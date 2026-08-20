import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
    const directory = mkdtempSync(join(tmpdir(), "kanna-inventory-concurrent-"));
    const path = join(directory, "inventory.json");
    const modulePath = resolve("src/runtime/process-inventory.ts");
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    };
    const children = Array.from({ length: 8 }, (_, index) => spawn(
      process.execPath,
      ["--experimental-strip-types", "-e", `import { recordInventoryResource } from ${JSON.stringify(modulePath)}; recordInventoryResource(${JSON.stringify(path)}, { kind: 'tmux-server', socket: 'socket-${index}' });`],
      { stdio: ["ignore", "ignore", "pipe"], env: childEnv }
    ));
    await Promise.all(children.map((child) => new Promise<void>((resolveExit, reject) => {
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`writer exited ${code}: ${stderr}`)));
    })));
    expect(readProcessInventory(path).map((resource) => resource.kind === "tmux-server" ? resource.socket : "").sort())
      .toEqual(Array.from({ length: 8 }, (_, index) => `socket-${index}`).sort());
    expect(readFileSync(path, "utf8")).toContain('"version": 1');
  }, 20_000);

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
