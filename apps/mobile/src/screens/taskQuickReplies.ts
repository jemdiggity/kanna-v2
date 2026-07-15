export interface TaskQuickReply {
  id: string;
  label: string;
  messagePrefix: string;
}

export const TASK_QUICK_REPLIES: readonly TaskQuickReply[] = [
  {
    id: "sgtm-proceed",
    label: "SGTM. Proceed.",
    messagePrefix: "SGTM. Proceed."
  }
];

export function buildTaskQuickReply(
  quickReply: TaskQuickReply,
  draft: string
): string {
  const trimmedDraft = draft.trim();
  return trimmedDraft
    ? `${quickReply.messagePrefix}\n\n${trimmedDraft}`
    : quickReply.messagePrefix;
}
