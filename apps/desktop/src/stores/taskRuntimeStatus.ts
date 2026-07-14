export type TaskActivity = "working" | "unread" | "idle";
export type RuntimeStatus = "busy" | "idle" | "waiting";

export function shouldIgnoreRuntimeStatusDuringSetup(
  status: string,
  isPendingSetup: boolean,
): boolean {
  return isPendingSetup && status === "idle";
}

export function resolveActivityForRuntimeStatus(
  currentActivity: TaskActivity,
  status: RuntimeStatus,
  isSelected: boolean,
): TaskActivity | null {
  if (status === "busy") {
    return currentActivity === "working" ? null : "working";
  }

  if (currentActivity === "working") {
    return isSelected ? "idle" : "unread";
  }

  return null;
}
