import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertLiveAgentCliContractsEnabled } from "./live-contract-guard";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findAntigravityBinary(): Promise<string> {
  assertLiveAgentCliContractsEnabled();
  const home = process.env.HOME ?? "";
  const candidates = [
    `${home}/.local/bin/agy`,
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy",
    `${home}/Library/Application Support/Antigravity/bin/agy`,
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error("agy binary not found");
}

export async function listAntigravityConversationIds(): Promise<Set<string>> {
  const home = process.env.HOME ?? "";
  const directory = join(home, ".gemini", "antigravity-cli", "conversations");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }

  return new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
      .map((entry) => basename(entry.name, ".db"))
      .filter((id) => UUID_PATTERN.test(id)),
  );
}

export async function runAntigravityPrint(
  prompt: string,
  opts?: {
    conversationId?: string;
    cwd?: string;
    timeoutMs?: number;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binary = await findAntigravityBinary();
  const args = [
    "--dangerously-skip-permissions",
    "--print-timeout",
    "2m",
    ...(opts?.conversationId
      ? ["--conversation", opts.conversationId]
      : []),
    "--print",
    prompt,
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts?.cwd ?? "/tmp",
      env: process.env,
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

    const timer = setTimeout(() => child.kill(), opts?.timeoutMs ?? 150_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
