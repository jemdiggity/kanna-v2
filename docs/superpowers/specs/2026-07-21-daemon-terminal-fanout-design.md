# Daemon Terminal Fanout: Consumer Map and Root-Cause Backpressure Design

Follow-up to task-7a08b37d (`2026-07-20-terminal-output-stall-diagnostics-design.md`),
which added `terminal_perf` instrumentation and a temporary 500ms timeout that
disconnects a stalled attached writer from inside the PTY ingestion loop. This
document maps every real daemon terminal consumer, decides whether the shared
KSP data plane stays, and specifies the root-cause fix: a lag-aware
per-subscriber fanout boundary in the daemon.

## 1. Every real daemon terminal consumer

The daemon delivers PTY output through three mechanisms: attached writers
(`SessionWriters`, joined via `AttachSnapshot`), passive observers
(`SessionObservers`, joined via `Observe`), and the lossy `Subscribe`
broadcast (lifecycle JSON only — `Output` is never broadcast).

| Consumer | Daemon mechanism | Connection owner | Purpose |
|---|---|---|---|
| Desktop terminal (production) | `AttachSnapshot` (attached writer) | kanna-server `stream_terminal_once` (`crates/kanna-server/src/ksp.rs:1841`), one dedicated daemon connection per KSP terminal attachment | Terminal bytes → `term_snapshot`/`term_output` KSP frames → local WebSocket → desktop `StreamClient` → xterm |
| Mobile terminal | `AttachSnapshot` (attached writer) | Same kanna-server KSP handler, reached through the relay tunnel (`relay.rs:394-434` → `handle_tungstenite_stream`) | Same KSP frames over the tunnel |
| Desktop legacy lifecycle attach | `AttachSnapshot` (attached writer) | `apps/desktop/src-tauri/src/commands/daemon/attachment.rs` | **Production-dead.** No production frontend code invokes `attach_session_with_snapshot`; only the `PtyTest.vue` dev harness does, and its `terminal_output` listener has been dead since 4153e4dc. Discards `Output`, forwards `session_exit`/`status_changed` Tauri events that duplicate the event-bridge Subscribe path |
| Cloud-workspace remote terminal | `Observe` (passive observer) | kanna-server relay loop `observer_loop` (`relay.rs:656-722`), one dedicated daemon connection per observed session | Desktop-to-desktop terminal viewing over the relay: forwards every `Output` through the single shared relay WebSocket sink (`Arc<Mutex<WsSink>>`), fully awaited, no timeout |
| Task transfer | `Observe` (passive observer) | `crates/task-transfer/src/runtime/daemon.rs:91` | Same observer mechanism |
| Lifecycle watchers | `Subscribe` broadcast | Desktop event bridge (`daemon_lifecycle.rs:142`), kanna-server `terminal_watcher.rs:75` | `StatusChanged`/`Exit`/`SessionCreated`/hook events. `tokio::broadcast`: laggards drop messages, never block the sender |
| KSP terminal control | none (writes only) | kanna-server `run_terminal_control` (`ksp.rs:689`) | `InputNoReply`/`ResizeNoReply`; registers the effective size under its own writer, independent of the stream connection |

So a "non-reading attached client" in production is a KSP terminal stream
connection (desktop or mobile — indistinguishable at the daemon), and a
"non-reading observer" is the relay observer or task transfer. The legacy
desktop attachment cannot be the field culprit because it never exists in
production sessions.

### Why the 20-second pauses are architecturally possible today

`crates/daemon/src/output.rs::handle_output_chunk` runs inside the single PTY
ingestion loop and, per chunk:

- awaits every attached writer concurrently but bounded only by a **500ms
  timeout** (`STALL_THRESHOLD`) before disconnecting the stalled writer —
  ingestion still pauses up to 500ms, and reattach/stall cycles repeat it; and
- awaits every observer write **with no timeout at all**
  (`STAGE_OBSERVER_WRITE`). A relay WebSocket under TCP backpressure (or a
  contended shared sink mutex) stalls `observer_loop`, fills the observer's
  Unix socket, and then blocks PTY ingestion indefinitely — headless terminal
  mirroring, recovery persistence, and every healthy subscriber freeze
  together. This is the only remaining unbounded await and is sufficient to
  explain arbitrarily long (20s+) pauses whenever an observer exists.

`RecoveryManager::write_output` is already isolated (bounded queue,
`try_send`, drop-on-full), and `Subscribe` uses a lossy broadcast. The fanout
to attached writers and observers is the only boundary where client socket
progress can still back-pressure PTY ingestion.

## 2. The shared KSP data plane stays

Restoring the pre-4153e4dc desktop Tauri event path would be the wrong fix:

- KSP is the single source of truth for terminal bytes across desktop,
  mobile, and relay-tunnelled clients; one data plane means one snapshot
  hydration path (`term_snapshot` resets and rehydrates xterm mid-stream,
  `terminalSessionLifecycle.ts:131-141`) and one resync mechanism
  (`stream_terminal` re-attaches with backoff on daemon loss and re-sends a
  fresh authoritative snapshot).
- The KSP layer is already per-subscriber isolated: each attachment has its
  own forwarding task and its own daemon connection. `stream_terminal_once`
  blocking on a full outbound frame queue only stops draining *its own*
  daemon socket. The defect is that the daemon lets that private stall
  propagate into the shared ingestion loop — which is exactly what the fanout
  boundary below removes. No KSP protocol change is required.

## 3. Root-cause fix: per-subscriber bounded mailboxes in the daemon

New `crates/daemon/src/fanout.rs`. Each session owns a `SessionFanout`
(whose `streaming` flag keeps the existing "stream started" meaning of
`session_writers` entry presence); each attached writer and each observer
becomes a `Subscriber`:

- a mailbox — an unbounded channel guarded by byte-budget accounting
  (`SUBSCRIBER_MAILBOX_MAX_BYTES` of undelivered pre-serialized event lines,
  each `Arc<str>`, serialized once per event for all subscribers); the
  budget, not the channel, is what bounds memory; and
- a dedicated writer task that drains the mailbox onto that client's
  socket (`Arc<Mutex<OwnedWriteHalf>>`, shared with command replies exactly
  as today) and wraps each socket write in the existing
  `attached_writer`/`observer_write` `terminal_perf` stages.

The PTY ingestion loop **only ever enqueues without awaiting**. It never
awaits client socket or WebSocket progress; neither do headless mirroring or
recovery persistence, which keep running even when every subscriber is
wedged.

### Lag behavior (explicit)

Disconnecting an overflowing subscriber was considered and rejected: a
subscriber that is actively draining but momentarily slower than a PTY burst
(the normal case during heavy output) would be disconnected and reconnect in
a churn loop. Instead lag is handled in place, mosh-style, using the
authoritative headless terminal:

- **Bounded memory:** at most `SUBSCRIBER_MAILBOX_MAX_BYTES` undelivered
  serialized bytes per subscriber, plus the kernel socket buffer. A
  subscriber over budget is marked *lagged* and further output is dropped
  for it — enqueueing to everyone else continues untouched.
- **Observable:** the transition emits a `terminal_perf … event=lag` record
  (new `TerminalPerfEventKind::Lag`) with stage, session, chunk, and queue
  budget; the eventual resync emits `event=recovered` carrying the lag
  episode duration; slow-but-within-budget sockets keep emitting the
  existing stall/recovered records from the writer task.
- **Deterministic resync:** once a lagged subscriber's backlog fully drains,
  the daemon re-syncs it in place by queueing a fresh authoritative
  snapshot — on the next output chunk, or within one 500ms status tick
  during silence. This is the same snapshot-first contract every consumer
  already implements for attach and reattach: KSP forwards the mid-stream
  `Snapshot` as a `term_snapshot` frame (desktop/mobile reset and
  rehydrate), the relay observer forwards it as a `terminal_snapshot`
  event, and task-transfer already forwards mid-stream snapshots.
- **Isolation:** healthy subscribers keep their own mailboxes draining;
  per-client ordering is preserved by the per-subscriber queue, and a
  resynced subscriber sees snapshot-then-live with nothing duplicated or
  lost in between.
- **Final events:** on session exit/kill, a subscriber that still cannot
  take the Exit event is disconnected (writer task aborted, write half shut
  down) so its client observes EOF instead of a silent dead stream.

### Observer cutover: `ObserveSnapshot`

The legacy observer flow (`Observe` then a separate `Snapshot` command on the
same connection) had no atomic boundary: the plain `Snapshot` handler runs
outside the fanout lock and writes its reply through the same socket writer
the observer's mailbox task uses, so a chunk could be mirrored after the
snapshot was taken yet win the writer lock before the snapshot reply —
consumers that discard pre-snapshot output (relay) lose those bytes, and
consumers that forward everything (task-transfer) reset over them. The
`ObserveSnapshot` command closes this: under the session fanout lock it
snapshots the authoritative terminal and registers the observer with that
`Snapshot` event as its first queued mailbox message — the same atomic
cutover attached writers get from `AttachSnapshot`. The relay
(`observe_session`) and task-transfer observer paths both use it; the plain
`Observe`/`Snapshot` commands remain for non-streaming uses.

### Mailbox byte budget and the snapshot exemption

A subscriber's queued bytes never exceed `max(budget, one authoritative
snapshot + initial status events)`. Live output past the budget marks the
subscriber lagged and is dropped; snapshot lines are exempt — an
authoritative snapshot larger than the budget must remain deliverable or
resync would deadlock — but they are only ever queued into an empty mailbox
(fresh registration, or resync after a fully drained backlog), so the
exemption cannot accumulate. A subscriber slower than snapshot-sized bursts
degrades to snapshot-paced delivery while staying within the bound.

### Same-connection re-registration

Replacing or removing a subscriber cancels its writer stream: the in-flight
line completes (lines stay whole on the socket) and everything still queued
is discarded, with the cancellation checked under the shared socket writer
lock. A same-connection reattach or re-observe therefore keeps one ordered
writer stream — queued output from the replaced registration can never be
delivered after the fresh snapshot.

### Atomic snapshot-to-live cutover

Today the attach snapshot is taken *before* the writer joins the registry, so
a chunk mirrored between the two steps can be missed by (or duplicated to)
the new client. The fanout closes this: the ingestion loop holds the
per-session fanout lock across (mirror → enqueue), and `AttachSnapshot` holds
the same lock across (snapshot → enqueue snapshot + status → register
subscriber). Any chunk is therefore either fully contained in the snapshot or
fully enqueued behind it, never both, never neither. The lock is
per-session and is never held across a client-progress await.

### Exit and kill delivery

Session exit and `Kill` enqueue exactly one `Exit` line per subscriber
(try_send; an already-lagging subscriber is disconnected without it — its
client resyncs on reconnect and observes the session gone) and then close all
mailboxes; writer tasks drain and finish. The `Kill` handler currently
writes `Exit` to every attached writer and observer twice (refactor
artifact); the fanout consolidates this to one delivery. The `Subscribe`
broadcast of killed exits is unchanged — `terminal_watcher` deliberately
filters `killed` exits, so broadcast semantics stay as-is.

## 4. Legacy desktop lifecycle AttachSnapshot: retire

Evidence (see §1): no production caller; lifecycle events already reach the
frontend through the event-bridge `Subscribe` connection (`daemon_ready`,
`session_exit` including killed exits, `status_changed`, `hook_event`,
`session_created`) and through KSP `session_exit` frames; `terminal_snapshot`
is consumed only by the relay viewer bridge (fed by relay events, not Tauri
events) and mocks; `session_stream_lost` can only be emitted by the dead
path. The correct end state is to retire `attach_session_with_snapshot` and
the attachment stream task rather than convert them to a non-output
subscription that would duplicate the event bridge. Removal touches the
`PtyTest.vue` dev harness and e2e mocks and is deliberately kept out of this
change to keep the daemon fix reviewable; it is documented here as the
follow-up end state, not a steady state to preserve.

## 5. Test obligations

Red first, against the current fanout, in `crates/daemon/tests/reconnect.rs`:

1. A permanently non-reading attached client must not delay a healthy
   attached client **at all** — the healthy client receives a marker well
   under the previous 500ms timeout bound while the stalled client's socket
   stays saturated, and stays ordered.
2. A permanently non-reading observer (no timeout at all today — this is the
   indefinite-stall path) must not delay a healthy attached client.
3. A subscriber that overflows its byte budget is not disconnected: once it
   resumes draining it is resynchronized in place from a fresh authoritative
   snapshot containing the content it missed, live output resumes after the
   snapshot, and neither the healthy subscriber nor PTY ingestion (headless
   snapshot over a control connection) was ever delayed.

The saturation probes clamp the stalled connection's `SO_RCVBUF` and assert
the corresponding `terminal_perf` stall/lag records in the daemon log, so a
flood the kernel quietly buffers away fails the test instead of passing
vacuously. Additional coverage: a same-connection reattach with a queued
backlog proving the fresh snapshot is the cutover boundary (no stale output
after it), observer overflow/resync (fresh mid-stream Snapshot followed by
live Output), an `observer_loop` integration test forwarding a mid-stream
resync Snapshot over a real WebSocket sink, source-order unit tests that the
ingestion loop never writes to a subscriber socket and that the attach
cutover holds the fanout lock across snapshot and registration, a KSP test
that a mid-stream daemon `Snapshot` is forwarded as a `term_snapshot` frame,
and the existing concurrent attach cutover, kill, handoff, and cleanup
suites staying green.
