import { describe, expect, it } from "vitest";
import { formatAppWindowTitle } from "./windowTitle";

describe("formatAppWindowTitle", () => {
  it("includes the durable task id when present", () => {
    expect(
      formatAppWindowTitle({
        version: "0.0.29",
        branch: "release-v0.0.28",
        commitHash: "7f7db992",
        taskId: "524d7c7e",
        worktree: "task-524d7c7e",
      })
    ).toBe("Kanna — task 524d7c7e · release-v0.0.28 (0.0.29 @ 7f7db992)");
  });

  it("deduplicates worktree and branch names for task workspaces", () => {
    expect(
      formatAppWindowTitle({
        version: "0.0.65",
        branch: "task-37ec6039-5",
        commitHash: "abc1234",
        taskId: "37ec6039",
        worktree: "task-37ec6039-5",
      })
    ).toBe("Kanna — task 37ec6039 · task-37ec6039-5 (0.0.65 @ abc1234)");
  });

  it("falls back to the worktree name when a task id is unavailable", () => {
    expect(
      formatAppWindowTitle({
        version: "0.0.29",
        branch: "release-v0.0.28",
        commitHash: "7f7db992",
        worktree: "task-524d7c7e",
      })
    ).toBe("Kanna — task-524d7c7e · release-v0.0.28 (0.0.29 @ 7f7db992)");
  });

  it("shows branch info for non-main builds without a worktree", () => {
    expect(
      formatAppWindowTitle({
        version: "0.0.29",
        branch: "feat/headless-terminal-recovery",
        commitHash: "abcdef12",
        worktree: "",
      })
    ).toBe("Kanna — feat/headless-terminal-recovery (0.0.29 @ abcdef12)");
  });

  it("keeps the default title on main without a worktree", () => {
    expect(
      formatAppWindowTitle({
        version: "0.0.29",
        branch: "main",
        commitHash: "abcdef12",
        worktree: "",
      })
    ).toBeNull();
  });
});
