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
- You are not running inside a Kanna sandbox; use the normal shell tools available in this worktree.
- Agents are assigned workspace ports from \`<repo>/.kanna/config.json\`; Kanna assigns ports nearest to each default depending on project specifics. Use the assigned ports for services like Vite servers and Firebase emulators. Do not leave your assigned workspace unless asked.
- Prefer Kanna MCP tools named \`kanna_*\` for Kanna task operations when your agent client exposes them.
- Claude tasks are launched with the instance-local MCP config via \`--mcp-config\` when \`kanna-mcp\` is available.
- If MCP tools are unavailable, fall back to the instance-local \`kanna-cli\`; it is exported as \`KANNA_CLI_PATH\` and its directory is prepended to PATH.
- Use \`kanna-cli guide\` for the generated fallback CLI manual and current workflow semantics.
- Do not push a branch or create a pull request unless this stage's prompt explicitly tells you to do so. Most stages should finish by recording stage completion so Kanna can advance the configured pipeline.
- When this stage is complete, prefer MCP \`kanna_complete_stage\`; fallback: \`kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "..."\`.`;

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
