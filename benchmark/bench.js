const { createLimit } = require("../dist/cjs/limit.js");

function bench(name, fn, iterations = 100000) {
  // Warmup
  for (let i = 0; i < 1000; i++) {
    fn();
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = process.hrtime.bigint();

  const totalNs = Number(end - start);
  const avgNs = totalNs / iterations;
  const avgUs = avgNs / 1000;

  console.log(`${name}: ${avgUs.toFixed(2)} µs/op`);
}

async function benchAsync(name, fn, iterations = 10000) {
  // Warmup
  for (let i = 0; i < 100; i++) {
    await fn();
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  const end = process.hrtime.bigint();

  const totalNs = Number(end - start);
  const avgNs = totalNs / iterations;
  const avgUs = avgNs / 1000;

  console.log(`${name}: ${avgUs.toFixed(2)} µs/op`);
}

async function main() {
  console.log("nano-limit benchmarks\n");

  // Sync baseline
  bench("Direct sync call (baseline)", () => {
    return 42;
  });

  // Async baseline
  await benchAsync("Direct async call (baseline)", async () => {
    return 42;
  });

  console.log();

  // Create limiter once
  const limit = createLimit({ concurrency: 10 });

  // Limited sync function
  await benchAsync("limit() - sync fn, success", async () => {
    await limit(() => 42);
  });

  // Limited async function
  await benchAsync("limit() - async fn, success", async () => {
    await limit(async () => 42);
  });

  console.log();

  // Rate limited
  const rateLimited = createLimit({ concurrency: 10, rate: 100000, interval: 1000 });

  await benchAsync("limit() - with rate limiting", async () => {
    await rateLimited(() => 42);
  });

  console.log();

  // With priority
  await benchAsync("limit() - with priority", async () => {
    await limit(() => 42, { priority: 5 });
  });

  console.log();

  // Queue overhead (measure when queue is used)
  const singleLimit = createLimit({ concurrency: 1 });
  let running = null;

  console.log("Queue operations:");

  bench("Queue insert (pendingCount)", () => {
    singleLimit(() => {});
  });

  singleLimit.clearQueue();

  console.log("\nDone.");
}

main().catch(console.error);
