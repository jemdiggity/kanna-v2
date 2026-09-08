import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../lib/api/types";
import {
  dismissLocalActivity,
  emptyLocalTaskListPreferences,
  isLocallyDismissed,
  isLocallyPinned,
  localPinnedTaskIds,
  normalizeLocalTaskListPreferences,
  pruneLocalTaskListPreferences,
  seedLocalTaskPinsFromServer,
  setLocalTaskPinned,
  type LocalTaskListPreferences
} from "./taskListPreferences";

function task(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    repoId: "repo-1",
    title: `Task ${overrides.id}`,
    stage: "in progress",
    ...overrides
  };
}

function preferences(
  overrides: Partial<LocalTaskListPreferences> = {}
): LocalTaskListPreferences {
  return { ...emptyLocalTaskListPreferences(), ...overrides };
}

describe("setLocalTaskPinned", () => {
  it("puts a new pin at the top and keeps the rest in order", () => {
    const first = setLocalTaskPinned(
      emptyLocalTaskListPreferences(),
      task({ id: "task-1" }),
      true
    );
    const second = setLocalTaskPinned(first, task({ id: "task-2" }), true);

    expect(localPinnedTaskIds(second)).toEqual(["task-2", "task-1"]);
    expect(isLocallyPinned(second, task({ id: "task-1" }))).toBe(true);
  });

  it("removes a pin and returns the same record when nothing changes", () => {
    const pinned = setLocalTaskPinned(
      emptyLocalTaskListPreferences(),
      task({ id: "task-1" }),
      true
    );

    expect(localPinnedTaskIds(setLocalTaskPinned(pinned, task({ id: "task-1" }), false)))
      .toEqual([]);
    expect(setLocalTaskPinned(pinned, task({ id: "task-1" }), true)).toBe(pinned);
  });
});

describe("default pins for account-wide singletons", () => {
  const singleton = task({ id: "task-merge", singletonAgent: "merge" });

  it("shows a directory singleton pinned without the phone pinning it", () => {
    const empty = emptyLocalTaskListPreferences();

    expect(localPinnedTaskIds(empty, [task({ id: "task-1" }), singleton]))
      .toEqual(["task-merge"]);
    expect(isLocallyPinned(empty, singleton)).toBe(true);
    expect(isLocallyPinned(empty, task({ id: "task-1" }))).toBe(false);
  });

  it("keeps the default above the phone's own pins without reordering them", () => {
    const pinned = setLocalTaskPinned(
      setLocalTaskPinned(emptyLocalTaskListPreferences(), task({ id: "task-1" }), true),
      task({ id: "task-2" }),
      true
    );

    expect(
      localPinnedTaskIds(pinned, [task({ id: "task-1" }), task({ id: "task-2" }), singleton])
    ).toEqual(["task-merge", "task-2", "task-1"]);
  });

  it("keeps an explicit unpin off across later list builds", () => {
    const unpinned = setLocalTaskPinned(
      emptyLocalTaskListPreferences(),
      singleton,
      false
    );

    expect(unpinned.unpinnedDefaults).toEqual([
      { taskId: "task-merge", repoId: "repo-1" }
    ]);
    expect(localPinnedTaskIds(unpinned, [singleton])).toEqual([]);
    expect(isLocallyPinned(unpinned, singleton)).toBe(false);
    // A record round-tripped through storage still says the same thing.
    expect(
      localPinnedTaskIds(
        normalizeLocalTaskListPreferences(JSON.parse(JSON.stringify(unpinned)))!,
        [singleton]
      )
    ).toEqual([]);
  });

  it("restores the default when the phone pins it again", () => {
    const unpinned = setLocalTaskPinned(
      emptyLocalTaskListPreferences(),
      singleton,
      false
    );
    const repinned = setLocalTaskPinned(unpinned, singleton, true);

    expect(repinned.unpinnedDefaults).toEqual([]);
    // The default already puts it at the top; no explicit entry is needed.
    expect(repinned.pins).toEqual([]);
    expect(localPinnedTaskIds(repinned, [singleton])).toEqual(["task-merge"]);
  });

  it("leaves the owner's pin for a singleton to the default rather than seeding it", () => {
    const seeded = seedLocalTaskPinsFromServer(emptyLocalTaskListPreferences(), [
      task({ id: "task-merge", singletonAgent: "merge", pinned: true, pinOrder: 0 }),
      task({ id: "task-1", pinned: true, pinOrder: 1 })
    ]);

    expect(seeded.pins).toEqual([{ taskId: "task-1", repoId: "repo-1" }]);
    expect(localPinnedTaskIds(seeded, [singleton, task({ id: "task-1" })]))
      .toEqual(["task-merge", "task-1"]);
  });
});

describe("dismissLocalActivity", () => {
  it("records the generation it dismissed and hides the row", () => {
    const dismissed = dismissLocalActivity(
      emptyLocalTaskListPreferences(),
      task({ id: "task-1", activity: "unread", activityRevision: 7 })
    );

    expect(dismissed.dismissedActivity).toEqual([
      { taskId: "task-1", repoId: "repo-1", activityRevision: 7 }
    ]);
    expect(
      isLocallyDismissed(
        dismissed,
        task({ id: "task-1", activity: "unread", activityRevision: 7 })
      )
    ).toBe(true);
  });

  it("stops hiding a row once newer activity arrives", () => {
    const dismissed = dismissLocalActivity(
      emptyLocalTaskListPreferences(),
      task({ id: "task-1", activity: "unread", activityRevision: 7 })
    );

    expect(
      isLocallyDismissed(
        dismissed,
        task({ id: "task-1", activity: "unread", activityRevision: 8 })
      )
    ).toBe(false);
  });

  it("lapses a revisionless dismissal as soon as the task reports a generation", () => {
    const dismissed = dismissLocalActivity(
      emptyLocalTaskListPreferences(),
      task({ id: "task-1", activity: "unread" })
    );

    expect(dismissed.dismissedActivity[0]?.activityRevision).toBeNull();
    expect(
      isLocallyDismissed(dismissed, task({ id: "task-1", activity: "unread" }))
    ).toBe(true);
    expect(
      isLocallyDismissed(
        dismissed,
        task({ id: "task-1", activity: "unread", activityRevision: 2 })
      )
    ).toBe(false);
  });

  it("replaces the entry when the same row is dismissed at a newer generation", () => {
    const first = dismissLocalActivity(
      emptyLocalTaskListPreferences(),
      task({ id: "task-1", activity: "unread", activityRevision: 7 })
    );
    const second = dismissLocalActivity(
      first,
      task({ id: "task-1", activity: "unread", activityRevision: 9 })
    );

    expect(second.dismissedActivity).toEqual([
      { taskId: "task-1", repoId: "repo-1", activityRevision: 9 }
    ]);
  });
});

describe("pruneLocalTaskListPreferences", () => {
  const stale = preferences({
    pins: [
      { taskId: "task-open", repoId: "repo-1" },
      { taskId: "task-gone", repoId: "repo-1" },
      { taskId: "task-elsewhere", repoId: "repo-2" }
    ],
    dismissedActivity: [
      { taskId: "task-open", repoId: "repo-1", activityRevision: 7 },
      { taskId: "task-read", repoId: "repo-1", activityRevision: 3 },
      { taskId: "task-superseded", repoId: "repo-1", activityRevision: 4 },
      { taskId: "task-elsewhere", repoId: "repo-2", activityRevision: 1 }
    ],
    pinsSeededFromServer: true
  });

  it("drops entries the snapshot proves are dead", () => {
    const pruned = pruneLocalTaskListPreferences(stale, [
      task({ id: "task-open", activity: "unread", activityRevision: 7 }),
      task({ id: "task-read", activity: "idle", activityRevision: 3 }),
      task({ id: "task-superseded", activity: "unread", activityRevision: 5 })
    ]);

    expect(localPinnedTaskIds(pruned)).toEqual([
      "task-open",
      "task-elsewhere"
    ]);
    expect(pruned.dismissedActivity).toEqual([
      { taskId: "task-open", repoId: "repo-1", activityRevision: 7 },
      { taskId: "task-elsewhere", repoId: "repo-2", activityRevision: 1 }
    ]);
  });

  it("keeps everything when the snapshot covers no repo it knows", () => {
    expect(pruneLocalTaskListPreferences(stale, [])).toBe(stale);
    expect(
      pruneLocalTaskListPreferences(stale, [
        task({ id: "other", repoId: "repo-9" })
      ])
    ).toBe(stale);
  });
});

describe("seedLocalTaskPinsFromServer", () => {
  it("folds desktop pins in once, in the desktop's own order", () => {
    const seeded = seedLocalTaskPinsFromServer(emptyLocalTaskListPreferences(), [
      task({ id: "task-second", pinned: true, pinOrder: 1 }),
      task({ id: "task-first", pinned: true, pinOrder: 0 }),
      task({ id: "task-loose" })
    ]);

    expect(seeded).toMatchObject({
      pins: [
        { taskId: "task-first", repoId: "repo-1" },
        { taskId: "task-second", repoId: "repo-1" }
      ],
      pinsSeededFromServer: true
    });

    // Second pass is a no-op, so an unpin on the phone stays unpinned.
    const unpinned = setLocalTaskPinned(seeded, task({ id: "task-first" }), false);
    expect(
      seedLocalTaskPinsFromServer(unpinned, [
        task({ id: "task-first", pinned: true, pinOrder: 0 })
      ])
    ).toBe(unpinned);
  });

  it("waits for a snapshot with tasks in it", () => {
    const empty = emptyLocalTaskListPreferences();
    expect(seedLocalTaskPinsFromServer(empty, [])).toBe(empty);
  });
});

describe("normalizeLocalTaskListPreferences", () => {
  it("reads a stored record back", () => {
    expect(
      normalizeLocalTaskListPreferences({
        pins: [{ taskId: "task-1", repoId: "repo-1" }],
        dismissedActivity: [
          { taskId: "task-2", repoId: "repo-1", activityRevision: null }
        ],
        pinsSeededFromServer: true
      })
    ).toEqual({
      pins: [{ taskId: "task-1", repoId: "repo-1" }],
      // A record written before default pins existed reads back as a phone
      // that has suppressed nothing.
      unpinnedDefaults: [],
      dismissedActivity: [
        { taskId: "task-2", repoId: "repo-1", activityRevision: null }
      ],
      pinsSeededFromServer: true
    });
  });

  it("reads suppressed default pins back", () => {
    expect(
      normalizeLocalTaskListPreferences({
        pins: [],
        unpinnedDefaults: [{ taskId: "task-merge", repoId: "repo-1" }],
        dismissedActivity: [],
        pinsSeededFromServer: true
      })
    ).toMatchObject({
      unpinnedDefaults: [{ taskId: "task-merge", repoId: "repo-1" }]
    });
    expect(
      normalizeLocalTaskListPreferences({
        pins: [],
        unpinnedDefaults: ["task-merge"],
        dismissedActivity: [],
        pinsSeededFromServer: true
      })
    ).toBeNull();
  });

  it("refuses a payload it cannot read rather than guessing at an empty one", () => {
    expect(normalizeLocalTaskListPreferences(null)).toBeNull();
    expect(normalizeLocalTaskListPreferences({ pins: [] })).toBeNull();
    expect(
      normalizeLocalTaskListPreferences({
        pins: ["task-1"],
        dismissedActivity: [],
        pinsSeededFromServer: false
      })
    ).toBeNull();
    expect(
      normalizeLocalTaskListPreferences({
        pins: [],
        dismissedActivity: [{ taskId: "task-1", repoId: "repo-1", activityRevision: "7" }],
        pinsSeededFromServer: false
      })
    ).toBeNull();
  });
});
