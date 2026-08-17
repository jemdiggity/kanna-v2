import { createServer } from "node:net";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Port allocation for the E2E harness.
 *
 * Binding `:0` returns a port from the kernel's ephemeral range — exactly the pool macOS
 * reassigns to outbound connections. The harness allocates its ports minutes before the
 * processes that bind them (the app only listens once cargo has finished building), so an
 * unrelated connection can take the port in between and the app dies with `AddrInUse`.
 *
 * Allocate from a private range the kernel never hands out on its own instead, hold the
 * reservation until the run actually starts its processes, and never hand out adjacent
 * ports: `vite.config.ts` puts HMR on `KANNA_DEV_PORT + 1` when `TAURI_DEV_HOST` is set,
 * which would otherwise land on another allocation.
 */
export const EPHEMERAL_PORT_RANGE_START = 49152;
export const E2E_PORT_RANGE_START = 20000;
export const E2E_PORT_RANGE_END = 39998;

export type ReleasePort = () => Promise<void>;
export type ReleasePortClaim = () => Promise<void>;

export interface PortAllocator {
  allocate(label: string, options?: { reserveNextPort?: boolean }): Promise<number>;
  handoff(port: number): Promise<void>;
  releaseAll(): Promise<void>;
}

export interface PortAllocatorOptions {
  /** Reserves `port`, or resolves `null` when it is not available. */
  reserve?: (port: number) => Promise<ReleasePort | null>;
  /** Claims `port` across harness processes, or resolves `null` when another run owns it. */
  claim?: (port: number) => Promise<ReleasePortClaim | null>;
  /** Returns a float in `[0, 1)`; injected so tests can drive candidate selection. */
  random?: () => number;
  rangeStart?: number;
  rangeEnd?: number;
  maxAttempts?: number;
}

function portClaimPath(port: number): string {
  return join(tmpdir(), `kanna-desktop-e2e-port-${port}.lock`);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Keep a cross-process claim after the listening reservation is handed to the
 * owning service. This closes the restart gap where another E2E runner could
 * select a port while the first runner is between app instances.
 */
export async function claimE2ePort(port: number): Promise<ReleasePortClaim | null> {
  const path = portClaimPath(port);
  const ownerToken = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${ownerToken}\n`);
      await handle.close();
      return async () => {
        const currentOwner = (await readFile(path, "utf8").catch(() => "")).trim();
        if (currentOwner !== ownerToken) return;
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== "EEXIST") throw error;
      const owner = Number.parseInt((await readFile(path, "utf8").catch(() => "")).split(":")[0] ?? "", 10);
      if (processIsAlive(owner)) return null;
      // Rename the stale claim before deleting it. An unlink of the shared
      // path can otherwise remove a fresh claim won by another runner between
      // our liveness check and cleanup.
      const stalePath = `${path}.stale-${process.pid}-${randomUUID()}`;
      try {
        await rename(path, stalePath);
        await unlink(stalePath).catch(() => undefined);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
      }
    }
  }
  return null;
}

async function listen(port: number, host: string): Promise<ReleasePort | null> {
  return await new Promise<ReleasePort | null>((resolve) => {
    // A reservation owns the bind only; it is not a service. Reject probes
    // immediately so `server.close()` never waits forever on a socket that
    // connected while the real service was intentionally absent.
    const server = createServer((socket) => socket.destroy());
    server.once("error", () => resolve(null));
    server.listen(port, host, () => {
      resolve(async () => {
        await new Promise<void>((closed) => server.close(() => closed()));
      });
    });
  });
}

/**
 * Reserves a port on both loopback stacks. Vite binds `localhost`, which macOS resolves to
 * `::1`, while the WebDriver plugin and `kanna-server` bind `127.0.0.1` — a port is only
 * usable for this run when it is free on both.
 */
export async function reserveLoopbackPort(port: number): Promise<ReleasePort | null> {
  const releaseIpv4 = await listen(port, "127.0.0.1");
  if (!releaseIpv4) return null;
  const releaseIpv6 = await listen(port, "::1");
  if (!releaseIpv6) {
    await releaseIpv4();
    return null;
  }
  return async () => {
    await releaseIpv6();
    await releaseIpv4();
  };
}

export function createPortAllocator(options: PortAllocatorOptions = {}): PortAllocator {
  const reserve = options.reserve ?? reserveLoopbackPort;
  const claim = options.claim ?? claimE2ePort;
  const random = options.random ?? Math.random;
  const rangeStart = options.rangeStart ?? E2E_PORT_RANGE_START;
  const rangeEnd = options.rangeEnd ?? E2E_PORT_RANGE_END;
  const maxAttempts = options.maxAttempts ?? 200;
  const taken = new Set<number>();
  const allocations = new Map<number, {
    claims: ReleasePortClaim[];
    reservations: ReleasePort[];
  }>();

  if (rangeEnd >= EPHEMERAL_PORT_RANGE_START) {
    throw new Error(
      `E2E port range must stay below the ephemeral range (${EPHEMERAL_PORT_RANGE_START}), got ${rangeEnd}`,
    );
  }

  return {
    async allocate(label: string, allocationOptions = {}): Promise<number> {
      const span = rangeEnd - rangeStart + 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const port = rangeStart + Math.floor(random() * span);
        const requestedPorts = allocationOptions.reserveNextPort ? [port, port + 1] : [port];
        if ((requestedPorts[requestedPorts.length - 1] ?? port) > rangeEnd) continue;
        // Keep a gap around each allocation so a later dev server can never put
        // its HMR listener on an already allocated service port.
        if (requestedPorts.some((candidate) =>
          taken.has(candidate) || taken.has(candidate - 1) || taken.has(candidate + 1)
        )) continue;

        const claims: ReleasePortClaim[] = [];
        const reservations: ReleasePort[] = [];
        let available = true;
        for (const candidate of requestedPorts) {
          const releaseClaim = await claim(candidate);
          if (!releaseClaim) {
            available = false;
            break;
          }
          claims.push(releaseClaim);
          const releaseReservation = await reserve(candidate);
          if (!releaseReservation) {
            available = false;
            break;
          }
          reservations.push(releaseReservation);
        }
        if (!available) {
          await Promise.allSettled(reservations.map((release) => release()));
          await Promise.allSettled(claims.map((release) => release()));
          continue;
        }
        requestedPorts.forEach((candidate) => taken.add(candidate));
        allocations.set(port, { claims, reservations });
        return port;
      }
      throw new Error(
        `failed to allocate a free port for ${label} in ${rangeStart}-${rangeEnd} after ${maxAttempts} attempts`,
      );
    },
    async handoff(port: number): Promise<void> {
      const allocation = allocations.get(port);
      if (!allocation) {
        throw new Error(`cannot hand off unallocated E2E port ${port}`);
      }
      const reservations = allocation.reservations.splice(0);
      await Promise.all(reservations.map((release) => release()));
    },
    async releaseAll(): Promise<void> {
      for (const allocation of allocations.values()) {
        await Promise.allSettled(allocation.reservations.splice(0).map((release) => release()));
        await Promise.allSettled(allocation.claims.splice(0).map((release) => release()));
      }
      allocations.clear();
      taken.clear();
    },
  };
}
