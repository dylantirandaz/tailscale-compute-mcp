import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";

import { parseTailscaleTarget } from "./config.js";

const OMP_CONFIGURATION_SCHEMA =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
const OMP_SERVER_NAME = "tailscale-compute";
const PACKAGE_NAME = "@dylantirandaz/tailscale-compute-mcp";
const OMP_FLEET_SKILL_NAME = "tailscale-compute-fleet";
const OMP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const MANAGED_SKILL_FRONTMATTER_LINE = `managedBy: "${PACKAGE_NAME}"`;

interface JsonObject {
  readonly [key: string]: unknown;
}

export interface OmpSetupRequest {
  readonly homeDirectory: string;
  readonly target: string | undefined;
  readonly packageVersion: string;
  readonly serverName?: string;
  readonly skillContent: string;
}

export type OmpSetupOutcome =
  | {
      readonly kind: "configured";
      readonly path: string;
      readonly skillPath: string;
      readonly serverName: string;
      readonly restartRequired: true;
    }
  | {
      readonly kind: "already_configured";
      readonly path: string;
      readonly skillPath: string;
      readonly serverName: string;
    }
  | {
      readonly kind: "refused";
      readonly path: string;
      readonly skillPath: string;
      readonly reason:
        | "invalid_target"
        | "invalid_home_directory"
        | "invalid_server_name"
        | "invalid_configuration"
        | "invalid_skill_content"
        | "symbolic_link"
        | "server_name_conflict"
        | "skill_name_conflict";
      readonly message: string;
    }
  | {
      readonly kind: "failed";
      readonly path: string;
      readonly skillPath: string;
      readonly message: string;
    };

export type ConfigurationClient =
  | "claude"
  | "cursor"
  | "codex"
  | "opencode";

export interface ClientConfigurationRequest {
  readonly client: ConfigurationClient;
  readonly target: string;
  readonly packageVersion: string;
}

export type ClientConfigurationOutcome =
  | {
      readonly kind: "rendered";
      readonly client: ConfigurationClient;
      readonly format: "shell" | "json" | "toml";
      readonly content: string;
    }
  | {
      readonly kind: "invalid_target";
      readonly message: string;
    };

export function renderClientConfiguration(
  request: ClientConfigurationRequest,
): ClientConfigurationOutcome {
  const targetResult = parseTailscaleTarget(request.target);
  if (!targetResult.ok) {
    return {
      kind: "invalid_target",
      message: targetResult.error.message,
    };
  }
  const target = targetResult.value.destination;
  const packageSpecifier = `${PACKAGE_NAME}@${request.packageVersion}`;
  switch (request.client) {
    case "claude":
      return {
        kind: "rendered",
        client: request.client,
        format: "shell",
        content: [
          "claude mcp add --scope user",
          `  --env TAILSCALE_COMPUTE_HOST=${target}`,
          "  --transport stdio tailscale-compute",
          `  -- npx -y ${packageSpecifier}`,
        ].join(" \\\n"),
      };
    case "cursor":
      return {
        kind: "rendered",
        client: request.client,
        format: "json",
        content: JSON.stringify(
          {
            mcpServers: {
              [OMP_SERVER_NAME]: {
                command: "npx",
                args: ["-y", packageSpecifier],
                env: { TAILSCALE_COMPUTE_HOST: target },
              },
            },
          },
          null,
          2,
        ),
      };
    case "codex":
      return {
        kind: "rendered",
        client: request.client,
        format: "toml",
        content: [
          `[mcp_servers.${OMP_SERVER_NAME}]`,
          'command = "npx"',
          `args = ["-y", ${JSON.stringify(packageSpecifier)}]`,
          "",
          `[mcp_servers.${OMP_SERVER_NAME}.env]`,
          `TAILSCALE_COMPUTE_HOST = ${JSON.stringify(target)}`,
        ].join("\n"),
      };
    case "opencode":
      return {
        kind: "rendered",
        client: request.client,
        format: "json",
        content: JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            mcp: {
              [OMP_SERVER_NAME]: {
                type: "local",
                command: ["npx", "-y", packageSpecifier],
                environment: { TAILSCALE_COMPUTE_HOST: target },
              },
            },
          },
          null,
          2,
        ),
      };
  }
}

export function ompUserConfigurationPath(homeDirectory: string): string {
  return path.join(homeDirectory, ".omp", "agent", "mcp.json");
}
export function ompUserSkillPath(homeDirectory: string): string {
  return path.join(
    homeDirectory,
    ".omp",
    "agent",
    "skills",
    OMP_FLEET_SKILL_NAME,
    "SKILL.md",
  );
}

export function setupOmpUserConfiguration(
  request: OmpSetupRequest,
): OmpSetupOutcome {
  const configurationPath = ompUserConfigurationPath(request.homeDirectory);
  const skillPath = ompUserSkillPath(request.homeDirectory);
  const serverName = request.serverName ?? OMP_SERVER_NAME;
  if (!path.isAbsolute(request.homeDirectory)) {
    return {
      kind: "refused",
      path: configurationPath,
      skillPath,
      reason: "invalid_home_directory",
      message: "The home directory must be an absolute path.",
    };
  }
  if (!OMP_SERVER_NAME_PATTERN.test(serverName)) {
    return {
      kind: "refused",
      path: configurationPath,
      skillPath,
      reason: "invalid_server_name",
      message:
        "The OMP server name must contain 1 through 100 letters, numbers, underscores, periods, or hyphens.",
    };
  }
  if (!isPackageManagedFleetSkill(request.skillContent)) {
    return {
      kind: "refused",
      path: configurationPath,
      skillPath,
      reason: "invalid_skill_content",
      message: "The packaged Tailscale Compute fleet skill is invalid.",
    };
  }
  if (request.target === undefined) {
    return {
      kind: "refused",
      path: configurationPath,
      skillPath,
      reason: "invalid_target",
      message:
        "Set TAILSCALE_COMPUTE_HOST before you run the OMP setup command.",
    };
  }
  const targetResult = parseTailscaleTarget(request.target);
  if (!targetResult.ok) {
    return {
      kind: "refused",
      path: configurationPath,
      skillPath,
      reason: "invalid_target",
      message: targetResult.error.message,
    };
  }

  let existingConfigurationText: string | undefined;
  let existingSkillText: string | undefined;
  try {
    const configurationStatus = lstatSync(configurationPath, {
      throwIfNoEntry: false,
    });
    if (configurationStatus?.isSymbolicLink() === true) {
      return {
        kind: "refused",
        path: configurationPath,
        skillPath,
        reason: "symbolic_link",
        message: "The OMP MCP configuration path is a symbolic link.",
      };
    }
    existingConfigurationText =
      configurationStatus === undefined
        ? undefined
        : readFileSync(configurationPath, "utf8");

    const skillStatus = lstatSync(skillPath, { throwIfNoEntry: false });
    if (skillStatus?.isSymbolicLink() === true) {
      return {
        kind: "refused",
        path: configurationPath,
        skillPath,
        reason: "symbolic_link",
        message: "The OMP fleet skill path is a symbolic link.",
      };
    }
    existingSkillText =
      skillStatus === undefined ? undefined : readFileSync(skillPath, "utf8");
  } catch (error: unknown) {
    return failedOutcome(configurationPath, skillPath, error);
  }

  const configurationResult = parseExistingConfiguration(
    existingConfigurationText,
  );
  if (!configurationResult.ok) {
    return {
      kind: "refused",
      path: configurationPath,
      skillPath,
      reason: "invalid_configuration",
      message: configurationResult.message,
    };
  }

  const serverDefinition = {
    type: "stdio",
    command: "npx",
    args: ["-y", `${PACKAGE_NAME}@${request.packageVersion}`],
    env: {
      TAILSCALE_COMPUTE_HOST: targetResult.value.destination,
    },
  };
  const existingServer = configurationResult.mcpServers[serverName];
  if (
    existingServer !== undefined &&
    !isDeepStrictEqual(existingServer, serverDefinition)
  ) {
    return {
      kind: "refused",
      path: configurationPath,
      skillPath,
      reason: "server_name_conflict",
      message: `The OMP MCP configuration already contains a different '${serverName}' server. No file was changed.`,
    };
  }

  const configurationNeedsWrite = existingServer === undefined;
  const skillNeedsWrite = existingSkillText !== request.skillContent;
  if (
    skillNeedsWrite &&
    existingSkillText !== undefined &&
    !isPackageManagedFleetSkill(existingSkillText)
  ) {
    return {
      kind: "refused",
      path: configurationPath,
      skillPath,
      reason: "skill_name_conflict",
      message:
        "The OMP skill directory already contains an unmanaged tailscale-compute-fleet skill. No file was changed.",
    };
  }
  if (!configurationNeedsWrite && !skillNeedsWrite) {
    return {
      kind: "already_configured",
      path: configurationPath,
      skillPath,
      serverName,
    };
  }

  const nextConfiguration = {
    ...configurationResult.root,
    $schema:
      configurationResult.root["$schema"] ?? OMP_CONFIGURATION_SCHEMA,
    mcpServers: {
      ...configurationResult.mcpServers,
      [serverName]: serverDefinition,
    },
  };
  const configurationDirectory = path.dirname(configurationPath);
  const skillDirectory = path.dirname(skillPath);
  const uniqueSuffix = `${process.pid}-${randomUUID()}`;
  const configurationTemporaryPath = `${configurationPath}.${uniqueSuffix}.tmp`;
  const skillTemporaryPath = `${skillPath}.${uniqueSuffix}.tmp`;
  let skillWasReplaced = false;
  try {
    if (configurationNeedsWrite) {
      mkdirSync(configurationDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(
        configurationTemporaryPath,
        `${JSON.stringify(nextConfiguration, null, 2)}\n`,
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );
    }
    if (skillNeedsWrite) {
      mkdirSync(skillDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(skillTemporaryPath, request.skillContent, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    if (skillNeedsWrite) {
      renameSync(skillTemporaryPath, skillPath);
      skillWasReplaced = true;
    }
    if (configurationNeedsWrite) {
      renameSync(configurationTemporaryPath, configurationPath);
    }
  } catch (error: unknown) {
    removeTemporaryFile(configurationTemporaryPath);
    removeTemporaryFile(skillTemporaryPath);
    let rollbackError: unknown;
    if (skillWasReplaced) {
      try {
        if (existingSkillText === undefined) {
          rmSync(skillPath, { force: true });
        } else {
          writeFileSync(skillTemporaryPath, existingSkillText, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          renameSync(skillTemporaryPath, skillPath);
        }
      } catch (caughtRollbackError: unknown) {
        rollbackError = caughtRollbackError;
      }
    }
    if (rollbackError !== undefined) {
      return failedOutcome(
        configurationPath,
        skillPath,
        new Error(
          `Setup failed: ${errorMessage(error)} Skill rollback also failed: ${errorMessage(rollbackError)}`,
        ),
      );
    }
    return failedOutcome(configurationPath, skillPath, error);
  }
  return {
    kind: "configured",
    path: configurationPath,
    skillPath,
    serverName,
    restartRequired: true,
  };
}

function isPackageManagedFleetSkill(content: string): boolean {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    return false;
  }
  let hasExpectedName = false;
  let hasManagedMarker = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "---") {
      return hasExpectedName && hasManagedMarker;
    }
    if (line === `name: ${OMP_FLEET_SKILL_NAME}`) {
      hasExpectedName = true;
    }
    if (line === MANAGED_SKILL_FRONTMATTER_LINE) {
      hasManagedMarker = true;
    }
  }
  return false;
}

type ParsedExistingConfiguration =
  | {
      readonly ok: true;
      readonly root: JsonObject;
      readonly mcpServers: JsonObject;
    }
  | { readonly ok: false; readonly message: string };

function parseExistingConfiguration(
  text: string | undefined,
): ParsedExistingConfiguration {
  if (text === undefined) {
    return { ok: true, root: {}, mcpServers: {} };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `The existing OMP MCP configuration is not JSON: ${message}`,
    };
  }
  if (!isJsonObject(value)) {
    return {
      ok: false,
      message: "The existing OMP MCP configuration must be a JSON object.",
    };
  }
  const rawSchema = value["$schema"];
  if (rawSchema !== undefined && typeof rawSchema !== "string") {
    return {
      ok: false,
      message: "The $schema field must be a string.",
    };
  }
  const rawMcpServers = value["mcpServers"];
  if (rawMcpServers === undefined) {
    return { ok: true, root: value, mcpServers: {} };
  }
  if (!isJsonObject(rawMcpServers)) {
    return {
      ok: false,
      message: "The mcpServers field must be a JSON object.",
    };
  }
  return { ok: true, root: value, mcpServers: rawMcpServers };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function removeTemporaryFile(pathname: string): void {
  try {
    rmSync(pathname, { force: true });
  } catch {
    return;
  }
}

function failedOutcome(
  configurationPath: string,
  skillPath: string,
  error: unknown,
): OmpSetupOutcome {
  return {
    kind: "failed",
    path: configurationPath,
    skillPath,
    message: errorMessage(error),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
