# Remote Blocked Task UX Review Round 12 Design

## Goal

Close the remaining identity, LAN authorization, transfer-protocol,
event-loop, daemon-incarnation, persistence, and deployed-mobile
compatibility gaps without changing the intended remote blocked-task UX.

## Blocker identity

Remote blocker lookup is scoped by repository, owner desktop identity, and
owner-local task identity. The raw localized fallback is used when no blocker
snapshot exists in the blocked task's repository. A task from another
repository can never resolve that fallback, even when its owner and task IDs
collide and it has a PR that would otherwise make the blocker appear resolved.

The workspace projection remains the single input used by Sidebar,
MainPanel, and the stage-advance guard. The regression therefore exercises
all three consumers from one colliding snapshot fixture.

## LAN control authorization and stream compatibility

Every `/v1/transfers` route is privileged, including reads. Direct loopback,
a paired LAN device, and an authenticated relay tunnel remain the accepted
authorities. CORS does not grant authority; non-loopback requests with hostile
origins and no paired-device headers receive `401` before handlers can
enumerate or mutate transfer rows.

`/v2/stream` remains the authenticated paired-device endpoint. Retained
`/v1/stream` is the explicit previous-mobile/current-server compatibility
lane and continues to accept the credential-less auth frame emitted by the
deployed previous mobile client. A serialized previous-client fixture proves
that its terminal/agent stream can still open. New clients negotiate v2 from
the status capability and send their paired-device credential there.

## Transfer message authentication

Prepare and finalize requests use the existing encrypted authenticated-request
envelope. Each envelope binds:

- the action and outer request ID;
- the transfer ID when one exists;
- the current receiver owner epoch and issue timestamp;
- the requester identity;
- the reserved target identity; and
- prepare's source task identity.

The receiver authenticates and reserves the replay key before allocating a
reservation or enqueueing finalization work. Prepare and finalize replay keys
are crash-durable for their freshness window. Forged arguments, stale epochs
or timestamps, and repeated captured messages fail before side effects.

## Artifact event-loop and persistence boundaries

The Tauri materialization command is async and moves the complete secure
source open, file copy, and gzip/tar extraction operation into
`tauri::async_runtime::spawn_blocking`. Runtime join failures are mapped to a
stable command error.

Codex rollout copies publish through a private same-directory temporary file.
The implementation removes stale matching temporary files, copies to a
create-new temp, flushes and fsyncs it, renames it to the final name with
no-replace semantics, and fsyncs the parent directory. A failed or interrupted
attempt can leave only a temp; retry removes it and publishes the complete
rollout. The renderer treats a fully existing destination as usable resume
state and propagates materialization errors so it never creates an imported
task after silently discarding its resume session.

## Daemon subscription incarnation ordering

Observe, ObserveSnapshot, and AttachSnapshot participate in the same
per-session lifecycle lock as Spawn, Kill, and natural exit. Registration
resolves the session only after acquiring that lock, then revalidates the exact
`Arc<SessionHandle>` and exact fanout immediately before registering.

This produces two valid orderings:

- registration wins: initial Snapshot/Status is queued before the old
  incarnation's final Exit;
- Kill wins: the stale registration receives SessionNotFound, or a later
  registration resolves only the newly spawned same-ID incarnation.

No stale Snapshot or Status can follow the final Exit of an old incarnation.
Deterministic test pauses exercise attach/observe versus Kill and same-ID
respawn rather than relying on scheduler timing.

## Verification

Focused workspace/App, Kanna server HTTP/KSP, task-transfer protocol/runtime,
desktop artifact/store, and daemon reconnect tests run first. The desktop
build/typecheck, canonical practical JavaScript verification, canonical Rust
verification, and final diff review complete the revision.
