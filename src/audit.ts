import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface AuditEntry {
  readonly timestamp: string;
  readonly target: string;
  readonly remoteWorkspace: string;
  readonly localWorkspace: string;
  readonly program: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly syncMode: string;
  readonly outcomeKind: string;
  readonly exitCode: number | undefined;
  readonly stage: string | undefined;
}

export type AuditWriteResult =
  | { readonly kind: "appended" }
  | { readonly kind: "failed"; readonly message: string };

export function writeAuditEntry(
  logPath: string,
  entry: AuditEntry,
): AuditWriteResult {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
    return { kind: "appended" };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", message };
  }
}
