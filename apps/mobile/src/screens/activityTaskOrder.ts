import type { TaskActivity, TaskSummary } from "../lib/api/types";

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
