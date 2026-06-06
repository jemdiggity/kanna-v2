import { describe, it, expect } from "vitest";
import { buildKannaRuntimeSystemPrompt, buildKannaRuntimeUserPrompt, buildStagePrompt } from "./prompt-builder";

describe("buildStagePrompt", () => {
  it("replaces $TASK_PROMPT with the user's original prompt", () => {
    const result = buildStagePrompt(
      "Agent base prompt.",
      "Do this: $TASK_PROMPT",
      { taskPrompt: "fix the bug" }
    );
    expect(result).toContain("Do this: fix the bug");
  });

  it("replaces $PREV_RESULT with the previous stage's completion metadata", () => {
    const prevResult = JSON.stringify({ status: "success", summary: "done" });
    const result = buildStagePrompt(
      "Agent base prompt.",
      "Previous result: $PREV_RESULT",
      { prevResult }
    );
    expect(result).toContain(`Previous result: ${prevResult}`);
  });

  it("replaces $BRANCH with the branch name", () => {
    const result = buildStagePrompt(
      "Agent base prompt.",
      "Work on branch $BRANCH.",
      { branch: "task-abc123" }
    );
    expect(result).toContain("Work on branch task-abc123.");
  });

  it("replaces $SOURCE_WORKTREE with the source worktree path", () => {
    const result = buildStagePrompt(
      "Agent base prompt.",
      "Check the source worktree at $SOURCE_WORKTREE.",
      { sourceWorktree: "/tmp/repo/.kanna-worktrees/task-abc123" }
    );
    expect(result).toContain(
      "Check the source worktree at /tmp/repo/.kanna-worktrees/task-abc123."
    );
  });

  it("replaces $BASE_REF with the original task base ref", () => {
    const result = buildStagePrompt(
      "Agent base prompt.",
      "Review changes since $BASE_REF.",
      { baseRef: "origin/main" }
    );
    expect(result).toContain("Review changes since origin/main.");
  });

  it("is a no-op when no variables are present", () => {
    const stagePrompt = "No variables here.";
    const result = buildStagePrompt("Agent base prompt.", stagePrompt, {
      taskPrompt: "ignored",
      prevResult: "ignored",
      branch: "ignored",
    });
    expect(result).toBe("Agent base prompt.\n\nNo variables here.");
  });

  it("replaces undefined/missing variables with empty string", () => {
    const result = buildStagePrompt(
      "Base.",
      "Task: $TASK_PROMPT, Prev: $PREV_RESULT, Branch: $BRANCH, Base: $BASE_REF, Source: $SOURCE_WORKTREE",
      {}
    );
    expect(result).toBe("Base.\n\nTask: , Prev: , Branch: , Base: , Source: ");
  });

  it("combines agent base prompt with stage prompt separated by double newline", () => {
    const result = buildStagePrompt(
      "Agent base prompt.",
      "Stage specific prompt.",
      {}
    );
    expect(result).toBe("Agent base prompt.\n\nStage specific prompt.");
  });

  it("uses only the agent prompt when stage prompt is undefined", () => {
    const result = buildStagePrompt("Agent base prompt only.", undefined, {
      taskPrompt: "task",
    });
    expect(result).toBe("Agent base prompt only.");
  });

  it("substitutes variables in both agent prompt and stage prompt", () => {
    const result = buildStagePrompt(
      "Agent for $BRANCH.",
      "Task: $TASK_PROMPT",
      { branch: "main", taskPrompt: "do it" }
    );
    expect(result).toBe("Agent for main.\n\nTask: do it");
  });

  it("replaces all occurrences of a variable", () => {
    const result = buildStagePrompt(
      "Base.",
      "$TASK_PROMPT and also $TASK_PROMPT",
      { taskPrompt: "hello" }
    );
    expect(result).toBe("Base.\n\nhello and also hello");
  });
});

describe("buildKannaRuntimeSystemPrompt", () => {
  it("builds Kanna discovery guidance for hidden agent instructions", () => {
    const result = buildKannaRuntimeSystemPrompt();

    expect(result).toContain("This session was launched by Kanna");
    expect(result).toContain("The current Kanna task id is in `KANNA_TASK_ID`.");
    expect(result).toContain("Kanna MCP tools are named `kanna_*`");
    expect(result).toContain("The bundled `kanna-cli` is on PATH");
  });
});

describe("buildKannaRuntimeUserPrompt", () => {
  it("prepends Kanna discovery guidance to visible-prompt-only agents", () => {
    const result = buildKannaRuntimeUserPrompt("Ship the feature");

    expect(result).toContain("This session was launched by Kanna");
    expect(result).toContain("The bundled `kanna-cli` is on PATH");
    expect(result).toMatch(/\n\nShip the feature$/);
  });
});
