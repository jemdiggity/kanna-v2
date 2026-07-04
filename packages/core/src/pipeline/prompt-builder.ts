export interface PromptContext {
  taskPrompt?: string;
  prevResult?: string;
  branch?: string;
  baseRef?: string;
  sourceWorktree?: string;
}

export interface KannaRuntimeContext {
  taskId?: string;
  stage?: string;
  pipeline?: string;
  transition?: string;
  /** Agent provider, used with mcpConfigured to describe MCP registration. */
  provider?: string;
  /** True when this session was launched with the Kanna MCP server registered. */
  mcpConfigured?: boolean;
}

// Canonical Kanna runtime guidance injected into every agent session.
// The source of truth is kanna-task-environment.md next to this file; the
// Rust task creator embeds that file via include_str!, and this constant
// must stay byte-identical to it (enforced by prompt-builder.test.ts).
export const KANNA_TASK_ENVIRONMENT_TEMPLATE = `## Kanna Task Environment

{{TASK_CONTEXT}}

Kanna is a desktop app that orchestrates coding agent tasks. Each task moves through the stages of a pipeline (for example: in progress -> review -> pr). The task itself is durable — its id, run history, and blockers survive every stage, and \`KANNA_TASK_ID\` always holds that id — but each stage transition forks a fresh workspace: a new branch and worktree named \`task-<taskid>-<n>\` cut from the previous stage's committed tip. A workspace is an ephemeral manifestation of the task: the name carries the durable task id plus a per-workspace counter (the creation workspace is plain \`task-<taskid>\`). Only committed work crosses a stage boundary; uncommitted changes stay behind in the old worktree. You are the agent for the current stage. Kanna advances the pipeline when you record this stage's result; do not move the task between stages yourself unless a prompt explicitly asks you to.

Rules:

- Work only in this worktree, on its current branch. Do not switch branches or touch the main checkout or other worktrees unless this stage's prompt says to.
- Do not push a branch or create a pull request unless this stage's prompt explicitly tells you to. Local commits are fine; publishing is usually a later pipeline stage.
- If the repo's \`.kanna/config.json\` declares \`ports\`, this session's environment has each of those variables set to a port reserved for this task. Start dev servers and other services on the assigned ports so parallel tasks do not collide.
- You are not running inside a Kanna sandbox; use the normal shell and tools available in this worktree.

Kanna task operations (inspect tasks, create subtasks, send input to other tasks, record stage results):

- Prefer the \`kanna_*\` MCP tools when your agent client exposes them (for example \`kanna_get_task\`, \`kanna_complete_stage\`).
- {{MCP_STATUS}}
- If MCP tools are unavailable, fall back to the \`kanna-cli\` binary; it is on \`PATH\` and its full path is exported as \`KANNA_CLI_PATH\`.
- Run \`kanna-cli guide\` for live task state, workflow semantics, and the full tool catalog.
- This task's id is in the \`KANNA_TASK_ID\` environment variable. Use it for all task operations; it is stable across stages, unlike branch and worktree names.

When this stage's goal is achieved, record completion so Kanna can advance the pipeline: prefer MCP \`kanna_complete_stage\` with status \`success\` and a short summary; fallback: \`kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "..."\`. If you are blocked or the goal cannot be met, record status \`failure\` with the reason instead of stopping silently.`;

// Mirrors build_kanna_preamble's context line in
// crates/kanna-server/src/task_creator/commands.rs — keep the formats in sync.
export function buildKannaTaskContextLine(context?: KannaRuntimeContext): string {
  let line = "This session was launched by Kanna";
  if (context?.taskId) {
    line += ` as task \`${context.taskId}\``;
  }
  if (context?.stage && context?.pipeline) {
    line += `, stage \`${context.stage}\` of pipeline \`${context.pipeline}\``;
  }
  if (context?.transition) {
    line += ` (transition: \`${context.transition}\`)`;
  }
  return `${line}.`;
}

// Mirrors kanna_mcp_launch_line in
// crates/kanna-server/src/task_creator/commands.rs — keep the texts in sync.
const MCP_LAUNCH_LINES: Record<string, string> = {
  claude:
    "Claude is launched with this config via `--mcp-config`, so Kanna MCP tools should be available automatically.",
  codex:
    "Codex is launched with Kanna MCP registration via `-c mcp_servers.kanna-mcp.*` overrides, so Kanna MCP tools should be available automatically.",
  copilot:
    "Copilot is launched with this config via `--additional-mcp-config`, so Kanna MCP tools should be available automatically.",
  opencode:
    "OpenCode is launched with Kanna MCP registration via `OPENCODE_CONFIG_CONTENT`, so Kanna MCP tools should be available automatically.",
  antigravity:
    "Antigravity CLI MCP registration is not wired because `agy 1.0.14` exposes no stable MCP flag or config surface; use the `kanna-cli` fallback for Kanna task operations.",
};

export function buildKannaMcpStatusLine(context?: KannaRuntimeContext): string | null {
  if (!context?.mcpConfigured || !context.provider) return null;
  return MCP_LAUNCH_LINES[context.provider] ?? null;
}

export function buildKannaRuntimeSystemPrompt(context?: KannaRuntimeContext): string {
  const mcpStatus = buildKannaMcpStatusLine(context);
  return KANNA_TASK_ENVIRONMENT_TEMPLATE.replace(
    "{{TASK_CONTEXT}}",
    buildKannaTaskContextLine(context)
  ).replace(mcpStatus ? "{{MCP_STATUS}}" : "- {{MCP_STATUS}}\n", mcpStatus ?? "");
}

export function buildKannaRuntimeUserPrompt(
  prompt: string,
  context?: KannaRuntimeContext
): string {
  return `${buildKannaRuntimeSystemPrompt(context)}\n\n${prompt}`;
}

export function buildStagePrompt(
  agentPrompt: string,
  stagePrompt: string | undefined,
  context: PromptContext
): string {
  const parts = [agentPrompt, stagePrompt].filter(
    (p): p is string => p !== undefined && p.trim() !== ""
  );
  const combined = parts.join("\n\n");

  return combined
    .replaceAll("$TASK_PROMPT", context.taskPrompt ?? "")
    .replaceAll("$PREV_RESULT", context.prevResult ?? "")
    .replaceAll("$BRANCH", context.branch ?? "")
    .replaceAll("$BASE_REF", context.baseRef ?? "")
    .replaceAll("$SOURCE_WORKTREE", context.sourceWorktree ?? "");
}
