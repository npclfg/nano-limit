# nano-limit

[![npm version](https://img.shields.io/npm/v/@npclfg/nano-limit)](https://npmjs.com/package/@npclfg/nano-limit)
[![npm downloads](https://img.shields.io/npm/dm/@npclfg/nano-limit)](https://npmjs.com/package/@npclfg/nano-limit)
[![license](https://img.shields.io/npm/l/@npclfg/nano-limit)](https://github.com/npclfg/nano-limit/blob/main/LICENSE)

Tiny concurrency and rate limiter with priorities, AbortSignal, and zero dependencies.

- **Zero dependencies**
- **TypeScript-first** with full type inference
- **ESM and CommonJS** support

## The Problem

You need to limit API calls. You reach for p-limit but:

```typescript
// p-limit: only concurrency, no rate limiting
// p-limit: can't do "max 60 requests per minute"
// p-limit: no priority queue, no AbortSignal
```

You try bottleneck but:

```typescript
// bottleneck: complex API with reservoir, highWater, strategy...
// bottleneck: must call disconnect() or memory leaks
// bottleneck: breaks with mock timers in tests
// bottleneck: last major release was 2019
```

## The Fix

```typescript
import { createLimit } from "@npclfg/nano-limit";

// Concurrency + rate limiting in one
const limit = createLimit({
  concurrency: 5,     // max 5 parallel
  rate: 60,           // max 60 per minute
  interval: 60000,
});

await limit(() => openai.chat.completions.create({ model: "gpt-4", messages }));

// Priority queue: important requests go first
await limit(() => criticalOperation(), { priority: 10 });

// Cancel pending operations
await limit(() => fetch(url), { signal: controller.signal });
```

That's it. Concurrency limiting, rate limiting, priorities, and cancellation in one tiny package.

## Why nano-limit?

| Feature | p-limit | bottleneck | nano-limit |
|---------|---------|------------|------------|
| Dependencies | 2 | 0 | **0** |
| Concurrency limiting | ✅ | ✅ | ✅ |
| Rate limiting | ❌ | ✅ | ✅ |
| Priority queue | ❌ | ✅ | ✅ |
| AbortSignal | ❌ | ❌ | ✅ |
| Per-key limiting | ❌ | Manual | ✅ Built-in |
| Queue size limit | ❌ | ✅ | ✅ |
| onIdle() | ❌ | ✅ | ✅ |
| Memory leak risk | Low | disconnect() required | **None** |
| ESM + CJS | ESM-only (v4+) | ✅ | ✅ |
| Last updated | Active | 2019 | Active |

## Installation

```bash
npm install @npclfg/nano-limit
```

**Requirements:** Node.js 16+ or modern browsers (ES2020)

## Quick Start

```typescript
import { createLimit } from "@npclfg/nano-limit";

// Concurrency only (like p-limit)
const limit = createLimit({ concurrency: 5 });
await Promise.all(urls.map(url => limit(() => fetch(url))));

// Rate limiting (max 10 per second)
const rateLimited = createLimit({ rate: 10, interval: 1000 });

// Both together
const apiLimit = createLimit({
  concurrency: 5,
  rate: 60,
  interval: 60000,
});
```

## API Reference

### `createLimit(options?): Limiter`

Create a concurrency and/or rate limiter.

```typescript
const limit = createLimit({
  concurrency: 5,    // max concurrent (default: Infinity)
  rate: 100,         // max per interval
  interval: 1000,    // interval in ms (default: 1000)
  maxQueueSize: 1000 // max queued operations (default: Infinity)
});

const result = await limit(() => fetchData());
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `concurrency` | `number` | `Infinity` | Maximum concurrent operations |
| `rate` | `number` | - | Maximum operations per interval |
| `interval` | `number` | `1000` | Interval in ms for rate limiting |
| `maxQueueSize` | `number` | `Infinity` | Max queued operations (throws QueueFullError) |

#### Limiter Properties

| Property | Type | Description |
|----------|------|-------------|
| `activeCount` | `number` | Currently running operations |
| `pendingCount` | `number` | Operations waiting in queue |
| `clearQueue(reject?)` | `function` | Clear pending operations |
| `onIdle()` | `Promise<void>` | Resolves when queue is empty and all done |

### Operation Options

```typescript
await limit(() => fn(), {
  priority: 10,              // higher = sooner (default: 0)
  signal: controller.signal  // AbortSignal for cancellation
});
```

### `createKeyedLimit(options?): KeyedLimiter`

Per-key rate limiting for multi-tenant systems.

```typescript
const userLimit = createKeyedLimit({
  concurrency: 2,
  rate: 10,
  interval: 1000
});

// Each user gets their own limit
await userLimit("user-123", () => fetchUserData("123"));
await userLimit("user-456", () => fetchUserData("456"));

// Manage keys
userLimit.get("user-123");     // Get limiter for key
userLimit.delete("user-123");  // Remove key
userLimit.clear();             // Remove all keys
userLimit.size;                // Number of active keys
```

### `limited(fn, options?): WrappedFunction`

Create a pre-configured limited function.

```typescript
const fetchWithLimit = limited(
  (url: string) => fetch(url),
  { concurrency: 5, rate: 10, interval: 1000 }
);

await fetchWithLimit("/api/data");
```

### Error Types

```typescript
import { AbortError, QueueClearedError, QueueFullError } from "nano-limit";

try {
  await limit(() => fn(), { signal });
} catch (error) {
  if (error instanceof AbortError) {
    // Operation was aborted
  }
  if (error instanceof QueueClearedError) {
    // clearQueue() was called
  }
  if (error instanceof QueueFullError) {
    // maxQueueSize exceeded
  }
}
```

## Patterns & Recipes

### OpenAI/Anthropic Rate Limiting

```typescript
const aiLimit = createLimit({
  concurrency: 5,      // parallel requests
  rate: 60,            // 60 RPM
  interval: 60000,
});

const response = await aiLimit(() =>
  openai.chat.completions.create({
    model: "gpt-4",
    messages,
  })
);
```

### Priority Queue

```typescript
const limit = createLimit({ concurrency: 1 });

// High priority runs first
limit(() => lowPriorityTask());
limit(() => criticalTask(), { priority: 10 });  // Runs first
```

### Graceful Shutdown

```typescript
const limit = createLimit({ concurrency: 10 });

// On shutdown
process.on("SIGTERM", async () => {
  limit.clearQueue();     // Cancel pending
  await limit.onIdle();   // Wait for active to finish
  process.exit(0);
});
```

### With Timeout

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

try {
  await limit(() => slowOperation(), { signal: controller.signal });
} catch (error) {
  if (error instanceof AbortError) {
    console.log("Timed out");
  }
}
```

### Backpressure / Queue Overflow

```typescript
const limit = createLimit({
  concurrency: 5,
  maxQueueSize: 100,  // Reject if queue grows too large
});

try {
  await limit(() => processRequest());
} catch (error) {
  if (error instanceof QueueFullError) {
    // Return 503 Service Unavailable
  }
}
```

### Multi-Tenant API

```typescript
const userLimit = createKeyedLimit({
  concurrency: 2,
  rate: 100,
  interval: 60000,
});

app.use(async (req, res, next) => {
  try {
    await userLimit(req.user.id, () => next());
  } catch (error) {
    if (error instanceof QueueFullError) {
      res.status(429).send("Too Many Requests");
    }
  }
});
```

## TypeScript Usage

Full type inference is supported:

```typescript
import { createLimit, LimitOptions, Limiter } from "nano-limit";

interface ApiResponse {
  data: string[];
}

// Return type is inferred as Promise<ApiResponse>
const result = await limit(async (): Promise<ApiResponse> => {
  const res = await fetch("/api");
  return res.json();
});
```

## License

MIT
