import type { PipelineItem } from "../types/kanna"

/**
 * The two facts the sidebar draws, read as two facts.
 *
 * `activity` is a *blend* of the runtime and read dimensions into a single
 * `working | idle | unread`, so it can only ever report one of them: a task
 * that is working and whose latest output nobody has read reads `unread`,
 * exactly like a finished one, and the working mark is simply lost. Reading
 * `runtime_state` and `read_state` separately is what lets both show at once.
 *
 * Each helper falls back to `activity` when its own dimension is absent so
 * snapshots published before the split fields were added still render.
 */

type TaskActivityFields = Pick<PipelineItem, "activity" | "runtime_state" | "read_state">

/**
 * Whether the task's agent session is doing work right now — including work
 * blocked inside a long tool or build call, which is what `busy` means to the
 * daemon. Never inferred from silence.
 */
export function isTaskWorking(item: TaskActivityFields): boolean {
  if (item.runtime_state != null) {
    return item.runtime_state === "busy"
  }
  return item.activity === "working"
}

/** Whether the task's latest output is still unread by a human. */
export function isTaskUnread(item: TaskActivityFields): boolean {
  if (item.read_state != null) {
    return item.read_state === "unread"
  }
  return item.activity === "unread"
}

/**
 * Whether the sidebar draws the unread mark.
 *
 * The mark is orthogonal to runtime styling: busy + unread deliberately draws
 * both the working treatment and this mark.
 */
export function showsUnreadMark(item: TaskActivityFields): boolean {
  return isTaskUnread(item)
}
