const {
  createLimit,
  createKeyedLimit,
  limited,
  AbortError,
  QueueClearedError,
  QueueFullError,
} = require("../dist/cjs/limit.js");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

function assert(condition, message = "Assertion failed") {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log("\nConcurrency Limiting");

  await test("should limit concurrent operations", async () => {
    const limit = createLimit({ concurrency: 2 });
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 5 }, () =>
      limit(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(50);
        running--;
      })
    );

    await Promise.all(tasks);
    assertEqual(maxRunning, 2);
  });

  await test("should return function result", async () => {
    const limit = createLimit({ concurrency: 2 });
    const result = await limit(() => 42);
    assertEqual(result, 42);
  });

  await test("should handle async functions", async () => {
    const limit = createLimit({ concurrency: 2 });
    const result = await limit(async () => {
      await sleep(10);
      return "async result";
    });
    assertEqual(result, "async result");
  });

  await test("should propagate errors", async () => {
    const limit = createLimit({ concurrency: 2 });
    let caught = false;
    try {
      await limit(() => {
        throw new Error("test error");
      });
    } catch (error) {
      caught = true;
      assertEqual(error.message, "test error");
    }
    assert(caught, "Error should have been thrown");
  });

  await test("should track activeCount", async () => {
    const limit = createLimit({ concurrency: 5 });
    assertEqual(limit.activeCount, 0);

    const p1 = limit(() => sleep(50));
    await sleep(10);
    assertEqual(limit.activeCount, 1);

    const p2 = limit(() => sleep(50));
    await sleep(10);
    assertEqual(limit.activeCount, 2);

    await Promise.all([p1, p2]);
    assertEqual(limit.activeCount, 0);
  });

  await test("should track pendingCount", async () => {
    const limit = createLimit({ concurrency: 1 });
    assertEqual(limit.pendingCount, 0);

    const p1 = limit(() => sleep(100));
    await sleep(10);
    assertEqual(limit.pendingCount, 0);
    assertEqual(limit.activeCount, 1);

    const p2 = limit(() => sleep(50));
    await sleep(10);
    assertEqual(limit.pendingCount, 1);

    const p3 = limit(() => sleep(50));
    await sleep(10);
    assertEqual(limit.pendingCount, 2);

    await Promise.all([p1, p2, p3]);
    assertEqual(limit.pendingCount, 0);
    assertEqual(limit.activeCount, 0);
  });

  await test("should work with Infinity concurrency", async () => {
    const limit = createLimit({ concurrency: Infinity });
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 10 }, () =>
      limit(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(20);
        running--;
      })
    );

    await Promise.all(tasks);
    assertEqual(maxRunning, 10);
  });

  console.log("\nPriority Queue");

  await test("should process higher priority first", async () => {
    const limit = createLimit({ concurrency: 1 });
    const order = [];

    // Start one task to fill the slot
    const blocker = limit(async () => {
      await sleep(50);
      order.push("blocker");
    });

    // Queue up tasks with different priorities
    await sleep(10);
    const low = limit(async () => order.push("low"), { priority: 1 });
    const high = limit(async () => order.push("high"), { priority: 10 });
    const medium = limit(async () => order.push("medium"), { priority: 5 });

    await Promise.all([blocker, low, high, medium]);
    assertEqual(order.join(","), "blocker,high,medium,low");
  });

  await test("should use priority 0 by default", async () => {
    const limit = createLimit({ concurrency: 1 });
    const order = [];

    const blocker = limit(async () => {
      await sleep(50);
      order.push("blocker");
    });

    await sleep(10);
    const first = limit(async () => order.push("first"));
    const priority = limit(async () => order.push("priority"), { priority: 1 });
    const second = limit(async () => order.push("second"));

    await Promise.all([blocker, first, priority, second]);
    assertEqual(order.join(","), "blocker,priority,first,second");
  });

  console.log("\nRate Limiting");

  await test("should limit rate per interval", async () => {
    const limit = createLimit({ rate: 3, interval: 100 });
    const timestamps = [];

    const tasks = Array.from({ length: 6 }, () =>
      limit(async () => {
        timestamps.push(Date.now());
      })
    );

    await Promise.all(tasks);

    // First 3 should execute immediately
    const firstBatch = timestamps.slice(0, 3);
    const secondBatch = timestamps.slice(3, 6);

    // All in first batch should be close together
    assert(
      firstBatch[2] - firstBatch[0] < 50,
      "First batch should execute quickly"
    );

    // Second batch should be at least 100ms after first
    assert(
      secondBatch[0] - firstBatch[0] >= 90,
      "Second batch should wait for interval"
    );
  });

  await test("should combine concurrency and rate limiting", async () => {
    const limit = createLimit({ concurrency: 2, rate: 4, interval: 100 });
    let running = 0;
    let maxRunning = 0;
    const timestamps = [];

    const tasks = Array.from({ length: 6 }, () =>
      limit(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        timestamps.push(Date.now());
        await sleep(30);
        running--;
      })
    );

    await Promise.all(tasks);
    assertEqual(maxRunning, 2, "Concurrency should be respected");
    assert(timestamps.length === 6, "All tasks should complete");
  });

  console.log("\nAbortSignal Support");

  await test("should abort immediately if signal already aborted", async () => {
    const limit = createLimit({ concurrency: 2 });
    const controller = new AbortController();
    controller.abort();

    let caught = false;
    try {
      await limit(() => "should not run", { signal: controller.signal });
    } catch (error) {
      caught = true;
      assert(error instanceof AbortError);
    }
    assert(caught, "Should have thrown AbortError");
  });

  await test("should abort pending operations", async () => {
    const limit = createLimit({ concurrency: 1 });
    const controller = new AbortController();

    // Fill the slot
    const blocker = limit(() => sleep(100));

    // Queue an operation with signal
    const abortable = limit(() => "should not run", { signal: controller.signal });

    // Abort while pending
    await sleep(10);
    controller.abort();

    let caught = false;
    try {
      await abortable;
    } catch (error) {
      caught = true;
      assert(error instanceof AbortError);
    }

    await blocker;
    assert(caught, "Should have thrown AbortError");
  });

  await test("should remove aborted operations from queue", async () => {
    const limit = createLimit({ concurrency: 1 });
    const controller = new AbortController();

    const blocker = limit(() => sleep(100));
    await sleep(10);

    limit(() => "should not run", { signal: controller.signal }).catch(() => {});
    assertEqual(limit.pendingCount, 1);

    controller.abort();
    await sleep(10);
    assertEqual(limit.pendingCount, 0);

    await blocker;
  });

  console.log("\nClear Queue");

  await test("should clear pending operations with rejection by default", async () => {
    const limit = createLimit({ concurrency: 1 });

    const blocker = limit(() => sleep(100));
    await sleep(10);

    let rejectedCount = 0;
    const pending = Array.from({ length: 3 }, () =>
      limit(() => "result").catch((error) => {
        if (error instanceof QueueClearedError) {
          rejectedCount++;
        }
      })
    );

    assertEqual(limit.pendingCount, 3);
    limit.clearQueue(); // Default is now true
    assertEqual(limit.pendingCount, 0);

    await Promise.all(pending);
    assertEqual(rejectedCount, 3);

    await blocker;
  });

  await test("should clear pending operations without rejection when false", async () => {
    const limit = createLimit({ concurrency: 1 });

    const blocker = limit(() => sleep(100));
    await sleep(10);

    const pending = [];
    for (let i = 0; i < 3; i++) {
      pending.push(limit(() => `result ${i}`).catch(() => "rejected"));
    }

    assertEqual(limit.pendingCount, 3);
    limit.clearQueue(false);
    assertEqual(limit.pendingCount, 0);

    await blocker;
  });

  await test("should clear pending operations with rejection", async () => {
    const limit = createLimit({ concurrency: 1 });

    const blocker = limit(() => sleep(100));
    await sleep(10);

    let rejectedCount = 0;
    const pending = Array.from({ length: 3 }, () =>
      limit(() => "result").catch((error) => {
        if (error instanceof QueueClearedError) {
          rejectedCount++;
        }
      })
    );

    limit.clearQueue(true);
    await Promise.all(pending);
    assertEqual(rejectedCount, 3);

    await blocker;
  });

  console.log("\nInput Validation");

  await test("should reject invalid concurrency", () => {
    let threw = false;
    try {
      createLimit({ concurrency: 0 });
    } catch (error) {
      threw = true;
      assert(error instanceof TypeError);
    }
    assert(threw);
  });

  await test("should reject negative concurrency", () => {
    let threw = false;
    try {
      createLimit({ concurrency: -1 });
    } catch (error) {
      threw = true;
      assert(error instanceof TypeError);
    }
    assert(threw);
  });

  await test("should reject non-integer concurrency", () => {
    let threw = false;
    try {
      createLimit({ concurrency: 1.5 });
    } catch (error) {
      threw = true;
      assert(error instanceof TypeError);
    }
    assert(threw);
  });

  await test("should reject invalid rate", () => {
    let threw = false;
    try {
      createLimit({ rate: 0 });
    } catch (error) {
      threw = true;
      assert(error instanceof TypeError);
    }
    assert(threw);
  });

  await test("should reject invalid interval", () => {
    let threw = false;
    try {
      createLimit({ interval: 0 });
    } catch (error) {
      threw = true;
      assert(error instanceof TypeError);
    }
    assert(threw);
  });

  await test("should reject invalid maxQueueSize", () => {
    let threw = false;
    try {
      createLimit({ maxQueueSize: 0 });
    } catch (error) {
      threw = true;
      assert(error instanceof TypeError);
    }
    assert(threw);
  });

  await test("should reject non-function fn", () => {
    const limit = createLimit({ concurrency: 2 });
    let threw = false;
    try {
      limit("not a function");
    } catch (error) {
      threw = true;
      assert(error instanceof TypeError);
      assert(error.message.includes("function"));
    }
    assert(threw);
  });

  console.log("\nMax Queue Size");

  await test("should reject when queue is full", async () => {
    const limit = createLimit({ concurrency: 1, maxQueueSize: 2 });

    const blocker = limit(() => sleep(100));
    await sleep(10);

    // These should be queued
    const p1 = limit(() => "result1").catch((e) => e);
    const p2 = limit(() => "result2").catch((e) => e);
    assertEqual(limit.pendingCount, 2);

    // This should be rejected
    let caught = false;
    try {
      await limit(() => "result3");
    } catch (error) {
      caught = true;
      assert(error instanceof QueueFullError);
    }
    assert(caught, "Should have thrown QueueFullError");

    limit.clearQueue();
    await blocker;
  });

  console.log("\nonIdle");

  await test("should resolve immediately when already idle", async () => {
    const limit = createLimit({ concurrency: 2 });
    await limit.onIdle();
  });

  await test("should resolve when all operations complete", async () => {
    const limit = createLimit({ concurrency: 2 });
    const order = [];

    limit(async () => {
      await sleep(50);
      order.push("task1");
    });
    limit(async () => {
      await sleep(30);
      order.push("task2");
    });

    await limit.onIdle();
    order.push("idle");

    assertEqual(order.join(","), "task2,task1,idle");
  });

  await test("should resolve when queue is cleared", async () => {
    const limit = createLimit({ concurrency: 1 });

    const blocker = limit(() => sleep(100));
    await sleep(10);

    limit(() => "pending").catch(() => {});
    limit(() => "pending").catch(() => {});

    const idlePromise = limit.onIdle();
    limit.clearQueue();

    await blocker;
    await idlePromise;
  });

  console.log("\nlimited() Wrapper");

  await test("should create a limited function", async () => {
    const fetchData = limited((id) => `data-${id}`, { concurrency: 2 });
    const result = await fetchData(123);
    assertEqual(result, "data-123");
  });

  await test("should pass all arguments", async () => {
    const fn = limited((a, b, c) => a + b + c, { concurrency: 2 });
    const result = await fn(1, 2, 3);
    assertEqual(result, 6);
  });

  console.log("\nKeyed Limiter");

  await test("should create separate limits per key", async () => {
    const limit = createKeyedLimit({ concurrency: 1 });
    const order = [];

    // Start two concurrent operations on different keys
    const p1 = limit("key1", async () => {
      order.push("key1-start");
      await sleep(50);
      order.push("key1-end");
    });

    const p2 = limit("key2", async () => {
      order.push("key2-start");
      await sleep(50);
      order.push("key2-end");
    });

    await Promise.all([p1, p2]);

    // Both should start immediately (different keys)
    assert(
      order[0].endsWith("-start") && order[1].endsWith("-start"),
      "Both should start before either ends"
    );
  });

  await test("should track size", async () => {
    const limit = createKeyedLimit({ concurrency: 1 });
    assertEqual(limit.size, 0);

    await limit("key1", () => "result");
    assertEqual(limit.size, 1);

    await limit("key2", () => "result");
    assertEqual(limit.size, 2);
  });

  await test("should delete a key", async () => {
    const limit = createKeyedLimit({ concurrency: 1 });
    await limit("key1", () => "result");
    assertEqual(limit.size, 1);

    const deleted = limit.delete("key1");
    assert(deleted);
    assertEqual(limit.size, 0);
  });

  await test("should clear all keys", async () => {
    const limit = createKeyedLimit({ concurrency: 1 });
    await limit("key1", () => "result");
    await limit("key2", () => "result");
    assertEqual(limit.size, 2);

    limit.clear();
    assertEqual(limit.size, 0);
  });

  await test("should get limiter for key", async () => {
    const limit = createKeyedLimit({ concurrency: 1 });
    const limiter = limit.get("key1");
    assert(typeof limiter === "function");
    assert("activeCount" in limiter);
    assert("pendingCount" in limiter);
  });

  console.log("\nEdge Cases");

  await test("should handle rapid calls", async () => {
    const limit = createLimit({ concurrency: 2 });
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => limit(() => i))
    );
    assertEqual(results.length, 100);
    assertEqual(results[0], 0);
    assertEqual(results[99], 99);
  });

  await test("should handle sync functions", async () => {
    const limit = createLimit({ concurrency: 2 });
    const result = await limit(() => "sync");
    assertEqual(result, "sync");
  });

  await test("should maintain FIFO within same priority", async () => {
    const limit = createLimit({ concurrency: 1 });
    const order = [];

    const blocker = limit(async () => {
      await sleep(50);
      order.push("blocker");
    });

    await sleep(10);
    const tasks = Array.from({ length: 3 }, (_, i) =>
      limit(async () => order.push(i))
    );

    await Promise.all([blocker, ...tasks]);
    assertEqual(order.join(","), "blocker,0,1,2");
  });

  console.log("\n---");
  console.log(`${passed} passing, ${failed} failing`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
