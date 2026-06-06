export interface PromptContext {
  taskPrompt?: string;
  prevResult?: string;
  branch?: string;
  baseRef?: string;
  sourceWorktree?: string;
}

const KANNA_RUNTIME_GUIDANCE = `## Kanna Task Environment

This session was launched by Kanna, a desktop app that manages agent tasks, worktrees, and pipeline stages.

- The current Kanna task id is in \`KANNA_TASK_ID\`.
- Kanna MCP tools are named \`kanna_*\` when your agent client exposes them.
- The bundled \`kanna-cli\` is on PATH for Kanna task operations from the shell.`;

export function buildKannaRuntimeSystemPrompt(): string {
  return KANNA_RUNTIME_GUIDANCE;
}

export function buildKannaRuntimeUserPrompt(prompt: string): string {
  return `${KANNA_RUNTIME_GUIDANCE}\n\n${prompt}`;
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
