/**
 * Error thrown when a queued operation is aborted.
 */
export class AbortError extends Error {
  readonly isLimitAbort = true;
  constructor(message = "Operation was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/**
 * Error thrown when the queue is cleared.
 */
export class QueueClearedError extends Error {
  readonly isQueueCleared = true;
  constructor(message = "Queue was cleared") {
    super(message);
    this.name = "QueueClearedError";
  }
}

/**
 * Error thrown when the queue is full.
 */
export class QueueFullError extends Error {
  readonly isQueueFull = true;
  constructor(message = "Queue is full") {
    super(message);
    this.name = "QueueFullError";
  }
}

/**
 * Options for creating a limiter.
 */
export interface LimitOptions {
  /** Maximum concurrent operations. Default: Infinity */
  concurrency?: number;
  /** Maximum operations per interval (rate limiting). */
  rate?: number;
  /** Interval in ms for rate limiting. Default: 1000 */
  interval?: number;
  /** Maximum queue size. Throws QueueFullError when exceeded. Default: Infinity */
  maxQueueSize?: number;
}

/**
 * Options for a single operation.
 */
export interface OperationOptions {
  /** Priority (higher = sooner). Default: 0 */
  priority?: number;
  /** AbortSignal to cancel the operation. */
  signal?: AbortSignal;
}

interface QueuedOperation<T> {
  fn: () => T | Promise<T>;
  priority: number;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * A limiter function that controls concurrency and rate.
 */
export interface Limiter {
  /**
   * Execute a function with limiting applied.
   */
  <T>(fn: () => T | Promise<T>, options?: OperationOptions): Promise<T>;
  /** Number of operations currently running. */
  readonly activeCount: number;
  /** Number of operations waiting in the queue. */
  readonly pendingCount: number;
  /**
   * Clear all pending operations from the queue.
   * @param reject If true (default), reject pending promises with QueueClearedError.
   */
  clearQueue(reject?: boolean): void;
  /**
   * Returns a promise that resolves when the queue is empty and all operations are complete.
   */
  onIdle(): Promise<void>;
}

/**
 * Create a concurrency and/or rate limiter.
 *
 * @param options - Configuration options.
 * @returns A limiter function.
 *
 * @example
 * ```typescript
 * // Concurrency only (like p-limit)
 * const limit = createLimit({ concurrency: 5 });
 * await limit(() => fetch(url));
 *
 * // Rate limiting (max 10 per second)
 * const limit = createLimit({ rate: 10, interval: 1000 });
 *
 * // Both
 * const limit = createLimit({ concurrency: 5, rate: 60, interval: 60000 });
 *
 * // With priority
 * await limit(() => importantCall(), { priority: 10 });
 *
 * // With AbortSignal
 * await limit(() => fetch(url), { signal: controller.signal });
 * ```
 */
export function createLimit(options: LimitOptions = {}): Limiter {
  const {
    concurrency = Infinity,
    rate,
    interval = 1000,
    maxQueueSize = Infinity,
  } = options;

  // Validate options
  if (concurrency !== Infinity && (concurrency <= 0 || !Number.isInteger(concurrency))) {
    throw new TypeError("concurrency must be a positive integer or Infinity");
  }
  if (rate !== undefined && (rate <= 0 || !Number.isInteger(rate))) {
    throw new TypeError("rate must be a positive integer");
  }
  if (interval <= 0) {
    throw new TypeError("interval must be positive");
  }
  if (maxQueueSize !== Infinity && (maxQueueSize <= 0 || !Number.isInteger(maxQueueSize))) {
    throw new TypeError("maxQueueSize must be a positive integer or Infinity");
  }

  const queue: QueuedOperation<unknown>[] = [];
  let activeCount = 0;
  let idleResolvers: (() => void)[] = [];

  // Token bucket for rate limiting
  let tokens = rate ?? Infinity;
  let lastRefill = Date.now();
  let refillTimeoutId: ReturnType<typeof setTimeout> | null = null;

  function refillTokens(): void {
    if (rate === undefined) return;

    const now = Date.now();
    const elapsed = now - lastRefill;

    if (elapsed >= interval) {
      // Full refill
      const periods = Math.floor(elapsed / interval);
      tokens = Math.min(rate, tokens + rate * periods);
      lastRefill += periods * interval;
    }
  }

  function scheduleRefill(): void {
    if (rate === undefined || refillTimeoutId !== null) return;
    if (queue.length === 0) return;

    const now = Date.now();
    const timeSinceLastRefill = now - lastRefill;
    const timeUntilRefill = Math.max(0, interval - timeSinceLastRefill);

    refillTimeoutId = setTimeout(() => {
      refillTimeoutId = null;
      refillTokens();
      processQueue();
    }, timeUntilRefill);
  }

  function checkIdle(): void {
    if (activeCount === 0 && queue.length === 0 && idleResolvers.length > 0) {
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  function processQueue(): void {
    refillTokens();

    while (queue.length > 0 && activeCount < concurrency && tokens > 0) {
      const op = queue.shift()!;

      // Remove abort listener since we're about to execute
      if (op.onAbort && op.signal) {
        op.signal.removeEventListener("abort", op.onAbort);
      }

      // Check if already aborted
      if (op.signal?.aborted) {
        op.reject(new AbortError());
        continue;
      }

      activeCount++;
      if (rate !== undefined) {
        tokens--;
      }

      Promise.resolve()
        .then(() => op.fn())
        .then(
          (result) => {
            activeCount--;
            op.resolve(result as never);
            processQueue();
            checkIdle();
          },
          (error) => {
            activeCount--;
            op.reject(error);
            processQueue();
            checkIdle();
          }
        );
    }

    // Schedule refill if we're rate limited and have pending work
    if (queue.length > 0 && tokens <= 0) {
      scheduleRefill();
    }

    // Check if we're idle
    checkIdle();
  }

  function enqueue<T>(
    fn: () => T | Promise<T>,
    options: OperationOptions = {}
  ): Promise<T> {
    // Validate fn
    if (typeof fn !== "function") {
      throw new TypeError("fn must be a function");
    }

    const { priority = 0, signal } = options;

    return new Promise<T>((resolve, reject) => {
      // Check if already aborted
      if (signal?.aborted) {
        reject(new AbortError());
        return;
      }

      // Check queue size
      if (queue.length >= maxQueueSize) {
        reject(new QueueFullError());
        return;
      }

      const op: QueuedOperation<T> = {
        fn,
        priority,
        resolve: resolve as (value: unknown) => void,
        reject,
        signal,
      };

      // Set up abort handler
      if (signal) {
        op.onAbort = () => {
          const index = queue.indexOf(op as QueuedOperation<unknown>);
          if (index !== -1) {
            queue.splice(index, 1);
            reject(new AbortError());
          }
        };
        signal.addEventListener("abort", op.onAbort, { once: true });
      }

      // Insert in priority order (higher priority first)
      let inserted = false;
      for (let i = 0; i < queue.length; i++) {
        if (priority > queue[i].priority) {
          queue.splice(i, 0, op as QueuedOperation<unknown>);
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        queue.push(op as QueuedOperation<unknown>);
      }

      processQueue();
    });
  }

  function clearQueue(reject = true): void {
    // Cancel refill timer
    if (refillTimeoutId !== null) {
      clearTimeout(refillTimeoutId);
      refillTimeoutId = null;
    }

    // Process all queued items
    while (queue.length > 0) {
      const op = queue.shift()!;

      // Clean up abort listener
      if (op.onAbort && op.signal) {
        op.signal.removeEventListener("abort", op.onAbort);
      }

      if (reject) {
        op.reject(new QueueClearedError());
      }
    }

    // Check if we're now idle
    checkIdle();
  }

  function onIdle(): Promise<void> {
    if (activeCount === 0 && queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      idleResolvers.push(resolve);
    });
  }

  const limiter = enqueue as Limiter;

  Object.defineProperty(limiter, "activeCount", {
    get: () => activeCount,
  });

  Object.defineProperty(limiter, "pendingCount", {
    get: () => queue.length,
  });

  limiter.clearQueue = clearQueue;
  limiter.onIdle = onIdle;

  return limiter;
}

/**
 * Create a pre-limited version of a function.
 *
 * @param fn - The function to wrap.
 * @param options - Limit options.
 * @returns A function that applies limiting.
 *
 * @example
 * ```typescript
 * const fetchWithLimit = limited(
 *   (url: string) => fetch(url),
 *   { concurrency: 5 }
 * );
 * await fetchWithLimit("/api/data");
 * ```
 */
export function limited<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult | Promise<TResult>,
  options: LimitOptions = {}
): (...args: TArgs) => Promise<TResult> {
  const limit = createLimit(options);
  return (...args: TArgs) => limit(() => fn(...args));
}

/**
 * A keyed limiter for per-key rate limiting.
 */
export interface KeyedLimiter {
  /**
   * Execute a function with limiting applied to a specific key.
   */
  <T>(key: string, fn: () => T | Promise<T>, options?: OperationOptions): Promise<T>;
  /**
   * Get the limiter for a specific key.
   */
  get(key: string): Limiter;
  /**
   * Delete a limiter for a specific key.
   */
  delete(key: string): boolean;
  /**
   * Clear all limiters.
   */
  clear(): void;
  /** Number of active keys. */
  readonly size: number;
}

/**
 * Create a keyed limiter for per-key rate limiting.
 *
 * @param options - Limit options applied to each key.
 * @returns A keyed limiter.
 *
 * @example
 * ```typescript
 * const userLimit = createKeyedLimit({ concurrency: 2, rate: 10, interval: 1000 });
 *
 * // Each user gets their own limit
 * await userLimit("user-123", () => fetchUserData("123"));
 * await userLimit("user-456", () => fetchUserData("456"));
 * ```
 */
export function createKeyedLimit(options: LimitOptions = {}): KeyedLimiter {
  const limiters = new Map<string, Limiter>();

  function getOrCreate(key: string): Limiter {
    let limiter = limiters.get(key);
    if (!limiter) {
      limiter = createLimit(options);
      limiters.set(key, limiter);
    }
    return limiter;
  }

  function keyedLimit<T>(
    key: string,
    fn: () => T | Promise<T>,
    options?: OperationOptions
  ): Promise<T> {
    return getOrCreate(key)(fn, options);
  }

  keyedLimit.get = getOrCreate;

  keyedLimit.delete = (key: string): boolean => {
    const limiter = limiters.get(key);
    if (limiter) {
      limiter.clearQueue(true);
      return limiters.delete(key);
    }
    return false;
  };

  keyedLimit.clear = (): void => {
    for (const limiter of limiters.values()) {
      limiter.clearQueue(true);
    }
    limiters.clear();
  };

  Object.defineProperty(keyedLimit, "size", {
    get: () => limiters.size,
  });

  return keyedLimit as KeyedLimiter;
}
