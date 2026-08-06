import { describe, expect, it } from "vitest";
import {
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
  it("allocates below the ephemeral range the kernel reassigns", async () => {
    const allocator = createPortAllocator({ reserve: async () => async () => undefined });

    for (let i = 0; i < 50; i += 1) {
      const port = await allocator.allocate("dev");
      expect(port).toBeGreaterThanOrEqual(E2E_PORT_RANGE_START);
      expect(port).toBeLessThan(EPHEMERAL_PORT_RANGE_START);
    }
  });

  it("skips ports that cannot be reserved", async () => {
    const busy = new Set([25000]);
    const allocator = createPortAllocator({
      random: sequenceRandom([fractionFor(25000), fractionFor(25500)]),
      reserve: async (port) => (busy.has(port) ? null : async () => undefined),
    });

    expect(await allocator.allocate("webdriver")).toBe(25500);
  });

  it("never hands out a port adjacent to an earlier allocation", async () => {
    const allocator = createPortAllocator({
      random: sequenceRandom([fractionFor(25000), fractionFor(25001), fractionFor(24999), fractionFor(26000)]),
      reserve: async () => async () => undefined,
    });

    expect(await allocator.allocate("dev")).toBe(25000);
    // 25001 is the HMR port for a dev server on 25000, and 24999 would make 25000 the
    // HMR port of the next dev server.
    expect(await allocator.allocate("webdriver")).toBe(26000);
  });

  it("reports which port it failed to allocate", async () => {
    const allocator = createPortAllocator({ reserve: async () => null, maxAttempts: 3 });

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
