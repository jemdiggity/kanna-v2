# KSP PTY Runtime Status Authority Design

Desktop sidebar activity (`working` italic / `unread` bold / `idle`) can stay
`idle` while a PTY-mode agent (e.g. Codex) is visibly producing output in its
terminal. This document confirms the gap, records the boundary decisions from
brainstorming, and specifies the fix: KSP becomes the authoritative runtime
status channel for attached PTY sessions, with the legacy Tauri event bridge
retained only as a temporary fallback.

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
   rejected for this fix. It cannot preserve idle-vs-unread because `selected`
   is client knowledge; moving selection tracking into kanna-server is a
   larger boundary change. Noted as the eventual end state that would retire
   the fallback entirely (see §6).
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

**Legacy listener fate.** The Tauri `status_changed` listener in
`stores/init.ts` and the `syncTaskStatusesFromDaemon` poll stay, explicitly
documented in code as a temporary fallback: they still cover sessions with no
KSP attachment (background tasks whose terminals are not mounted). Double
delivery is harmless — `apply_runtime_status` returns `activity: null` when
nothing changes and the desktop skips the reload in that case
(`sessions.ts:126`). Removal criteria in §6.

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
  block remains directly below it with a comment marking it as the temporary
  fallback for unattached sessions.

Idle-vs-unread semantics are untouched: all paths converge on the
`/v1/tasks/{task_id}/activity/runtime-status` POST carrying `selected`, and
`activity_for_runtime_status` remains the single decision point.

**Fallback kill switch (dev/E2E only).** A `KANNA_DISABLE_LEGACY_STATUS_FALLBACK`
environment flag (read once at store init, dev builds only) skips registering
the legacy `status_changed` Tauri listener and the `syncTaskStatusesFromDaemon`
poll. It exists so the E2E can prove the KSP path in isolation, and it is the
mechanism that later becomes the fallback's removal (§6). Production behavior
is unchanged when the flag is absent.

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
  status arriving on both KSP and legacy paths applies once (second apply
  returns `activity: null`, no extra reload).
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
  → KSP → store path. To prove KSP is the carrier (not the fallbacks), the
  E2E instance launches with the fallback kill switch (below) enabled. This
  supersedes any standalone E2E-gap writeup.

## 5. Out of scope

- Headless (SDK-mode) activity flow — agent attachments already receive
  `onStatus`; wiring a desktop consumer for them is orthogonal.
- Mobile consumption of terminal status frames (the optional handler makes
  this available; adopting it is a mobile feature).
- `waiting_prompt_snippet` propagation over KSP (terminal_watcher keeps it).

## 6. Fallback removal criteria

The legacy Tauri `status_changed` listener and the `list_sessions` status
poll can be deleted when kanna-server itself applies runtime status for
sessions with no live KSP attachment — which requires the server to know
per-window selection (or to defer the idle-vs-unread choice until read).
Until then they are fallbacks, not the steady state, and must be labeled as
such in code.
