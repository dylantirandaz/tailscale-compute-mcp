import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeAuditEntry } from "../src/audit.js";

const baseFields = {
  timestamp: "2026-08-13T00:00:00.000Z",
  target: "builder@100.71.137.123",
  remoteWorkspace: ".cache/tailscale-compute-mcp/project-abc",
  localWorkspace: "/Users/builder/project",
  program: "/bin/zsh",
  arguments: ["-lc", "npm test"],
  workingDirectory: ".",
  syncMode: "incremental",
};

test("appends a JSON audit line and creates its directory", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tailscale-compute-audit-"));
  const logPath = path.join(directory, "nested", "compute-audit.log");
  try {
    const first = writeAuditEntry(logPath, {
      ...baseFields,
      outcomeKind: "completed",
      exitCode: 0,
      stage: undefined,
    });
    assert.deepEqual(first, { kind: "appended" });

    const second = writeAuditEntry(logPath, {
      ...baseFields,
      outcomeKind: "stage_failed",
      exitCode: undefined,
      stage: "command",
    });
    assert.deepEqual(second, { kind: "appended" });

    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
    assert.equal(statSync(path.dirname(logPath)).mode & 0o777, 0o700);
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
    assert.equal(lines.length, 2);
    const firstLine = lines[0];
    const secondLine = lines[1];
    assert.ok(firstLine !== undefined);
    assert.ok(secondLine !== undefined);
    assert.deepEqual(JSON.parse(firstLine), {
      ...baseFields,
      outcomeKind: "completed",
      exitCode: 0,
    });
    assert.deepEqual(JSON.parse(secondLine), {
      ...baseFields,
      outcomeKind: "stage_failed",
      stage: "command",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports append failure as a value", () => {
  const result = writeAuditEntry("/dev/null/impossible/audit.log", {
    ...baseFields,
    outcomeKind: "completed",
    exitCode: 0,
    stage: undefined,
  });
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.equal(result.message.length > 0, true);
  }
});
