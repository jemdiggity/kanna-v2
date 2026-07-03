import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  KANNA_TASK_ENVIRONMENT_TEMPLATE,
  buildKannaMcpStatusLine,
  buildKannaRuntimeSystemPrompt,
  buildKannaRuntimeUserPrompt,
  buildKannaTaskContextLine,
  buildStagePrompt,
} from "./prompt-builder";

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

describe("KANNA_TASK_ENVIRONMENT_TEMPLATE", () => {
  it("stays in sync with the canonical kanna-task-environment.md shared with the Rust task creator", () => {
    const canonical = readFileSync(
      resolve(process.cwd(), "src/pipeline/kanna-task-environment.md"),
      "utf8"
    );

    expect(KANNA_TASK_ENVIRONMENT_TEMPLATE).toBe(canonical.trimEnd());
  });
});

describe("buildKannaTaskContextLine", () => {
  it("renders the generic line when no context is known", () => {
    expect(buildKannaTaskContextLine()).toBe("This session was launched by Kanna.");
  });

  it("renders the task id when known", () => {
    expect(buildKannaTaskContextLine({ taskId: "task-123" })).toBe(
      "This session was launched by Kanna as task `task-123`."
    );
  });

  it("matches the Rust build_kanna_preamble format when full context is known", () => {
    const line = buildKannaTaskContextLine({
      taskId: "task-123",
      stage: "review",
      pipeline: "qa",
      transition: "auto",
    });

    expect(line).toBe(
      "This session was launched by Kanna as task `task-123`, stage `review` of pipeline `qa` (transition: `auto`)."
    );
  });
});

describe("buildKannaRuntimeSystemPrompt", () => {
  it("builds Kanna runtime guidance for hidden agent instructions", () => {
    const result = buildKannaRuntimeSystemPrompt();

    expect(result).toContain("## Kanna Task Environment");
    expect(result).toContain("This session was launched by Kanna");
    expect(result).toContain("This task's id is in the `KANNA_TASK_ID` environment variable.");
    expect(result).toContain("You are not running inside a Kanna sandbox");
    expect(result).toContain("Prefer the `kanna_*` MCP tools");
    expect(result).toContain("fall back to the `kanna-cli` binary");
    expect(result).toContain("KANNA_CLI_PATH");
    expect(result).toContain("kanna-cli guide");
    expect(result).toContain("kanna_complete_stage");
    expect(result).toContain('kanna-cli stage-complete --task-id "$KANNA_TASK_ID"');
    expect(result).toContain("record status `failure` with the reason");
    expect(result).toContain("Do not push a branch or create a pull request unless this stage's prompt explicitly tells you to");
    expect(result).toContain("Work only in this worktree");
    expect(result).toContain("Only committed work crosses a stage boundary");
    expect(result).toContain("each stage transition forks a fresh workspace");
    expect(result).toContain("Start dev servers and other services on the assigned ports so parallel tasks do not collide");
    expect(result).not.toContain("{{TASK_CONTEXT}}");
    expect(result).not.toContain("{{MCP_STATUS}}");
  });

  it("drops the MCP status bullet when registration state is unknown", () => {
    const result = buildKannaRuntimeSystemPrompt();

    expect(result).not.toContain("{{MCP_STATUS}}");
    expect(result).not.toContain("should be available automatically");
  });

  it("names the provider's automatic MCP registration when configured", () => {
    const result = buildKannaRuntimeSystemPrompt({
      taskId: "task-1",
      provider: "claude",
      mcpConfigured: true,
    });

    expect(result).toContain(
      "- Claude is launched with this config via `--mcp-config`, so Kanna MCP tools should be available automatically."
    );
    expect(result).not.toContain("{{MCP_STATUS}}");
  });

  it("prefers MCP tools before describing the CLI fallback", () => {
    const result = buildKannaRuntimeSystemPrompt();

    const mcpIndex = result.indexOf("Prefer the `kanna_*` MCP tools");
    const cliIndex = result.indexOf("fall back to the `kanna-cli` binary");
    expect(mcpIndex).toBeGreaterThan(-1);
    expect(cliIndex).toBeGreaterThan(mcpIndex);
  });

  it("inlines the task context when provided", () => {
    const result = buildKannaRuntimeSystemPrompt({
      taskId: "task-abc",
      stage: "in progress",
      pipeline: "default",
      transition: "manual",
    });

    expect(result).toContain(
      "This session was launched by Kanna as task `task-abc`, stage `in progress` of pipeline `default` (transition: `manual`)."
    );
  });
});

describe("buildKannaMcpStatusLine", () => {
  it("returns null without provider or registration", () => {
    expect(buildKannaMcpStatusLine()).toBeNull();
    expect(buildKannaMcpStatusLine({ provider: "claude" })).toBeNull();
    expect(buildKannaMcpStatusLine({ mcpConfigured: true })).toBeNull();
  });

  it("directs Antigravity to the CLI fallback, matching kanna_mcp_launch_line in commands.rs", () => {
    const line = buildKannaMcpStatusLine({ provider: "antigravity", mcpConfigured: true });

    expect(line).toContain("Antigravity CLI MCP registration is not wired");
    expect(line).toContain("use the `kanna-cli` fallback for Kanna task operations");
  });
});

describe("buildKannaRuntimeUserPrompt", () => {
  it("prepends Kanna runtime guidance to visible-prompt-only agents", () => {
    const result = buildKannaRuntimeUserPrompt("Ship the feature");

    expect(result).toContain("This session was launched by Kanna");
    expect(result).toContain("Prefer the `kanna_*` MCP tools");
    expect(result).toContain("fall back to the `kanna-cli` binary");
    expect(result).toMatch(/\n\nShip the feature$/);
  });

  it("passes the task context through to the guidance", () => {
    const result = buildKannaRuntimeUserPrompt("Ship it", { taskId: "task-9" });

    expect(result).toContain("as task `task-9`");
    expect(result).toMatch(/\n\nShip it$/);
  });
});
