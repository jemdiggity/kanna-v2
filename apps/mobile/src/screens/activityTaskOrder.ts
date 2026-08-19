import type { TaskActivity, TaskSummary } from "../lib/api/types";
import {
  emptyLocalTaskListPreferences,
  isLocallyDismissed,
  type LocalTaskListPreferences
} from "../state/taskListPreferences";

function activityPriority(activity: TaskActivity | null | undefined): number {
  if (activity === "unread") return 0;
  if (activity === "working") return 2;
  return 1;
}

export function orderActivityTasks(
  tasks: readonly TaskSummary[]
): TaskSummary[] {
  return tasks
    .map((task, sourceIndex) => ({ task, sourceIndex }))
    .sort(
      (left, right) =>
        activityPriority(left.task.activity) -
          activityPriority(right.task.activity) ||
        left.sourceIndex - right.sourceIndex
    )
    .map(({ task }) => task);
}

/**
 * The Activity rows this phone still shows: unread tasks it has not dismissed
 * itself. A dismissal is local and generation-scoped, so a task that produces
 * newer activity than the dismissed generation comes back.
 */
export function visibleActivityTasks(
  tasks: readonly TaskSummary[],
  preferences: LocalTaskListPreferences = emptyLocalTaskListPreferences()
): TaskSummary[] {
  return orderActivityTasks(
    tasks.filter(
      (task) =>
        task.activity === "unread" && !isLocallyDismissed(preferences, task)
    )
  );
}

export function unreadActivityCount(
  tasks: readonly TaskSummary[],
  preferences: LocalTaskListPreferences = emptyLocalTaskListPreferences()
): number {
  return visibleActivityTasks(tasks, preferences).length;
}
