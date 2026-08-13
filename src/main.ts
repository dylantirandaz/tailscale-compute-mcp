#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { parseConfiguration } from "./config.js";
import { RemoteComputeService } from "./compute.js";
import { createServer } from "./server.js";
import { SERVER_VERSION } from "./version.js";

const commandArguments = process.argv.slice(2);

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
} else {
  process.stderr.write(
    `Unknown arguments: ${commandArguments.join(" ")}\nRun tailscale-compute-mcp --help for usage.\n`,
  );
  process.exitCode = 2;
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
  tailscale-compute-mcp --check  Check SSH access and remote hardware.
  tailscale-compute-mcp --help   Show this help.

Required environment:
  TAILSCALE_COMPUTE_HOST
    A direct Tailscale target, such as user@100.71.137.123 or user@compute-node.tailnet.ts.net.

Optional environment:
  TAILSCALE_COMPUTE_LOCAL_ROOT
    An absolute local project path. The default is the MCP process directory.
  TAILSCALE_COMPUTE_REMOTE_ROOT
    A path under the remote home directory. The default is .cache/tailscale-compute-mcp.
  TAILSCALE_COMPUTE_REMOTE_SHELL
    auto, /bin/sh, /bin/bash, or /bin/zsh. The default is auto.
  TAILSCALE_COMPUTE_CONNECT_TIMEOUT_SECONDS
    The SSH connection timeout from 1 through 60. The default is 10.

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
          "TAILSCALE_COMPUTE_HOST": "user@100.71.137.123"
        }
      }
    }
  }
`;
}
