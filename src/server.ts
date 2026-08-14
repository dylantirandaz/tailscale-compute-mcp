import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  parseConfiguration,
  type ConfigurationError,
  type Environment,
} from "./config.js";
import {
  doctorCheckFailedProtocolSchema,
  doctorInputSchema,
  doctorReadyProtocolSchema,
} from "./doctor.js";
import {
  type AuditEntry,
  writeAuditEntry,
} from "./audit.js";
import {
  RemoteComputeService,
  type RemoteDoctorOutcome,
  type RemoteFetchOutcome,
  type RemoteJobCancelOutcome,
  type RemoteJobDeleteOutcome,
  type RemoteJobListOutcome,
  type RemoteJobLogOutcome,
  type RemoteJobStartOutcome,
  type RemoteJobStatusOutcome,
  type RemoteRunOutcome,
  type RemoteWorkspaceDeleteOutcome,
  type RemoteWorkspaceStatusOutcome,
  type StatusOutcome,
} from "./compute.js";
import {
  fetchedArtifactSchema,
  hardwareRequirementFailureSchema,
  hardwareRequirementsSchema,
  remoteHardwareSchema,
  runReceiptSchema,
} from "./receipt.js";
import { SERVER_VERSION } from "./version.js";

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 900;
const MAXIMUM_COMMAND_TIMEOUT_SECONDS = 43_200;
const MAXIMUM_STANDARD_INPUT_CHARACTERS = 1_048_576;
const MAXIMUM_ARGUMENT_CHARACTERS = 65_536;
const DEFAULT_LOG_CHUNK_BYTES = 65_536;
const MAXIMUM_LOG_CHUNK_BYTES = 262_144;
const JOB_IDENTIFIER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const capturedOutputSchema = z.object({
  text: z.string(),
  totalBytes: z.number().int().nonnegative(),
  omittedBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
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
    "invalid_max_active_jobs",
  ]),
  message: z.string(),
});

const acceleratorUsageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("nvidia"),
    devices: z.array(
      z.object({
        kind: z.literal("nvidia"),
        index: z.number().int().nonnegative(),
        uuid: z.string(),
        memoryUsedBytes: z.number().int().nonnegative(),
        memoryAvailableBytes: z.number().int().nonnegative(),
        utilization: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("reported"),
            percent: z.number().min(0).max(100),
          }),
          z.object({ kind: z.literal("unavailable") }),
        ]),
      }),
    ),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

const remoteNodeHealthSchema = z.object({
  checkedAt: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  loadAverage: z.object({
    oneMinute: z.number().nonnegative(),
    fiveMinutes: z.number().nonnegative(),
    fifteenMinutes: z.number().nonnegative(),
  }),
  availableMemoryBytes: z.number().int().nonnegative(),
  remoteRootStorage: z.object({
    totalBytes: z.number().int().nonnegative(),
    availableBytes: z.number().int().nonnegative(),
  }),
  activeJobCount: z.number().int().nonnegative(),
  acceleratorUsage: acceleratorUsageSchema,
});

const statusOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  z.object({
    kind: z.literal("ready"),
    target: z.string(),
    remoteRoot: z.string(),
    remoteWorkspace: z.string(),
    hardware: remoteHardwareSchema,
    health: remoteNodeHealthSchema,
    warning: z.string().optional(),
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

const doctorOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  doctorReadyProtocolSchema.extend({
    target: z.string(),
    durationMilliseconds: z.number().nonnegative(),
  }),
  doctorCheckFailedProtocolSchema.extend({
    target: z.string(),
    durationMilliseconds: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal("unavailable"),
    target: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("protocol_error"),
    target: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
]);

const workspaceRecordedTimeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("never") }),
  z.object({ kind: z.literal("recorded"), value: z.string() }),
]);

const workspaceStatusOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  z.object({
    kind: z.literal("completed"),
    target: z.string(),
    remoteWorkspace: z.string(),
    totalBytes: z.number().int().nonnegative(),
    lastSyncAt: workspaceRecordedTimeSchema,
    lastRunAt: workspaceRecordedTimeSchema,
    activeJobIds: z.array(
      z.string().regex(JOB_IDENTIFIER_PATTERN),
    ),
  }),
  z.object({
    kind: z.literal("workspace_not_found"),
    target: z.string(),
    remoteWorkspace: z.string(),
  }),
  z.object({ kind: z.literal("workspace_error"), error: workspaceErrorSchema }),
  z.object({
    kind: z.literal("unavailable"),
    target: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("protocol_error"),
    target: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
]);

const auditInfoSchema = z.object({
  path: z.string(),
  appended: z.boolean(),
  error: z.string().optional(),
});

const workspaceDeleteOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  z.object({
    kind: z.literal("deleted"),
    target: z.string(),
    remoteWorkspace: z.string(),
    localWorkspace: z.string(),
    existed: z.boolean(),
    audit: auditInfoSchema,
  }),
  z.object({
    kind: z.literal("workspace_busy"),
    target: z.string(),
    remoteWorkspace: z.string(),
    activeJobIds: z.array(z.string().regex(JOB_IDENTIFIER_PATTERN)),
  }),
  z.object({ kind: z.literal("workspace_error"), error: workspaceErrorSchema }),
  z.object({
    kind: z.literal("unavailable"),
    target: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("protocol_error"),
    target: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
]);

const jobIdSchema = z
  .string()
  .regex(JOB_IDENTIFIER_PATTERN)
  .describe("The version 4 UUID returned by compute_job_start.");
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
    warning: z.string().optional(),
    receipt: runReceiptSchema,
    audit: auditInfoSchema,
  }),
  z.object({
    kind: z.literal("workspace_error"),
    error: workspaceErrorSchema,
  }),
  z.object({
    kind: z.literal("workspace_busy"),
    target: z.string(),
    remoteWorkspace: z.string(),
    activeJobIds: z.array(jobIdSchema),
  }),
  z.object({
    kind: z.literal("requirements_not_met"),
    target: z.string(),
    remoteWorkspace: z.string(),
    requirements: hardwareRequirementsSchema,
    hardware: remoteHardwareSchema,
    failures: z.array(hardwareRequirementFailureSchema),
    receipt: runReceiptSchema,
    audit: auditInfoSchema,
  }),
  z.object({
    kind: z.literal("stage_failed"),
    target: z.string(),
    remoteWorkspace: z.string(),
    stage: z.enum(["probe", "prepare", "sync", "metadata", "command"]),
    process: processOutcomeSchema,
    receipt: runReceiptSchema,
    audit: auditInfoSchema,
  }),
  z.object({
    kind: z.literal("protocol_error"),
    target: z.string(),
    remoteWorkspace: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
    receipt: runReceiptSchema,
    audit: auditInfoSchema,
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

const commandInputShape = {
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
    .describe("The maximum time for each sync or command process, up to 12 hours."),
  requirements: hardwareRequirementsSchema
    .optional()
    .describe(
      "Optional fail-fast platform, architecture, memory, and NVIDIA requirements. The command does not sync or start when the node does not match.",
    ),
} as const;

const runInputSchema = z.object(commandInputShape);
const jobLabelSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes("\0") && !/[\r\n]/.test(value), {
    message: "A label must not contain a null byte or a line break.",
  });

const jobStartInputSchema = z.object({
  ...commandInputShape,
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    .optional()
    .describe(
      "A caller-selected key that makes repeated identical job starts return the first job.",
    ),
  label: jobLabelSchema
    .optional()
    .describe("An optional experiment label for job listing."),
  artifactPaths: z
    .array(z.string().min(1).max(4_096))
    .max(64)
    .default([])
    .describe(
      "Relative workspace paths to preserve in the immutable job artifact snapshot.",
    ),
});


const pendingJobTerminationSchema = z.object({ kind: z.literal("pending") });
const completedJobTerminationSchema = z.object({
  kind: z.literal("completed"),
});
const failedJobTerminationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exited"),
    exitCode: z.number().int().min(1).max(255),
  }),
  z.object({
    kind: z.literal("signalled"),
    signalNumber: z.number().int().min(1).max(64),
  }),
  z.object({
    kind: z.literal("timed_out"),
    timeoutSeconds: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("oom_killed"),
    evidence: z.object({
      kind: z.literal("cgroup"),
      oomKillCount: z.number().int().positive(),
    }),
  }),
]);
const cancelledJobTerminationSchema = z.object({
  kind: z.literal("cancelled"),
});
const lostJobTerminationSchema = z.object({
  kind: z.literal("lost"),
  reason: z.string(),
});

const jobStateBaseShape = {
  jobId: jobIdSchema,
  target: z.string(),
  remoteWorkspace: z.string(),
  startedAt: z.string(),
  receipt: runReceiptSchema,
} as const;

const jobStartOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  z.object({
    kind: z.literal("started"),
    jobId: jobIdSchema,
    target: z.string(),
    remoteWorkspace: z.string(),
    startedAt: z.string(),
    syncDurationMilliseconds: z.number().nonnegative(),
    reused: z.boolean(),
    warning: z.string().optional(),
    receipt: runReceiptSchema,
    audit: auditInfoSchema,
  }),
  z.object({
    kind: z.literal("validation_error"),
    target: z.string(),
    remoteWorkspace: z.string(),
    code: z.enum([
      "invalid_idempotency_key",
      "invalid_label",
      "invalid_artifact_path",
    ]),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("idempotency_conflict"),
    target: z.string(),
    remoteWorkspace: z.string(),
    existingJobId: jobIdSchema,
    message: z.string(),
  }),
  z.object({
    kind: z.literal("idempotency_error"),
    target: z.string(),
    remoteWorkspace: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("workspace_error"),
    error: workspaceErrorSchema,
  }),
  z.object({
    kind: z.literal("workspace_busy"),
    target: z.string(),
    remoteWorkspace: z.string(),
    activeJobIds: z.array(jobIdSchema),
  }),
  z.object({
    kind: z.literal("node_busy"),
    target: z.string(),
    remoteWorkspace: z.string(),
    maximumActiveJobs: z.number().int().positive(),
    activeJobIds: z.array(jobIdSchema),
    activeAdmissionCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("admission_error"),
    target: z.string(),
    remoteWorkspace: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("requirements_not_met"),
    jobId: jobIdSchema,
    target: z.string(),
    remoteWorkspace: z.string(),
    requirements: hardwareRequirementsSchema,
    hardware: remoteHardwareSchema,
    failures: z.array(hardwareRequirementFailureSchema),
    receipt: runReceiptSchema,
    audit: auditInfoSchema,
  }),
  z.object({
    kind: z.literal("stage_failed"),
    jobId: jobIdSchema,
    target: z.string(),
    remoteWorkspace: z.string(),
    stage: z.enum([
      "probe",
      "prepare",
      "sync",
      "metadata",
      "job_prepare",
      "job_start",
    ]),
    process: processOutcomeSchema,
    receipt: runReceiptSchema,
    audit: auditInfoSchema,
  }),
  z.object({
    kind: z.literal("protocol_error"),
    jobId: jobIdSchema,
    target: z.string(),
    remoteWorkspace: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
    receipt: runReceiptSchema,
    audit: auditInfoSchema,
  }),
]);

const jobStatusOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  z.object({ kind: z.literal("starting"), ...jobStateBaseShape }),
  z.object({
    kind: z.literal("running"),
    ...jobStateBaseShape,
    processGroupId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("completed"),
    ...jobStateBaseShape,
    exitCode: z.literal(0),
    finishedAt: z.string(),
    termination: completedJobTerminationSchema,
  }),
  z.object({
    kind: z.literal("failed"),
    ...jobStateBaseShape,
    exitCode: z.number().int().min(1).max(255),
    finishedAt: z.string(),
    termination: failedJobTerminationSchema,
  }),
  z.object({
    kind: z.literal("cancelled"),
    ...jobStateBaseShape,
    finishedAt: z.string(),
    termination: cancelledJobTerminationSchema,
  }),
  z.object({
    kind: z.literal("lost"),
    ...jobStateBaseShape,
    lastKnownState: z.enum(["starting", "running"]),
    finishedAt: z.string(),
    reason: z.string(),
    termination: lostJobTerminationSchema,
  }),
  z.object({
    kind: z.literal("job_not_found"),
    jobId: jobIdSchema,
    target: z.string(),
  }),
  z.object({
    kind: z.literal("unavailable"),
    jobId: jobIdSchema,
    target: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("protocol_error"),
    jobId: z.string(),
    target: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
]);

const jobCancelOutputSchema = z.union([
  jobStatusOutputSchema,
  z.object({
    kind: z.literal("cancel_failed"),
    jobId: jobIdSchema,
    target: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
]);

const jobSummaryBaseShape = {
  jobId: jobIdSchema,
  target: z.string(),
  localWorkspace: z.string(),
  remoteWorkspace: z.string(),
  program: z.string(),
  label: z.string().optional(),
  startedAt: z.string(),
} as const;

const jobSummarySchema = z.discriminatedUnion("state", [
  z.object({
    ...jobSummaryBaseShape,
    state: z.literal("starting"),
    termination: pendingJobTerminationSchema,
  }),
  z.object({
    ...jobSummaryBaseShape,
    state: z.literal("running"),
    termination: pendingJobTerminationSchema,
  }),
  z.object({
    ...jobSummaryBaseShape,
    state: z.literal("completed"),
    finishedAt: z.string(),
    termination: completedJobTerminationSchema,
  }),
  z.object({
    ...jobSummaryBaseShape,
    state: z.literal("failed"),
    finishedAt: z.string(),
    termination: failedJobTerminationSchema,
  }),
  z.object({
    ...jobSummaryBaseShape,
    state: z.literal("cancelled"),
    finishedAt: z.string(),
    termination: cancelledJobTerminationSchema,
  }),
  z.object({
    ...jobSummaryBaseShape,
    state: z.literal("lost"),
    finishedAt: z.string(),
    termination: lostJobTerminationSchema,
  }),
]);

const jobListOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  z.object({
    kind: z.literal("completed"),
    target: z.string(),
    remoteWorkspace: z.string(),
    jobs: z.array(jobSummarySchema),
    nextCursor: jobIdSchema.nullable(),
  }),
  z.object({
    kind: z.literal("workspace_error"),
    error: workspaceErrorSchema,
  }),
  z.object({
    kind: z.literal("validation_error"),
    code: z.enum(["invalid_cursor", "invalid_label"]),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("unavailable"),
    target: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("protocol_error"),
    target: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
]);

const jobDeleteOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  z.object({
    kind: z.literal("deleted"),
    jobId: jobIdSchema,
    target: z.string(),
    remoteWorkspace: z.string(),
  }),
  z.object({
    kind: z.literal("job_active"),
    jobId: jobIdSchema,
    target: z.string(),
    state: z.enum(["starting", "running"]),
  }),
  z.object({
    kind: z.literal("job_not_found"),
    jobId: jobIdSchema,
    target: z.string(),
  }),
  z.object({
    kind: z.literal("unavailable"),
    jobId: jobIdSchema,
    target: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("protocol_error"),
    jobId: z.string(),
    target: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
]);

const jobLogOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  z.object({
    kind: z.literal("log_chunk"),
    jobId: jobIdSchema,
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
    offsetBytes: z.number().int().nonnegative(),
    nextOffsetBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    endOfStream: z.boolean(),
  }),
  z.object({
    kind: z.enum(["job_not_found", "log_not_found"]),
    jobId: jobIdSchema,
    target: z.string(),
  }),
  z.object({
    kind: z.literal("invalid_log_offset"),
    jobId: jobIdSchema,
    target: z.string(),
    offsetBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("unavailable"),
    jobId: jobIdSchema,
    target: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("protocol_error"),
    jobId: z.string(),
    target: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
]);


const fetchOutputSchema = z.discriminatedUnion("kind", [
  configurationErrorSchema,
  z.object({
    kind: z.literal("completed"),
    target: z.string(),
    remoteWorkspace: z.string(),
    jobId: jobIdSchema.optional(),
    localDestination: z.string(),
    files: z.array(fetchedArtifactSchema),
    totalBytes: z.number().int().nonnegative(),
    durationMilliseconds: z.number().nonnegative(),
    audit: auditInfoSchema,
  }),
  z.object({
    kind: z.literal("workspace_error"),
    error: workspaceErrorSchema,
  }),
  z.object({
    kind: z.literal("validation_error"),
    code: z.enum([
      "invalid_remote_path",
      "invalid_local_destination",
      "destination_exists",
      "local_artifact_error",
      "invalid_job_id",
      "job_workspace_mismatch",
      "artifact_not_declared",
      "artifact_integrity_error",
    ]),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("artifact_refused"),
    target: z.string(),
    remoteWorkspace: z.string(),
    path: z.string(),
    reason: z.enum(["not_found", "symbolic_link"]),
    audit: auditInfoSchema,
  }),
  z.object({
    kind: z.literal("job_not_terminal"),
    jobId: jobIdSchema,
    target: z.string(),
    state: z.enum(["starting", "running"]),
  }),
  z.object({
    kind: z.literal("job_not_found"),
    jobId: jobIdSchema,
    target: z.string(),
  }),
  z.object({
    kind: z.literal("unavailable"),
    jobId: jobIdSchema,
    target: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("protocol_error"),
    jobId: z.string(),
    target: z.string(),
    message: z.string(),
    process: processOutcomeSchema,
  }),
  z.object({
    kind: z.literal("stage_failed"),
    target: z.string(),
    remoteWorkspace: z.string(),
    stage: z.enum(["validate", "fetch"]),
    process: processOutcomeSchema,
    audit: auditInfoSchema,
  }),
]);

const jobIdInputSchema = z.object({ jobId: jobIdSchema });
const jobListInputSchema = z.object({
  workspacePath: workspacePathSchema,
  states: z
    .array(
      z.enum([
        "starting",
        "running",
        "completed",
        "failed",
        "cancelled",
        "lost",
      ]),
    )
    .max(6)
    .default([])
    .describe("Job states to include. An empty list includes every state."),
  label: jobLabelSchema
    .optional()
    .describe("Include only jobs with this exact label."),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: jobIdSchema
    .nullable()
    .default(null)
    .describe("The last job ID from the previous page, or null for the first page."),
});

const jobLogInputSchema = z.object({
  jobId: jobIdSchema,
  stream: z.enum(["stdout", "stderr"]),
  offsetBytes: z.number().int().nonnegative().default(0),
  maximumBytes: z
    .number()
    .int()
    .min(4)
    .max(MAXIMUM_LOG_CHUNK_BYTES)
    .default(DEFAULT_LOG_CHUNK_BYTES),
});

const fetchPathSchema = z.string().min(1).max(4_096);
const fetchCommonInputShape = {
  workspacePath: workspacePathSchema,
  localDestination: z
    .string()
    .min(1)
    .max(4_096)
    .describe("A destination path relative to the local workspace."),
  overwrite: z.boolean().default(false),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAXIMUM_COMMAND_TIMEOUT_SECONDS)
    .default(DEFAULT_COMMAND_TIMEOUT_SECONDS),
} as const;
const fetchInputSchema = z.union([
  z.strictObject({
    ...fetchCommonInputShape,
    jobId: jobIdSchema.describe(
      "A terminal job whose immutable artifact snapshot is the download source.",
    ),
    paths: z
      .array(fetchPathSchema)
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Selected paths in the job snapshot. Omit this field to fetch every declared artifact.",
      ),
  }),
  z.strictObject({
    ...fetchCommonInputShape,
    paths: z
      .array(fetchPathSchema)
      .min(1)
      .max(64)
      .describe("Selected paths in the mutable workspace."),
  }),
]);

type ConfigurationToolOutcome = {
  readonly kind: "configuration_error";
  readonly code: ConfigurationError["code"];
  readonly message: string;
};

type StatusToolOutcome = StatusOutcome | ConfigurationToolOutcome;
type DoctorToolOutcome = RemoteDoctorOutcome | ConfigurationToolOutcome;
type RunToolOutcome = RemoteRunOutcome | ConfigurationToolOutcome;
type JobStartToolOutcome = RemoteJobStartOutcome | ConfigurationToolOutcome;
type WorkspaceStatusToolOutcome =
  | RemoteWorkspaceStatusOutcome
  | ConfigurationToolOutcome;
type WorkspaceDeleteToolOutcome =
  | RemoteWorkspaceDeleteOutcome
  | ConfigurationToolOutcome;
type JobListToolOutcome = RemoteJobListOutcome | ConfigurationToolOutcome;
type JobDeleteToolOutcome = RemoteJobDeleteOutcome | ConfigurationToolOutcome;
type JobStatusToolOutcome = RemoteJobStatusOutcome | ConfigurationToolOutcome;
type JobLogToolOutcome = RemoteJobLogOutcome | ConfigurationToolOutcome;
type JobCancelToolOutcome = RemoteJobCancelOutcome | ConfigurationToolOutcome;
type FetchToolOutcome = RemoteFetchOutcome | ConfigurationToolOutcome;
type AuditedRunOutcome = z.infer<typeof runOutputSchema>;
type AuditedFetchOutcome = z.infer<typeof fetchOutputSchema>;
type AuditedJobStartOutcome = z.infer<typeof jobStartOutputSchema>;
type AuditedWorkspaceDeleteOutcome = z.infer<
  typeof workspaceDeleteOutputSchema
>;

type ServerRuntime =
  | {
      readonly kind: "ready";
      readonly service: RemoteComputeService;
      readonly auditLogPath: string;
    }
  | { readonly kind: "configuration_error"; readonly error: ConfigurationError };

function configurationToolOutcome(
  runtime: ServerRuntime,
): ConfigurationToolOutcome | undefined {
  if (runtime.kind === "ready") {
    return undefined;
  }
  return {
    kind: "configuration_error",
    code: runtime.error.code,
    message: runtime.error.message,
  };
}

export function createServer(
  environment: Environment = process.env,
): McpServer {
  const configurationResult = parseConfiguration(environment);
  const runtime: ServerRuntime = configurationResult.ok
    ? {
        kind: "ready",
        service: new RemoteComputeService(configurationResult.value),
        auditLogPath: configurationResult.value.auditLogPath,
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
    "compute_doctor",
    {
      title: "Check PyTorch CUDA",
      description:
        "Run the explicit PyTorch doctor profile with the selected Python program on one required CUDA device. It checks the NVIDIA driver, CUDA runtime and compiler, PyTorch compatibility, compute capability, available memory, a real operation, and model, input, intermediate, and output placement. It never falls back to the CPU.",
      inputSchema: doctorInputSchema,
      outputSchema: doctorOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      let outcome: DoctorToolOutcome;
      const configurationOutcome = configurationToolOutcome(runtime);
      if (configurationOutcome !== undefined) {
        outcome = configurationOutcome;
      } else if (runtime.kind === "ready") {
        outcome = await runtime.service.doctor({
          profile: input.profile,
          pythonProgram: input.pythonProgram,
          requiredDevice: input.requiredDevice,
          minimumAvailableMemoryBytes:
            input.minimumAvailableMemoryBytes,
          signal: context.mcpReq.signal,
        });
      } else {
        throw new Error("The server runtime state is not exhaustive.");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
        structuredContent: outcome,
        isError: outcome.kind !== "ready",
      };
    },
  );

  server.registerTool(
    "compute_workspace_status",
    {
      title: "Inspect Tailscale Compute Workspace",
      description:
        "Report the managed remote path, disk usage, last sync, last run, and active durable jobs for this local workspace.",
      inputSchema: statusInputSchema,
      outputSchema: workspaceStatusOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ workspacePath }, context) => {
      let outcome: WorkspaceStatusToolOutcome;
      const configurationOutcome = configurationToolOutcome(runtime);
      if (configurationOutcome !== undefined) {
        outcome = configurationOutcome;
      } else if (runtime.kind === "ready") {
        outcome = await runtime.service.workspaceStatus(
          workspacePath,
          context.mcpReq.signal,
        );
      } else {
        throw new Error("The server runtime state is not exhaustive.");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
        structuredContent: outcome,
        isError: outcome.kind !== "completed",
      };
    },
  );

  server.registerTool(
    "compute_workspace_delete",
    {
      title: "Delete Tailscale Compute Workspace",
      description:
        "Delete only the managed remote workspace derived from this local project. The operation refuses deletion while a durable job is active.",
      inputSchema: statusInputSchema,
      outputSchema: workspaceDeleteOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ workspacePath }, context) => {
      let outcome: WorkspaceDeleteToolOutcome;
      const configurationOutcome = configurationToolOutcome(runtime);
      if (configurationOutcome !== undefined) {
        outcome = configurationOutcome;
      } else if (runtime.kind === "ready") {
        outcome = await runtime.service.deleteWorkspace(
          workspacePath,
          context.mcpReq.signal,
        );
      } else {
        throw new Error("The server runtime state is not exhaustive.");
      }

      let structuredContent:
        | WorkspaceDeleteToolOutcome
        | AuditedWorkspaceDeleteOutcome = outcome;
      if (runtime.kind === "ready" && outcome.kind === "deleted") {
        const auditEntry: AuditEntry = {
          timestamp: new Date().toISOString(),
          target: outcome.target,
          remoteWorkspace: outcome.remoteWorkspace,
          localWorkspace: outcome.localWorkspace,
          operation: "workspace_delete",
          existed: outcome.existed,
          result: { kind: "deleted" },
        };
        const auditWriteResult = writeAuditEntry(
          runtime.auditLogPath,
          auditEntry,
        );
        structuredContent = {
          ...outcome,
          audit: {
            path: runtime.auditLogPath,
            appended: auditWriteResult.kind === "appended",
            error:
              auditWriteResult.kind === "failed"
                ? auditWriteResult.message
                : undefined,
          },
        };
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
        isError: outcome.kind !== "deleted",
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
          requirements: input.requirements,
          signal: context.mcpReq.signal,
        });
      }

      let structuredContent: RunToolOutcome | AuditedRunOutcome = outcome;
      if (
        runtime.kind === "ready" &&
        (outcome.kind === "completed" ||
          outcome.kind === "stage_failed" ||
          outcome.kind === "requirements_not_met" ||
          outcome.kind === "protocol_error")
      ) {
        const auditBase = {
          timestamp: new Date().toISOString(),
          target: outcome.target,
          remoteWorkspace: outcome.remoteWorkspace,
          localWorkspace: input.workspacePath ?? "(MCP process directory)",
          operation: "run" as const,
          program: input.program,
          arguments: input.arguments,
          workingDirectory: input.workingDirectory,
          syncMode: input.syncMode,
        };
        let auditEntry: AuditEntry;
        switch (outcome.kind) {
          case "completed":
            auditEntry = {
              ...auditBase,
              result: { kind: "completed", exitCode: outcome.exitCode },
            };
            break;
          case "stage_failed":
            auditEntry = {
              ...auditBase,
              result: { kind: "stage_failed", stage: outcome.stage },
            };
            break;
          case "requirements_not_met":
            auditEntry = {
              ...auditBase,
              result: { kind: "requirements_not_met" },
            };
            break;
          case "protocol_error":
            auditEntry = {
              ...auditBase,
              result: { kind: "protocol_error" },
            };
            break;
        }
        const auditWriteResult = writeAuditEntry(
          runtime.auditLogPath,
          auditEntry,
        );
        structuredContent = {
          ...outcome,
          audit: {
            path: runtime.auditLogPath,
            appended: auditWriteResult.kind === "appended",
            error:
              auditWriteResult.kind === "failed"
                ? auditWriteResult.message
                : undefined,
          },
        };
      }

      const isError = outcome.kind !== "completed" || outcome.exitCode !== 0;
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
        isError,
      };
    },
  );

  server.registerTool(
    "compute_job_start",
    {
      title: "Start Tailscale Compute Job",
      description:
        "Sync the local project and start one durable remote job. The job continues after the MCP request, SSH connection, or local MCP process ends.",
      inputSchema: jobStartInputSchema,
      outputSchema: jobStartOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      let outcome: JobStartToolOutcome;
      const configurationOutcome = configurationToolOutcome(runtime);
      if (configurationOutcome !== undefined) {
        outcome = configurationOutcome;
      } else if (runtime.kind === "ready") {
        outcome = await runtime.service.startJob({
          workspacePath: input.workspacePath,
          program: input.program,
          arguments: input.arguments,
          environment: input.environment,
          workingDirectory: input.workingDirectory,
          syncMode: input.syncMode,
          standardInput: input.standardInput,
          timeoutSeconds: input.timeoutSeconds,
          requirements: input.requirements,
          idempotencyKey: input.idempotencyKey,
          label: input.label,
          artifactPaths: input.artifactPaths,
          signal: context.mcpReq.signal,
        });
      } else {
        throw new Error("The server runtime state is not exhaustive.");
      }

      let structuredContent:
        | JobStartToolOutcome
        | AuditedJobStartOutcome = outcome;
      if (
        runtime.kind === "ready" &&
        (outcome.kind === "started" ||
          outcome.kind === "stage_failed" ||
          outcome.kind === "requirements_not_met" ||
          outcome.kind === "protocol_error")
      ) {
        const auditBase = {
          timestamp: new Date().toISOString(),
          target: outcome.target,
          remoteWorkspace: outcome.remoteWorkspace,
          localWorkspace: input.workspacePath ?? "(MCP process directory)",
          operation: "job_start" as const,
          jobId: outcome.jobId,
          program: input.program,
          arguments: input.arguments,
          workingDirectory: input.workingDirectory,
          syncMode: input.syncMode,
        };
        let auditEntry: AuditEntry;
        switch (outcome.kind) {
          case "started":
            auditEntry = { ...auditBase, result: { kind: "started" } };
            break;
          case "stage_failed":
            auditEntry = {
              ...auditBase,
              result: { kind: "stage_failed", stage: outcome.stage },
            };
            break;
          case "requirements_not_met":
            auditEntry = {
              ...auditBase,
              result: { kind: "requirements_not_met" },
            };
            break;
          case "protocol_error":
            auditEntry = {
              ...auditBase,
              result: { kind: "protocol_error" },
            };
            break;
        }
        const auditWriteResult = writeAuditEntry(
          runtime.auditLogPath,
          auditEntry,
        );
        structuredContent = {
          ...outcome,
          audit: {
            path: runtime.auditLogPath,
            appended: auditWriteResult.kind === "appended",
            error:
              auditWriteResult.kind === "failed"
                ? auditWriteResult.message
                : undefined,
          },
        };
      }

      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
        isError: outcome.kind !== "started",
      };
    },
  );

  server.registerTool(
    "compute_job_list",
    {
      title: "List Tailscale Compute Jobs",
      description:
        "List durable jobs in the managed workspace, newest first. Filter by state or exact label and continue with nextCursor.",
      inputSchema: jobListInputSchema,
      outputSchema: jobListOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      let outcome: JobListToolOutcome;
      const configurationOutcome = configurationToolOutcome(runtime);
      if (configurationOutcome !== undefined) {
        outcome = configurationOutcome;
      } else if (runtime.kind === "ready") {
        outcome = await runtime.service.listJobs({
          workspacePath: input.workspacePath,
          states: input.states,
          label: input.label,
          limit: input.limit,
          cursor: input.cursor,
          signal: context.mcpReq.signal,
        });
      } else {
        throw new Error("The server runtime state is not exhaustive.");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
        structuredContent: outcome,
        isError: outcome.kind !== "completed",
      };
    },
  );

  server.registerTool(
    "compute_job_status",
    {
      title: "Check Tailscale Compute Job",
      description:
        "Read the durable state of one remote job. A missing process never reports a running state.",
      inputSchema: jobIdInputSchema,
      outputSchema: jobStatusOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId }, context) => {
      let outcome: JobStatusToolOutcome;
      const configurationOutcome = configurationToolOutcome(runtime);
      if (configurationOutcome !== undefined) {
        outcome = configurationOutcome;
      } else if (runtime.kind === "ready") {
        outcome = await runtime.service.jobStatus(
          jobId,
          context.mcpReq.signal,
        );
      } else {
        throw new Error("The server runtime state is not exhaustive.");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
        structuredContent: outcome,
        isError:
          outcome.kind === "job_not_found" ||
          outcome.kind === "unavailable" ||
          outcome.kind === "protocol_error" ||
          outcome.kind === "lost",
      };
    },
  );

  server.registerTool(
    "compute_job_logs",
    {
      title: "Read Tailscale Compute Job Logs",
      description:
        "Read one UTF-8 stdout or stderr chunk by byte offset. Continue with nextOffsetBytes until endOfStream is true.",
      inputSchema: jobLogInputSchema,
      outputSchema: jobLogOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      let outcome: JobLogToolOutcome;
      const configurationOutcome = configurationToolOutcome(runtime);
      if (configurationOutcome !== undefined) {
        outcome = configurationOutcome;
      } else if (runtime.kind === "ready") {
        outcome = await runtime.service.jobLogs({
          jobId: input.jobId,
          stream: input.stream,
          offsetBytes: input.offsetBytes,
          maximumBytes: input.maximumBytes,
          signal: context.mcpReq.signal,
        });
      } else {
        throw new Error("The server runtime state is not exhaustive.");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
        structuredContent: outcome,
        isError: outcome.kind !== "log_chunk",
      };
    },
  );

  server.registerTool(
    "compute_job_cancel",
    {
      title: "Cancel Tailscale Compute Job",
      description:
        "Stop the complete remote process group for one durable job. A terminal job remains unchanged.",
      inputSchema: jobIdInputSchema,
      outputSchema: jobCancelOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId }, context) => {
      let outcome: JobCancelToolOutcome;
      const configurationOutcome = configurationToolOutcome(runtime);
      if (configurationOutcome !== undefined) {
        outcome = configurationOutcome;
      } else if (runtime.kind === "ready") {
        outcome = await runtime.service.cancelJob(
          jobId,
          context.mcpReq.signal,
        );
      } else {
        throw new Error("The server runtime state is not exhaustive.");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
        structuredContent: outcome,
        isError:
          outcome.kind === "job_not_found" ||
          outcome.kind === "unavailable" ||
          outcome.kind === "protocol_error" ||
          outcome.kind === "cancel_failed" ||
          outcome.kind === "lost",
      };
    },
  );

  server.registerTool(
    "compute_job_delete",
    {
      title: "Delete Tailscale Compute Job",
      description:
        "Delete one validated terminal job and its stored logs. Active jobs are refused.",
      inputSchema: jobIdInputSchema,
      outputSchema: jobDeleteOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId }, context) => {
      let outcome: JobDeleteToolOutcome;
      const configurationOutcome = configurationToolOutcome(runtime);
      if (configurationOutcome !== undefined) {
        outcome = configurationOutcome;
      } else if (runtime.kind === "ready") {
        outcome = await runtime.service.deleteJob(
          jobId,
          context.mcpReq.signal,
        );
      } else {
        throw new Error("The server runtime state is not exhaustive.");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
        structuredContent: outcome,
        isError: outcome.kind !== "deleted",
      };
    },
  );

  server.registerTool(
    "compute_fetch",
    {
      title: "Fetch Tailscale Compute Artifacts",
      description:
        "Copy files or directories into the local workspace. Set jobId to fetch a terminal job's immutable, receipt-verified artifact snapshot. Omit paths with jobId to fetch every declared artifact. Symbolic links and path escapes are refused.",
      inputSchema: fetchInputSchema,
      outputSchema: fetchOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      let outcome: FetchToolOutcome;
      const configurationOutcome = configurationToolOutcome(runtime);
      if (configurationOutcome !== undefined) {
        outcome = configurationOutcome;
      } else if (runtime.kind === "ready") {
        outcome = await runtime.service.fetch({
          workspacePath: input.workspacePath,
          source:
            "jobId" in input
              ? {
                  kind: "job",
                  jobId: input.jobId,
                  paths: input.paths,
                }
              : { kind: "workspace", paths: input.paths },
          localDestination: input.localDestination,
          overwrite: input.overwrite,
          timeoutSeconds: input.timeoutSeconds,
          signal: context.mcpReq.signal,
        });
      } else {
        throw new Error("The server runtime state is not exhaustive.");
      }

      let structuredContent: FetchToolOutcome | AuditedFetchOutcome = outcome;
      if (
        runtime.kind === "ready" &&
        (outcome.kind === "completed" ||
          outcome.kind === "artifact_refused" ||
          outcome.kind === "stage_failed")
      ) {
        const auditBase = {
          timestamp: new Date().toISOString(),
          target: outcome.target,
          remoteWorkspace: outcome.remoteWorkspace,
          localWorkspace: input.workspacePath ?? "(MCP process directory)",
          operation: "fetch" as const,
          paths: input.paths ?? [],
          localDestination: input.localDestination,
          overwrite: input.overwrite,
        };
        let auditEntry: AuditEntry;
        switch (outcome.kind) {
          case "completed":
            auditEntry = { ...auditBase, result: { kind: "completed" } };
            break;
          case "artifact_refused":
            auditEntry = {
              ...auditBase,
              result: {
                kind: "artifact_refused",
                path: outcome.path,
                reason: outcome.reason,
              },
            };
            break;
          case "stage_failed":
            auditEntry = {
              ...auditBase,
              result: { kind: "stage_failed", stage: outcome.stage },
            };
            break;
        }
        const auditWriteResult = writeAuditEntry(
          runtime.auditLogPath,
          auditEntry,
        );
        structuredContent = {
          ...outcome,
          audit: {
            path: runtime.auditLogPath,
            appended: auditWriteResult.kind === "appended",
            error:
              auditWriteResult.kind === "failed"
                ? auditWriteResult.message
                : undefined,
          },
        };
      }

      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
        isError: outcome.kind !== "completed",
      };
    },
  );

  return server;
}
