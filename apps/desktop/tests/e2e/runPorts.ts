import { createServer } from "node:net";

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

export interface PortAllocator {
  allocate(label: string): Promise<number>;
  releaseAll(): Promise<void>;
}

export interface PortAllocatorOptions {
  /** Reserves `port`, or resolves `null` when it is not available. */
  reserve?: (port: number) => Promise<ReleasePort | null>;
  /** Returns a float in `[0, 1)`; injected so tests can drive candidate selection. */
  random?: () => number;
  rangeStart?: number;
  rangeEnd?: number;
  maxAttempts?: number;
}

async function listen(port: number, host: string): Promise<ReleasePort | null> {
  return await new Promise<ReleasePort | null>((resolve) => {
    const server = createServer();
    server.unref();
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
  const random = options.random ?? Math.random;
  const rangeStart = options.rangeStart ?? E2E_PORT_RANGE_START;
  const rangeEnd = options.rangeEnd ?? E2E_PORT_RANGE_END;
  const maxAttempts = options.maxAttempts ?? 200;
  const taken = new Set<number>();
  const releases: ReleasePort[] = [];

  if (rangeEnd >= EPHEMERAL_PORT_RANGE_START) {
    throw new Error(
      `E2E port range must stay below the ephemeral range (${EPHEMERAL_PORT_RANGE_START}), got ${rangeEnd}`,
    );
  }

  return {
    async allocate(label: string): Promise<number> {
      const span = rangeEnd - rangeStart + 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const port = rangeStart + Math.floor(random() * span);
        // `port + 1` is the HMR port for a dev server on `port`, so never let a later
        // allocation land on the neighbour of an earlier one.
        if (taken.has(port) || taken.has(port - 1) || taken.has(port + 1)) continue;
        const release = await reserve(port);
        if (!release) continue;
        taken.add(port);
        releases.push(release);
        return port;
      }
      throw new Error(
        `failed to allocate a free port for ${label} in ${rangeStart}-${rangeEnd} after ${maxAttempts} attempts`,
      );
    },
    async releaseAll(): Promise<void> {
      while (releases.length > 0) {
        const release = releases.pop();
        await release?.().catch(() => undefined);
      }
    },
  };
}
