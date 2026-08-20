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
    expect(result).toBe(
      "## Agent Instructions\n\nAgent base prompt.\n\n## Your Task\n\nNo variables here."
    );
  });

  it("replaces undefined/missing variables with empty string", () => {
    const result = buildStagePrompt(
      "Base.",
      "Task: $TASK_PROMPT, Prev: $PREV_RESULT, Branch: $BRANCH, Base: $BASE_REF, Source: $SOURCE_WORKTREE",
      {}
    );
    expect(result).toBe(
      "## Agent Instructions\n\nBase.\n\n## Your Task\n\nTask: , Prev: , Branch: , Base: , Source: "
    );
  });

  it("combines agent base prompt with stage prompt separated by double newline", () => {
    const result = buildStagePrompt(
      "Agent base prompt.",
      "Stage specific prompt.",
      {}
    );
    expect(result).toBe(
      "## Agent Instructions\n\nAgent base prompt.\n\n## Your Task\n\nStage specific prompt."
    );
  });

  it("uses only the agent prompt when stage prompt is undefined", () => {
    const result = buildStagePrompt("Agent base prompt only.", undefined, {
      taskPrompt: "task",
    });
    expect(result).toBe("## Agent Instructions\n\nAgent base prompt only.");
  });

  it("uses only the stage prompt when the agent prompt is whitespace", () => {
    const result = buildStagePrompt(" \n\t", "  Stage prompt only.\n", {});

    expect(result).toBe("## Your Task\n\nStage prompt only.");
  });

  it("trims nonempty agent and stage prompt bodies", () => {
    const result = buildStagePrompt(
      "  Agent base prompt.\n",
      "\nStage specific prompt.  ",
      {}
    );

    expect(result).toBe(
      "## Agent Instructions\n\nAgent base prompt.\n\n## Your Task\n\nStage specific prompt."
    );
  });

  it("omits a whitespace-only stage prompt", () => {
    const result = buildStagePrompt("  Agent base prompt only.\n", " \n\t", {});

    expect(result).toBe("## Agent Instructions\n\nAgent base prompt only.");
  });

  it("returns an empty prompt when both sections are blank", () => {
    const result = buildStagePrompt(" \n", "\t", {});

    expect(result).toBe("");
  });

  it("omits a section whose rendered body is empty", () => {
    const result = buildStagePrompt(
      "Follow the review policy.",
      "$TASK_PROMPT",
      { taskPrompt: "" }
    );

    expect(result).toBe("## Agent Instructions\n\nFollow the review policy.");
  });

  it("substitutes variables in both agent prompt and stage prompt", () => {
    const result = buildStagePrompt(
      "Agent for $BRANCH.",
      "Task: $TASK_PROMPT",
      { branch: "main", taskPrompt: "do it" }
    );
    expect(result).toBe(
      "## Agent Instructions\n\nAgent for main.\n\n## Your Task\n\nTask: do it"
    );
  });

  it("replaces all occurrences of a variable", () => {
    const result = buildStagePrompt(
      "Base.",
      "$TASK_PROMPT and also $TASK_PROMPT",
      { taskPrompt: "hello" }
    );
    expect(result).toBe(
      "## Agent Instructions\n\nBase.\n\n## Your Task\n\nhello and also hello"
    );
  });

  it("does not rescan reserved tokens introduced by substitution", () => {
    const result = buildStagePrompt(
      "Agent context: $TASK_PROMPT",
      "Previous result: $PREV_RESULT",
      { taskPrompt: "$PREV_RESULT", prevResult: "sensitive result" }
    );

    expect(result).toBe(
      "## Agent Instructions\n\nAgent context: $PREV_RESULT\n\n## Your Task\n\nPrevious result: sensitive result"
    );
  });

  it("matches Rust braced variables and bare-token boundaries", () => {
    const result = buildStagePrompt(
      "Braced task: ${TASK_PROMPT}",
      "Unknown suffix: $TASK_PROMPT_SUFFIX",
      { taskPrompt: "ship it" }
    );

    expect(result).toBe(
      "## Agent Instructions\n\nBraced task: ship it\n\n## Your Task\n\nUnknown suffix: $TASK_PROMPT_SUFFIX"
    );
  });

  it("labels agent instructions separately from the actual task", () => {
    const result = buildStagePrompt(
      "Generic agent guidance.\n\n## Completion\nSummarize the work.",
      "$TASK_PROMPT",
      { taskPrompt: "Fix the buried task." }
    );
    expect(result).toBe(
      "## Agent Instructions\n\nGeneric agent guidance.\n\n## Completion\nSummarize the work.\n\n## Your Task\n\nFix the buried task."
    );
  });
});

describe("KANNA_TASK_ENVIRONMENT_TEMPLATE", () => {
  it("stays in sync with the canonical kanna-task-environment.md shared with the Rust task creator", () => {
    const canonical = readFileSync(
      resolve(process.cwd(), "src/workflow/kanna-task-environment.md"),
      "utf8"
    );

    expect(KANNA_TASK_ENVIRONMENT_TEMPLATE).toBe(canonical.trimEnd());
    expect(KANNA_TASK_ENVIRONMENT_TEMPLATE).toContain(
      "Stop every background process you start before recording stage completion."
    );
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
      workflow: "qa",
      transition: "auto",
    });

    expect(line).toBe(
      "This session was launched by Kanna as task `task-123`, stage `review` of workflow `qa` (transition: `auto`)."
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
    expect(result).not.toContain("kanna_info");
    expect(result).not.toContain("kanna-cli info");
    expect(result).not.toContain("authoritative server environment");
    expect(result).not.toContain("staging/production");
    expect(result).not.toContain("{{TASK_CONTEXT}}");
    expect(result).not.toContain("{{MCP_STATUS}}");
    expect(result).not.toContain("{{COMPLETION}}");
  });

  it("defaults to manual completion guidance, matching the Rust build_kanna_preamble default", () => {
    const result = buildKannaRuntimeSystemPrompt({ taskId: "task-1" });

    expect(result).toContain("This stage's transition is `manual`");
    expect(result).toContain("recording a successful result does not advance the workflow");
    expect(result).toContain("record completion only if this stage's prompt asks for it");
    expect(result).toContain("record status `failure` with the reason");
    expect(result).not.toContain("--status success");
    expect(result).not.toContain("{{COMPLETION}}");
  });

  it("renders manual completion guidance for manual-transition stages", () => {
    const result = buildKannaRuntimeSystemPrompt({
      taskId: "task-1",
      stage: "in progress",
      workflow: "default",
      transition: "manual",
    });

    expect(result).toContain("This stage's transition is `manual`");
    expect(result).not.toContain("record completion so Kanna can advance the workflow");
    expect(result).toContain(
      'kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "failure"'
    );
  });

  it("instructs auto-transition stages to record completion so Kanna advances the workflow", () => {
    const result = buildKannaRuntimeSystemPrompt({
      taskId: "task-1",
      stage: "review",
      workflow: "qa",
      transition: "auto",
    });

    expect(result).toContain("This stage's transition is `auto`");
    expect(result).toContain("record completion so Kanna can advance the workflow");
    expect(result).toContain(
      'kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "success"'
    );
    expect(result).toContain('--status success --summary "..."');
    expect(result).not.toContain("{{COMPLETION}}");
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
      workflow: "default",
      transition: "manual",
    });

    expect(result).toContain(
      "This session was launched by Kanna as task `task-abc`, stage `in progress` of workflow `default` (transition: `manual`)."
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
    expect(result).not.toContain("kanna_info");
    expect(result).not.toContain("kanna-cli info");
    expect(result).toMatch(/\n\n## Your Task\n\nShip the feature$/);
  });

  it("passes the task context through to the guidance", () => {
    const result = buildKannaRuntimeUserPrompt("Ship it", { taskId: "task-9" });

    expect(result).toContain("as task `task-9`");
    expect(result).toMatch(/\n\n## Your Task\n\nShip it$/);
  });

  it("delimits the task with a heading matching prompt_with_system_prompt in adapter.rs", () => {
    const result = buildKannaRuntimeUserPrompt("Ship it");

    const guidanceIndex = result.indexOf("## Kanna Task Environment");
    const taskIndex = result.indexOf("## Your Task");
    expect(guidanceIndex).toBeGreaterThan(-1);
    expect(taskIndex).toBeGreaterThan(guidanceIndex);
  });

  it("does not duplicate an existing task section", () => {
    const prompt = "## Agent Instructions\n\nFollow policy.\n\n## Your Task\n\nShip it";
    const result = buildKannaRuntimeUserPrompt(prompt);
    expect(result.match(/^## Your Task$/gm)).toHaveLength(1);
    expect(result).toMatch(/## Agent Instructions[\s\S]*## Your Task\n\nShip it$/);
  });

  it("preserves an agent-only section without adding an empty task section", () => {
    const prompt = "## Agent Instructions\n\nFollow policy.";
    const result = buildKannaRuntimeUserPrompt(prompt);

    expect(result).toMatch(/## Agent Instructions\n\nFollow policy\.$/);
    expect(result).not.toMatch(/^## Your Task$/gm);
  });

  it("does not add a task section for a blank prompt", () => {
    const result = buildKannaRuntimeUserPrompt(" \n\t");

    expect(result).toBe(buildKannaRuntimeSystemPrompt());
  });

  it("frames a raw prompt even when its content contains a nested task heading", () => {
    const prompt = "Explain this excerpt:\n\n## Your Task\n\nNested text";
    const result = buildKannaRuntimeUserPrompt(prompt);

    expect(result).toMatch(/## Your Task\n\nExplain this excerpt:/);
    expect(result.match(/^## Your Task$/gm)).toHaveLength(2);
  });
});
