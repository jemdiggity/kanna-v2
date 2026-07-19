export interface TaskQuickReply {
  id: string;
  text: string;
}

export const MIN_TASK_QUICK_REPLIES = 1;
export const MAX_TASK_QUICK_REPLIES = 5;
export const MAX_TASK_QUICK_REPLY_LENGTH = 200;

export const DEFAULT_TASK_QUICK_REPLIES: readonly TaskQuickReply[] = [
  {
    id: "sgtm-proceed",
    text: "SGTM. Proceed."
  }
];

export interface TaskQuickReplyValidation {
  valid: boolean;
  errors: Record<number, string>;
  listError: string | null;
}

export function normalizeTaskQuickReplies(value: unknown): TaskQuickReply[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const replies: TaskQuickReply[] = [];
  const normalizedTexts = new Set<string>();
  const ids = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as Partial<TaskQuickReply>;
    if (typeof candidate.id !== "string" || typeof candidate.text !== "string") {
      continue;
    }

    const id = candidate.id.trim();
    const text = candidate.text.trim();
    const normalizedText = text.toLocaleLowerCase();
    if (
      !id ||
      !text ||
      text.length > MAX_TASK_QUICK_REPLY_LENGTH ||
      ids.has(id) ||
      normalizedTexts.has(normalizedText)
    ) {
      continue;
    }

    replies.push({ id, text });
    ids.add(id);
    normalizedTexts.add(normalizedText);
    if (replies.length === MAX_TASK_QUICK_REPLIES) {
      break;
    }
  }

  return replies;
}

export function validateTaskQuickReplies(
  replies: readonly TaskQuickReply[]
): TaskQuickReplyValidation {
  const errors: Record<number, string> = {};
  let listError: string | null = null;

  if (replies.length < MIN_TASK_QUICK_REPLIES) {
    listError = "Add at least one quick reply.";
  } else if (replies.length > MAX_TASK_QUICK_REPLIES) {
    listError = `Keep at most ${MAX_TASK_QUICK_REPLIES} quick replies.`;
  }

  const firstTextIndex = new Map<string, number>();
  replies.forEach((reply, index) => {
    const text = reply.text.trim();
    if (!text) {
      errors[index] = "Quick replies cannot be blank.";
      return;
    }
    if (text.length > MAX_TASK_QUICK_REPLY_LENGTH) {
      errors[index] = `Quick replies must be ${MAX_TASK_QUICK_REPLY_LENGTH} characters or fewer.`;
      return;
    }

    const normalizedText = text.toLocaleLowerCase();
    if (firstTextIndex.has(normalizedText)) {
      errors[index] = "Quick replies must be unique.";
      return;
    }
    firstTextIndex.set(normalizedText, index);
  });

  return {
    valid: listError === null && Object.keys(errors).length === 0,
    errors,
    listError
  };
}

export function addTaskQuickReply(
  replies: readonly TaskQuickReply[],
  reply: TaskQuickReply
): readonly TaskQuickReply[] {
  if (
    replies.length >= MAX_TASK_QUICK_REPLIES ||
    replies.some((candidate) => candidate.id === reply.id)
  ) {
    return replies;
  }
  return [...replies, reply];
}

export function updateTaskQuickReply(
  replies: readonly TaskQuickReply[],
  replyId: string,
  text: string
): readonly TaskQuickReply[] {
  const index = replies.findIndex((reply) => reply.id === replyId);
  if (index === -1 || replies[index]?.text === text) {
    return replies;
  }
  return replies.map((reply) =>
    reply.id === replyId ? { ...reply, text } : reply
  );
}

export function deleteTaskQuickReply(
  replies: readonly TaskQuickReply[],
  replyId: string
): readonly TaskQuickReply[] {
  if (
    replies.length <= MIN_TASK_QUICK_REPLIES ||
    !replies.some((reply) => reply.id === replyId)
  ) {
    return replies;
  }
  return replies.filter((reply) => reply.id !== replyId);
}

export function moveTaskQuickReply(
  replies: readonly TaskQuickReply[],
  replyId: string,
  direction: -1 | 1
): readonly TaskQuickReply[] {
  const currentIndex = replies.findIndex((reply) => reply.id === replyId);
  const targetIndex = currentIndex + direction;
  if (
    currentIndex === -1 ||
    targetIndex < 0 ||
    targetIndex >= replies.length
  ) {
    return replies;
  }

  const reordered = [...replies];
  const [reply] = reordered.splice(currentIndex, 1);
  if (!reply) {
    return replies;
  }
  reordered.splice(targetIndex, 0, reply);
  return reordered;
}

export function buildTaskQuickReply(
  quickReply: TaskQuickReply,
  draft: string
): string {
  const trimmedDraft = draft.trim();
  return trimmedDraft
    ? `${quickReply.text}\n\n${trimmedDraft}`
    : quickReply.text;
}
