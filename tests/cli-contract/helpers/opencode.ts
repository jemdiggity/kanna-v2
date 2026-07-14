import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { assertLiveAgentCliContractsEnabled } from "./live-contract-guard";

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
  },
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

export async function findOpenCodeBinary(): Promise<string> {
  assertLiveAgentCliContractsEnabled();
  const home = process.env.HOME || "";
  const candidates = [
    `${home}/.opencode/bin/opencode`,
    `${home}/.local/bin/opencode`,
    "/usr/local/bin/opencode",
    `${home}/.npm/bin/opencode`,
    "/opt/homebrew/bin/opencode",
  ];
  for (const p of candidates) {
    if (await pathExists(p)) return p;
  }
  throw new Error("opencode binary not found. Install: curl -fsSL https://opencode.ai/install | bash");
}

export async function runOpenCodeRaw(args: string[], opts?: {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binary = await findOpenCodeBinary();
  return await runProcess(binary, args, {
    cwd: opts?.cwd ?? "/tmp",
    env: opts?.env,
    timeoutMs: opts?.timeoutMs ?? 15000,
  });
}

export async function runOpenCodeJson(opts: {
  prompt: string;
  flags?: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  lines: Array<Record<string, unknown>>;
}> {
  const result = await runOpenCodeRaw([
    "run",
    "--format",
    "json",
    "--dangerously-skip-permissions",
    "--dir",
    opts.cwd ?? "/tmp",
    ...(opts.flags || []),
    opts.prompt,
  ], {
    cwd: opts.cwd ?? "/tmp",
    timeoutMs: opts.timeoutMs ?? 120000,
  });

  const lines: Array<Record<string, unknown>> = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lines.push(JSON.parse(trimmed));
  }

  return { ...result, lines };
}
