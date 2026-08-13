import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  parseConfiguration,
  type ConfigurationError,
  type Environment,
} from "./config.js";
import {
  RemoteComputeService,
  type RemoteRunOutcome,
  type StatusOutcome,
} from "./compute.js";
import { SERVER_VERSION } from "./version.js";

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 900;
const MAXIMUM_COMMAND_TIMEOUT_SECONDS = 7_200;
const MAXIMUM_STANDARD_INPUT_CHARACTERS = 1_048_576;
const MAXIMUM_ARGUMENT_CHARACTERS = 65_536;

const capturedOutputSchema = z.object({
  text: z.string(),
  totalBytes: z.number().int().nonnegative(),
  omittedBytes: z.number().int().nonnegative(),
});

const processBaseShape = {
  stdout: capturedOutputSchema,
  stderr: capturedOutputSchema,
  durationMilliseconds: z.number().nonnegative(),
} as const;

const processOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completed"),
    exitCode: z.number().int().min(0).max(255),
    ...processBaseShape,
  }),
  z.object({
    kind: z.literal("signaled"),
    signal: z.string(),
    ...processBaseShape,
  }),
  z.object({ kind: z.literal("timed_out"), ...processBaseShape }),
  z.object({ kind: z.literal("cancelled"), ...processBaseShape }),
  z.object({ kind: z.literal("unknown_termination"), ...processBaseShape }),
  z.object({
    kind: z.literal("spawn_error"),
    message: z.string(),
    code: z.string().nullable(),
    ...processBaseShape,
  }),
]);

const nvidiaAcceleratorSchema = z.object({
  kind: z.literal("nvidia"),
  index: z.number().int().nonnegative(),
  name: z.string(),
  uuid: z.string(),
  memoryBytes: z.number().int().positive(),
  driverVersion: z.string(),
});

const acceleratorInventorySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("nvidia"),
    devices: z.array(nvidiaAcceleratorSchema),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

const remoteHardwareBaseShape = {
  hostname: z.string(),
  architecture: z.string(),
  processor: z.string(),
  logicalProcessors: z.number().int().positive(),
  memoryBytes: z.number().int().positive(),
  shell: z.enum(["/bin/sh", "/bin/bash", "/bin/zsh"]),
  rsyncVersion: z.string(),
  acceleratorInventory: acceleratorInventorySchema,
} as const;

const remoteHardwareSchema = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("darwin"),
    ...remoteHardwareBaseShape,
    productName: z.string(),
    productVersion: z.string(),
    buildVersion: z.string(),
  }),
  z.object({
    platform: z.literal("linux"),
    ...remoteHardwareBaseShape,
    distributionName: z.string(),
    distributionVersion: z.string(),
    kernelVersion: z.string(),
  }),
]);

const workspaceErrorSchema = z.object({
  code: z.enum([
    "workspace_not_absolute",
    "workspace_not_directory",
    "workspace_is_root",
    "invalid_working_directory",
  ]),
  message: z.string(),
});

const configurationErrorSchema = z.object({
  kind: z.literal("configuration_error"),
  code: z.enum([
    "missing_target",
    "invalid_target",
    "invalid_remote_root",
    "invalid_local_root",
    "invalid_remote_shell",
    "invalid_connect_timeout",
  ]),
  message: z.string(),
});

const statusOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  z.object({
    kind: z.literal("ready"),
    target: z.string(),
    remoteRoot: z.string(),
    remoteWorkspace: z.string(),
    hardware: remoteHardwareSchema,
    durationMilliseconds: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal("workspace_error"),
    error: workspaceErrorSchema,
  }),
  z.object({
    kind: z.literal("unavailable"),
    target: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("probe_error"),
    target: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
]);

const runOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  z.object({
    kind: z.literal("completed"),
    target: z.string(),
    remoteWorkspace: z.string(),
    exitCode: z.number().int().min(0).max(255),
    stdout: capturedOutputSchema,
    stderr: capturedOutputSchema,
    syncDurationMilliseconds: z.number().nonnegative(),
    commandDurationMilliseconds: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal("workspace_error"),
    error: workspaceErrorSchema,
  }),
  z.object({
    kind: z.literal("stage_failed"),
    target: z.string(),
    remoteWorkspace: z.string(),
    stage: z.enum(["probe", "prepare", "sync", "command"]),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("protocol_error"),
    target: z.string(),
    remoteWorkspace: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
]);

const workspacePathSchema = z
  .string()
  .min(1)
  .describe(
    "The absolute local project path. Omit it when the MCP host starts this server in the project directory.",
  )
  .optional();

const statusInputSchema = z.object({
  workspacePath: workspacePathSchema,
});

const runInputSchema = z.object({
  workspacePath: workspacePathSchema,
  program: z
    .string()
    .min(1)
    .max(4_096)
    .refine((value) => !value.includes("\0") && !value.startsWith("-"), {
      message: "The program must not contain a null byte or start with '-'.",
    })
    .describe(
      "The executable name or path. For shell syntax, use a shell available on the remote node with arguments such as ['-lc', 'your command'].",
    ),
  arguments: z
    .array(
      z
        .string()
        .max(MAXIMUM_ARGUMENT_CHARACTERS)
        .refine((value) => !value.includes("\0"), {
          message: "An argument must not contain a null byte.",
        }),
    )
    .max(256)
    .default([])
    .describe("The exact arguments for the remote program."),
  environment: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      z.string().max(MAXIMUM_ARGUMENT_CHARACTERS),
    )
    .default({})
    .describe("Environment variables for this command only."),
  workingDirectory: z
    .string()
    .min(1)
    .default(".")
    .describe("A POSIX path relative to the remote workspace."),
  syncMode: z
    .enum(["incremental", "clean", "none"])
    .default("incremental")
    .describe(
      "Use incremental for normal runs, clean to replace the remote workspace, or none to reuse the last remote snapshot.",
    ),
  standardInput: z
    .string()
    .max(MAXIMUM_STANDARD_INPUT_CHARACTERS)
    .optional()
    .describe("Optional UTF-8 input for the remote program."),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAXIMUM_COMMAND_TIMEOUT_SECONDS)
    .default(DEFAULT_COMMAND_TIMEOUT_SECONDS)
    .describe("The maximum time for each sync or command process."),
});

type ConfigurationToolOutcome = {
  readonly kind: "configuration_error";
  readonly code: ConfigurationError["code"];
  readonly message: string;
};

type StatusToolOutcome = StatusOutcome | ConfigurationToolOutcome;
type RunToolOutcome = RemoteRunOutcome | ConfigurationToolOutcome;

type ServerRuntime =
  | { readonly kind: "ready"; readonly service: RemoteComputeService }
  | { readonly kind: "configuration_error"; readonly error: ConfigurationError };

export function createServer(
  environment: Environment = process.env,
): McpServer {
  const configurationResult = parseConfiguration(environment);
  const runtime: ServerRuntime = configurationResult.ok
    ? {
        kind: "ready",
        service: new RemoteComputeService(configurationResult.value),
      }
    : { kind: "configuration_error", error: configurationResult.error };

  const server = new McpServer({
    name: "tailscale-compute",
    version: SERVER_VERSION,
  });

  server.registerTool(
    "compute_status",
    {
      title: "Check Tailscale Compute",
      description:
        "Check the configured Tailscale compute node and report its operating system, hardware, remote shell, and accelerator inventory. Use this before the first remote run or after a connection failure.",
      inputSchema: statusInputSchema,
      outputSchema: statusOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ workspacePath }, context) => {
      let outcome: StatusToolOutcome;
      if (runtime.kind === "configuration_error") {
        outcome = {
          kind: "configuration_error",
          code: runtime.error.code,
          message: runtime.error.message,
        };
      } else {
        outcome = await runtime.service.status(
          workspacePath,
          context.mcpReq.signal,
        );
      }

      return {
        content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
        structuredContent: outcome,
        isError: outcome.kind !== "ready",
      };
    },
  );

  server.registerTool(
    "compute_run",
    {
      title: "Run on Tailscale Compute",
      description:
        "Sync the local project and run one non-interactive command on the configured Tailscale compute node. Use it for builds, tests, benchmarks, and other costly work. Keep file edits local. The command has the full permissions of the remote SSH user.",
      inputSchema: runInputSchema,
      outputSchema: runOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      let outcome: RunToolOutcome;
      if (runtime.kind === "configuration_error") {
        outcome = {
          kind: "configuration_error",
          code: runtime.error.code,
          message: runtime.error.message,
        };
      } else {
        outcome = await runtime.service.run({
          workspacePath: input.workspacePath,
          program: input.program,
          arguments: input.arguments,
          environment: input.environment,
          workingDirectory: input.workingDirectory,
          syncMode: input.syncMode,
          standardInput: input.standardInput,
          timeoutSeconds: input.timeoutSeconds,
          signal: context.mcpReq.signal,
        });
      }

      const isError = outcome.kind !== "completed" || outcome.exitCode !== 0;
      return {
        content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
        structuredContent: outcome,
        isError,
      };
    },
  );

  return server;
}
