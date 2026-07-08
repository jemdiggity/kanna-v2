export interface ReviewAnchor {
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface PendingReviewComment extends ReviewAnchor {
  id: string;
  excerpt: string;
  note: string;
  headCommit: string;
}

export interface BuildRevisionPromptOptions {
  taskId: string;
  headCommit: string;
  baseRef: string;
  comments: PendingReviewComment[];
  summary: string;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function displayTaskId(taskId: string): string {
  return taskId.startsWith("task-") ? taskId : `task-${taskId}`;
}

function normalizeLineRange(anchor: ReviewAnchor): { startLine: number; endLine: number } {
  const startLine = Math.max(1, Math.min(anchor.startLine, anchor.endLine));
  const endLine = Math.max(1, Math.max(anchor.startLine, anchor.endLine));
  return { startLine, endLine };
}

export function formatReviewAnchor(anchor: ReviewAnchor): string {
  const { startLine, endLine } = normalizeLineRange(anchor);
  return startLine === endLine
    ? `${anchor.filePath}:${startLine}`
    : `${anchor.filePath}:${startLine}-${endLine}`;
}

function formatExcerpt(excerpt: string): string[] {
  const lines = excerpt.trimEnd().split("\n").filter((line, index, allLines) => {
    return line.length > 0 || index < allLines.length - 1;
  });
  if (lines.length === 0) return [">"];
  return lines.map((line) => `> ${line}`);
}

function formatCommentBlock(comment: PendingReviewComment, currentHeadCommit: string): string[] {
  const staleSuffix = comment.headCommit && comment.headCommit !== currentHeadCommit
    ? ` (written against ${shortSha(comment.headCommit)})`
    : "";
  return [
    `${formatReviewAnchor(comment)}${staleSuffix}`,
    ...formatExcerpt(comment.excerpt),
    comment.note.trim(),
  ];
}

export function buildRevisionPrompt(options: BuildRevisionPromptOptions): string {
  const lines: string[] = [
    `Revision requested from review of ${displayTaskId(options.taskId)} @ ${shortSha(options.headCommit)} (branch diff vs ${options.baseRef}).`,
  ];

  for (const comment of options.comments) {
    lines.push("", ...formatCommentBlock(comment, options.headCommit));
  }

  const summary = options.summary.trim();
  if (summary) {
    lines.push("", `Overall: ${summary}`);
  }

  return lines.join("\n");
}
