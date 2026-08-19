import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../lib/api/types";
import {
  buildCreatingTaskUiSlot,
  projectTaskUiSlots,
  type TaskUiSlot
} from "../state/taskUiSlots";
import { buildTaskTreeRows } from "./taskTreeRows";

function task(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    repoId: "repo-1",
    title: `Task ${overrides.id}`,
    stage: "in progress",
    ...overrides
  };
}

function slots(tasks: TaskSummary[]): TaskUiSlot[] {
  return projectTaskUiSlots(tasks, []);
}

function rowIds(rows: ReturnType<typeof buildTaskTreeRows>): Array<[string, number]> {
  return rows.map((row) => [row.slot.slotId, row.depth]);
}

describe("buildTaskTreeRows", () => {
  it("nests subtasks directly under their parent, oldest first", () => {
    const rows = buildTaskTreeRows(slots([
      task({ id: "parent" }),
      task({
        id: "child-new",
        parentTaskId: "parent",
        createdAt: "2026-07-20 10:00:00"
      }),
      task({ id: "other" }),
      task({
        id: "child-old",
        parentTaskId: "parent",
        createdAt: "2026-07-19 10:00:00"
      })
    ]));

    expect(rowIds(rows)).toEqual([
      ["parent", 0],
      ["child-old", 1],
      ["child-new", 1],
      ["other", 0]
    ]);
  });

  it("nests grandchildren one level deeper", () => {
    const rows = buildTaskTreeRows(slots([
      task({ id: "parent" }),
      task({ id: "child", parentTaskId: "parent" }),
      task({ id: "grandchild", parentTaskId: "child" })
    ]));

    expect(rowIds(rows)).toEqual([
      ["parent", 0],
      ["child", 1],
      ["grandchild", 2]
    ]);
  });

  it("keeps a pinned subtask top-level so pinning can lift it", () => {
    const rows = buildTaskTreeRows(slots([
      task({ id: "pinned-child", parentTaskId: "parent", pinned: true }),
      task({ id: "parent" }),
      task({ id: "child", parentTaskId: "parent" })
    ]));

    expect(rowIds(rows)).toEqual([
      ["pinned-child", 0],
      ["parent", 0],
      ["child", 1]
    ]);
  });

  it("keeps a task top-level when its parent is absent from the list", () => {
    const rows = buildTaskTreeRows(slots([
      task({ id: "orphan", parentTaskId: "closed-parent" }),
      task({ id: "other" })
    ]));

    expect(rowIds(rows)).toEqual([
      ["orphan", 0],
      ["other", 0]
    ]);
  });

  it("keeps every task visible when the parent graph contains a cycle", () => {
    const rows = buildTaskTreeRows(slots([
      task({ id: "a", parentTaskId: "b" }),
      task({ id: "b", parentTaskId: "a" })
    ]));

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.slot.slotId).sort()).toEqual(["a", "b"]);
  });

  it("ignores a self-referential parent id", () => {
    const rows = buildTaskTreeRows(slots([
      task({ id: "self", parentTaskId: "self" })
    ]));

    expect(rowIds(rows)).toEqual([["self", 0]]);
  });

  it("does not nest across repos", () => {
    const rows = buildTaskTreeRows(slots([
      task({ id: "parent", repoId: "repo-1" }),
      task({ id: "child", repoId: "repo-2", parentTaskId: "parent" })
    ]));

    expect(rowIds(rows)).toEqual([
      ["parent", 0],
      ["child", 0]
    ]);
  });

  it("does not nest across desktops", () => {
    const rows = buildTaskTreeRows(slots([
      task({ id: "parent", ownerDesktopId: "desktop-1" }),
      task({
        id: "child",
        ownerDesktopId: "desktop-2",
        parentTaskId: "parent"
      })
    ]));

    expect(rowIds(rows)).toEqual([
      ["parent", 0],
      ["child", 0]
    ]);
  });

  it("matches parents by owner-local id for cloud-merged tasks", () => {
    const rows = buildTaskTreeRows(slots([
      task({
        id: "cloud-parent-id",
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "local-parent"
      }),
      task({
        id: "cloud-child-id",
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "local-child",
        parentTaskId: "local-parent"
      })
    ]));

    expect(rowIds(rows)).toEqual([
      ["cloud-parent-id", 0],
      ["cloud-child-id", 1]
    ]);
  });

  it("nests each child under its own desktop's parent when owner-local parent ids collide", () => {
    // Owner-local ids are unique only per desktop: two desktops can both
    // hold a parent with local id "task-p". Each child must nest under the
    // parent from its own desktop even when the foreign parent appears
    // first in the collection.
    const rows = buildTaskTreeRows(slots([
      task({
        id: "cloud-d1-parent",
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "task-p"
      }),
      task({
        id: "cloud-d2-parent",
        ownerDesktopId: "desktop-2",
        ownerLocalTaskId: "task-p"
      }),
      task({
        id: "cloud-d2-child",
        ownerDesktopId: "desktop-2",
        ownerLocalTaskId: "task-c2",
        parentTaskId: "task-p"
      }),
      task({
        id: "cloud-d1-child",
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "task-c1",
        parentTaskId: "task-p"
      })
    ]));

    expect(rowIds(rows)).toEqual([
      ["cloud-d1-parent", 0],
      ["cloud-d1-child", 1],
      ["cloud-d2-parent", 0],
      ["cloud-d2-child", 1]
    ]);
  });

  it("keeps creating slots top-level", () => {
    const creating = buildCreatingTaskUiSlot({
      slotId: "slot-creating",
      repoId: "repo-1",
      prompt: "New work",
      desktopId: "desktop-1",
      agentProvider: "claude"
    });
    const rows = buildTaskTreeRows([
      ...slots([task({ id: "parent" })]),
      creating
    ]);

    expect(rowIds(rows)).toEqual([
      ["parent", 0],
      ["slot-creating", 0]
    ]);
  });
});
