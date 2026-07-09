import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { waitFor } from "./wait";

const execFileAsync = promisify(execFile);

export interface RunningExpoProcess {
  commandLine: string;
  cwd: string | null;
}

export interface ExpoServerHandle {
  pid: number | null;
  port: number;
  reused: boolean;
  stop(): Promise<void>;
}

interface EnsureExpoServerOptions {
  env?: Record<string, string>;
  metroPort: number;
  projectRoot: string;
}

export function extractEnvVarFromCommandLine(commandLine: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const segment of commandLine.split(/\s+/)) {
    const match = /^([A-Z0-9_]+)=(.+)$/.exec(segment);
    if (!match) {
      continue;
    }

    result[match[1]] = match[2];
  }

  return result;
}

export function shouldReuseExpoServer(
  existing: RunningExpoProcess,
  expected: {
    env?: Record<string, string>;
    projectRoot: string;
  }
): boolean {
  if (existing.cwd !== expected.projectRoot) {
    return false;
  }

  if (!existing.commandLine.includes("expo")) {
    return false;
  }

  if (existing.commandLine.includes("--dev-client")) {
    return true;
  }

  const existingEnv = extractEnvVarFromCommandLine(existing.commandLine);
  for (const [key, value] of Object.entries(expected.env ?? {})) {
    if (existingEnv[key] !== value) {
      return false;
    }
  }

  return true;
}

export function buildExpoStartCommand(port: number): string[] {
  return ["pnpm", "exec", "expo", "start", "--port", String(port), "--dev-client"];
}

export async function ensureExpoServer(
  options: EnsureExpoServerOptions
): Promise<ExpoServerHandle> {
  const existingPid = await findListeningProcessPid(options.metroPort);
  if (existingPid !== null) {
    const existing = await inspectRunningExpoProcess(existingPid);
    if (
      existing &&
      shouldReuseExpoServer(existing, {
        env: options.env,
        projectRoot: options.projectRoot
      })
    ) {
      await waitForExpoServer(options.metroPort);
      return {
        pid: existingPid,
        port: options.metroPort,
        reused: true,
        async stop() {}
      };
    }

    await terminateProcess(existingPid);
    await waitForPortToClear(options.metroPort);
  }

  const child = spawn("pnpm", buildExpoStartCommand(options.metroPort), {
    cwd: options.projectRoot,
    env: {
      ...process.env,
      CI: "1",
      EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED: "1",
      ...options.env
    },
    stdio: "inherit"
  });

  await waitForExpoServer(options.metroPort);

  return {
    pid: child.pid ?? null,
    port: options.metroPort,
    reused: false,
    async stop() {
      if (!child.pid || child.killed) {
        return;
      }

      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(() => resolve(), 2_000);
      });
    }
  };
}

async function findListeningProcessPid(port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-tiTCP:" + String(port),
      "-sTCP:LISTEN"
    ]);
    const pid = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

async function inspectRunningExpoProcess(pid: number): Promise<RunningExpoProcess | null> {
  try {
    const [{ stdout: commandLine }, { stdout: cwdOutput }] = await Promise.all([
      execFileAsync("ps", ["eww", "-o", "command=", "-p", String(pid)]),
      execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    ]);

    const cwdLine = cwdOutput
      .split("\n")
      .find((line) => line.startsWith("n"));

    return {
      commandLine: commandLine.trim(),
      cwd: cwdLine ? cwdLine.slice(1) : null
    };
  } catch {
    return null;
  }
}

async function terminateProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

async function waitForPortToClear(port: number): Promise<void> {
  await waitFor(
    `Metro port ${port} to clear`,
    async () => ((await findListeningProcessPid(port)) === null ? true : null),
    { intervalMs: 250, timeoutMs: 5_000 }
  );
}

async function waitForExpoServer(port: number): Promise<void> {
  await waitFor(
    `Expo Metro server on port ${port}`,
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`);
        if (!response.ok) {
          return null;
        }

        const body = await response.text();
        return body.includes("packager-status:running") ? true : null;
      } catch {
        return null;
      }
    },
    { intervalMs: 500, timeoutMs: 30_000 }
  );
}
