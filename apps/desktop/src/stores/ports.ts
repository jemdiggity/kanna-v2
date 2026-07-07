import type { RepoConfig } from "@kanna/core";
import type { StoreContext } from "./state";
import { claimDesktopTaskPorts, releaseDesktopTaskPorts } from "../services/desktopServerClient";

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

export function createPortsStore(_context: StoreContext): PortsStore {
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
      return {
        portEnv: response.portEnv ?? response.port_env ?? {},
        firstPort: response.firstPort ?? response.first_port ?? null,
      };
    });
  }

  async function releaseTaskPorts(itemId: string): Promise<void> {
    await releaseDesktopTaskPorts(itemId);
  }

  async function closeTaskAndReleasePorts(
    itemId: string,
    closeFn: (id: string) => Promise<void>,
  ): Promise<void> {
    await closeFn(itemId);
  }

  return {
    claimTaskPorts,
    releaseTaskPorts,
    closeTaskAndReleasePorts,
  };
}
