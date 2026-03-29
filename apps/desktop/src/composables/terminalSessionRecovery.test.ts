import { describe, expect, it } from "vitest";
import {
  formatAttachFailureMessage,
  getTerminalRecoveryMode,
  shouldReattachOnDaemonReady,
} from "./terminalSessionRecovery";

describe("getTerminalRecoveryMode", () => {
  const spawnFn = async () => {};

  it("uses attach-only recovery for task PTY terminals", () => {
    expect(
      getTerminalRecoveryMode(
        { cwd: "/tmp/task", prompt: "do work", spawnFn },
        { agentProvider: "claude", worktreePath: "/tmp/task" },
      )
    ).toBe("attach-only");
  });

  it("uses spawn-on-missing recovery for shell terminals", () => {
    expect(
      getTerminalRecoveryMode(
        { cwd: "/tmp/repo", prompt: "", spawnFn },
        undefined,
      )
    ).toBe("spawn-on-missing");
  });
});

describe("formatAttachFailureMessage", () => {
  it("surfaces a visible reconnect failure for task terminals", () => {
    const message = formatAttachFailureMessage("session not found");
    expect(message).toContain("Failed to reconnect");
    expect(message).toContain("session not found");
  });
});

describe("shouldReattachOnDaemonReady", () => {
  const spawnFn = async () => {};

  it("re-attaches mounted task PTY terminals after daemon restart", () => {
    expect(
      shouldReattachOnDaemonReady(
        { cwd: "/tmp/task", prompt: "do work", spawnFn },
        { agentProvider: "copilot", worktreePath: "/tmp/task" },
      )
    ).toBe(true);
  });

  it("does not re-attach shell terminals after daemon restart", () => {
    expect(
      shouldReattachOnDaemonReady(
        { cwd: "/tmp/repo", prompt: "", spawnFn },
        undefined,
      )
    ).toBe(false);
  });
});
