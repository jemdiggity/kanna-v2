import { spawn } from "node:child_process";
import { assertLiveAgentCliContractsEnabled } from "./live-contract-guard";

export interface CodexResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  lines: Array<Record<string, unknown>>;
  duration: number;
}

/**
 * Find the codex binary by asking the login shell, falling back to PATH.
 * Codex installs via npm, so its location follows the active node manager.
 */
export async function findCodexBinary(): Promise<string> {
  assertLiveAgentCliContractsEnabled();
  const fromShell = await new Promise<string>((resolve) => {
    const child = spawn("/bin/zsh", ["-lc", "command -v codex"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
  if (fromShell) return fromShell;
  return "codex";
}

/**
 * Run `codex exec --json` and capture the JSONL event stream.
 */
export async function runCodexExec(opts: {
  prompt: string;
  flags?: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<CodexResult> {
  const binary = await findCodexBinary();
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    ...(opts.flags || []),
    opts.prompt,
  ];

  const start = Date.now();
  const { stdout, stderr, exitCode } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd ?? "/tmp",
      env: process.env,
      // codex exec reads piped stdin to EOF before starting — keep it closed.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
    });
    child.on("error", reject);

    const timer = setTimeout(() => {
      child.kill();
    }, opts.timeoutMs ?? 120000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: code ?? -1 });
    });
  });

  const lines: Array<Record<string, unknown>> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // Not JSON — skip
    }
  }

  return { stdout, stderr, exitCode, lines, duration: Date.now() - start };
}

export async function runCodexRaw(args: string[], opts?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binary = await findCodexBinary();
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts?.cwd ?? "/tmp",
      env: { ...process.env, ...opts?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);

    const timer = setTimeout(() => {
      child.kill();
    }, opts?.timeoutMs ?? 30_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
