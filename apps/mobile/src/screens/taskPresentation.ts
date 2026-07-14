import type { TaskSummary } from "../lib/api/types";

const TASK_TITLE_LIMIT = 80;
const WAITING_PROMPT_LIMIT = 240;

export interface TaskListItemModel {
  stageLabel: string;
  title: string;
  waitingPromptSnippet: string | null;
  isWaitingPromptPlaceholder: boolean;
}

export function truncateVisibleText(value: string, limit: number): string {
  if (limit <= 0) return "";
  const characters = Array.from(value.trim());
  if (characters.length <= limit) return characters.join("");
  return `${characters.slice(0, limit - 1).join("")}…`;
}

export function buildTaskListItemModel(task: TaskSummary): TaskListItemModel {
  const prompt = task.waitingPromptSnippet?.trim() ?? "";
  const isDuplicatePrompt = Boolean(prompt) && prompt === task.title.trim();
  return {
    stageLabel: task.stage ?? "unknown",
    title: truncateVisibleText(task.title, TASK_TITLE_LIMIT),
    waitingPromptSnippet: isDuplicatePrompt
      ? null
      : prompt
      ? truncateVisibleText(prompt, WAITING_PROMPT_LIMIT)
      : "…",
    isWaitingPromptPlaceholder: !prompt && !isDuplicatePrompt
  };
}
