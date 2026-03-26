import { spawn } from "bun";

export interface CopilotResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

/**
 * Find the copilot binary.
 * Install methods: brew, curl installer (~/.local/bin), npm global.
 */
export function findCopilotBinary(): string {
  const home = process.env.HOME || "";
  const candidates = [
    `${home}/.local/bin/copilot`,
    "/usr/local/bin/copilot",
    `${home}/.npm/bin/copilot`,
    // Homebrew on Apple Silicon
    "/opt/homebrew/bin/copilot",
  ];
  for (const p of candidates) {
    if (Bun.file(p).size > 0) return p;
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
  const binary = findCopilotBinary();
  const args = [
    "-p", opts.prompt,
    "--yolo",
    "--silent",
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

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

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
  const binary = findCopilotBinary();
  const args = [
    "-i", opts.prompt,
    "--yolo",
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

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

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
  const binary = findCopilotBinary();
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

/**
 * Create a temp directory with git init and optional .github/hooks config.
 * Returns the path — caller is responsible for cleanup.
 */
export async function createHookTestDir(hookConfig: Record<string, unknown>): Promise<string> {
  const { mkdtemp, mkdir, writeFile } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const { join } = await import("path");

  const tmpDir = await mkdtemp(join(tmpdir(), "kanna-copilot-test-"));

  // git init so copilot recognizes the repo root
  await spawn({
    cmd: ["git", "init"],
    cwd: tmpDir,
    stdout: "ignore",
    stderr: "ignore",
  }).exited;

  // Write hook config to .github/hooks/kanna.json
  await mkdir(join(tmpDir, ".github", "hooks"), { recursive: true });
  await writeFile(
    join(tmpDir, ".github", "hooks", "kanna.json"),
    JSON.stringify(hookConfig, null, 2)
  );

  return tmpDir;
}
