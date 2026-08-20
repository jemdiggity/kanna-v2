import { describe, expect, it } from "vitest";
import { killWorkspaceDaemons } from "../src/runtime/daemon";

describe("daemon cleanup", () => {
  it("kills only the daemon recorded by its own pidfile", async () => {
    const killed: number[] = [];
    const result = await killWorkspaceDaemons({
      repoRoot: "/repo/worktree",
      daemonDir: "/repo/worktree/.kanna-daemon",
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      readPidFile: () => 111,
      killProcess: (pid) => killed.push(pid)
    });
    expect(result).toEqual({ pidFileKilled: 111 });
    expect(killed).toEqual([111]);
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
      killProcess: () => {
        throw new Error("must not kill");
      }
    });
    expect(result).toEqual({});
    expect(runnerCalled).toBe(false);
  });
});
