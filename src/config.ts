import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

import { failure, success, type Result } from "./result.js";

const DEFAULT_REMOTE_ROOT = ".cache/tailscale-compute-mcp";
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const MINIMUM_CONNECT_TIMEOUT_SECONDS = 1;
const MAXIMUM_CONNECT_TIMEOUT_SECONDS = 60;
const DEFAULT_AUDIT_LOG_PATH = path.join(
  os.homedir(),
  ".config",
  "tailscale-compute-mcp",
  "compute-audit.log",
);

export interface TailscaleTarget {
  readonly destination: string;
  readonly host: string;
}

export type RemoteShellPreference =
  | "auto"
  | "/bin/sh"
  | "/bin/bash"
  | "/bin/zsh";

export interface ComputeConfiguration {
  readonly target: TailscaleTarget;
  readonly remoteRoot: string;
  readonly defaultWorkspace: string | undefined;
  readonly remoteShell: RemoteShellPreference;
  readonly connectTimeoutSeconds: number;
  readonly auditLogPath: string;
}

export type ConfigurationErrorCode =
  | "missing_target"
  | "invalid_target"
  | "invalid_remote_root"
  | "invalid_local_root"
  | "invalid_remote_shell"
  | "invalid_connect_timeout";

export interface ConfigurationError {
  readonly code: ConfigurationErrorCode;
  readonly message: string;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export function parseConfiguration(
  environment: Environment,
): Result<ComputeConfiguration, ConfigurationError> {
  const rawTarget = environment["TAILSCALE_COMPUTE_HOST"];
  if (rawTarget === undefined || rawTarget.trim().length === 0) {
    return failure({
      code: "missing_target",
      message:
        "Set TAILSCALE_COMPUTE_HOST to a Tailscale IPv4 address or a full .ts.net name. You can add the remote user, for example user@100.64.0.1.",
    });
  }

  const targetResult = parseTailscaleTarget(rawTarget);
  if (!targetResult.ok) {
    return targetResult;
  }

  const rawRemoteRoot =
    environment["TAILSCALE_COMPUTE_REMOTE_ROOT"] ?? DEFAULT_REMOTE_ROOT;
  const remoteRootResult = parseRemoteRoot(rawRemoteRoot);
  if (!remoteRootResult.ok) {
    return remoteRootResult;
  }

  const rawDefaultWorkspace = environment["TAILSCALE_COMPUTE_LOCAL_ROOT"];
  const defaultWorkspaceResult = parseDefaultWorkspace(rawDefaultWorkspace);
  if (!defaultWorkspaceResult.ok) {
    return defaultWorkspaceResult;
  }

  const remoteShellResult = parseRemoteShell(
    environment["TAILSCALE_COMPUTE_REMOTE_SHELL"],
  );
  if (!remoteShellResult.ok) {
    return remoteShellResult;
  }

  const rawConnectTimeout =
    environment["TAILSCALE_COMPUTE_CONNECT_TIMEOUT_SECONDS"];
  const connectTimeoutResult = parseConnectTimeout(rawConnectTimeout);
  if (!connectTimeoutResult.ok) {
    return connectTimeoutResult;
  }

  const auditLogPath = parseAuditLogPath(
    environment["TAILSCALE_COMPUTE_AUDIT_LOG"],
  );

  return success({
    target: targetResult.value,
    remoteRoot: remoteRootResult.value,
    defaultWorkspace: defaultWorkspaceResult.value,
    remoteShell: remoteShellResult.value,
    connectTimeoutSeconds: connectTimeoutResult.value,
    auditLogPath,
  });
}

function parseAuditLogPath(rawAuditLog: string | undefined): string {
  const trimmed = rawAuditLog?.trim() ?? "";
  return trimmed.length === 0 ? DEFAULT_AUDIT_LOG_PATH : trimmed;
}

export function parseTailscaleTarget(
  rawTarget: string,
): Result<TailscaleTarget, ConfigurationError> {
  const destination = rawTarget.trim();
  if (
    destination.startsWith("-") ||
    destination.includes("\0") ||
    destination.includes("\n") ||
    destination.includes("\r")
  ) {
    return invalidTarget(destination);
  }

  const atIndex = destination.lastIndexOf("@");
  const user = atIndex === -1 ? undefined : destination.slice(0, atIndex);
  const host = atIndex === -1 ? destination : destination.slice(atIndex + 1);

  if (
    (user !== undefined && !/^[A-Za-z_][A-Za-z0-9._-]*$/.test(user)) ||
    host.length === 0 ||
    host.includes("/") ||
    /[^A-Za-z0-9._:[\]]/.test(host) ||
    (host.includes(":") && !(host.startsWith("[") && host.endsWith("]")))
  ) {
    return invalidTarget(destination);
  }

  if (!isDirectTailscaleHost(host)) {
    return invalidTarget(destination);
  }

  return success({ destination, host });
}

export function isDirectTailscaleHost(host: string): boolean {
  const hostWithoutFinalDot = host.endsWith(".") ? host.slice(0, -1) : host;
  const lowerHost = hostWithoutFinalDot.toLowerCase();

  if (
    lowerHost.endsWith(".ts.net") &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/.test(lowerHost)
  ) {
    return true;
  }

  if (isIP(hostWithoutFinalDot) === 4) {
    const octets = hostWithoutFinalDot.split(".").map(Number);
    const firstOctet = octets[0];
    const secondOctet = octets[1];
    return (
      firstOctet === 100 &&
      secondOctet !== undefined &&
      secondOctet >= 64 &&
      secondOctet <= 127
    );
  }

  const unwrappedHost =
    lowerHost.startsWith("[") && lowerHost.endsWith("]")
      ? lowerHost.slice(1, -1)
      : lowerHost;
  return (
    isIP(unwrappedHost) === 6 && unwrappedHost.startsWith("fd7a:115c:a1e0:")
  );
}

function parseRemoteRoot(
  rawRemoteRoot: string,
): Result<string, ConfigurationError> {
  const remoteRoot = rawRemoteRoot.trim();
  const pathSegments = remoteRoot.split("/");
  const hasInvalidSegment = pathSegments.some(
    (segment) => segment === ".." || segment === ".",
  );

  if (
    remoteRoot.length === 0 ||
    remoteRoot === "/" ||
    remoteRoot.startsWith("-") ||
    hasInvalidSegment ||
    !/^\/?[A-Za-z0-9._/-]+$/.test(remoteRoot)
  ) {
    return failure({
      code: "invalid_remote_root",
      message:
        "TAILSCALE_COMPUTE_REMOTE_ROOT must be a safe absolute path or a path relative to the remote home directory. Do not use spaces, '.' segments, or '..' segments.",
    });
  }

  return success(path.posix.normalize(remoteRoot));
}

function parseDefaultWorkspace(
  rawDefaultWorkspace: string | undefined,
): Result<string | undefined, ConfigurationError> {
  if (rawDefaultWorkspace === undefined) {
    return success(undefined);
  }

  const defaultWorkspace = rawDefaultWorkspace.trim();
  if (!path.isAbsolute(defaultWorkspace)) {
    return failure({
      code: "invalid_local_root",
      message: "TAILSCALE_COMPUTE_LOCAL_ROOT must be an absolute path.",
    });
  }

  return success(defaultWorkspace);
}

function parseRemoteShell(
  rawRemoteShell: string | undefined,
): Result<RemoteShellPreference, ConfigurationError> {
  const remoteShell = rawRemoteShell ?? "auto";
  switch (remoteShell) {
    case "auto":
    case "/bin/sh":
    case "/bin/bash":
    case "/bin/zsh":
      return success(remoteShell);
    default:
      return failure({
        code: "invalid_remote_shell",
        message:
          "TAILSCALE_COMPUTE_REMOTE_SHELL must be auto, /bin/sh, /bin/bash, or /bin/zsh.",
      });
  }
}

function parseConnectTimeout(
  rawConnectTimeout: string | undefined,
): Result<number, ConfigurationError> {
  if (rawConnectTimeout === undefined) {
    return success(DEFAULT_CONNECT_TIMEOUT_SECONDS);
  }

  if (!/^\d+$/.test(rawConnectTimeout)) {
    return invalidConnectTimeout();
  }

  const connectTimeoutSeconds = Number(rawConnectTimeout);
  if (
    !Number.isSafeInteger(connectTimeoutSeconds) ||
    connectTimeoutSeconds < MINIMUM_CONNECT_TIMEOUT_SECONDS ||
    connectTimeoutSeconds > MAXIMUM_CONNECT_TIMEOUT_SECONDS
  ) {
    return invalidConnectTimeout();
  }

  return success(connectTimeoutSeconds);
}

function invalidTarget(target: string): Result<never, ConfigurationError> {
  return failure({
    code: "invalid_target",
    message: `The target '${target}' is not a direct Tailscale node. Use a 100.64.0.0/10 address, a Tailscale IPv6 address, or a full .ts.net name.`,
  });
}

function invalidConnectTimeout(): Result<never, ConfigurationError> {
  return failure({
    code: "invalid_connect_timeout",
    message: `TAILSCALE_COMPUTE_CONNECT_TIMEOUT_SECONDS must be an integer from ${MINIMUM_CONNECT_TIMEOUT_SECONDS} through ${MAXIMUM_CONNECT_TIMEOUT_SECONDS}.`,
  });
}
