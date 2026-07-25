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
owner database assigns every task a durable monotonic `activity_revision` and
increments it atomically whenever activity changes. Owner cloud and LAN
snapshots publish that revision.

The watcher captures the selected task's owner desktop ID, owner-local task ID,
and exact unread activity revision. After one second, it verifies that the
selection, remote identity, unread state, and revision are all unchanged, then
routes a compare-and-swap mark-read action to that owner-local task ID. Binding
the revision to its owner identity prevents a stable sidebar presentation slot
from applying an observation after its preferred remote source changes.
Missing revisions from older remote snapshots fail safe and do not trigger
automatic mark-read.

Extend the shared remote terminal/action client with `markTaskRead`:

- Relay transport posts to the owner's existing
  `/v1/tasks/{task_id}/actions/mark-read` route with
  `expectedActivityRevision`.
- LAN transport invokes a new Tauri command that follows the existing
  close-task and advance-stage task-transfer path. The task ID and expected
  revision are sealed to the paired owner's key so the listener verifies
  possession of the requester's paired private key.
- The task-transfer protocol forwards the action to the owner, whose listener
  calls the same local server mark-read route.

The owner route performs one conditional update requiring `activity = 'unread'`
and an exact revision match, then changes activity to idle and increments the
revision in the same statement. This prevents stale or replayed requests from
clearing newer activity without relying on cross-machine clocks, timestamp
precision, or timezone parsing. An empty request body retains the legacy local
unconditional mark-read behavior.

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
- revision changes and newly unread activity are not overwritten by a stale
  dwell callback;
- a presentation slot rebound to another owner with the same numeric revision
  is not marked read;
- restored selections start the dwell immediately and missing revisions fail
  safe;
- every activity transition increments the durable revision;
- cloud and LAN snapshots preserve the revision;
- relay routes mark-read to the encoded owner task API path;
- LAN routes mark-read through the new Tauri command;
- task-transfer seals the action, rejects forged callers, and forwards the
  expected revision;
- owner compare-and-swap rejects stale and replayed requests, including two
  activity transitions within one timestamp second.

Run the focused desktop TypeScript and task-transfer Rust tests, followed by the
repository's practical broader checks for the touched packages.
