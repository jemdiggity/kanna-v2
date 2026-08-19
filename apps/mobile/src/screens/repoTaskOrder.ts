import type { TaskUiSlot } from "../state/taskUiSlots";
import { taskUiSlotToTaskSummary } from "../state/taskUiSlots";
import { orderTaskSlotsPinnedFirst } from "./taskPinOrder";
import { taskCreationTimestamp } from "./taskTreeRows";

function sortTaskSlotsNewestFirst(taskSlots: readonly TaskUiSlot[]): TaskUiSlot[] {
  return [...taskSlots].sort((left, right) => {
    const leftTimestamp = taskCreationTimestamp(taskUiSlotToTaskSummary(left));
    const rightTimestamp = taskCreationTimestamp(taskUiSlotToTaskSummary(right));
    if (leftTimestamp === null) return rightTimestamp === null ? 0 : 1;
    if (rightTimestamp === null) return -1;
    return rightTimestamp - leftTimestamp;
  });
}

/**
 * The order the repo-scoped Tasks list renders in: owner-pinned tasks first,
 * in their owner pin order, then everything else newest first.
 *
 * It reads `pinned`/`pinOrder` straight off the task payload, which both the
 * LAN summaries and the Firestore-published index carry, so the same ordering
 * holds whichever transport served the list.
 */
export function orderRepoTaskSlots(
  taskSlots: readonly TaskUiSlot[]
): TaskUiSlot[] {
  return orderTaskSlotsPinnedFirst(sortTaskSlotsNewestFirst(taskSlots));
}
