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

function isUnicodeWhitespace(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x0009 && codePoint <= 0x000d) ||
    codePoint === 0x0020 ||
    codePoint === 0x0085 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

function daemonWaitingPromptRepresentation(value: string): string {
  let normalized = "";
  let pendingSpace = false;
  for (const character of value) {
    if (isUnicodeWhitespace(character)) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) normalized += " ";
    normalized += character;
    pendingSpace = false;
  }
  const characters = Array.from(normalized);
  if (characters.length <= WAITING_PROMPT_LIMIT) return normalized;
  return `${characters.slice(0, WAITING_PROMPT_LIMIT - 1).join("")}…`;
}

export function buildTaskListItemModel(task: TaskSummary): TaskListItemModel {
  const storedTitle = (task.title ?? "").trim() ? task.title : "";
  const promptTitle = task.prompt
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  const title = storedTitle || promptTitle || "Untitled task";
  const prompt = task.waitingPromptSnippet?.trim() ?? "";
  const isDuplicatePrompt =
    Boolean(prompt) && prompt === daemonWaitingPromptRepresentation(title);
  return {
    stageLabel: task.stage ?? "unknown",
    title: truncateVisibleText(title, TASK_TITLE_LIMIT),
    waitingPromptSnippet: isDuplicatePrompt
      ? null
      : prompt
      ? truncateVisibleText(prompt, WAITING_PROMPT_LIMIT)
      : "…",
    isWaitingPromptPlaceholder: !prompt && !isDuplicatePrompt
  };
}
