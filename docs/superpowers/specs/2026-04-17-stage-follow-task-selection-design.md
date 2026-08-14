# Stage Follow Task Selection Design

## Summary

Workflow stages should control whether Kanna follows the spawned next-stage task after a manual stage advance. This behavior belongs on the destination stage, not on a global app preference or a source-to-destination transition table.

The stage config adds an optional `follow_task` boolean:

- `true`: select the spawned next-stage task after it is created
- `false`: do not follow the spawned next-stage task; instead keep focus on the next visible item in the sidebar ordering
- omitted: default to `true` to preserve current behavior and avoid breaking existing workflow definitions

This supports "fire and forget" stages like `pr` while keeping the existing follow behavior for implementation-style stages.

## Goals

- Make next-task selection behavior configurable per workflow stage.
- Preserve current behavior for existing workflows that do not set the new field.
- Keep the behavior attached to the destination stage so workflow JSON stays simple and readable.
- Let PR-style stages opt out of automatic focus stealing.

## Non-Goals

- No global preference for stage-follow behavior.
- No per-transition selection policy matrix.
- No change to sidebar ordering rules.
- No change to how stage advancement creates a new task and closes the source task.

## Configuration Shape

Extend `WorkflowStage` with:

```ts
interface WorkflowStage {
  name: string;
  description?: string;
  agent?: string;
  prompt?: string;
  agent_provider?: string;
  environment?: string;
  transition: "manual" | "auto";
  follow_task?: boolean;
}
```

Example:

```json
{
  "name": "pr",
  "description": "Agent creates a GitHub PR",
  "agent": "pr",
  "prompt": "Create a PR for the work on branch $BRANCH. Previous result: $PREV_RESULT",
  "transition": "manual",
  "follow_task": false
}
```

## Runtime Behavior

### Default Case

If `follow_task` is omitted or `true`, stage advancement keeps the current behavior:

1. Determine the next stage.
2. Close the source task with `selectNext: false` so close-task selection logic does not interfere.
3. Create the destination-stage task.
4. Allow the spawned task setup flow to auto-select the new task when session startup completes.

This is the current model and should remain the default.

### Opt-Out Case

If `follow_task` is `false`, stage advancement should not leave focus on the spawned destination task.

Required behavior:

1. Compute the next visible sidebar item relative to the source task before closing it.
2. Close the source task without auto-selecting the spawned task.
3. Create the destination-stage task without auto-selecting it during setup.
4. Restore or preserve selection on the previously computed sidebar neighbor if that item still exists and is still visible.
5. If there is no valid next visible item, leave selection unset and allow existing current-item fallback behavior to resolve naturally.

The important distinction is that `follow_task: false` suppresses only the selection handoff. It does not change task creation, worktree creation, session startup, or workflow semantics.

## Architectural Changes

### Workflow Schema

Update the workflow type and parser in `packages/core/src/workflow/` to recognize `follow_task?: boolean`.

Validation rules:

- Accept omitted `follow_task`.
- Accept boolean `follow_task`.
- Ignore non-boolean values during parsing, matching the current loader pattern for optional stage fields.

The intended result is a backward-compatible schema extension with no migration.

### Stage Advance API

`advanceStage()` in the store layer should read the destination stage config and pass selection policy through the stage-handoff flow.

The current implementation only controls close-task selection with `selectNext: false`; it does not control the later auto-selection inside `createItem()`/setup. That is why PR stage advancement still follows the new task today.

To support stage-configurable behavior cleanly, task creation needs an explicit selection policy instead of always auto-selecting on successful spawn.

Recommended shape:

- Add an optional task creation flag such as `selectOnCreate?: boolean` or `followTask?: boolean`.
- Default it to `true`.
- In the async setup path, only call `selectItem(id)` when that flag is enabled.

This keeps task creation reusable and avoids PR-specific branching in lower layers.

### Selection Source of Truth

When `follow_task` is `false`, `advanceStage()` should capture the intended sidebar successor before the source task is closed. The captured item id becomes the stable selection target for the handoff.

Selection should not be recomputed after creating the new task because inserting the spawned stage task would perturb the sidebar order and defeat the purpose of opting out.

## Data Flow

For `follow_task: false`, the intended flow is:

1. Read current task and workflow.
2. Resolve destination stage.
3. Compute pre-close next visible item id from current sidebar order.
4. Close source task with `selectNext: false`.
5. Create destination task with `selectOnCreate: false`.
6. Reload snapshot as needed.
7. Re-select the previously captured item id if it is still present and visible.

For `follow_task: true` or omitted, the flow remains:

1. Close source task with `selectNext: false`.
2. Create destination task with `selectOnCreate: true`.
3. The new task auto-selects during setup.

## Error Handling

- If the source task cannot be closed, do not create the destination task.
- If destination task creation fails after the source task closes, keep the existing error reporting behavior; selection should remain on the preserved sidebar item if one was chosen.
- If the preserved selection target disappears before restore, do not throw. Fall back to normal selection behavior.
- If the destination stage omits `follow_task`, treat it as `true`.

## Tests

Add or update tests in the store and workflow layers to cover:

- Workflow parser accepts `follow_task: false`.
- Workflow parser preserves omitted `follow_task`.
- `advanceStage()` follows the spawned task by default.
- `advanceStage()` follows the spawned task when `follow_task: true`.
- `advanceStage()` keeps selection on the precomputed next visible item when `follow_task: false`.
- `advanceStage()` does not recompute the selection target after inserting the new stage task.
- `follow_task: false` behaves correctly when there is no next visible item.

The most important regression test is the PR case:

- advancing from `in progress` to `pr` with `follow_task: false` should create the PR task without pulling focus away from the user’s next sidebar item

## Rollout

- Add `follow_task: false` to the built-in `pr` stage in the default workflow resource.
- Leave all other built-in stages on the default follow behavior unless there is an explicit product reason to opt them out.

## Open Decisions Resolved

- The selection policy belongs to the destination stage.
- The default for omitted config is follow the spawned task.
- PR stages should opt out with `follow_task: false`.
