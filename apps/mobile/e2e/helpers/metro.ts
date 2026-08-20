import { execFile, spawn, type ChildProcess } from "node:child_process";
import { processIdentity, processInventoryPath, recordInventoryResource, removeInventoryResource, terminateInventoryProcess } from "../../../../tools/kd/src/runtime/process-inventory";
import { resolve } from "node:path";
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
  requireExactEnvironment?: boolean;
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
    requireExactEnvironment?: boolean;
  }
): boolean {
  if (existing.cwd !== expected.projectRoot) {
    return false;
  }

  if (!existing.commandLine.includes("expo")) {
    return false;
  }

  if (
    existing.commandLine.includes("--dev-client") &&
    !expected.requireExactEnvironment
  ) {
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

export function buildExpoStartCommand(
  port: number,
  options: { clearCache?: boolean } = {}
): string[] {
  return [
    "pnpm",
    "exec",
    "expo",
    "start",
    "--port",
    String(port),
    "--dev-client",
    ...(options.clearCache ? ["--clear"] : [])
  ];
}

export async function ensureExpoServer(
  options: EnsureExpoServerOptions
): Promise<ExpoServerHandle> {
  const expoEnv = {
    EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED: "1",
    ...options.env
  };
  const existingPid = await findListeningProcessPid(options.metroPort);
  if (existingPid !== null) {
    const existing = await inspectRunningExpoProcess(existingPid);
    if (
      existing &&
      shouldReuseExpoServer(existing, {
        env: expoEnv,
        projectRoot: options.projectRoot,
        requireExactEnvironment: options.requireExactEnvironment
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

    throw new Error(
      `Metro port ${options.metroPort} is held by a process that this run did not start; run ./kd dev down instead of killing an inferred owner.`
    );
  }

  const child = spawn(
    "pnpm",
    buildExpoStartCommand(options.metroPort, {
      clearCache: options.requireExactEnvironment
    }),
    {
      cwd: options.projectRoot,
      env: {
        ...process.env,
        CI: "1",
        ...expoEnv
      },
      stdio: "inherit"
    }
  );
  const inventoryPath = processInventoryPath(resolve(options.projectRoot, "../.."));
  const resource = child.pid
    ? recordInventoryResource(inventoryPath, { kind: "process" as const, pid: child.pid, label: "mobile-e2e-metro", identity: processIdentity(child.pid) })
    : undefined;

  await waitForExpoServer(options.metroPort);

  return {
    pid: child.pid ?? null,
    port: options.metroPort,
    reused: false,
    async stop() {
      if (!child.pid || child.killed) {
        return;
      }

      if (resource?.kind === "process") {
        const outcome = await terminateInventoryProcess(resource);
        if (outcome !== "failed") removeInventoryResource(inventoryPath, resource);
      }
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
