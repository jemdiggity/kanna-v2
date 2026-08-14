# Stable Task Sidebar Slots Design

## Summary

Task entries in the desktop sidebar will have a stable UI identity that is independent of a task's durable backend ID. Creating a task adds one sidebar slot. The server response later fills that slot's task ID, and snapshot hydration fills its durable task data without removing or replacing the slot.

This removes the transient duplicate row, count increase, and selection jump that currently occur when an optimistic placeholder and its durable task briefly coexist under different IDs.

## Context

The current creation path inserts an optimistic `PipelineItem` into the snapshot overlay with a temporary `id`. The server creates the durable task under a different ID. While the overlay remains active, a snapshot refresh contains both records. `Sidebar.vue` groups every record and keys each row by `item.id`, so it correctly renders two rows even though they represent one logical creation.

The underlying modeling problem is that `PipelineItem.id` currently serves two unrelated purposes:

- durable task identity used by the server, database, daemon, and task actions
- UI identity used by Vue keys, sidebar selection, and the setup placeholder

The sidebar needs a stable UI slot whose durable task identity may initially be unavailable.

## Goals

- Render exactly one sidebar row for a task throughout creation and hydration.
- Keep the slot's UI identity and selection stable when its durable task ID arrives.
- Keep durable `PipelineItem` state separate from UI-only creation state.
- Persist and send only durable task IDs outside the UI layer.
- Preserve current sidebar grouping, ordering, search, pinning, activity styling, and task actions once the slot is ready.

## Non-goals

- Changing how the server allocates task IDs.
- Adding a task-ID reservation endpoint or client-generated durable IDs.
- Changing database schemas or task API contracts.
- Reworking optimistic updates for stage transitions, closing, pinning, or other operations.
- Adding sidebar animations.

## UI Slot Model

Introduce a UI-layer task slot with two identities:

```ts
interface TaskUiSlot {
  slotId: string;
  taskId: string | null;
  state: "creating" | "ready";
  task: PipelineItem | null;
  draft: {
    repoId: string;
    prompt: string;
    displayName: string | null;
    workflow: string;
    stage: string;
    agentType: AgentExecutionType;
    agentProvider: AgentProvider;
    createdAt: string;
  };
}
```

`slotId` is generated once when the UI slot is created and never changes during that app session. `taskId` starts as `null` and is filled from the successful create response. `task` starts as `null` and is filled when a snapshot contains `taskId`. Ready slots render from `task`; creating slots render from `draft`.

Tasks loaded without an in-flight creation receive slots with `slotId === task.id`, `taskId === task.id`, and `state === "ready"`. On application restart all slots may be rebuilt this way because the previous DOM and in-memory UI identity no longer exist.

## State and Projection

Durable snapshot items remain in the existing `items` collection. Task creation will no longer inject a synthetic `PipelineItem` into the durable snapshot overlay.

A focused slot registry owns UI identity. Snapshot reconciliation updates existing slots by `taskId` and creates ready slots for durable tasks that do not already have one. If an acknowledged creating slot claims a durable task ID, reconciliation updates that same slot instead of projecting a second row. Ready slots for tasks no longer present in the visible workspace are removed through the normal close/reconciliation path. An acknowledged creating slot survives the first authoritative snapshot that omits it, so a response/snapshot race cannot destroy it; a second authoritative miss removes the stale slot.

The sidebar receives task slots and uses `slotId` for Vue keys and in-memory selection. It derives title, stage, repository, and ordering fields from the durable task when ready and from the draft while creating. Counts include each slot exactly once.

Task actions continue to consume durable IDs. UI actions that require a durable `PipelineItem` remain unavailable while a slot is creating.

## Selection and Main Panel

In-memory task selection tracks `slotId`. A computed durable selection resolves the selected slot's `taskId`:

- window persistence stores `taskId`, never a UI-only `slotId`
- operator events and backend actions use `taskId`
- before acknowledgement, persistence uses `null` for the task selection
- once acknowledgement fills `taskId`, selection remains on the same slot while durable persistence can record the new ID

The main panel receives the selected slot. It shows the existing setup placeholder while `slot.task` is `null`, then switches to the durable task view when reconciliation fills `task`. The selected slot itself does not change during this transition.

## Creation Flow

1. Generate a `slotId`, add one creating slot from the submitted task fields, and select it when `selectOnCreate` permits.
2. Run the existing create request without supplying a task ID.
3. On success, assign the returned durable ID to `slot.taskId` and persist that durable selection when the slot is selected. Do not remove or replace the slot.
4. Refresh the snapshot. When the durable item appears, reconcile it into the same slot, set `slot.task`, and mark the slot ready.
5. Publish task snapshots through the existing paths after the durable item is available.

At no point should both a creating slot and a separate ready slot represent the same durable task.

## Error Handling

- If creation fails before a durable task is acknowledged, remove the creating slot and select the normal replacement.
- If creation succeeds but snapshot hydration fails, retain the acknowledged slot with its `taskId` and setup presentation. A later successful refresh hydrates the same slot. The UI must not invite a second create attempt for the already acknowledged task.
- A successful snapshot that temporarily omits the acknowledged task consumes one miss grace but does not remove its slot.
- If the next authoritative reconciliation also omits the task, remove the stale acknowledged slot through the normal task-removal path.
- Failures while persisting selection must not remove or duplicate the slot.

## Testing

Add focused regression coverage at four boundaries:

1. Slot reconciliation tests prove that acknowledgement and snapshot hydration preserve `slotId`, update the existing slot, and never create a second slot for the durable task.
2. Store integration tests delay snapshot hydration and selection persistence to expose the former race. They assert one visible slot, a stable selected `slotId`, a nullable-then-durable `taskId`, and recovery after snapshot failure.
3. Sidebar component tests transition a mounted slot from creating to ready and assert that the row count and repository count stay constant and that the same keyed DOM row remains mounted while durable task data appears.
4. Browser lifecycle coverage independently holds the create response and the subsequent snapshot, then verifies the same selected DOM row survives optimistic creation, durable-ID acknowledgement, and hydration without a count change.

Existing task creation, selection, sidebar ordering, and component suites run as regression coverage alongside the focused browser handoff scenario.
