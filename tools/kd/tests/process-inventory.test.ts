import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupProcessInventory,
  processIdentity,
  readProcessInventory,
  recordInventoryResource
} from "../src/runtime/process-inventory";
import { nodeCommandRunner } from "../src/runtime/process";
import { startTmuxSession } from "../src/runtime/tmux";
import { executeDevDownWithContext } from "../src/tasks/registry";

const runner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

function spawnedPid(child: ReturnType<typeof spawn>): number {
  if (child.pid === undefined) throw new Error("child process did not start");
  return child.pid;
}

describe("kd process inventory", () => {
  it("round-trips exact process identities and tmux sockets", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kanna-inventory-")), "inventory.json");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const pid = spawnedPid(child);
    recordInventoryResource(path, { kind: "process", pid, label: "owned" });
    recordInventoryResource(path, { kind: "tmux-server", socket: "kanna-e2e-task-abc" });
    const calls: string[] = [];
    const result = await cleanupProcessInventory(path, {
      run: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });
    expect(result.failed).toEqual([]);
    expect(calls).toEqual(["tmux -L kanna-e2e-task-abc kill-server"]);
    expect(readProcessInventory(path)).toEqual([]);
    expect(processIdentity(pid)).toBeUndefined();
  });

  it("escalates for a SIGTERM-resistant child and waits for confirmed exit", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kanna-inventory-resistant-")), "inventory.json");
    const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
    const pid = spawnedPid(child);
    await new Promise<void>((resolveReady) => setTimeout(resolveReady, 100));
    recordInventoryResource(path, { kind: "process", pid, label: "resistant" });
    const result = await cleanupProcessInventory(path, runner, { graceMs: 100, pollMs: 10 });
    expect(result.failed).toEqual([]);
    expect(processIdentity(pid)).toBeUndefined();
    expect(readProcessInventory(path)).toEqual([]);
  });

  it("retains a process when exit cannot be confirmed", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kanna-inventory-failure-")), "inventory.json");
    recordInventoryResource(path, { kind: "process", pid: 700, label: "owned", identity: "spawn-1" });
    const signals: NodeJS.Signals[] = [];
    const result = await cleanupProcessInventory(path, runner, {
      identity: () => "spawn-1",
      signal: (_pid, signal) => signals.push(signal),
      graceMs: 1,
      pollMs: 1
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.failed).toHaveLength(1);
    expect(readProcessInventory(path)).toHaveLength(1);
  });

  it("does not signal a stale PID whose spawn identity changed", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kanna-inventory-stale-")), "inventory.json");
    recordInventoryResource(path, { kind: "process", pid: 701, label: "stale", identity: "old" });
    const signals: NodeJS.Signals[] = [];
    await cleanupProcessInventory(path, runner, {
      identity: () => "new",
      signal: (_pid, signal) => signals.push(signal)
    });
    expect(signals).toEqual([]);
    expect(readProcessInventory(path)).toEqual([]);
  });

  it("serializes concurrent writers without losing resources", async () => {
    const root = resolve("../../.tmp");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "inventory-interleaving-"));
    const path = join(directory, "inventory.json");
    // Seed a readable inventory so the fixture can gate after the read but
    // before the mutation is written, inside the writer's critical section.
    recordInventoryResource(path, { kind: "tmux-server", socket: "seed" });
    interface Writer {
      child: ReturnType<typeof spawn>;
      exited: Promise<number | null>;
      release: () => void;
      wait: (event: string) => Promise<void>;
    }
    const writers: Writer[] = [];
    function startWriter(socket: string, gateAt: "inventory" | "owner"): Writer {
      const child = spawn(process.execPath, [
        "--experimental-strip-types", resolve("tests/fixtures/inventory-writer.mjs"),
        resolve("src/runtime/process-inventory.ts"), path, socket, gateAt,
      ], { stdio: ["ignore", "pipe", "pipe"], env: {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      } });
      let output = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const exited = new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", resolveExit);
      });
      const writer = {
        child, exited,
        release: () => writeFileSync(`${path}.${socket}.release`, ""),
        wait: async (event: string) => {
          await vi.waitUntil(() => {
            if (output.includes(`${event}\n`)) return true;
            if (child.exitCode !== null) throw new Error(`writer ${socket} exited before ${event}: ${output} ${stderr}`);
            return false;
          });
        },
      };
      writers.push(writer);
      return writer;
    }
    try {
      const first = startWriter("first", "inventory");
      await first.wait("gated");
      const contender = startWriter("contender", "owner");
      await contender.wait("gated");
      first.release();
      expect(await first.exited).toBe(0);

      const replacement = startWriter("replacement", "inventory");
      await replacement.wait("gated");
      // The contender holds first's metadata, but first has exited and the
      // lock now belongs to replacement. Recovery must preserve that lock.
      contender.release();
      await contender.wait("contended-again");
      expect(existsSync(`${path}.lock`)).toBe(true);
      replacement.release();
      expect(await replacement.exited).toBe(0);
      expect(await contender.exited).toBe(0);
      expect(readProcessInventory(path).map((resource) => resource.kind === "tmux-server" ? resource.socket : "").sort())
        .toEqual(["contender", "first", "replacement", "seed"]);
      expect(readFileSync(path, "utf8")).toContain('"version": 1');
    } finally {
      for (const writer of writers) {
        writer.release();
        if (writer.child.exitCode === null) writer.child.kill("SIGKILL");
      }
      await Promise.all(writers.map((writer) => writer.exited));
    }
  });

  it("publishes owner metadata atomically with the inventory lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kanna-inventory-publication-"));
    const path = join(directory, "inventory.json");
    const modulePath = resolve("src/runtime/process-inventory.ts");
    const script = (socket: string) => `import { recordInventoryResource } from ${JSON.stringify(modulePath)}; recordInventoryResource(${JSON.stringify(path)}, { kind: 'tmux-server', socket: ${JSON.stringify(socket)} });`;
    const delayed = spawn(process.execPath, ["--experimental-strip-types", "-e", script("delayed")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, KANNA_TEST_INVENTORY_LOCK_PUBLISH_DELAY_MS: "500" }
    });
    const pendingDeadline = Date.now() + 2_000;
    while (!readdirSync(directory).some((entry) => entry.startsWith("inventory.json.lock.pending-"))) {
      if (Date.now() >= pendingDeadline) throw new Error("delayed writer never prepared its lock metadata");
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(existsSync(`${path}.lock`)).toBe(false);

    const contender = spawn(process.execPath, ["--experimental-strip-types", "-e", script("contender")], {
      stdio: ["ignore", "ignore", "pipe"], env: process.env
    });
    const waitForExit = (child: ReturnType<typeof spawn>) => new Promise<void>((resolveExit, reject) => {
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`writer exited ${code}: ${stderr}`)));
    });
    await Promise.all([waitForExit(delayed), waitForExit(contender)]);
    expect(readProcessInventory(path).map((resource) => resource.kind === "tmux-server" ? resource.socket : "").sort())
      .toEqual(["contender", "delayed"]);
  }, 10_000);

  it("recovers an inventory lock abandoned by a crashed writer", () => {
    const directory = mkdtempSync(join(tmpdir(), "kanna-inventory-abandoned-"));
    const path = join(directory, "inventory.json");
    mkdirSync(`${path}.lock`);
    writeFileSync(join(`${path}.lock`, "owner.json"), JSON.stringify({ pid: 999_999_999, identity: "gone" }));
    recordInventoryResource(path, { kind: "tmux-server", socket: "recovered" });
    expect(readProcessInventory(path)).toEqual([{ kind: "tmux-server", socket: "recovered" }]);
  });

  it("preserves and does not signal a concurrent same-PID replacement", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kanna-inventory-replaced-")), "inventory.json");
    recordInventoryResource(path, { kind: "process", pid: 702, label: "old", identity: "spawn-1" });
    let identity = "spawn-1";
    const signals: NodeJS.Signals[] = [];
    const result = await cleanupProcessInventory(path, runner, {
      identity: () => identity,
      signal: (_pid, signal) => {
        signals.push(signal);
        identity = "spawn-2";
        recordInventoryResource(path, { kind: "process", pid: 702, label: "new", identity });
      },
      graceMs: 1,
      pollMs: 1
    });
    expect(result.failed).toEqual([]);
    expect(signals).toEqual(["SIGTERM"]);
    expect(readProcessInventory(path)).toEqual([
      { kind: "process", pid: 702, label: "new", identity: "spawn-2" }
    ]);
  });

  it("reaps only this instance's recovery helper after its daemon", async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "kanna-recovery-first-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "kanna-recovery-second-"));
    const firstInventory = join(firstRoot, ".kanna/kd-state/process-inventory.json");
    const secondInventory = join(secondRoot, ".kanna/kd-state/process-inventory.json");
    const identities = new Map<number, string>([
      [801, "first-daemon"],
      [802, "first-recovery"],
      [901, "second-daemon"],
      [902, "second-recovery"]
    ]);
    recordInventoryResource(firstInventory, {
      kind: "process", pid: 801, label: "kanna-daemon", identity: "first-daemon"
    });
    recordInventoryResource(firstInventory, {
      kind: "process", pid: 802, label: "kanna-terminal-recovery", identity: "first-recovery"
    });
    recordInventoryResource(secondInventory, {
      kind: "process", pid: 901, label: "kanna-daemon", identity: "second-daemon"
    });
    recordInventoryResource(secondInventory, {
      kind: "process", pid: 902, label: "kanna-terminal-recovery", identity: "second-recovery"
    });
    const signals: number[] = [];

    const result = await executeDevDownWithContext({ killDaemon: false }, {
      runner,
      context: {
        repoRoot: firstRoot,
        tmux: { server: "first", session: "first" },
        ports: {},
        env: {}
      }
    }, {
      cleanupOperations: {
        identity: (pid) => identities.get(pid),
        signal: (pid) => {
          signals.push(pid);
          identities.delete(pid);
        },
        graceMs: 1,
        pollMs: 1
      }
    });

    expect(result.data).toMatchObject({
      inventoryCleanup: { failed: [] }
    });
    expect(signals).toEqual([801, 802]);
    expect(readProcessInventory(firstInventory)).toEqual([]);
    expect(readProcessInventory(secondInventory)).toHaveLength(2);
    expect(identities.get(901)).toBe("second-daemon");
    expect(identities.get(902)).toBe("second-recovery");
  });

  it.runIf(tmuxAvailable)("dev down removes the exact tmux server and detached pane while preserving an unrelated process", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kanna-dev-down-"));
    const socket = `kanna-kd-test-${process.pid}-${Date.now()}`;
    const target = { server: socket, session: socket, inventoryPath: join(repoRoot, ".kanna/kd-state/process-inventory.json") };
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await startTmuxSession(nodeCommandRunner, target, [{
        name: "desktop", cwd: repoRoot, command: "sh -c 'trap \"\" TERM; while :; do sleep 1; done'", env: process.env
      }]);
      const pane = readProcessInventory(target.inventoryPath).find((resource) => resource.kind === "process");
      expect(pane?.kind).toBe("process");
      const socketPath = (await nodeCommandRunner.run("tmux", ["-L", socket, "display-message", "-p", "#{socket_path}"])).stdout.trim();
      await executeDevDownWithContext({ killDaemon: false }, {
        runner: nodeCommandRunner,
        context: { repoRoot, tmux: target, ports: {}, env: {} }
      });
      expect((await nodeCommandRunner.run("tmux", ["-L", socket, "has-session"])).exitCode).not.toBe(0);
      expect(socketPath).not.toBe("");
      expect(existsSync(socketPath)).toBe(false);
      expect(processIdentity(unrelated.pid ?? 0)).toBeDefined();
      if (pane?.kind === "process") expect(processIdentity(pane.pid)).toBeUndefined();
    } finally {
      unrelated.kill("SIGKILL");
      await nodeCommandRunner.run("tmux", ["-L", socket, "kill-server"]);
    }
  }, 15_000);
});
