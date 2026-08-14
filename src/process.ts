import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface CapturedOutput {
  readonly text: string;
  readonly totalBytes: number;
  readonly omittedBytes: number;
  readonly sha256: string;
}

export interface PrefixDigest {
  readonly totalBytes: number;
  readonly sha256: string;
}

interface ProcessOutcomeBase {
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
  readonly durationMilliseconds: number;
  readonly stderrPrefixDigest?: PrefixDigest;
}

export type ProcessOutcome =
  | (ProcessOutcomeBase & {
      readonly kind: "completed";
      readonly exitCode: number;
    })
  | (ProcessOutcomeBase & {
      readonly kind: "signaled";
      readonly signal: NodeJS.Signals;
    })
  | (ProcessOutcomeBase & {
      readonly kind: "timed_out";
    })
  | (ProcessOutcomeBase & {
      readonly kind: "cancelled";
    })
  | (ProcessOutcomeBase & {
      readonly kind: "spawn_error";
      readonly message: string;
      readonly code: string | undefined;
    })
  | (ProcessOutcomeBase & {
      readonly kind: "unknown_termination";
    });

export interface ProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly standardInput?: string;
  readonly timeoutMilliseconds: number;
  readonly outputLimitBytes: number;
  readonly stderrDigestBoundary?: string;
  readonly signal?: AbortSignal;
}

type RequestedTermination = "timed_out" | "cancelled";

const FORCE_KILL_DELAY_MILLISECONDS = 2_000;

export async function runProcess(request: ProcessRequest): Promise<ProcessOutcome> {
  const startedAt = performance.now();
  const stdout = new BoundedOutputCollector(request.outputLimitBytes);
  const stderr = new BoundedOutputCollector(request.outputLimitBytes);

  if (request.signal?.aborted === true) {
    return {
      kind: "cancelled",
      stdout: stdout.capture(),
      stderr: stderr.capture(),
      durationMilliseconds: 0,
    };
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(request.executable, [...request.arguments], {
      ...(request.workingDirectory === undefined
        ? {}
        : { cwd: request.workingDirectory }),
      ...(request.environment === undefined
        ? {}
        : { env: request.environment }),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    const normalizedError = normalizeProcessError(error);
    return {
      kind: "spawn_error",
      message: normalizedError.message,
      code: normalizedError.code,
      stdout: stdout.capture(),
      stderr: stderr.capture(),
      durationMilliseconds: performance.now() - startedAt,
    };
  }

  return await new Promise<ProcessOutcome>((resolve) => {
    let requestedTermination: RequestedTermination | undefined;
    let emittedError: { readonly message: string; readonly code: string | undefined } | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    child.stdin.on("error", () => {
      // A child can close stdin before it exits. Its exit result is authoritative.
    });

    const requestTermination = (termination: RequestedTermination): void => {
      if (requestedTermination !== undefined) {
        return;
      }
      requestedTermination = termination;
      terminateProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL");
      }, FORCE_KILL_DELAY_MILLISECONDS);
      forceKillTimer.unref();
    };

    const abortListener = (): void => {
      requestTermination("cancelled");
    };
    request.signal?.addEventListener("abort", abortListener, { once: true });

    const timeoutTimer = setTimeout(() => {
      requestTermination("timed_out");
    }, request.timeoutMilliseconds);
    timeoutTimer.unref();

    child.on("error", (error: Error & { code?: string }) => {
      emittedError = { message: error.message, code: error.code };
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      request.signal?.removeEventListener("abort", abortListener);

      const stderrPrefixDigest =
        request.stderrDigestBoundary === undefined
          ? undefined
          : stderr.digestBeforeLast(request.stderrDigestBoundary);
      const commonResult = {
        stdout: stdout.capture(),
        stderr: stderr.capture(),
        durationMilliseconds: performance.now() - startedAt,
        ...(stderrPrefixDigest === undefined ? {} : { stderrPrefixDigest }),
      };

      if (emittedError !== undefined) {
        resolve({
          kind: "spawn_error",
          message: emittedError.message,
          code: emittedError.code,
          ...commonResult,
        });
        return;
      }

      if (requestedTermination === "timed_out") {
        resolve({ kind: "timed_out", ...commonResult });
        return;
      }

      if (requestedTermination === "cancelled") {
        resolve({ kind: "cancelled", ...commonResult });
        return;
      }

      if (exitCode !== null) {
        resolve({ kind: "completed", exitCode, ...commonResult });
        return;
      }

      if (signal !== null) {
        resolve({ kind: "signaled", signal, ...commonResult });
        return;
      }

      resolve({ kind: "unknown_termination", ...commonResult });
    });

    if (request.signal?.aborted === true) {
      abortListener();
    }

    if (request.standardInput === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(request.standardInput, "utf8");
    }
  });
}

class BoundedOutputCollector {
  readonly #headLimitBytes: number;
  readonly #tailLimitBytes: number;
  readonly #headChunks: Buffer[] = [];
  readonly #tailChunks: Buffer[] = [];
  readonly #hash = createHash("sha256");
  #hashTail = Buffer.alloc(0);
  #headBytes = 0;
  #tailBytes = 0;
  #totalBytes = 0;

  constructor(limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 2) {
      throw new Error("The process output limit must be an integer of at least 2 bytes.");
    }
    this.#headLimitBytes = Math.ceil(limitBytes / 2);
    this.#tailLimitBytes = Math.floor(limitBytes / 2);
  }

  append(chunk: Buffer): void {
    this.appendDigest(chunk);
    this.#totalBytes += chunk.byteLength;
    let remainingChunk = chunk;

    if (this.#headBytes < this.#headLimitBytes) {
      const availableHeadBytes = this.#headLimitBytes - this.#headBytes;
      const headByteCount = Math.min(availableHeadBytes, remainingChunk.byteLength);
      if (headByteCount > 0) {
        this.#headChunks.push(Buffer.from(remainingChunk.subarray(0, headByteCount)));
        this.#headBytes += headByteCount;
        remainingChunk = remainingChunk.subarray(headByteCount);
      }
    }

    if (remainingChunk.byteLength === 0 || this.#tailLimitBytes === 0) {
      return;
    }

    this.#tailChunks.push(Buffer.from(remainingChunk));
    this.#tailBytes += remainingChunk.byteLength;
    this.trimTail();
  }

  capture(): CapturedOutput {
    const omittedBytes = this.#totalBytes - this.#headBytes - this.#tailBytes;
    const headText = Buffer.concat(this.#headChunks, this.#headBytes).toString("utf8");
    const tailText = Buffer.concat(this.#tailChunks, this.#tailBytes).toString("utf8");
    const text =
      omittedBytes === 0
        ? `${headText}${tailText}`
        : `${headText}\n... ${omittedBytes} bytes omitted ...\n${tailText}`;

    return {
      text,
      totalBytes: this.#totalBytes,
      omittedBytes,
      sha256: this.#hash.copy().update(this.#hashTail).digest("hex"),
    };
  }

  digestBeforeLast(boundary: string): PrefixDigest | undefined {
    const boundaryBytes = Buffer.from(boundary, "utf8");
    const boundaryIndex = this.#hashTail.lastIndexOf(boundaryBytes);
    if (boundaryIndex < 0) {
      return undefined;
    }
    return {
      totalBytes:
        this.#totalBytes - (this.#hashTail.byteLength - boundaryIndex),
      sha256: this.#hash
        .copy()
        .update(this.#hashTail.subarray(0, boundaryIndex))
        .digest("hex"),
    };
  }

  private appendDigest(chunk: Buffer): void {
    const maximumTailBytes = 1_024;
    const combined = Buffer.concat(
      [this.#hashTail, chunk],
      this.#hashTail.byteLength + chunk.byteLength,
    );
    if (combined.byteLength <= maximumTailBytes) {
      this.#hashTail = combined;
      return;
    }
    const committedBytes = combined.byteLength - maximumTailBytes;
    this.#hash.update(combined.subarray(0, committedBytes));
    this.#hashTail = Buffer.from(combined.subarray(committedBytes));
  }

  private trimTail(): void {
    while (this.#tailBytes > this.#tailLimitBytes) {
      const firstChunk = this.#tailChunks[0];
      if (firstChunk === undefined) {
        throw new Error("The output tail byte count is not consistent with its chunks.");
      }

      const excessBytes = this.#tailBytes - this.#tailLimitBytes;
      if (firstChunk.byteLength <= excessBytes) {
        this.#tailChunks.shift();
        this.#tailBytes -= firstChunk.byteLength;
      } else {
        this.#tailChunks[0] = Buffer.from(firstChunk.subarray(excessBytes));
        this.#tailBytes -= excessBytes;
      }
    }
  }
}

function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    child.kill(signal);
  }
}

function normalizeProcessError(error: unknown): {
  readonly message: string;
  readonly code: string | undefined;
} {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string" ? error.code : undefined;
    return { message: error.message, code };
  }
  return { message: String(error), code: undefined };
}
