# Mobile partial-task creation and abort

**Status:** Approved for implementation.

## Problem

Mobile currently stores task creation as one global pending attempt. While that
attempt is unresolved, New Task redirects to its optimistic task slot and the
composer refuses edits or another submission. The task action menu also resolves
the optimistic slot id instead of the reserved desktop task id, so Close Task
cannot abort the attempt.

An unresolved create has two materially different outcomes:

- **definitely not created:** the request was never dispatched, or the desktop
  explicitly returned a `TaskCreationError` with outcome `not-created`; and
- **uncertain:** the request was dispatched but mobile did not receive a
  definitive response, so the desktop task may or may not exist.

Definite failures already may be removed locally. Uncertain attempts must remain
recoverable until mobile either recovers them or safely aborts them.

## Product behavior

New Task always opens a fresh, editable composer. Existing partial creations do
not redirect New Task and do not prevent another task from being submitted.

Each unresolved creation appears independently in the task list. Selecting it
opens its existing creation workspace:

- pending creation shows Creating task;
- ambiguous creation shows Task creation interrupted and Recover task;
- recovery shows Recovering task.

Close Task on any unresolved creation aborts only that creation. Mobile sends
the attempt's reserved task id to its owning desktop. The abort succeeds when
the desktop closes the task or confirms that it does not exist. Mobile then
removes that optimistic slot. An unreachable desktop or another ambiguous
failure leaves the slot intact and retryable.

Abort never replays the create request and therefore never creates a task that
was absent.

## Mobile state model

Creation state moves from the session-wide `pendingTaskCreation` and
`taskCreationPhase` fields to the individual optimistic task slots.
A creating slot owns:

- its stable UI slot id;
- the reserved desktop task id;
- the frozen repo, prompt, desktop, provider, and terminal geometry;
- its current `pending`, `recovering`, or `uncertain` phase.

The composer owns only the draft for the next creation. Opening it does not
select or mutate a creating slot. Submitting creates a new slot and a new
creation flight, then closes the composer. Controller flights and persistence
barriers are keyed by reserved task id so several independent attempts can
settle without overwriting one another.

Completion, definite failure, recovery, and abort update only the matching
slot. Late results check that the same reserved attempt still exists before
acknowledging or removing anything. A successful abort removes the slot first,
so a late create response cannot resurrect it in mobile state.

## Persistence and compatibility

Persist all unresolved creation attempts as an array. Hydration restores every
entry as `uncertain`, because an app restart loses knowledge of whether an
in-flight request completed.

The parser continues accepting the existing singular `pendingTaskCreation`
field and converts it to a one-element array. New saves write only the array.
Malformed or duplicate entries are ignored deterministically by stable slot id
and reserved task id.

This is a TypeScript and Rust service change only. It does not change mobile
native code or configuration and does not require an OTA `runtimeVersion`
bump.

## Desktop abort contract

Add a task-creation abort operation keyed by the requested task id. Mobile
transports route it explicitly to the frozen owning desktop rather than using a
task-list-derived route, which may not exist when the create response was lost.

The desktop operation is idempotent:

- an open task with that id follows the normal close workflow;
- an already closed task succeeds;
- an absent task succeeds without creating any records;
- a real close failure is returned to mobile.

Requested-id creation and abort operations serialize on the desktop by task id.
If creation is already running, abort waits for that operation to settle before
checking and closing the resulting task. A create request cannot enter the
critical section while abort owns it. This prevents an abort from observing
absence immediately before the corresponding in-flight create publishes a
task.

The existing ordinary close endpoint keeps its current not-found behavior.
Only the explicit creation-abort operation treats absence as success, avoiding
silent success for mistyped normal task ids.

## Error handling

Mobile begins the normal close-task pending action for the selected optimistic
slot, which disables duplicate actions and shows the existing closing spinner.
On success it removes only that creation and clears any error associated with
it. On failure it finishes the pending action, preserves the attempt and phase,
and surfaces the transport or desktop error.

Recover and abort are single-flight per reserved task id. Actions on one
creation do not block the composer or unrelated creation attempts. A recover
or create response that arrives after a successful abort is ignored because
the matching slot no longer exists.

## Verification

Tests will cover:

- New Task opens a blank composer while one or more uncertain slots remain;
- a second task can be submitted and completed independently;
- selecting an uncertain slot still exposes recovery;
- abort routes the reserved id to the frozen owning desktop;
- abort removes the slot when the desktop closes the task or reports absence;
- abort failure preserves the slot and permits retry;
- abort and an in-flight requested-id create serialize without leaving an
  orphan task;
- late create and recovery responses cannot resurrect an aborted slot;
- multiple unresolved attempts persist and hydrate as uncertain;
- legacy singular persistence migrates to one unresolved slot; and
- ordinary task close behavior remains unchanged.

Focused mobile unit/integration tests and Kanna server HTTP tests run first,
followed by the relevant package typechecks and the repository's practical
broader test command.
