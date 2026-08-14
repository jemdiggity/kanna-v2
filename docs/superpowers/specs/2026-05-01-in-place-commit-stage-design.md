# In-Place Commit Stage Design

## Summary

Kanna should make committing the task agent's responsibility before PR creation. The default workflow will add a `commit` stage between `in progress` and `pr`, but this stage must not create a new task, worktree, branch, or agent session. It updates the current task in place and sends the existing agent a follow-up prompt so the agent that implemented the work can commit it with full context.

After the commit stage completes, the PR stage can remain a separate PR-focused task. The PR agent should no longer inspect and commit uncommitted work as part of its normal process.

## Goals

- Move commit ownership from the PR agent to the implementation agent context.
- Represent commit as a real workflow stage so users can see and customize it.
- Preserve the current task, branch, worktree, and agent session during the commit stage.
- Keep existing stage advancement behavior for stages that intentionally create a new task.
- Remove normal uncommitted-work handling from the PR agent instructions.

## Non-Goals

- Do not make every stage in-place.
- Do not introduce hidden post-stage behavior outside the workflow definition.
- Do not require the PR agent to recover from a missing commit beyond surfacing the problem clearly.
- Do not change the meaning of closed tasks or task cleanup.

## Workflow Model

Add an optional stage execution mode to workflow stages:

- `mode: "new_task"`: the existing behavior. Advancing closes the source task and creates a new task for the next stage.
- `mode: "continue"`: advancing updates the existing task to the next stage and sends the stage prompt to the current agent session.

If `mode` is omitted, stages default to `new_task` for backward compatibility.

The built-in default workflow becomes:

```json
{
  "name": "default",
  "description": "Standard in progress -> commit -> PR flow",
  "stages": [
    {
      "name": "in progress",
      "description": "Agent implements the task",
      "agent": "implement",
      "prompt": "$TASK_PROMPT",
      "transition": "manual"
    },
    {
      "name": "commit",
      "description": "Implementation agent commits the relevant work",
      "agent": "commit",
      "prompt": "Commit the relevant work for this task. Original task: $TASK_PROMPT",
      "transition": "auto",
      "mode": "continue"
    },
    {
      "name": "pr",
      "description": "Agent creates a GitHub PR",
      "agent": "pr",
      "prompt": "Create a PR for the work on branch $BRANCH. Previous result: $PREV_RESULT",
      "transition": "manual",
      "follow_task": false
    }
  ]
}
```

The built-in QA workflow should use the same commit ownership before review:

```text
in progress -> commit -> review -> pr
```

This makes QA and PR stages consume committed work instead of inheriting commit cleanup.

## In-Place Stage Advancement

When advancing from a source stage to a next stage whose `mode` is `continue`, Kanna should:

1. Resolve the next stage and build its prompt with the existing prompt builder.
2. Update the existing `pipeline_item.stage` to the next stage name.
3. Clear the previous `stage_result` so automatic completion logic observes only the new stage result.
4. Keep the same `pipeline_item.id`, branch, worktree, terminal session, and daemon session.
5. Send the built stage prompt as input to the existing agent session.
6. Reload state so the sidebar and header reflect the new stage.

This path should not call the existing `closeTask` plus `createItem` promotion flow.

If no live session exists for a `continue` stage, Kanna should fail clearly and leave the task in its current stage. A later enhancement may allow rerunning the current task's agent, but silent task creation would violate the stage contract.

## Commit Agent

Add a built-in `commit` agent. It should instruct the existing implementation agent to:

- inspect `git status` and the relevant diff,
- include only task-relevant changes,
- run appropriate focused checks when useful,
- create one or more clear commits,
- avoid committing unrelated local changes,
- call `kanna-cli stage-complete --status success --summary "<summary>"` after commits are ready,
- call `kanna-cli stage-complete --status failure --summary "<reason>"` if it cannot safely decide what to commit.

The commit agent can support the same providers as the implementation agent. Because the stage uses `mode: "continue"`, provider/model changes in the commit agent frontmatter should not imply a new session for this stage.

## PR Agent

Update the built-in PR agent so its normal process assumes the source branch is already committed. Remove the current first step that checks the source worktree for uncommitted changes and commits them.

The PR agent should still fail clearly if the branch cannot be rebased, pushed, or turned into a PR. It may report an unexpected dirty tree as a precondition failure, but it should not become the owner of committing implementation work.

## Data Flow

Manual or automatic stage advancement calls the store's workflow API. For `new_task` stages, the current close-and-create path remains unchanged. For `continue` stages, the workflow API updates the existing DB row, sends the prompt to the existing PTY session, and reloads the snapshot.

Automatic completion remains stage-result driven. The commit agent records completion with `kanna-cli stage-complete`; the store sees a successful result on an auto stage and advances to the PR stage. Because PR uses `new_task`, that second advancement closes the committed task and creates the PR task as it does today.

## Testing

Unit tests should cover:

- workflow parsing accepts `mode: "continue"` and defaults missing mode to `new_task` behavior,
- advancing to a `continue` stage updates the same task instead of inserting a new one,
- the existing session receives the commit stage prompt,
- `stage_result` is cleared when entering a continue stage,
- advancing from `commit` to `pr` still creates a new PR task,
- the PR agent instructions no longer include the uncommitted-work commit step.

E2E coverage should be added or updated if the existing mock harness can exercise workflow advancement. If not practical in the current harness, the implementation should document why and rely on focused store and workflow tests for this change.

## Decisions

Use the workflow property name `mode` with values `"new_task"` and `"continue"`. This is explicit enough for JSON authors and leaves room for future modes without overloading `transition`, which already describes manual versus automatic advancement.
