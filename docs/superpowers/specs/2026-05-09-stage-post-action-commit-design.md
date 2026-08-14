# Stage Post-Action Commit Design

## Summary

The commit step should stop being a normal workflow stage. It should become a generic post-action attached to the `in progress` stage. While the commit post-action is running, the task remains in `stage = "in progress"` so it stays grouped with implementation work. The sidebar shows the task with a leading `... ` to indicate that a post-action is active.

When the commit post-action completes successfully, Kanna clears the post-action marker and advances the task to the next real workflow stage, usually `pr`.

## Goals

- Remove `commit` from the visible stage flow.
- Keep the task in the `in progress` stage until commit work is complete.
- Preserve the existing in-place commit behavior: same task, worktree, branch, terminal session, and agent session.
- Make post-actions generic enough for future stage-local actions without designing a nested workflow system now.
- Give users a small, visible sidebar cue that the task is in post-action work.

## Non-Goals

- Do not support multiple post-actions per stage in this change.
- Do not create new tasks, worktrees, or sessions for post-actions.
- Do not hide state in tags.
- Do not make the PR agent responsible for committing dirty work again.

## Workflow Model

Workflow stages gain an optional `post_action` object:

```json
{
  "name": "in progress",
  "description": "Agent implements the task",
  "agent": "implement",
  "prompt": "$TASK_PROMPT",
  "transition": "manual",
  "post_action": {
    "name": "commit",
    "description": "Implementation agent commits the relevant work",
    "agent": "commit",
    "prompt": "Commit the relevant work for this task. Original task: $TASK_PROMPT",
    "transition": "auto"
  }
}
```

The first implementation supports one post-action per stage. A post-action has its own name, agent, prompt, optional description, optional provider hints, and transition setting. It is not a workflow stage and should not appear in stage ordering, stage labels, or task grouping.

The default workflow becomes:

```text
in progress --post-action: commit--> pr
```

The QA workflow becomes:

```text
in progress --post-action: commit--> review -> pr
```

## Task State

Add a dedicated nullable `pipeline_item.active_post_action` field. The field stores the post-action name while that action is running and is `NULL` otherwise.

`pipeline_item.stage` remains the source of truth for task grouping and workflow position. During commit post-action work:

- `stage = "in progress"`
- `active_post_action = "commit"`
- `stage_result = NULL` until the commit agent reports completion

`stage_result` continues to represent the latest completion result for the current execution unit. The completion handler interprets the result as a post-action result when `active_post_action` is set.

## Advancement Flow

Manual stage advancement from a stage with a post-action should enter the post-action first:

1. Resolve the current stage from the task's workflow.
2. If the stage has a `post_action` and the task has no active post-action, build the post-action prompt.
3. Set `active_post_action` to the post-action name.
4. Clear stale `stage_result`.
5. Send the post-action prompt to the existing live agent session.
6. Reload state.
7. Do not change `pipeline_item.stage`.

When `kanna-cli stage-complete --status success` reports completion while `active_post_action` is set:

1. Atomically claim the reported `stage_result`.
2. Clear `active_post_action`.
3. Clear `stage_result`.
4. Advance from the unchanged current stage to the next real stage.

For the default workflow, that final advance closes the implementation task and creates the PR task exactly as the normal `in progress -> pr` stage transition does today.

If a post-action reports failure, Kanna should leave `active_post_action` set and mark the task unread if it is not selected. The user can inspect the terminal, intervene manually, rerun the post-action, or advance again after resolving the problem.

## Sidebar Display

Sidebar grouping continues to use only `pipeline_item.stage`, so a task in the commit post-action remains under the `in progress` section.

When a task has an active post-action, the displayed title gets a leading ASCII ellipsis:

```text
... Fix sidebar task ordering
```

The existing unread bold and working italic styling still applies. Pinned tasks use the same title formatting.

## Rerun Behavior

Rerunning a task with `active_post_action` set should rerun the post-action prompt, not the parent stage prompt. This lets users retry a failed or interrupted commit action without moving the task out of `in progress`.

Rerunning a task without `active_post_action` keeps the existing stage rerun behavior.

## Compatibility

Existing workflows that still contain a `commit` stage should continue to parse and run through the existing stage mechanism. The built-in workflows should move to `post_action` so new tasks use the cleaner flow by default.

Existing tasks currently in `stage = "commit"` can remain valid. This change does not need to migrate historical tasks because the prior stage name is still a valid custom workflow stage.

## Testing

Unit tests should cover:

- workflow parsing accepts `post_action`,
- invalid post-action shapes fail validation,
- stage order defaults no longer include built-in `commit`,
- advancing from `in progress` with a post-action sets `active_post_action` and leaves `stage` unchanged,
- post-action entry sends the commit prompt to the existing session,
- successful post-action completion clears the marker and advances to the next real stage,
- failed post-action completion leaves the marker in place,
- rerun uses the post-action prompt when a marker is active,
- sidebar renders active post-action tasks with a leading `... ` while grouping under `in progress`.

E2E coverage should update the existing continue-mode stage tests to prove a live task can enter commit post-action through the daemon input command and remain in the `in progress` section until completion.

## Persistence

Add `active_post_action TEXT NULL` to `pipeline_item` in the SQLite migrations and TypeScript schema. New inserts should default it to `NULL`. Snapshot loading and transfer payloads should preserve the field so task state stays consistent across reloads and task transfer.
