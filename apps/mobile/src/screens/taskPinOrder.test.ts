import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../lib/api/types";
import {
  buildCreatingTaskUiSlot,
  projectTaskUiSlots,
  type TaskUiSlot
} from "../state/taskUiSlots";
import { isPinnedTask, orderTaskSlotsPinnedFirst } from "./taskPinOrder";

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

function ids(ordered: readonly TaskUiSlot[]): string[] {
  return ordered.map((slot) => slot.slotId);
}

describe("orderTaskSlotsPinnedFirst", () => {
  it("hoists pinned slots in owner pin order", () => {
    const ordered = orderTaskSlotsPinnedFirst(slots([
      task({ id: "loose-a" }),
      task({ id: "pin-b", pinned: true, pinOrder: 1 }),
      task({ id: "loose-b" }),
      task({ id: "pin-a", pinned: true, pinOrder: 0 })
    ]));

    expect(ids(ordered)).toEqual(["pin-a", "pin-b", "loose-a", "loose-b"]);
  });

  it("keeps a pinned slot without an order behind the ordered pins", () => {
    const ordered = orderTaskSlotsPinnedFirst(slots([
      task({ id: "pin-unordered", pinned: true }),
      task({ id: "pin-first", pinned: true, pinOrder: 0 }),
      task({ id: "loose" })
    ]));

    expect(ids(ordered)).toEqual(["pin-first", "pin-unordered", "loose"]);
  });

  it("preserves the caller's order within each group and leaves input alone", () => {
    const input = slots([
      task({ id: "loose-a" }),
      task({ id: "pin-a", pinned: true, pinOrder: 0 }),
      task({ id: "loose-b" }),
      task({ id: "pin-b", pinned: true, pinOrder: 0 })
    ]);

    expect(ids(orderTaskSlotsPinnedFirst(input))).toEqual([
      "pin-a",
      "pin-b",
      "loose-a",
      "loose-b"
    ]);
    expect(ids(input)).toEqual(["loose-a", "pin-a", "loose-b", "pin-b"]);
  });

  it("treats a still-creating slot as unpinned", () => {
    const creating = buildCreatingTaskUiSlot({
      slotId: "draft-1",
      repoId: "repo-1",
      prompt: "New task",
      desktopId: "desktop-1",
      agentProvider: "claude"
    });
    const ordered = orderTaskSlotsPinnedFirst([
      creating,
      ...slots([task({ id: "pin-a", pinned: true, pinOrder: 0 })])
    ]);

    expect(ids(ordered)).toEqual(["pin-a", "draft-1"]);
  });
});

describe("isPinnedTask", () => {
  it("defaults an absent pin flag to unpinned", () => {
    expect(isPinnedTask(task({ id: "task-1" }))).toBe(false);
    expect(isPinnedTask(task({ id: "task-2", pinned: true }))).toBe(true);
  });
});
