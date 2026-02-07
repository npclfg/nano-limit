/** Error thrown when operation is aborted. */
export class AbortError extends Error {
  readonly isLimitAbort = true;
  constructor(message = "Operation was aborted") { super(message); this.name = "AbortError"; }
}

/** Error thrown when queue is cleared. */
export class QueueClearedError extends Error {
  readonly isQueueCleared = true;
  constructor(message = "Queue was cleared") { super(message); this.name = "QueueClearedError"; }
}

/** Error thrown when queue is full. */
export class QueueFullError extends Error {
  readonly isQueueFull = true;
  constructor(message = "Queue is full") { super(message); this.name = "QueueFullError"; }
}

export interface LimitOptions {
  /** Maximum concurrent operations. Default: Infinity */
  concurrency?: number;
  /** Maximum operations per interval (rate limiting). */
  rate?: number;
  /** Interval in ms for rate limiting. Default: 1000 */
  interval?: number;
  /** Maximum queue size. Default: Infinity */
  maxQueueSize?: number;
}

export interface OperationOptions {
  /** Priority (higher = sooner). Default: 0 */
  priority?: number;
  /** AbortSignal to cancel the operation. */
  signal?: AbortSignal;
}

interface QueuedOp<T> {
  fn: () => T | Promise<T>;
  priority: number;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface Limiter {
  <T>(fn: () => T | Promise<T>, options?: OperationOptions): Promise<T>;
  readonly activeCount: number;
  readonly pendingCount: number;
  clearQueue(reject?: boolean): void;
  onIdle(): Promise<void>;
}

/**
 * Create a concurrency and/or rate limiter.
 *
 * @example
 * ```typescript
 * const limit = createLimit({ concurrency: 5, rate: 10, interval: 1000 });
 * await limit(() => fetch(url));
 * await limit(() => importantCall(), { priority: 10 });
 * ```
 */
export function createLimit(options: LimitOptions = {}): Limiter {
  const { concurrency = Infinity, rate, interval = 1000, maxQueueSize = Infinity } = options;

  if (concurrency !== Infinity && (!Number.isInteger(concurrency) || concurrency <= 0))
    throw new TypeError("concurrency must be a positive integer or Infinity");
  if (rate !== undefined && (!Number.isInteger(rate) || rate <= 0))
    throw new TypeError("rate must be a positive integer");
  if (interval <= 0) throw new TypeError("interval must be positive");
  if (maxQueueSize !== Infinity && (!Number.isInteger(maxQueueSize) || maxQueueSize <= 0))
    throw new TypeError("maxQueueSize must be a positive integer or Infinity");

  const queue: QueuedOp<unknown>[] = [];
  let activeCount = 0;
  let idleResolvers: (() => void)[] = [];
  let tokens = rate ?? Infinity;
  let lastRefill = Date.now();
  let refillTimer: ReturnType<typeof setTimeout> | null = null;

  const checkIdle = () => {
    if (activeCount === 0 && queue.length === 0 && idleResolvers.length > 0) {
      const resolvers = idleResolvers;
      idleResolvers = [];
      resolvers.forEach(r => r());
    }
  };

  const refillTokens = () => {
    if (rate === undefined) return;
    const elapsed = Date.now() - lastRefill;
    if (elapsed >= interval) {
      const periods = Math.floor(elapsed / interval);
      tokens = Math.min(rate, tokens + rate * periods);
      lastRefill += periods * interval;
    }
  };

  const processQueue = () => {
    refillTokens();
    while (queue.length > 0 && activeCount < concurrency && tokens > 0) {
      const op = queue.shift()!;
      if (op.onAbort && op.signal) op.signal.removeEventListener("abort", op.onAbort);
      if (op.signal?.aborted) { op.reject(new AbortError()); continue; }

      activeCount++;
      if (rate !== undefined) tokens--;

      Promise.resolve().then(() => op.fn()).then(
        result => { activeCount--; op.resolve(result as never); processQueue(); checkIdle(); },
        error => { activeCount--; op.reject(error); processQueue(); checkIdle(); }
      );
    }
    if (queue.length > 0 && tokens <= 0 && refillTimer === null) {
      const delay = Math.max(0, interval - (Date.now() - lastRefill));
      refillTimer = setTimeout(() => { refillTimer = null; refillTokens(); processQueue(); }, delay);
    }
    checkIdle();
  };

  const enqueue = <T>(fn: () => T | Promise<T>, opts: OperationOptions = {}): Promise<T> => {
    if (typeof fn !== "function") throw new TypeError("fn must be a function");
    const { priority = 0, signal } = opts;

    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(new AbortError()); return; }
      if (queue.length >= maxQueueSize) { reject(new QueueFullError()); return; }

      const op: QueuedOp<T> = { fn, priority, resolve: resolve as (v: unknown) => void, reject, signal };

      if (signal) {
        op.onAbort = () => {
          const idx = queue.indexOf(op as QueuedOp<unknown>);
          if (idx !== -1) { queue.splice(idx, 1); reject(new AbortError()); }
        };
        signal.addEventListener("abort", op.onAbort, { once: true });
      }

      const idx = queue.findIndex(q => priority > q.priority);
      queue.splice(idx === -1 ? queue.length : idx, 0, op as QueuedOp<unknown>);
      processQueue();
    });
  };

  const clearQueue = (reject = true) => {
    if (refillTimer !== null) { clearTimeout(refillTimer); refillTimer = null; }
    const items = queue.splice(0);
    for (const op of items) {
      if (op.onAbort && op.signal) op.signal.removeEventListener("abort", op.onAbort);
      if (reject) op.reject(new QueueClearedError());
    }
    checkIdle();
  };

  const onIdle = (): Promise<void> => {
    if (activeCount === 0 && queue.length === 0) return Promise.resolve();
    return new Promise(resolve => { idleResolvers.push(resolve); });
  };

  const limiter = enqueue as Limiter;
  Object.defineProperties(limiter, {
    activeCount: { get: () => activeCount },
    pendingCount: { get: () => queue.length },
  });
  limiter.clearQueue = clearQueue;
  limiter.onIdle = onIdle;
  return limiter;
}

/**
 * Create a pre-limited version of a function.
 *
 * @example
 * ```typescript
 * const fetchLimited = limited((url: string) => fetch(url), { concurrency: 5 });
 * await fetchLimited("/api/data");
 * ```
 */
export function limited<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult | Promise<TResult>,
  options: LimitOptions = {}
): (...args: TArgs) => Promise<TResult> {
  const limit = createLimit(options);
  return (...args: TArgs) => limit(() => fn(...args));
}

export interface KeyedLimiter {
  <T>(key: string, fn: () => T | Promise<T>, options?: OperationOptions): Promise<T>;
  get(key: string): Limiter;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
}

/**
 * Create a keyed limiter for per-key rate limiting.
 *
 * @example
 * ```typescript
 * const userLimit = createKeyedLimit({ rate: 10, interval: 1000 });
 * await userLimit("user-123", () => fetchUserData("123"));
 * ```
 */
export function createKeyedLimit(options: LimitOptions = {}): KeyedLimiter {
  const limiters = new Map<string, Limiter>();

  const getOrCreate = (key: string): Limiter => {
    let limiter = limiters.get(key);
    if (!limiter) { limiter = createLimit(options); limiters.set(key, limiter); }
    return limiter;
  };

  const keyedLimit = <T>(key: string, fn: () => T | Promise<T>, opts?: OperationOptions): Promise<T> =>
    getOrCreate(key)(fn, opts);

  keyedLimit.get = getOrCreate;
  keyedLimit.delete = (key: string): boolean => {
    const limiter = limiters.get(key);
    if (limiter) { limiter.clearQueue(true); return limiters.delete(key); }
    return false;
  };
  keyedLimit.clear = () => { limiters.forEach(l => l.clearQueue(true)); limiters.clear(); };
  Object.defineProperty(keyedLimit, "size", { get: () => limiters.size });
  return keyedLimit as KeyedLimiter;
}
