import { describe, expect, it } from "vitest";
import {
  formatAttachFailureMessage,
  getTerminalRecoveryMode,
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
