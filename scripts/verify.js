#!/usr/bin/env node

const { execSync } = require("child_process");

function run(label, cmd) {
  console.log(`==> ${label}`);
  try {
    execSync(cmd, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

let success = true;

success = run("tests", "node test/run.js") && success;
console.log();
success = run("sample", "node sample/app.js") && success;
console.log();
success = run("benchmarks", "node benchmark/bench.js") && success;

process.exit(success ? 0 : 1);
