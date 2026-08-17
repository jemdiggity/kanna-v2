import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimE2ePort,
  createPortAllocator,
  reserveLoopbackPort,
  E2E_PORT_RANGE_END,
  E2E_PORT_RANGE_START,
  EPHEMERAL_PORT_RANGE_START,
  PORT_CLAIM_DIR,
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
  it("keeps another allocator claim from taking the same port", async () => {
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

describe("claimE2ePort across processes", () => {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const tsx = join(desktopRoot, "node_modules", ".bin", "tsx");
  const claimScript = join(desktopRoot, "tests", "e2e", "runPortsClaimProcess.ts");
  const gateDirs: string[] = [];
  const runningChildren: Array<ReturnType<typeof spawn>> = [];

  interface ClaimChild {
    /** Resolves with the child's reported claim outcome. */
    outcome: Promise<boolean>;
    /** Resolves once the process is gone, with everything it printed. */
    finished: Promise<{ code: number | null; stdout: string; stderr: string }>;
  }

  function startClaimProcess(port: number, mode: string, gateDir: string): ClaimChild {
    const child = spawn(tsx, [claimScript, String(port), mode, gateDir], {
      cwd: desktopRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runningChildren.push(child);
    let stdout = "";
    let stderr = "";
    let reportLine: ((line: string) => void) | null = null;
    let reportFailure: ((error: Error) => void) | null = null;
    const firstLine = new Promise<string>((resolveLine, rejectLine) => {
      reportLine = resolveLine;
      reportFailure = rejectLine;
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline >= 0) reportLine?.(stdout.slice(0, newline));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const finished = new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code) => {
          reportFailure?.(new Error(`claim process exited without reporting: ${stderr.trim()}`));
          resolveExit({ code, stdout, stderr });
        });
      },
    );
    return {
      outcome: firstLine.then((line) => Boolean(JSON.parse(line).claimed)),
      finished,
    };
  }

  async function createGateDir(): Promise<string> {
    const gateDir = await mkdtemp(join(tmpdir(), "kanna-e2e-port-claim-gate-"));
    gateDirs.push(gateDir);
    return gateDir;
  }

  async function openGate(gateDir: string, gate: string): Promise<void> {
    await writeFile(join(gateDir, gate), "");
  }

  async function waitForGate(gateDir: string, gate: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const entries = await readdir(gateDir).catch(() => [] as string[]);
      if (entries.includes(gate)) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for the claim process to open the ${gate} gate`);
  }

  async function claimFilesFor(port: number): Promise<string[]> {
    const entries = await readdir(PORT_CLAIM_DIR).catch(() => [] as string[]);
    return entries.filter((entry) => entry.startsWith(`port-${port}.claim-`));
  }

  afterEach(async () => {
    while (runningChildren.length > 0) runningChildren.pop()?.kill("SIGKILL");
    while (gateDirs.length > 0) {
      await rm(gateDirs.pop() ?? "", { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // A claim published but not yet resolved used to read as ownerless, which let
  // the competitor delete it and take the same port. Only separate processes
  // can hold that window open, and the gate files make the overlap exact
  // instead of timed.
  it("refuses a competing process while the first claim is still publishing", async () => {
    const port = E2E_PORT_RANGE_START + (process.pid % 4000);
    const gateDir = await createGateDir();
    const holder = startClaimProcess(port, "hold-window", gateDir);

    await waitForGate(gateDir, "published");

    const competitor = startClaimProcess(port, "claim", gateDir);
    expect(await competitor.outcome).toBe(false);
    expect((await competitor.finished).code).toBe(0);

    await openGate(gateDir, "resume");
    expect(await holder.outcome).toBe(true);

    await openGate(gateDir, "release");
    expect((await holder.finished).code).toBe(0);
    expect(await claimFilesFor(port)).toEqual([]);

    // The released port is claimable again by a fresh process.
    const successor = startClaimProcess(port, "claim", gateDir);
    expect(await successor.outcome).toBe(true);
    expect((await successor.finished).code).toBe(0);
  }, 120_000);

  it("hands a port to at most one of several racing processes", async () => {
    const port = E2E_PORT_RANGE_START + 4000 + (process.pid % 4000);
    const gateDir = await createGateDir();
    const racers = Array.from({ length: 4 }, () => startClaimProcess(port, "hold", gateDir));

    const outcomes = await Promise.all(racers.map((racer) => racer.outcome));
    expect(outcomes.filter(Boolean).length).toBeLessThanOrEqual(1);

    await openGate(gateDir, "release");
    for (const racer of racers) {
      expect((await racer.finished).code).toBe(0);
    }
    expect(await claimFilesFor(port)).toEqual([]);
  }, 120_000);
});
