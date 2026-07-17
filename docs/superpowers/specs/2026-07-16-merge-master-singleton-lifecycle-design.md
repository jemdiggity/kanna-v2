# Merge Master Singleton Lifecycle

## Problem

The merge master is intended to be one long-lived task per repository. After
each merge turn, the agent records a stage result. This changes the current
`stage_run` status from `running` to `succeeded` or `failed`, while leaving the
task and its PTY session open.

The signal endpoint currently looks only for an open task with a `running`
stage run. A completed turn therefore makes the existing merge master
invisible, and the next signal creates another task.

## Lifecycle Boundary

An open singleton-agent task remains the singleton for its repository and
agent, regardless of the result of its latest turn. A successful or failed
stage result completes only that turn. Explicitly closing the task is the sole
event that permits the next signal to create a replacement.

## Design

Change the singleton-agent lookup to select the latest agent-bound stage run
for an open task without requiring that run to have `running` status. Return
the persisted session id from that run, falling back to the task id under the
existing daemon-session convention.

The signal endpoint will continue to use the lookup before task creation. If
an open singleton exists, it sends the new message to that task's session and
returns `created: false`. If no open task exists, it follows the existing
creation, pinning, and detached-spawn path and returns `created: true`.

This remains generic for repo-scoped singleton agents rather than introducing
merge-specific pipeline-name logic or a second source of agent identity.

## Error Handling

Input-delivery failures keep the existing behavior: the endpoint reports the
daemon error and does not silently create a second task. This avoids violating
singleton identity when an open task exists but its session needs operator
attention.

## Verification

Add focused route-level regression coverage proving that:

- a signal after a successful turn reuses the same task and session;
- a signal after a failed turn reuses the same task and session;
- a closed singleton is ignored, so a later signal may create a replacement;
- the existing running-task reuse and absent-task creation behavior remains
  intact.

Run the focused `kanna-server` tests, followed by the repository's Rust test
command if practical.
