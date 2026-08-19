import type { TaskSummary } from "../lib/api/types";
import type { TaskUiSlot } from "../state/taskUiSlots";
import { taskUiSlotToTaskSummary } from "../state/taskUiSlots";

/**
 * Owner-pinned tasks belong at the top of the list they were pinned in — the
 * whole point of the gesture, and desktop sidebar parity (pinned rows render
 * above every other row in their repo, ordered by `pinOrder`).
 *
 * Pin state travels on the task payload itself (`pinned`/`pinOrder`), which
 * both the LAN summaries and the Firestore-published index carry, so ordering
 * is a pure client-side projection of what the list already holds.
 */
export function isPinnedTask(task: TaskSummary): boolean {
  return task.pinned ?? false;
}

/**
 * Owner-side ordering among pinned rows. A pinned row without a `pinOrder`
 * (a payload from a peer that predates the column, or a still-optimistic
 * local pin) sorts after the ordered ones rather than jumping the queue.
 */
function pinRank(task: TaskSummary): number {
  const pinOrder = task.pinOrder ?? null;
  return pinOrder === null ? Number.MAX_SAFE_INTEGER : pinOrder;
}

/**
 * Hoists pinned slots above the rest, preserving the caller's ordering within
 * each group (so the unpinned tail keeps whatever order the view chose, and
 * pinned rows with equal `pinOrder` stay stable).
 */
export function orderTaskSlotsPinnedFirst(
  slots: readonly TaskUiSlot[]
): TaskUiSlot[] {
  const pinned: Array<{ slot: TaskUiSlot; rank: number; index: number }> = [];
  const rest: TaskUiSlot[] = [];
  slots.forEach((slot, index) => {
    const task = taskUiSlotToTaskSummary(slot);
    if (isPinnedTask(task)) {
      pinned.push({ slot, rank: pinRank(task), index });
    } else {
      rest.push(slot);
    }
  });
  pinned.sort((left, right) => left.rank - right.rank || left.index - right.index);
  return [...pinned.map(({ slot }) => slot), ...rest];
}
