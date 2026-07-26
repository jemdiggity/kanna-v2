# Remote Blocked Task UX Review Round 2 Design

## Goal

Close the remaining concurrency and recovery gaps in the replacement for PR
#921 without changing the established local-task, remote-terminal, blocker UI,
or workspace-projection behavior.

## Terminal Lag Recovery

Each attached terminal subscriber and passive observer keeps its bounded
mailbox and dedicated socket writer. When enqueueing crosses the byte budget,
the subscriber remains registered but enters a lagged state and drops later
live output. The writer signals the session fanout as soon as the retained
mailbox reaches zero. A session-scoped recovery worker consumes that signal,
takes the fanout lock, captures a fresh authoritative headless-terminal
snapshot, queues the snapshot and current status into the empty mailbox, and
returns the subscriber to live streaming.

The notification is edge-triggered but recovery rechecks state under the
fanout lock, so duplicate or stale notifications are harmless. This removes
the race where a quiet PTY depended on a later output chunk or coarse status
tick to notice that a lagged mailbox had drained.

## Remote Advance Compare-and-Swap

The latest owner `stage_run.id` is the task's transition revision. It changes
when an accepted advance starts a post or a new stage run, and it is stable
for ordinary activity, terminal, read-dwell, blocker, and file-link updates.
Owner snapshots publish this optional revision through the existing cloud and
LAN task snapshot models.

The viewer includes `expectedTransitionRevision` in relay and LAN advance
requests. The owner compares it with the latest stage-run ID before preparing
the transition and returns `409 Conflict` for a missing, stale, or replayed
revision. Existing owner-side task single-flight remains as a second guard
while a transition is being prepared or dispatched.

The viewer records the accepted request as pending by owner/task and expected
revision. HTTP/LAN completion does not clear it. A later authoritative
workspace snapshot clears the pending state only when the task disappears or
its transition revision changes. Therefore a retry against the same stale
snapshot is suppressed locally and rejected by the owner if it reaches the
owner through another viewer or replay path.

## Atomic Blocker Replacement

The database owns one blocker replacement operation that begins an immediate
SQLite transaction before resolving task identities. Inside that transaction
it resolves and deduplicates blockers, rejects self-dependencies, checks every
candidate against the currently committed dependency graph, replaces the
entire edge set, and updates task activity. The existing blocker revision
triggers run inside the same transaction, so their revision changes become
visible only with the final edge set.

`BEGIN IMMEDIATE` serializes competing graph writers. A concurrent inverse
edge replacement waits, then performs cycle detection against the winner's
committed graph and is rejected. Snapshot reads use their existing read
transaction and therefore see either the complete old graph/revision or the
complete new graph/revision, never the delete/insert intermediate state.

Task creation keeps its current prepared-task rollback behavior. The
transactional replacement API is used for mutations of existing task blocker
sets, including block, unblock, integration-task substitution, and restore.

## Error Handling

- Daemon snapshot failures leave subscribers lagged and re-signal recovery;
  no unbounded queue or forced reconnect is introduced.
- Remote advance CAS mismatches return `409` with an owner message, which the
  existing relay/LAN error surfaces show to the viewer.
- Blocker validation errors retain their current HTTP `400`/`404` semantics;
  SQLite errors remain `500`.
- Transactions roll back automatically on every validation, cycle, hook, or
  persistence failure.

## Verification

- Run each daemon overflow test repeatedly and the full reconnect suite.
- Add viewer tests for retry-before-snapshot and release-after-new-revision,
  relay/LAN protocol propagation tests, and owner stale/replay rejection.
- Add concurrent blocker replacement/cycle tests and a fault-injected snapshot
  test that pauses after delete inside the uncommitted transaction.
- Run focused frontend/workspace tests, focused Rust suites, desktop
  typecheck/build, `pnpm test`, and the repository's practical JavaScript
  verification.
