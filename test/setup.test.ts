import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  renderClientConfiguration,
  setupOmpUserConfiguration,
} from "../src/setup.js";

const FLEET_SKILL_CONTENT = readFileSync(
  path.join(
    process.cwd(),
    "skills",
    "tailscale-compute-fleet",
    "SKILL.md",
  ),
  "utf8",
);

function withTemporaryHome(run: (homeDirectory: string) => void): void {
  const homeDirectory = mkdtempSync(path.join(os.tmpdir(), "tailscale-omp-"));
  try {
    run(homeDirectory);
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true });
  }
}

test("adds the server and fleet skill without changing other servers", () => {
  withTemporaryHome((homeDirectory) => {
    const configurationDirectory = path.join(homeDirectory, ".omp", "agent");
    const configurationPath = path.join(configurationDirectory, "mcp.json");
    const skillPath = path.join(
      configurationDirectory,
      "skills",
      "tailscale-compute-fleet",
      "SKILL.md",
    );
    mkdirSync(configurationDirectory, { recursive: true });
    writeFileSync(
      configurationPath,
      `${JSON.stringify({ mcpServers: { existing: { url: "https://example.test/mcp" } } })}\n`,
    );

    const outcome = setupOmpUserConfiguration({
      homeDirectory,
      target: "developer@100.64.0.1",
      packageVersion: "1.2.3",
      skillContent: FLEET_SKILL_CONTENT,
    });
    assert.deepEqual(outcome, {
      kind: "configured",
      path: configurationPath,
      skillPath,
      serverName: "tailscale-compute",
      restartRequired: true,
    });
    assert.deepEqual(JSON.parse(readFileSync(configurationPath, "utf8")), {
      mcpServers: {
        existing: { url: "https://example.test/mcp" },
        "tailscale-compute": {
          type: "stdio",
          command: "npx",
          args: ["-y", "@dylantirandaz/tailscale-compute-mcp@1.2.3"],
          env: { TAILSCALE_COMPUTE_HOST: "developer@100.64.0.1" },
        },
      },
      $schema:
        "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
    });
    assert.equal(statSync(configurationPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(skillPath, "utf8"), FLEET_SKILL_CONTENT);
    assert.equal(statSync(skillPath).mode & 0o777, 0o600);

    assert.equal(
      setupOmpUserConfiguration({
        homeDirectory,
        target: "developer@100.64.0.1",
        packageVersion: "1.2.3",
        skillContent: FLEET_SKILL_CONTENT,
      }).kind,
      "already_configured",
    );
  });
});

test("adds several named compute nodes for fleet placement", () => {
  withTemporaryHome((homeDirectory) => {
    const invalidOutcome = setupOmpUserConfiguration({
      homeDirectory,
      target: "developer@100.64.0.1",
      packageVersion: "1.2.3",
      serverName: "invalid server name",
      skillContent: FLEET_SKILL_CONTENT,
    });
    assert.equal(invalidOutcome.kind, "refused");
    if (invalidOutcome.kind === "refused") {
      assert.equal(invalidOutcome.reason, "invalid_server_name");
    }

    const firstOutcome = setupOmpUserConfiguration({
      homeDirectory,
      target: "developer@100.64.0.1",
      packageVersion: "1.2.3",
      serverName: "compute-mac-mini-1",
      skillContent: FLEET_SKILL_CONTENT,
    });
    assert.equal(firstOutcome.kind, "configured");

    const secondOutcome = setupOmpUserConfiguration({
      homeDirectory,
      target: "developer@100.64.0.2",
      packageVersion: "1.2.3",
      serverName: "compute-mac-mini-2",
      skillContent: FLEET_SKILL_CONTENT,
    });
    assert.equal(secondOutcome.kind, "configured");

    const configurationPath = path.join(
      homeDirectory,
      ".omp",
      "agent",
      "mcp.json",
    );
    assert.deepEqual(JSON.parse(readFileSync(configurationPath, "utf8")), {
      mcpServers: {
        "compute-mac-mini-1": {
          type: "stdio",
          command: "npx",
          args: ["-y", "@dylantirandaz/tailscale-compute-mcp@1.2.3"],
          env: { TAILSCALE_COMPUTE_HOST: "developer@100.64.0.1" },
        },
        "compute-mac-mini-2": {
          type: "stdio",
          command: "npx",
          args: ["-y", "@dylantirandaz/tailscale-compute-mcp@1.2.3"],
          env: { TAILSCALE_COMPUTE_HOST: "developer@100.64.0.2" },
        },
      },
      $schema:
        "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
    });
  });
});

test("refuses to replace an unmanaged fleet skill", () => {
  withTemporaryHome((homeDirectory) => {
    const skillPath = path.join(
      homeDirectory,
      ".omp",
      "agent",
      "skills",
      "tailscale-compute-fleet",
      "SKILL.md",
    );
    const configurationPath = path.join(
      homeDirectory,
      ".omp",
      "agent",
      "mcp.json",
    );
    const customSkill = "---\nname: tailscale-compute-fleet\n---\n# Custom\n";
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, customSkill);

    const outcome = setupOmpUserConfiguration({
      homeDirectory,
      target: "developer@100.64.0.1",
      packageVersion: "1.2.3",
      skillContent: FLEET_SKILL_CONTENT,
    });
    assert.equal(outcome.kind, "refused");
    if (outcome.kind === "refused") {
      assert.equal(outcome.reason, "skill_name_conflict");
    }
    assert.equal(existsSync(configurationPath), false);
    assert.equal(readFileSync(skillPath, "utf8"), customSkill);
  });
});

test("refuses a symbolic-link fleet skill", () => {
  withTemporaryHome((homeDirectory) => {
    const skillPath = path.join(
      homeDirectory,
      ".omp",
      "agent",
      "skills",
      "tailscale-compute-fleet",
      "SKILL.md",
    );
    const linkedPath = path.join(homeDirectory, "linked-skill.md");
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(linkedPath, FLEET_SKILL_CONTENT);
    symlinkSync(linkedPath, skillPath);

    const outcome = setupOmpUserConfiguration({
      homeDirectory,
      target: "developer@100.64.0.1",
      packageVersion: "1.2.3",
      skillContent: FLEET_SKILL_CONTENT,
    });
    assert.equal(outcome.kind, "refused");
    if (outcome.kind === "refused") {
      assert.equal(outcome.reason, "symbolic_link");
    }
    assert.equal(readFileSync(linkedPath, "utf8"), FLEET_SKILL_CONTENT);
  });
});

test("refuses to replace an existing server", () => {
  withTemporaryHome((homeDirectory) => {
    const configurationDirectory = path.join(homeDirectory, ".omp", "agent");
    const configurationPath = path.join(configurationDirectory, "mcp.json");
    mkdirSync(configurationDirectory, { recursive: true });
    const original = `${JSON.stringify({ mcpServers: { "tailscale-compute": { command: "custom" } } })}\n`;
    writeFileSync(configurationPath, original);

    const outcome = setupOmpUserConfiguration({
      homeDirectory,
      target: "developer@100.64.0.1",
      packageVersion: "1.2.3",
      skillContent: FLEET_SKILL_CONTENT,
    });
    assert.equal(outcome.kind, "refused");
    if (outcome.kind === "refused") {
      assert.equal(outcome.reason, "server_name_conflict");
    }
    assert.equal(readFileSync(configurationPath, "utf8"), original);
  });
});

test("refuses malformed OMP configuration", () => {
  withTemporaryHome((homeDirectory) => {
    const configurationDirectory = path.join(homeDirectory, ".omp", "agent");
    const configurationPath = path.join(configurationDirectory, "mcp.json");
    mkdirSync(configurationDirectory, { recursive: true });
    writeFileSync(configurationPath, "not JSON\n");

    const outcome = setupOmpUserConfiguration({
      homeDirectory,
      target: "developer@100.64.0.1",
      packageVersion: "1.2.3",
      skillContent: FLEET_SKILL_CONTENT,
    });
    assert.equal(outcome.kind, "refused");
    if (outcome.kind === "refused") {
      assert.equal(outcome.reason, "invalid_configuration");
    }
    assert.equal(readFileSync(configurationPath, "utf8"), "not JSON\n");
  });
});

test("refuses a symbolic-link OMP configuration", () => {
  withTemporaryHome((homeDirectory) => {
    const configurationDirectory = path.join(homeDirectory, ".omp", "agent");
    const configurationPath = path.join(configurationDirectory, "mcp.json");
    const linkedPath = path.join(homeDirectory, "linked.json");
    mkdirSync(configurationDirectory, { recursive: true });
    writeFileSync(linkedPath, "{}\n");
    symlinkSync(linkedPath, configurationPath);

    const outcome = setupOmpUserConfiguration({
      homeDirectory,
      target: "developer@100.64.0.1",
      packageVersion: "1.2.3",
      skillContent: FLEET_SKILL_CONTENT,
    });
    assert.equal(outcome.kind, "refused");
    if (outcome.kind === "refused") {
      assert.equal(outcome.reason, "symbolic_link");
    }
    assert.equal(readFileSync(linkedPath, "utf8"), "{}\n");
  });
});

test("shows the OMP path and does not write after a failed check", () => {
  withTemporaryHome((homeDirectory) => {
    const mainPath = fileURLToPath(new URL("../src/main.js", import.meta.url));
    const configurationPath = path.join(
      homeDirectory,
      ".omp",
      "agent",
      "mcp.json",
    );
    const skillPath = path.join(
      homeDirectory,
      ".omp",
      "agent",
      "skills",
      "tailscale-compute-fleet",
      "SKILL.md",
    );
    const result = spawnSync(
      process.execPath,
      [mainPath, "setup", "omp", "--host", "developer@example.com"],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: homeDirectory },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      `OMP configuration file: ${configurationPath}\nOMP fleet skill file: ${skillPath}\n`,
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      kind: "connection_check_failed",
      path: configurationPath,
      skillPath,
      connection: {
        kind: "configuration_error",
        code: "invalid_target",
        message:
          "The target 'developer@example.com' is not a direct Tailscale node. Use a 100.64.0.0/10 address, a Tailscale IPv6 address, or a full .ts.net name.",
      },
    });
    assert.equal(existsSync(configurationPath), false);
    assert.equal(existsSync(skillPath), false);
  });
});

test("renders pinned configurations for supported MCP clients", () => {
  const request = {
    target: "developer@100.64.0.1",
    packageVersion: "1.2.3",
  } as const;
  const claude = renderClientConfiguration({
    ...request,
    client: "claude",
  });
  assert.deepEqual(claude, {
    kind: "rendered",
    client: "claude",
    format: "shell",
    content: [
      "claude mcp add --scope user",
      "  --env TAILSCALE_COMPUTE_HOST=developer@100.64.0.1",
      "  --transport stdio tailscale-compute",
      "  -- npx -y @dylantirandaz/tailscale-compute-mcp@1.2.3",
    ].join(" \\\n"),
  });

  const cursor = renderClientConfiguration({
    ...request,
    client: "cursor",
  });
  assert.equal(cursor.kind, "rendered");
  if (cursor.kind === "rendered") {
    assert.deepEqual(JSON.parse(cursor.content), {
      mcpServers: {
        "tailscale-compute": {
          command: "npx",
          args: [
            "-y",
            "@dylantirandaz/tailscale-compute-mcp@1.2.3",
          ],
          env: {
            TAILSCALE_COMPUTE_HOST: "developer@100.64.0.1",
          },
        },
      },
    });
  }

  const codex = renderClientConfiguration({
    ...request,
    client: "codex",
  });
  assert.deepEqual(codex, {
    kind: "rendered",
    client: "codex",
    format: "toml",
    content: [
      "[mcp_servers.tailscale-compute]",
      'command = "npx"',
      'args = ["-y", "@dylantirandaz/tailscale-compute-mcp@1.2.3"]',
      "",
      "[mcp_servers.tailscale-compute.env]",
      'TAILSCALE_COMPUTE_HOST = "developer@100.64.0.1"',
    ].join("\n"),
  });

  const opencode = renderClientConfiguration({
    ...request,
    client: "opencode",
  });
  assert.equal(opencode.kind, "rendered");
  if (opencode.kind === "rendered") {
    assert.deepEqual(JSON.parse(opencode.content), {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        "tailscale-compute": {
          type: "local",
          command: [
            "npx",
            "-y",
            "@dylantirandaz/tailscale-compute-mcp@1.2.3",
          ],
          environment: {
            TAILSCALE_COMPUTE_HOST: "developer@100.64.0.1",
          },
        },
      },
    });
  }
});

test("prints client configuration with setup print syntax", () => {
  const mainPath = fileURLToPath(new URL("../src/main.js", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [mainPath, "setup", "print", "--client", "cursor"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TAILSCALE_COMPUTE_HOST: "developer@100.64.0.1",
      },
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    mcpServers: {
      "tailscale-compute": {
        command: "npx",
        args: [
          "-y",
          "@dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5",
        ],
        env: {
          TAILSCALE_COMPUTE_HOST: "developer@100.64.0.1",
        },
      },
    },
  });
});
