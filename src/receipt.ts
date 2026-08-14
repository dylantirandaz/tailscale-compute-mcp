import { spawnSync } from "node:child_process";
import * as z from "zod/v4";

import type {
  HardwareRequirementFailure,
  HardwareRequirements,
  FetchedArtifact,
  JobStage,
  RemoteHardware,
  RunStage,
  SyncMode,
} from "./compute.js";
import type { CapturedOutput } from "./process.js";
import { SERVER_VERSION } from "./version.js";

export type WorkspaceRevision =
  | {
      readonly kind: "git";
      readonly commit: string;
      readonly hasUncommittedChanges: boolean;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export type ReceiptHardware =
  | { readonly kind: "reported"; readonly value: RemoteHardware }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface OutputDigest {
  readonly totalBytes: number;
  readonly sha256: string;
}

export type ReceiptOutput =
  | { readonly kind: "pending" }
  | {
      readonly kind: "captured";
      readonly stdout: OutputDigest;
      readonly stderr: OutputDigest;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export type ActiveRunReceipt = RunReceiptCommon & {
  readonly timing: { readonly kind: "active"; readonly startedAt: string };
  readonly result: { readonly kind: "started" };
  readonly output: { readonly kind: "pending" };
};

export type ReceiptHardwareRequirements =
  | { readonly kind: "none" }
  | { readonly kind: "specified"; readonly value: HardwareRequirements };

export type FinishedReceiptResult =
  | { readonly kind: "completed"; readonly exitCode: 0 }
  | { readonly kind: "failed"; readonly exitCode: number }
  | { readonly kind: "cancelled" }
  | { readonly kind: "lost"; readonly reason: string }
  | { readonly kind: "stage_failed"; readonly stage: RunStage | JobStage }
  | { readonly kind: "protocol_error"; readonly message: string }
  | {
      readonly kind: "requirements_not_met";
      readonly failures: readonly HardwareRequirementFailure[];
    };

export type FinishedReceiptOutput =
  | {
      readonly kind: "captured";
      readonly stdout: OutputDigest;
      readonly stderr: OutputDigest;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export type FinishedRunReceipt = RunReceiptCommon & {
  readonly timing: {
    readonly kind: "finished";
    readonly startedAt: string;
    readonly finishedAt: string;
  };
  readonly result: FinishedReceiptResult;
  readonly output: FinishedReceiptOutput;
};

interface RunReceiptCommon {
  readonly runId: string;
  readonly target: string;
  readonly serverVersion: string;
  readonly localWorkspace: string;
  readonly remoteWorkspace: string;
  readonly label?: string | undefined;
  readonly command: {
    readonly program: string;
    readonly arguments: readonly string[];
    readonly environmentNames: readonly string[];
    readonly workingDirectory: string;
    readonly hardwareRequirements: ReceiptHardwareRequirements;
  };
  readonly workspaceRevision: WorkspaceRevision;
  readonly sync: {
    readonly mode: SyncMode;
    readonly durationMilliseconds: number;
  };
  readonly hardware: ReceiptHardware;
  readonly artifacts: readonly FetchedArtifact[];
}

export type RunReceipt = ActiveRunReceipt | FinishedRunReceipt;

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
  uid: z.number().int().nonnegative(),
  isRoot: z.boolean(),
  acceleratorInventory: acceleratorInventorySchema,
} as const;

export const remoteHardwareSchema = z.discriminatedUnion("platform", [
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

export const fetchedArtifactSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const workspaceRevisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("git"),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    hasUncommittedChanges: z.boolean(),
  }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);

const receiptHardwareSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reported"), value: remoteHardwareSchema }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);

const nvidiaRequirementSchema = z.object({
  minimumDeviceCount: z.number().int().min(1).max(32),
  minimumMemoryBytesPerDevice: z.number().int().positive().optional(),
});

const hardwareRequirementFieldsShape = {
  platform: z.enum(["darwin", "linux"]).optional(),
  architecture: z.enum(["arm64", "aarch64", "x86_64"]).optional(),
  minimumMemoryBytes: z.number().int().positive().optional(),
  nvidia: nvidiaRequirementSchema.optional(),
} as const;

export const hardwareRequirementsSchema: z.ZodType<HardwareRequirements> =
  z.union([
    z.object({
      ...hardwareRequirementFieldsShape,
      platform: z.enum(["darwin", "linux"]),
    }),
    z.object({
      ...hardwareRequirementFieldsShape,
      architecture: z.enum(["arm64", "aarch64", "x86_64"]),
    }),
    z.object({
      ...hardwareRequirementFieldsShape,
      minimumMemoryBytes: z.number().int().positive(),
    }),
    z.object({
      ...hardwareRequirementFieldsShape,
      nvidia: nvidiaRequirementSchema,
    }),
  ]);

export const hardwareRequirementFailureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("platform"),
    required: z.enum(["darwin", "linux"]),
    actual: z.enum(["darwin", "linux"]),
  }),
  z.object({
    kind: z.literal("architecture"),
    required: z.enum(["arm64", "aarch64", "x86_64"]),
    actual: z.string(),
  }),
  z.object({
    kind: z.literal("memory"),
    requiredBytes: z.number().int().positive(),
    actualBytes: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("nvidia_inventory"), message: z.string() }),
  z.object({
    kind: z.literal("nvidia_device_count"),
    required: z.number().int().positive(),
    actual: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("nvidia_memory"),
    requiredDeviceCount: z.number().int().positive(),
    minimumBytesPerDevice: z.number().int().positive(),
    qualifyingDeviceCount: z.number().int().nonnegative(),
  }),
]);

const receiptHardwareRequirementsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("specified"), value: hardwareRequirementsSchema }),
]);

const outputDigestSchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const finishedReceiptResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completed"),
    exitCode: z.literal(0),
  }),
  z.object({
    kind: z.literal("failed"),
    exitCode: z.number().int().min(1).max(255),
  }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("lost"), reason: z.string() }),
  z.object({
    kind: z.literal("stage_failed"),
    stage: z.enum([
      "probe",
      "prepare",
      "sync",
      "metadata",
      "command",
      "job_prepare",
      "job_start",
    ]),
  }),
  z.object({ kind: z.literal("protocol_error"), message: z.string() }),
  z.object({
    kind: z.literal("requirements_not_met"),
    failures: z.array(hardwareRequirementFailureSchema),
  }),
]);

const finishedReceiptOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("captured"),
    stdout: outputDigestSchema,
    stderr: outputDigestSchema,
  }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);

const runReceiptCommonShape = {
  runId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  target: z.string(),
  serverVersion: z.string(),
  localWorkspace: z.string(),
  remoteWorkspace: z.string(),
  label: z.string().min(1).max(128).optional(),
  command: z.object({
    program: z.string(),
    arguments: z.array(z.string()),
    environmentNames: z.array(z.string()),
    hardwareRequirements: receiptHardwareRequirementsSchema,
    workingDirectory: z.string(),
  }),
  workspaceRevision: workspaceRevisionSchema,
  sync: z.object({
    mode: z.enum(["incremental", "clean", "none"]),
    durationMilliseconds: z.number().nonnegative(),
  }),
  hardware: receiptHardwareSchema,
  artifacts: z.array(fetchedArtifactSchema),
} as const;

export const runReceiptSchema: z.ZodType<RunReceipt> = z.union([
  z.object({
    ...runReceiptCommonShape,
    timing: z.object({
      kind: z.literal("active"),
      startedAt: z.string(),
    }),
    result: z.object({ kind: z.literal("started") }),
    output: z.object({ kind: z.literal("pending") }),
  }),
  z.object({
    ...runReceiptCommonShape,
    timing: z.object({
      kind: z.literal("finished"),
      startedAt: z.string(),
      finishedAt: z.string(),
    }),
    result: finishedReceiptResultSchema,
    output: finishedReceiptOutputSchema,
  }),
]);

export type RunReceiptParseOutcome =
  | { readonly kind: "parsed"; readonly value: RunReceipt }
  | { readonly kind: "invalid"; readonly message: string };

export function parseRunReceiptJson(json: string): RunReceiptParseOutcome {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "invalid", message: `The run receipt is not JSON: ${message}` };
  }

  const parsed = runReceiptSchema.safeParse(value);
  if (!parsed.success) {
    return {
      kind: "invalid",
      message: `The run receipt has an invalid shape: ${z.prettifyError(parsed.error)}`,
    };
  }
  return { kind: "parsed", value: parsed.data };
}
export function isActiveRunReceipt(
  receipt: RunReceipt,
): receipt is ActiveRunReceipt {
  return receipt.timing.kind === "active";
}

export interface RunReceiptBase {
  readonly runId: string;
  readonly target: string;
  readonly localWorkspace: string;
  readonly remoteWorkspace: string;
  readonly label: string | undefined;
  readonly command: RunReceipt["command"];
  readonly workspaceRevision: WorkspaceRevision;
  readonly startedAt: string;
  readonly syncMode: SyncMode;
}

export function createRunReceiptBase(
  runId: string,
  target: string,
  localWorkspace: string,
  remoteWorkspace: string,
  command: {
    readonly program: string;
    readonly arguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly workingDirectory: string;
    readonly requirements: HardwareRequirements | undefined;
  },
  syncMode: SyncMode,
  startedAt: string,
  label?: string,
): RunReceiptBase {
  return {
    runId,
    target,
    localWorkspace,
    remoteWorkspace,
    label,
    command: {
      program: command.program,
      arguments: Object.freeze([...command.arguments]),
      environmentNames: Object.freeze(Object.keys(command.environment).sort()),
      workingDirectory: command.workingDirectory,
      hardwareRequirements:
        command.requirements === undefined
          ? { kind: "none" }
          : { kind: "specified", value: command.requirements },
    },
    workspaceRevision: inspectWorkspaceRevision(localWorkspace),
    startedAt,
    syncMode,
  };
}

export function activeRunReceipt(
  base: RunReceiptBase,
  hardware: ReceiptHardware,
  syncDurationMilliseconds: number,
): ActiveRunReceipt {
  return {
    runId: base.runId,
    target: base.target,
    serverVersion: SERVER_VERSION,
    localWorkspace: base.localWorkspace,
    remoteWorkspace: base.remoteWorkspace,
    ...(base.label === undefined ? {} : { label: base.label }),
    command: base.command,
    workspaceRevision: base.workspaceRevision,
    sync: {
      mode: base.syncMode,
      durationMilliseconds: syncDurationMilliseconds,
    },
    hardware,
    timing: { kind: "active", startedAt: base.startedAt },
    result: { kind: "started" },
    output: { kind: "pending" },
    artifacts: Object.freeze([]),
  };
}

export function finishedRunReceipt(
  base: RunReceiptBase,
  hardware: ReceiptHardware,
  syncDurationMilliseconds: number,
  result: FinishedReceiptResult,
  output: FinishedReceiptOutput,
): FinishedRunReceipt {
  return {
    runId: base.runId,
    target: base.target,
    serverVersion: SERVER_VERSION,
    localWorkspace: base.localWorkspace,
    remoteWorkspace: base.remoteWorkspace,
    ...(base.label === undefined ? {} : { label: base.label }),
    command: base.command,
    workspaceRevision: base.workspaceRevision,
    sync: {
      mode: base.syncMode,
      durationMilliseconds: syncDurationMilliseconds,
    },
    hardware,
    timing: {
      kind: "finished",
      startedAt: base.startedAt,
      finishedAt: new Date().toISOString(),
    },
    result,
    output,
    artifacts: Object.freeze([]),
  };
}

export function finishStoredRunReceipt(
  receipt: ActiveRunReceipt,
  finishedAt: string,
  result: FinishedReceiptResult,
  output: FinishedReceiptOutput,
  artifacts: readonly FetchedArtifact[] = receipt.artifacts,
): FinishedRunReceipt {
  return {
    runId: receipt.runId,
    target: receipt.target,
    serverVersion: receipt.serverVersion,
    localWorkspace: receipt.localWorkspace,
    remoteWorkspace: receipt.remoteWorkspace,
    ...(receipt.label === undefined ? {} : { label: receipt.label }),
    command: receipt.command,
    workspaceRevision: receipt.workspaceRevision,
    sync: receipt.sync,
    hardware: receipt.hardware,
    timing: {
      kind: "finished",
      startedAt: receipt.timing.startedAt,
      finishedAt,
    },
    result,
    output,
    artifacts: Object.freeze([...artifacts]),
  };
}

export function capturedReceiptOutput(
  stdout: CapturedOutput,
  stderr: CapturedOutput,
): Extract<ReceiptOutput, { readonly kind: "captured" }> {
  return {
    kind: "captured",
    stdout: { totalBytes: stdout.totalBytes, sha256: stdout.sha256 },
    stderr: { totalBytes: stderr.totalBytes, sha256: stderr.sha256 },
  };
}

export function inspectWorkspaceRevision(
  localWorkspace: string,
): WorkspaceRevision {
  try {
    const revision = spawnSync(
      "git",
      ["-C", localWorkspace, "rev-parse", "HEAD"],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (revision.status !== 0) {
      return {
        kind: "unavailable",
        reason: "The local workspace is not a readable Git work tree.",
      };
    }
    const commit = revision.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) {
      return {
        kind: "unavailable",
        reason: "Git returned an invalid commit identifier.",
      };
    }

    const status = spawnSync(
      "git",
      ["-C", localWorkspace, "status", "--porcelain", "--untracked-files=normal"],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (status.status !== 0) {
      return {
        kind: "unavailable",
        reason: "Git did not return the local workspace status.",
      };
    }
    return {
      kind: "git",
      commit,
      hasUncommittedChanges: status.stdout.length > 0,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "unavailable",
      reason: `The local Git revision is unavailable: ${message}`,
    };
  }
}
