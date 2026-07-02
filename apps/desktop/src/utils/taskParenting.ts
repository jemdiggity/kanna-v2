import type { PipelineItem } from "@kanna/db";

/** A task is open while it has not been closed. */
export function isOpenTask(item: Pick<PipelineItem, "closed_at">): boolean {
  return item.closed_at == null;
}

/** True when `taskId` has at least one open subtask — used to keep parents open until drained. */
export function hasOpenSubtasks(items: readonly PipelineItem[], taskId: string): boolean {
  return items.some(
    (candidate) =>
      candidate.parent_task_id === taskId && candidate.id !== taskId && isOpenTask(candidate),
  );
}

export type ParentAssignmentError = "same-task" | "different-repo" | "cycle";

/**
 * Validate nesting `childId` under `parentId`. Returns an error reason when the assignment is
 * invalid, or null when it is allowed (including the no-op case where a referenced task is
 * missing — the caller decides what to do then). Mirrors the server's set-parent invariants.
 */
export function validateParentAssignment(
  items: readonly PipelineItem[],
  childId: string,
  parentId: string,
): ParentAssignmentError | null {
  if (childId === parentId) return "same-task";
  const child = items.find((item) => item.id === childId);
  const parent = items.find((item) => item.id === parentId);
  if (!child || !parent) return null;
  if (parent.repo_id !== child.repo_id) return "different-repo";

  // Walk the proposed parent's ancestry; reaching the child means this would form a cycle.
  const seen = new Set<string>();
  let cursor: string | null = parent.id;
  while (cursor) {
    if (cursor === childId) return "cycle";
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = items.find((item) => item.id === cursor)?.parent_task_id ?? null;
  }
  return null;
}
