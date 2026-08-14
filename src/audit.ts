import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const AUDIT_DIRECTORY_MODE = 0o700;
const AUDIT_FILE_MODE = 0o600;

interface AuditBase {
  readonly timestamp: string;
  readonly target: string;
  readonly remoteWorkspace: string;
  readonly localWorkspace: string;
}

export type AuditEntry =
  | (AuditBase & {
      readonly operation: "run";
      readonly program: string;
      readonly arguments: readonly string[];
      readonly workingDirectory: string;
      readonly syncMode: string;
      readonly result:
        | { readonly kind: "completed"; readonly exitCode: number }
        | { readonly kind: "stage_failed"; readonly stage: string }
        | { readonly kind: "protocol_error" }
        | { readonly kind: "requirements_not_met" };
    })
  | (AuditBase & {
      readonly operation: "job_start";
      readonly jobId: string;
      readonly program: string;
      readonly arguments: readonly string[];
      readonly workingDirectory: string;
      readonly syncMode: string;
      readonly result:
        | { readonly kind: "started" }
        | { readonly kind: "stage_failed"; readonly stage: string }
        | { readonly kind: "protocol_error" }
        | { readonly kind: "requirements_not_met" };
    })
  | (AuditBase & {
      readonly operation: "fetch";
      readonly paths: readonly string[];
      readonly localDestination: string;
      readonly overwrite: boolean;
      readonly result:
        | { readonly kind: "completed" }
        | {
            readonly kind: "artifact_refused";
            readonly path: string;
            readonly reason: "not_found" | "symbolic_link";
          }
        | { readonly kind: "stage_failed"; readonly stage: string };
    })
  | (AuditBase & {
      readonly operation: "workspace_delete";
      readonly existed: boolean;
      readonly result: { readonly kind: "deleted" };
    });

export type AuditWriteResult =
  | { readonly kind: "appended" }
  | { readonly kind: "failed"; readonly message: string };

export function writeAuditEntry(
  logPath: string,
  entry: AuditEntry,
): AuditWriteResult {
  try {
    mkdirSync(path.dirname(logPath), {
      recursive: true,
      mode: AUDIT_DIRECTORY_MODE,
    });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: AUDIT_FILE_MODE,
    });
    return { kind: "appended" };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", message };
  }
}
