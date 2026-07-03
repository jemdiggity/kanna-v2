import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "./process";

export interface WorkspaceDaemonProcess {
  pid: number;
  command: string;
}

export interface KillWorkspaceDaemonsInput {
  repoRoot: string;
  daemonDir: string;
  runner: CommandRunner;
  readPidFile?: (pidFile: string) => number | undefined;
  killProcess?: (pid: number) => void;
}

export interface KillWorkspaceDaemonsResult {
  pidFileKilled?: number;
  orphanedKilled: WorkspaceDaemonProcess[];
}

function readPidFile(pidFile: string): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function defaultKillProcess(pid: number): void {
  process.kill(pid, "SIGTERM");
}

export function findWorkspaceDaemonProcesses(repoRoot: string, psOutput: string): WorkspaceDaemonProcess[] {
  return psOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): WorkspaceDaemonProcess | undefined => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      if (!match) {
        return undefined;
      }
      const pid = Number(match[1]);
      const command = match[2] ?? "";
      if (
        Number.isInteger(pid) &&
        command.includes(`${repoRoot}/.build/`) &&
        (command.includes("kanna-daemon") || command.includes("kanna-terminal-recovery"))
      ) {
        return { pid, command };
      }
      return undefined;
    })
    .filter((process): process is WorkspaceDaemonProcess => process !== undefined);
}

export interface KillWorkspaceServersInput {
  repoRoot: string;
  runner: CommandRunner;
  killProcess?: (pid: number) => void;
}

/** Workspace `kanna-server` processes spawned from this repo's build output. */
export function findWorkspaceServerProcesses(repoRoot: string, psOutput: string): WorkspaceDaemonProcess[] {
  return psOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): WorkspaceDaemonProcess | undefined => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      if (!match) {
        return undefined;
      }
      const pid = Number(match[1]);
      const command = match[2] ?? "";
      if (
        Number.isInteger(pid) &&
        command.includes(`${repoRoot}/.build/`) &&
        command.includes("kanna-server")
      ) {
        return { pid, command };
      }
      return undefined;
    })
    .filter((process): process is WorkspaceDaemonProcess => process !== undefined);
}

/**
 * Stop the workspace's kanna-server. Unlike the daemon (which deliberately
 * survives dev restarts to keep PTY sessions alive), kanna-server is
 * stateless HTTP over the DB and daemon — an orphaned instance keeps the
 * workspace port bound and silently serves a STALE binary across `kd dev
 * restart`, so server changes never appear to take effect.
 */
export async function killWorkspaceServers(input: KillWorkspaceServersInput): Promise<WorkspaceDaemonProcess[]> {
  const killProcess = input.killProcess ?? defaultKillProcess;
  const killed: WorkspaceDaemonProcess[] = [];
  const ps = await input.runner.run("ps", ["-axo", "pid=,command="]);
  if (ps.exitCode !== 0) {
    return killed;
  }
  for (const processInfo of findWorkspaceServerProcesses(input.repoRoot, ps.stdout)) {
    try {
      killProcess(processInfo.pid);
      killed.push(processInfo);
    } catch {
      // Process may have exited after ps output; cleanup is best-effort.
    }
  }
  return killed;
}

export async function killWorkspaceDaemons(input: KillWorkspaceDaemonsInput): Promise<KillWorkspaceDaemonsResult> {
  const pidFile = join(input.daemonDir, "daemon.pid");
  const readPid = input.readPidFile ?? readPidFile;
  const killProcess = input.killProcess ?? defaultKillProcess;
  const pid = readPid(pidFile);
  const result: KillWorkspaceDaemonsResult = { orphanedKilled: [] };

  if (pid !== undefined) {
    try {
      killProcess(pid);
      result.pidFileKilled = pid;
    } catch {
      rmSync(pidFile, { force: true });
    }
  }

  const ps = await input.runner.run("ps", ["-axo", "pid=,command="]);
  if (ps.exitCode === 0) {
    for (const processInfo of findWorkspaceDaemonProcesses(input.repoRoot, ps.stdout)) {
      if (processInfo.pid === pid) {
        continue;
      }
      try {
        killProcess(processInfo.pid);
        result.orphanedKilled.push(processInfo);
      } catch {
        // Process may have exited after ps output; ignore and keep cleanup best-effort.
      }
    }
  }

  return result;
}
