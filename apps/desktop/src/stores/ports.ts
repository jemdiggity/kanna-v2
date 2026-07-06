import type { RepoConfig } from "@kanna/core";
import { formatTaskPortAllocationLog, type PortAllocationLogEntry } from "./portAllocationLog";
import { closePipelineItemAndClearCachedTerminalState } from "./kannaCleanup";
import { debugLog } from "../utils/debugLog";
import {
  claimDesktopTaskPorts,
  releaseDesktopTaskPorts,
} from "../services/desktopServerClient";

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

export function createPortsStore(): PortsStore {
  let portAllocationChain: Promise<void> = Promise.resolve();

  async function withPortAllocationLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = portAllocationChain.then(fn, fn);
    portAllocationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function claimTaskPorts(
    itemId: string,
    repoConfig: RepoConfig,
  ): Promise<AllocatedPorts> {
    return withPortAllocationLock(async () => {
      const response = await claimDesktopTaskPorts(itemId, {
        ports: repoConfig.ports,
        reservedPorts: repoConfig.reserved_ports,
        reservedPortOffsets: repoConfig.reserved_port_offsets,
      });
      const portEnv = response.portEnv ?? response.port_env ?? {};
      const firstPort = response.firstPort ?? response.first_port ?? null;

      if (repoConfig.ports && Object.keys(portEnv).length > 0) {
        const logEntries: PortAllocationLogEntry[] = Object.entries(repoConfig.ports)
          .flatMap(([envName, requestedPort]) => {
            const assigned = Number(portEnv[envName]);
            if (!Number.isFinite(assigned)) return [];
            return [{
              envName,
              requestedPort,
              assignedPort: assigned,
              reusedExisting: false,
            }];
          });
        if (logEntries.length > 0) {
          debugLog(formatTaskPortAllocationLog(itemId, logEntries));
        }
      }

      return { portEnv, firstPort };
    });
  }

  async function releaseTaskPorts(itemId: string): Promise<void> {
    await releaseDesktopTaskPorts(itemId);
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
