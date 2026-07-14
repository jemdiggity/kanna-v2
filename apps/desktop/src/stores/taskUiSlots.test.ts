import { describe, expect, it } from "vitest";
import type { PipelineItem } from "../types/kanna";
import {
  acknowledgeTaskUiSlot,
  buildCreatingTaskUiSlot,
  reconcileTaskUiSlots,
  removeTaskUiSlot,
  taskUiSlotForSelection,
  taskUiSlotToSidebarItem,
} from "./taskUiSlots";

function task(id: string): PipelineItem {
  return {
    id,
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Ship stable slots",
    pipeline: "default",
    pipeline_def: null,
    stage: "in progress",
    pr_number: null,
    pr_url: null,
    branch: `task-${id}`,
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "working",
    activity_changed_at: "2026-07-11T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    display_name: null,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: "origin/main",
    agent_session_id: null,
    teardown_started_at: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
  };
}

function creatingSlot() {
  return buildCreatingTaskUiSlot({
    slotId: "create:slot-1",
    repoId: "repo-1",
    prompt: "Ship stable slots",
    displayName: null,
    pipelineName: "default",
    stage: "in progress",
    agentType: "pty",
    requestedAgentProviders: "claude",
    nowIso: "2026-07-11T00:00:00.000Z",
  });
}

describe("task UI slots", () => {
  it("acknowledges and hydrates one slot without changing its UI identity", () => {
    const acknowledged = acknowledgeTaskUiSlot([creatingSlot()], "create:slot-1", "durable-1");
    const hydrated = reconcileTaskUiSlots(acknowledged, [task("durable-1")]);

    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({
      slot_id: "create:slot-1",
      task_id: "durable-1",
      state: "ready",
      task: { id: "durable-1" },
    });
  });

  it("defers a snapshot task until an unacknowledged creating slot can claim it", () => {
    const durableTask = task("durable-1");
    const snapshotFirst = reconcileTaskUiSlots([creatingSlot()], [durableTask]);

    expect(snapshotFirst).toEqual([
      expect.objectContaining({
        slot_id: "create:slot-1",
        task_id: null,
        state: "creating",
        task: null,
      }),
    ]);

    const acknowledged = acknowledgeTaskUiSlot(snapshotFirst, "create:slot-1", "durable-1");
    const hydrated = reconcileTaskUiSlots(acknowledged, [durableTask]);

    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({
      slot_id: "create:slot-1",
      task_id: "durable-1",
      state: "ready",
      task: { id: "durable-1" },
    });
  });

  it("materializes snapshot tasks in other repos while one repo has an unacknowledged creation", () => {
    const repoBTask = {
      ...task("durable-b"),
      repo_id: "repo-2",
      prompt: "Ship repo B",
    };

    const slots = reconcileTaskUiSlots([creatingSlot()], [repoBTask]);

    expect(slots.map((slot) => ({
      slot_id: slot.slot_id,
      task_id: slot.task_id,
      repo_id: slot.draft.repo_id,
      state: slot.state,
    }))).toEqual([
      {
        slot_id: "create:slot-1",
        task_id: null,
        repo_id: "repo-1",
        state: "creating",
      },
      {
        slot_id: "durable-b",
        task_id: "durable-b",
        repo_id: "repo-2",
        state: "ready",
      },
    ]);
  });

  it("defers unclaimed snapshot tasks until every concurrent creation is acknowledged", () => {
    const secondSlot = buildCreatingTaskUiSlot({
      slotId: "create:slot-2",
      repoId: "repo-1",
      prompt: "Ship another stable slot",
      agentType: "pty",
      requestedAgentProviders: "claude",
      nowIso: "2026-07-11T00:00:01.000Z",
    });
    const durableTasks = [task("durable-1"), task("durable-2")];

    const snapshotFirst = reconcileTaskUiSlots([creatingSlot(), secondSlot], durableTasks);
    const firstAcknowledged = acknowledgeTaskUiSlot(
      snapshotFirst,
      "create:slot-1",
      "durable-1",
    );
    const firstHydrated = reconcileTaskUiSlots(firstAcknowledged, durableTasks);

    expect(firstHydrated.map((slot) => ({
      slot_id: slot.slot_id,
      task_id: slot.task_id,
      state: slot.state,
    }))).toEqual([
      { slot_id: "create:slot-1", task_id: "durable-1", state: "ready" },
      { slot_id: "create:slot-2", task_id: null, state: "creating" },
    ]);

    const allAcknowledged = acknowledgeTaskUiSlot(
      firstHydrated,
      "create:slot-2",
      "durable-2",
    );
    const allHydrated = reconcileTaskUiSlots(allAcknowledged, durableTasks);

    expect(allHydrated.map((slot) => ({ slot_id: slot.slot_id, task_id: slot.task_id }))).toEqual([
      { slot_id: "create:slot-1", task_id: "durable-1" },
      { slot_id: "create:slot-2", task_id: "durable-2" },
    ]);
  });

  it("removes an acknowledged slot only after two authoritative snapshots omit its task", () => {
    const acknowledged = acknowledgeTaskUiSlot([creatingSlot()], "create:slot-1", "durable-1");

    expect(acknowledged).toEqual([
      expect.objectContaining({
        slot_id: "create:slot-1",
        task_id: "durable-1",
        authoritative_miss_grace_remaining: 1,
      }),
    ]);

    const afterNonAuthoritativeMiss = reconcileTaskUiSlots(
      acknowledged,
      [],
      { authoritative: false },
    );
    expect(afterNonAuthoritativeMiss).toEqual(acknowledged);

    const afterFirstAuthoritativeMiss = reconcileTaskUiSlots(
      afterNonAuthoritativeMiss,
      [],
      { authoritative: true },
    );
    expect(afterFirstAuthoritativeMiss).toEqual([
      expect.objectContaining({
        slot_id: "create:slot-1",
        task_id: "durable-1",
        authoritative_miss_grace_remaining: 0,
      }),
    ]);

    const afterAnotherNonAuthoritativeMiss = reconcileTaskUiSlots(
      afterFirstAuthoritativeMiss,
      [],
      { authoritative: false },
    );
    expect(afterAnotherNonAuthoritativeMiss).toEqual(afterFirstAuthoritativeMiss);

    expect(reconcileTaskUiSlots(
      afterAnotherNonAuthoritativeMiss,
      [],
      { authoritative: true },
    )).toEqual([]);
  });

  it("drops a ready slot when its durable task is missing", () => {
    const ready = reconcileTaskUiSlots([], [task("durable-1")]);

    expect(reconcileTaskUiSlots(ready, [])).toEqual([]);
  });

  it("creates ready slots for durable tasks that did not originate in this UI", () => {
    const acknowledged = acknowledgeTaskUiSlot([creatingSlot()], "create:slot-1", "durable-1");
    const slots = reconcileTaskUiSlots(acknowledged, [task("durable-1"), task("durable-2")]);

    expect(slots.map((slot) => ({ slot_id: slot.slot_id, task_id: slot.task_id }))).toEqual([
      { slot_id: "create:slot-1", task_id: "durable-1" },
      { slot_id: "durable-2", task_id: "durable-2" },
    ]);
  });

  it("normalizes legacy sdk execution types when creating a ready slot draft", () => {
    const durableTask = task("durable-1");
    durableTask.agent_type = "sdk";

    const [slot] = reconcileTaskUiSlots([], [durableTask]);

    expect(slot.draft.agent_type).toBe("agent");
  });

  it("canonicalizes duplicate durable task IDs from one snapshot", () => {
    const durableTask = task("durable-1");

    const slots = reconcileTaskUiSlots([], [durableTask, { ...durableTask }]);

    expect(slots.map((slot) => slot.task_id)).toEqual(["durable-1"]);
  });

  it("resolves selection by stable slot ID or durable task ID", () => {
    const acknowledged = acknowledgeTaskUiSlot([creatingSlot()], "create:slot-1", "durable-1");

    expect(taskUiSlotForSelection(acknowledged, "create:slot-1")?.slot_id).toBe("create:slot-1");
    expect(taskUiSlotForSelection(acknowledged, "durable-1")?.slot_id).toBe("create:slot-1");
  });

  it("projects a creating slot without pretending it has a durable task ID", () => {
    expect(taskUiSlotToSidebarItem(creatingSlot())).toMatchObject({
      slot_id: "create:slot-1",
      task_id: null,
      state: "creating",
      prompt: "Ship stable slots",
      branch: null,
      activity: "working",
    });
  });

  it("projects an acknowledged creating slot with its durable ID and draft presentation", () => {
    const [acknowledged] = acknowledgeTaskUiSlot(
      [creatingSlot()],
      "create:slot-1",
      "durable-1",
    );

    expect(acknowledged).toMatchObject({
      task_id: "durable-1",
      state: "creating",
      task: null,
    });
    expect(taskUiSlotToSidebarItem(acknowledged)).toMatchObject({
      slot_id: "create:slot-1",
      task_id: "durable-1",
      state: "creating",
      prompt: "Ship stable slots",
      branch: null,
    });
  });

  it("projects a ready slot from its durable task fields", () => {
    const durableTask = task("durable-1");
    durableTask.display_name = "Durable title";
    const [slot] = reconcileTaskUiSlots([], [durableTask]);

    expect(taskUiSlotToSidebarItem(slot)).toMatchObject({
      slot_id: "durable-1",
      task_id: "durable-1",
      state: "ready",
      display_name: "Durable title",
      branch: "task-durable-1",
    });
  });

  it("removes only the requested slot", () => {
    const other = reconcileTaskUiSlots([], [task("durable-1")])[0];

    expect(removeTaskUiSlot([creatingSlot(), other], "create:slot-1")).toEqual([other]);
  });
});
