#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readFile } from "node:fs/promises";
import os from "node:os";

import { parseConfiguration } from "./config.js";
import { RemoteComputeService } from "./compute.js";
import { createServer } from "./server.js";
import {
  ompUserConfigurationPath,
  ompUserSkillPath,
  renderClientConfiguration,
  setupOmpUserConfiguration,
  type ConfigurationClient,
} from "./setup.js";
import { SERVER_VERSION } from "./version.js";

const commandArguments = process.argv.slice(2);
const requestedConfigurationClient =
  commandArguments[0] === "setup" &&
  commandArguments[1] === "print" &&
  commandArguments[2] === "--client"
    ? parseConfigurationClient(commandArguments[3])
    : undefined;

if (commandArguments.length === 0) {
  serveStdio(() => createServer(), {
    onerror: (error) => {
      process.stderr.write(`MCP transport error: ${error.message}\n`);
    },
  });
  process.stderr.write("tailscale-compute MCP server is running on stdio.\n");
} else if (
  commandArguments.length === 1 &&
  (commandArguments[0] === "--help" || commandArguments[0] === "-h")
) {
  process.stdout.write(helpText());
} else if (
  commandArguments.length === 1 &&
  (commandArguments[0] === "--version" || commandArguments[0] === "-v")
) {
  process.stdout.write(`${SERVER_VERSION}\n`);
} else if (
  commandArguments.length === 1 &&
  commandArguments[0] === "--check"
) {
  await runConnectionCheck();
} else if (
  (commandArguments.length === 4 || commandArguments.length === 6) &&
  commandArguments[0] === "setup" &&
  commandArguments[1] === "omp" &&
  commandArguments[2] === "--host" &&
  commandArguments[3] !== undefined &&
  (commandArguments.length === 4 ||
    (commandArguments[4] === "--name" &&
      commandArguments[5] !== undefined))
) {
  await runOmpSetup(
    commandArguments[3],
    commandArguments.length === 6 ? commandArguments[5] : undefined,
  );
} else if (
  (commandArguments.length === 4 || commandArguments.length === 6) &&
  commandArguments[0] === "setup" &&
  commandArguments[1] === "print" &&
  commandArguments[2] === "--client" &&
  requestedConfigurationClient !== undefined &&
  (commandArguments.length === 4 ||
    (commandArguments[4] === "--host" &&
      commandArguments[5] !== undefined))
) {
  runPrintConfiguration(
    requestedConfigurationClient,
    commandArguments.length === 6
      ? commandArguments[5]
      : process.env["TAILSCALE_COMPUTE_HOST"],
  );
} else {
  process.stderr.write(
    `Unknown arguments: ${commandArguments.join(" ")}\nRun tailscale-compute-mcp --help for usage.\n`,
  );
  process.exitCode = 2;
}

function parseConfigurationClient(
  value: string | undefined,
): ConfigurationClient | undefined {
  switch (value) {
    case "claude":
    case "cursor":
    case "codex":
    case "opencode":
      return value;
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function runPrintConfiguration(
  client: ConfigurationClient,
  target: string | undefined,
): void {
  if (target === undefined) {
    process.stderr.write(
      "Set TAILSCALE_COMPUTE_HOST or pass --host <target>.\n",
    );
    process.exitCode = 1;
    return;
  }
  const outcome = renderClientConfiguration({
    client,
    target,
    packageVersion: SERVER_VERSION,
  });
  if (outcome.kind === "invalid_target") {
    process.stderr.write(`${outcome.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${outcome.content}\n`);
}

async function runOmpSetup(
  target: string,
  serverName: string | undefined,
): Promise<void> {
  const homeDirectory = os.homedir();
  const configurationPath = ompUserConfigurationPath(homeDirectory);
  const skillPath = ompUserSkillPath(homeDirectory);
  process.stderr.write(`OMP configuration file: ${configurationPath}\n`);
  process.stderr.write(`OMP fleet skill file: ${skillPath}\n`);

  const configurationResult = parseConfiguration({
    TAILSCALE_COMPUTE_HOST: target,
  });
  if (!configurationResult.ok) {
    const connection = {
      kind: "configuration_error",
      code: configurationResult.error.code,
      message: configurationResult.error.message,
    };
    process.stdout.write(
      `${JSON.stringify(
        {
          kind: "connection_check_failed",
          path: configurationPath,
          skillPath,
          connection,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }
  let skillContent: string;
  try {
    skillContent = await readFile(
      new URL(
        "../skills/tailscale-compute-fleet/SKILL.md",
        import.meta.url,
      ),
      "utf8",
    );
  } catch (error: unknown) {
    process.stdout.write(
      `${JSON.stringify(
        {
          kind: "skill_load_failed",
          path: configurationPath,
          skillPath,
          message: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const service = new RemoteComputeService(configurationResult.value);
  const connection = await service.status(undefined, undefined);
  if (connection.kind !== "ready") {
    process.stdout.write(
      `${JSON.stringify(
        {
          kind: "connection_check_failed",
          path: configurationPath,
          skillPath,
          connection,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const outcome = setupOmpUserConfiguration({
    homeDirectory,
    target,
    packageVersion: SERVER_VERSION,
    ...(serverName === undefined ? {} : { serverName }),
    skillContent,
  });
  process.stdout.write(
    `${JSON.stringify({ ...outcome, connection }, null, 2)}\n`,
  );
  process.exitCode =
    outcome.kind === "configured" || outcome.kind === "already_configured"
      ? 0
      : 1;
}

async function runConnectionCheck(): Promise<void> {
  const configurationResult = parseConfiguration(process.env);
  if (!configurationResult.ok) {
    const output = {
      kind: "configuration_error",
      code: configurationResult.error.code,
      message: configurationResult.error.message,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const service = new RemoteComputeService(configurationResult.value);
  const outcome = await service.status(undefined, undefined);
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  process.exitCode = outcome.kind === "ready" ? 0 : 1;
}

function helpText(): string {
  return `tailscale-compute-mcp ${SERVER_VERSION}

Run a local stdio MCP server that uses SSH and rsync only when an agent calls a compute tool. No service runs on the remote compute node.

Usage:
  tailscale-compute-mcp          Start the MCP stdio server.
  tailscale-compute-mcp --check
    Check SSH access, remote hardware, and live health.
  tailscale-compute-mcp setup omp --host <target> [--name <server-name>]
    Check the connection, add one named server to the user OMP configuration,
    and install the fleet placement skill. Use a unique name for each node.
  tailscale-compute-mcp setup print --client <claude|cursor|codex|opencode> [--host <target>]
    Print a pinned user configuration. If --host is absent, use TAILSCALE_COMPUTE_HOST.
  tailscale-compute-mcp --help
    Show this help.

Required environment for the MCP server and --check:
  TAILSCALE_COMPUTE_HOST
    A direct Tailscale target, such as user@100.64.0.1 or user@compute-node.example.ts.net.

Optional environment:
  TAILSCALE_COMPUTE_LOCAL_ROOT
    An absolute local project path. The default is the MCP process directory.
  TAILSCALE_COMPUTE_REMOTE_ROOT
    A path under the remote home directory. The default is .cache/tailscale-compute-mcp.
  TAILSCALE_COMPUTE_REMOTE_SHELL
    auto, /bin/sh, /bin/bash, or /bin/zsh. The default is auto.
  TAILSCALE_COMPUTE_CONNECT_TIMEOUT_SECONDS
    The SSH connection timeout from 1 through 60. The default is 10.
  TAILSCALE_COMPUTE_MAX_ACTIVE_JOBS
    An optional node-wide durable job limit from 1 through 1024.
  TAILSCALE_COMPUTE_AUDIT_LOG
    The local audit log path.

Requirements:
  1. Connect the local computer and remote node to the same Tailscale network.
  2. Enable SSH on the remote Darwin or Linux node.
  3. Configure non-interactive SSH and verify the remote host key.
  4. Install rsync locally and remotely.
  5. Install the project toolchain on the remote node.

The normal sync respects .gitignore and .tailscale-compute-ignore. It also excludes common secrets, dependencies, and build caches. The clean sync replaces only this server's hashed remote workspace.

MCP host example:
  {
    "mcpServers": {
      "tailscale-compute": {
        "command": "tailscale-compute-mcp",
        "env": {
          "TAILSCALE_COMPUTE_HOST": "user@100.64.0.1"
        }
      }
    }
  }
`;
}
