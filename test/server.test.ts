import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { createServer } from "../src/server.js";
import { hardwareRequirementsSchema } from "../src/receipt.js";

test("lists all compute tools through MCP", async () => {
  const server = createServer({});
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.listTools();
    assert.deepEqual(
      result.tools.map((tool) => tool.name).sort(),
      [
        "compute_doctor",
        "compute_fetch",
        "compute_job_cancel",
        "compute_job_delete",
        "compute_job_list",
        "compute_job_logs",
        "compute_job_start",
        "compute_job_status",
        "compute_run",
        "compute_status",
        "compute_workspace_delete",
        "compute_workspace_status",
      ],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("accepts a twelve-hour durable job timeout", async () => {
  const server = createServer({});
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const accepted = await client.callTool({
      name: "compute_job_start",
      arguments: {
        program: "/usr/bin/true",
        timeoutSeconds: 43_200,
      },
    });
    assert.equal(accepted.isError, true);
    assert.deepEqual(accepted.structuredContent, {
      kind: "configuration_error",
      code: "missing_target",
      message:
        "Set TAILSCALE_COMPUTE_HOST to a Tailscale IPv4 address or a full .ts.net name. You can add the remote user, for example user@100.64.0.1.",
    });

    const rejected = await client.callTool({
      name: "compute_job_start",
      arguments: {
        program: "/usr/bin/true",
        timeoutSeconds: 43_201,
      },
    });
    assert.deepEqual(rejected, {
      content: [
        {
          type: "text",
          text: "Input validation error: Invalid arguments for tool compute_job_start: timeoutSeconds: Too big: expected number to be <=43200",
        },
      ],
      isError: true,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("accepts an all-artifact job fetch without paths", async () => {
  const server = createServer({});
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "compute_fetch",
      arguments: {
        jobId: "12345678-1234-4234-8234-123456789abc",
        localDestination: ".tailscale-compute-results/run-42",
      },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      kind: "configuration_error",
      code: "missing_target",
      message:
        "Set TAILSCALE_COMPUTE_HOST to a Tailscale IPv4 address or a full .ts.net name. You can add the remote user, for example user@100.64.0.1.",
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("accepts an explicit Python program and required CUDA device", async () => {
  const server = createServer({});
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "compute_doctor",
      arguments: {
        profile: "pytorch",
        pythonProgram: "/opt/project/.venv/bin/python",
        requiredDevice: "cuda:0",
      },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      kind: "configuration_error",
      code: "missing_target",
      message:
        "Set TAILSCALE_COMPUTE_HOST to a Tailscale IPv4 address or a full .ts.net name. You can add the remote user, for example user@100.64.0.1.",
    });

    const rejectedLegacyInput = await client.callTool({
      name: "compute_doctor",
      arguments: {
        profile: "pytorch",
        device: "cuda:0",
      },
    });
    assert.equal(rejectedLegacyInput.isError, true);
    assert.equal(rejectedLegacyInput.structuredContent, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("returns a readable configuration error through MCP", async () => {
  const server = createServer({});
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const statusResult = await client.callTool({
      name: "compute_status",
      arguments: {},
    });
    assert.equal(statusResult.isError, true);
    assert.deepEqual(statusResult.structuredContent, {
      kind: "configuration_error",
      code: "missing_target",
      message:
        "Set TAILSCALE_COMPUTE_HOST to a Tailscale IPv4 address or a full .ts.net name. You can add the remote user, for example user@100.64.0.1.",
    });

    const runResult = await client.callTool({
      name: "compute_run",
      arguments: { program: "/usr/bin/true" },
    });
    assert.equal(runResult.isError, true);
    assert.deepEqual(runResult.structuredContent, {
      kind: "configuration_error",
      code: "missing_target",
      message:
        "Set TAILSCALE_COMPUTE_HOST to a Tailscale IPv4 address or a full .ts.net name. You can add the remote user, for example user@100.64.0.1.",
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("publishes combined hardware requirements as a valid MCP schema", async () => {
  const server = new McpServer({
    name: "hardware-requirements-schema-test",
    version: "1.0.0",
  });
  server.registerTool(
    "hardware_requirements",
    {
      inputSchema: z.object({}),
      outputSchema: z.object({ requirements: hardwareRequirementsSchema }),
    },
    () => {
      const structuredContent = {
        requirements: {
          platform: "darwin" as const,
          architecture: "arm64" as const,
        },
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "hardware_requirements",
      arguments: {},
    });
    assert.deepEqual(result.structuredContent, {
      requirements: {
        platform: "darwin",
        architecture: "arm64",
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});
