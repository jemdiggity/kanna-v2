# Authoritative PTY Busy State Design

## Problem

The task sidebar can show a PTY task as `unread` (bold) while the daemon
reports that the task's current session is `busy`. Selecting the task repairs
the row to `working` (italic) because terminal attach replays the daemon's
current status.

The live `task-eb76b59d` reproduction established that this is stale server
activity, not a Vue rendering bug:

- the daemon listed the session as `busy`;
- `/v1/snapshot` still exposed `activity: unread`;
- selecting the task caused the server activity timestamp to change and the
  snapshot to expose `activity: working`.

An earlier reproduction after daemon replacement exposed a second gap:
handed-off PTYs keep their transferred status but do not resume their output
reader until the first `AttachSnapshot`, so no subsequent status transition is
observed while the task remains unselected.

## Root causes

### Attached sessions suppress authoritative busy updates

`kanna-server`'s terminal watcher currently discards every runtime status for
a session with a live terminal attachment. This delegation is necessary for
`idle` and `waiting`, because the desktop supplies whether a task is selected
and that determines `idle` versus `unread`. It is not necessary for `busy`:
`activity_for_runtime_status` maps `busy` to `working` independently of
selection.

If the client status path is reconnecting, rebinding a same-id session, or
otherwise fails to persist a live `Busy` frame, the server can remain
`unread`. Attach-time replay then makes selection look like the cause of the
state change.

### Adopted PTYs have no reader before selection

`startup.rs` reconstructs a `SessionHandle` for every handed-off PTY with no
`stream_control` and explicitly waits for `AttachSnapshot` to start
`stream_output`. During that interval the headless terminal, recovery mirror,
and status detector are frozen.

The new daemon already waits for the old daemon to relinquish adopted agent
session readers before starting replacements. PTY adoption needs the same
ownership handoff and immediate reader restart.

### Same-id replacement does not stop the old reader explicitly

Task reruns kill and respawn the same daemon session id. `Kill` removes the old
handle from `SessionManager`, but it does not request that handle's
`StreamControl` to stop. The old reader can overlap the new session until EOF.
Final exit cleanup checks handle identity, but output mirroring and quiet
status refresh happen before that check and are externally visible under the
reused session id.

## Design

### 1. Busy is globally authoritative

Change the terminal watcher ownership rule:

- `Busy` is always applied through `activity_for_runtime_status`, even when a
  terminal attachment lease exists.
- `Idle` and `Waiting` remain client-owned while attached.
- All statuses remain watcher-owned while unattached.

This preserves the selected-task policy while guaranteeing the invariant:

> If the daemon reports a live PTY session as `Busy`, the server task activity
> converges to `working` without terminal selection.

The existing state-change publication remains the sidebar synchronization
mechanism. No sidebar polling, click-time refresh, or CSS workaround is added.

### 2. Adopted PTYs resume ingestion during startup

During handoff startup:

1. reconstruct each adopted `SessionHandle`;
2. retain the transferred PTY fd, input receiver, and handle needed to start
   `stream_output`;
3. wait for the previous daemon process to exit once when either PTY or agent
   sessions were adopted;
4. initialize recovery mirroring and fanout streaming state;
5. start one `stream_output` task for every adopted PTY before publishing the
   new daemon socket.

`AttachSnapshot` keeps its existing lazy-start branch as defensive support for
legacy/non-streaming handles, but normal handoff no longer depends on a client
attach.

### 3. A killed session stops before its id can be reused

`Kill` requests the current `StreamControl` to stop before terminating and
removing the PTY session. The reader checks both its stop token and manager
handle identity before externally visible chunk/status work. The kill path
waits for the reader to acknowledge the stop for a bounded interval before
replying, so a successful same-id respawn cannot race an old reader that is
still publishing events.

The wait is bounded and never holds the session-manager lock. If a reader
cannot acknowledge promptly, kill logs the timeout and continues after the
manager identity guard has made the old reader stale.

## Tests

1. Server watcher: an attached task in `unread` receiving `Busy` becomes
   `working` and publishes a task state change.
2. Server watcher: attached `Idle`/`Waiting` remains delegated to the client.
3. Daemon replacement: after killing and respawning a same-id session, output
   and status from the old handle cannot affect the replacement.
4. Daemon handoff: an adopted PTY changes status without any
   `AttachSnapshot`, and `List` observes the new status.
5. Existing focused server and daemon suites, formatting, linting, and the
   repository's practical verification commands remain green.

## Non-goals

- Changing bold/italic presentation rules.
- Reintroducing a periodic desktop `List` poll.
- Moving selected-task idle/unread policy into the daemon.
- Treating background subprocess existence as foreground-agent activity; the
  daemon's provider-aware terminal detector remains the source of runtime
  status.
