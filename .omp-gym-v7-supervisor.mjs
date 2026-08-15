import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const firstJobId = process.argv[2];
if (firstJobId === undefined) {
  throw new Error("usage: supervisor FIRST_JOB_ID");
}

const workspacePath = "/Users/dylantirandaz/omp";
const statePath = "/tmp/omp-gym-v7-supervisor-state.json";
const requestOptions = {
  timeout: 43_200_000,
  resetTimeoutOnProgress: true,
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./dist/main.js", import.meta.url))],
  env: process.env,
});
const client = new Client({ name: "omp-gym-v7-supervisor", version: "1.0.0" });

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function readSecondJobId() {
  if (!existsSync(statePath)) {
    return undefined;
  }
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (typeof state.secondJobId !== "string") {
    throw new Error("the supervisor state has no second job ID");
  }
  return state.secondJobId;
}

function writeSecondJobId(secondJobId) {
  writeFileSync(
    statePath,
    `${JSON.stringify({ firstJobId, secondJobId }, null, 2)}\n`,
    { mode: 0o600 },
  );
}


async function callTool(name, argumentsValue) {
  const result = await client.callTool(
    { name, arguments: argumentsValue },
    requestOptions,
  );
  if (result.structuredContent === undefined) {
    throw new Error(`${name} did not return structured content`);
  }
  return result.structuredContent;
}
async function callReadTool(name, argumentsValue) {
  for (;;) {
    const result = await callTool(name, argumentsValue);
    if (result.kind !== "unavailable") {
      return result;
    }
    console.error(`${name} is unavailable; retrying in 60 seconds`);
    await sleep(60_000);
  }
}


async function readNewLogs(jobId, offsetBytes) {
  let nextOffsetBytes = offsetBytes;
  for (;;) {
    const result = await callReadTool("compute_job_logs", {
      jobId,
      stream: "stdout",
      offsetBytes: nextOffsetBytes,
      maximumBytes: 65_536,
    });
    if (result.kind !== "log_chunk") {
      throw new Error(`log read failed: ${JSON.stringify(result)}`);
    }
    process.stdout.write(result.text);
    nextOffsetBytes = result.nextOffsetBytes;
    if (nextOffsetBytes >= result.totalBytes) {
      return nextOffsetBytes;
    }
  }
}

async function waitForJob(jobId, label) {
  let offsetBytes = 0;
  for (;;) {
    const status = await callReadTool("compute_job_status", { jobId });
    offsetBytes = await readNewLogs(jobId, offsetBytes);
    switch (status.kind) {
      case "starting":
      case "running":
        await sleep(60_000);
        break;
      case "completed":
        console.log(`\n${label} completed: ${jobId}`);
        return;
      case "failed":
      case "cancelled":
      case "lost":
      case "job_not_found":
      case "protocol_error":
        throw new Error(`${label} stopped: ${JSON.stringify(status)}`);
      default:
        throw new Error(`${label} returned an unknown state: ${JSON.stringify(status)}`);
    }
  }
}

await client.connect(transport);
try {
  let secondJobId = readSecondJobId();
  if (secondJobId === undefined) {
    await waitForJob(firstJobId, "v7a");

    const secondJob = await callTool("compute_job_start", {
      workspacePath,
      program: "/bin/zsh",
      arguments: [
        "-lc",
        "UV=$HOME/Library/Python/3.9/bin/uv; exec $UV run omp-gym train --data dataset --model mlx-community/Qwen2.5-3B-Instruct-4bit --iters 1000 --batch-size 1 --max-seq-length 2048 --adapter adapters/v7 --resume-adapter adapters/v7a/adapters.safetensors",
      ],
      environment: { PYTHONUNBUFFERED: "1" },
      workingDirectory: ".",
      syncMode: "none",
      timeoutSeconds: 43_200,
      requirements: {
        platform: "darwin",
        architecture: "arm64",
        minimumMemoryBytes: 16_000_000_000,
      },
    });
    if (secondJob.kind !== "started") {
      throw new Error(`v7 did not start: ${JSON.stringify(secondJob)}`);
    }
    secondJobId = secondJob.jobId;
    writeSecondJobId(secondJobId);
    console.log(`v7 started: ${secondJobId}`);
  } else {
    console.log(`v7 supervisor resumed: ${secondJobId}`);
  }
  await waitForJob(secondJobId, "v7");

  const fetchResult = await callTool("compute_fetch", {
    workspacePath,
    paths: ["adapters/v7"],
    localDestination: "runs/remote-v7",
    overwrite: true,
    timeoutSeconds: 600,
  });
  if (fetchResult.kind !== "completed") {
    throw new Error(`v7 fetch failed: ${JSON.stringify(fetchResult)}`);
  }
  console.log(`v7 fetched: ${JSON.stringify(fetchResult)}`);
} finally {
  await client.close();
}
