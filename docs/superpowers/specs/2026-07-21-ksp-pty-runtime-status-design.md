# KSP PTY Runtime Status Authority Design

Desktop sidebar activity (`working` italic / `unread` bold / `idle`) can stay
`idle` while a PTY-mode agent (e.g. Codex) is visibly producing output in its
terminal. This document confirms the gap, records the boundary decisions from
brainstorming, and specifies the fix. Revision 2 (2026-07-22): KSP is the
authoritative runtime status channel for attached PTY sessions, kanna-server
applies status directly for sessions with no live KSP terminal attachment,
and the legacy Tauri status path is removed outright together with its tests
— no temporary fallback remains. Revision 3 (2026-07-22): the attach-gap
race is closed by an explicit ownership and reconciliation design — a
selected-client repair rule in `activity_for_runtime_status`, attach-time
snapshot-status replay as the guaranteed repair point, and one-shot detach
reconciliation (§2a).

## 1. Confirmed gap

The daemon emits `Event::StatusChanged { session_id, status, .. }` with
`SessionStatus` values `busy` / `waiting` / `idle`
(`crates/daemon/src/protocol.rs:130`). Four consumers exist today, and none of
them delivers status to a KSP PTY terminal attachment:

- **kanna-server KSP agent stream** — `stream_agent_once` forwards
  `StatusChanged` as `ServerFrame::StatusChanged { task_id, status }`
  (`crates/kanna-server/src/ksp.rs:1722-1734`). Headless-only: PTY tasks never
  have an agent attachment.
- **kanna-server KSP terminal stream** — `stream_terminal_once` forwards
  `Output`, mid-stream `Snapshot`, and `Exit`, but `StatusChanged` falls into
  the catch-all `Ok(_) => {}` (`crates/kanna-server/src/ksp.rs:1950`). PTY
  attachments receive no status frames at all.
- **kanna-server terminal_watcher** — on `StatusChanged` it only persists the
  waiting-prompt snippet (`crates/kanna-server/src/terminal_watcher.rs:92-104`);
  it never applies busy/idle activity because the idle-vs-unread decision
  needs the client-side `selected` bit it does not have.
- **Desktop legacy event bridge** — the Tauri process holds its own daemon
  `Subscribe` connection and re-emits `status_changed` as a Tauri event
  (`apps/desktop/src-tauri/src/daemon_lifecycle.rs:170`), consumed by
  `listen("status_changed")` in `apps/desktop/src/stores/init.ts:380`, which
  resolves the item and calls `applyTaskRuntimeStatus`.

On the client, `packages/stream-client/src/index.ts:457-459` routes
`status_changed` frames only to `agentAttachment(frame.task_id)`.
`TerminalStreamHandlers` has no `onStatus` member, and the desktop wires no
`onStatus` handler anywhere — the terminal attachment in
`terminalSessionLifecycle.ts:130` registers only
`onSnapshot`/`onOutput`/`onSessionExit`/`onError`.

Net effect: the KSP data plane — the production terminal path for desktop and
mobile since the fanout consolidation
(`2026-07-21-daemon-terminal-fanout-design.md` §1) — carries terminal bytes
but not status, so sidebar activity for PTY tasks depends entirely on the
legacy side-channel (`daemon_lifecycle.rs` bridge plus the
`syncTaskStatusesFromDaemon` `list_sessions` poll in
`apps/desktop/src/stores/sessions.ts:133`). When that side-channel is
reconnecting, lagging, or absent, a busy Codex session renders live output
while its sidebar row stays `idle`.

Activity semantics are decided server-side and must not move:
`activity_for_runtime_status`
(`crates/kanna-server/src/http_api/task_activity.rs:24-47`) maps `busy` →
`working`; `idle`/`waiting` downgrade only from `working`, to `idle` when the
task is selected in some window and `unread` otherwise. The desktop supplies
`selected` per event via `isTaskSelectedInAnyWindow` when POSTing
`/v1/tasks/{task_id}/activity/runtime-status`
(`apps/desktop/src/stores/sessions.ts:109-131`).

## 2. Decisions (from brainstorming)

**Where status becomes authoritative.** Three options were evaluated:

1. *Forward `StatusChanged` inside `stream_terminal_once`* — chosen. Status
   rides the same dedicated daemon connection that proves the attachment is
   live, mirrors the existing agent-stream behavior, reuses the existing
   `ServerFrame::StatusChanged` (task-keyed, no protocol addition), and needs
   no daemon changes for the steady state.
2. *Make `terminal_watcher` persist activity server-side for every session* —
   initially rejected because idle-vs-unread needs the client's `selected`
   bit. Revision 2 adopts a scoped version for unattached sessions only,
   where no selection knowledge is needed (see §2a).
3. *A new `term_status` frame kind* — rejected; `status_changed` already
   exists and is task-scoped, and inventing a parallel frame would fork the
   status vocabulary.

**Stream-client routing.** Route `status_changed` to both the agent and the
terminal attachment, exactly as `session_exit` already does
(`packages/stream-client/src/index.ts:467-471`). `TerminalStreamHandlers`
gains an optional `onStatus?(status: string): void`. Optionality keeps mobile
and other existing consumers source-compatible.

**Desktop consumption point.** The status must flow into the *same*
`applyTaskRuntimeStatus` service the legacy listener uses — same
session-to-item resolution (`resolveTaskItemForDaemonSession`; KSP terminal
attachments are keyed by daemon session id, see
`terminalSessionLifecycle.ts:130`, so shell/teardown sessions filter out
naturally), same setup-pending guard, same `selected` computation, same
server-side `activity_for_runtime_status` decision. The terminal component
must not own activity policy: the `onStatus` handler forwards
`(sessionId, status)` to a store-registered sink (precedent:
`markTaskSwitchFirstOutput` imported into `terminalSessionLifecycle`), and the
store applies it. No duplicated mapping logic in the component layer.

**Initial status on attach.** `StatusChanged` is edge-triggered; a client
that attaches to an already-busy session would see nothing until the next
transition (e.g. desktop relaunch mid-Codex-run). The daemon already tracks
per-session `SessionStatus` (it serves it in `List`). Extend the attach
snapshot payload (`TerminalSnapshot`, `crates/daemon/src/protocol.rs:54`) with
`#[serde(default)] status: SessionStatus` (default `Idle` preserves
mixed-version decode during daemon handoff), and have `stream_terminal_once`
emit one `status_changed` frame immediately after `term_snapshot`. Rejected
alternative: a `List` round-trip per attach from kanna-server — extra daemon
command on the hot attach path and racy against concurrent transitions.

**Legacy listener fate.** Revision 1 kept the Tauri `status_changed`
listener and the `syncTaskStatusesFromDaemon` poll as a labeled temporary
fallback for unattached sessions. Revision 2 removes them (see §2a).

## 2a. Revision 2 decisions (remove the legacy path)

**Authorization.** The original task text required retaining the legacy
Tauri listener as a temporary fallback; the operator explicitly superseded
that on 2026-07-22 with the directive "we should remove the legacy code and
its corresponding tests". Revision 2 executes that directive.

**The gap full removal must close.** KSP status frames flow only to sessions
with a live terminal attachment. Tasks whose terminals were never mounted
(e.g. created via MCP/CLI and never clicked) would silently lose activity
tracking if the legacy path were simply deleted.

**Key observation: selection implies attachment — in steady state only.** A
selected task's terminal is mounted and KSP-attached
(`terminalSessionLifecycle`), so in steady state an unattached session is
never the selected one, and the server can apply runtime status for
unattached sessions without selection knowledge: `busy` → `working`
(selection-independent anyway), and `idle`/`waiting` downgrades from
`working` → `unread` — what `activity_for_runtime_status` decides with
`selected: false`.

**The attach-gap race (Revision 3).** The steady-state claim is false during
initial attach and reconnect gaps: between selecting a task and the KSP
attach completing (or while a dropped stream re-attaches), the registry
refcount is zero. An `idle`/`waiting` event landing in that gap makes the
watcher apply `working` → `unread` for a task the user is actively viewing —
and under the pre-Revision-3 rules that state was unrepairable, because
`activity_for_runtime_status` returns `None` for `idle`/`waiting` whenever
current activity is not `working` (`task_activity.rs:37-45`): the selected
client's post-attach status replay could not turn `unread` back into `idle`.

**Ownership and reconciliation (Revision 3).** Ownership is asymmetric by
authority, not just by attachment:

1. *The watcher is a conservative writer.* It may only apply
   `busy` → `working` and `working` → `unread`, and only for sessions with
   no live attachment refcount. Its worst-case misfire is an over-eager
   `unread` on a selected task caught in an attach gap — never a lost
   `working` and never a wrong `idle`.
2. *The selected client is the authority and the repairer.*
   `activity_for_runtime_status` gains one rule: `idle`/`waiting` with
   `selected: true` maps `unread` → `idle` in addition to
   `working` → `idle`. Unselected reports keep `working` → `unread` only,
   and the watcher always applies with `selected: false`, so only a client
   showing the task to the user can perform the repair.
3. *Attach is the guaranteed repair point.* The mandatory initial
   snapshot-status frame after `term_snapshot` (§2, "Initial status on
   attach") means every attach replays the session's current status through
   the selected client's POST — any watcher misfire during the gap is
   repaired as soon as the attach lands, with no timers and no polling.
4. *Detach triggers one-shot reconciliation.* A status change can also land
   in the symmetric window between a stream ending and the watcher taking
   over (an idle prompt emits no further output, so the daemon will not
   re-emit). When a session's attachment refcount drops to zero,
   kanna-server immediately queries that session's current status (daemon
   `List`) and applies it through the unattached rule — event-driven, no
   periodic poll.

Ordering guarantee: the attachment lease is acquired before the
`AttachSnapshot` round-trip begins and released when the stream task ends,
so the watcher's skip window brackets the client's entire ownership span;
events falling in either boundary window are covered by reconciliation
points 3 and 4.

Repair-rule side effect (accepted): selecting an `unread` task whose live
session sits at an idle prompt now clears the bold state at attach time
rather than after the 1s mark-read debounce — the user is looking at the
task, so clearing is consistent with existing mark-read intent.
Completion-driven `unread` (daemon `Exit` boundary) is unaffected: an exited
session has no live status stream left to replay.

**Registry.** `terminal_watcher` consults a process-global refcounted
registry of attached terminal session ids maintained by the KSP stream
lifecycle (KSP attachments are per-connection state only, `ksp.rs:486`;
multiple windows/clients can attach the same session, hence a refcount, not
a set).

**Watcher reconciliation replaces the poll.** On every successful daemon
subscribe, `terminal_watcher` issues a `List` command (session status is
already in the reply, `crates/daemon/src/protocol.rs:315`) and applies each
session's status through the same unattached-only rule. This covers
transitions missed while kanna-server was down — the role the deleted
desktop `list_sessions` poll used to play.

**Last legacy consumer migrates.** `terminalLayout.ts` reconnect redraw
settle (`waitForIdleStatus`, `terminalLayout.ts:77`) listens on the legacy
Tauri event; it moves to the KSP status via the runtime-status sink
generalized into a small per-session status bus (multiple subscribers, store
sink + terminal layout).

**Removed outright, with their tests:** the event-bridge `status_changed`
emission (`daemon_lifecycle.rs:170`), the legacy-attach emission
(`attachment.rs:189`, production-dead per the fanout design),
`listen("status_changed")` in `stores/init.ts`, `syncTaskStatusesFromDaemon`
and its `session_created` call site, and the legacy-path cases in
`kanna.runtimeStatusSync.test.ts`. The Revision-1 kill-switch idea
(`KANNA_DISABLE_LEGACY_STATUS_FALLBACK`) is dropped — there is nothing left
to switch off.

## 3. Design

### kanna-server (`crates/kanna-server/src/ksp.rs`)

In `stream_terminal_once`'s event loop, add a `StatusChanged` arm matching
the session id, forwarding `ServerFrame::StatusChanged { task_id,
status: status_str(status) }` — identical shape to the agent-stream arm at
`ksp.rs:1722`. After a successful `AttachSnapshot` reply, send the snapshot's
`status` as a `status_changed` frame directly after the `term_snapshot`
frame.

### daemon (`crates/daemon`)

`TerminalSnapshot` gains `#[serde(default)] pub status: SessionStatus`,
populated wherever attach/observe snapshots are built from live session
state. No new events, no behavior change for existing consumers (serde
default on decode; extra field ignored by old decoders is not a concern for
JSON, and new decoders of old producers get `Idle`).

### stream-client (`packages/stream-client/src/index.ts`)

- `TerminalStreamHandlers` gains optional `onStatus?(status: string): void`.
- The `status_changed` case delivers to both attachment kinds:
  agent (existing) and terminal (new), keyed by `frame.task_id`.

### desktop (`apps/desktop/src`)

- `terminalSessionLifecycle` registers `onStatus` in its `attachTerminal`
  handlers, forwarding `(params.sessionId, status)` to a runtime-status sink.
- The store (`stores/init.ts` / `stores/sessions.ts`) registers the sink at
  init: resolve the item with `resolveTaskItemForDaemonSession`, then call
  the existing `applyTaskRuntimeStatus`. The legacy `listen("status_changed")`
  block and the `syncTaskStatusesFromDaemon` poll are deleted per §2a;
  sessions without a live KSP attachment are covered by the server-side
  application below.

Idle-vs-unread semantics stay at the existing boundary: all paths converge
on the `/v1/tasks/{task_id}/activity/runtime-status` POST carrying
`selected`, and `activity_for_runtime_status` remains the single decision
point. Revision 3 adds exactly one rule there: `idle`/`waiting` with
`selected: true` also maps `unread` → `idle` (the attach-gap repair, §2a).

**Server-side application for unattached sessions (Revision 2).**
`terminal_watcher` gains the unattached-only status application from §2a:
on `StatusChanged`, if the session has no live KSP terminal attachment
(refcounted registry shared through `AppState`), resolve the task and apply
`busy` → `working`, `idle`/`waiting` from `working` → `unread`, reusing the
`activity_for_runtime_status` rules with `selected: false` and publishing
`StateChangeScope::Tasks` so all clients refresh — the same broadcast the
HTTP endpoint uses (`task_activity.rs:91`). On subscribe it reconciles via
daemon `List`. Waiting-prompt persistence is unchanged.

**Detach reconciliation (Revision 3).** When a session's attachment
refcount drops to zero, kanna-server performs a one-shot daemon `List` for
that session and applies its current status through the same unattached
rule, closing the stream-end → watcher-takeover window (§2a point 4).

## 4. Required regression coverage

- **stream-client boundary** (`packages/stream-client/src/stream-client.test.ts`):
  a `status_changed` frame reaches the terminal attachment's `onStatus`; it
  still reaches the agent attachment; a terminal attachment without `onStatus`
  does not throw; a frame for an unattached task is a no-op.
- **kanna-server KSP boundary** (`ksp.rs` tests module, existing fake-daemon
  stream tests): a daemon `StatusChanged` mid terminal stream produces a
  client-visible `status_changed` frame; the initial frame after
  `term_snapshot` carries the snapshot status; status for a different session
  id is not forwarded.
- **daemon serde**: `TerminalSnapshot` round-trip with and without the
  `status` field (default `Idle`).
- **desktop activity integration** (`apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
  boundary): a KSP terminal `busy` drives activity to `working`; `idle` while
  the task is selected yields `idle`; `idle` while unselected yields
  `unread`; the setup-pending guard and closed-task guard still apply; a
  status applied twice during a client/server writer overlap window (§2a)
  converges idempotently (second apply returns `activity: null`, no extra
  reload).
- **E2E (required, false-agent driven)**: the daemon status detector is
  plain marker matching over the visible footer rows
  (`crates/daemon/src/headless_terminal.rs:628` — `"esc to interrupt"` →
  busy, `"do you want to allow"` → waiting, a `›`/`❯` prompt line → idle), so
  no live provider CLI is needed. The E2E harness already spawns arbitrary
  executables as daemon PTY sessions with an `agent_provider` tag
  (`spawn_session` in `pty-session.test.ts`). Add a desktop E2E that spawns a
  scripted false agent tagged `codex` which prints the busy marker, pauses
  past the status-detection throttle, prints the waiting marker, then ends on
  an idle prompt line — and asserts sidebar/task activity follows
  working → (selected ? idle : unread) through the real daemon → kanna-server
  → KSP → store path. With the legacy path removed there is no fallback to
  mask the result: the selected/attached case exercises the client-applied
  KSP path, and an unselected task with an unmounted terminal exercises the
  server-side `terminal_watcher` path — the E2E should assert both. This
  supersedes any standalone E2E-gap writeup.
- **terminal_watcher boundary** (Revision 2): unattached `busy` applies
  `working`; unattached `idle` from `working` applies `unread`; a session
  with a live attachment refcount is skipped; subscribe-time `List`
  reconciliation applies statuses; refcount attach/detach lifecycle.
- **Attach-gap race** (Revision 3, required — cross-process asynchronous
  lifecycle behavior):
  - `task_activity` rules: `idle`/`waiting` + `selected` + current `unread`
    → `idle` (repair); `idle`/`waiting` + unselected + current `unread` →
    `None` (watcher misfires stay repairable only by a selected client);
    `busy` transitions unchanged.
  - Watcher/registry ordering: a `StatusChanged` arriving while the lease is
    held is skipped by the watcher; the lease is acquired before the
    `AttachSnapshot` round-trip and released at stream end; refcount-zero
    triggers the one-shot detach reconciliation and it applies the session's
    current status.
  - Gap-repair integration (`kanna.runtimeStatusSync.test.ts` boundary):
    simulate the full ordering — selected task `working`, watcher applies
    `unread` during an attach gap, client attach replays snapshot status
    `idle` with `selected: true` — and assert final activity is `idle`.
  - E2E (desktop PTY harness): force the selected task through an
    initial-attach or reconnect gap while the false agent transitions
    busy → idle (e.g. start the false agent before the terminal mounts, or
    drop and re-establish the stream mid-run) and assert the final sidebar
    activity is `idle`, not `unread`.
- **status bus / terminal layout** (Revision 2): reconnect redraw settle
  resolves from a KSP status delivery instead of the removed Tauri event.
- **Legacy-path tests removed** (Revision 2): the `listen("status_changed")`
  and `syncTaskStatusesFromDaemon` cases in `kanna.runtimeStatusSync.test.ts`
  go away with the code they cover.

## 5. Out of scope

- Headless (SDK-mode) activity flow — agent attachments already receive
  `onStatus`; wiring a desktop consumer for them is orthogonal.
- Mobile consumption of terminal status frames (the optional handler makes
  this available; adopting it is a mobile feature).
- `waiting_prompt_snippet` propagation over KSP (terminal_watcher keeps it).

## 6. Fallback removal criteria

Revision 1 predicted the fallback could be deleted once kanna-server applied
runtime status for unattached sessions, and assumed that required per-window
selection knowledge. §2a's observation (selection implies attachment) showed
it does not. Revision 2 executes the removal: the legacy Tauri status
emissions, listener, and poll are deleted rather than labeled.
