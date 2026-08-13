import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  DEFAULT_SYNC_FILTER_ARGUMENTS,
  parseRemoteHardware,
  parseRemoteRelativePath,
  quoteForPosixShell,
} from "../src/compute.js";

test("keeps a remote working directory inside the workspace", () => {
  assert.deepEqual(parseRemoteRelativePath("packages/app"), {
    ok: true,
    value: "packages/app",
  });
  assert.deepEqual(parseRemoteRelativePath("packages/../app"), {
    ok: true,
    value: "app",
  });

  assert.equal(parseRemoteRelativePath("../outside").ok, false);
  assert.equal(parseRemoteRelativePath("/absolute").ok, false);
  assert.equal(parseRemoteRelativePath("windows\\path").ok, false);
});

test("protects ignored files and common credentials during sync", () => {
  assert.deepEqual(DEFAULT_SYNC_FILTER_ARGUMENTS, [
    "--filter=:- .gitignore",
    "--filter=:- .tailscale-compute-ignore",
    "--exclude",
    ".git/",
    "--exclude",
    ".env",
    "--exclude",
    ".env.*",
    "--exclude",
    ".npmrc",
    "--exclude",
    ".pypirc",
    "--exclude",
    "*.pem",
    "--exclude",
    "*.key",
    "--exclude",
    "*.p12",
    "--exclude",
    "*.pfx",
    "--exclude",
    "node_modules/",
    "--exclude",
    ".venv/",
    "--exclude",
    "venv/",
    "--exclude",
    "target/",
    "--exclude",
    "__pycache__/",
    "--exclude",
    ".next/cache/",
  ]);
});

test("quotes remote command values without shell expansion", () => {
  const values = [
    "plain",
    "two words",
    "apostrophe's value",
    "$(printf injected)",
    "line one\nline two",
  ];

  for (const value of values) {
    const output = execFileSync(
      "/bin/sh",
      ["-lc", `printf %s ${quoteForPosixShell(value)}`],
      { encoding: "utf8" },
    );
    assert.equal(output, value);
  }
});

test("parses Darwin hardware with an automatic zsh selection", () => {
  const result = parseRemoteHardware(
    [
      "platform=Darwin",
      "hostname=mac-mini.local",
      "architecture=arm64",
      "shell=/bin/zsh",
      "rsyncVersion=openrsync: protocol version 29",
      "productName=macOS",
      "productVersion=26.5.1",
      "buildVersion=25F80",
      "processor=Apple M4",
      "logicalProcessors=10",
      "memoryBytes=17179869184",
    ].join("\n"),
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      platform: "darwin",
      hostname: "mac-mini.local",
      architecture: "arm64",
      processor: "Apple M4",
      logicalProcessors: 10,
      memoryBytes: 17_179_869_184,
      shell: "/bin/zsh",
      rsyncVersion: "openrsync: protocol version 29",
      acceleratorInventory: { kind: "none" },
      productName: "macOS",
      productVersion: "26.5.1",
      buildVersion: "25F80",
    },
  });
});

test("parses Linux hardware and NVIDIA accelerator inventory", () => {
  const result = parseRemoteHardware(
    [
      "platform=Linux",
      "hostname=dgx-spark",
      "architecture=aarch64",
      "shell=/bin/bash",
      "rsyncVersion=rsync version 3.2.7 protocol version 31",
      "distributionName=Ubuntu 24.04.3 LTS",
      "distributionVersion=24.04",
      "kernelVersion=6.11.0",
      "processor=ARMv8 Processor",
      "logicalProcessors=20",
      "memoryKilobytes=131072",
      "nvidia=0, NVIDIA GB10, GPU-1234, 8192, 580.95",
    ].join("\n"),
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      platform: "linux",
      hostname: "dgx-spark",
      architecture: "aarch64",
      processor: "ARMv8 Processor",
      logicalProcessors: 20,
      memoryBytes: 134_217_728,
      shell: "/bin/bash",
      rsyncVersion: "rsync version 3.2.7 protocol version 31",
      acceleratorInventory: {
        kind: "nvidia",
        devices: [
          {
            kind: "nvidia",
            index: 0,
            name: "NVIDIA GB10",
            uuid: "GPU-1234",
            memoryBytes: 8_589_934_592,
            driverVersion: "580.95",
          },
        ],
      },
      distributionName: "Ubuntu 24.04.3 LTS",
      distributionVersion: "24.04",
      kernelVersion: "6.11.0",
    },
  });
});

test("reports an accelerator probe failure without hiding host hardware", () => {
  const result = parseRemoteHardware(
    [
      "platform=Linux",
      "hostname=linux-node",
      "architecture=x86_64",
      "shell=/bin/bash",
      "rsyncVersion=rsync version 3.2.7 protocol version 31",
      "distributionName=Ubuntu",
      "distributionVersion=24.04",
      "kernelVersion=6.8.0",
      "processor=Example CPU",
      "logicalProcessors=8",
      "memoryKilobytes=65536",
      "acceleratorError=nvidia-smi failed: driver unavailable",
    ].join("\n"),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.acceleratorInventory, {
      kind: "error",
      message: "nvidia-smi failed: driver unavailable",
    });
  }
});

test("rejects unsupported remote platforms", () => {
  const result = parseRemoteHardware(
    "platform=FreeBSD\nprobeError=Unsupported remote platform: FreeBSD",
  );

  assert.deepEqual(result, {
    ok: false,
    error: "Unsupported remote platform: FreeBSD",
  });
});
