import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  DEFAULT_SYNC_EXCLUSION_ARGUMENTS,
  buildSyncFilterArguments,
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
  assert.deepEqual(DEFAULT_SYNC_EXCLUSION_ARGUMENTS, [
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
    ".ssh/",
    "--exclude",
    ".aws/",
    "--exclude",
    ".gnupg/",
    "--exclude",
    ".git-credentials",
    "--exclude",
    ".netrc",
    "--exclude",
    "*_history",
    "--exclude",
    ".curlrc",
    "--exclude",
    ".wgetrc",
    "--exclude",
    "*.pem",
    "--exclude",
    "*.key",
    "--exclude",
    "*.p12",
    "--exclude",
    "*.pfx",
    "--exclude",
    "*.secret",
    "--exclude",
    "secrets/",
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

test("uses fixed exclusions when workspace ignore files are absent", () => {
  const arguments_ = buildSyncFilterArguments("/some/workspace");
  assert.deepEqual(arguments_, DEFAULT_SYNC_EXCLUSION_ARGUMENTS);
});

test("uses the workspace ignore files, not the process directory", () => {
  const directory = mkdtempSync(`${tmpdir()}/tailscale-compute-ignore-`);
  try {
    writeFileSync(
      `${directory}/.tailscale-compute-ignore`,
      [
        "generated.log",
        "build-out/",
        "!keep.generated.log",
        "!.env",
        "bad\0pattern",
        "# comment and blank lines are skipped",
        "",
        "/root-only.txt",
      ].join("\n"),
    );
    writeFileSync(`${directory}/.gitignore`, "*.tmp\n");

    const filterArguments = buildSyncFilterArguments(directory);
    assert.deepEqual(
      filterArguments.slice(0, DEFAULT_SYNC_EXCLUSION_ARGUMENTS.length),
      DEFAULT_SYNC_EXCLUSION_ARGUMENTS,
    );
    assert.deepEqual(
      filterArguments.slice(DEFAULT_SYNC_EXCLUSION_ARGUMENTS.length),
      [
        "--include",
        "keep.generated.log",
        "--include",
        ".env",
        "--exclude",
        "*.tmp",
        "--exclude",
        "generated.log",
        "--exclude",
        "build-out/",
        "--exclude",
        "/root-only.txt",
      ],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("skips a runaway ignore file", () => {
  const directory = mkdtempSync(`${tmpdir()}/tailscale-compute-ignore-`);
  try {
    const content = "x\n".repeat(600_000);
    writeFileSync(`${directory}/.gitignore`, content);
    assert.deepEqual(
      buildSyncFilterArguments(directory),
      DEFAULT_SYNC_EXCLUSION_ARGUMENTS,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("quotes remote command values without shell expansion", () => {
  const values = [
    "plain",
    "two words",
    "apostrophe's value",
    "$(printf injected)",
    "`printf injected`",
    "a | b; c && d",
    "' ; rm -rf / ; '",
    "* ? [x] {y}",
    '~ " double" \\ backslash',
    "line one\nline two",
    "!bang # comment",
    "日本語-π",
    "\u001b[31mred\u001b[0m",
    "$IFS$(id)",
    "a\tb",
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
      "uid=501",
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
      uid: 501,
      isRoot: false,
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
      "uid=1000",
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
      uid: 1000,
      isRoot: false,
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
      "uid=0",
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

test("flags a root remote compute user", () => {
  const result = parseRemoteHardware(
    [
      "platform=Linux",
      "hostname=root-node",
      "architecture=aarch64",
      "shell=/bin/bash",
      "rsyncVersion=rsync version 3.2.7 protocol version 31",
      "uid=0",
      "distributionName=Debian GNU/Linux",
      "distributionVersion=12",
      "kernelVersion=6.1.0",
      "processor=Example CPU",
      "logicalProcessors=4",
      "memoryKilobytes=32768",
    ].join("\n"),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.uid, 0);
    assert.equal(result.value.isRoot, true);
  }
});

test("rejects a probe without a remote user id", () => {
  const result = parseRemoteHardware(
    [
      "platform=Linux",
      "hostname=broken-node",
      "architecture=x86_64",
      "shell=/bin/bash",
      "rsyncVersion=rsync version 3.2.7 protocol version 31",
      "distributionName=Ubuntu",
      "distributionVersion=24.04",
      "kernelVersion=6.1.0",
      "processor=Example CPU",
      "logicalProcessors=4",
      "memoryKilobytes=32768",
    ].join("\n"),
  );

  assert.equal(result.ok, false);
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
