import assert from "node:assert/strict";
import test from "node:test";

import os from "node:os";
import path from "node:path";

import {
  isDirectTailscaleHost,
  parseConfiguration,
  parseTailscaleTarget,
} from "../src/config.js";

test("accepts direct Tailscale targets", () => {
  const targets = [
    "100.64.0.1",
    "100.127.255.254",
    "mac-mini.example.ts.net",
    "mac-mini.example.ts.net.",
    "[fd7a:115c:a1e0::1]",
  ];

  for (const target of targets) {
    assert.equal(isDirectTailscaleHost(target), true, target);
  }
});

test("rejects targets outside the Tailscale address space", () => {
  const targets = [
    "100.63.255.255",
    "100.128.0.1",
    "192.168.1.20",
    "compute.example.com",
    "mac-mini",
    "-oProxyCommand=bad",
  ];

  for (const target of targets) {
    assert.equal(isDirectTailscaleHost(target), false, target);
  }
});

test("rejects hostile and ambiguous targets for SSH", () => {
  const targets = [
    "user@100.64.0.1:2222",
    "100.64.0.0/10",
    "user@100.64.0.1/32",
    "fd7a:115c:a1e0::1",
    "user@fd7a:115c:a1e0::1",
    "[fd7a:115c:a1e0::1]:22",
    "user@-oIdentityFile=/tmp/x 100.64.0.1",
    "-oProxyCommand=sh -i",
    "user@host.ts.net:22",
    "user@100.64.0.1#22",
    "100 .64.0.1",
    "user@100.64.0.1 pushd",
    "user@100.64.0.1\\ evil",
    "user@100.64.0.1\u0000",
    "user@",
    "@100.64.0.1",
  ];

  for (const target of targets) {
    const result = parseTailscaleTarget(target);
    assert.equal(result.ok, false, target);
  }
});

test("parses an SSH user without weakening target validation", () => {
  const result = parseTailscaleTarget("builder@100.71.137.123");

  assert.deepEqual(result, {
    ok: true,
    value: {
      destination: "builder@100.71.137.123",
      host: "100.71.137.123",
    },
  });
  assert.equal(parseTailscaleTarget("builder@203.0.113.9").ok, false);
});

test("reports missing required configuration as a value", () => {
  const result = parseConfiguration({});

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "missing_target");
  }
});

test("builds the default safe configuration", () => {
  const result = parseConfiguration({
    TAILSCALE_COMPUTE_HOST: "builder@100.71.137.123",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.remoteRoot, ".cache/tailscale-compute-mcp");
    assert.equal(result.value.remoteShell, "auto");
    assert.equal(result.value.connectTimeoutSeconds, 10);
    assert.equal(result.value.defaultWorkspace, undefined);
    assert.equal(
      result.value.auditLogPath,
      path.join(os.homedir(), ".config", "tailscale-compute-mcp", "compute-audit.log"),
    );
  }
});

test("honors an explicit audit log path", () => {
  const result = parseConfiguration({
    TAILSCALE_COMPUTE_HOST: "builder@100.71.137.123",
    TAILSCALE_COMPUTE_AUDIT_LOG: "/var/log/tailscale-compute/audit.log",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.auditLogPath, "/var/log/tailscale-compute/audit.log");
  }
});

test("rejects a remote root that can leave its managed path", () => {
  const result = parseConfiguration({
    TAILSCALE_COMPUTE_HOST: "100.71.137.123",
    TAILSCALE_COMPUTE_REMOTE_ROOT: "../other-data",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_remote_root");
  }
});

test("accepts one supported remote shell", () => {
  const result = parseConfiguration({
    TAILSCALE_COMPUTE_HOST: "100.71.137.123",
    TAILSCALE_COMPUTE_REMOTE_SHELL: "/bin/bash",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.remoteShell, "/bin/bash");
  }
});

test("rejects an unsupported remote shell", () => {
  const result = parseConfiguration({
    TAILSCALE_COMPUTE_HOST: "100.71.137.123",
    TAILSCALE_COMPUTE_REMOTE_SHELL: "/usr/bin/fish",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_remote_shell");
  }
});
