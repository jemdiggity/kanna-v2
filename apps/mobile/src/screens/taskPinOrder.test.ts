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
  it("hoists pinned slots in this phone's pin order", () => {
    const ordered = orderTaskSlotsPinnedFirst(
      slots([
        task({ id: "loose-a" }),
        task({ id: "pin-b" }),
        task({ id: "loose-b" }),
        task({ id: "pin-a" })
      ]),
      ["pin-a", "pin-b"]
    );

    expect(ids(ordered)).toEqual(["pin-a", "pin-b", "loose-a", "loose-b"]);
  });

  it("ignores the desktop's own pin state on the payload", () => {
    const ordered = orderTaskSlotsPinnedFirst(
      slots([
        task({ id: "desktop-pin", pinned: true, pinOrder: 0 }),
        task({ id: "phone-pin" })
      ]),
      ["phone-pin"]
    );

    expect(ids(ordered)).toEqual(["phone-pin", "desktop-pin"]);
  });

  it("preserves the caller's order within each group and leaves input alone", () => {
    const input = slots([
      task({ id: "loose-a" }),
      task({ id: "pin-a" }),
      task({ id: "loose-b" }),
      task({ id: "pin-b" })
    ]);

    expect(ids(orderTaskSlotsPinnedFirst(input, ["pin-a", "pin-b"]))).toEqual([
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
    const ordered = orderTaskSlotsPinnedFirst(
      [creating, ...slots([task({ id: "pin-a" })])],
      ["pin-a"]
    );

    expect(ids(ordered)).toEqual(["pin-a", "draft-1"]);
  });
});

describe("isPinnedTask", () => {
  it("reads the phone's own pin list rather than the task payload", () => {
    expect(isPinnedTask("task-1", [])).toBe(false);
    expect(isPinnedTask("task-2", ["task-2"])).toBe(true);
  });
});
