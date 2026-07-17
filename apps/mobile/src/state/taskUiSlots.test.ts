import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../lib/api/types";
import {
  acknowledgeTaskUiSlot,
  buildCreatingTaskUiSlot,
  projectTaskUiSlots,
  removeTaskUiSlot,
  taskUiSlotForSelection,
  taskUiSlotToTaskSummary
} from "./taskUiSlots";

const createdTask: TaskSummary = {
  id: "cloud:desktop-1:repo-1:1111111111111111",
  repoId: "repo-1",
  title: "Ship optimistic creation",
  prompt: "Ship optimistic creation",
  stage: "in progress",
  agentProvider: "codex",
  agentType: "pty"
};

function creatingSlot() {
  return buildCreatingTaskUiSlot({
    slotId: "create:slot-1",
    repoId: "repo-1",
    prompt: "Ship optimistic creation",
    desktopId: "desktop-1",
    agentProvider: "codex"
  });
}

describe("task UI slots", () => {
  it("keeps presentation identity separate when acknowledging a durable task", () => {
    const creating = creatingSlot();

    expect(creating).toMatchObject({
      slotId: "create:slot-1",
      taskId: null,
      state: "creating",
      task: null
    });

    const [ready] = acknowledgeTaskUiSlot(
      [creating],
      creating.slotId,
      createdTask
    );

    expect(ready).toMatchObject({
      slotId: "create:slot-1",
      taskId: createdTask.id,
      state: "ready",
      task: createdTask
    });
  });

  it("resolves a local slot by presentation or acknowledged task identity", () => {
    const [ready] = acknowledgeTaskUiSlot(
      [creatingSlot()],
      "create:slot-1",
      createdTask
    );

    expect(taskUiSlotForSelection([ready], "create:slot-1")).toBe(ready);
    expect(taskUiSlotForSelection([ready], createdTask.id)).toBe(ready);
    expect(taskUiSlotForSelection([ready], "missing")).toBeNull();
  });

  it("projects a creating draft into a normal task-shaped presentation", () => {
    expect(taskUiSlotToTaskSummary(creatingSlot())).toEqual({
      id: "create:slot-1",
      repoId: "repo-1",
      title: "Ship optimistic creation",
      prompt: "Ship optimistic creation",
      stage: "in progress",
      agentProvider: "codex",
      agentType: "pty",
      ownerDesktopId: "desktop-1",
      activity: "working"
    });
  });

  it("uses slot IDs for list identity while retaining authoritative task data", () => {
    const [ready] = acknowledgeTaskUiSlot(
      [creatingSlot()],
      "create:slot-1",
      createdTask
    );
    const projected = projectTaskUiSlots([createdTask], [ready]);

    expect(projected).toEqual([ready]);
    expect(projected[0]?.slotId).toBe("create:slot-1");
    expect(taskUiSlotToTaskSummary(projected[0]!)).toBe(createdTask);
  });

  it("keeps an unacknowledged creating slot visible across empty snapshots", () => {
    const creating = creatingSlot();

    expect(projectTaskUiSlots([], [creating])).toEqual([creating]);
  });

  it("wraps ordinary authoritative tasks in task-keyed ready slots", () => {
    expect(projectTaskUiSlots([createdTask], [])).toEqual([
      {
        slotId: createdTask.id,
        taskId: createdTask.id,
        state: "ready",
        task: createdTask,
        draft: {
          repoId: createdTask.repoId,
          prompt: createdTask.prompt,
          desktopId: null,
          agentProvider: "codex",
          agentType: "pty",
          stage: "in progress"
        }
      }
    ]);
  });

  it("removes only the targeted local slot", () => {
    const first = creatingSlot();
    const second = buildCreatingTaskUiSlot({
      slotId: "create:slot-2",
      repoId: "repo-2",
      prompt: "Keep this slot",
      desktopId: "desktop-2",
      agentProvider: "claude"
    });

    expect(removeTaskUiSlot([first, second], first.slotId)).toEqual([second]);
  });
});
