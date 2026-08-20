import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killWorkspaceDaemons } from "../src/runtime/daemon";
import { processInventoryPath, readProcessInventory, recordInventoryResource } from "../src/runtime/process-inventory";

describe("daemon cleanup", () => {
  it("does not signal a stale daemon pidfile identity", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kanna-daemon-stale-"));
    const inventoryPath = processInventoryPath(repoRoot);
    recordInventoryResource(inventoryPath, { kind: "process", pid: 111, label: "kanna-daemon", identity: "old" });
    const signals: NodeJS.Signals[] = [];
    const result = await killWorkspaceDaemons({
      repoRoot,
      daemonDir: join(repoRoot, ".kanna-daemon"),
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      readPidFile: () => 111,
      cleanupOperations: { identity: () => "new", signal: (_pid, signal) => signals.push(signal) }
    });
    expect(result).toEqual({});
    expect(signals).toEqual([]);
    expect(readProcessInventory(inventoryPath)).toHaveLength(1);
  });

  it("escalates a TERM-resistant daemon and succeeds only after verified exit", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kanna-daemon-resistant-"));
    const inventoryPath = processInventoryPath(repoRoot);
    recordInventoryResource(inventoryPath, { kind: "process", pid: 112, label: "kanna-daemon", identity: "spawn" });
    const signals: NodeJS.Signals[] = [];
    let identity: string | undefined = "spawn";
    const result = await killWorkspaceDaemons({
      repoRoot,
      daemonDir: join(repoRoot, ".kanna-daemon"),
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      readPidFile: () => 112,
      cleanupOperations: {
        identity: () => identity,
        signal: (_pid, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") identity = undefined;
        },
        graceMs: 1,
        pollMs: 1
      }
    });
    expect(result).toEqual({ pidFileKilled: 112 });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(readProcessInventory(inventoryPath)).toEqual([]);
  });

  it("retains the daemon record when exit cannot be confirmed", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kanna-daemon-unconfirmed-"));
    const inventoryPath = processInventoryPath(repoRoot);
    recordInventoryResource(inventoryPath, { kind: "process", pid: 113, label: "kanna-daemon", identity: "spawn" });
    const result = await killWorkspaceDaemons({
      repoRoot,
      daemonDir: join(repoRoot, ".kanna-daemon"),
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      readPidFile: () => 113,
      cleanupOperations: { identity: () => "spawn", signal: () => undefined, graceMs: 1, pollMs: 1 }
    });
    expect(result).toEqual({});
    expect(readProcessInventory(inventoryPath)).toHaveLength(1);
  });

  it("does not enumerate or kill anything without an owning pidfile", async () => {
    let runnerCalled = false;
    const result = await killWorkspaceDaemons({
      repoRoot: "/repo/worktree",
      daemonDir: "/repo/worktree/.kanna-daemon",
      runner: { run: async () => {
        runnerCalled = true;
        return { exitCode: 0, stdout: "999 unrelated", stderr: "" };
      } },
      readPidFile: () => undefined,
      cleanupOperations: { signal: () => { throw new Error("must not kill"); } }
    });
    expect(result).toEqual({});
    expect(runnerCalled).toBe(false);
  });
});
