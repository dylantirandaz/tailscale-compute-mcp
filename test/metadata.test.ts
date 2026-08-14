import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as z from "zod/v4";

import { SERVER_VERSION } from "../src/version.js";

const packageMetadataSchema = z.object({
  name: z.string(),
  version: z.string(),
  mcpName: z.string(),
  files: z.array(z.string()),
});

const serverMetadataSchema = z.object({
  name: z.string(),
  version: z.string(),
  packages: z.array(
    z.object({
      registryType: z.literal("npm"),
      identifier: z.string(),
      version: z.string(),
      transport: z.object({ type: z.literal("stdio") }),
    }),
  ),
});

test("keeps npm and MCP Registry identities aligned", () => {
  const packageMetadata = packageMetadataSchema.parse(
    JSON.parse(readFileSync("package.json", "utf8")),
  );
  const serverMetadata = serverMetadataSchema.parse(
    JSON.parse(readFileSync("server.json", "utf8")),
  );

  assert.equal(serverMetadata.name, packageMetadata.mcpName);
  assert.equal(serverMetadata.version, packageMetadata.version);
  assert.equal(packageMetadata.version, SERVER_VERSION);
  assert.equal(serverMetadata.packages.length, 1);

  const packageEntry = serverMetadata.packages[0];
  assert.ok(packageEntry !== undefined);
  assert.equal(packageEntry.identifier, packageMetadata.name);
  assert.equal(packageEntry.version, packageMetadata.version);
  assert.deepEqual(packageEntry.transport, { type: "stdio" });
  assert.deepEqual(packageMetadata.files, [
    "dist",
    "skills",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "server.json",
  ]);
});
