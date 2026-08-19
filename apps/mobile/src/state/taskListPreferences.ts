import type { TaskSummary } from "../lib/api/types";

/**
 * Phone-local task list preferences: the rows this phone pins to the top of a
 * list, and the Activity rows it has dismissed.
 *
 * Both are deliberately device-local. The desktop keeps its own pin state and
 * its own read state; a mobile pin is never published to it, and a mobile
 * dismiss never marks the task read for the desktop or for supervisors. The
 * phone's own copy is therefore the only source of truth for what these lists
 * show, which is what makes the swipe instant: there is no round-trip to wait
 * for and no server answer to reconcile against.
 */

export interface LocalTaskPin {
  taskId: string;
  /**
   * The repo the pin was made in. Retention is scoped to snapshots that cover
   * this repo, so pins belonging to a machine (or repo) the phone is not
   * currently reading are never mistaken for tasks that went away.
   */
  repoId: string;
}

export interface LocalActivityDismissal {
  taskId: string;
  repoId: string;
  /**
   * The activity generation that was dismissed. Newer activity than this must
   * bring the row back, which is why the entry is a pair rather than a bare
   * id. `null` records a desktop that predates `activityRevision`: such a
   * dismissal cannot recognise newer activity by number, so it lapses as soon
   * as the task starts reporting one.
   */
  activityRevision: number | null;
}

export interface LocalTaskListPreferences {
  /** Pinned tasks, topmost first: the array order is the pin order. */
  pins: LocalTaskPin[];
  dismissedActivity: LocalActivityDismissal[];
  /** Whether the one-time seed from desktop pin state has already run. */
  pinsSeededFromServer: boolean;
}

/** The task fields these preferences are keyed by. */
export type LocalTaskListTask = Pick<
  TaskSummary,
  "id" | "repoId" | "activity" | "activityRevision"
>;

export function emptyLocalTaskListPreferences(): LocalTaskListPreferences {
  return { pins: [], dismissedActivity: [], pinsSeededFromServer: false };
}

/**
 * Reads a stored payload back into preferences, or returns `null` when it is
 * not recognisable. `null` means "do not understand this" — the caller
 * preserves the bytes rather than replacing them, because a payload this
 * function cannot read is not the same as a phone with no pins.
 */
export function normalizeLocalTaskListPreferences(
  value: unknown
): LocalTaskListPreferences | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as {
    pins?: unknown;
    dismissedActivity?: unknown;
    pinsSeededFromServer?: unknown;
  };
  if (!Array.isArray(candidate.pins)) return null;
  if (!Array.isArray(candidate.dismissedActivity)) return null;
  if (typeof candidate.pinsSeededFromServer !== "boolean") return null;

  const pins: LocalTaskPin[] = [];
  for (const entry of candidate.pins) {
    const pin = normalizePin(entry);
    if (!pin) return null;
    if (pins.some((existing) => existing.taskId === pin.taskId)) continue;
    pins.push(pin);
  }

  const dismissedActivity: LocalActivityDismissal[] = [];
  for (const entry of candidate.dismissedActivity) {
    const dismissal = normalizeDismissal(entry);
    if (!dismissal) return null;
    if (
      dismissedActivity.some(
        (existing) => existing.taskId === dismissal.taskId
      )
    ) {
      continue;
    }
    dismissedActivity.push(dismissal);
  }

  return {
    pins,
    dismissedActivity,
    pinsSeededFromServer: candidate.pinsSeededFromServer
  };
}

export function localPinnedTaskIds(
  preferences: LocalTaskListPreferences
): string[] {
  return preferences.pins.map((pin) => pin.taskId);
}

export function isLocallyPinned(
  preferences: LocalTaskListPreferences,
  taskId: string
): boolean {
  return preferences.pins.some((pin) => pin.taskId === taskId);
}

/**
 * Toggles a pin. A new pin goes to the front, so the row the owner just
 * swiped is the topmost one; unchanged input is returned by identity so
 * callers can skip a redundant write.
 */
export function setLocalTaskPinned(
  preferences: LocalTaskListPreferences,
  task: Pick<TaskSummary, "id" | "repoId">,
  pinned: boolean
): LocalTaskListPreferences {
  const alreadyPinned = isLocallyPinned(preferences, task.id);
  if (alreadyPinned === pinned) return preferences;
  const pins = preferences.pins.filter((pin) => pin.taskId !== task.id);
  return {
    ...preferences,
    pins: pinned
      ? [{ taskId: task.id, repoId: task.repoId }, ...pins]
      : pins
  };
}

/**
 * Records a dismissal of the task's *current* activity generation. Dismissing
 * again after newer activity replaces the entry, so the row hides for the new
 * generation too.
 */
export function dismissLocalActivity(
  preferences: LocalTaskListPreferences,
  task: LocalTaskListTask
): LocalTaskListPreferences {
  const activityRevision = task.activityRevision ?? null;
  const existing = preferences.dismissedActivity.find(
    (entry) => entry.taskId === task.id
  );
  if (
    existing &&
    existing.repoId === task.repoId &&
    existing.activityRevision === activityRevision
  ) {
    return preferences;
  }
  return {
    ...preferences,
    dismissedActivity: [
      ...preferences.dismissedActivity.filter(
        (entry) => entry.taskId !== task.id
      ),
      { taskId: task.id, repoId: task.repoId, activityRevision }
    ]
  };
}

export function isLocallyDismissed(
  preferences: LocalTaskListPreferences,
  task: LocalTaskListTask
): boolean {
  const entry = preferences.dismissedActivity.find(
    (candidate) => candidate.taskId === task.id
  );
  return entry ? dismissalCoversTask(entry, task) : false;
}

/**
 * Drops entries a snapshot proves are dead: a pinned task that is gone, and a
 * dismissal whose task is gone, is no longer unread, or has been superseded by
 * newer activity.
 *
 * `snapshot` must be an authoritative all-open-tasks read. Retention is still
 * scoped per repo: an entry is only ever dropped when the snapshot carries at
 * least one task from the same repo, so a phone that switched machines — or
 * that read one desktop while the pinned task lives on another — keeps every
 * entry it cannot see. The cost of that is a pin whose repo has no other open
 * task lingering until the repo shows one again; the alternative silently
 * loses pins on every machine switch.
 */
export function pruneLocalTaskListPreferences(
  preferences: LocalTaskListPreferences,
  snapshot: readonly LocalTaskListTask[]
): LocalTaskListPreferences {
  const tasksById = new Map(snapshot.map((task) => [task.id, task]));
  const coveredRepoIds = new Set(snapshot.map((task) => task.repoId));

  const pins = preferences.pins.filter(
    (pin) => !coveredRepoIds.has(pin.repoId) || tasksById.has(pin.taskId)
  );
  const dismissedActivity = preferences.dismissedActivity.filter((entry) => {
    if (!coveredRepoIds.has(entry.repoId)) return true;
    const task = tasksById.get(entry.taskId);
    if (!task) return false;
    if ((task.activity ?? null) !== "unread") return false;
    return dismissalCoversTask(entry, task);
  });

  if (
    pins.length === preferences.pins.length &&
    dismissedActivity.length === preferences.dismissedActivity.length
  ) {
    return preferences;
  }
  return { ...preferences, pins, dismissedActivity };
}

/**
 * One-time migration off the server round-trip: the first authoritative
 * snapshot with tasks in it folds whatever the desktop had pinned into the
 * phone's own list, so pins made before this phone stopped calling the pin API
 * survive the switch. It runs once — an unpin made afterwards is not undone by
 * the next snapshot that still reports the desktop pin.
 */
export function seedLocalTaskPinsFromServer(
  preferences: LocalTaskListPreferences,
  snapshot: readonly TaskSummary[]
): LocalTaskListPreferences {
  if (preferences.pinsSeededFromServer || snapshot.length === 0) {
    return preferences;
  }
  const serverPins = snapshot
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.pinned === true)
    .sort(
      (left, right) =>
        pinOrderRank(left.task) - pinOrderRank(right.task) ||
        left.index - right.index
    )
    .map(({ task }) => ({ taskId: task.id, repoId: task.repoId }))
    .filter((pin) => !isLocallyPinned(preferences, pin.taskId));

  return {
    ...preferences,
    pins: [...preferences.pins, ...serverPins],
    pinsSeededFromServer: true
  };
}

function pinOrderRank(task: TaskSummary): number {
  return task.pinOrder ?? Number.MAX_SAFE_INTEGER;
}

function dismissalCoversTask(
  entry: LocalActivityDismissal,
  task: LocalTaskListTask
): boolean {
  const current = task.activityRevision ?? null;
  if (entry.activityRevision === null) {
    // Nothing to compare against: a task that starts reporting a generation
    // is newer activity than anything this entry can describe.
    return current === null;
  }
  // A task that stopped reporting a generation carries no evidence of newer
  // activity, so the dismissal stands.
  return current === null || current <= entry.activityRevision;
}

function normalizePin(value: unknown): LocalTaskPin | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { taskId?: unknown; repoId?: unknown };
  if (typeof candidate.taskId !== "string" || !candidate.taskId) return null;
  if (typeof candidate.repoId !== "string" || !candidate.repoId) return null;
  return { taskId: candidate.taskId, repoId: candidate.repoId };
}

function normalizeDismissal(value: unknown): LocalActivityDismissal | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as {
    taskId?: unknown;
    repoId?: unknown;
    activityRevision?: unknown;
  };
  if (typeof candidate.taskId !== "string" || !candidate.taskId) return null;
  if (typeof candidate.repoId !== "string" || !candidate.repoId) return null;
  const activityRevision = candidate.activityRevision;
  if (activityRevision !== null && typeof activityRevision !== "number") {
    return null;
  }
  if (typeof activityRevision === "number" && !Number.isFinite(activityRevision)) {
    return null;
  }
  return {
    taskId: candidate.taskId,
    repoId: candidate.repoId,
    activityRevision: activityRevision ?? null
  };
}
