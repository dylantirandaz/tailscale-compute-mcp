import assert from "node:assert/strict";
import test from "node:test";

import { runProcess } from "../src/process.js";

const OUTPUT_LIMIT_BYTES = 4_096;

test("captures a completed process result", async () => {
  const outcome = await runProcess({
    executable: process.execPath,
    arguments: [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7;",
    ],
    timeoutMilliseconds: 5_000,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
  });

  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {
    assert.equal(outcome.exitCode, 7);
    assert.equal(outcome.stdout.text, "out");
    assert.equal(outcome.stderr.text, "err");
  }
});

test("passes UTF-8 standard input", async () => {
  const outcome = await runProcess({
    executable: process.execPath,
    arguments: ["-e", "process.stdin.pipe(process.stdout);"],
    standardInput: "input value",
    timeoutMilliseconds: 5_000,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
  });

  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.stdout.text, "input value");
});

test("keeps the start and end when output is truncated", async () => {
  const outcome = await runProcess({
    executable: process.execPath,
    arguments: [
      "-e",
      "process.stdout.write('START' + 'x'.repeat(1000) + 'END');",
    ],
    timeoutMilliseconds: 5_000,
    outputLimitBytes: 100,
  });

  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.stdout.text.startsWith("START"), true);
  assert.equal(outcome.stdout.text.endsWith("END"), true);
  assert.equal(outcome.stdout.omittedBytes > 0, true);
  assert.equal(outcome.stdout.totalBytes, 1_008);
});

// Fake timers cannot drive or stop an operating system child process.
test("returns a timeout and stops the child process", async () => {
  const outcome = await runProcess({
    executable: process.execPath,
    arguments: [
      "-e",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    ],
    timeoutMilliseconds: 50,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
  });

  assert.equal(outcome.kind, "timed_out");
  assert.equal(outcome.durationMilliseconds < 2_000, true);
});

test("returns an executable error as a value", async () => {
  const outcome = await runProcess({
    executable: "tailscale-compute-command-that-does-not-exist",
    arguments: [],
    timeoutMilliseconds: 5_000,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
  });

  assert.equal(outcome.kind, "spawn_error");
  if (outcome.kind === "spawn_error") {
    assert.equal(outcome.code, "ENOENT");
  }
});
