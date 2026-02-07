const { createLimit, createKeyedLimit, limited } = require("../dist/cjs/limit.js");

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== nano-limit examples ===\n");

  // Example 1: Basic concurrency limiting
  console.log("1. Concurrency limiting (max 2 parallel)");
  const limit = createLimit({ concurrency: 2 });

  const start = Date.now();
  await Promise.all([
    limit(async () => { await sleep(100); console.log(`   Task 1 done at ${Date.now() - start}ms`); }),
    limit(async () => { await sleep(100); console.log(`   Task 2 done at ${Date.now() - start}ms`); }),
    limit(async () => { await sleep(100); console.log(`   Task 3 done at ${Date.now() - start}ms`); }),
    limit(async () => { await sleep(100); console.log(`   Task 4 done at ${Date.now() - start}ms`); }),
  ]);
  console.log();

  // Example 2: Rate limiting
  console.log("2. Rate limiting (max 3 per 200ms)");
  const rateLimited = createLimit({ rate: 3, interval: 200 });

  const start2 = Date.now();
  const timestamps = [];
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      rateLimited(async () => {
        timestamps.push(Date.now() - start2);
      })
    )
  );
  console.log(`   Execution times: ${timestamps.map((t) => `${t}ms`).join(", ")}`);
  console.log();

  // Example 3: Priority queue
  console.log("3. Priority queue (higher priority runs first)");
  const priorityLimit = createLimit({ concurrency: 1 });
  const order = [];

  const blocker = priorityLimit(async () => {
    await sleep(50);
    order.push("blocker");
  });
  await sleep(10);

  const lowPriority = priorityLimit(async () => order.push("low"), { priority: 1 });
  const highPriority = priorityLimit(async () => order.push("high"), { priority: 10 });
  const mediumPriority = priorityLimit(async () => order.push("medium"), { priority: 5 });

  await Promise.all([blocker, lowPriority, highPriority, mediumPriority]);
  console.log(`   Execution order: ${order.join(" -> ")}`);
  console.log();

  // Example 4: Per-user rate limiting
  console.log("4. Per-key limiting (each user gets own limit)");
  const userLimit = createKeyedLimit({ concurrency: 1 });

  await Promise.all([
    userLimit("alice", async () => {
      await sleep(50);
      console.log("   Alice's request completed");
    }),
    userLimit("bob", async () => {
      await sleep(50);
      console.log("   Bob's request completed");
    }),
  ]);
  console.log(`   Active keys: ${userLimit.size}`);
  console.log();

  // Example 5: Pre-wrapped function
  console.log("5. Pre-wrapped function with limited()");
  const fetchWithLimit = limited(
    async (id) => {
      await sleep(50);
      return { id, data: `Data for ${id}` };
    },
    { concurrency: 2 }
  );

  const results = await Promise.all([
    fetchWithLimit(1),
    fetchWithLimit(2),
    fetchWithLimit(3),
  ]);
  console.log(`   Results: ${results.map((r) => r.data).join(", ")}`);
  console.log();

  console.log("=== All examples completed ===");
}

main().catch(console.error);
