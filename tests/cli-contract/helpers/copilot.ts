import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { assertLiveAgentCliContractsEnabled } from "./live-contract-guard";

export interface CopilotResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

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
 * Find the copilot binary.
 * Install methods: brew, curl installer (~/.local/bin), npm global.
 */
export async function findCopilotBinary(): Promise<string> {
  assertLiveAgentCliContractsEnabled();
  const home = process.env.HOME || "";
  const candidates = [
    `${home}/.local/bin/copilot`,
    "/usr/local/bin/copilot",
    `${home}/.npm/bin/copilot`,
    // Homebrew on Apple Silicon
    "/opt/homebrew/bin/copilot",
  ];
  for (const p of candidates) {
    if (await pathExists(p)) return p;
  }
  throw new Error(
    "copilot binary not found. Install: curl -fsSL https://gh.io/copilot-install | bash"
  );
}

/**
 * Run copilot CLI in programmatic mode (-p) and capture output.
 * Uses -p which runs the prompt and exits.
 */
export async function runCopilot(opts: {
  prompt: string;
  flags?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<CopilotResult> {
  const binary = await findCopilotBinary();
  const args = [
    "-p", opts.prompt,
    "--yolo",
    "--silent",
    ...(opts.flags || []),
  ];

  const start = Date.now();
  const { stdout, stderr, exitCode } = await runProcess(binary, args, {
    cwd: opts.cwd ?? "/tmp",
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });

  const duration = Date.now() - start;
  return { stdout, stderr, exitCode, duration };
}

/**
 * Run copilot CLI in interactive mode (-i) with an auto-executed prompt.
 * This simulates what Kanna does: spawn copilot in a PTY with a prompt
 * that auto-executes, then the user can continue interacting.
 * When stdin is null (piped), copilot runs the prompt and exits.
 */
export async function runCopilotInteractive(opts: {
  prompt: string;
  flags?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<CopilotResult> {
  const binary = await findCopilotBinary();
  const args = [
    "-i", opts.prompt,
    "--yolo",
    ...(opts.flags || []),
  ];

  const start = Date.now();
  const { stdout, stderr, exitCode } = await runProcess(binary, args, {
    cwd: opts.cwd ?? "/tmp",
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });

  const duration = Date.now() - start;
  return { stdout, stderr, exitCode, duration };
}

/**
 * Run copilot CLI with raw flags (no -p, no --yolo).
 * For testing flag validation and error cases.
 */
export async function runCopilotRaw(args: string[], opts?: {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binary = await findCopilotBinary();
  return await runProcess(binary, args, {
    cwd: opts?.cwd ?? "/tmp",
    env: opts?.env,
    timeoutMs: opts?.timeoutMs ?? 60_000,
  });
}
