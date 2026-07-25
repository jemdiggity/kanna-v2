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

/**
 * Resume an existing Codex thread through the headless JSON contract.
 */
export async function runCodexExecResume(opts: {
  sessionId: string;
  prompt: string;
  flags?: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<CodexResult> {
  const binary = await findCodexBinary();
  const args = [
    "exec",
    "resume",
    opts.sessionId,
    ...(opts.flags || []),
    "--dangerously-bypass-approvals-and-sandbox",
    "--json",
    opts.prompt,
  ];

  const start = Date.now();
  const result = await runCodexRaw(args, {
    cwd: opts.cwd ?? "/tmp",
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  const lines: Array<Record<string, unknown>> = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // Not JSON — skip.
    }
  }

  return { ...result, lines, duration: Date.now() - start };
}

/**
 * Run the interactive production resume command under a real PTY:
 * `codex resume <flags> <session-id> <prompt>`.
 *
 * Codex stays open after finishing a turn, so the harness tears the PTY down
 * after observing the expected response text.
 */
export async function runCodexPtyResume(opts: {
  sessionId: string;
  prompt: string;
  waitFor: string;
  flags?: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  matched: boolean;
  duration: number;
}> {
  if (process.platform !== "darwin") {
    throw new Error(
      "Codex production PTY resume contract currently requires macOS /usr/bin/script",
    );
  }
  const binary = await findCodexBinary();
  const args = [
    "-q",
    "/dev/null",
    binary,
    "resume",
    ...(opts.flags || []),
    opts.sessionId,
    opts.prompt,
  ];
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/script", args, {
      cwd: opts.cwd ?? "/tmp",
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: "120",
        LINES: "40",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let matched = false;
    let teardownStarted = false;
    const beginTeardown = () => {
      if (teardownStarted) return;
      teardownStarted = true;
      if (child.stdin?.writable) child.stdin.write("\x03");
      setTimeout(() => {
        if (child.stdin?.writable) child.stdin.write("\x04");
      }, 100);
      setTimeout(() => child.kill(), 1_000);
    };
    const observe = () => {
      if (!matched && `${stdout}\n${stderr}`.includes(opts.waitFor)) {
        matched = true;
        beginTeardown();
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdin?.on("error", () => {
      // The PTY may close between observing the nonce and the teardown keys.
    });
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      observe();
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      observe();
    });
    child.on("error", reject);

    const timer = setTimeout(beginTeardown, opts.timeoutMs ?? 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        matched,
        duration: Date.now() - start,
      });
    });
  });
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
