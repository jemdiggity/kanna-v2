import { spawn } from "bun";
import { resolve } from "path";

export interface ClaudeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  lines: Array<Record<string, unknown>>;
  duration: number;
}

/**
 * Find the claude binary.
 */
export function findClaudeBinary(): string {
  const home = process.env.HOME || "";
  const candidates = [
    `${home}/.local/bin/claude`,
    "/usr/local/bin/claude",
    `${home}/.npm/bin/claude`,
  ];
  for (const p of candidates) {
    if (Bun.file(p).size > 0) return p;
  }
  throw new Error("claude binary not found");
}

/**
 * Run claude CLI and capture structured output.
 */
export async function runClaude(opts: {
  prompt: string;
  flags?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<ClaudeResult> {
  const binary = findClaudeBinary();
  const args = [
    "-p", opts.prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--max-turns", "1",
    ...(opts.flags || []),
  ];

  const start = Date.now();
  const proc = spawn({
    cmd: [binary, ...args],
    cwd: opts.cwd || "/tmp",
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: null,
  });

  const timeout = opts.timeoutMs || 30000;
  const timer = setTimeout(() => proc.kill(), timeout);

  const [stdoutBuf, stderrBuf] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const duration = Date.now() - start;

  // Parse NDJSON lines
  const lines: Array<Record<string, unknown>> = [];
  for (const line of stdoutBuf.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // Not JSON — skip
    }
  }

  return { stdout: stdoutBuf, stderr: stderrBuf, exitCode, lines, duration };
}

/**
 * Run claude CLI with raw flags (no --output-format, no -p).
 * For testing flag validation and error cases.
 */
export async function runClaudeRaw(args: string[], opts?: {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binary = findClaudeBinary();
  const proc = spawn({
    cmd: [binary, ...args],
    cwd: opts?.cwd || "/tmp",
    env: { ...process.env, ...opts?.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: null,
  });

  const timeout = opts?.timeoutMs || 15000;
  const timer = setTimeout(() => proc.kill(), timeout);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return { stdout, stderr, exitCode };
}
