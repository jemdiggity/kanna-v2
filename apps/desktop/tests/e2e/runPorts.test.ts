import { describe, expect, it } from "vitest";
import {
  claimE2ePort,
  createPortAllocator,
  reserveLoopbackPort,
  E2E_PORT_RANGE_END,
  E2E_PORT_RANGE_START,
  EPHEMERAL_PORT_RANGE_START,
} from "./runPorts";

function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function fractionFor(port: number, rangeStart = E2E_PORT_RANGE_START, rangeEnd = E2E_PORT_RANGE_END): number {
  return (port - rangeStart) / (rangeEnd - rangeStart + 1);
}

describe("createPortAllocator", () => {
  const noClaim = async () => async () => undefined;

  it("allocates below the ephemeral range the kernel reassigns", async () => {
    const allocator = createPortAllocator({ claim: noClaim, reserve: async () => async () => undefined });

    for (let i = 0; i < 50; i += 1) {
      const port = await allocator.allocate("dev");
      expect(port).toBeGreaterThanOrEqual(E2E_PORT_RANGE_START);
      expect(port).toBeLessThan(EPHEMERAL_PORT_RANGE_START);
    }
  });

  it("skips ports that cannot be reserved", async () => {
    const busy = new Set([25000]);
    const allocator = createPortAllocator({
      claim: noClaim,
      random: sequenceRandom([fractionFor(25000), fractionFor(25500)]),
      reserve: async (port) => (busy.has(port) ? null : async () => undefined),
    });

    expect(await allocator.allocate("webdriver")).toBe(25500);
  });

  it("never hands out a port adjacent to an earlier allocation", async () => {
    const allocator = createPortAllocator({
      claim: noClaim,
      random: sequenceRandom([fractionFor(25000), fractionFor(25001), fractionFor(24999), fractionFor(26000)]),
      reserve: async () => async () => undefined,
    });

    expect(await allocator.allocate("dev")).toBe(25000);
    // 25001 is the HMR port for a dev server on 25000, and 24999 would make 25000 the
    // HMR port of the next dev server.
    expect(await allocator.allocate("webdriver")).toBe(26000);
  });

  it("reports which port it failed to allocate", async () => {
    const allocator = createPortAllocator({ claim: noClaim, reserve: async () => null, maxAttempts: 3 });

    await expect(allocator.allocate("relay")).rejects.toThrow(/free port for relay/);
  });

  it("refuses a range that overlaps the ephemeral range", () => {
    expect(() => createPortAllocator({ rangeEnd: EPHEMERAL_PORT_RANGE_START + 1 })).toThrow(
      /ephemeral range/,
    );
  });

  it("releases every reservation so the processes that need them can bind", async () => {
    const released: number[] = [];
    const allocator = createPortAllocator({
      claim: noClaim,
      reserve: async (port) => async () => {
        released.push(port);
      },
    });

    const first = await allocator.allocate("dev");
    const second = await allocator.allocate("webdriver");
    await allocator.releaseAll();

    expect(released.sort()).toEqual([first, second].sort());
    await allocator.releaseAll();
    expect(released).toHaveLength(2);
  });

  it("hands a reservation to its service without releasing the cross-run claim", async () => {
    const released: string[] = [];
    const allocator = createPortAllocator({
      claim: async (port) => async () => { released.push(`claim:${port}`); },
      reserve: async (port) => async () => { released.push(`reservation:${port}`); },
    });

    const port = await allocator.allocate("relay control");
    await allocator.handoff(port);
    expect(released).toEqual([`reservation:${port}`]);

    await allocator.releaseAll();
    expect(released).toEqual([`reservation:${port}`, `claim:${port}`]);
  });

  it("reserves a dev server's HMR neighbour as one allocation", async () => {
    const reserved: number[] = [];
    const allocator = createPortAllocator({
      claim: noClaim,
      random: sequenceRandom([fractionFor(25000), fractionFor(26000)]),
      reserve: async (port) => {
        reserved.push(port);
        return async () => undefined;
      },
    });

    expect(await allocator.allocate("dev", { reserveNextPort: true })).toBe(25000);
    expect(reserved).toEqual([25000, 25001]);
    expect(await allocator.allocate("webdriver")).toBe(26000);
  });
});

describe("reserveLoopbackPort", () => {
  it("holds the port on both loopback stacks and frees it on release", async () => {
    const allocator = createPortAllocator();
    const port = await allocator.allocate("probe");

    expect(await reserveLoopbackPort(port)).toBeNull();

    await allocator.releaseAll();
    const release = await reserveLoopbackPort(port);
    expect(release).not.toBeNull();
    await release?.();
  });
});

describe("claimE2ePort", () => {
  it("keeps another allocator process claim from taking the same port", async () => {
    const port = 20000 + (process.pid % 15000);
    const release = await claimE2ePort(port);
    expect(release).not.toBeNull();
    try {
      expect(await claimE2ePort(port)).toBeNull();
    } finally {
      await release?.();
    }
  });
});
