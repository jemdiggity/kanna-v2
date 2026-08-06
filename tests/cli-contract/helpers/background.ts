import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run a CLI without waiting for it, so a test can observe the files it writes
 * *while it is still running*. Several transfer behaviors — "is the transcript
 * on disk before exit?", "is the rollout complete before exit?" — are only
 * answerable mid-flight, which the existing run-to-completion helpers cannot do.
 */
export class BackgroundProcess {
  private readonly child: ChildProcess;
  private stdoutBuf = "";
  private stderrBuf = "";
  private closed = false;
  private code: number | null = null;
  readonly startedAt = Date.now();

  constructor(command: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) {
    this.child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      // Agent CLIs read piped stdin to EOF before starting — keep it closed.
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.stdoutBuf += chunk;
    });
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrBuf += chunk;
    });
    this.child.on("close", (exitCode) => {
      this.closed = true;
      this.code = exitCode ?? -1;
    });
  }

  get stdout(): string {
    return this.stdoutBuf;
  }

  get stderr(): string {
    return this.stderrBuf;
  }

  get running(): boolean {
    return !this.closed;
  }

  get exitCode(): number | null {
    return this.closed ? this.code : null;
  }

  /** JSON lines emitted on stdout so far. */
  jsonLines(): Array<Record<string, unknown>> {
    const lines: Array<Record<string, unknown>> = [];
    for (const line of this.stdoutBuf.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        lines.push(JSON.parse(trimmed));
      } catch {
        // Not JSON — skip.
      }
    }
    return lines;
  }

  async waitForExit(timeoutMs: number): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await sleep(100);
    }
    return this.exitCode;
  }

  kill(): void {
    if (!this.closed) this.child.kill("SIGKILL");
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A temp working directory with symlinks resolved. Claude derives its project
 * slug from `process.cwd()`, which is already physical — on macOS `/tmp/x` is
 * really `/private/tmp/x`, and the two slugs name different directories.
 */
export async function makeRealTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return await realpath(dir);
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}
