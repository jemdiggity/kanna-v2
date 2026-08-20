import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "./process";
import { removeInventoryResource } from "./process-inventory";

export interface KillWorkspaceDaemonsInput {
  repoRoot: string;
  daemonDir: string;
  runner: CommandRunner;
  readPidFile?: (pidFile: string) => number | undefined;
  killProcess?: (pid: number) => void;
}

export interface KillWorkspaceDaemonsResult {
  pidFileKilled?: number;
}

function readPidFile(pidFile: string): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Kill only the daemon identified by this workspace's daemon-owned pidfile. */
export async function killWorkspaceDaemons(input: KillWorkspaceDaemonsInput): Promise<KillWorkspaceDaemonsResult> {
  const pidFile = join(input.daemonDir, "daemon.pid");
  const pid = (input.readPidFile ?? readPidFile)(pidFile);
  if (pid === undefined) return {};
  try {
    (input.killProcess ?? ((target) => process.kill(target, "SIGTERM")))(pid);
    removeInventoryResource(join(input.repoRoot, ".kanna", "kd-state", "process-inventory.json"), {
      kind: "process",
      pid,
      label: "kanna-daemon"
    });
    return { pidFileKilled: pid };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      rmSync(pidFile, { force: true });
      return {};
    }
    throw error;
  }
}
