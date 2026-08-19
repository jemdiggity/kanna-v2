import type { TaskUiSlot } from "../state/taskUiSlots";
import { taskUiSlotToTaskSummary } from "../state/taskUiSlots";

/**
 * Pinned tasks belong at the top of the list they were pinned in — the whole
 * point of the gesture, and desktop sidebar parity (pinned rows render above
 * every other row in their repo).
 *
 * Mobile pins are phone-local: the ids come from this device's own record
 * rather than from the task payload, so the ordering is a pure projection of
 * state the phone already holds and needs no read to agree with it. The
 * desktop keeps its own pin state, which mobile no longer reads or writes.
 */
export function isPinnedTask(
  taskId: string,
  pinnedTaskIds: readonly string[]
): boolean {
  return pinnedTaskIds.includes(taskId);
}

/**
 * Hoists pinned slots above the rest in pin order, preserving the caller's
 * ordering within each group (so the unpinned tail keeps whatever order the
 * view chose).
 */
export function orderTaskSlotsPinnedFirst(
  slots: readonly TaskUiSlot[],
  pinnedTaskIds: readonly string[]
): TaskUiSlot[] {
  const pinned: Array<{ slot: TaskUiSlot; rank: number; index: number }> = [];
  const rest: TaskUiSlot[] = [];
  slots.forEach((slot, index) => {
    const rank = pinnedTaskIds.indexOf(taskUiSlotToTaskSummary(slot).id);
    if (rank >= 0) {
      pinned.push({ slot, rank, index });
    } else {
      rest.push(slot);
    }
  });
  pinned.sort((left, right) => left.rank - right.rank || left.index - right.index);
  return [...pinned.map(({ slot }) => slot), ...rest];
}
