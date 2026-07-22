import type { TaskSummary } from "./types";

/**
 * The owner-local durable task id that `parentTaskId` and `blockedByTaskIds`
 * reference. Cloud-merged tasks display under a cloud-canonical id while
 * `ownerLocalTaskId` keeps the desktop-local id; direct LAN tasks use the
 * local id as their display id.
 */
export function taskLocalId(task: TaskSummary): string {
  return task.ownerLocalTaskId ?? task.id;
}

/** Local task ids are only unique per desktop; undefined owners match any. */
export function sameTaskDesktop(left: TaskSummary, right: TaskSummary): boolean {
  return (
    left.ownerDesktopId === undefined ||
    right.ownerDesktopId === undefined ||
    left.ownerDesktopId === right.ownerDesktopId
  );
}

/**
 * A blocker reference paired with its visible task summary when one is in
 * the current collections. Blockers can be cross-repo (a task may wait on
 * work in another repository), so resolution only matches owner-local id
 * within the same desktop — never repo.
 */
export interface BlockerTaskRef {
  blockerTaskId: string;
  task: TaskSummary | null;
}

export function isTaskBlocked(task: TaskSummary): boolean {
  return (task.blockedByTaskIds?.length ?? 0) > 0;
}

export function resolveBlockerTasks(
  task: TaskSummary,
  tasks: readonly TaskSummary[]
): BlockerTaskRef[] {
  return (task.blockedByTaskIds ?? []).map((blockerTaskId) => ({
    blockerTaskId,
    task:
      tasks.find(
        (candidate) =>
          taskLocalId(candidate) === blockerTaskId &&
          sameTaskDesktop(candidate, task)
      ) ?? null
  }));
}

export function buildCloudTaskId({
  ownerDesktopId,
  localRepoId,
  ownerLocalTaskId
}: {
  ownerDesktopId: string;
  localRepoId: string;
  ownerLocalTaskId: string;
}): string {
  return `cloud:${ownerDesktopId}:${localRepoId}:${ownerLocalTaskId}`;
}

// Cloud-sourced tasks carry a synthetic canonical id ("cloud:<desktop>:<repo>:<task>").
// User-facing surfaces must show the desktop-local task id, matching the desktop app.
export function displayTaskId(task: {
  id: string;
  ownerLocalTaskId?: string;
}): string {
  return task.ownerLocalTaskId?.trim() || task.id;
}

export function canonicalizeTaskActionId({
  canonicalTaskId,
  ownerDesktopId,
  localRepoId,
  sourceLocalTaskId,
  responseLocalTaskId
}: {
  canonicalTaskId: string;
  ownerDesktopId: string;
  localRepoId: string;
  sourceLocalTaskId: string;
  responseLocalTaskId: string;
}): string {
  if (responseLocalTaskId === sourceLocalTaskId) {
    return canonicalTaskId;
  }

  return buildCloudTaskId({
    ownerDesktopId,
    localRepoId,
    ownerLocalTaskId: responseLocalTaskId
  });
}
