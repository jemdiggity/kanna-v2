import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupProcessInventory,
  readProcessInventory,
  recordInventoryResource
} from "../src/runtime/process-inventory";

describe("kd process inventory", () => {
  it("round-trips exact pids and tmux sockets and cleans nothing else", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kanna-inventory-")), "inventory.json");
    recordInventoryResource(path, { kind: "process", pid: 123, label: "firebase" });
    recordInventoryResource(path, { kind: "tmux-server", socket: "kanna-e2e-task-abc" });
    const killed: number[] = [];
    const calls: string[] = [];
    const result = await cleanupProcessInventory(
      path,
      { run: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      } },
      (pid) => killed.push(pid)
    );
    expect(result.failed).toEqual([]);
    expect(killed).toEqual([123]);
    expect(calls).toEqual(["tmux -L kanna-e2e-task-abc kill-server"]);
    expect(readProcessInventory(path)).toEqual([]);
  });

  it("survives a crashed run and is consumed by the next cleanup", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kanna-inventory-crash-")), "inventory.json");
    recordInventoryResource(path, { kind: "process", pid: 456, label: "appium" });
    expect(readFileSync(path, "utf8")).toContain("appium");
    const killed: number[] = [];
    await cleanupProcessInventory(
      path,
      { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      (pid) => killed.push(pid)
    );
    expect(killed).toEqual([456]);
  });

  it("retains only resources whose exact cleanup failed", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kanna-inventory-failure-")), "inventory.json");
    recordInventoryResource(path, { kind: "process", pid: 700, label: "owned" });
    recordInventoryResource(path, { kind: "process", pid: 701, label: "unrelated" });
    await cleanupProcessInventory(
      path,
      { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      (pid) => {
        if (pid === 701) throw new Error("denied");
      }
    );
    expect(readProcessInventory(path)).toEqual([{ kind: "process", pid: 701, label: "unrelated" }]);
  });
});
