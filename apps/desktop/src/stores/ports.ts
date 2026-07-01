import type { RepoConfig } from "@kanna/core";
import { deleteTaskPortsForItem, listTaskPorts, listTaskPortsForItem } from "@kanna/db";
import { formatTaskPortAllocationLog, type PortAllocationLogEntry } from "./portAllocationLog";
import { closePipelineItemAndClearCachedTerminalState } from "./kannaCleanup";
import { debugLog } from "../utils/debugLog";
import type { StoreContext } from "./state";

export interface AllocatedPorts {
  portEnv: Record<string, string>;
  firstPort: number | null;
}

export interface PortsStore {
  claimTaskPorts(itemId: string, repoConfig: RepoConfig): Promise<AllocatedPorts>;
  releaseTaskPorts(itemId: string): Promise<void>;
  closeTaskAndReleasePorts(
    itemId: string,
    closeFn: (id: string) => Promise<void>,
  ): Promise<void>;
}

function toPortAssignmentMap(taskPorts: Array<{ env_name: string; port: number }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const taskPort of taskPorts) {
    map.set(taskPort.env_name, taskPort.port);
  }
  return map;
}

function addReservedPorts(occupiedPorts: Set<number>, repoConfig: RepoConfig): void {
  for (const port of repoConfig.reserved_ports ?? []) {
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      occupiedPorts.add(port);
    }
  }

  const offsets = repoConfig.reserved_port_offsets ?? [];
  if (!repoConfig.ports || offsets.length === 0) return;

  for (const preferredPort of Object.values(repoConfig.ports)) {
    if (!Number.isInteger(preferredPort)) continue;
    for (const offset of offsets) {
      if (!Number.isInteger(offset) || offset < 0) continue;
      const reservedPort = preferredPort + offset;
      if (reservedPort > 0 && reservedPort <= 65535) {
        occupiedPorts.add(reservedPort);
      }
    }
  }
}

export function createPortsStore(context: StoreContext): PortsStore {
  let portAllocationChain: Promise<void> = Promise.resolve();

  async function withPortAllocationLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = portAllocationChain.then(fn, fn);
    portAllocationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function tryClaimPort(
    itemId: string,
    envName: string,
    candidate: number,
    occupiedPorts: Set<number>,
  ): Promise<boolean> {
    const db = context.requireDb();
    if (!Number.isInteger(candidate) || candidate <= 0) return false;
    if (occupiedPorts.has(candidate)) return false;

    await db.execute(
      "INSERT OR IGNORE INTO task_port (port, pipeline_item_id, env_name) VALUES (?, ?, ?)",
      [candidate, itemId, envName],
    );
    const owner = await db.select<{ pipeline_item_id: string }>(
      "SELECT pipeline_item_id FROM task_port WHERE port = ?",
      [candidate],
    );
    if (owner[0]?.pipeline_item_id !== itemId) return false;

    occupiedPorts.add(candidate);
    return true;
  }

  async function claimClosestPort(
    itemId: string,
    envName: string,
    preferredPort: number,
    occupiedPorts: Set<number>,
  ): Promise<number> {
    const existing = await listTaskPortsForItem(context.requireDb(), itemId);
    const existingPort = existing.find((taskPort) => taskPort.env_name === envName)?.port;
    if (existingPort != null) {
      occupiedPorts.add(existingPort);
      return existingPort;
    }

    for (let candidate = preferredPort + 1; candidate <= 65535; candidate++) {
      if (await tryClaimPort(itemId, envName, candidate, occupiedPorts)) {
        return candidate;
      }
    }

    throw new Error(`No free port available near ${preferredPort} for ${envName}`);
  }

  async function claimTaskPorts(
    itemId: string,
    repoConfig: RepoConfig,
  ): Promise<AllocatedPorts> {
    return withPortAllocationLock(async () => {
      const portEnv: Record<string, string> = {};
      let firstPort: number | null = null;
      const claimedPorts: number[] = [];
      const logEntries: PortAllocationLogEntry[] = [];

      try {
        const activeTaskPorts = await listTaskPorts(context.requireDb());
        const occupiedPorts = new Set<number>(activeTaskPorts.map((taskPort) => taskPort.port));
        addReservedPorts(occupiedPorts, repoConfig);

        if (!repoConfig.ports) return { portEnv, firstPort };

        const existingTaskPorts = await listTaskPortsForItem(context.requireDb(), itemId);
        const existingAssignments = toPortAssignmentMap(existingTaskPorts);

        for (const [envName, preferredPort] of Object.entries(repoConfig.ports)) {
          const existingPort = existingAssignments.get(envName);
          if (existingPort != null) {
            occupiedPorts.add(existingPort);
            portEnv[envName] = String(existingPort);
            if (firstPort === null) firstPort = existingPort;
            logEntries.push({
              envName,
              requestedPort: preferredPort,
              assignedPort: existingPort,
              reusedExisting: true,
            });
            continue;
          }

          const assignedPort = await claimClosestPort(itemId, envName, preferredPort, occupiedPorts);
          claimedPorts.push(assignedPort);
          portEnv[envName] = String(assignedPort);
          if (firstPort === null) firstPort = assignedPort;
          logEntries.push({
            envName,
            requestedPort: preferredPort,
            assignedPort,
            reusedExisting: false,
          });
        }

        if (logEntries.length > 0) {
          debugLog(formatTaskPortAllocationLog(itemId, logEntries));
        }

        return { portEnv, firstPort };
      } catch (error) {
        if (claimedPorts.length > 0) {
          await deleteTaskPortsForItem(context.requireDb(), itemId).catch((cleanupError) =>
            console.error("[store] failed to clean up partial port claims:", cleanupError),
          );
        }
        throw error;
      }
    });
  }

  async function releaseTaskPorts(itemId: string): Promise<void> {
    await deleteTaskPortsForItem(context.requireDb(), itemId);
  }

  async function closeTaskAndReleasePorts(
    itemId: string,
    closeFn: (id: string) => Promise<void>,
  ): Promise<void> {
    await closePipelineItemAndClearCachedTerminalState(itemId, closeFn);
    await releaseTaskPorts(itemId);
  }

  return {
    claimTaskPorts,
    releaseTaskPorts,
    closeTaskAndReleasePorts,
  };
}
