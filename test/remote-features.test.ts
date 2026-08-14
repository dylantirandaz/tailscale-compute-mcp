import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildJobAdmissionCommand,
  buildJobWrapperScript,
  decodeUtf8LogChunk,
  parseArtifactPaths,
  parseJobLogProtocol,
  parseJobAdmissionProtocol,
  parseJobStatusProtocol,
  resolveArtifactDestination,
} from "../src/compute.js";
import {
  parseRunReceiptJson,
  type ActiveRunReceipt,
} from "../src/receipt.js";

const EMPTY_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({});

function createWrapperReceipt(workspace: string): ActiveRunReceipt {
  return {
    runId: "12345678-1234-4234-8234-123456789abc",
    target: "test@100.64.0.1",
    serverVersion: "test",
    localWorkspace: workspace,
    remoteWorkspace: workspace,
    command: {
      program: process.execPath,
      arguments: [],
      environmentNames: [],
      workingDirectory: ".",
      hardwareRequirements: { kind: "none" },
    },
    workspaceRevision: {
      kind: "unavailable",
      reason: "This test does not use a Git work tree.",
    },
    sync: { mode: "none", durationMilliseconds: 0 },
    hardware: {
      kind: "unavailable",
      reason: "This test does not inspect hardware.",
    },
    timing: {
      kind: "active",
      startedAt: "2026-08-14T12:00:00.000Z",
    },
    result: { kind: "started" },
    output: { kind: "pending" },
    artifacts: [],
  };
}

interface ShellCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runShellCommand(
  command: string,
): Promise<ShellCommandResult> {
  const child = spawn("/bin/sh", ["-c", command], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [exitCode] = await once(child, "close");
  if (typeof exitCode !== "number") {
    throw new Error("The shell command ended without an exit code.");
  }
  return { exitCode, stdout, stderr };
}

test("admits one concurrent job at a node-wide limit of one", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tailscale-compute-admission-"));
  const jobsRoot = path.join(root, "jobs");
  const jobIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ] as const;
  try {
    const commandResults = await Promise.all(
      jobIds.map((jobId) =>
        runShellCommand(
          buildJobAdmissionCommand(root, jobsRoot, jobId, 1, 60),
        ),
      ),
    );
    assert.deepEqual(
      commandResults.map((result) => result.exitCode),
      [0, 0],
    );
    const admissionResults = commandResults.map((result) =>
      parseJobAdmissionProtocol(result.stdout),
    );
    assert.deepEqual(
      admissionResults
        .map((result) => (result.ok ? result.value.kind : "parse_error"))
        .sort(),
      ["admitted", "node_busy"],
    );
    for (const admissionResult of admissionResults) {
      assert.equal(admissionResult.ok, true);
      if (
        admissionResult.ok &&
        admissionResult.value.kind === "node_busy"
      ) {
        assert.equal(admissionResult.value.activeAdmissionCount, 1);
        assert.deepEqual(admissionResult.value.activeJobIds, []);
      }
    }
    assert.equal(
      jobIds.filter((jobId) =>
        existsSync(path.join(root, ".admissions", jobId)),
      ).length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs the durable job wrapper to one terminal state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tailscale-compute-job-"));
  const workspace = path.join(root, "workspace");
  const jobDirectory = path.join(root, "job");
  mkdirSync(workspace);
  mkdirSync(jobDirectory);
  const runScript = path.join(jobDirectory, "run.sh");
  try {
    const script = buildJobWrapperScript(jobDirectory, workspace, ".", {
      workspacePath: workspace,
      program: process.execPath,
      arguments: [
        "-e",
        "process.stdout.write('out'); process.stderr.write('err')",
      ],
      environment: EMPTY_ENVIRONMENT,
      workingDirectory: ".",
      syncMode: "none",
      standardInput: undefined,
      timeoutSeconds: 10,
      requirements: undefined,
      artifactPaths: [],
    }, createWrapperReceipt(workspace));
    writeFileSync(runScript, script, { mode: 0o700 });

    const child = spawn("/bin/sh", [runScript], {
      stdio: "ignore",
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    assert.equal(exitCode, 0);
    assert.equal(readFileSync(path.join(jobDirectory, "state"), "utf8").trim(), "completed");
    assert.equal(readFileSync(path.join(jobDirectory, "exit-code"), "utf8").trim(), "0");
    assert.equal(readFileSync(path.join(jobDirectory, "stdout"), "utf8"), "out");
    assert.equal(readFileSync(path.join(jobDirectory, "stderr"), "utf8"), "err");
    assert.equal(readFileSync(path.join(jobDirectory, "process-group-id"), "utf8").trim().length > 0, true);
    assert.equal(readFileSync(path.join(jobDirectory, "finished-at"), "utf8").trim().endsWith("Z"), true);
    const storedReceipt = parseRunReceiptJson(
      readFileSync(path.join(jobDirectory, "receipt.json"), "utf8"),
    );
    assert.equal(storedReceipt.kind, "parsed");
    if (storedReceipt.kind === "parsed") {
      assert.equal(storedReceipt.value.timing.kind, "finished");
      assert.deepEqual(storedReceipt.value.result, {
        kind: "completed",
        exitCode: 0,
      });
      assert.deepEqual(storedReceipt.value.artifacts, []);
      assert.deepEqual(storedReceipt.value.output, {
        kind: "captured",
        stdout: {
          totalBytes: 3,
          sha256: createHash("sha256").update("out").digest("hex"),
        },
        stderr: {
          totalBytes: 3,
          sha256: createHash("sha256").update("err").digest("hex"),
        },
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshots declared job artifacts with stable hashes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tailscale-compute-artifact-"));
  const workspace = path.join(root, "workspace");
  const jobDirectory = path.join(root, "job");
  mkdirSync(workspace);
  mkdirSync(jobDirectory);
  const runScript = path.join(jobDirectory, "run.sh");
  const artifactPath = `result/model"${String.fromCharCode(10)}é.bin`;
  try {
    const script = buildJobWrapperScript(jobDirectory, workspace, ".", {
      workspacePath: workspace,
      program: process.execPath,
      arguments: [
        "-e",
        `const fs=require('node:fs');fs.mkdirSync('result');fs.writeFileSync(${JSON.stringify(artifactPath)},'weights')`,
      ],
      environment: EMPTY_ENVIRONMENT,
      workingDirectory: ".",
      syncMode: "none",
      standardInput: undefined,
      timeoutSeconds: 10,
      requirements: undefined,
      artifactPaths: [artifactPath],
    }, createWrapperReceipt(workspace));
    writeFileSync(runScript, script, { mode: 0o700 });

    const child = spawn("/bin/sh", [runScript], { stdio: "ignore" });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    assert.equal(exitCode, 0);
    assert.equal(
      readFileSync(path.join(jobDirectory, "state"), "utf8").trim(),
      "completed",
    );
    const snapshotPath = path.join(
      jobDirectory,
      "artifacts",
      artifactPath,
    );
    assert.equal(readFileSync(snapshotPath, "utf8"), "weights");
    const sha256 = createHash("sha256").update("weights").digest("hex");
    const encodedPath = Buffer.from(artifactPath).toString("base64");
    assert.equal(
      readFileSync(path.join(jobDirectory, "artifacts.manifest"), "utf8"),
      `${encodedPath}\t7\t${sha256}\n`,
    );
    const storedReceipt = parseRunReceiptJson(
      readFileSync(path.join(jobDirectory, "receipt.json"), "utf8"),
    );
    assert.equal(storedReceipt.kind, "parsed");
    if (storedReceipt.kind === "parsed") {
      assert.equal(storedReceipt.value.timing.kind, "finished");
      assert.deepEqual(storedReceipt.value.artifacts, [
        {
          path: artifactPath,
          sizeBytes: 7,
          sha256,
        },
      ]);
    }

    writeFileSync(path.join(workspace, artifactPath), "changed");
    assert.equal(readFileSync(snapshotPath, "utf8"), "weights");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parses every durable job terminal state", () => {
  const startedAt = "2026-08-14T12:00:00.000Z";
  const receipt = {
    runId: "12345678-1234-4234-8234-123456789abc",
    target: "builder@example.ts.net",
    serverVersion: "0.1.0-test",
    localWorkspace: "/workspace",
    remoteWorkspace: ".cache/project",
    command: {
      program: "/bin/sh",
      arguments: ["-c", "true"],
      environmentNames: [],
      workingDirectory: ".",
      hardwareRequirements: { kind: "none" },
    },
    workspaceRevision: { kind: "unavailable", reason: "test" },
    sync: { mode: "none", durationMilliseconds: 0 },
    hardware: { kind: "unavailable", reason: "test" },
    timing: { kind: "active", startedAt },
    result: { kind: "started" },
    output: { kind: "pending" },
    artifacts: [],
  };
  const common = [
    "remoteWorkspace=.cache/project",
    `startedAt=${startedAt}`,
    `receiptBase64=${Buffer.from(JSON.stringify(receipt)).toString("base64")}`,
  ].join("\n");
  const output = [
    "stdoutBytes=0",
    `stdoutSha256=${"0".repeat(64)}`,
    "stderrBytes=0",
    `stderrSha256=${"1".repeat(64)}`,
    "artifactManifestBase64=",
  ].join("\n");

  const running = parseJobStatusProtocol(
    `kind=running\n${common}\nprocessGroupId=42\n`,
  );
  assert.equal(running.ok, true);
  if (running.ok && running.value.kind === "running") {
    assert.equal(running.value.processGroupId, 42);
    assert.equal(running.value.receipt.runId, receipt.runId);
  }

  const completed = parseJobStatusProtocol(
    `kind=completed\n${common}\nfinishedAt=2026-08-14T12:01:00Z\nexitCode=0\n${output}\n`,
  );
  assert.equal(completed.ok, true);
  if (completed.ok && completed.value.kind === "completed") {
    assert.deepEqual(completed.value.termination, { kind: "completed" });
  }

  const exited = parseJobStatusProtocol(
    `kind=failed\n${common}\nfinishedAt=2026-08-14T12:01:00Z\nexitCode=7\ntimedOut=false\ntimeoutSeconds=900\noomKillCount=\n${output}\n`,
  );
  assert.equal(exited.ok, true);
  if (exited.ok && exited.value.kind === "failed") {
    assert.deepEqual(exited.value.termination, { kind: "exited", exitCode: 7 });
  }

  const signalled = parseJobStatusProtocol(
    `kind=failed\n${common}\nfinishedAt=2026-08-14T12:01:00Z\nexitCode=143\ntimedOut=false\ntimeoutSeconds=900\noomKillCount=\n${output}\n`,
  );
  assert.equal(signalled.ok, true);
  if (signalled.ok && signalled.value.kind === "failed") {
    assert.deepEqual(signalled.value.termination, {
      kind: "signalled",
      signalNumber: 15,
    });
  }

  const timedOut = parseJobStatusProtocol(
    `kind=failed\n${common}\nfinishedAt=2026-08-14T12:01:00Z\nexitCode=124\ntimedOut=true\ntimeoutSeconds=20\noomKillCount=\n${output}\n`,
  );
  assert.equal(timedOut.ok, true);
  if (timedOut.ok && timedOut.value.kind === "failed") {
    assert.deepEqual(timedOut.value.termination, {
      kind: "timed_out",
      timeoutSeconds: 20,
    });
  }

  const oomKilled = parseJobStatusProtocol(
    `kind=failed\n${common}\nfinishedAt=2026-08-14T12:01:00Z\nexitCode=137\ntimedOut=false\ntimeoutSeconds=900\noomKillCount=2\n${output}\n`,
  );
  assert.equal(oomKilled.ok, true);
  if (oomKilled.ok && oomKilled.value.kind === "failed") {
    assert.deepEqual(oomKilled.value.termination, {
      kind: "oom_killed",
      evidence: { kind: "cgroup", oomKillCount: 2 },
    });
  }

  const exit137WithoutOomEvidence = parseJobStatusProtocol(
    `kind=failed\n${common}\nfinishedAt=2026-08-14T12:01:00Z\nexitCode=137\ntimedOut=false\ntimeoutSeconds=900\noomKillCount=\n${output}\n`,
  );
  assert.equal(exit137WithoutOomEvidence.ok, true);
  if (
    exit137WithoutOomEvidence.ok &&
    exit137WithoutOomEvidence.value.kind === "failed"
  ) {
    assert.deepEqual(exit137WithoutOomEvidence.value.termination, {
      kind: "signalled",
      signalNumber: 9,
    });
  }

  const cancelled = parseJobStatusProtocol(
    `kind=cancelled\n${common}\nfinishedAt=2026-08-14T12:01:00Z\n${output}\n`,
  );
  assert.equal(cancelled.ok, true);
  if (cancelled.ok && cancelled.value.kind === "cancelled") {
    assert.deepEqual(cancelled.value.termination, { kind: "cancelled" });
  }

  const lost = parseJobStatusProtocol(
    `kind=lost\n${common}\nfinishedAt=2026-08-14T12:01:00Z\nlastKnownState=running\nreason=missing process\n${output}\n`,
  );
  assert.equal(lost.ok, true);
  if (lost.ok && lost.value.kind === "lost") {
    assert.deepEqual(lost.value.termination, {
      kind: "lost",
      reason: "missing process",
    });
  }

  assert.equal(
    parseJobStatusProtocol(
      `kind=completed\n${common}\nfinishedAt=2026-08-14T12:01:00Z\nexitCode=3\n${output}\n`,
    ).ok,
    false,
  );
});

test("reads paged UTF-8 logs on byte boundaries", () => {
  const fullText = "αβγ";
  const fullBytes = Buffer.from(fullText, "utf8");
  const encodedChunk = fullBytes.subarray(0, 5).toString("base64");
  const protocol = parseJobLogProtocol({
    text: `kind=data\ntotalBytes=${fullBytes.byteLength}\ndataBase64=${encodedChunk}\n`,
    totalBytes: encodedChunk.length,
    omittedBytes: 0,
    sha256: "0".repeat(64),
  });
  assert.equal(protocol.ok, true);
  if (!protocol.ok || protocol.value.kind !== "data") {
    return;
  }

  const decoded = decodeUtf8LogChunk(
    protocol.value.bytes,
    0,
    protocol.value.totalBytes,
  );
  assert.deepEqual(decoded, {
    ok: true,
    value: { text: "αβ", consumedBytes: 4 },
  });
  assert.equal(decodeUtf8LogChunk(fullBytes.subarray(1), 1, fullBytes.length).ok, false);
});

test("keeps artifact paths and destinations inside the workspace", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "tailscale-compute-fetch-"));
  try {
    assert.deepEqual(parseArtifactPaths(["build/app", "results.json"]), {
      ok: true,
      value: ["build/app", "results.json"],
    });
    assert.equal(parseArtifactPaths(["../secret"]).ok, false);
    assert.equal(parseArtifactPaths(["result", "result"]).ok, false);

    const destination = resolveArtifactDestination(
      workspace,
      "artifacts/run-1",
      false,
    );
    assert.equal(destination.ok, true);

    mkdirSync(path.join(workspace, "existing"));
    assert.equal(
      resolveArtifactDestination(workspace, "existing", false).ok,
      false,
    );

    mkdirSync(path.join(workspace, "outside"));
    symlinkSync(path.join(workspace, "outside"), path.join(workspace, "link"));
    assert.equal(
      resolveArtifactDestination(workspace, "link/result", true).ok,
      false,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
