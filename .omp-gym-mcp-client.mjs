import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

const [toolName, rawArguments] = process.argv.slice(2);
if (toolName === undefined || rawArguments === undefined) {
  throw new Error("usage: client TOOL JSON_ARGUMENTS");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./dist/main.js", import.meta.url))],
  env: {
    ...process.env,
    TAILSCALE_COMPUTE_HOST: "dylantirandaz@100.71.137.123",
  },
});
const client = new Client({ name: "omp-gym-operator", version: "1.0.0" });
await client.connect(transport);
try {
  const result = await client.callTool(
    {
      name: toolName,
      arguments: JSON.parse(rawArguments),
    },
    {
      timeout: 43_200_000,
      resetTimeoutOnProgress: true,
    },
  );
  console.log(JSON.stringify(result.structuredContent ?? result.content));
} finally {
  await client.close();
}
