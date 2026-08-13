import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createServer } from "../src/server.js";

test("lists both compute tools through MCP", async () => {
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
      ["compute_run", "compute_status"],
    );
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
