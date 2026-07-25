# Remote Task Read Dwell Design

## Problem

The desktop marks a selected local task read after it remains selected for one
second. Remote task selections are tracked outside the local task UI slots, so
the local selection watcher never observes them and their unread state
persists.

## Desired Behavior

A remote task that remains selected for one second is marked read on its owner
desktop. Switching away before one second cancels the action. The owner remains
the source of truth, and normal cloud or LAN synchronization updates every
projection of the task afterward.

## Design

Add a remote selection dwell watcher alongside the existing local watcher. The
watcher observes the selected remote workspace task, waits one second, verifies
that the task is still unread and that its activity predates the selection, and
then routes a mark-read action to the owner's local task ID.

Extend the shared remote terminal/action client with `markTaskRead`:

- Relay transport posts to the owner's existing
  `/v1/tasks/{task_id}/actions/mark-read` route.
- LAN transport invokes a new Tauri command that follows the existing
  close-task and advance-stage task-transfer path.
- The task-transfer protocol forwards the action to the owner, whose listener
  calls the same local server mark-read route.

The observing desktop does not mutate its remote snapshot optimistically.
Successful owner-side persistence propagates through the existing cloud or LAN
snapshot synchronization.

## Error Handling

If the remote owner or transport is unavailable, leave the task unread and log
the failure. A later selection can retry through the normal dwell behavior.
Client connections are closed after each action attempt.

## Testing

Add regression coverage that proves:

- a selected unread remote task invokes mark-read after one second;
- navigating away before one second cancels the action;
- recent activity is not overwritten by a stale dwell callback;
- relay routes mark-read to the encoded owner task API path;
- LAN routes mark-read through the new Tauri command;
- task-transfer forwards the action and the owner persists the read state.

Run the focused desktop TypeScript and task-transfer Rust tests, followed by the
repository's practical broader checks for the touched packages.
