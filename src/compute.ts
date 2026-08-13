import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type {
  ComputeConfiguration,
  RemoteShellPreference,
} from "./config.js";
import {
  runProcess,
  type CapturedOutput,
  type ProcessOutcome,
} from "./process.js";
import { failure, success, type Result } from "./result.js";

const PROCESS_OUTPUT_LIMIT_BYTES = 262_144;
const SYNC_OUTPUT_LIMIT_BYTES = 131_072;
const MINIMUM_PREPARE_TIMEOUT_MILLISECONDS = 15_000;
const MAXIMUM_WORKSPACE_SLUG_LENGTH = 48;

const SYNC_EXCLUSIONS = [
  ".git/",
  ".env",
  ".env.*",
  ".npmrc",
  ".pypirc",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "node_modules/",
  ".venv/",
  "venv/",
  "target/",
  "__pycache__/",
  ".next/cache/",
] as const;

export const DEFAULT_SYNC_FILTER_ARGUMENTS: readonly string[] = Object.freeze([
  "--filter=:- .gitignore",
  "--filter=:- .tailscale-compute-ignore",
  ...SYNC_EXCLUSIONS.flatMap((pattern) => ["--exclude", pattern]),
]);

export type SyncMode = "incremental" | "clean" | "none";
export type RunStage = "probe" | "prepare" | "sync" | "command";
export type RemoteShellPath = "/bin/sh" | "/bin/bash" | "/bin/zsh";

export interface WorkspaceLocation {
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

export type StatusOutcome =
  | {
      readonly kind: "ready";
      readonly target: string;
      readonly remoteRoot: string;
      readonly remoteWorkspace: string;
      readonly hardware: RemoteHardware;
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

export interface RemoteRunRequest {
  readonly workspacePath: string | undefined;
  readonly program: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  readonly syncMode: SyncMode;
  readonly standardInput: string | undefined;
  readonly timeoutSeconds: number;
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
    }
  | {
      readonly kind: "workspace_error";
      readonly error: WorkspaceError;
    }
  | {
      readonly kind: "stage_failed";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly stage: RunStage;
      readonly process: SerializableProcessOutcome;
    }
  | {
      readonly kind: "protocol_error";
      readonly target: string;
      readonly remoteWorkspace: string;
      readonly message: string;
      readonly process: SerializableProcessOutcome;
    };

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

    return {
      kind: "ready",
      target: this.#configuration.target.destination,
      remoteRoot: this.#configuration.remoteRoot,
      remoteWorkspace: workspaceResult.value.remotePath,
      hardware: hardwareResult.value,
      durationMilliseconds: probeProcess.durationMilliseconds,
    };
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
    return await this.#workspaceQueue.run(workspace.remotePath, async () =>
      this.runInWorkspace(
        request,
        workspace,
        relativeDirectoryResult.value,
      ),
    );
  }

  private async runInWorkspace(
    request: RemoteRunRequest,
    workspace: WorkspaceLocation,
    workingDirectory: string,
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
      return this.stageFailure("probe", workspace, probeProcess);
    }

    const hardwareResult = parseRemoteHardware(probeProcess.stdout.text);
    if (!hardwareResult.ok) {
      return {
        kind: "protocol_error",
        target: this.#configuration.target.destination,
        remoteWorkspace: workspace.remotePath,
        message: hardwareResult.error,
        process: toSerializableProcessOutcome(probeProcess),
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
        return this.stageFailure("prepare", workspace, prepareProcess);
      }

      const syncProcess = await this.syncWorkspace(
        workspace,
        timeoutMilliseconds,
        request.signal,
      );
      syncDurationMilliseconds += syncProcess.durationMilliseconds;
      if (syncProcess.kind !== "completed" || syncProcess.exitCode !== 0) {
        return this.stageFailure("sync", workspace, syncProcess);
      }
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
    );

    if (commandProcess.kind !== "completed" || commandProcess.exitCode !== 0) {
      return this.stageFailure("command", workspace, commandProcess);
    }

    const commandResult = extractRemoteCommandResult(commandProcess.stderr, marker);
    if (!commandResult.ok) {
      return {
        kind: "protocol_error",
        target: this.#configuration.target.destination,
        remoteWorkspace: workspace.remotePath,
        message: commandResult.error,
        process: toSerializableProcessOutcome(commandProcess),
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
    const exclusionArguments = DEFAULT_SYNC_FILTER_ARGUMENTS;
    const remoteShell = [
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

    return await runProcess({
      executable: "rsync",
      arguments: [
        "-rlpt",
        "--delete",
        ...exclusionArguments,
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

  private async runSsh(
    remoteCommand: string,
    standardInput: string | undefined,
    timeoutMilliseconds: number,
    outputLimitBytes: number,
    signal: AbortSignal | undefined,
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
    const remotePath = path.posix.join(
      this.#configuration.remoteRoot,
      `${workspaceName}-${workspaceHash}`,
    );

    return success({ localPath, remotePath });
  }

  private stageFailure(
    stage: RunStage,
    workspace: WorkspaceLocation,
    processOutcome: ProcessOutcome,
  ): RemoteRunOutcome {
    return {
      kind: "stage_failed",
      target: this.#configuration.target.destination,
      remoteWorkspace: workspace.remotePath,
      stage,
      process: toSerializableProcessOutcome(processOutcome),
    };
  }

  private prepareTimeoutMilliseconds(): number {
    return Math.max(
      MINIMUM_PREPARE_TIMEOUT_MILLISECONDS,
      (this.#configuration.connectTimeoutSeconds + 5) * 1_000,
    );
  }
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
    logicalProcessors < 1
  ) {
    return failure(
      `The remote hardware probe returned incomplete common data. Raw output:\n${probeOutput}`,
    );
  }

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
    `printf '\\n${marker}%d\\n' "$exit_code" >&2`,
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
  return success({
    exitCode,
    stderr: {
      text: stderr.text.slice(0, markerStart),
      totalBytes: Math.max(0, stderr.totalBytes - protocolSuffixBytes),
      omittedBytes: stderr.omittedBytes,
    },
  });
}
