import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

import type {
  ComputeConfiguration,
  RemoteShellPreference,
} from "./config.js";
import {
  buildPytorchDoctorScript,
  parseDoctorProtocol,
  type CudaDevice,
  type DoctorCheckFailedProtocol,
  type DoctorReadyProtocol,
} from "./doctor.js";
import {
  runProcess,
  type CapturedOutput,
  type PrefixDigest,
  type ProcessOutcome,
} from "./process.js";
import {
  activeRunReceipt,
  capturedReceiptOutput,
  createRunReceiptBase,
  finishedRunReceipt,
  finishStoredRunReceipt,
  isActiveRunReceipt,
  parseRunReceiptJson,
  type ActiveRunReceipt,
  type FinishedRunReceipt,
  type FinishedReceiptOutput,
  type OutputDigest,
  type ReceiptHardware,
  type RunReceipt,
  type RunReceiptBase,
} from "./receipt.js";
import { failure, success, type Result } from "./result.js";

const PROCESS_OUTPUT_LIMIT_BYTES = 262_144;
const JOB_STATUS_OUTPUT_LIMIT_BYTES = 1_048_576;
const SYNC_OUTPUT_LIMIT_BYTES = 131_072;
const MINIMUM_PREPARE_TIMEOUT_MILLISECONDS = 15_000;
const MAXIMUM_WORKSPACE_SLUG_LENGTH = 48;
const MAXIMUM_JOB_LOG_CHUNK_BYTES = 262_144;
const JOB_START_TIMEOUT_MILLISECONDS = 15_000;
const DOCTOR_TIMEOUT_MILLISECONDS = 120_000;
const JOB_CANCEL_GRACE_SECONDS = 5;
const MAXIMUM_JOB_ARTIFACT_FILES = 1_024;
const MAXIMUM_JOB_ARTIFACT_MANIFEST_BYTES = 131_072;
const JOB_IDENTIFIER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JOB_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JOB_LABEL_PATTERN = /^[^\0\r\n]{1,128}$/;

const SYNC_EXCLUSIONS = [
  ".git/",
  ".env",
  ".env.*",
  ".npmrc",
  ".pypirc",
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".git-credentials",
  ".netrc",
  "*_history",
  ".curlrc",
  ".wgetrc",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.secret",
  "secrets/",
  "node_modules/",
  ".venv/",
  "venv/",
  "target/",
  "__pycache__/",
  ".next/cache/",
] as const;

export const DEFAULT_SYNC_EXCLUSION_ARGUMENTS: readonly string[] = Object.freeze(
  SYNC_EXCLUSIONS.flatMap((pattern) => ["--exclude", pattern]),
);

const IGNORE_FILE_NAMES = [".gitignore", ".tailscale-compute-ignore"] as const;
const MAXIMUM_IGNORE_FILE_BYTES = 65_536;
const MAXIMUM_IGNORE_RULES = 5_000;

export function buildSyncFilterArguments(
  localPath: string,
): readonly string[] {
  const includePairs: string[] = [];
  const excludePairs: string[] = [];
  let ruleCount = 0;

  for (const fileName of IGNORE_FILE_NAMES) {
    const filePath = path.join(localPath, fileName);
    let content: string;
    try {
      const fileStats = statSync(filePath);
      if (!fileStats.isFile() || fileStats.size > MAXIMUM_IGNORE_FILE_BYTES) {
        continue;
      }
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    for (const rawLine of content.split("\n")) {
      if (ruleCount >= MAXIMUM_IGNORE_RULES) {
        break;
      }
      const line = rawLine.replace(/\r$/, "").replace(/[ \t]+$/, "");
      if (
        line.length === 0 ||
        line.startsWith("#") ||
        line.includes("\0")
      ) {
        continue;
      }
      ruleCount += 1;
      if (line.startsWith("!")) {
        const pattern = line.slice(1);
        if (pattern.length > 0) {
          includePairs.push("--include", pattern);
        }
      } else {
        excludePairs.push("--exclude", line);
      }
    }
  }

  return Object.freeze([
    ...DEFAULT_SYNC_EXCLUSION_ARGUMENTS,
    ...includePairs,
    ...excludePairs,
  ]);
}

export type SyncMode = "incremental" | "clean" | "none";
export type RunStage = "probe" | "prepare" | "sync" | "metadata" | "command";
export type RemoteShellPath = "/bin/sh" | "/bin/bash" | "/bin/zsh";

export interface WorkspaceLocation {
  readonly id: string;
  readonly localPath: string;
  readonly remotePath: string;
}

export interface WorkspaceError {
  readonly code:
    | "workspace_not_absolute"
    | "workspace_not_directory"
    | "workspace_is_root"
    | "invalid_working_directory";
  readonly message: string;
}

export interface NvidiaAccelerator {
  readonly kind: "nvidia";
  readonly index: number;
  readonly name: string;
  readonly uuid: string;
  readonly memoryBytes: number;
  readonly driverVersion: string;
}

export type AcceleratorInventory =
  | { readonly kind: "none" }
  | {
      readonly kind: "nvidia";
      readonly devices: readonly NvidiaAccelerator[];
    }
  | { readonly kind: "error"; readonly message: string };

interface RemoteHardwareBase {
  readonly hostname: string;
  readonly architecture: string;
  readonly processor: string;
  readonly logicalProcessors: number;
  readonly memoryBytes: number;
  readonly shell: RemoteShellPath;
  readonly rsyncVersion: string;
  readonly uid: number;
  readonly isRoot: boolean;
  readonly acceleratorInventory: AcceleratorInventory;
}

export type RemoteHardware =
  | (RemoteHardwareBase & {
      readonly platform: "darwin";
      readonly productName: string;
      readonly productVersion: string;
      readonly buildVersion: string;
    })
  | (RemoteHardwareBase & {
      readonly platform: "linux";
      readonly distributionName: string;
      readonly distributionVersion: string;
      readonly kernelVersion: string;
    });

export type RequiredArchitecture = "arm64" | "aarch64" | "x86_64";

interface HardwareRequirementFields {
  readonly platform?: RemoteHardware["platform"] | undefined;
  readonly architecture?: RequiredArchitecture | undefined;
  readonly minimumMemoryBytes?: number | undefined;
  readonly nvidia?:
    | {
        readonly minimumDeviceCount: number;
        readonly minimumMemoryBytesPerDevice?: number | undefined;
      }
    | undefined;
}

export type HardwareRequirements = HardwareRequirementFields &
  (
    | { readonly platform: RemoteHardware["platform"] }
    | { readonly architecture: RequiredArchitecture }
    | { readonly minimumMemoryBytes: number }
    | {
        readonly nvidia: {
          readonly minimumDeviceCount: number;
          readonly minimumMemoryBytesPerDevice?: number | undefined;
        };
      }
  );

export type HardwareRequirementFailure =
  | {
      readonly kind: "platform";
      readonly required: RemoteHardware["platform"];
      readonly actual: RemoteHardware["platform"];
    }
  | {
      readonly kind: "architecture";
      readonly required: RequiredArchitecture;
      readonly actual: string;
    }
  | {
      readonly kind: "memory";
      readonly requiredBytes: number;
      readonly actualBytes: number;
    }
  | {
      readonly kind: "nvidia_inventory";
      readonly message: string;
    }
  | {
      readonly kind: "nvidia_device_count";
      readonly required: number;
      readonly actual: number;
    }
  | {
      readonly kind: "nvidia_memory";
      readonly requiredDeviceCount: number;
      readonly minimumBytesPerDevice: number;
      readonly qualifyingDeviceCount: number;
    };

export function evaluateHardwareRequirements(
  hardware: RemoteHardware,
  requirements: HardwareRequirements,
): readonly HardwareRequirementFailure[] {
  const failures: HardwareRequirementFailure[] = [];
  if (
    requirements.platform !== undefined &&
    requirements.platform !== hardware.platform
  ) {
    failures.push({
      kind: "platform",
      required: requirements.platform,
      actual: hardware.platform,
    });
  }
  if (
    requirements.architecture !== undefined &&
    requirements.architecture !== hardware.architecture
  ) {
    failures.push({
      kind: "architecture",
      required: requirements.architecture,
      actual: hardware.architecture,
    });
  }
  if (
    requirements.minimumMemoryBytes !== undefined &&
    requirements.minimumMemoryBytes > hardware.memoryBytes
  ) {
    failures.push({
      kind: "memory",
      requiredBytes: requirements.minimumMemoryBytes,
      actualBytes: hardware.memoryBytes,
    });
  }

  const nvidiaRequirement = requirements.nvidia;
  if (nvidiaRequirement === undefined) {
    return Object.freeze(failures);
  }
  switch (hardware.acceleratorInventory.kind) {
    case "error":
      failures.push({
        kind: "nvidia_inventory",
        message: hardware.acceleratorInventory.message,
      });
      break;
    case "none":
      failures.push({
        kind: "nvidia_device_count",
        required: nvidiaRequirement.minimumDeviceCount,
        actual: 0,
      });
      break;
    case "nvidia": {
      const devices = hardware.acceleratorInventory.devices;
      if (devices.length < nvidiaRequirement.minimumDeviceCount) {
        failures.push({
          kind: "nvidia_device_count",
          required: nvidiaRequirement.minimumDeviceCount,
          actual: devices.length,
        });
      }
      const minimumMemoryBytesPerDevice =
        nvidiaRequirement.minimumMemoryBytesPerDevice;
      if (minimumMemoryBytesPerDevice !== undefined) {
        const qualifyingDeviceCount = devices.filter(
          (device) => device.memoryBytes >= minimumMemoryBytesPerDevice,
        ).length;
        if (qualifyingDeviceCount < nvidiaRequirement.minimumDeviceCount) {
          failures.push({
            kind: "nvidia_memory",
            requiredDeviceCount: nvidiaRequirement.minimumDeviceCount,
            minimumBytesPerDevice: minimumMemoryBytesPerDevice,
            qualifyingDeviceCount,
          });
        }
      }
      break;
    }
  }
  return Object.freeze(failures);
}

export type SerializableProcessOutcome =
  | {
      readonly kind: "completed";
      readonly exitCode: number;
      readonly stdout: CapturedOutput;
      readonly stderr: CapturedOutput;
      readonly durationMilliseconds: number;
    }
  | {
      readonly kind: "signaled";
      readonly signal: NodeJS.Signals;
      readonly stdout: CapturedOutput;
      readonly stderr: CapturedOutput;
      readonly durationMilliseconds: number;
    }
  | {
      readonly kind: "timed_out" | "cancelled" | "unknown_termination";
      readonly stdout: CapturedOutput;
      readonly stderr: CapturedOutput;
      readonly durationMilliseconds: number;
    }
  | {
      readonly kind: "spawn_error";
      readonly message: string;
      readonly code: string | null;
      readonly stdout: CapturedOutput;
      readonly stderr: CapturedOutput;
      readonly durationMilliseconds: number;
    };

export interface NvidiaAcceleratorUsage {
  readonly kind: "nvidia";
  readonly index: number;
  readonly uuid: string;
  readonly memoryUsedBytes: number;
  readonly memoryAvailableBytes: number;
  readonly utilization:
    | { readonly kind: "reported"; readonly percent: number }
    | { readonly kind: "unavailable" };
}

export type AcceleratorUsage =
  | { readonly kind: "none" }
  | {
      readonly kind: "nvidia";
      readonly devices: readonly NvidiaAcceleratorUsage[];
    }
  | { readonly kind: "error"; readonly message: string };

export interface RemoteNodeHealth {
  readonly checkedAt: string;
  readonly uptimeSeconds: number;
  readonly loadAverage: {
    readonly oneMinute: number;
    readonly fiveMinutes: number;
    readonly fifteenMinutes: number;
  };
  readonly availableMemoryBytes: number;
  readonly remoteRootStorage: {
    readonly totalBytes: number;
    readonly availableBytes: number;
  };
  readonly acceleratorUsage: AcceleratorUsage;
  readonly activeJobCount: number;
}

export type StatusOutcome =
  | {
      readonly kind: "ready";
      readonly target: string;
      readonly remoteRoot: string;
      readonly remoteWorkspace: string;
      readonly hardware: RemoteHardware;
      readonly health: RemoteNodeHealth;
      readonly warning?: string;
      readonly durationMilliseconds: number;
    }
  | {
      readonly kind: "workspace_error";
      readonly error: WorkspaceError;
    }
  | {
      readonly kind: "unavailable";
      readonly target: string;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "probe_error";
      readonly target: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    };

export interface RemoteDoctorRequest {
  readonly profile: "pytorch";
  readonly pythonProgram: string;
  readonly requiredDevice: CudaDevice;
  readonly minimumAvailableMemoryBytes: number | undefined;
  readonly signal: AbortSignal | undefined;
}

export type RemoteDoctorOutcome =
  | (DoctorReadyProtocol & {
      readonly target: string;
      readonly durationMilliseconds: number;
    })
  | (DoctorCheckFailedProtocol & {
      readonly target: string;
      readonly durationMilliseconds: number;
    })
  | {
      readonly kind: "unavailable";
      readonly target: string;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "protocol_error";
      readonly target: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    };

export interface RemoteCommandRequest {
  readonly workspacePath: string | undefined;
  readonly program: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  readonly syncMode: SyncMode;
  readonly standardInput: string | undefined;
  readonly timeoutSeconds: number;
  readonly requirements: HardwareRequirements | undefined;
}

export interface RemoteRunRequest extends RemoteCommandRequest {
  readonly signal: AbortSignal | undefined;
}

export interface RemoteJobStartRequest extends RemoteCommandRequest {
  readonly idempotencyKey: string | undefined;
  readonly label: string | undefined;
  readonly artifactPaths: readonly string[];
  readonly signal: AbortSignal | undefined;
}

export type RemoteRunOutcome =
  | {
      readonly kind: "completed";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly exitCode: number;
      readonly stdout: CapturedOutput;
      readonly stderr: CapturedOutput;
      readonly syncDurationMilliseconds: number;
      readonly commandDurationMilliseconds: number;
      readonly warning?: string;
      readonly receipt: RunReceipt;
    }
  | {
      readonly kind: "workspace_error";
      readonly error: WorkspaceError;
    }
  | {
      readonly kind: "workspace_busy";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly activeJobIds: readonly string[];
    }
  | {
      readonly kind: "requirements_not_met";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly requirements: HardwareRequirements;
      readonly hardware: RemoteHardware;
      readonly failures: readonly HardwareRequirementFailure[];
      readonly receipt: RunReceipt;
    }
  | {
      readonly kind: "stage_failed";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly stage: RunStage;
      readonly process: SerializableProcessOutcome;
      readonly receipt: RunReceipt;
    }
  | {
      readonly kind: "protocol_error";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
      readonly receipt: RunReceipt;
    };

export type JobStage =
  | "probe"
  | "prepare"
  | "sync"
  | "metadata"
  | "job_prepare"
  | "job_start";
export type JobLogStream = "stdout" | "stderr";
export type ActiveJobState = "starting" | "running";

export type RemoteJobStartOutcome =
  | {
      readonly kind: "started";
      readonly jobId: string;
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly startedAt: string;
      readonly syncDurationMilliseconds: number;
      readonly warning?: string;
      readonly receipt: RunReceipt;
      readonly reused: boolean;
    }
  | {
      readonly kind: "workspace_error";
      readonly error: WorkspaceError;
    }
  | {
      readonly kind: "workspace_busy";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly activeJobIds: readonly string[];
    }
  | {
      readonly kind: "requirements_not_met";
      readonly jobId: string;
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly requirements: HardwareRequirements;
      readonly hardware: RemoteHardware;
      readonly failures: readonly HardwareRequirementFailure[];
      readonly receipt: RunReceipt;
    }
  | {
      readonly kind: "stage_failed";
      readonly jobId: string;
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly stage: JobStage;
      readonly process: SerializableProcessOutcome;
      readonly receipt: RunReceipt;
    }
  | {
      readonly kind: "protocol_error";
      readonly jobId: string;
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
      readonly receipt: RunReceipt;
    }
  | {
      readonly kind: "node_busy";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly maximumActiveJobs: number;
      readonly activeJobIds: readonly string[];
      readonly activeAdmissionCount: number;
    }
  | {
      readonly kind: "admission_error";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "validation_error";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly code:
        | "invalid_idempotency_key"
        | "invalid_label"
        | "invalid_artifact_path";
      readonly message: string;
    }
  | {
      readonly kind: "idempotency_conflict";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly existingJobId: string;
      readonly message: string;
    }
  | {
      readonly kind: "idempotency_error";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    };

interface RemoteJobStateBase {
  readonly jobId: string;
  readonly target: string;
  readonly remoteWorkspace: string;
  readonly startedAt: string;
  readonly receipt: RunReceipt;
}

export type RemoteJobStatusOutcome =
  | (RemoteJobStateBase & {
      readonly kind: "starting";
    })
  | (RemoteJobStateBase & {
      readonly kind: "running";
      readonly processGroupId: number;
    })
  | (RemoteJobStateBase & {
      readonly kind: "completed";
      readonly exitCode: 0;
      readonly finishedAt: string;
      readonly termination: { readonly kind: "completed" };
    })
  | (RemoteJobStateBase & {
      readonly kind: "failed";
      readonly exitCode: number;
      readonly finishedAt: string;
      readonly termination: Extract<
        JobTermination,
        {
          readonly kind:
            | "exited"
            | "signalled"
            | "timed_out"
            | "oom_killed";
        }
      >;
    })
  | (RemoteJobStateBase & {
      readonly kind: "cancelled";
      readonly finishedAt: string;
      readonly termination: { readonly kind: "cancelled" };
    })
  | (RemoteJobStateBase & {
      readonly kind: "lost";
      readonly lastKnownState: ActiveJobState;
      readonly finishedAt: string;
      readonly reason: string;
      readonly termination: { readonly kind: "lost"; readonly reason: string };
    })
  | {
      readonly kind: "job_not_found";
      readonly jobId: string;
      readonly target: string;
    }
  | {
      readonly kind: "unavailable";
      readonly jobId: string;
      readonly target: string;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "protocol_error";
      readonly jobId: string;
      readonly target: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    };

export type RemoteJobCancelOutcome =
  | RemoteJobStatusOutcome
  | {
      readonly kind: "cancel_failed";
      readonly jobId: string;
      readonly target: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    };

export type DurableJobState =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost";

export type JobTermination =
  | { readonly kind: "pending" }
  | { readonly kind: "completed" }
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "signalled"; readonly signalNumber: number }
  | { readonly kind: "timed_out"; readonly timeoutSeconds: number }
  | { readonly kind: "cancelled" }
  | { readonly kind: "lost"; readonly reason: string }
  | {
      readonly kind: "oom_killed";
      readonly evidence: {
        readonly kind: "cgroup";
        readonly oomKillCount: number;
      };
    };

interface RemoteJobSummaryBase {
  readonly jobId: string;
  readonly target: string;
  readonly localWorkspace: string;
  readonly remoteWorkspace: string;
  readonly program: string;
  readonly label?: string | undefined;
  readonly startedAt: string;
}

export type RemoteJobSummary = RemoteJobSummaryBase &
  (
    | {
        readonly state: "starting" | "running";
        readonly termination: { readonly kind: "pending" };
      }
    | {
        readonly state: "completed";
        readonly finishedAt: string;
        readonly termination: { readonly kind: "completed" };
      }
    | {
        readonly state: "failed";
        readonly finishedAt: string;
        readonly termination: Extract<
          JobTermination,
          {
            readonly kind:
              | "exited"
              | "signalled"
              | "timed_out"
              | "oom_killed";
          }
        >;
      }
    | {
        readonly state: "cancelled";
        readonly finishedAt: string;
        readonly termination: { readonly kind: "cancelled" };
      }
    | {
        readonly state: "lost";
        readonly finishedAt: string;
        readonly termination: {
          readonly kind: "lost";
          readonly reason: string;
        };
      }
  );

export interface RemoteJobListRequest {
  readonly workspacePath: string | undefined;
  readonly states: readonly DurableJobState[];
  readonly label: string | undefined;
  readonly limit: number;
  readonly cursor: string | null;
  readonly signal: AbortSignal | undefined;
}

export type RemoteJobListOutcome =
  | {
      readonly kind: "completed";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly jobs: readonly RemoteJobSummary[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: "workspace_error"; readonly error: WorkspaceError }
  | {
      readonly kind: "validation_error";
      readonly code: "invalid_cursor" | "invalid_label";
      readonly message: string;
    }
  | {
      readonly kind: "unavailable";
      readonly target: string;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "protocol_error";
      readonly target: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    };

export type RemoteJobDeleteOutcome =
  | {
      readonly kind: "deleted";
      readonly jobId: string;
      readonly target: string;
      readonly remoteWorkspace: string;
    }
  | {
      readonly kind: "job_active";
      readonly jobId: string;
      readonly target: string;
      readonly state: ActiveJobState;
    }
  | {
      readonly kind: "job_not_found";
      readonly jobId: string;
      readonly target: string;
    }
  | {
      readonly kind: "unavailable";
      readonly jobId: string;
      readonly target: string;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "protocol_error";
      readonly jobId: string;
      readonly target: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    };

export interface RemoteJobLogRequest {
  readonly jobId: string;
  readonly stream: JobLogStream;
  readonly offsetBytes: number;
  readonly maximumBytes: number;
  readonly signal: AbortSignal | undefined;
}

export type RemoteJobLogOutcome =
  | {
      readonly kind: "log_chunk";
      readonly jobId: string;
      readonly stream: JobLogStream;
      readonly text: string;
      readonly offsetBytes: number;
      readonly nextOffsetBytes: number;
      readonly totalBytes: number;
      readonly endOfStream: boolean;
    }
  | {
      readonly kind: "job_not_found" | "log_not_found";
      readonly jobId: string;
      readonly target: string;
    }
  | {
      readonly kind: "invalid_log_offset";
      readonly jobId: string;
      readonly target: string;
      readonly offsetBytes: number;
      readonly totalBytes: number;
      readonly message: string;
    }
  | {
      readonly kind: "unavailable";
      readonly jobId: string;
      readonly target: string;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "protocol_error";
      readonly jobId: string;
      readonly target: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    };

export type RemoteFetchSourceRequest =
  | {
      readonly kind: "workspace";
      readonly paths: readonly string[];
    }
  | {
      readonly kind: "job";
      readonly jobId: string;
      readonly paths: readonly string[] | undefined;
    };

export interface RemoteFetchRequest {
  readonly workspacePath: string | undefined;
  readonly source: RemoteFetchSourceRequest;
  readonly localDestination: string;
  readonly overwrite: boolean;
  readonly timeoutSeconds: number;
  readonly signal: AbortSignal | undefined;
}

export interface FetchedArtifact {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export type RemoteFetchOutcome =
  | {
      readonly kind: "completed";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly jobId?: string | undefined;
      readonly localDestination: string;
      readonly files: readonly FetchedArtifact[];
      readonly totalBytes: number;
      readonly durationMilliseconds: number;
    }
  | {
      readonly kind: "workspace_error";
      readonly error: WorkspaceError;
    }
  | {
      readonly kind: "validation_error";
      readonly code:
        | "invalid_remote_path"
        | "invalid_local_destination"
        | "destination_exists"
        | "local_artifact_error"
        | "invalid_job_id"
        | "job_workspace_mismatch"
        | "artifact_not_declared"
        | "artifact_integrity_error";
      readonly message: string;
    }
  | {
      readonly kind: "artifact_refused";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly path: string;
      readonly reason: "not_found" | "symbolic_link";
    }
  | {
      readonly kind: "job_not_terminal";
      readonly jobId: string;
      readonly target: string;
      readonly state: ActiveJobState;
    }
  | {
      readonly kind: "job_not_found";
      readonly jobId: string;
      readonly target: string;
    }
  | {
      readonly kind: "unavailable";
      readonly jobId: string;
      readonly target: string;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "protocol_error";
      readonly jobId: string;
      readonly target: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "stage_failed";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly stage: "validate" | "fetch";
      readonly process: SerializableProcessOutcome;
    };

export type WorkspaceRecordedTime =
  | { readonly kind: "never" }
  | { readonly kind: "recorded"; readonly value: string };

export type RemoteWorkspaceStatusOutcome =
  | {
      readonly kind: "completed";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly totalBytes: number;
      readonly lastSyncAt: WorkspaceRecordedTime;
      readonly lastRunAt: WorkspaceRecordedTime;
      readonly activeJobIds: readonly string[];
    }
  | {
      readonly kind: "workspace_not_found";
      readonly target: string;
      readonly remoteWorkspace: string;
    }
  | { readonly kind: "workspace_error"; readonly error: WorkspaceError }
  | {
      readonly kind: "unavailable";
      readonly target: string;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "protocol_error";
      readonly target: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    };

export type RemoteWorkspaceDeleteOutcome =
  | {
      readonly kind: "deleted";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly localWorkspace: string;
      readonly existed: boolean;
    }
  | {
      readonly kind: "workspace_busy";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly activeJobIds: readonly string[];
    }
  | { readonly kind: "workspace_error"; readonly error: WorkspaceError }
  | {
      readonly kind: "unavailable";
      readonly target: string;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "protocol_error";
      readonly target: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    };

interface ArtifactDestination {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly createdByFetch: boolean;
}

type ArtifactDestinationError = {
  readonly code: "invalid_local_destination" | "destination_exists";
  readonly message: string;
};

type ArtifactFetchSource =
  | { readonly kind: "workspace"; readonly remoteRoot: string }
  | {
      readonly kind: "job";
      readonly jobId: string;
      readonly remoteRoot: string;
      readonly expectedArtifacts: readonly FetchedArtifact[];
    };

interface ParsedJobStatusBase {
  readonly remoteWorkspace: string;
  readonly startedAt: string;
  readonly receipt: RunReceipt;
}

type JobOutputDigests = Extract<
  FinishedReceiptOutput,
  { readonly kind: "captured" }
>;

type ParsedJobStatus =
  | { readonly kind: "job_not_found" }
  | (ParsedJobStatusBase & { readonly kind: "starting" })
  | (ParsedJobStatusBase & {
      readonly kind: "running";
      readonly processGroupId: number;
    })
  | (ParsedJobStatusBase & {
      readonly kind: "completed";
      readonly finishedAt: string;
      readonly output: JobOutputDigests;
      readonly artifacts: readonly FetchedArtifact[];
      readonly termination: { readonly kind: "completed" };
    })
  | (ParsedJobStatusBase & {
      readonly kind: "failed";
      readonly finishedAt: string;
      readonly exitCode: number;
      readonly output: JobOutputDigests;
      readonly artifacts: readonly FetchedArtifact[];
      readonly termination: Extract<
        JobTermination,
        {
          readonly kind:
            | "exited"
            | "signalled"
            | "timed_out"
            | "oom_killed";
        }
      >;
    })
  | (ParsedJobStatusBase & {
      readonly kind: "cancelled";
      readonly finishedAt: string;
      readonly output: JobOutputDigests;
      readonly artifacts: readonly FetchedArtifact[];
      readonly termination: { readonly kind: "cancelled" };
    })
  | (ParsedJobStatusBase & {
      readonly kind: "lost";
      readonly finishedAt: string;
      readonly lastKnownState: ActiveJobState;
      readonly reason: string;
      readonly output: JobOutputDigests;
      readonly artifacts: readonly FetchedArtifact[];
      readonly termination: { readonly kind: "lost"; readonly reason: string };
    });

type ParsedJobLogProtocol =
  | { readonly kind: "job_not_found" }
  | { readonly kind: "log_not_found" }
  | { readonly kind: "invalid_log_offset"; readonly totalBytes: number }
  | {
      readonly kind: "data";
      readonly totalBytes: number;
      readonly bytes: Buffer;
    };

type JobIdempotencyLookup =
  | { readonly kind: "missing" }
  | {
      readonly kind: "existing";
      readonly jobId: string;
      readonly requestSha256: string;
    };

type JobPreparationProtocol =
  | { readonly kind: "created" }
  | {
      readonly kind: "existing";
      readonly jobId: string;
      readonly requestSha256: string;
    };

type JobAdmissionProtocol =
  | { readonly kind: "admitted" }
  | {
      readonly kind: "node_busy";
      readonly activeJobIds: readonly string[];
      readonly activeAdmissionCount: number;
    };

interface JobIdentifierPage {
  readonly cursorFound: boolean;
  readonly hasMore: boolean;
  readonly jobIds: readonly string[];
}

type JobDeleteProtocol =
  | { readonly kind: "deleted"; readonly remoteWorkspace: string }
  | { readonly kind: "job_not_found" }
  | { readonly kind: "job_active"; readonly state: ActiveJobState }
  | { readonly kind: "invalid" };

interface JobIdempotencyDescriptor {
  readonly recordPath: string;
  readonly requestSha256: string;
}

function createJobIdempotencyDescriptor(
  configuration: ComputeConfiguration,
  workspace: WorkspaceLocation,
  request: RemoteJobStartRequest,
): JobIdempotencyDescriptor | undefined {
  if (request.idempotencyKey === undefined) {
    return undefined;
  }
  const scopeSha256 = createHash("sha256")
    .update(configuration.target.destination)
    .update("\0")
    .update(workspace.id)
    .update("\0")
    .update(request.idempotencyKey)
    .digest("hex");
  const requirements = request.requirements;
  const requestSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        program: request.program,
        arguments: request.arguments,
        environment: Object.entries(request.environment).sort(
          ([leftName], [rightName]) => leftName.localeCompare(rightName),
        ),
        workingDirectory: request.workingDirectory,
        syncMode: request.syncMode,
        standardInput: request.standardInput ?? null,
        timeoutSeconds: request.timeoutSeconds,
        requirements:
          requirements === undefined
            ? null
            : {
                platform: requirements.platform ?? null,
                architecture: requirements.architecture ?? null,
                minimumMemoryBytes: requirements.minimumMemoryBytes ?? null,
                nvidia:
                  requirements.nvidia === undefined
                    ? null
                    : {
                        minimumDeviceCount:
                          requirements.nvidia.minimumDeviceCount,
                        minimumMemoryBytesPerDevice:
                          requirements.nvidia.minimumMemoryBytesPerDevice ??
                          null,
                      },
              },
        label: request.label ?? null,
        artifactPaths: request.artifactPaths,
      }),
    )
    .digest("hex");
  return {
    recordPath: path.posix.join(
      configuration.remoteRoot,
      ".idempotency",
      workspace.id,
      scopeSha256,
    ),
    requestSha256,
  };
}

export class RemoteComputeService {
  readonly #configuration: ComputeConfiguration;
  readonly #workspaceQueue = new WorkspaceQueue();

  constructor(configuration: ComputeConfiguration) {
    this.#configuration = configuration;
  }

  async status(
    workspacePath: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<StatusOutcome> {
    const workspaceResult = this.resolveWorkspace(workspacePath);
    if (!workspaceResult.ok) {
      return { kind: "workspace_error", error: workspaceResult.error };
    }

    const probeProcess = await this.runSsh(
      buildRemoteProbeCommand(this.#configuration.remoteShell),
      undefined,
      this.prepareTimeoutMilliseconds(),
      PROCESS_OUTPUT_LIMIT_BYTES,
      signal,
    );
    const serializableProcess = toSerializableProcessOutcome(probeProcess);

    if (probeProcess.kind !== "completed" || probeProcess.exitCode !== 0) {
      return {
        kind: "unavailable",
        target: this.#configuration.target.destination,
        process: serializableProcess,
      };
    }

    const hardwareResult = parseRemoteHardware(probeProcess.stdout.text);
    if (!hardwareResult.ok) {
      return {
        kind: "probe_error",
        target: this.#configuration.target.destination,
        message: hardwareResult.error,
        process: serializableProcess,
      };
    }

    const healthProcess = await this.runSsh(
      buildNodeHealthCommand(
        this.#configuration.remoteRoot,
        this.jobsRoot(),
        hardwareResult.value.platform,
      ),
      undefined,
      this.prepareTimeoutMilliseconds(),
      PROCESS_OUTPUT_LIMIT_BYTES,
      signal,
    );
    const serializableHealthProcess =
      toSerializableProcessOutcome(healthProcess);
    if (healthProcess.kind !== "completed" || healthProcess.exitCode !== 0) {
      return {
        kind: "unavailable",
        target: this.#configuration.target.destination,
        process: serializableHealthProcess,
      };
    }
    const healthResult = parseNodeHealthProtocol(healthProcess.stdout.text);
    if (!healthResult.ok) {
      return {
        kind: "probe_error",
        target: this.#configuration.target.destination,
        message: healthResult.error,
        process: serializableHealthProcess,
      };
    }


    return {
      kind: "ready",
      target: this.#configuration.target.destination,
      remoteRoot: this.#configuration.remoteRoot,
      remoteWorkspace: workspaceResult.value.remotePath,
      hardware: hardwareResult.value,
      health: healthResult.value,
      ...(hardwareResult.value.isRoot
        ? { warning: rootWarning(this.#configuration.target.destination) }
        : {}),
      durationMilliseconds:
        probeProcess.durationMilliseconds + healthProcess.durationMilliseconds,
    };
  }

  async doctor(request: RemoteDoctorRequest): Promise<RemoteDoctorOutcome> {
    const missingPythonOutput = JSON.stringify({
      kind: "check_failed",
      profile: request.profile,
      check: "python",
      message: `The Python program '${request.pythonProgram}' is not available on the remote node.`,
    });
    const pythonScript = buildPytorchDoctorScript({
      profile: request.profile,
      pythonProgram: request.pythonProgram,
      requiredDevice: request.requiredDevice,
      ...(request.minimumAvailableMemoryBytes === undefined
        ? {}
        : {
            minimumAvailableMemoryBytes:
              request.minimumAvailableMemoryBytes,
          }),
    });
    const shellScript = [
      `python_program=${quoteForPosixShell(request.pythonProgram)}`,
      'if ! command -v "$python_program" >/dev/null 2>&1; then',
      `  printf '%s\\n' ${quoteForPosixShell(missingPythonOutput)}`,
      "  exit 0",
      "fi",
      `exec "$python_program" -c ${quoteForPosixShell(pythonScript)}`,
    ].join("\n");
    const doctorProcess = await this.runSsh(
      `/bin/sh -c ${quoteForPosixShell(shellScript)}`,
      undefined,
      DOCTOR_TIMEOUT_MILLISECONDS,
      PROCESS_OUTPUT_LIMIT_BYTES,
      request.signal,
    );
    const target = this.#configuration.target.destination;
    if (
      doctorProcess.kind !== "completed" ||
      doctorProcess.exitCode !== 0
    ) {
      return {
        kind: "unavailable",
        target,
        process: toSerializableProcessOutcome(doctorProcess),
      };
    }
    const protocolResult = parseDoctorProtocol(doctorProcess.stdout.text);
    if (!protocolResult.ok) {
      return {
        kind: "protocol_error",
        target,
        message: protocolResult.error,
        process: toSerializableProcessOutcome(doctorProcess),
      };
    }
    switch (protocolResult.value.kind) {
      case "ready":
      case "check_failed":
        return {
          ...protocolResult.value,
          target,
          durationMilliseconds: doctorProcess.durationMilliseconds,
        };
    }
  }

  async workspaceStatus(
    workspacePath: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RemoteWorkspaceStatusOutcome> {
    const workspaceResult = this.resolveWorkspace(workspacePath);
    if (!workspaceResult.ok) {
      return { kind: "workspace_error", error: workspaceResult.error };
    }
    const workspace = workspaceResult.value;
    const target = this.#configuration.target.destination;
    return await this.#workspaceQueue.run(workspace.remotePath, async () => {
      const statusProcess = await this.runSsh(
        buildWorkspaceStatusCommand(
          workspace.remotePath,
          this.workspaceMetadataDirectory(workspace.id),
        ),
        undefined,
        this.prepareTimeoutMilliseconds(),
        PROCESS_OUTPUT_LIMIT_BYTES,
        signal,
      );
      if (statusProcess.kind !== "completed" || statusProcess.exitCode !== 0) {
        return {
          kind: "unavailable",
          target,
          process: toSerializableProcessOutcome(statusProcess),
        };
      }
      const statusResult = parseWorkspaceStatusProtocol(
        statusProcess.stdout.text,
      );
      if (!statusResult.ok) {
        return {
          kind: "protocol_error",
          target,
          message: statusResult.error,
          process: toSerializableProcessOutcome(statusProcess),
        };
      }
      if (statusResult.value.kind === "workspace_not_found") {
        return {
          kind: "workspace_not_found",
          target,
          remoteWorkspace: workspace.remotePath,
        };
      }

      const activeJobsProcess = await this.runSsh(
        buildActiveJobsCommand(this.jobsRoot(), workspace.id),
        undefined,
        this.prepareTimeoutMilliseconds(),
        PROCESS_OUTPUT_LIMIT_BYTES,
        signal,
      );
      if (
        activeJobsProcess.kind !== "completed" ||
        activeJobsProcess.exitCode !== 0
      ) {
        return {
          kind: "unavailable",
          target,
          process: toSerializableProcessOutcome(activeJobsProcess),
        };
      }
      return {
        kind: "completed",
        target,
        remoteWorkspace: workspace.remotePath,
        totalBytes: statusResult.value.totalBytes,
        lastSyncAt: statusResult.value.lastSyncAt,
        lastRunAt: statusResult.value.lastRunAt,
        activeJobIds: parseActiveJobIdentifiers(
          activeJobsProcess.stdout.text,
        ),
      };
    });
  }

  async deleteWorkspace(
    workspacePath: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RemoteWorkspaceDeleteOutcome> {
    const workspaceResult = this.resolveWorkspace(workspacePath);
    if (!workspaceResult.ok) {
      return { kind: "workspace_error", error: workspaceResult.error };
    }
    const workspace = workspaceResult.value;
    const target = this.#configuration.target.destination;
    return await this.#workspaceQueue.run(workspace.remotePath, async () => {
      const activeJobsProcess = await this.runSsh(
        buildActiveJobsCommand(this.jobsRoot(), workspace.id),
        undefined,
        this.prepareTimeoutMilliseconds(),
        PROCESS_OUTPUT_LIMIT_BYTES,
        signal,
      );
      if (
        activeJobsProcess.kind !== "completed" ||
        activeJobsProcess.exitCode !== 0
      ) {
        return {
          kind: "unavailable",
          target,
          process: toSerializableProcessOutcome(activeJobsProcess),
        };
      }
      const activeJobIds = parseActiveJobIdentifiers(
        activeJobsProcess.stdout.text,
      );
      if (activeJobIds.length > 0) {
        return {
          kind: "workspace_busy",
          target,
          remoteWorkspace: workspace.remotePath,
          activeJobIds,
        };
      }

      const deleteProcess = await this.runSsh(
        buildDeleteWorkspaceCommand(
          this.#configuration.remoteRoot,
          workspace.remotePath,
          this.workspaceMetadataDirectory(workspace.id),
        ),
        undefined,
        this.prepareTimeoutMilliseconds(),
        PROCESS_OUTPUT_LIMIT_BYTES,
        signal,
      );
      if (deleteProcess.kind !== "completed" || deleteProcess.exitCode !== 0) {
        return {
          kind: "unavailable",
          target,
          process: toSerializableProcessOutcome(deleteProcess),
        };
      }
      const deleteResult = parseWorkspaceDeleteProtocol(
        deleteProcess.stdout.text,
      );
      if (!deleteResult.ok) {
        return {
          kind: "protocol_error",
          target,
          message: deleteResult.error,
          process: toSerializableProcessOutcome(deleteProcess),
        };
      }
      return {
        kind: "deleted",
        target,
        remoteWorkspace: workspace.remotePath,
        localWorkspace: workspace.localPath,
        existed: deleteResult.value,
      };
    });
  }

  async run(request: RemoteRunRequest): Promise<RemoteRunOutcome> {
    const workspaceResult = this.resolveWorkspace(request.workspacePath);
    if (!workspaceResult.ok) {
      return { kind: "workspace_error", error: workspaceResult.error };
    }

    const relativeDirectoryResult = parseRemoteRelativePath(
      request.workingDirectory,
    );
    if (!relativeDirectoryResult.ok) {
      return {
        kind: "workspace_error",
        error: {
          code: "invalid_working_directory",
          message: relativeDirectoryResult.error,
        },
      };
    }

    const workspace = workspaceResult.value;
    const receiptBase = createRunReceiptBase(
      randomUUID(),
      this.#configuration.target.destination,
      workspace.localPath,
      workspace.remotePath,
      {
        program: request.program,
        arguments: request.arguments,
        environment: request.environment,
        workingDirectory: relativeDirectoryResult.value,
        requirements: request.requirements,
      },
      request.syncMode,
      new Date().toISOString(),
    );
    return await this.#workspaceQueue.run(workspace.remotePath, async () =>
      this.runInWorkspace(
        request,
        workspace,
        relativeDirectoryResult.value,
        receiptBase,
      ),
    );
  }

  async startJob(
    request: RemoteJobStartRequest,
  ): Promise<RemoteJobStartOutcome> {
    const workspaceResult = this.resolveWorkspace(request.workspacePath);
    if (!workspaceResult.ok) {
      return { kind: "workspace_error", error: workspaceResult.error };
    }

    const relativeDirectoryResult = parseRemoteRelativePath(
      request.workingDirectory,
    );
    if (!relativeDirectoryResult.ok) {
      return {
        kind: "workspace_error",
        error: {
          code: "invalid_working_directory",
          message: relativeDirectoryResult.error,
        },
      };
    }

    const workspace = workspaceResult.value;
    const target = this.#configuration.target.destination;
    if (
      request.idempotencyKey !== undefined &&
      !JOB_IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)
    ) {
      return {
        kind: "validation_error",
        target,
        remoteWorkspace: workspace.remotePath,
        code: "invalid_idempotency_key",
        message:
          "The idempotency key must start with an ASCII letter or digit and contain at most 128 letters, digits, periods, underscores, colons, or hyphens.",
      };
    }
    if (request.label !== undefined && !JOB_LABEL_PATTERN.test(request.label)) {
      return {
        kind: "validation_error",
        target,
        remoteWorkspace: workspace.remotePath,
        code: "invalid_label",
        message:
          "The job label must contain from 1 through 128 characters and must not contain a null byte or a line break.",
      };
    }
    if (request.artifactPaths.length > 64) {
      return {
        kind: "validation_error",
        target,
        remoteWorkspace: workspace.remotePath,
        code: "invalid_artifact_path",
        message: "A job can declare at most 64 artifact paths.",
      };
    }
    const artifactPathsResult =
      request.artifactPaths.length === 0
        ? success(Object.freeze<string[]>([]))
        : parseArtifactPaths(request.artifactPaths);
    if (!artifactPathsResult.ok) {
      return {
        kind: "validation_error",
        target,
        remoteWorkspace: workspace.remotePath,
        code: "invalid_artifact_path",
        message: artifactPathsResult.error,
      };
    }
    const normalizedRequest: RemoteJobStartRequest = {
      ...request,
      artifactPaths: artifactPathsResult.value,
    };


    return await this.#workspaceQueue.run(workspace.remotePath, async () =>
      this.startJobInWorkspace(
        normalizedRequest,
        workspace,
        relativeDirectoryResult.value,
      ),
    );
  }

  async jobStatus(
    jobId: string,
    signal: AbortSignal | undefined,
  ): Promise<RemoteJobStatusOutcome> {
    const target = this.#configuration.target.destination;
    if (!JOB_IDENTIFIER_PATTERN.test(jobId)) {
      return {
        kind: "protocol_error",
        jobId,
        target,
        message: "The job identifier is not a valid version 4 UUID.",
        process: emptySerializableProcessOutcome(),
      };
    }

    const statusProcess = await this.runSsh(
      buildJobStatusCommand(this.jobDirectory(jobId)),
      undefined,
      this.prepareTimeoutMilliseconds(),
      JOB_STATUS_OUTPUT_LIMIT_BYTES,
      signal,
    );
    if (statusProcess.kind !== "completed" || statusProcess.exitCode !== 0) {
      return {
        kind: "unavailable",
        jobId,
        target,
        process: toSerializableProcessOutcome(statusProcess),
      };
    }

    const statusResult = parseJobStatusProtocol(statusProcess.stdout.text);
    if (!statusResult.ok) {
      return {
        kind: "protocol_error",
        jobId,
        target,
        message: statusResult.error,
        process: toSerializableProcessOutcome(statusProcess),
      };
    }

    const status = statusResult.value;
    if (status.kind === "job_not_found") {
      return { kind: "job_not_found", jobId, target };
    }
    if (
      status.receipt.runId !== jobId ||
      status.receipt.target !== target ||
      status.receipt.remoteWorkspace !== status.remoteWorkspace
    ) {
      return {
        kind: "protocol_error",
        jobId,
        target,
        message: "The stored run receipt does not identify this job.",
        process: toSerializableProcessOutcome(statusProcess),
      };
    }
    const receiptResult = receiptForJobStatus(status);
    if (!receiptResult.ok) {
      return {
        kind: "protocol_error",
        jobId,
        target,
        message: receiptResult.error,
        process: toSerializableProcessOutcome(statusProcess),
      };
    }
    const statusIsTerminal =
      status.kind === "completed" ||
      status.kind === "failed" ||
      status.kind === "cancelled" ||
      status.kind === "lost";
    if (isActiveRunReceipt(status.receipt) && statusIsTerminal) {
      const receiptWriteProcess = await this.writeRemoteFile(
        path.posix.join(this.jobDirectory(jobId), "receipt.json"),
        `${JSON.stringify(receiptResult.value)}\n`,
        signal,
      );
      if (
        receiptWriteProcess.kind !== "completed" ||
        receiptWriteProcess.exitCode !== 0
      ) {
        return {
          kind: "unavailable",
          jobId,
          target,
          process: toSerializableProcessOutcome(receiptWriteProcess),
        };
      }
    }


    const base = {
      jobId,
      target,
      remoteWorkspace: status.remoteWorkspace,
      startedAt: status.startedAt,
      receipt: receiptResult.value,
    };
    switch (status.kind) {
      case "starting":
        return { kind: "starting", ...base };
      case "running":
        return {
          kind: "running",
          ...base,
          processGroupId: status.processGroupId,
        };
      case "completed":
        return {
          kind: "completed",
          ...base,
          exitCode: 0,
          finishedAt: status.finishedAt,
          termination: status.termination,
        };
      case "failed":
        return {
          kind: "failed",
          ...base,
          exitCode: status.exitCode,
          finishedAt: status.finishedAt,
          termination: status.termination,
        };
      case "cancelled":
        return {
          kind: "cancelled",
          ...base,
          finishedAt: status.finishedAt,
          termination: status.termination,
        };
      case "lost":
        return {
          kind: "lost",
          ...base,
          lastKnownState: status.lastKnownState,
          finishedAt: status.finishedAt,
          reason: status.reason,
          termination: status.termination,
        };
    }
  }

  async jobLogs(
    request: RemoteJobLogRequest,
  ): Promise<RemoteJobLogOutcome> {
    const target = this.#configuration.target.destination;
    if (!JOB_IDENTIFIER_PATTERN.test(request.jobId)) {
      return {
        kind: "protocol_error",
        jobId: request.jobId,
        target,
        message: "The job identifier is not a valid version 4 UUID.",
        process: emptySerializableProcessOutcome(),
      };
    }

    const logProcess = await this.runSsh(
      buildJobLogCommand(
        this.jobDirectory(request.jobId),
        request.stream,
        request.offsetBytes,
        Math.min(request.maximumBytes, MAXIMUM_JOB_LOG_CHUNK_BYTES),
      ),
      undefined,
      this.prepareTimeoutMilliseconds(),
      MAXIMUM_JOB_LOG_CHUNK_BYTES * 2,
      request.signal,
    );
    if (logProcess.kind !== "completed" || logProcess.exitCode !== 0) {
      return {
        kind: "unavailable",
        jobId: request.jobId,
        target,
        process: toSerializableProcessOutcome(logProcess),
      };
    }

    const protocolResult = parseJobLogProtocol(logProcess.stdout);
    if (!protocolResult.ok) {
      return {
        kind: "protocol_error",
        jobId: request.jobId,
        target,
        message: protocolResult.error,
        process: toSerializableProcessOutcome(logProcess),
      };
    }

    const protocol = protocolResult.value;
    if (protocol.kind === "job_not_found") {
      return { kind: "job_not_found", jobId: request.jobId, target };
    }
    if (protocol.kind === "log_not_found") {
      return { kind: "log_not_found", jobId: request.jobId, target };
    }
    if (protocol.kind === "invalid_log_offset") {
      return {
        kind: "invalid_log_offset",
        jobId: request.jobId,
        target,
        offsetBytes: request.offsetBytes,
        totalBytes: protocol.totalBytes,
        message: `The log offset ${request.offsetBytes} is larger than the ${protocol.totalBytes}-byte log.`,
      };
    }

    const chunkResult = decodeUtf8LogChunk(
      protocol.bytes,
      request.offsetBytes,
      protocol.totalBytes,
    );
    if (!chunkResult.ok) {
      return {
        kind: "invalid_log_offset",
        jobId: request.jobId,
        target,
        offsetBytes: request.offsetBytes,
        totalBytes: protocol.totalBytes,
        message: chunkResult.error,
      };
    }

    const nextOffsetBytes =
      request.offsetBytes + chunkResult.value.consumedBytes;
    return {
      kind: "log_chunk",
      jobId: request.jobId,
      stream: request.stream,
      text: chunkResult.value.text,
      offsetBytes: request.offsetBytes,
      nextOffsetBytes,
      totalBytes: protocol.totalBytes,
      endOfStream: nextOffsetBytes >= protocol.totalBytes,
    };
  }

  async cancelJob(
    jobId: string,
    signal: AbortSignal | undefined,
  ): Promise<RemoteJobCancelOutcome> {
    const status = await this.jobStatus(jobId, signal);
    if (
      status.kind !== "starting" &&
      status.kind !== "running"
    ) {
      return status;
    }

    const cancelProcess = await this.runSsh(
      buildCancelJobCommand(
        this.jobDirectory(jobId),
        JOB_CANCEL_GRACE_SECONDS,
      ),
      undefined,
      (JOB_CANCEL_GRACE_SECONDS + 5) * 1_000,
      PROCESS_OUTPUT_LIMIT_BYTES,
      signal,
    );
    if (cancelProcess.kind !== "completed" || cancelProcess.exitCode !== 0) {
      return {
        kind: "cancel_failed",
        jobId,
        target: this.#configuration.target.destination,
        message: "The remote process group did not stop.",
        process: toSerializableProcessOutcome(cancelProcess),
      };
    }

    return await this.jobStatus(jobId, signal);
  }

  async listJobs(
    request: RemoteJobListRequest,
  ): Promise<RemoteJobListOutcome> {
    const workspaceResult = this.resolveWorkspace(request.workspacePath);
    if (!workspaceResult.ok) {
      return { kind: "workspace_error", error: workspaceResult.error };
    }
    if (request.label !== undefined && !JOB_LABEL_PATTERN.test(request.label)) {
      return {
        kind: "validation_error",
        code: "invalid_label",
        message:
          "The job label must contain from 1 through 128 characters and must not contain a null byte or a line break.",
      };
    }
    if (
      request.cursor !== null &&
      !JOB_IDENTIFIER_PATTERN.test(request.cursor)
    ) {
      return {
        kind: "validation_error",
        code: "invalid_cursor",
        message: "The job cursor must be a version 4 UUID.",
      };
    }

    const workspace = workspaceResult.value;
    const target = this.#configuration.target.destination;
    const summaries: RemoteJobSummary[] = [];
    let scanCursor = request.cursor;
    while (summaries.length <= request.limit) {
      const listProcess = await this.runSsh(
        buildJobListCommand(this.jobsRoot(), workspace.id, scanCursor, 100),
        undefined,
        this.prepareTimeoutMilliseconds(),
        PROCESS_OUTPUT_LIMIT_BYTES,
        request.signal,
      );
      if (listProcess.kind !== "completed" || listProcess.exitCode !== 0) {
        return {
          kind: "unavailable",
          target,
          process: toSerializableProcessOutcome(listProcess),
        };
      }
      const pageResult = parseJobIdentifierPageProtocol(
        listProcess.stdout.text,
      );
      if (!pageResult.ok) {
        return {
          kind: "protocol_error",
          target,
          message: pageResult.error,
          process: toSerializableProcessOutcome(listProcess),
        };
      }
      const page = pageResult.value;
      if (!page.cursorFound) {
        if (scanCursor === request.cursor) {
          return {
            kind: "validation_error",
            code: "invalid_cursor",
            message: "The job cursor does not identify a job in this workspace.",
          };
        }
        return {
          kind: "protocol_error",
          target,
          message: "A job disappeared during paged listing.",
          process: toSerializableProcessOutcome(listProcess),
        };
      }

      for (const jobId of page.jobIds) {
        const status = await this.jobStatus(jobId, request.signal);
        switch (status.kind) {
          case "job_not_found":
            continue;
          case "unavailable":
            return {
              kind: "unavailable",
              target,
              process: status.process,
            };
          case "protocol_error":
            return {
              kind: "protocol_error",
              target,
              message: status.message,
              process: status.process,
            };
          case "starting":
          case "running":
          case "completed":
          case "failed":
          case "cancelled":
          case "lost":
            break;
        }
        if (
          (request.states.length > 0 &&
            !request.states.includes(status.kind)) ||
          (request.label !== undefined &&
            status.receipt.label !== request.label)
        ) {
          continue;
        }

        const common = {
          jobId,
          target,
          localWorkspace: status.receipt.localWorkspace,
          remoteWorkspace: status.remoteWorkspace,
          program: status.receipt.command.program,
          ...(status.receipt.label === undefined
            ? {}
            : { label: status.receipt.label }),
          startedAt: status.startedAt,
        };
        switch (status.kind) {
          case "starting":
          case "running":
            summaries.push({
              ...common,
              state: status.kind,
              termination: { kind: "pending" },
            });
            break;
          case "completed":
            summaries.push({
              ...common,
              state: "completed",
              finishedAt: status.finishedAt,
              termination: status.termination,
            });
            break;
          case "failed":
            summaries.push({
              ...common,
              state: "failed",
              finishedAt: status.finishedAt,
              termination: status.termination,
            });
            break;
          case "cancelled":
            summaries.push({
              ...common,
              state: "cancelled",
              finishedAt: status.finishedAt,
              termination: status.termination,
            });
            break;
          case "lost":
            summaries.push({
              ...common,
              state: "lost",
              finishedAt: status.finishedAt,
              termination: status.termination,
            });
            break;
        }
        if (summaries.length > request.limit) {
          break;
        }
      }

      if (summaries.length > request.limit || !page.hasMore) {
        break;
      }
      const lastScannedJobId = page.jobIds.at(-1);
      if (lastScannedJobId === undefined) {
        return {
          kind: "protocol_error",
          target,
          message: "The job list page did not advance.",
          process: toSerializableProcessOutcome(listProcess),
        };
      }
      scanCursor = lastScannedJobId;
    }

    const jobs = summaries.slice(0, request.limit);
    return {
      kind: "completed",
      target,
      remoteWorkspace: workspace.remotePath,
      jobs,
      nextCursor:
        summaries.length > request.limit
          ? (jobs.at(-1)?.jobId ?? null)
          : null,
    };
  }

  async deleteJob(
    jobId: string,
    signal: AbortSignal | undefined,
  ): Promise<RemoteJobDeleteOutcome> {
    const status = await this.jobStatus(jobId, signal);
    switch (status.kind) {
      case "starting":
      case "running":
        return {
          kind: "job_active",
          jobId,
          target: status.target,
          state: status.kind,
        };
      case "job_not_found":
      case "unavailable":
      case "protocol_error":
        return status;
      case "completed":
      case "failed":
      case "cancelled":
      case "lost":
        break;
    }

    const deleteProcess = await this.#workspaceQueue.run(
      path.posix.join(this.jobDirectory(jobId), "artifacts"),
      async () =>
        this.runSsh(
          buildDeleteJobCommand(
            this.#configuration.remoteRoot,
            this.jobsRoot(),
            jobId,
          ),
          undefined,
          this.prepareTimeoutMilliseconds(),
          PROCESS_OUTPUT_LIMIT_BYTES,
          signal,
        ),
    );
    if (deleteProcess.kind !== "completed" || deleteProcess.exitCode !== 0) {
      return {
        kind: "unavailable",
        jobId,
        target: status.target,
        process: toSerializableProcessOutcome(deleteProcess),
      };
    }
    const protocolResult = parseJobDeleteProtocol(deleteProcess.stdout.text);
    if (!protocolResult.ok) {
      return {
        kind: "protocol_error",
        jobId,
        target: status.target,
        message: protocolResult.error,
        process: toSerializableProcessOutcome(deleteProcess),
      };
    }
    const protocol = protocolResult.value;
    switch (protocol.kind) {
      case "deleted":
        if (protocol.remoteWorkspace !== status.remoteWorkspace) {
          return {
            kind: "protocol_error",
            jobId,
            target: status.target,
            message: "The deleted job workspace does not match its receipt.",
            process: toSerializableProcessOutcome(deleteProcess),
          };
        }
        return {
          kind: "deleted",
          jobId,
          target: status.target,
          remoteWorkspace: protocol.remoteWorkspace,
        };
      case "job_not_found":
        return { kind: "job_not_found", jobId, target: status.target };
      case "job_active":
        return {
          kind: "job_active",
          jobId,
          target: status.target,
          state: protocol.state,
        };
      case "invalid":
        return {
          kind: "protocol_error",
          jobId,
          target: status.target,
          message: "The remote job directory is not safe to delete.",
          process: toSerializableProcessOutcome(deleteProcess),
        };
    }
  }

  async fetch(request: RemoteFetchRequest): Promise<RemoteFetchOutcome> {
    const workspaceResult = this.resolveWorkspace(request.workspacePath);
    if (!workspaceResult.ok) {
      return { kind: "workspace_error", error: workspaceResult.error };
    }

    const workspace = workspaceResult.value;
    const destinationResult = resolveArtifactDestination(
      workspace.localPath,
      request.localDestination,
      request.overwrite,
    );
    if (!destinationResult.ok) {
      return {
        kind: "validation_error",
        code: destinationResult.error.code,
        message: destinationResult.error.message,
      };
    }

    let source: ArtifactFetchSource;
    let remotePaths: readonly string[];
    switch (request.source.kind) {
      case "workspace": {
        const remotePathsResult = parseArtifactPaths(request.source.paths);
        if (!remotePathsResult.ok) {
          return {
            kind: "validation_error",
            code: "invalid_remote_path",
            message: remotePathsResult.error,
          };
        }
        source = { kind: "workspace", remoteRoot: workspace.remotePath };
        remotePaths = remotePathsResult.value;
        break;
      }
      case "job": {
        if (!JOB_IDENTIFIER_PATTERN.test(request.source.jobId)) {
          return {
            kind: "validation_error",
            code: "invalid_job_id",
            message: "The artifact job ID must be a version 4 UUID.",
          };
        }
        const requestedPathsResult =
          request.source.paths === undefined
            ? undefined
            : parseArtifactPaths(request.source.paths);
        if (requestedPathsResult !== undefined && !requestedPathsResult.ok) {
          return {
            kind: "validation_error",
            code: "invalid_remote_path",
            message: requestedPathsResult.error,
          };
        }

        const status = await this.jobStatus(
          request.source.jobId,
          request.signal,
        );
        switch (status.kind) {
          case "starting":
          case "running":
            return {
              kind: "job_not_terminal",
              jobId: request.source.jobId,
              target: status.target,
              state: status.kind,
            };
          case "job_not_found":
          case "unavailable":
          case "protocol_error":
            return status;
          case "completed":
          case "failed":
          case "cancelled":
          case "lost": {
            if (status.remoteWorkspace !== workspace.remotePath) {
              return {
                kind: "validation_error",
                code: "job_workspace_mismatch",
                message:
                  "The artifact job belongs to a different managed workspace.",
              };
            }

            let expectedArtifacts: readonly FetchedArtifact[];
            if (requestedPathsResult === undefined) {
              expectedArtifacts = status.receipt.artifacts;
              remotePaths = selectArtifactSnapshotRoots(expectedArtifacts);
            } else {
              const expectedArtifactsResult = selectJobArtifacts(
                status.receipt.artifacts,
                requestedPathsResult.value,
              );
              if (!expectedArtifactsResult.ok) {
                return {
                  kind: "validation_error",
                  code: "artifact_not_declared",
                  message: expectedArtifactsResult.error,
                };
              }
              expectedArtifacts = expectedArtifactsResult.value;
              remotePaths = requestedPathsResult.value;
            }
            source = {
              kind: "job",
              jobId: request.source.jobId,
              remoteRoot: path.posix.join(
                this.jobDirectory(request.source.jobId),
                "artifacts",
              ),
              expectedArtifacts,
            };
            break;
          }
        }
        break;
      }
    }

    const queueKey =
      source.kind === "workspace" ? workspace.remotePath : source.remoteRoot;
    return await this.#workspaceQueue.run(queueKey, async () =>
      this.fetchFromWorkspace(
        request,
        workspace,
        source,
        remotePaths,
        destinationResult.value,
      ),
    );
  }

  private async startJobInWorkspace(
    request: RemoteJobStartRequest,
    workspace: WorkspaceLocation,
    workingDirectory: string,
  ): Promise<RemoteJobStartOutcome> {
    const idempotency = createJobIdempotencyDescriptor(
      this.#configuration,
      workspace,
      request,
    );
    if (idempotency !== undefined) {
      const lookupProcess = await this.runSsh(
        buildJobIdempotencyLookupCommand(idempotency.recordPath),
        undefined,
        this.prepareTimeoutMilliseconds(),
        PROCESS_OUTPUT_LIMIT_BYTES,
        request.signal,
      );
      if (
        lookupProcess.kind !== "completed" ||
        lookupProcess.exitCode !== 0
      ) {
        return {
          kind: "idempotency_error",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          message: "The remote idempotency record could not be read.",
          process: toSerializableProcessOutcome(lookupProcess),
        };
      }
      const lookupResult = parseJobIdempotencyLookupProtocol(
        lookupProcess.stdout.text,
      );
      if (!lookupResult.ok) {
        return {
          kind: "idempotency_error",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          message: lookupResult.error,
          process: toSerializableProcessOutcome(lookupProcess),
        };
      }
      if (lookupResult.value.kind === "existing") {
        if (
          lookupResult.value.requestSha256 !== idempotency.requestSha256
        ) {
          return {
            kind: "idempotency_conflict",
            target: this.#configuration.target.destination,
            remoteWorkspace: workspace.remotePath,
            existingJobId: lookupResult.value.jobId,
            message:
              "The idempotency key is already bound to a different job request.",
          };
        }
        return await this.reusedJobStartOutcome(
          lookupResult.value.jobId,
          workspace,
          request.signal,
        );
      }
    }

    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    const receiptBase = createRunReceiptBase(
      jobId,
      this.#configuration.target.destination,
      workspace.localPath,
      workspace.remotePath,
      {
        program: request.program,
        arguments: request.arguments,
        environment: request.environment,
        workingDirectory,
        requirements: request.requirements,
      },
      request.syncMode,
      startedAt,
      request.label,
    );
    const timeoutMilliseconds = request.timeoutSeconds * 1_000;
    let syncDurationMilliseconds = 0;
    const probeProcess = await this.runSsh(
      buildRemoteProbeCommand(this.#configuration.remoteShell),
      undefined,
      this.prepareTimeoutMilliseconds(),
      PROCESS_OUTPUT_LIMIT_BYTES,
      request.signal,
    );
    if (probeProcess.kind !== "completed" || probeProcess.exitCode !== 0) {
      return this.jobStageFailure(
        "probe",
        jobId,
        workspace,
        probeProcess,
        receiptBase,
        {
          kind: "unavailable",
          reason: "The remote hardware probe did not complete.",
        },
        syncDurationMilliseconds,
      );
    }

    const hardwareResult = parseRemoteHardware(probeProcess.stdout.text);
    if (!hardwareResult.ok) {
      return {
        kind: "protocol_error",
        jobId,
        target: this.#configuration.target.destination,
        remoteWorkspace: workspace.remotePath,
        message: hardwareResult.error,
        process: toSerializableProcessOutcome(probeProcess),
        receipt: finishedRunReceipt(
          receiptBase,
          {
            kind: "unavailable",
            reason: "The remote hardware report was invalid.",
          },
          syncDurationMilliseconds,
          { kind: "protocol_error", message: hardwareResult.error },
          capturedReceiptOutput(probeProcess.stdout, probeProcess.stderr),
        ),
      };
    }
    const receiptHardware: ReceiptHardware = {
      kind: "reported",
      value: hardwareResult.value,
    };
    if (request.requirements !== undefined) {
      const requirementFailures = evaluateHardwareRequirements(
        hardwareResult.value,
        request.requirements,
      );
      if (requirementFailures.length > 0) {
        return {
          kind: "requirements_not_met",
          jobId,
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          requirements: request.requirements,
          hardware: hardwareResult.value,
          failures: requirementFailures,
          receipt: finishedRunReceipt(
            receiptBase,
            receiptHardware,
            syncDurationMilliseconds,
            {
              kind: "requirements_not_met",
              failures: requirementFailures,
            },
            {
              kind: "unavailable",
              reason: "The workload did not start because its hardware requirements were not met.",
            },
          ),
        };
      }
    }

    let admissionReserved = false;
    const maximumActiveJobs = this.#configuration.maximumActiveJobs;
    if (maximumActiveJobs !== undefined) {
      const admissionProcess = await this.runSsh(
        buildJobAdmissionCommand(
          this.#configuration.remoteRoot,
          this.jobsRoot(),
          jobId,
          maximumActiveJobs,
          request.timeoutSeconds + 300,
        ),
        undefined,
        Math.max(this.prepareTimeoutMilliseconds(), 20_000),
        PROCESS_OUTPUT_LIMIT_BYTES,
        request.signal,
      );
      if (
        admissionProcess.kind !== "completed" ||
        admissionProcess.exitCode !== 0
      ) {
        return {
          kind: "admission_error",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          message: "The remote job admission check did not complete.",
          process: toSerializableProcessOutcome(admissionProcess),
        };
      }
      const admissionResult = parseJobAdmissionProtocol(
        admissionProcess.stdout.text,
      );
      if (!admissionResult.ok) {
        return {
          kind: "admission_error",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          message: admissionResult.error,
          process: toSerializableProcessOutcome(admissionProcess),
        };
      }
      if (admissionResult.value.kind === "node_busy") {
        return {
          kind: "node_busy",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          maximumActiveJobs,
          activeJobIds: admissionResult.value.activeJobIds,
          activeAdmissionCount:
            admissionResult.value.activeAdmissionCount,
        };
      }
      admissionReserved = true;
    }

    try {
    const activeJobsProcess = await this.runSsh(
      buildActiveJobsCommand(this.jobsRoot(), workspace.id),
      undefined,
      this.prepareTimeoutMilliseconds(),
      PROCESS_OUTPUT_LIMIT_BYTES,
      request.signal,
    );
    if (
      activeJobsProcess.kind !== "completed" ||
      activeJobsProcess.exitCode !== 0
    ) {
      return this.jobStageFailure(
        "job_prepare",
        jobId,
        workspace,
        activeJobsProcess,
        receiptBase,
        receiptHardware,
        syncDurationMilliseconds,
      );
    }
    const activeJobIds = parseActiveJobIdentifiers(
      activeJobsProcess.stdout.text,
    );
    if (activeJobIds.length > 0) {
      return {
        kind: "workspace_busy",
        target: this.#configuration.target.destination,
        remoteWorkspace: workspace.remotePath,
        activeJobIds,
      };
    }

    const remoteShell = hardwareResult.value.shell;
    if (request.syncMode !== "none") {
      const prepareProcess = await this.prepareWorkspace(
        workspace.remotePath,
        request.syncMode === "clean",
        remoteShell,
        request.signal,
      );
      syncDurationMilliseconds += prepareProcess.durationMilliseconds;
      if (prepareProcess.kind !== "completed" || prepareProcess.exitCode !== 0) {
        return this.jobStageFailure(
          "prepare",
          jobId,
          workspace,
          prepareProcess,
          receiptBase,
          receiptHardware,
          syncDurationMilliseconds,
        );
      }

      const syncProcess = await this.syncWorkspace(
        workspace,
        timeoutMilliseconds,
        request.signal,
      );
      syncDurationMilliseconds += syncProcess.durationMilliseconds;
      if (syncProcess.kind !== "completed" || syncProcess.exitCode !== 0) {
        return this.jobStageFailure(
          "sync",
          jobId,
          workspace,
          syncProcess,
          receiptBase,
          receiptHardware,
          syncDurationMilliseconds,
        );
      }
      const syncMetadataProcess = await this.recordWorkspaceTime(
        workspace.id,
        "last-sync-at",
        request.signal,
      );
      if (
        syncMetadataProcess.kind !== "completed" ||
        syncMetadataProcess.exitCode !== 0
      ) {
        return this.jobStageFailure(
          "metadata",
          jobId,
          workspace,
          syncMetadataProcess,
          receiptBase,
          receiptHardware,
          syncDurationMilliseconds,
        );
      }
    }
    const runMetadataProcess = await this.recordWorkspaceTime(
      workspace.id,
      "last-run-at",
      request.signal,
    );
    if (
      runMetadataProcess.kind !== "completed" ||
      runMetadataProcess.exitCode !== 0
    ) {
      return this.jobStageFailure(
        "metadata",
        jobId,
        workspace,
        runMetadataProcess,
        receiptBase,
        receiptHardware,
        syncDurationMilliseconds,
      );
    }


    const jobDirectory = this.jobDirectory(jobId);
    const receipt = activeRunReceipt(
      receiptBase,
      receiptHardware,
      syncDurationMilliseconds,
    );
    const prepareJobProcess = await this.runSsh(
      buildPrepareJobCommand(
        this.jobsRoot(),
        jobDirectory,
        workspace,
        startedAt,
        request.timeoutSeconds,
        idempotency,
      ),
      undefined,
      this.prepareTimeoutMilliseconds(),
      PROCESS_OUTPUT_LIMIT_BYTES,
      request.signal,
    );
    if (
      prepareJobProcess.kind !== "completed" ||
      prepareJobProcess.exitCode !== 0
    ) {
      return this.jobStageFailure(
        "job_prepare",
        jobId,
        workspace,
        prepareJobProcess,
        receiptBase,
        receiptHardware,
        syncDurationMilliseconds,
      );
    }
    const preparationResult = parseJobPreparationProtocol(
      prepareJobProcess.stdout.text,
    );
    if (!preparationResult.ok) {
      return {
        kind: "idempotency_error",
        target: this.#configuration.target.destination,
        remoteWorkspace: workspace.remotePath,
        message: preparationResult.error,
        process: toSerializableProcessOutcome(prepareJobProcess),
      };
    }
    if (preparationResult.value.kind === "existing") {
      if (
        idempotency === undefined ||
        preparationResult.value.requestSha256 !== idempotency.requestSha256
      ) {
        return {
          kind: "idempotency_conflict",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          existingJobId: preparationResult.value.jobId,
          message:
            "The idempotency key is already bound to a different job request.",
        };
      }
      return await this.reusedJobStartOutcome(
        preparationResult.value.jobId,
        workspace,
        request.signal,
      );
    }

    const wrapperScript = buildJobWrapperScript(
      jobDirectory,
      workspace.remotePath,
      workingDirectory,
      request,
      receipt,
    );
    const scriptWriteProcess = await this.writeRemoteFile(
      path.posix.join(jobDirectory, "run.sh"),
      wrapperScript,
      request.signal,
    );
    if (
      scriptWriteProcess.kind !== "completed" ||
      scriptWriteProcess.exitCode !== 0
    ) {
      return this.jobStageFailure(
        "job_prepare",
        jobId,
        workspace,
        scriptWriteProcess,
        receiptBase,
        receiptHardware,
        syncDurationMilliseconds,
      );
    }

    if (request.standardInput !== undefined) {
      const inputWriteProcess = await this.writeRemoteFile(
        path.posix.join(jobDirectory, "stdin"),
        request.standardInput,
        request.signal,
      );
      if (
        inputWriteProcess.kind !== "completed" ||
        inputWriteProcess.exitCode !== 0
      ) {
        return this.jobStageFailure(
          "job_prepare",
          jobId,
          workspace,
          inputWriteProcess,
          receiptBase,
          receiptHardware,
          syncDurationMilliseconds,
        );
      }
    }

    const receiptWriteProcess = await this.writeRemoteFile(
      path.posix.join(jobDirectory, "receipt.json"),
      `${JSON.stringify(receipt)}\n`,
      request.signal,
    );
    if (
      receiptWriteProcess.kind !== "completed" ||
      receiptWriteProcess.exitCode !== 0
    ) {
      return this.jobStageFailure(
        "job_prepare",
        jobId,
        workspace,
        receiptWriteProcess,
        receiptBase,
        receiptHardware,
        syncDurationMilliseconds,
      );
    }

    const startProcess = await this.runSsh(
      buildStartJobCommand(jobDirectory),
      undefined,
      JOB_START_TIMEOUT_MILLISECONDS,
      PROCESS_OUTPUT_LIMIT_BYTES,
      request.signal,
    );
    if (startProcess.kind !== "completed" || startProcess.exitCode !== 0) {
      return this.jobStageFailure(
        "job_start",
        jobId,
        workspace,
        startProcess,
        receiptBase,
        receiptHardware,
        syncDurationMilliseconds,
      );
    }
    const warnings: string[] = [];
    if (hardwareResult.value.isRoot) {
      warnings.push(rootWarning(this.#configuration.target.destination));
    }
    if (idempotency !== undefined) {
      const readyProcess = await this.runSsh(
        buildMarkJobIdempotencyReadyCommand(idempotency, jobId),
        undefined,
        this.prepareTimeoutMilliseconds(),
        PROCESS_OUTPUT_LIMIT_BYTES,
        request.signal,
      );
      if (readyProcess.kind !== "completed" || readyProcess.exitCode !== 0) {
        warnings.push(
          "The job started, but its idempotency record was not finalized.",
        );
      }
    }

    return {
      kind: "started",
      jobId,
      target: this.#configuration.target.destination,
      remoteWorkspace: workspace.remotePath,
      startedAt,
      syncDurationMilliseconds,
      receipt,
      reused: false,
      ...(warnings.length === 0 ? {} : { warning: warnings.join(" ") }),
    };
    } finally {
      if (admissionReserved) {
        await this.runSsh(
          buildReleaseJobAdmissionCommand(
            this.#configuration.remoteRoot,
            jobId,
          ),
          undefined,
          this.prepareTimeoutMilliseconds(),
          PROCESS_OUTPUT_LIMIT_BYTES,
          undefined,
        );
      }
    }
  }

  private async reusedJobStartOutcome(
    jobId: string,
    workspace: WorkspaceLocation,
    signal: AbortSignal | undefined,
  ): Promise<RemoteJobStartOutcome> {
    const status = await this.jobStatus(jobId, signal);
    switch (status.kind) {
      case "starting":
      case "running":
      case "completed":
      case "failed":
      case "cancelled":
      case "lost":
        if (status.remoteWorkspace !== workspace.remotePath) {
          return {
            kind: "idempotency_error",
            target: this.#configuration.target.destination,
            remoteWorkspace: workspace.remotePath,
            message:
              "The idempotency record points to a job in a different workspace.",
            process: emptySerializableProcessOutcome(),
          };
        }
        return {
          kind: "started",
          jobId,
          target: status.target,
          remoteWorkspace: status.remoteWorkspace,
          startedAt: status.startedAt,
          syncDurationMilliseconds: status.receipt.sync.durationMilliseconds,
          receipt: status.receipt,
          reused: true,
        };
      case "job_not_found":
        return {
          kind: "idempotency_error",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          message:
            "The idempotency record points to a job that does not exist.",
          process: emptySerializableProcessOutcome(),
        };
      case "unavailable":
        return {
          kind: "idempotency_error",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          message: "The existing idempotent job could not be read.",
          process: status.process,
        };
      case "protocol_error":
        return {
          kind: "idempotency_error",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          message: status.message,
          process: status.process,
        };
    }
  }

  private async fetchFromWorkspace(
    request: RemoteFetchRequest,
    workspace: WorkspaceLocation,
    source: ArtifactFetchSource,
    remotePaths: readonly string[],
    destination: ArtifactDestination,
  ): Promise<RemoteFetchOutcome> {
    const startedAt = Date.now();
    for (const remotePath of remotePaths) {
      const validationProcess = await this.runSsh(
        buildArtifactValidationCommand(source.remoteRoot, remotePath),
        undefined,
        this.prepareTimeoutMilliseconds(),
        PROCESS_OUTPUT_LIMIT_BYTES,
        request.signal,
      );
      if (
        validationProcess.kind !== "completed" ||
        validationProcess.exitCode !== 0
      ) {
        return {
          kind: "stage_failed",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          stage: "validate",
          process: toSerializableProcessOutcome(validationProcess),
        };
      }

      const validationResult = parseArtifactValidationProtocol(
        validationProcess.stdout.text,
      );
      if (!validationResult.ok) {
        return {
          kind: "validation_error",
          code: "invalid_remote_path",
          message: validationResult.error,
        };
      }
      if (validationResult.value !== "ok") {
        return {
          kind: "artifact_refused",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          path: remotePath,
          reason: validationResult.value,
        };
      }
    }

    mkdirSync(destination.absolutePath, { recursive: true, mode: 0o700 });
    for (const remotePath of remotePaths) {
      const fetchProcess = await this.syncArtifact(
        source.remoteRoot,
        remotePath,
        destination.absolutePath,
        request.timeoutSeconds * 1_000,
        request.signal,
      );
      if (fetchProcess.kind !== "completed" || fetchProcess.exitCode !== 0) {
        if (destination.createdByFetch) {
          rmSync(destination.absolutePath, { recursive: true, force: true });
        }
        return {
          kind: "stage_failed",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          stage: "fetch",
          process: toSerializableProcessOutcome(fetchProcess),
        };
      }
    }

    const artifactResult = await hashFetchedArtifacts(
      workspace.localPath,
      destination.absolutePath,
      remotePaths,
    );
    if (!artifactResult.ok) {
      if (destination.createdByFetch) {
        rmSync(destination.absolutePath, { recursive: true, force: true });
      }
      return {
        kind: "validation_error",
        code: "local_artifact_error",
        message: artifactResult.error,
      };
    }
    if (source.kind === "job") {
      const integrityResult = verifyFetchedArtifactIntegrity(
        destination.relativePath,
        artifactResult.value.files,
        source.expectedArtifacts,
      );
      if (!integrityResult.ok) {
        if (destination.createdByFetch) {
          rmSync(destination.absolutePath, { recursive: true, force: true });
        }
        return {
          kind: "validation_error",
          code: "artifact_integrity_error",
          message: integrityResult.error,
        };
      }
    }

    return {
      kind: "completed",
      target: this.#configuration.target.destination,
      remoteWorkspace: workspace.remotePath,
      ...(source.kind === "job" ? { jobId: source.jobId } : {}),
      localDestination: destination.relativePath,
      files: artifactResult.value.files,
      totalBytes: artifactResult.value.totalBytes,
      durationMilliseconds: Date.now() - startedAt,
    };
  }

  private async writeRemoteFile(
    remotePath: string,
    content: string,
    signal: AbortSignal | undefined,
  ): Promise<ProcessOutcome> {
    const script = `umask 077\ncat > ${quoteForPosixShell(remotePath)}`;
    return await this.runSsh(
      `/bin/sh -c ${quoteForPosixShell(script)}`,
      content,
      this.prepareTimeoutMilliseconds(),
      PROCESS_OUTPUT_LIMIT_BYTES,
      signal,
    );
  }

  private async syncArtifact(
    remoteRoot: string,
    remotePath: string,
    localDestination: string,
    timeoutMilliseconds: number,
    signal: AbortSignal | undefined,
  ): Promise<ProcessOutcome> {
    const remoteShell = this.rsyncRemoteShell();
    const remoteSource = `./${remotePath}`;
    return await runProcess({
      executable: "rsync",
      arguments: [
        "-rlptR",
        "--safe-links",
        "--rsync-path",
        `cd ${quoteForPosixShell(remoteRoot)} && rsync`,
        "-e",
        remoteShell,
        "--",
        `${this.#configuration.target.destination}:${quoteForPosixShell(remoteSource)}`,
        `${localDestination}/`,
      ],
      timeoutMilliseconds,
      outputLimitBytes: SYNC_OUTPUT_LIMIT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private jobStageFailure(
    stage: JobStage,
    jobId: string,
    workspace: WorkspaceLocation,
    processOutcome: ProcessOutcome,
    receiptBase: RunReceiptBase,
    hardware: ReceiptHardware,
    syncDurationMilliseconds: number,
  ): RemoteJobStartOutcome {
    return {
      kind: "stage_failed",
      jobId,
      target: this.#configuration.target.destination,
      remoteWorkspace: workspace.remotePath,
      stage,
      process: toSerializableProcessOutcome(processOutcome),
      receipt: finishedRunReceipt(
        receiptBase,
        hardware,
        syncDurationMilliseconds,
        { kind: "stage_failed", stage },
        capturedReceiptOutput(processOutcome.stdout, processOutcome.stderr),
      ),
    };
  }

  private jobsRoot(): string {
    return path.posix.join(this.#configuration.remoteRoot, ".jobs");
  }

  private workspaceMetadataDirectory(workspaceId: string): string {
    return path.posix.join(
      this.#configuration.remoteRoot,
      ".workspaces",
      workspaceId,
    );
  }

  private async recordWorkspaceTime(
    workspaceId: string,
    fileName: "last-sync-at" | "last-run-at",
    signal: AbortSignal | undefined,
  ): Promise<ProcessOutcome> {
    const metadataDirectory = this.workspaceMetadataDirectory(workspaceId);
    const timestampPath = path.posix.join(metadataDirectory, fileName);
    const script = [
      "umask 077",
      `mkdir -p -- ${quoteForPosixShell(metadataDirectory)}`,
      `date -u '+%Y-%m-%dT%H:%M:%SZ' > ${quoteForPosixShell(`${timestampPath}.tmp`)}`,
      `mv -f -- ${quoteForPosixShell(`${timestampPath}.tmp`)} ${quoteForPosixShell(timestampPath)}`,
    ].join("\n");
    return await this.runSsh(
      `/bin/sh -c ${quoteForPosixShell(script)}`,
      undefined,
      this.prepareTimeoutMilliseconds(),
      PROCESS_OUTPUT_LIMIT_BYTES,
      signal,
    );
  }

  private jobDirectory(jobId: string): string {
    return path.posix.join(this.jobsRoot(), jobId);
  }

  private async runInWorkspace(
    request: RemoteRunRequest,
    workspace: WorkspaceLocation,
    workingDirectory: string,
    receiptBase: RunReceiptBase,
  ): Promise<RemoteRunOutcome> {
    const timeoutMilliseconds = request.timeoutSeconds * 1_000;
    let syncDurationMilliseconds = 0;
    const probeProcess = await this.runSsh(
      buildRemoteProbeCommand(this.#configuration.remoteShell),
      undefined,
      this.prepareTimeoutMilliseconds(),
      PROCESS_OUTPUT_LIMIT_BYTES,
      request.signal,
    );
    if (probeProcess.kind !== "completed" || probeProcess.exitCode !== 0) {
      return this.stageFailure(
        "probe",
        workspace,
        probeProcess,
        receiptBase,
        {
          kind: "unavailable",
          reason: "The remote hardware probe did not complete.",
        },
        syncDurationMilliseconds,
      );
    }

    const hardwareResult = parseRemoteHardware(probeProcess.stdout.text);
    if (!hardwareResult.ok) {
      return {
        kind: "protocol_error",
        target: this.#configuration.target.destination,
        remoteWorkspace: workspace.remotePath,
        message: hardwareResult.error,
        process: toSerializableProcessOutcome(probeProcess),
        receipt: finishedRunReceipt(
          receiptBase,
          {
            kind: "unavailable",
            reason: "The remote hardware report was invalid.",
          },
          syncDurationMilliseconds,
          { kind: "protocol_error", message: hardwareResult.error },
          capturedReceiptOutput(probeProcess.stdout, probeProcess.stderr),
        ),
      };
    }
    const receiptHardware: ReceiptHardware = {
      kind: "reported",
      value: hardwareResult.value,
    };
    if (request.requirements !== undefined) {
      const requirementFailures = evaluateHardwareRequirements(
        hardwareResult.value,
        request.requirements,
      );
      if (requirementFailures.length > 0) {
        return {
          kind: "requirements_not_met",
          target: this.#configuration.target.destination,
          remoteWorkspace: workspace.remotePath,
          requirements: request.requirements,
          hardware: hardwareResult.value,
          failures: requirementFailures,
          receipt: finishedRunReceipt(
            receiptBase,
            receiptHardware,
            syncDurationMilliseconds,
            {
              kind: "requirements_not_met",
              failures: requirementFailures,
            },
            {
              kind: "unavailable",
              reason: "The workload did not start because its hardware requirements were not met.",
            },
          ),
        };
      }
    }

    const remoteShell = hardwareResult.value.shell;
    const activeJobsProcess = await this.runSsh(
      buildActiveJobsCommand(this.jobsRoot(), workspace.id),
      undefined,
      this.prepareTimeoutMilliseconds(),
      PROCESS_OUTPUT_LIMIT_BYTES,
      request.signal,
    );
    if (
      activeJobsProcess.kind !== "completed" ||
      activeJobsProcess.exitCode !== 0
    ) {
      return this.stageFailure(
        "prepare",
        workspace,
        activeJobsProcess,
        receiptBase,
        receiptHardware,
        syncDurationMilliseconds,
      );
    }
    const activeJobIds = parseActiveJobIdentifiers(
      activeJobsProcess.stdout.text,
    );
    if (activeJobIds.length > 0) {
      return {
        kind: "workspace_busy",
        target: this.#configuration.target.destination,
        remoteWorkspace: workspace.remotePath,
        activeJobIds,
      };
    }


    if (request.syncMode !== "none") {
      const prepareProcess = await this.prepareWorkspace(
        workspace.remotePath,
        request.syncMode === "clean",
        remoteShell,
        request.signal,
      );
      syncDurationMilliseconds += prepareProcess.durationMilliseconds;
      if (prepareProcess.kind !== "completed" || prepareProcess.exitCode !== 0) {
        return this.stageFailure(
          "prepare",
          workspace,
          prepareProcess,
          receiptBase,
          receiptHardware,
          syncDurationMilliseconds,
        );
      }

      const syncProcess = await this.syncWorkspace(
        workspace,
        timeoutMilliseconds,
        request.signal,
      );
      syncDurationMilliseconds += syncProcess.durationMilliseconds;
      if (syncProcess.kind !== "completed" || syncProcess.exitCode !== 0) {
        return this.stageFailure(
          "sync",
          workspace,
          syncProcess,
          receiptBase,
          receiptHardware,
          syncDurationMilliseconds,
        );
      }
      const syncMetadataProcess = await this.recordWorkspaceTime(
        workspace.id,
        "last-sync-at",
        request.signal,
      );
      if (
        syncMetadataProcess.kind !== "completed" ||
        syncMetadataProcess.exitCode !== 0
      ) {
        return this.stageFailure(
          "metadata",
          workspace,
          syncMetadataProcess,
          receiptBase,
          receiptHardware,
          syncDurationMilliseconds,
        );
      }
    }
    const runMetadataProcess = await this.recordWorkspaceTime(
      workspace.id,
      "last-run-at",
      request.signal,
    );
    if (
      runMetadataProcess.kind !== "completed" ||
      runMetadataProcess.exitCode !== 0
    ) {
      return this.stageFailure(
        "metadata",
        workspace,
        runMetadataProcess,
        receiptBase,
        receiptHardware,
        syncDurationMilliseconds,
      );
    }


    const marker = `__TAILSCALE_COMPUTE_EXIT_${randomUUID().replaceAll("-", "")}__=`;
    const remoteWorkingDirectory = path.posix.join(
      workspace.remotePath,
      workingDirectory,
    );
    const remoteCommand = buildRemoteProgramCommand(
      remoteWorkingDirectory,
      request.program,
      request.arguments,
      request.environment,
      remoteShell,
      marker,
    );
    const commandProcess = await this.runSsh(
      remoteCommand,
      request.standardInput,
      timeoutMilliseconds,
      PROCESS_OUTPUT_LIMIT_BYTES,
      request.signal,
      `\n${marker}`,
    );

    if (commandProcess.kind !== "completed" || commandProcess.exitCode !== 0) {
      return this.stageFailure(
        "command",
        workspace,
        commandProcess,
        receiptBase,
        receiptHardware,
        syncDurationMilliseconds,
      );
    }

    const commandResult = extractRemoteCommandResult(
      commandProcess.stderr,
      marker,
      commandProcess.stderrPrefixDigest,
    );
    if (!commandResult.ok) {
      return {
        kind: "protocol_error",
        target: this.#configuration.target.destination,
        remoteWorkspace: workspace.remotePath,
        message: commandResult.error,
        process: toSerializableProcessOutcome(commandProcess),
        receipt: finishedRunReceipt(
          receiptBase,
          receiptHardware,
          syncDurationMilliseconds,
          { kind: "protocol_error", message: commandResult.error },
          capturedReceiptOutput(commandProcess.stdout, commandProcess.stderr),
        ),
      };
    }

    return {
      kind: "completed",
      target: this.#configuration.target.destination,
      remoteWorkspace: workspace.remotePath,
      exitCode: commandResult.value.exitCode,
      stdout: commandProcess.stdout,
      stderr: commandResult.value.stderr,
      syncDurationMilliseconds,
      commandDurationMilliseconds: commandProcess.durationMilliseconds,
      receipt: finishedRunReceipt(
        receiptBase,
        receiptHardware,
        syncDurationMilliseconds,
        commandResult.value.exitCode === 0
          ? { kind: "completed", exitCode: 0 }
          : { kind: "failed", exitCode: commandResult.value.exitCode },
        capturedReceiptOutput(commandProcess.stdout, commandResult.value.stderr),
      ),
      ...(hardwareResult.value.isRoot
        ? { warning: rootWarning(this.#configuration.target.destination) }
        : {}),
    };
  }

  private async prepareWorkspace(
    remoteWorkspace: string,
    clean: boolean,
    shell: RemoteShellPath,
    signal: AbortSignal | undefined,
  ): Promise<ProcessOutcome> {
    const script = clean
      ? `rm -rf -- ${quoteForPosixShell(remoteWorkspace)} && mkdir -p -- ${quoteForPosixShell(remoteWorkspace)}`
      : `mkdir -p -- ${quoteForPosixShell(remoteWorkspace)}`;
    return await this.runSsh(
      wrapInRemoteLoginShell(script, shell),
      undefined,
      this.prepareTimeoutMilliseconds(),
      SYNC_OUTPUT_LIMIT_BYTES,
      signal,
    );
  }

  private async syncWorkspace(
    workspace: WorkspaceLocation,
    timeoutMilliseconds: number,
    signal: AbortSignal | undefined,
  ): Promise<ProcessOutcome> {
    const filterArguments = buildSyncFilterArguments(workspace.localPath);
    const remoteShell = this.rsyncRemoteShell();

    return await runProcess({
      executable: "rsync",
      arguments: [
        "-rlpt",
        "--delete",
        ...filterArguments,
        "-e",
        remoteShell,
        "--",
        `${workspace.localPath}/`,
        `${this.#configuration.target.destination}:${workspace.remotePath}/`,
      ],
      timeoutMilliseconds,
      outputLimitBytes: SYNC_OUTPUT_LIMIT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private rsyncRemoteShell(): string {
    return [
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `ConnectTimeout=${this.#configuration.connectTimeoutSeconds}`,
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "ClearAllForwardings=yes",
    ].join(" ");
  }

  private async runSsh(
    remoteCommand: string,
    standardInput: string | undefined,
    timeoutMilliseconds: number,
    outputLimitBytes: number,
    signal: AbortSignal | undefined,
    stderrDigestBoundary?: string,
  ): Promise<ProcessOutcome> {
    return await runProcess({
      executable: "ssh",
      arguments: [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `ConnectTimeout=${this.#configuration.connectTimeoutSeconds}`,
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "ClearAllForwardings=yes",
        "--",
        this.#configuration.target.destination,
        remoteCommand,
      ],
      timeoutMilliseconds,
      outputLimitBytes,
      ...(standardInput === undefined ? {} : { standardInput }),
      ...(stderrDigestBoundary === undefined
        ? {}
        : { stderrDigestBoundary }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private resolveWorkspace(
    workspacePath: string | undefined,
  ): Result<WorkspaceLocation, WorkspaceError> {
    const requestedWorkspace =
      workspacePath ?? this.#configuration.defaultWorkspace ?? process.cwd();
    if (!path.isAbsolute(requestedWorkspace)) {
      return failure({
        code: "workspace_not_absolute",
        message: `The workspace path '${requestedWorkspace}' is not absolute.`,
      });
    }

    let localPath: string;
    try {
      localPath = realpathSync(requestedWorkspace);
      if (!statSync(localPath).isDirectory()) {
        return failure({
          code: "workspace_not_directory",
          message: `The workspace path '${requestedWorkspace}' is not a directory.`,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return failure({
        code: "workspace_not_directory",
        message: `The workspace path '${requestedWorkspace}' is not available: ${message}`,
      });
    }

    if (path.parse(localPath).root === localPath) {
      return failure({
        code: "workspace_is_root",
        message: "The file system root cannot be a compute workspace.",
      });
    }

    const baseName = path.basename(localPath);
    const normalizedBaseName = baseName
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAXIMUM_WORKSPACE_SLUG_LENGTH);
    const workspaceName =
      normalizedBaseName.length === 0 ? "workspace" : normalizedBaseName;
    const workspaceHash = createHash("sha256")
      .update(localPath)
      .digest("hex")
      .slice(0, 12);
    const workspaceId = `${workspaceName}-${workspaceHash}`;
    const remotePath = path.posix.join(
      this.#configuration.remoteRoot,
      workspaceId,
    );

    return success({ id: workspaceId, localPath, remotePath });
  }

  private stageFailure(
    stage: RunStage,
    workspace: WorkspaceLocation,
    processOutcome: ProcessOutcome,
    receiptBase: RunReceiptBase,
    hardware: ReceiptHardware,
    syncDurationMilliseconds: number,
  ): RemoteRunOutcome {
    return {
      kind: "stage_failed",
      target: this.#configuration.target.destination,
      remoteWorkspace: workspace.remotePath,
      stage,
      process: toSerializableProcessOutcome(processOutcome),
      receipt: finishedRunReceipt(
        receiptBase,
        hardware,
        syncDurationMilliseconds,
        { kind: "stage_failed", stage },
        capturedReceiptOutput(processOutcome.stdout, processOutcome.stderr),
      ),
    };
  }

  private prepareTimeoutMilliseconds(): number {
    return Math.max(
      MINIMUM_PREPARE_TIMEOUT_MILLISECONDS,
      (this.#configuration.connectTimeoutSeconds + 5) * 1_000,
    );
  }
}

function buildActiveJobsCommand(
  jobsRoot: string,
  workspaceId: string | undefined,
): string {
  const workspaceFilter =
    workspaceId === undefined
      ? []
      : [
          `[ "$(cat "$job_dir/workspace-id" 2>/dev/null)" = ${quoteForPosixShell(workspaceId)} ] || continue`,
        ];
  const script = [
    `jobs_root=${quoteForPosixShell(jobsRoot)}`,
    `[ -d "$jobs_root" ] || exit 0`,
    `for job_dir in "$jobs_root"/*; do`,
    `  [ -d "$job_dir" ] || continue`,
    `  [ -L "$job_dir" ] && continue`,
    ...workspaceFilter.map((command) => `  ${command}`),
    `  state=$(cat "$job_dir/state" 2>/dev/null || true)`,
    `  case "$state" in`,
    `    starting)`,
    `      launcher_pid=$(cat "$job_dir/launcher-pid" 2>/dev/null || true)`,
    `      case "$launcher_pid" in ''|*[!0-9]*) continue ;; esac`,
    `      kill -0 "$launcher_pid" 2>/dev/null || continue`,
    `      ;;`,
    `    running)`,
    `      process_group_id=$(cat "$job_dir/process-group-id" 2>/dev/null || true)`,
    `      case "$process_group_id" in ''|*[!0-9]*) continue ;; esac`,
    `      if ! kill -0 -- "-$process_group_id" 2>/dev/null; then`,
    `        launcher_pid=$(cat "$job_dir/launcher-pid" 2>/dev/null || true)`,
    `        case "$launcher_pid" in ''|*[!0-9]*) continue ;; esac`,
    `        kill -0 "$launcher_pid" 2>/dev/null || continue`,
    `      fi`,
    `      ;;`,
    `    *) continue ;;`,
    `  esac`,
    `  job_id=${"${job_dir##*/}"}`,
    `  case "$job_id" in ????????-????-4???-[89ab]???-????????????) ;; *) continue ;; esac`,
    `  case "$job_id" in *[!0-9a-f-]*) continue ;; esac`,
    `  printf '%s\\n' "$job_id"`,
    `done`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

export function buildJobAdmissionCommand(
  remoteRoot: string,
  jobsRoot: string,
  jobId: string,
  maximumActiveJobs: number,
  leaseSeconds: number,
): string {
  const admissionsRoot = path.posix.join(remoteRoot, ".admissions");
  const lockDirectory = path.posix.join(admissionsRoot, ".lock");
  const reservationPath = path.posix.join(admissionsRoot, jobId);
  const activeJobsCommand = buildActiveJobsCommand(jobsRoot, undefined);
  const script = [
    "umask 077",
    "set -e",
    `jobs_root=${quoteForPosixShell(jobsRoot)}`,
    `admissions_root=${quoteForPosixShell(admissionsRoot)}`,
    `lock_directory=${quoteForPosixShell(lockDirectory)}`,
    `reservation_path=${quoteForPosixShell(reservationPath)}`,
    `maximum_active_jobs=${String(maximumActiveJobs)}`,
    `lease_seconds=${String(leaseSeconds)}`,
    `mkdir -p -- "$jobs_root" "$admissions_root"`,
    `attempt=0`,
    `while ! mkdir -- "$lock_directory" 2>/dev/null; do`,
    `  owner_pid=$(cat "$lock_directory/owner-pid" 2>/dev/null || true)`,
    `  case "$owner_pid" in`,
    `    ''|*[!0-9]*) if [ "$attempt" -ge 5 ]; then rm -rf -- "$lock_directory"; fi ;;`,
    `    *) kill -0 "$owner_pid" 2>/dev/null || rm -rf -- "$lock_directory" ;;`,
    `  esac`,
    `  attempt=$((attempt + 1))`,
    `  [ "$attempt" -lt 15 ] || exit 75`,
    `  sleep 1`,
    `done`,
    `printf '%s\\n' "$$" > "$lock_directory/owner-pid"`,
    `trap 'rm -rf -- "$lock_directory"' EXIT HUP INT TERM`,
    `now=$(date +%s)`,
    `active_jobs_path="$lock_directory/active-jobs"`,
    `${activeJobsCommand} > "$active_jobs_path"`,
    `active_job_count=$(wc -l < "$active_jobs_path" | tr -d '[:space:]')`,
    `active_admission_count=0`,
    `for admission_path in "$admissions_root"/*; do`,
    `  [ -d "$admission_path" ] || continue`,
    `  [ -L "$admission_path" ] && continue`,
    `  admission_job_id=${"${admission_path##*/}"}`,
    `  case "$admission_job_id" in ????????-????-4???-[89ab]???-????????????) ;; *) rm -rf -- "$admission_path"; continue ;; esac`,
    `  case "$admission_job_id" in *[!0-9a-f-]*) rm -rf -- "$admission_path"; continue ;; esac`,
    `  admission_is_active=false`,
    `  while read -r active_job_id; do`,
    `    if [ "$active_job_id" = "$admission_job_id" ]; then admission_is_active=true; break; fi`,
    `  done < "$active_jobs_path"`,
    `  if [ "$admission_is_active" = true ]; then rm -rf -- "$admission_path"; continue; fi`,
    `  expires_at=$(cat "$admission_path/expires-at" 2>/dev/null || true)`,
    `  case "$expires_at" in ''|*[!0-9]*) rm -rf -- "$admission_path"; continue ;; esac`,
    `  if [ "$expires_at" -le "$now" ]; then rm -rf -- "$admission_path"; continue; fi`,
    `  active_admission_count=$((active_admission_count + 1))`,
    `done`,
    `if [ "$((active_job_count + active_admission_count))" -ge "$maximum_active_jobs" ]; then`,
    `  printf 'kind=node_busy\\n'`,
    `  printf 'activeAdmissionCount=%s\\n' "$active_admission_count"`,
    `  while read -r active_job_id; do [ -n "$active_job_id" ] && printf 'activeJobId=%s\\n' "$active_job_id"; done < "$active_jobs_path"`,
    `  exit 0`,
    `fi`,
    `mkdir -- "$reservation_path"`,
    `printf '%s\\n' "$((now + lease_seconds))" > "$reservation_path/expires-at"`,
    `printf 'kind=admitted\\n'`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

function buildReleaseJobAdmissionCommand(
  remoteRoot: string,
  jobId: string,
): string {
  const reservationPath = path.posix.join(
    remoteRoot,
    ".admissions",
    jobId,
  );
  return `/bin/sh -c ${quoteForPosixShell(`rm -rf -- ${quoteForPosixShell(reservationPath)}`)}`;
}

export function parseJobAdmissionProtocol(
  output: string,
): Result<JobAdmissionProtocol, string> {
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 1 && lines[0] === "kind=admitted") {
    return success({ kind: "admitted" });
  }
  if (
    lines.length < 2 ||
    lines[0] !== "kind=node_busy" ||
    !lines[1]?.startsWith("activeAdmissionCount=")
  ) {
    return failure(`The job admission protocol is invalid. Raw output:\n${output}`);
  }
  const activeAdmissionCount = Number(
    lines[1].slice("activeAdmissionCount=".length),
  );
  if (
    !Number.isSafeInteger(activeAdmissionCount) ||
    activeAdmissionCount < 0
  ) {
    return failure(`The job admission protocol is invalid. Raw output:\n${output}`);
  }
  const activeJobIds: string[] = [];
  const seenJobIds = new Set<string>();
  for (const line of lines.slice(2)) {
    if (!line.startsWith("activeJobId=")) {
      return failure(`The job admission protocol is invalid. Raw output:\n${output}`);
    }
    const activeJobId = line.slice("activeJobId=".length);
    if (
      !JOB_IDENTIFIER_PATTERN.test(activeJobId) ||
      seenJobIds.has(activeJobId)
    ) {
      return failure(`The job admission protocol is invalid. Raw output:\n${output}`);
    }
    seenJobIds.add(activeJobId);
    activeJobIds.push(activeJobId);
  }
  return success({
    kind: "node_busy",
    activeJobIds: Object.freeze(activeJobIds),
    activeAdmissionCount,
  });
}

type ParsedWorkspaceStatus =
  | { readonly kind: "workspace_not_found" }
  | {
      readonly kind: "completed";
      readonly totalBytes: number;
      readonly lastSyncAt: WorkspaceRecordedTime;
      readonly lastRunAt: WorkspaceRecordedTime;
    };

function buildWorkspaceStatusCommand(
  remoteWorkspace: string,
  metadataDirectory: string,
): string {
  const script = [
    `workspace=${quoteForPosixShell(remoteWorkspace)}`,
    `metadata_directory=${quoteForPosixShell(metadataDirectory)}`,
    `[ -d "$workspace" ] || { printf 'kind=workspace_not_found\\n'; exit 0; }`,
    `total_kib=$(du -sk "$workspace" 2>/dev/null | awk '{print $1}')`,
    `case "$total_kib" in ''|*[!0-9]*) exit 72 ;; esac`,
    `total_bytes=$((total_kib * 1024))`,
    `last_sync_at=$(cat "$metadata_directory/last-sync-at" 2>/dev/null || true)`,
    `last_run_at=$(cat "$metadata_directory/last-run-at" 2>/dev/null || true)`,
    `printf 'kind=completed\\n'`,
    `printf 'totalBytes=%s\\n' "$total_bytes"`,
    `printf 'lastSyncAt=%s\\n' "$last_sync_at"`,
    `printf 'lastRunAt=%s\\n' "$last_run_at"`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

export function parseWorkspaceStatusProtocol(
  output: string,
): Result<ParsedWorkspaceStatus, string> {
  const values = parseProtocolValues(output);
  const kind = values["kind"];
  if (kind === "workspace_not_found") {
    return success({ kind });
  }
  if (kind !== "completed") {
    return failure(`The workspace status protocol is invalid. Raw output:\n${output}`);
  }
  const totalBytes = Number(values["totalBytes"]);
  const lastSyncResult = parseWorkspaceRecordedTime(values["lastSyncAt"]);
  const lastRunResult = parseWorkspaceRecordedTime(values["lastRunAt"]);
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    !lastSyncResult.ok ||
    !lastRunResult.ok
  ) {
    return failure(`The workspace status protocol is invalid. Raw output:\n${output}`);
  }
  return success({
    kind,
    totalBytes,
    lastSyncAt: lastSyncResult.value,
    lastRunAt: lastRunResult.value,
  });
}

function parseWorkspaceRecordedTime(
  value: string | undefined,
): Result<WorkspaceRecordedTime, string> {
  if (value === undefined || value.length === 0) {
    return success({ kind: "never" });
  }
  if (!isIsoTimestamp(value)) {
    return failure("The workspace timestamp is invalid.");
  }
  return success({ kind: "recorded", value });
}

function buildDeleteWorkspaceCommand(
  remoteRoot: string,
  remoteWorkspace: string,
  metadataDirectory: string,
): string {
  const script = [
    `remote_root=${quoteForPosixShell(remoteRoot)}`,
    `workspace=${quoteForPosixShell(remoteWorkspace)}`,
    `metadata_directory=${quoteForPosixShell(metadataDirectory)}`,
    `case "$workspace" in "$remote_root"/*) ;; *) exit 73 ;; esac`,
    `[ "$workspace" != "$remote_root" ] || exit 73`,
    `if [ -e "$workspace" ] || [ -L "$workspace" ]; then existed=true; else existed=false; fi`,
    `rm -rf -- "$workspace"`,
    `rm -rf -- "$metadata_directory"`,
    `printf 'kind=deleted\\nexisted=%s\\n' "$existed"`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

export function parseWorkspaceDeleteProtocol(
  output: string,
): Result<boolean, string> {
  const values = parseProtocolValues(output);
  if (values["kind"] !== "deleted") {
    return failure(`The workspace delete protocol is invalid. Raw output:\n${output}`);
  }
  switch (values["existed"]) {
    case "true":
      return success(true);
    case "false":
      return success(false);
    case undefined:
    default:
      return failure(`The workspace delete protocol is invalid. Raw output:\n${output}`);
  }
}

function buildJobIdempotencyLookupCommand(recordPath: string): string {
  const readyPath = path.posix.join(recordPath, "ready");
  const jobIdPath = path.posix.join(recordPath, "job-id");
  const requestPath = path.posix.join(recordPath, "request-sha256");
  const script = [
    `record=${quoteForPosixShell(recordPath)}`,
    `[ -d "$record" ] || { printf 'kind=missing\\n'; exit 0; }`,
    `attempt=0`,
    `while [ ! -f ${quoteForPosixShell(readyPath)} ] && [ "$attempt" -lt 30 ]; do`,
    `  attempt=$((attempt + 1))`,
    `  sleep 1`,
    `done`,
    `printf 'kind=existing\\n'`,
    `printf 'jobId=%s\\n' "$(cat ${quoteForPosixShell(jobIdPath)} 2>/dev/null || true)"`,
    `printf 'requestSha256=%s\\n' "$(cat ${quoteForPosixShell(requestPath)} 2>/dev/null || true)"`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

function buildMarkJobIdempotencyReadyCommand(
  descriptor: JobIdempotencyDescriptor,
  jobId: string,
): string {
  const jobIdPath = path.posix.join(descriptor.recordPath, "job-id");
  const requestPath = path.posix.join(
    descriptor.recordPath,
    "request-sha256",
  );
  const readyPath = path.posix.join(descriptor.recordPath, "ready");
  const script = [
    "set -e",
    `[ "$(cat ${quoteForPosixShell(jobIdPath)})" = ${quoteForPosixShell(jobId)} ]`,
    `[ "$(cat ${quoteForPosixShell(requestPath)})" = ${quoteForPosixShell(descriptor.requestSha256)} ]`,
    `: > ${quoteForPosixShell(`${readyPath}.tmp`)}`,
    `mv -f -- ${quoteForPosixShell(`${readyPath}.tmp`)} ${quoteForPosixShell(readyPath)}`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

export function parseJobIdempotencyLookupProtocol(
  output: string,
): Result<JobIdempotencyLookup, string> {
  const values = parseProtocolValues(output);
  switch (values["kind"]) {
    case "missing":
      return success({ kind: "missing" });
    case "existing": {
      const jobId = values["jobId"];
      const requestSha256 = values["requestSha256"];
      if (
        jobId === undefined ||
        !JOB_IDENTIFIER_PATTERN.test(jobId) ||
        requestSha256 === undefined ||
        !/^[0-9a-f]{64}$/.test(requestSha256)
      ) {
        return failure(
          `The idempotency record is invalid. Raw output:\n${output}`,
        );
      }
      return success({ kind: "existing", jobId, requestSha256 });
    }
    case undefined:
    default:
      return failure(
        `The idempotency lookup protocol is invalid. Raw output:\n${output}`,
      );
  }
}

export function parseJobPreparationProtocol(
  output: string,
): Result<JobPreparationProtocol, string> {
  const values = parseProtocolValues(output);
  switch (values["kind"]) {
    case "created":
      return success({ kind: "created" });
    case "existing": {
      const jobId = values["jobId"];
      const requestSha256 = values["requestSha256"];
      if (
        jobId === undefined ||
        !JOB_IDENTIFIER_PATTERN.test(jobId) ||
        requestSha256 === undefined ||
        !/^[0-9a-f]{64}$/.test(requestSha256)
      ) {
        return failure(
          `The job preparation record is invalid. Raw output:\n${output}`,
        );
      }
      return success({ kind: "existing", jobId, requestSha256 });
    }
    case undefined:
    default:
      return failure(
        `The job preparation protocol is invalid. Raw output:\n${output}`,
      );
  }
}

function buildPrepareJobCommand(
  jobsRoot: string,
  jobDirectory: string,
  workspace: WorkspaceLocation,
  startedAt: string,
  timeoutSeconds: number,
  idempotency: JobIdempotencyDescriptor | undefined,
): string {
  const metadataCommands = [
    `mkdir -- ${quoteForPosixShell(jobDirectory)}`,
    `printf '%s\\n' starting > ${quoteForPosixShell(path.posix.join(jobDirectory, "state"))}`,
    `printf '%s\\n' ${quoteForPosixShell(workspace.id)} > ${quoteForPosixShell(path.posix.join(jobDirectory, "workspace-id"))}`,
    `printf '%s\\n' ${quoteForPosixShell(workspace.remotePath)} > ${quoteForPosixShell(path.posix.join(jobDirectory, "remote-workspace"))}`,
    `printf '%s\\n' ${quoteForPosixShell(startedAt)} > ${quoteForPosixShell(path.posix.join(jobDirectory, "started-at"))}`,
    `printf '%s\\n' ${quoteForPosixShell(String(timeoutSeconds))} > ${quoteForPosixShell(path.posix.join(jobDirectory, "timeout-seconds"))}`,
  ];
  if (idempotency === undefined) {
    const script = [
      "umask 077",
      "set -e",
      `mkdir -p -- ${quoteForPosixShell(jobsRoot)}`,
      ...metadataCommands,
      `printf 'kind=created\\n'`,
    ].join("\n");
    return `/bin/sh -c ${quoteForPosixShell(script)}`;
  }

  const recordParent = path.posix.dirname(idempotency.recordPath);
  const requestPath = path.posix.join(
    idempotency.recordPath,
    "request-sha256",
  );
  const jobIdPath = path.posix.join(idempotency.recordPath, "job-id");
  const readyPath = path.posix.join(idempotency.recordPath, "ready");
  const jobId = path.posix.basename(jobDirectory);
  const script = [
    "umask 077",
    "set -e",
    `record=${quoteForPosixShell(idempotency.recordPath)}`,
    `ready=${quoteForPosixShell(readyPath)}`,
    `mkdir -p -- ${quoteForPosixShell(jobsRoot)} ${quoteForPosixShell(recordParent)}`,
    `if mkdir -- "$record" 2>/dev/null; then`,
    `  cleanup_record=true`,
    `  trap 'if [ "$cleanup_record" = true ]; then rm -rf -- "$record"; fi' EXIT HUP INT TERM`,
    `  printf '%s\\n' ${quoteForPosixShell(idempotency.requestSha256)} > ${quoteForPosixShell(requestPath)}`,
    `  printf '%s\\n' ${quoteForPosixShell(jobId)} > ${quoteForPosixShell(jobIdPath)}`,
    ...metadataCommands.map((command) => `  ${command}`),
    `  printf '%s\\n' ${quoteForPosixShell(path.posix.basename(idempotency.recordPath))} > ${quoteForPosixShell(path.posix.join(jobDirectory, "idempotency-digest"))}`,
    `  cleanup_record=false`,
    `  trap - EXIT HUP INT TERM`,
    `  printf 'kind=created\\n'`,
    `else`,
    `  attempt=0`,
    `  while [ ! -f "$ready" ] && [ "$attempt" -lt 30 ]; do`,
    `    attempt=$((attempt + 1))`,
    `    sleep 1`,
    `  done`,
    `  printf 'kind=existing\\n'`,
    `  printf 'jobId=%s\\n' "$(cat ${quoteForPosixShell(jobIdPath)} 2>/dev/null || true)"`,
    `  printf 'requestSha256=%s\\n' "$(cat ${quoteForPosixShell(requestPath)} 2>/dev/null || true)"`,
    `fi`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

function buildArtifactSnapshotCopyCommands(
  artifactPaths: readonly string[],
): readonly string[] {
  return artifactPaths.flatMap((artifactPath) => {
    const sourceExpression = `"$remote_workspace"/${quoteForPosixShell(artifactPath)}`;
    const destinationExpression = `"$artifact_snapshot_temporary_path"/${quoteForPosixShell(artifactPath)}`;
    const symbolicLinkChecks: string[] = [];
    let currentPath = "";
    for (const component of artifactPath.split("/")) {
      currentPath =
        currentPath.length === 0
          ? component
          : path.posix.join(currentPath, component);
      symbolicLinkChecks.push(
        `[ -L "$remote_workspace"/${quoteForPosixShell(currentPath)} ]`,
      );
    }
    return [
      `if [ "$artifact_snapshot_failed" = false ]; then`,
      `  artifact_source=${sourceExpression}`,
      `  artifact_destination=${destinationExpression}`,
      `  if [ ! -e "$artifact_source" ]; then`,
      `    record_artifact_error ${quoteForPosixShell(`The declared artifact '${artifactPath}' does not exist.`)}`,
      `  elif [ ! -f "$artifact_source" ] && [ ! -d "$artifact_source" ]; then`,
      `    record_artifact_error ${quoteForPosixShell(`The declared artifact '${artifactPath}' is not a regular file or directory.`)}`,
      `  elif ${symbolicLinkChecks.join(" || ")}; then`,
      `    record_artifact_error ${quoteForPosixShell(`The declared artifact '${artifactPath}' uses a symbolic link.`)}`,
      `  elif [ -d "$artifact_source" ] && [ -n "$(find "$artifact_source" -type l -print -quit 2>/dev/null)" ]; then`,
      `    record_artifact_error ${quoteForPosixShell(`The declared artifact '${artifactPath}' contains a symbolic link.`)}`,
      `  elif ! mkdir -p -- "$(dirname "$artifact_destination")"; then`,
      `    record_artifact_error ${quoteForPosixShell(`The snapshot directory for artifact '${artifactPath}' could not be created.`)}`,
      `  elif ! cp -R -P -- "$artifact_source" "$artifact_destination"; then`,
      `    record_artifact_error ${quoteForPosixShell(`The declared artifact '${artifactPath}' could not be copied.`)}`,
      `  elif [ -n "$(find "$artifact_destination" -type l -print -quit 2>/dev/null)" ]; then`,
      `    record_artifact_error ${quoteForPosixShell(`The declared artifact '${artifactPath}' produced a symbolic link in its snapshot.`)}`,
      `  fi`,
      `fi`,
    ];
  });
}

function terminalRunReceiptPrefix(receipt: ActiveRunReceipt): string {
  if (receipt.artifacts.length !== 0) {
    throw new Error("An active run receipt cannot contain artifacts.");
  }
  const common = {
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
  };
  return JSON.stringify(common).slice(0, -1);
}

export function buildJobWrapperScript(
  jobDirectory: string,
  remoteWorkspace: string,
  workingDirectory: string,
  request: RemoteCommandRequest & {
    readonly artifactPaths: readonly string[];
  },
  receipt: ActiveRunReceipt,
): string {
  const artifactPathJsonEncoderScript = String.raw`BEGIN { printf "\"" }
{
  for (field_index = 1; field_index <= NF; field_index += 1) {
    byte = $field_index + 0
    if (byte == 8) { printf "\\b" }
    else if (byte == 9) { printf "\\t" }
    else if (byte == 10) { printf "\\n" }
    else if (byte == 12) { printf "\\f" }
    else if (byte == 13) { printf "\\r" }
    else if (byte == 34) { printf "\\\"" }
    else if (byte == 92) { printf "\\\\" }
    else if (byte < 32) { printf "\\u%04x", byte }
    else { printf "%c", byte }
  }
}
END { printf "\"" }`;
  const artifactManifestWorkerScript = [
    "set -e",
    "artifact_root=$1",
    "manifest_output_path=$2",
    "receipt_output_path=$3",
    "shift 3",
    "for artifact_file do",
    '  relative_path=${artifact_file#"$artifact_root"/}',
    `  size_bytes=$(wc -c < "$artifact_file" | tr -d '[:space:]')`,
    `  if command -v sha256sum >/dev/null 2>&1; then`,
    `    hash_output=$(sha256sum "$artifact_file")`,
    `  elif command -v shasum >/dev/null 2>&1; then`,
    `    hash_output=$(shasum -a 256 "$artifact_file")`,
    `  else`,
    `    exit 69`,
    `  fi`,
    "  artifact_sha256=${hash_output%% *}",
    "  artifact_sha256=${artifact_sha256#\\\\}",
    `  encoded_path=$(printf '%s' "$relative_path" | base64 | tr -d '\\r\\n')`,
    `  json_path=$(printf '%s' "$relative_path" | od -An -tu1 | LC_ALL=C awk ${quoteForPosixShell(artifactPathJsonEncoderScript)})`,
    `  printf '%s\\t%s\\t%s\\n' "$encoded_path" "$size_bytes" "$artifact_sha256" >> "$manifest_output_path"`,
    `  printf '%s\\t{"path":%s,"sizeBytes":%s,"sha256":"%s"}\\n' "$encoded_path" "$json_path" "$size_bytes" "$artifact_sha256" >> "$receipt_output_path"`,
    "done",
  ].join("\n");
  const artifactSnapshotCopyCommands = buildArtifactSnapshotCopyCommands(
    request.artifactPaths,
  );
  const artifactSnapshotFinalizationCommands =
    request.artifactPaths.length === 0
      ? [
          `rm -rf -- "$artifact_snapshot_path" "$artifact_snapshot_temporary_path"`,
          `mkdir -p -- "$artifact_snapshot_path" 2>/dev/null || true`,
          `: > "$artifact_manifest_path" 2>/dev/null || true`,
          `printf '[]\\n' > "$artifact_receipt_path"`,
        ]
      : [
          `artifact_snapshot_failed=false`,
          `rm -rf -- "$artifact_snapshot_path" "$artifact_snapshot_temporary_path"`,
          `if ! mkdir -p -- "$artifact_snapshot_temporary_path"; then`,
          `  record_artifact_error 'The artifact snapshot directory could not be created.'`,
          `fi`,
          ...artifactSnapshotCopyCommands,
          `if [ "$artifact_snapshot_failed" = false ] && ! mv -- "$artifact_snapshot_temporary_path" "$artifact_snapshot_path"; then`,
          `  record_artifact_error 'The artifact snapshot could not be finalized.'`,
          `fi`,
          `if [ "$artifact_snapshot_failed" = false ] && ! write_artifact_manifest; then`,
          `  record_artifact_error 'The artifact manifest could not be written.'`,
          `fi`,
          `if [ "$artifact_snapshot_failed" = true ]; then`,
          `  rm -rf -- "$artifact_snapshot_path" "$artifact_snapshot_temporary_path"`,
          `  rm -f -- "$artifact_manifest_unsorted_path" "$artifact_receipt_unsorted_path" "$artifact_receipt_sorted_path"`,
          `  : > "$artifact_manifest_path"`,
          `  printf '[]\\n' > "$artifact_receipt_path"`,
          `  if [ "$exit_code" -eq 0 ]; then exit_code=74; fi`,
          `fi`,
        ];
  const environmentAssignments = Object.entries(request.environment)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => quoteForPosixShell(`${key}=${value}`));
  const command = [
    "/usr/bin/env",
    ...environmentAssignments,
    quoteForPosixShell(request.program),
    ...request.arguments.map(quoteForPosixShell),
  ].join(" ");

  return [
    "#!/bin/sh",
    "set -u",
    `raw_job_directory=${quoteForPosixShell(jobDirectory)}`,
    `case "$raw_job_directory" in`,
    `  /*) job_directory=$raw_job_directory ;;`,
    `  *) job_directory=$HOME/$raw_job_directory ;;`,
    `esac`,
    `raw_remote_workspace=${quoteForPosixShell(remoteWorkspace)}`,
    `case "$raw_remote_workspace" in`,
    `  /*) remote_workspace=$raw_remote_workspace ;;`,
    `  *) remote_workspace=$HOME/$raw_remote_workspace ;;`,
    `esac`,
    `state_path="$job_directory/state"`,
    `terminal_state_path="$job_directory/terminal-state"`,
    `receipt_finalization_failed_path="$job_directory/receipt-finalization-failed"`,
    `input_path="$job_directory/stdin"`,
    `run_script_path="$job_directory/run.sh"`,
    `stdout_path="$job_directory/stdout"`,
    `stderr_path="$job_directory/stderr"`,
    `process_group_path="$job_directory/process-group-id"`,
    `exit_code_path="$job_directory/exit-code"`,
    `finished_at_path="$job_directory/finished-at"`,
    `cancel_requested_path="$job_directory/cancel-requested"`,
    `timed_out_path="$job_directory/timed-out"`,
    `oom_killed_path="$job_directory/oom-kill-count"`,
    `artifact_snapshot_path="$job_directory/artifacts"`,
    `artifact_snapshot_temporary_path="$job_directory/artifacts.tmp"`,
    `artifact_manifest_path="$job_directory/artifacts.manifest"`,
    `artifact_manifest_unsorted_path="$job_directory/artifacts.manifest.unsorted"`,
    `artifact_receipt_path="$job_directory/artifacts.json"`,
    `artifact_receipt_unsorted_path="$job_directory/artifacts.json.unsorted"`,
    `artifact_receipt_sorted_path="$job_directory/artifacts.json.sorted"`,
    `receipt_path="$job_directory/receipt.json"`,
    `receipt_prefix=${quoteForPosixShell(terminalRunReceiptPrefix(receipt))}`,
    `receipt_started_at_json=${quoteForPosixShell(JSON.stringify(receipt.timing.startedAt))}`,
    `timeout_seconds=${quoteForPosixShell(String(request.timeoutSeconds))}`,
    "write_state() {",
    `  printf '%s\\n' "$1" > "$state_path.tmp"`,
    `  mv -f -- "$state_path.tmp" "$state_path"`,
    "}",
    "write_terminal_state_marker() {",
    `  printf '%s\\n' "$1" > "$terminal_state_path.tmp"`,
    `  mv -f -- "$terminal_state_path.tmp" "$terminal_state_path"`,
    "}",
    "read_oom_kill_count() {",
    `  if [ ! -r "$1" ]; then printf '0\\n'; return; fi`,
    `  while read -r event_name event_count; do`,
    `    if [ "$event_name" = oom_kill ]; then`,
    `      case "$event_count" in ''|*[!0-9]*) printf '0\\n' ;; *) printf '%s\\n' "$event_count" ;; esac`,
    `      return`,
    `    fi`,
    `  done < "$1"`,
    `  printf '0\\n'`,
    "}",
    "record_artifact_error() {",
    `  artifact_snapshot_failed=true`,
    `  printf '%s\\n' "Artifact snapshot error: $1" >> "$stderr_path"`,
    "}",
    "write_artifact_manifest() {",
    `  : > "$artifact_manifest_unsorted_path"`,
    `  : > "$artifact_receipt_unsorted_path"`,
    `  if ! find "$artifact_snapshot_path" -type f -exec /bin/sh -c ${quoteForPosixShell(artifactManifestWorkerScript)} /bin/sh "$artifact_snapshot_path" "$artifact_manifest_unsorted_path" "$artifact_receipt_unsorted_path" {} +; then`,
    `    rm -f -- "$artifact_manifest_unsorted_path" "$artifact_receipt_unsorted_path"`,
    `    return 1`,
    `  fi`,
    `  artifact_file_count=$(wc -l < "$artifact_manifest_unsorted_path" | tr -d '[:space:]')`,
    `  artifact_receipt_count=$(wc -l < "$artifact_receipt_unsorted_path" | tr -d '[:space:]')`,
    `  artifact_manifest_bytes=$(wc -c < "$artifact_manifest_unsorted_path" | tr -d '[:space:]')`,
    `  case "$artifact_file_count:$artifact_receipt_count:$artifact_manifest_bytes" in *[!0-9:]*) return 1 ;; esac`,
    `  [ "$artifact_file_count" -eq "$artifact_receipt_count" ] || return 1`,
    `  [ "$artifact_file_count" -le ${String(MAXIMUM_JOB_ARTIFACT_FILES)} ] || return 1`,
    `  [ "$artifact_manifest_bytes" -le ${String(MAXIMUM_JOB_ARTIFACT_MANIFEST_BYTES)} ] || return 1`,
    `  LC_ALL=C sort "$artifact_manifest_unsorted_path" > "$artifact_manifest_path" || return 1`,
    `  LC_ALL=C sort "$artifact_receipt_unsorted_path" > "$artifact_receipt_sorted_path" || return 1`,
    `  tab_character=$(printf '\\t')`,
    `  {`,
    `    printf '['`,
    `    artifact_separator=`,
    `    while IFS="$tab_character" read -r artifact_sort_key artifact_json; do`,
    `      [ -n "$artifact_sort_key" ] && [ -n "$artifact_json" ] || return 1`,
    `      printf '%s%s' "$artifact_separator" "$artifact_json"`,
    `      artifact_separator=,`,
    `    done < "$artifact_receipt_sorted_path"`,
    `    printf ']\\n'`,
    `  } > "$artifact_receipt_path" || return 1`,
    `  rm -f -- "$artifact_manifest_unsorted_path" "$artifact_receipt_unsorted_path" "$artifact_receipt_sorted_path"`,
    `  return 0`,
    "}",
    "hash_file() {",
    `  if command -v sha256sum >/dev/null 2>&1; then`,
    `    hash_output=$(sha256sum "$1") || return 1`,
    `  elif command -v shasum >/dev/null 2>&1; then`,
    `    hash_output=$(shasum -a 256 "$1") || return 1`,
    `  else`,
    `    return 1`,
    `  fi`,
    `  file_sha256=\${hash_output%% *}`,
    `  file_sha256=\${file_sha256#\\\\}`,
    `  case "$file_sha256" in *[!0-9a-f]*|'') return 1 ;; esac`,
    `  [ "\${#file_sha256}" -eq 64 ] || return 1`,
    `  printf '%s\\n' "$file_sha256"`,
    "}",
    "write_terminal_receipt() {",
    `  terminal_state=$1`,
    `  terminal_exit_code=$2`,
    `  case "$terminal_exit_code" in ''|*[!0-9]*) return 1 ;; esac`,
    `  [ "$terminal_exit_code" -le 255 ] || return 1`,
    `  case "$terminal_state" in`,
    `    completed)`,
    `      [ "$terminal_exit_code" -eq 0 ] || return 1`,
    `      result_json='{"kind":"completed","exitCode":0}'`,
    `      ;;`,
    `    failed) result_json='{"kind":"failed","exitCode":'"$terminal_exit_code"'}' ;;`,
    `    cancelled) result_json='{"kind":"cancelled"}' ;;`,
    `    *) return 1 ;;`,
    `  esac`,
    `  finished_at=$(cat "$finished_at_path") || return 1`,
    `  stdout_bytes=$(wc -c < "$stdout_path" | tr -d '[:space:]') || return 1`,
    `  stderr_bytes=$(wc -c < "$stderr_path" | tr -d '[:space:]') || return 1`,
    `  case "$stdout_bytes:$stderr_bytes" in *[!0-9:]*) return 1 ;; esac`,
    `  stdout_sha256=$(hash_file "$stdout_path") || return 1`,
    `  stderr_sha256=$(hash_file "$stderr_path") || return 1`,
    `  [ -r "$artifact_receipt_path" ] || return 1`,
    `  receipt_temporary_path="$receipt_path.tmp"`,
    `  {`,
    `    printf '%s' "$receipt_prefix"`,
    `    printf ',"timing":{"kind":"finished","startedAt":%s,"finishedAt":"%s"}' "$receipt_started_at_json" "$finished_at"`,
    `    printf ',"result":%s' "$result_json"`,
    `    printf ',"output":{"kind":"captured","stdout":{"totalBytes":%s,"sha256":"%s"},"stderr":{"totalBytes":%s,"sha256":"%s"}}' "$stdout_bytes" "$stdout_sha256" "$stderr_bytes" "$stderr_sha256"`,
    `    printf ',"artifacts":'`,
    `    cat "$artifact_receipt_path"`,
    `    printf '}\\n'`,
    `  } > "$receipt_temporary_path" || { rm -f -- "$receipt_temporary_path"; return 1; }`,
    `  mv -f -- "$receipt_temporary_path" "$receipt_path"`,
    "}",
    "finish_failed_start() {",
    `  exit_code=$1`,
    `  printf '%s\\n' "$exit_code" > "$exit_code_path"`,
    `  date -u '+%Y-%m-%dT%H:%M:%SZ' > "$finished_at_path"`,
    `  : > "$artifact_manifest_path"`,
    `  printf '[]\\n' > "$artifact_receipt_path"`,
    `  write_terminal_state_marker failed`,
    `  if ! write_terminal_receipt failed "$exit_code"; then`,
    `    : > "$receipt_finalization_failed_path"`,
    `  fi`,
    `  write_state failed`,
    `  rm -f -- "$run_script_path" "$input_path"`,
    "  exit 0",
    "}",
    `: > "$stdout_path"`,
    `: > "$stderr_path"`,
    `cd -- "$remote_workspace"/${quoteForPosixShell(workingDirectory)} || finish_failed_start 125`,
    "set -m",
    `if [ -f "$input_path" ]; then`,
    `  ${command} < "$input_path" > "$stdout_path" 2> "$stderr_path" &`,
    "else",
    `  ${command} </dev/null > "$stdout_path" 2> "$stderr_path" &`,
    "fi",
    "child_pid=$!",
    `memory_events_path=`,
    `if [ -r /proc/self/cgroup ]; then`,
    `  while IFS=: read -r hierarchy controllers cgroup_relative; do`,
    `    if [ "$hierarchy" = 0 ] && [ -z "$controllers" ]; then`,
    `      memory_events_path="/sys/fs/cgroup$cgroup_relative/memory.events"`,
    `      break`,
    `    fi`,
    `  done < /proc/self/cgroup`,
    `fi`,
    `oom_kill_before=$(read_oom_kill_count "$memory_events_path")`,
    `process_group_id=$(ps -o pgid= -p "$child_pid" 2>/dev/null | tr -d '[:space:]')`,
    `case "$process_group_id" in ''|*[!0-9]*)`,
    `  kill -TERM "$child_pid" 2>/dev/null || true`,
    `  wait "$child_pid" 2>/dev/null || true`,
    `  finish_failed_start 125`,
    `  ;;`,
    `esac`,
    `if [ "$process_group_id" != "$child_pid" ]; then`,
    `  kill -TERM "$child_pid" 2>/dev/null || true`,
    `  wait "$child_pid" 2>/dev/null || true`,
    `  finish_failed_start 125`,
    `fi`,
    `printf '%s\\n' "$process_group_id" > "$process_group_path"`,
    `write_state running`,
    `rm -f -- "$run_script_path" "$input_path"`,
    "(",
    `  sleep_pid=`,
    `  trap 'if [ -n "$sleep_pid" ]; then kill -TERM "$sleep_pid" 2>/dev/null || true; fi; exit 0' TERM INT`,
    `  sleep "$timeout_seconds" &`,
    `  sleep_pid=$!`,
    `  wait "$sleep_pid" 2>/dev/null || exit 0`,
    `  if kill -0 -- "-$process_group_id" 2>/dev/null; then`,
    `    : > "$timed_out_path"`,
    `    kill -TERM -- "-$process_group_id" 2>/dev/null || true`,
    "    sleep 2",
    `    kill -KILL -- "-$process_group_id" 2>/dev/null || true`,
    "  fi",
    ") &",
    "watchdog_pid=$!",
    `wait "$child_pid"`,
    "exit_code=$?",
    `kill -TERM "$watchdog_pid" 2>/dev/null || true`,
    `wait "$watchdog_pid" 2>/dev/null || true`,
    `oom_kill_after=$(read_oom_kill_count "$memory_events_path")`,
    `if [ ! -f "$timed_out_path" ] && [ ! -f "$cancel_requested_path" ] && [ "$exit_code" -eq 137 ] && [ "$oom_kill_after" -gt "$oom_kill_before" ]; then`,
    `  printf '%s\\n' "$((oom_kill_after - oom_kill_before))" > "$oom_killed_path"`,
    `fi`,
    `if [ -f "$timed_out_path" ]; then exit_code=124; fi`,
    ...artifactSnapshotFinalizationCommands,
    `printf '%s\\n' "$exit_code" > "$exit_code_path"`,
    `date -u '+%Y-%m-%dT%H:%M:%SZ' > "$finished_at_path"`,
    `if [ -f "$cancel_requested_path" ]; then`,
    `  terminal_state=cancelled`,
    `elif [ "$exit_code" -eq 0 ]; then`,
    `  terminal_state=completed`,
    "else",
    `  terminal_state=failed`,
    "fi",
    `write_terminal_state_marker "$terminal_state"`,
    `if ! write_terminal_receipt "$terminal_state" "$exit_code"; then`,
    `  : > "$receipt_finalization_failed_path"`,
    `fi`,
    `write_state "$terminal_state"`,
    "exit 0",
    "",
  ].join("\n");
}

function buildStartJobCommand(jobDirectory: string): string {
  const runScript = path.posix.join(jobDirectory, "run.sh");
  const launcherPid = path.posix.join(jobDirectory, "launcher-pid");
  const statePath = path.posix.join(jobDirectory, "state");
  const script = [
    `nohup /bin/sh ${quoteForPosixShell(runScript)} </dev/null >/dev/null 2>&1 &`,
    "launcher_pid=$!",
    `printf '%s\\n' "$launcher_pid" > ${quoteForPosixShell(launcherPid)}`,
    "attempt=0",
    `while [ "$attempt" -lt ${String(JOB_START_TIMEOUT_MILLISECONDS / 1_000)} ]; do`,
    `  state=$(cat ${quoteForPosixShell(statePath)} 2>/dev/null || true)`,
    `  case "$state" in running|completed|failed|cancelled) exit 0 ;; esac`,
    `  kill -0 "$launcher_pid" 2>/dev/null || exit 70`,
    "  attempt=$((attempt + 1))",
    "  sleep 1",
    "done",
    "exit 71",
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

function buildJobStatusCommand(jobDirectory: string): string {
  const script = [
    `job_directory=${quoteForPosixShell(jobDirectory)}`,
    `[ -d "$job_directory" ] || { printf 'kind=job_not_found\\n'; exit 0; }`,
    `state=$(cat "$job_directory/state" 2>/dev/null || true)`,
    `terminal_state=$(cat "$job_directory/terminal-state" 2>/dev/null || true)`,
    `case "$terminal_state" in`,
    `  '') ;;`,
    `  completed|failed|cancelled|lost) state=$terminal_state ;;`,
    `  *) state=invalid ;;`,
    `esac`,
    `remote_workspace=$(cat "$job_directory/remote-workspace" 2>/dev/null || true)`,
    `started_at=$(cat "$job_directory/started-at" 2>/dev/null || true)`,
    `receipt_base64=$(base64 < "$job_directory/receipt.json" 2>/dev/null | tr -d '\\r\\n')`,
    "emit_common() {",
    `  printf 'remoteWorkspace=%s\\n' "$remote_workspace"`,
    `  printf 'startedAt=%s\\n' "$started_at"`,
    `  printf 'receiptBase64=%s\\n' "$receipt_base64"`,
    "}",
    "hash_file() {",
    `  if command -v sha256sum >/dev/null 2>&1; then`,
    `    sha256sum "$1" | cut -d ' ' -f 1`,
    `  elif command -v shasum >/dev/null 2>&1; then`,
    `    shasum -a 256 "$1" | cut -d ' ' -f 1`,
    "  else",
    "    return 1",
    "  fi",
    "}",
    "emit_output() {",
    `  stdout_bytes=$(wc -c < "$job_directory/stdout" | tr -d '[:space:]')`,
    `  stderr_bytes=$(wc -c < "$job_directory/stderr" | tr -d '[:space:]')`,
    `  stdout_sha256=$(hash_file "$job_directory/stdout") || return 1`,
    `  stderr_sha256=$(hash_file "$job_directory/stderr") || return 1`,
    `  printf 'stdoutBytes=%s\\n' "$stdout_bytes"`,
    `  printf 'stdoutSha256=%s\\n' "$stdout_sha256"`,
    `  printf 'stderrBytes=%s\\n' "$stderr_bytes"`,
    `  printf 'stderrSha256=%s\\n' "$stderr_sha256"`,
    "}",
    "emit_artifacts() {",
    `  if [ -f "$job_directory/artifacts.manifest" ]; then`,
    `    artifact_manifest_base64=$(base64 < "$job_directory/artifacts.manifest" | tr -d '\\r\\n') || return 1`,
    `  else`,
    `    artifact_manifest_base64=`,
    `  fi`,
    `  printf 'artifactManifestBase64=%s\\n' "$artifact_manifest_base64"`,
    "}",
    "mark_lost() {",
    `  [ -f "$job_directory/stdout" ] || : > "$job_directory/stdout"`,
    `  [ -f "$job_directory/stderr" ] || : > "$job_directory/stderr"`,
    `  finished_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')`,
    `  printf '%s\\n' "$finished_at" > "$job_directory/finished-at"`,
    `  printf '%s\\n' "$state" > "$job_directory/lost-prior-state"`,
    `  printf '%s\\n' "$1" > "$job_directory/lost-reason"`,
    `  printf '%s\\n' lost > "$job_directory/state.tmp"`,
    `  mv -f -- "$job_directory/state.tmp" "$job_directory/state"`,
    `  printf 'kind=lost\\n'`,
    "  emit_common",
    `  printf 'finishedAt=%s\\n' "$finished_at"`,
    `  printf 'lastKnownState=%s\\n' "$state"`,
    `  printf 'reason=%s\\n' "$1"`,
    "  emit_output || exit 74",
    "  emit_artifacts || exit 74",
    "  exit 0",
    "}",
    `case "$state" in`,
    `  starting)`,
    `    launcher_pid=$(cat "$job_directory/launcher-pid" 2>/dev/null || true)`,
    `    case "$launcher_pid" in ''|*[!0-9]*) mark_lost 'The launcher process identifier is missing.' ;; esac`,
    `    kill -0 "$launcher_pid" 2>/dev/null || mark_lost 'The launcher process is not running.'`,
    `    printf 'kind=starting\\n'`,
    `    emit_common`,
    `    ;;`,
    `  running)`,
    `    process_group_id=$(cat "$job_directory/process-group-id" 2>/dev/null || true)`,
    `    case "$process_group_id" in ''|*[!0-9]*) mark_lost 'The process group identifier is missing.' ;; esac`,
    `    if ! kill -0 -- "-$process_group_id" 2>/dev/null; then`,
    `      launcher_pid=$(cat "$job_directory/launcher-pid" 2>/dev/null || true)`,
    `      case "$launcher_pid" in ''|*[!0-9]*) mark_lost 'The launcher process identifier is missing.' ;; esac`,
    `      kill -0 "$launcher_pid" 2>/dev/null || mark_lost 'The process group and launcher are not running, and no terminal state was recorded.'`,
    `    fi`,
    `    printf 'kind=running\\n'`,
    `    emit_common`,
    `    printf 'processGroupId=%s\\n' "$process_group_id"`,
    `    ;;`,
    `  completed|failed|cancelled)`,
    `    finished_at=$(cat "$job_directory/finished-at" 2>/dev/null || true)`,
    `    printf 'kind=%s\\n' "$state"`,
    `    emit_common`,
    `    printf 'finishedAt=%s\\n' "$finished_at"`,
    `    if [ "$state" = completed ] || [ "$state" = failed ]; then`,
    `      printf 'exitCode=%s\\n' "$(cat "$job_directory/exit-code" 2>/dev/null || true)"`,
    `    fi`,
    `    if [ "$state" = failed ]; then`,
    `      if [ -f "$job_directory/timed-out" ]; then printf 'timedOut=true\\n'; else printf 'timedOut=false\\n'; fi`,
    `      printf 'timeoutSeconds=%s\\n' "$(cat "$job_directory/timeout-seconds" 2>/dev/null || true)"`,
    `      printf 'oomKillCount=%s\\n' "$(cat "$job_directory/oom-kill-count" 2>/dev/null || true)"`,
    `    fi`,
    `    emit_output || exit 74`,
    `    emit_artifacts || exit 74`,
    `    ;;`,
    `  lost)`,
    `    finished_at=$(cat "$job_directory/finished-at" 2>/dev/null || true)`,
    `    printf 'kind=lost\\n'`,
    `    emit_common`,
    `    printf 'finishedAt=%s\\n' "$finished_at"`,
    `    printf 'lastKnownState=%s\\n' "$(cat "$job_directory/lost-prior-state" 2>/dev/null || true)"`,
    `    printf 'reason=%s\\n' "$(cat "$job_directory/lost-reason" 2>/dev/null || true)"`,
    `    emit_output || exit 74`,
    `    emit_artifacts || exit 74`,
    `    ;;`,
    `  *)`,
    `    printf 'kind=invalid\\n'`,
    `    printf 'state=%s\\n' "$state"`,
    `    ;;`,
    `esac`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

export function parseJobStatusProtocol(
  output: string,
): Result<ParsedJobStatus, string> {
  const values = parseProtocolValues(output);
  const kind = values["kind"];
  if (kind === "job_not_found") {
    return success({ kind });
  }

  const remoteWorkspace = values["remoteWorkspace"];
  const startedAt = values["startedAt"];
  const receiptBase64 = values["receiptBase64"];
  if (
    remoteWorkspace === undefined ||
    remoteWorkspace.length === 0 ||
    startedAt === undefined ||
    !isIsoTimestamp(startedAt) ||
    receiptBase64 === undefined ||
    !isCanonicalBase64(receiptBase64)
  ) {
    return failure(`The job status protocol is incomplete. Raw output:\n${output}`);
  }

  const receiptResult = parseRunReceiptJson(
    Buffer.from(receiptBase64, "base64").toString("utf8"),
  );
  if (receiptResult.kind === "invalid") {
    return failure(receiptResult.message);
  }
  const receipt = receiptResult.value;
  if (
    receipt.remoteWorkspace !== remoteWorkspace ||
    receipt.timing.startedAt !== startedAt
  ) {
    return failure("The stored run receipt does not match the job metadata.");
  }
  const base: ParsedJobStatusBase = {
    remoteWorkspace,
    startedAt,
    receipt,
  };

  switch (kind) {
    case "starting":
      return success({ kind, ...base });
    case "running": {
      const processGroupId = Number(values["processGroupId"]);
      if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) {
        return failure(
          `The job status has an invalid process group identifier. Raw output:\n${output}`,
        );
      }
      return success({ kind, ...base, processGroupId });
    }
    case "completed":
    case "failed": {
      const exitCode = Number(values["exitCode"]);
      const finishedAt = values["finishedAt"];
      const outputResult = parseJobOutputDigests(values);
      const artifactsResult = parseJobArtifactManifest(
        values["artifactManifestBase64"],
      );
      if (
        !Number.isSafeInteger(exitCode) ||
        exitCode < 0 ||
        exitCode > 255 ||
        finishedAt === undefined ||
        !isIsoTimestamp(finishedAt) ||
        (!outputResult.ok || !artifactsResult.ok)
      ) {
        return failure(
          `The terminal job status is invalid. Raw output:\n${output}`,
        );
      }
      if (kind === "completed") {
        if (exitCode !== 0) {
          return failure("A completed job must have exit code 0.");
        }
        return success({
          kind,
          ...base,
          finishedAt,
          output: outputResult.value,
          artifacts: artifactsResult.value,
          termination: { kind: "completed" },
        });
      }
      if (exitCode === 0) {
        return failure("A failed job must have a nonzero exit code.");
      }
      const terminationResult = parseFailedJobTermination(
        values,
        exitCode,
        output,
      );
      if (!terminationResult.ok) {
        return failure(terminationResult.error);
      }
      return success({
        kind,
        ...base,
        finishedAt,
        exitCode,
        output: outputResult.value,
        artifacts: artifactsResult.value,
        termination: terminationResult.value,
      });
    }
    case "cancelled": {
      const finishedAt = values["finishedAt"];
      const outputResult = parseJobOutputDigests(values);
      const artifactsResult = parseJobArtifactManifest(
        values["artifactManifestBase64"],
      );
      if (
        finishedAt === undefined ||
        !isIsoTimestamp(finishedAt) ||
        (!outputResult.ok || !artifactsResult.ok)
      ) {
        return failure(
          `The cancelled job status has invalid terminal data. Raw output:\n${output}`,
        );
      }
      return success({
        kind,
        ...base,
        finishedAt,
        output: outputResult.value,
        artifacts: artifactsResult.value,
        termination: { kind: "cancelled" },
      });
    }
    case "lost": {
      const finishedAt = values["finishedAt"];
      const lastKnownState = values["lastKnownState"];
      const reason = values["reason"];
      const outputResult = parseJobOutputDigests(values);
      const artifactsResult = parseJobArtifactManifest(
        values["artifactManifestBase64"],
      );
      if (
        finishedAt === undefined ||
        !isIsoTimestamp(finishedAt) ||
        (lastKnownState !== "starting" && lastKnownState !== "running") ||
        reason === undefined ||
        reason.length === 0 ||
        (!outputResult.ok || !artifactsResult.ok)
      ) {
        return failure(`The lost job status is invalid. Raw output:\n${output}`);
      }
      return success({
        kind,
        ...base,
        finishedAt,
        lastKnownState,
        reason,
        output: outputResult.value,
        artifacts: artifactsResult.value,
        termination: { kind: "lost", reason },
      });
    }
    case undefined:
    default:
      return failure(`The job status kind is invalid. Raw output:\n${output}`);
  }
}

function parseJobArtifactManifest(
  encodedManifest: string | undefined,
): Result<readonly FetchedArtifact[], string> {
  if (
    encodedManifest === undefined ||
    !isCanonicalBase64(encodedManifest)
  ) {
    return failure("The job artifact manifest is not canonical base64.");
  }
  let manifest: string;
  try {
    manifest = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(encodedManifest, "base64"),
    );
  } catch {
    return failure("The job artifact manifest is not valid UTF-8.");
  }
  if (manifest.length === 0) {
    return success(Object.freeze<FetchedArtifact[]>([]));
  }

  const lines = manifest.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (
    lines.length > MAXIMUM_JOB_ARTIFACT_FILES ||
    Buffer.byteLength(manifest, "utf8") >
      MAXIMUM_JOB_ARTIFACT_MANIFEST_BYTES
  ) {
    return failure("The job artifact manifest exceeds its safe limit.");
  }

  const artifacts: FetchedArtifact[] = [];
  const seenPaths = new Set<string>();
  let previousEncodedPath: string | undefined;
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 3) {
      return failure("The job artifact manifest has an invalid record.");
    }
    const [encodedPath, rawSizeBytes, sha256] = fields;
    if (
      encodedPath === undefined ||
      rawSizeBytes === undefined ||
      sha256 === undefined ||
      !isCanonicalBase64(encodedPath) ||
      (previousEncodedPath !== undefined &&
        encodedPath <= previousEncodedPath)
    ) {
      return failure("The job artifact manifest is not ordered correctly.");
    }
    let artifactPath: string;
    try {
      artifactPath = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(encodedPath, "base64"),
      );
    } catch {
      return failure("A job artifact path is not valid UTF-8.");
    }
    const pathResult = parseRemoteRelativePath(artifactPath);
    const sizeBytes = Number(rawSizeBytes);
    if (
      !pathResult.ok ||
      pathResult.value === "." ||
      pathResult.value !== artifactPath ||
      seenPaths.has(artifactPath) ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      !/^[0-9a-f]{64}$/.test(sha256)
    ) {
      return failure("The job artifact manifest has invalid file data.");
    }
    seenPaths.add(artifactPath);
    artifacts.push({ path: artifactPath, sizeBytes, sha256 });
    previousEncodedPath = encodedPath;
  }
  return success(Object.freeze(artifacts));
}

function parseFailedJobTermination(
  values: Readonly<Record<string, string>>,
  exitCode: number,
  output: string,
): Result<
  Extract<
    JobTermination,
    {
      readonly kind:
        | "exited"
        | "signalled"
        | "timed_out"
        | "oom_killed";
    }
  >,
  string
> {
  const timedOut = values["timedOut"];
  const rawOomKillCount = values["oomKillCount"];
  if (
    (timedOut !== "true" && timedOut !== "false") ||
    rawOomKillCount === undefined
  ) {
    return failure(
      `The failed job termination data is incomplete. Raw output:\n${output}`,
    );
  }
  if (timedOut === "true") {
    const timeoutSeconds = Number(values["timeoutSeconds"]);
    if (
      !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds < 1
    ) {
      return failure(
        `The failed job timeout is invalid. Raw output:\n${output}`,
      );
    }
    return success({ kind: "timed_out", timeoutSeconds });
  }
  if (rawOomKillCount.length > 0) {
    const oomKillCount = Number(rawOomKillCount);
    if (!Number.isSafeInteger(oomKillCount) || oomKillCount < 1) {
      return failure(
        `The failed job OOM evidence is invalid. Raw output:\n${output}`,
      );
    }
    return success({
      kind: "oom_killed",
      evidence: { kind: "cgroup", oomKillCount },
    });
  }
  if (exitCode >= 129 && exitCode <= 192) {
    return success({ kind: "signalled", signalNumber: exitCode - 128 });
  }
  return success({ kind: "exited", exitCode });
}

function parseJobOutputDigests(
  values: Readonly<Record<string, string>>,
): Result<JobOutputDigests, string> {
  const stdoutResult = parseOutputDigest(
    values["stdoutBytes"],
    values["stdoutSha256"],
  );
  if (!stdoutResult.ok) {
    return failure(stdoutResult.error);
  }
  const stderrResult = parseOutputDigest(
    values["stderrBytes"],
    values["stderrSha256"],
  );
  if (!stderrResult.ok) {
    return failure(stderrResult.error);
  }
  return success({
    kind: "captured",
    stdout: stdoutResult.value,
    stderr: stderrResult.value,
  });
}

function parseOutputDigest(
  rawBytes: string | undefined,
  sha256: string | undefined,
): Result<OutputDigest, string> {
  const totalBytes = Number(rawBytes);
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    sha256 === undefined ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    return failure("The job output digest is invalid.");
  }
  return success({ totalBytes, sha256 });
}

function outputDigestMatches(
  left: OutputDigest,
  right: OutputDigest,
): boolean {
  return left.totalBytes === right.totalBytes && left.sha256 === right.sha256;
}

function artifactListsMatch(
  left: readonly FetchedArtifact[],
  right: readonly FetchedArtifact[],
): boolean {
  return (
    left.length === right.length &&
    left.every((artifact, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        artifact.path === other.path &&
        artifact.sizeBytes === other.sizeBytes &&
        artifact.sha256 === other.sha256
      );
    })
  );
}

function finishedReceiptMatchesJobStatus(
  receipt: FinishedRunReceipt,
  status: Extract<ParsedJobStatus, { readonly finishedAt: string }>,
): boolean {
  if (
    receipt.timing.finishedAt !== status.finishedAt ||
    receipt.output.kind !== "captured" ||
    !outputDigestMatches(receipt.output.stdout, status.output.stdout) ||
    !outputDigestMatches(receipt.output.stderr, status.output.stderr) ||
    !artifactListsMatch(receipt.artifacts, status.artifacts)
  ) {
    return false;
  }
  switch (status.kind) {
    case "completed":
      return (
        receipt.result.kind === "completed" && receipt.result.exitCode === 0
      );
    case "failed":
      return (
        receipt.result.kind === "failed" &&
        receipt.result.exitCode === status.exitCode
      );
    case "cancelled":
      return receipt.result.kind === "cancelled";
    case "lost":
      return (
        receipt.result.kind === "lost" &&
        receipt.result.reason === status.reason
      );
  }
}

function receiptForJobStatus(
  status: Exclude<ParsedJobStatus, { readonly kind: "job_not_found" }>,
): Result<RunReceipt, string> {
  const receipt = status.receipt;
  if (!isActiveRunReceipt(receipt)) {
    switch (status.kind) {
      case "starting":
      case "running":
        return failure(
          "A nonterminal job has a terminal stored run receipt.",
        );
      case "completed":
      case "failed":
      case "cancelled":
      case "lost":
        return finishedReceiptMatchesJobStatus(receipt, status)
          ? success(receipt)
          : failure(
              "The terminal stored run receipt does not match the job status.",
            );
    }
  }
  switch (status.kind) {
    case "starting":
    case "running":
      return success(receipt);
    case "completed":
      return success(
        finishStoredRunReceipt(
          receipt,
          status.finishedAt,
          { kind: "completed", exitCode: 0 },
          status.output,
          status.artifacts,
        ),
      );
    case "failed":
      return success(
        finishStoredRunReceipt(
          receipt,
          status.finishedAt,
          { kind: "failed", exitCode: status.exitCode },
          status.output,
          status.artifacts,
        ),
      );
    case "cancelled":
      return success(
        finishStoredRunReceipt(
          receipt,
          status.finishedAt,
          { kind: "cancelled" },
          status.output,
          status.artifacts,
        ),
      );
    case "lost":
      return success(
        finishStoredRunReceipt(
          receipt,
          status.finishedAt,
          { kind: "lost", reason: status.reason },
          status.output,
          status.artifacts,
        ),
      );
  }
}

function buildJobListCommand(
  jobsRoot: string,
  workspaceId: string,
  cursor: string | null,
  scanLimit: number,
): string {
  const script = [
    "umask 077",
    "set -e",
    `jobs_root=${quoteForPosixShell(jobsRoot)}`,
    `workspace_id=${quoteForPosixShell(workspaceId)}`,
    `cursor=${quoteForPosixShell(cursor ?? "")}`,
    `scan_limit=${String(scanLimit)}`,
    `mkdir -p -- "$jobs_root"`,
    `temporary_directory="$jobs_root/.list.$$"`,
    `mkdir -- "$temporary_directory"`,
    `trap 'rm -rf -- "$temporary_directory"' EXIT HUP INT TERM`,
    `index_path="$temporary_directory/index"`,
    `sorted_path="$temporary_directory/sorted"`,
    `result_path="$temporary_directory/result"`,
    `: > "$index_path"`,
    `: > "$result_path"`,
    `for job_directory in "$jobs_root"/*; do`,
    `  [ -d "$job_directory" ] || continue`,
    `  [ -L "$job_directory" ] && continue`,
    `  job_id=${"${job_directory##*/}"}`,
    `  case "$job_id" in ????????-????-4???-[89ab]???-????????????) ;; *) continue ;; esac`,
    `  case "$job_id" in *[!0-9a-f-]*) continue ;; esac`,
    `  [ "$(cat "$job_directory/workspace-id" 2>/dev/null || true)" = "$workspace_id" ] || continue`,
    `  started_at=$(cat "$job_directory/started-at" 2>/dev/null || true)`,
    `  printf '%s\\t%s\\n' "$started_at" "$job_id" >> "$index_path"`,
    `done`,
    `LC_ALL=C sort -r "$index_path" > "$sorted_path"`,
    `if [ -z "$cursor" ]; then cursor_found=true; else cursor_found=false; fi`,
    `has_more=false`,
    `count=0`,
    `tab=$(printf '\\t')`,
    `while IFS="$tab" read -r started_at job_id; do`,
    `  if [ "$cursor_found" = false ]; then`,
    `    if [ "$job_id" = "$cursor" ]; then cursor_found=true; fi`,
    `    continue`,
    `  fi`,
    `  if [ "$count" -ge "$scan_limit" ]; then has_more=true; break; fi`,
    `  printf 'jobId=%s\\n' "$job_id" >> "$result_path"`,
    `  count=$((count + 1))`,
    `done < "$sorted_path"`,
    `printf 'kind=completed\\n'`,
    `printf 'cursorFound=%s\\n' "$cursor_found"`,
    `printf 'hasMore=%s\\n' "$has_more"`,
    `cat "$result_path"`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

export function parseJobIdentifierPageProtocol(
  output: string,
): Result<JobIdentifierPage, string> {
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (
    lines.length < 3 ||
    lines[0] !== "kind=completed" ||
    (lines[1] !== "cursorFound=true" &&
      lines[1] !== "cursorFound=false") ||
    (lines[2] !== "hasMore=true" && lines[2] !== "hasMore=false")
  ) {
    return failure(`The job list protocol is invalid. Raw output:\n${output}`);
  }
  const jobIds: string[] = [];
  const seenJobIds = new Set<string>();
  for (const line of lines.slice(3)) {
    if (!line.startsWith("jobId=")) {
      return failure(`The job list protocol is invalid. Raw output:\n${output}`);
    }
    const jobId = line.slice("jobId=".length);
    if (
      !JOB_IDENTIFIER_PATTERN.test(jobId) ||
      seenJobIds.has(jobId)
    ) {
      return failure(`The job list protocol is invalid. Raw output:\n${output}`);
    }
    seenJobIds.add(jobId);
    jobIds.push(jobId);
  }
  return success({
    cursorFound: lines[1] === "cursorFound=true",
    hasMore: lines[2] === "hasMore=true",
    jobIds: Object.freeze(jobIds),
  });
}

function buildDeleteJobCommand(
  remoteRoot: string,
  jobsRoot: string,
  jobId: string,
): string {
  const jobDirectory = path.posix.join(jobsRoot, jobId);
  const idempotencyRoot = path.posix.join(remoteRoot, ".idempotency");
  const script = [
    "set -u",
    `job_directory=${quoteForPosixShell(jobDirectory)}`,
    `[ -L "$job_directory" ] && { printf 'kind=invalid\\n'; exit 0; }`,
    `[ -d "$job_directory" ] || { printf 'kind=job_not_found\\n'; exit 0; }`,
    `state=$(cat "$job_directory/state" 2>/dev/null || true)`,
    `case "$state" in`,
    `  starting|running) printf 'kind=job_active\\nstate=%s\\n' "$state"; exit 0 ;;`,
    `  completed|failed|cancelled|lost) ;;`,
    `  *) printf 'kind=invalid\\n'; exit 0 ;;`,
    `esac`,
    `remote_workspace=$(cat "$job_directory/remote-workspace" 2>/dev/null || true)`,
    `[ -n "$remote_workspace" ] || { printf 'kind=invalid\\n'; exit 0; }`,
    `workspace_id=$(cat "$job_directory/workspace-id" 2>/dev/null || true)`,
    `idempotency_digest=$(cat "$job_directory/idempotency-digest" 2>/dev/null || true)`,
    `idempotency_record=`,
    `if [ -n "$idempotency_digest" ]; then`,
    `  case "$workspace_id" in ''|*[!A-Za-z0-9._-]*) printf 'kind=invalid\\n'; exit 0 ;; esac`,
    `  case "$idempotency_digest" in *[!0-9a-f]*) printf 'kind=invalid\\n'; exit 0 ;; esac`,
    `  [ "${"${#idempotency_digest}"}" -eq 64 ] || { printf 'kind=invalid\\n'; exit 0; }`,
    `  idempotency_record=${quoteForPosixShell(idempotencyRoot)}/"$workspace_id"/"$idempotency_digest"`,
    `  [ ! -L "$idempotency_record" ] || { printf 'kind=invalid\\n'; exit 0; }`,
    `  if [ -e "$idempotency_record" ]; then`,
    `    [ -d "$idempotency_record" ] || { printf 'kind=invalid\\n'; exit 0; }`,
    `    [ "$(cat "$idempotency_record/job-id" 2>/dev/null || true)" = ${quoteForPosixShell(jobId)} ] || { printf 'kind=invalid\\n'; exit 0; }`,
    `  fi`,
    `fi`,
    `rm -rf -- "$job_directory" || exit 73`,
    `if [ -n "$idempotency_record" ] && [ -d "$idempotency_record" ]; then`,
    `  rm -rf -- "$idempotency_record" || exit 73`,
    `  rmdir -- ${quoteForPosixShell(idempotencyRoot)}/"$workspace_id" 2>/dev/null || true`,
    `fi`,
    `printf 'kind=deleted\\n'`,
    `printf 'remoteWorkspace=%s\\n' "$remote_workspace"`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

export function parseJobDeleteProtocol(
  output: string,
): Result<JobDeleteProtocol, string> {
  const values = parseProtocolValues(output);
  switch (values["kind"]) {
    case "deleted": {
      const remoteWorkspace = values["remoteWorkspace"];
      if (remoteWorkspace === undefined || remoteWorkspace.length === 0) {
        return failure(
          `The job delete protocol is invalid. Raw output:\n${output}`,
        );
      }
      return success({ kind: "deleted", remoteWorkspace });
    }
    case "job_not_found":
      return success({ kind: "job_not_found" });
    case "job_active": {
      const state = values["state"];
      if (state !== "starting" && state !== "running") {
        return failure(
          `The job delete protocol is invalid. Raw output:\n${output}`,
        );
      }
      return success({ kind: "job_active", state });
    }
    case "invalid":
      return success({ kind: "invalid" });
    case undefined:
    default:
      return failure(
        `The job delete protocol is invalid. Raw output:\n${output}`,
      );
  }
}

function buildJobLogCommand(
  jobDirectory: string,
  stream: JobLogStream,
  offsetBytes: number,
  maximumBytes: number,
): string {
  const logPath = path.posix.join(jobDirectory, stream);
  const script = [
    `job_directory=${quoteForPosixShell(jobDirectory)}`,
    `[ -d "$job_directory" ] || { printf 'kind=job_not_found\\n'; exit 0; }`,
    `log_path=${quoteForPosixShell(logPath)}`,
    `[ -f "$log_path" ] || { printf 'kind=log_not_found\\n'; exit 0; }`,
    `total_bytes=$(wc -c < "$log_path" | tr -d '[:space:]')`,
    `offset_bytes=${String(offsetBytes)}`,
    `maximum_bytes=${String(maximumBytes)}`,
    `[ "$offset_bytes" -le "$total_bytes" ] || { printf 'kind=invalid_log_offset\\ntotalBytes=%s\\n' "$total_bytes"; exit 0; }`,
    `printf 'kind=data\\ntotalBytes=%s\\ndataBase64=' "$total_bytes"`,
    `dd if="$log_path" bs=1 skip="$offset_bytes" count="$maximum_bytes" 2>/dev/null | base64 | tr -d '\\r\\n'`,
    `printf '\\n'`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

export function parseJobLogProtocol(
  output: CapturedOutput,
): Result<ParsedJobLogProtocol, string> {
  if (output.omittedBytes !== 0) {
    return failure("The job log protocol exceeded the local output limit.");
  }

  const values = parseProtocolValues(output.text);
  const kind = values["kind"];
  if (kind === "job_not_found" || kind === "log_not_found") {
    return success({ kind });
  }

  const totalBytes = Number(values["totalBytes"]);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    return failure("The job log protocol has an invalid total byte count.");
  }
  if (kind === "invalid_log_offset") {
    return success({ kind, totalBytes });
  }
  if (kind !== "data") {
    return failure("The job log protocol has an invalid result kind.");
  }

  const encoded = values["dataBase64"];
  if (encoded === undefined || !isCanonicalBase64(encoded)) {
    return failure("The job log protocol contains invalid base64 data.");
  }
  return success({
    kind,
    totalBytes,
    bytes: Buffer.from(encoded, "base64"),
  });
}

export function decodeUtf8LogChunk(
  bytes: Buffer,
  offsetBytes: number,
  totalBytes: number,
): Result<{ readonly text: string; readonly consumedBytes: number }, string> {
  const maximumTrimBytes = Math.min(3, bytes.byteLength);
  const endsAtFileBoundary = offsetBytes + bytes.byteLength >= totalBytes;
  for (let trimBytes = 0; trimBytes <= maximumTrimBytes; trimBytes += 1) {
    if (endsAtFileBoundary && trimBytes > 0) {
      break;
    }
    const candidateLength = bytes.byteLength - trimBytes;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, candidateLength),
      );
      return success({ text, consumedBytes: candidateLength });
    } catch {
      continue;
    }
  }
  return failure(
    "The requested byte offset or log data does not start and end on valid UTF-8 boundaries.",
  );
}

function buildCancelJobCommand(
  jobDirectory: string,
  graceSeconds: number,
): string {
  const script = [
    `job_directory=${quoteForPosixShell(jobDirectory)}`,
    `[ -d "$job_directory" ] || exit 0`,
    `: > "$job_directory/cancel-requested"`,
    `state=$(cat "$job_directory/state" 2>/dev/null || true)`,
    `case "$state" in`,
    `  starting)`,
    `    process_group_id=$(cat "$job_directory/process-group-id" 2>/dev/null || true)`,
    `    case "$process_group_id" in`,
    `      ''|*[!0-9]*) ;;`,
    `      *)`,
    `        kill -TERM -- "-$process_group_id" 2>/dev/null || true`,
    `        sleep 1`,
    `        kill -KILL -- "-$process_group_id" 2>/dev/null || true`,
    `        ;;`,
    `    esac`,
    `    launcher_pid=$(cat "$job_directory/launcher-pid" 2>/dev/null || true)`,
    `    case "$launcher_pid" in ''|*[!0-9]*) ;; *) kill -TERM "$launcher_pid" 2>/dev/null || true ;; esac`,
    `    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$job_directory/finished-at"`,
    `    printf '%s\\n' cancelled > "$job_directory/state.tmp"`,
    `    mv -f -- "$job_directory/state.tmp" "$job_directory/state"`,
    `    ;;`,
    `  running)`,
    `    process_group_id=$(cat "$job_directory/process-group-id" 2>/dev/null || true)`,
    `    case "$process_group_id" in ''|*[!0-9]*) exit 72 ;; esac`,
    `    kill -TERM -- "-$process_group_id" 2>/dev/null || true`,
    `    attempt=0`,
    `    while kill -0 -- "-$process_group_id" 2>/dev/null && [ "$attempt" -lt ${String(graceSeconds)} ]; do`,
    `      sleep 1`,
    `      attempt=$((attempt + 1))`,
    `    done`,
    `    kill -KILL -- "-$process_group_id" 2>/dev/null || true`,
    `    attempt=0`,
    `    while [ "$(cat "$job_directory/state" 2>/dev/null || true)" = running ] && [ "$attempt" -lt 3 ]; do`,
    `      sleep 1`,
    `      attempt=$((attempt + 1))`,
    `    done`,
    `    if [ "$(cat "$job_directory/state" 2>/dev/null || true)" = running ]; then`,
    `      date -u '+%Y-%m-%dT%H:%M:%SZ' > "$job_directory/finished-at"`,
    `      printf '%s\\n' cancelled > "$job_directory/state.tmp"`,
    `      mv -f -- "$job_directory/state.tmp" "$job_directory/state"`,
    `    fi`,
    `    ;;`,
    `esac`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

function selectJobArtifacts(
  receiptArtifacts: readonly FetchedArtifact[],
  requestedPaths: readonly string[],
): Result<readonly FetchedArtifact[], string> {
  const selectedArtifacts = new Map<string, FetchedArtifact>();
  for (const requestedPath of requestedPaths) {
    const matchingArtifacts = receiptArtifacts.filter(
      (artifact) =>
        artifact.path === requestedPath ||
        artifact.path.startsWith(`${requestedPath}/`),
    );
    if (matchingArtifacts.length === 0) {
      return failure(
        `The job receipt does not declare the artifact path '${requestedPath}'.`,
      );
    }
    for (const artifact of matchingArtifacts) {
      selectedArtifacts.set(artifact.path, artifact);
    }
  }
  return success(
    Object.freeze(
      [...selectedArtifacts.values()].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    ),
  );
}

function selectArtifactSnapshotRoots(
  receiptArtifacts: readonly FetchedArtifact[],
): readonly string[] {
  const roots = new Set<string>();
  for (const artifact of receiptArtifacts) {
    const separatorIndex = artifact.path.indexOf("/");
    roots.add(
      separatorIndex === -1
        ? artifact.path
        : artifact.path.slice(0, separatorIndex),
    );
  }
  return Object.freeze([...roots].sort((left, right) => left.localeCompare(right)));
}

function verifyFetchedArtifactIntegrity(
  localDestination: string,
  fetchedArtifacts: readonly FetchedArtifact[],
  expectedArtifacts: readonly FetchedArtifact[],
): Result<undefined, string> {
  const expectedByPath = new Map(
    expectedArtifacts.map((artifact) => [artifact.path, artifact]),
  );
  if (fetchedArtifacts.length !== expectedByPath.size) {
    return failure(
      "The downloaded artifact file count does not match the job receipt.",
    );
  }
  for (const fetchedArtifact of fetchedArtifacts) {
    const artifactPath = path.posix.relative(
      localDestination,
      fetchedArtifact.path,
    );
    if (
      fetchedArtifact.path === localDestination ||
      artifactPath === ".." ||
      artifactPath.startsWith("../") ||
      path.posix.isAbsolute(artifactPath)
    ) {
      return failure(
        "A downloaded artifact path is outside the local destination.",
      );
    }
    const expectedArtifact = expectedByPath.get(artifactPath);
    if (
      expectedArtifact === undefined ||
      expectedArtifact.sizeBytes !== fetchedArtifact.sizeBytes ||
      expectedArtifact.sha256 !== fetchedArtifact.sha256
    ) {
      return failure(
        `The downloaded artifact '${artifactPath}' does not match the job receipt.`,
      );
    }
  }
  return success(undefined);
}

export function parseArtifactPaths(
  rawPaths: readonly string[],
): Result<readonly string[], string> {
  if (rawPaths.length === 0) {
    return failure("Select at least one remote artifact path.");
  }
  if (rawPaths.length > 64) {
    return failure("Select at most 64 remote artifact paths.");
  }

  const normalizedPaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const rawPath of rawPaths) {
    if (
      rawPath.length > 4_096 ||
      rawPath.includes("\r") ||
      rawPath.includes("\n")
    ) {
      return failure(
        `The artifact path '${rawPath}' must not contain a line break and must contain at most 4096 characters.`,
      );
    }
    const pathResult = parseRemoteRelativePath(rawPath);
    if (!pathResult.ok || pathResult.value === ".") {
      return failure(
        `The artifact path '${rawPath}' must be a relative path inside the remote workspace.`,
      );
    }
    if (seenPaths.has(pathResult.value)) {
      return failure(`The artifact path '${pathResult.value}' is duplicated.`);
    }
    const overlappingPath = normalizedPaths.find(
      (existingPath) =>
        pathResult.value.startsWith(`${existingPath}/`) ||
        existingPath.startsWith(`${pathResult.value}/`),
    );
    if (overlappingPath !== undefined) {
      return failure(
        `The artifact paths '${overlappingPath}' and '${pathResult.value}' overlap.`,
      );
    }
    seenPaths.add(pathResult.value);
    normalizedPaths.push(pathResult.value);
  }
  return success(Object.freeze(normalizedPaths));
}

export function resolveArtifactDestination(
  localWorkspace: string,
  rawDestination: string,
  overwrite: boolean,
): Result<ArtifactDestination, ArtifactDestinationError> {
  if (
    rawDestination.length === 0 ||
    rawDestination.includes("\0") ||
    path.isAbsolute(rawDestination)
  ) {
    return failure({
      code: "invalid_local_destination",
      message: "The local artifact destination must be a relative path.",
    });
  }

  const absolutePath = path.resolve(localWorkspace, rawDestination);
  const relativePath = path.relative(localWorkspace, absolutePath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return failure({
      code: "invalid_local_destination",
      message: "The local artifact destination must stay inside the workspace.",
    });
  }

  const components = relativePath.split(path.sep);
  let currentPath = localWorkspace;
  for (const component of components) {
    currentPath = path.join(currentPath, component);
    if (!existsSync(currentPath)) {
      continue;
    }
    if (lstatSync(currentPath).isSymbolicLink()) {
      return failure({
        code: "invalid_local_destination",
        message: `The local artifact destination crosses the symbolic link '${currentPath}'.`,
      });
    }
  }

  const destinationExists = existsSync(absolutePath);
  if (destinationExists) {
    if (!lstatSync(absolutePath).isDirectory()) {
      return failure({
        code: "invalid_local_destination",
        message: "The local artifact destination exists and is not a directory.",
      });
    }
    if (!overwrite) {
      return failure({
        code: "destination_exists",
        message:
          "The local artifact destination exists. Set overwrite to true to use it.",
      });
    }
    const symbolicLink = findFirstSymbolicLink(absolutePath);
    if (symbolicLink !== undefined) {
      return failure({
        code: "invalid_local_destination",
        message: `The local artifact destination contains the symbolic link '${symbolicLink}'.`,
      });
    }
  }

  return success({
    absolutePath,
    relativePath: relativePath.split(path.sep).join("/"),
    createdByFetch: !destinationExists,
  });
}

function buildArtifactValidationCommand(
  remoteWorkspace: string,
  remotePath: string,
): string {
  const absoluteTarget = path.posix.join(remoteWorkspace, remotePath);
  const componentChecks: string[] = [];
  let currentPath = remoteWorkspace;
  for (const component of remotePath.split("/")) {
    currentPath = path.posix.join(currentPath, component);
    componentChecks.push(
      `[ ! -L ${quoteForPosixShell(currentPath)} ] || { printf 'symbolic_link\\n'; exit 0; }`,
    );
  }
  const script = [
    `[ -e ${quoteForPosixShell(absoluteTarget)} ] || { printf 'not_found\\n'; exit 0; }`,
    ...componentChecks,
    `if [ -d ${quoteForPosixShell(absoluteTarget)} ] && [ -n "$(find ${quoteForPosixShell(absoluteTarget)} -type l -print -quit 2>/dev/null)" ]; then`,
    `  printf 'symbolic_link\\n'`,
    `  exit 0`,
    `fi`,
    `printf 'ok\\n'`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

function parseArtifactValidationProtocol(
  output: string,
): Result<"ok" | "not_found" | "symbolic_link", string> {
  const result = output.trim();
  if (
    result === "ok" ||
    result === "not_found" ||
    result === "symbolic_link"
  ) {
    return success(result);
  }
  return failure(`The artifact validation protocol is invalid: ${output}`);
}

async function hashFetchedArtifacts(
  localWorkspace: string,
  localDestination: string,
  remotePaths: readonly string[],
): Promise<
  Result<
    {
      readonly files: readonly FetchedArtifact[];
      readonly totalBytes: number;
    },
    string
  >
> {
  try {
    const filePaths = new Set<string>();
    for (const remotePath of remotePaths) {
      collectRegularFiles(
        path.join(localDestination, ...remotePath.split("/")),
        filePaths,
      );
    }

    const artifacts: FetchedArtifact[] = [];
    let totalBytes = 0;
    for (const filePath of [...filePaths].sort()) {
      const stats = statSync(filePath);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
      }
      totalBytes += stats.size;
      artifacts.push({
        path: path.relative(localWorkspace, filePath).split(path.sep).join("/"),
        sizeBytes: stats.size,
        sha256: hash.digest("hex"),
      });
    }
    return success({
      files: Object.freeze(artifacts),
      totalBytes,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`The fetched artifacts could not be hashed: ${message}`);
  }
}

function collectRegularFiles(
  filePath: string,
  outputPaths: Set<string>,
): void {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`The fetched artifact '${filePath}' is a symbolic link.`);
  }
  if (stats.isFile()) {
    outputPaths.add(filePath);
    return;
  }
  if (!stats.isDirectory()) {
    throw new Error(`The fetched artifact '${filePath}' is not a regular file.`);
  }
  const entries = readdirSync(filePath, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    collectRegularFiles(path.join(filePath, entry.name), outputPaths);
  }
}

function findFirstSymbolicLink(directory: string): string | undefined {
  const entries = readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nestedLink = findFirstSymbolicLink(entryPath);
      if (nestedLink !== undefined) {
        return nestedLink;
      }
    }
  }
  return undefined;
}

function parseActiveJobIdentifiers(output: string): readonly string[] {
  const identifiers = output
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => JOB_IDENTIFIER_PATTERN.test(value));
  return Object.freeze([...new Set(identifiers)].sort());
}

function parseProtocolValues(output: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of output.trimEnd().split("\n")) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    values[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
  }
  return values;
}

function isIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().startsWith(value.slice(0, 19));
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function emptySerializableProcessOutcome(): SerializableProcessOutcome {
  const emptyOutput: CapturedOutput = {
    text: "",
    totalBytes: 0,
    omittedBytes: 0,
    sha256: createHash("sha256").digest("hex"),
  };
  return {
    kind: "unknown_termination",
    stdout: emptyOutput,
    stderr: emptyOutput,
    durationMilliseconds: 0,
  };
}

class WorkspaceQueue {
  readonly #pendingByWorkspace = new Map<string, Promise<void>>();

  async run<Value>(
    workspace: string,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const previous = this.#pendingByWorkspace.get(workspace) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.#pendingByWorkspace.set(workspace, completion);

    try {
      return await result;
    } finally {
      if (this.#pendingByWorkspace.get(workspace) === completion) {
        this.#pendingByWorkspace.delete(workspace);
      }
    }
  }
}

function rootWarning(target: string): string {
  return `The remote compute user is root (uid 0) on ${target}. Run compute_run through a dedicated non-root SSH user so a compromised build cannot control the whole node.`;
}

export function parseRemoteRelativePath(
  rawPath: string,
): Result<string, string> {
  if (
    rawPath.length === 0 ||
    rawPath.includes("\0") ||
    rawPath.includes("\\") ||
    path.posix.isAbsolute(rawPath)
  ) {
    return failure("The remote working directory must be a relative POSIX path.");
  }

  const normalizedPath = path.posix.normalize(rawPath);
  if (normalizedPath === ".." || normalizedPath.startsWith("../")) {
    return failure("The remote working directory cannot leave the workspace.");
  }

  return success(normalizedPath);
}

export function quoteForPosixShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function toSerializableProcessOutcome(
  outcome: ProcessOutcome,
): SerializableProcessOutcome {
  switch (outcome.kind) {
    case "completed":
      return outcome;
    case "signaled":
      return outcome;
    case "timed_out":
      return outcome;
    case "cancelled":
      return outcome;
    case "unknown_termination":
      return outcome;
    case "spawn_error":
      return { ...outcome, code: outcome.code ?? null };
  }
}

function buildRemoteProbeCommand(
  remoteShellPreference: RemoteShellPreference,
): string {
  const script = [
    `requested_shell=${quoteForPosixShell(remoteShellPreference)}`,
    `platform=$(/usr/bin/uname -s 2>/dev/null || /bin/uname -s 2>/dev/null)`,
    `case "$platform" in`,
    `  Darwin) default_shell=/bin/zsh ;;`,
    `  Linux)`,
    `    if [ -x /bin/bash ]; then`,
    `      default_shell=/bin/bash`,
    `    else`,
    `      default_shell=/bin/sh`,
    `    fi`,
    `    ;;`,
    `  *)`,
    `    printf 'platform=%s\\n' "$platform"`,
    `    printf 'probeError=Unsupported remote platform: %s\\n' "$platform"`,
    `    exit 0`,
    `    ;;`,
    `esac`,
    `if [ "$requested_shell" = auto ]; then`,
    `  selected_shell=$default_shell`,
    `else`,
    `  selected_shell=$requested_shell`,
    `fi`,
    `if [ ! -x "$selected_shell" ]; then`,
    `  printf 'platform=%s\\n' "$platform"`,
    `  printf 'probeError=The selected remote shell is not executable: %s\\n' "$selected_shell"`,
    `  exit 0`,
    `fi`,
    `printf 'platform=%s\\n' "$platform"`,
    `printf 'hostname=%s\\n' "$(hostname)"`,
    `printf 'architecture=%s\\n' "$(uname -m)"`,
    `printf 'shell=%s\\n' "$selected_shell"`,
    `printf 'rsyncVersion=%s\\n' "$(rsync --version | sed -n '1p')"`,
    `printf 'uid=%s\\n' "$(id -u 2>/dev/null || /usr/bin/id -u 2>/dev/null)"`,
    `case "$platform" in`,
    `  Darwin)`,
    `    printf 'productName=%s\\n' "$(/usr/bin/sw_vers -productName)"`,
    `    printf 'productVersion=%s\\n' "$(/usr/bin/sw_vers -productVersion)"`,
    `    printf 'buildVersion=%s\\n' "$(/usr/bin/sw_vers -buildVersion)"`,
    `    printf 'processor=%s\\n' "$(/usr/sbin/sysctl -n machdep.cpu.brand_string)"`,
    `    printf 'logicalProcessors=%s\\n' "$(/usr/sbin/sysctl -n hw.logicalcpu)"`,
    `    printf 'memoryBytes=%s\\n' "$(/usr/sbin/sysctl -n hw.memsize)"`,
    `    ;;`,
    `  Linux)`,
    `    distribution_name=Linux`,
    `    distribution_version=unknown`,
    `    if [ -r /etc/os-release ]; then`,
    `      . /etc/os-release`,
    `      distribution_name=\${PRETTY_NAME:-\${NAME:-Linux}}`,
    `      distribution_version=\${VERSION_ID:-unknown}`,
    `    fi`,
    `    processor=$(LC_ALL=C lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | sed -n '1p')`,
    `    if [ -z "$processor" ] && [ -r /proc/cpuinfo ]; then`,
    `      processor=$(awk -F: '/^(model name|Hardware)[[:space:]]*:/{sub(/^[[:space:]]*/, "", $2); print $2; exit}' /proc/cpuinfo)`,
    `    fi`,
    `    if [ -z "$processor" ]; then`,
    `      processor=$(uname -m)`,
    `    fi`,
    `    printf 'distributionName=%s\\n' "$distribution_name"`,
    `    printf 'distributionVersion=%s\\n' "$distribution_version"`,
    `    printf 'kernelVersion=%s\\n' "$(uname -r)"`,
    `    printf 'processor=%s\\n' "$processor"`,
    `    printf 'logicalProcessors=%s\\n' "$(getconf _NPROCESSORS_ONLN)"`,
    `    printf 'memoryKilobytes=%s\\n' "$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo)"`,
    `    if command -v nvidia-smi >/dev/null 2>&1; then`,
    `      nvidia_output=$(nvidia-smi --query-gpu=index,name,uuid,memory.total,driver_version --format=csv,noheader,nounits 2>&1)`,
    `      nvidia_status=$?`,
    `      if [ "$nvidia_status" -eq 0 ]; then`,
    `        printf '%s\\n' "$nvidia_output" | while IFS= read -r accelerator; do`,
    `          if [ -n "$accelerator" ]; then`,
    `            printf 'nvidia=%s\\n' "$accelerator"`,
    `          fi`,
    `        done`,
    `      else`,
    `        printf 'acceleratorError=nvidia-smi failed: %s\\n' "$(printf '%s\\n' "$nvidia_output" | sed -n '1p')"`,
    `      fi`,
    `    fi`,
    `    ;;`,
    `esac`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

function nodeHealthPlatformCommands(
  platform: RemoteHardware["platform"],
): readonly string[] {
  switch (platform) {
    case "darwin":
      return [
        `boot_epoch=$(/usr/sbin/sysctl -n kern.boottime | sed -n 's/^{ sec = \\([0-9][0-9]*\\),.*/\\1/p')`,
        `current_epoch=$(date +%s)`,
        `uptime_seconds=$((current_epoch - boot_epoch))`,
        `set -- $(/usr/sbin/sysctl -n vm.loadavg | tr -d '{}')`,
        `load_one=$1`,
        `load_five=$2`,
        `load_fifteen=$3`,
        `page_size=$(/usr/sbin/sysctl -n hw.pagesize)`,
        `available_memory_bytes=$(vm_stat | awk -v page_size="$page_size" '/Pages (free|inactive|speculative|purgeable):/{gsub(/\\./, "", $3); pages += $3} END{printf "%.0f", pages * page_size}')`,
      ];
    case "linux":
      return [
        `uptime_seconds=$(awk '{printf "%d", $1}' /proc/uptime)`,
        `set -- $(cat /proc/loadavg)`,
        `load_one=$1`,
        `load_five=$2`,
        `load_fifteen=$3`,
        `available_memory_bytes=$(awk '/^MemAvailable:/{printf "%.0f", $2 * 1024; exit}' /proc/meminfo)`,
      ];
  }
}

function buildNodeHealthCommand(
  remoteRoot: string,
  jobsRoot: string,
  platform: RemoteHardware["platform"],
): string {
  const platformCommands = nodeHealthPlatformCommands(platform);
  const script = [
    "set -u",
    `remote_root=${quoteForPosixShell(remoteRoot)}`,
    `jobs_root=${quoteForPosixShell(jobsRoot)}`,
    ...platformCommands,
    `disk_path=$remote_root`,
    `while [ ! -e "$disk_path" ]; do`,
    `  parent_path=$(dirname "$disk_path")`,
    `  if [ "$parent_path" = "$disk_path" ]; then disk_path=.; break; fi`,
    `  disk_path=$parent_path`,
    `done`,
    `set -- $(df -Pk "$disk_path" | awk 'NR == 2 {print $2, $4}')`,
    `disk_total_bytes=$(($1 * 1024))`,
    `disk_available_bytes=$(($2 * 1024))`,
    `active_job_count=0`,
    `if [ -d "$jobs_root" ]; then`,
    `  for job_directory in "$jobs_root"/*; do`,
    `    [ -d "$job_directory" ] || continue`,
    `    state=$(cat "$job_directory/state" 2>/dev/null || true)`,
    `    case "$state" in`,
    `      starting) process_id=$(cat "$job_directory/launcher-pid" 2>/dev/null || true) ;;`,
    `      running) process_id=$(cat "$job_directory/process-group-id" 2>/dev/null || true) ;;`,
    `      *) continue ;;`,
    `    esac`,
    `    case "$process_id" in ''|*[!0-9]*) continue ;; esac`,
    `    if [ "$state" = running ]; then`,
    `      kill -0 -- "-$process_id" 2>/dev/null || continue`,
    `    else`,
    `      kill -0 "$process_id" 2>/dev/null || continue`,
    `    fi`,
    `    active_job_count=$((active_job_count + 1))`,
    `  done`,
    `fi`,
    `if command -v nvidia-smi >/dev/null 2>&1; then`,
    `  nvidia_usage=$(nvidia-smi --query-gpu=index,uuid,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits 2>&1)`,
    `  nvidia_status=$?`,
    `  if [ "$nvidia_status" -eq 0 ]; then`,
    `    printf 'acceleratorUsage=nvidia\\n'`,
    `    printf '%s\\n' "$nvidia_usage" | while IFS= read -r usage_row; do`,
    `      [ -z "$usage_row" ] || printf 'nvidiaUsage=%s\\n' "$usage_row"`,
    `    done`,
    `  else`,
    `    printf 'acceleratorUsage=error\\n'`,
    `    printf 'acceleratorError=nvidia-smi failed: %s\\n' "$(printf '%s\\n' "$nvidia_usage" | sed -n '1p')"`,
    `  fi`,
    `else`,
    `  printf 'acceleratorUsage=none\\n'`,
    `fi`,
    `printf 'checkedAt=%s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"`,
    `printf 'uptimeSeconds=%s\\n' "$uptime_seconds"`,
    `printf 'loadOne=%s\\n' "$load_one"`,
    `printf 'loadFive=%s\\n' "$load_five"`,
    `printf 'loadFifteen=%s\\n' "$load_fifteen"`,
    `printf 'availableMemoryBytes=%s\\n' "$available_memory_bytes"`,
    `printf 'diskTotalBytes=%s\\n' "$disk_total_bytes"`,
    `printf 'diskAvailableBytes=%s\\n' "$disk_available_bytes"`,
    `printf 'activeJobCount=%s\\n' "$active_job_count"`,
  ].join("\n");
  return `/bin/sh -c ${quoteForPosixShell(script)}`;
}

function parseAcceleratorUsageProtocol(
  output: string,
  values: Readonly<Record<string, string>>,
): Result<AcceleratorUsage, string> {
  const usageRows = output
    .trimEnd()
    .split("\n")
    .filter((line) => line.startsWith("nvidiaUsage="))
    .map((line) => line.slice("nvidiaUsage=".length));
  switch (values["acceleratorUsage"]) {
    case "none":
      if (usageRows.length !== 0) {
        return failure("A node without NVIDIA usage contains device rows.");
      }
      return success({ kind: "none" });
    case "error": {
      const message = values["acceleratorError"];
      if (message === undefined || message.length === 0) {
        return failure("The NVIDIA usage error is missing.");
      }
      return success({ kind: "error", message });
    }
    case "nvidia": {
      if (usageRows.length === 0) {
        return failure("The NVIDIA usage report has no devices.");
      }
      const devices: NvidiaAcceleratorUsage[] = [];
      const indexes = new Set<number>();
      const uuids = new Set<string>();
      for (const row of usageRows) {
        const fields = row.split(",").map((field) => field.trim());
        if (fields.length !== 5) {
          return failure(`The NVIDIA usage row is invalid: ${row}`);
        }
        const [rawIndex, uuid, rawUsedMebibytes, rawFreeMebibytes, rawUtilization] =
          fields;
        const index = Number(rawIndex);
        const usedMebibytes = Number(rawUsedMebibytes);
        const freeMebibytes = Number(rawFreeMebibytes);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          uuid === undefined ||
          uuid.length === 0 ||
          !Number.isFinite(usedMebibytes) ||
          usedMebibytes < 0 ||
          !Number.isFinite(freeMebibytes) ||
          freeMebibytes < 0 ||
          rawUtilization === undefined ||
          indexes.has(index) ||
          uuids.has(uuid)
        ) {
          return failure(`The NVIDIA usage row is invalid: ${row}`);
        }
        const memoryUsedBytes = usedMebibytes * 1_048_576;
        const memoryAvailableBytes = freeMebibytes * 1_048_576;
        if (
          !Number.isSafeInteger(memoryUsedBytes) ||
          !Number.isSafeInteger(memoryAvailableBytes)
        ) {
          return failure(`The NVIDIA memory usage is invalid: ${row}`);
        }
        const normalizedUtilization = rawUtilization.toUpperCase();
        let utilization: NvidiaAcceleratorUsage["utilization"];
        if (
          normalizedUtilization === "N/A" ||
          normalizedUtilization === "[N/A]"
        ) {
          utilization = { kind: "unavailable" };
        } else {
          utilization = {
            kind: "reported",
            percent: Number(rawUtilization),
          };
        }
        if (
          utilization.kind === "reported" &&
          (!Number.isFinite(utilization.percent) ||
            utilization.percent < 0 ||
            utilization.percent > 100)
        ) {
          return failure(`The NVIDIA utilization is invalid: ${row}`);
        }
        indexes.add(index);
        uuids.add(uuid);
        devices.push({
          kind: "nvidia",
          index,
          uuid,
          memoryUsedBytes,
          memoryAvailableBytes,
          utilization,
        });
      }
      return success({ kind: "nvidia", devices: Object.freeze(devices) });
    }
    case undefined:
    default:
      return failure("The accelerator usage kind is invalid.");
  }
}

export function parseNodeHealthProtocol(
  output: string,
): Result<RemoteNodeHealth, string> {
  const values = parseProtocolValues(output);
  const acceleratorUsageResult = parseAcceleratorUsageProtocol(output, values);
  const checkedAt = values["checkedAt"];
  const uptimeSeconds = Number(values["uptimeSeconds"]);
  const oneMinute = Number(values["loadOne"]);
  const fiveMinutes = Number(values["loadFive"]);
  const fifteenMinutes = Number(values["loadFifteen"]);
  const availableMemoryBytes = Number(values["availableMemoryBytes"]);
  const totalBytes = Number(values["diskTotalBytes"]);
  const availableBytes = Number(values["diskAvailableBytes"]);
  const activeJobCount = Number(values["activeJobCount"]);
  const integerValues = [
    uptimeSeconds,
    availableMemoryBytes,
    totalBytes,
    availableBytes,
    activeJobCount,
  ];
  const loadValues = [oneMinute, fiveMinutes, fifteenMinutes];
  if (
    !acceleratorUsageResult.ok ||
    checkedAt === undefined ||
    !isIsoTimestamp(checkedAt) ||
    integerValues.some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    loadValues.some((value) => !Number.isFinite(value) || value < 0) ||
    availableBytes > totalBytes
  ) {
    return failure(`The node health protocol is invalid. Raw output:\n${output}`);
  }
  return success({
    checkedAt,
    uptimeSeconds,
    loadAverage: { oneMinute, fiveMinutes, fifteenMinutes },
    availableMemoryBytes,
    remoteRootStorage: { totalBytes, availableBytes },
    acceleratorUsage: acceleratorUsageResult.value,
    activeJobCount,
  });
}

export function parseRemoteHardware(
  probeOutput: string,
): Result<RemoteHardware, string> {
  const values: Record<string, string> = {};
  const nvidiaRows: string[] = [];
  for (const line of probeOutput.trimEnd().split("\n")) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    if (key === "nvidia") {
      nvidiaRows.push(value);
    } else {
      values[key] = value;
    }
  }

  const probeError = values["probeError"];
  if (probeError !== undefined && probeError.length > 0) {
    return failure(probeError);
  }

  const platform = values["platform"];
  const hostname = values["hostname"];
  const architecture = values["architecture"];
  const processor = values["processor"];
  const shell = values["shell"];
  const rsyncVersion = values["rsyncVersion"];
  const logicalProcessors = Number(values["logicalProcessors"]);
  const uid = Number(values["uid"]);

  if (
    hostname === undefined ||
    hostname.length === 0 ||
    architecture === undefined ||
    architecture.length === 0 ||
    processor === undefined ||
    processor.length === 0 ||
    !isRemoteShellPath(shell) ||
    rsyncVersion === undefined ||
    rsyncVersion.length === 0 ||
    !Number.isSafeInteger(logicalProcessors) ||
    logicalProcessors < 1 ||
    !Number.isSafeInteger(uid) ||
    uid < 0
  ) {
    return failure(
      `The remote hardware probe returned incomplete common data. Raw output:\n${probeOutput}`,
    );
  }

  const isRoot = uid === 0;

  const acceleratorInventory = parseAcceleratorInventory(
    nvidiaRows,
    values["acceleratorError"],
  );

  switch (platform) {
    case "Darwin": {
      const productName = values["productName"];
      const productVersion = values["productVersion"];
      const buildVersion = values["buildVersion"];
      const memoryBytes = Number(values["memoryBytes"]);
      if (
        productName === undefined ||
        productName.length === 0 ||
        productVersion === undefined ||
        productVersion.length === 0 ||
        buildVersion === undefined ||
        buildVersion.length === 0 ||
        !Number.isSafeInteger(memoryBytes) ||
        memoryBytes < 1
      ) {
        return failure(
          `The Darwin hardware probe returned incomplete data. Raw output:\n${probeOutput}`,
        );
      }

      return success({
        platform: "darwin",
        hostname,
        productName,
        productVersion,
        buildVersion,
        architecture,
        processor,
        logicalProcessors,
        memoryBytes,
        shell,
        rsyncVersion,
        uid,
        isRoot,
        acceleratorInventory,
      });
    }
    case "Linux": {
      const distributionName = values["distributionName"];
      const distributionVersion = values["distributionVersion"];
      const kernelVersion = values["kernelVersion"];
      const memoryKilobytes = Number(values["memoryKilobytes"]);
      const memoryBytes = memoryKilobytes * 1_024;
      if (
        distributionName === undefined ||
        distributionName.length === 0 ||
        distributionVersion === undefined ||
        distributionVersion.length === 0 ||
        kernelVersion === undefined ||
        kernelVersion.length === 0 ||
        !Number.isSafeInteger(memoryKilobytes) ||
        memoryKilobytes < 1 ||
        !Number.isSafeInteger(memoryBytes)
      ) {
        return failure(
          `The Linux hardware probe returned incomplete data. Raw output:\n${probeOutput}`,
        );
      }

      return success({
        platform: "linux",
        hostname,
        distributionName,
        distributionVersion,
        kernelVersion,
        architecture,
        processor,
        logicalProcessors,
        memoryBytes,
        shell,
        rsyncVersion,
        uid,
        isRoot,
        acceleratorInventory,
      });
    }
    default:
      return failure(
        `The remote platform '${platform ?? "missing"}' is not supported.`,
      );
  }
}

function parseAcceleratorInventory(
  nvidiaRows: readonly string[],
  acceleratorError: string | undefined,
): AcceleratorInventory {
  if (acceleratorError !== undefined && acceleratorError.length > 0) {
    return { kind: "error", message: acceleratorError };
  }

  if (nvidiaRows.length === 0) {
    return { kind: "none" };
  }

  const devices: NvidiaAccelerator[] = [];
  for (const row of nvidiaRows) {
    const fields = row.split(",").map((field) => field.trim());
    if (fields.length < 5) {
      return {
        kind: "error",
        message: `nvidia-smi returned an invalid inventory row: ${row}`,
      };
    }

    const indexText = fields[0];
    const driverVersion = fields.at(-1);
    const memoryMebibytesText = fields.at(-2);
    const uuid = fields.at(-3);
    const name = fields.slice(1, -3).join(", ");
    const index = Number(indexText);
    const memoryBytes = Number(memoryMebibytesText) * 1_024 * 1_024;
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      name.length === 0 ||
      uuid === undefined ||
      uuid.length === 0 ||
      driverVersion === undefined ||
      driverVersion.length === 0 ||
      !Number.isSafeInteger(memoryBytes) ||
      memoryBytes < 1
    ) {
      return {
        kind: "error",
        message: `nvidia-smi returned an invalid inventory row: ${row}`,
      };
    }

    devices.push({
      kind: "nvidia",
      index,
      name,
      uuid,
      memoryBytes,
      driverVersion,
    });
  }

  return { kind: "nvidia", devices };
}

function isRemoteShellPath(value: string | undefined): value is RemoteShellPath {
  return (
    value === "/bin/sh" ||
    value === "/bin/bash" ||
    value === "/bin/zsh"
  );
}

function buildRemoteProgramCommand(
  remoteWorkingDirectory: string,
  program: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
  shell: RemoteShellPath,
  marker: string,
): string {
  const environmentAssignments = Object.entries(environment)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => quoteForPosixShell(`${key}=${value}`));
  const commandParts = [
    "/usr/bin/env",
    ...environmentAssignments,
    quoteForPosixShell(program),
    ...arguments_.map(quoteForPosixShell),
  ];
  const script = [
    `cd -- ${quoteForPosixShell(remoteWorkingDirectory)}`,
    "exit_code=$?",
    `if [ "$exit_code" -eq 0 ]; then`,
    `  ${commandParts.join(" ")}`,
    "  exit_code=$?",
    "fi",
    `printf '\\n%s%s\\n' ${quoteForPosixShell(marker)} "$exit_code" >&2`,
    "exit 0",
  ].join("\n");
  return wrapInRemoteLoginShell(script, shell);
}

function wrapInRemoteLoginShell(
  script: string,
  shell: RemoteShellPath,
): string {
  return `${shell} -lc ${quoteForPosixShell(script)}`;
}

function extractRemoteCommandResult(
  stderr: CapturedOutput,
  marker: string,
  prefixDigest: PrefixDigest | undefined,
): Result<{ readonly exitCode: number; readonly stderr: CapturedOutput }, string> {
  const markerStart = stderr.text.lastIndexOf(`\n${marker}`);
  if (markerStart === -1) {
    return failure(
      "The SSH command ended without a remote exit marker. The connection or remote login shell ended before the command completed.",
    );
  }

  const protocolSuffix = stderr.text.slice(markerStart);
  const exitCodeText = protocolSuffix.slice(marker.length + 1).trimEnd();
  if (!/^\d{1,3}$/.test(exitCodeText)) {
    return failure("The remote exit marker contains an invalid exit code.");
  }

  const exitCode = Number(exitCodeText);
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    return failure("The remote exit marker contains an exit code outside 0 through 255.");
  }

  const protocolSuffixBytes = Buffer.byteLength(protocolSuffix, "utf8");
  const userStderrBytes = Math.max(
    0,
    stderr.totalBytes - protocolSuffixBytes,
  );
  if (
    prefixDigest === undefined ||
    prefixDigest.totalBytes !== userStderrBytes
  ) {
    return failure("The remote exit marker digest is missing or inconsistent.");
  }
  return success({
    exitCode,
    stderr: {
      text: stderr.text.slice(0, markerStart),
      totalBytes: prefixDigest.totalBytes,
      omittedBytes: stderr.omittedBytes,
      sha256: prefixDigest.sha256,
    },
  });
}
