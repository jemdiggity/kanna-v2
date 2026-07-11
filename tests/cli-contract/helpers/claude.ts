import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { ClaudeResult } from "./claude-availability";
import { assertLiveAgentCliContractsEnabled } from "./live-contract-guard";

export { isClaudeUnavailable, type ClaudeResult } from "./claude-availability";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function runProcess(
  binary: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd ?? "/tmp",
      env: { ...process.env, ...opts.env },
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
    }, opts.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/**
 * Find the claude binary.
 */
export async function findClaudeBinary(): Promise<string> {
  assertLiveAgentCliContractsEnabled();
  const home = process.env.HOME || "";
  const candidates = [
    `${home}/.local/bin/claude`,
    "/usr/local/bin/claude",
    `${home}/.npm/bin/claude`,
  ];
  for (const p of candidates) {
    if (await pathExists(p)) return p;
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
  const binary = await findClaudeBinary();
  const args = [
    "-p", opts.prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--max-turns", "1",
    ...(opts.flags || []),
  ];

  const start = Date.now();
  const { stdout: stdoutBuf, stderr: stderrBuf, exitCode } = await runProcess(binary, args, {
    cwd: opts.cwd ?? "/tmp",
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 30000,
  });

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
 * Run claude CLI in stream-json input mode, delivering messages over stdin.
 *
 * In this mode the CLI ignores any `-p` prompt argument: the prompt must be
 * written to stdin as `{"type":"user","message":{"role":"user","content":...}}`.
 * Stdin is closed after the lines are written; the CLI drains queued
 * messages before exiting on EOF.
 */
export async function runClaudeStreamInput(opts: {
  stdinLines: string[];
  flags?: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<ClaudeResult> {
  const binary = await findClaudeBinary();
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--max-turns", "1",
    ...(opts.flags || []),
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
      stdio: ["pipe", "pipe", "pipe"],
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

    for (const line of opts.stdinLines) {
      child.stdin?.write(`${line}\n`);
    }
    child.stdin?.end();

    const timer = setTimeout(() => {
      child.kill();
    }, opts.timeoutMs ?? 60000);

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

/**
 * Run claude CLI with raw flags (no --output-format, no -p).
 * For testing flag validation and error cases.
 */
export async function runClaudeRaw(args: string[], opts?: {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binary = await findClaudeBinary();
  return await runProcess(binary, args, {
    cwd: opts?.cwd ?? "/tmp",
    env: opts?.env,
    timeoutMs: opts?.timeoutMs ?? 15000,
  });
}
