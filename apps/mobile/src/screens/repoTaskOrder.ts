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
 * The order the repo-scoped Tasks list renders in: this phone's pinned tasks
 * first, in its own pin order, then everything else newest first.
 */
export function orderRepoTaskSlots(
  taskSlots: readonly TaskUiSlot[],
  pinnedTaskIds: readonly string[] = []
): TaskUiSlot[] {
  return orderTaskSlotsPinnedFirst(
    sortTaskSlotsNewestFirst(taskSlots),
    pinnedTaskIds
  );
}
