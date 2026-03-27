export interface PromptContext {
  taskPrompt?: string;
  prevResult?: string;
  branch?: string;
}

export function buildStagePrompt(
  agentPrompt: string,
  stagePrompt: string | undefined,
  context: PromptContext
): string {
  const combined =
    stagePrompt !== undefined
      ? `${agentPrompt}\n\n${stagePrompt}`
      : agentPrompt;

  return combined
    .replaceAll("$TASK_PROMPT", context.taskPrompt ?? "")
    .replaceAll("$PREV_RESULT", context.prevResult ?? "")
    .replaceAll("$BRANCH", context.branch ?? "");
}
