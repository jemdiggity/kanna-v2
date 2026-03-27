import { describe, it, expect } from "vitest";
import { buildStagePrompt } from "./prompt-builder";

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
      "Task: $TASK_PROMPT, Prev: $PREV_RESULT, Branch: $BRANCH",
      {}
    );
    expect(result).toBe("Base.\n\nTask: , Prev: , Branch: ");
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
