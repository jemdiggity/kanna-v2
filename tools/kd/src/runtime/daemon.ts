import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "./process";
import {
  readProcessInventory,
  removeInventoryResource,
  terminateInventoryProcess,
  type ProcessCleanupOperations
} from "./process-inventory";

export interface KillWorkspaceDaemonsInput {
  repoRoot: string;
  daemonDir: string;
  runner: CommandRunner;
  readPidFile?: (pidFile: string) => number | undefined;
  cleanupOperations?: ProcessCleanupOperations;
  /** Test seam retained for callers that only replace signal delivery. */
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
  const inventoryPath = join(input.repoRoot, ".kanna", "kd-state", "process-inventory.json");
  const resource = readProcessInventory(inventoryPath).find((candidate) =>
    candidate.kind === "process" && candidate.pid === pid && candidate.label === "kanna-daemon"
  );
  if (resource?.kind !== "process") return {};
  const cleanupOperations = input.killProcess
    ? { ...input.cleanupOperations, signal: (target: number) => input.killProcess?.(target) }
    : input.cleanupOperations;
  const outcome = await terminateInventoryProcess(resource, cleanupOperations);
  if (outcome !== "cleaned") return {};
  removeInventoryResource(inventoryPath, resource);
  rmSync(pidFile, { force: true });
  return { pidFileKilled: pid };
}
