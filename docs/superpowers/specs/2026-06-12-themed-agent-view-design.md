# Themed Agent Views & the Kanna Stream Protocol

**Date:** 2026-06-12
**Status:** Approved design, pending implementation planning

## Problem

Kanna displays agent tasks as their raw TUI: PTY bytes stream from the agent CLI through the daemon and Tauri backend into xterm.js. This works well locally, but for remote tasks every keystroke requires a network roundtrip before it echoes, making typing into a remote agent terminal laggy. The raw TUI is also a rendering dead end: it can't be restyled, and its interaction model (keystrokes into a terminal) fights Kanna's keyboard shortcuts.

## Goal

Display agent sessions as themed, native message views driven by the agent's structured JSON output instead of raw terminal bytes, with a normal input field (local echo, one roundtrip per message) for steering the agent. Make this work identically for local, LAN, and cloud-connected clients.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Meaning of "themes" | Multiple view styles rendering the same stream: **chat bubbles**, **compact log**, **terminal look** — ship all three on desktop |
| Mode switching | **Fixed at task creation**: themed (headless JSON) or raw terminal (PTY/TUI). No live switching |
| Default for new tasks | **Themed is the default** for supported providers; raw terminal is the opt-in |
| Providers at launch | **Claude and Codex** themed from day one via a provider-adapter abstraction; Copilot/OpenCode remain PTY-only until they get adapters |
| Permissions | **Full Allow / Allow-for-session / Deny UI** in the themed view, wired through the provider's permission/approval protocol |
| Input capability | **Steer mid-run + interrupt** (parity with what the TUI allows) |
| Session persistence | **Daemon-managed**: agent sessions survive app restarts and daemon handoff, same as PTY sessions |
| Remote scope | **Desktop remote and mobile** both in scope |
| Architecture posture | **Best long-term architecture, no backward-compatibility constraints.** One protocol for local/LAN/cloud; relay becomes a dumb tunnel; legacy paths are deleted, not preserved |

## Target architecture

Four roles, one protocol:

```
┌────────────────────── DESKTOP MACHINE ──────────────────────┐
│  DAEMON (session authority — tiny, stable)                  │
│    PTY sessions: headless terminal snapshots                │
│    AGENT sessions: headless CLI child + provider adapter    │
│                    + seq-numbered AgentEvent journal        │
│                  │ unix socket (attach/replay)              │
│  KANNA-SERVER (gateway — the only protocol surface)         │
│    Kanna Stream Protocol (KSP) over one multiplexed WS:     │
│    attach/replay · agent events · terminal frames ·         │
│    input/permission/interrupt · task API requests           │
│       │ localhost WS              │ outbound WS             │
│  DESKTOP APP (Tauri shell +       │                         │
│  same client library as mobile)   │                         │
└───────────────────────────────────┼─────────────────────────┘
                                    │
                     RELAY = dumb authenticated tunnel
                     (pairs sockets, splices opaque bytes)
                          │                    │
                   CLOUD clients         LAN clients (direct
                   (mobile/desktop)      WS, skip the relay)
```

- **Daemon** — session authority only. Owns PTY and agent sessions, journals, handoff. Deliberately not merged with the gateway: a restartable network layer must never take sessions down with it.
- **kanna-server** — the single protocol surface, always running, supervised by the desktop app the same way the daemon is. Serves session streams and the task API to every client, including the local desktop app over localhost.
- **Relay** — connection rendezvous and opaque byte forwarding only. All message-level vocabulary on the relay is deleted. (This unlocks optional end-to-end encryption later; out of scope here.)
- **Desktop app** — Tauri shell around the shared client library. Keeps machine-local powers only: supervising daemon/gateway, git/fs/IDE/native integrations. Local, LAN, and cloud clients have the same flow; only the dial strategy differs.

## Component design

### 1. `kanna-agent-protocol` crate (schema + provider adapters)

The schema source of truth, grown from `crates/claude-agent-sdk` types.

**Neutral `AgentEvent` schema** (journaled and streamed everywhere):
`turn_started`, `assistant_text`, `thinking`, `tool_call`, `tool_result`, `tool_progress`, `permission_request`, `permission_resolved`, `turn_completed { stats }`, `session_ended { code }`, `user_message` (echo of input), `diagnostic` (stderr), `raw` (unrecognized provider output — never dropped).

**`ProviderAdapter` trait**, one implementation per provider, responsible for:
- spawn command construction (executable, headless/JSON flags, permission mode flags)
- parsing provider stdout lines into zero or more neutral `AgentEvent`s
- encoding user input messages onto stdin (mid-run steering)
- encoding interrupt
- surfacing and answering permission/approval requests
- capturing the provider session id for resume-after-crash

**Day-one adapters:**
- **ClaudeAdapter** — `claude -p --output-format stream-json --input-format stream-json`; control protocol for interrupt and `can_use_tool` permission callbacks; `--resume <session_id>` for resurrection. Permission-mode flags are camelCase (`dontAsk`, `acceptEdits`, `default`).
- **CodexAdapter** — Codex CLI's non-interactive JSON/JSONL interface (stdio protocol mode) for events, approvals (exec/patch approval requests map to `permission_request`), input injection, and session resume. Exact flags are pinned by CLI contract tests during implementation, not hardcoded assumptions in this spec.

Copilot and OpenCode remain PTY-only; adding them later is writing an adapter, nothing more.

**Type generation:** TypeScript types for `AgentEvent` and all KSP frames are generated from the Rust definitions (ts-rs or JSON-Schema export) into the shared client package. CI fails if generated output is stale. This removes Rust↔TS schema drift (the class of bug the relay has had before, e.g. `createPairingCode`).

### 2. Daemon agent sessions

**New commands:** `SpawnAgent { session_id, agent_provider, executable, args, cwd, env }`, `AttachAgent { session_id, from_seq }`, `AgentInput { session_id, text }`, `AgentPermission { session_id, request_id, decision }`, `AgentInterrupt { session_id }`.
**New events:** `AgentSnapshot { session_id, events, last_seq }` (attach replay), `AgentEvent { session_id, seq, event }` (live).
`Kill`, `Signal`, `List`, `Subscribe`, `StatusChanged` work for both session kinds. PTY-only commands (`Resize`, raw `Input`) are errors for agent sessions.

**Process model:** the CLI child runs headless on plain pipes (stdin/stdout/stderr), detached via `setsid` like PTY children. The provider adapter translates each stdout line; stderr is journaled as `diagnostic` events.

**Journal:** per-session append-only log of neutral `AgentEvent`s with a monotonically increasing `seq`. Held in memory, persisted as NDJSON at `KANNA_DAEMON_DIR/agent-journals/{session_id}.ndjson`. The journal is the agent-session analog of the headless terminal: authoritative while detached. Oversized tool outputs are truncated at translation time with explicit truncation markers, bounding journal size by conversation length rather than output volume. Journal files persist until task cleanup (same lifecycle as worktrees).

**Attach semantics:** replay events `>= from_seq`, then join the live broadcast. Any number of clients may attach; no terminal-size coordination exists for agent sessions.

**Permissions:** a provider approval request is journaled as `permission_request` (late attachers see pending prompts). The first client decision wins; the daemon answers the provider and journals `permission_resolved` so all surfaces dismiss the prompt.

**Status:** derived from the stream — tool/assistant activity → `Busy`, `permission_request` → `Waiting`, `turn_completed` → `Idle`. `kanna-hook` is not involved for agent sessions.

**Lifecycle:** the provider process stays alive between turns. If it exits (crash, budget, max turns), `session_ended` is journaled; the next `AgentInput` transparently respawns the provider with its resume mechanism and the captured provider session id. The composer never dead-ends.

**Handoff:** `HandoffSession` gains a session-kind field; pipe fds transfer via SCM_RIGHTS exactly like PTY master fds; the new daemon reloads the journal from disk and resumes appending. All seven daemon invariants hold for agent sessions.

### 3. Kanna Stream Protocol (KSP) and kanna-server

**One multiplexed WebSocket per client.** All streams and requests for all tasks ride a single connection with task-tagged JSON frames. This keeps the relay tunnel to exactly one paired socket per client.

**Client → server frames:** `auth { credential }` · `attach { task_id, kind: "agent" | "terminal", from_seq }` · `detach { task_id }` · `agent_input { task_id, text }` · `agent_permission { task_id, request_id, decision }` · `agent_interrupt { task_id }` · `term_input { task_id, data_b64 }` · `term_resize { task_id, cols, rows }` · `request { id, method, path, body }` (task API: list/create/close/advance-stage/input — replaces both REST calls and the relay `Invoke` vocabulary).

**Server → client frames:** `auth_ok` · `attached { task_id, last_seq }` · `agent_event { task_id, seq, event }` · `term_snapshot` · `term_output` · `status_changed` · `response { id, status, body }` · `error { code, message }`.

`agent_event` payloads are byte-identical to the daemon journal entries; kanna-server fans out without re-interpreting. Terminal (TUI) sessions ride the same connection as `term_*` frames, so raw-terminal tasks work remotely through the same protocol.

**kanna-server** keeps `/v1/status` for discovery/health; everything else moves to KSP frames. It serves KSP on the LAN port and over one outbound tunnel connection to the relay, with identical fan-out code — it cannot tell a LAN client from a tunneled one. Auth: LAN pairing credential or cloud identity token in the same `auth` frame. `kanna-cli task send-input` becomes a KSP `request` frame.

### 4. Relay as tunnel

The relay's API shrinks to: desktop registers (`desktop_id` + secret) and holds a control socket; an authenticated client requests `desktop_id`; the relay opens a paired socket, signals the desktop to dial a matching one, and splices bytes blindly until either side closes. No KSP knowledge on the VM. Existing semantic vocabulary (`RelayMessage::Invoke`/`Event`, `observe_session`, base64 `terminal_output`) is deleted once consumers are migrated.

### 5. Shared client library

A TypeScript package consumed by the Vue desktop app and the React Native mobile app:
- connection strategy: localhost → LAN → tunnel, first that works for the target desktop
- the `auth` handshake
- attach/replay with per-task `last_seq` tracking
- automatic reconnect-with-resume (backoff), idempotent because of seq replay
- generated frame/event types (from the Rust crate)

The desktop app consumes it over localhost WS. Deleted once adopted: the `lib.rs` session event bridge (terminal_output forwarding), `AgentState` + drainer + `agent_next_message` polling in `commands/agent.rs`, `CloudTerminalView` and its bespoke clients, and mobile's `lanTransport` / `relayClient` / `remoteTransport` trio.

### 6. Desktop UI

**`AgentMessageView`** (replaces `AgentView.vue`): one component tree rendering the neutral event stream, with three style variants — **chat bubbles**, **compact log**, **terminal look** — as CSS-level skins over shared structure, all on `--kn-*` tokens (light/dark safe). Style switcher in the view footer; the selection is a global preference in the settings table, switchable live.

**Rendering:** assistant text via `markdown-it`; code via shiki; tool calls as cards with collapsible input/output and tool-aware presentation for common tools (Bash → command + output, Edit/Write → ±-colored line diff, Read → path), generic fallback otherwise; thinking collapsible; turn stats footer; `raw`/`diagnostic` in a collapsed debug section.

**Composer:** plain textarea — Enter sends, Shift+Enter newline, IME-safe, local echo. Sends work mid-run (steering); sent messages render optimistically as pending until the journal echo confirms. **Stop** button (and Esc while composer focused) sends `agent_interrupt`. Input to an ended session triggers resume. Because focus lives in a normal input rather than xterm, terminal-passthrough shortcut filtering does not apply to themed tasks — all Kanna shortcuts work.

**Permission prompts:** inline card with tool name and formatted input preview; **Allow / Allow for session / Deny** (deny carries an optional reason back to the agent). Resolves across all attached clients on `permission_resolved`. Pending permission drives task status `Waiting`.

**Task creation:** `NewTaskModal` gains a display-mode choice — **Themed** (default; available for Claude and Codex) / **Raw terminal** (all providers). Stored in `pipeline_item.agent_type` as `"agent" | "pty"`; the dormant `"sdk"` value retires (never shipped; no migration needed). Activity states (working/unread) derive from KSP `status_changed`. Diff modal, file picker, shell modal, stage advancement, pinning are untouched.

### 7. Mobile

Agent tasks render in a **native message view** (React Native list) over the same generated types and shared client. Native composer (`TextInput`) with Send/Stop and permission Allow/Deny — the largest beneficiary of message-grained input, since per-keystroke roundtrips are worst on phones. Raw-terminal tasks keep the existing xterm WebView, fed by `term_*` frames over the same connection. Mobile ships the **chat style only** initially; other styles are desktop-first.

## Error handling

- **Any link drops** (client↔gateway, gateway↔daemon, tunnel): auto-reconnect with backoff, resume via `attach { from_seq }`. Seq-numbered replay makes recovery idempotent — no lost or duplicated messages.
- **Provider process dies** (crash, budget, max turns): `session_ended` + stderr `diagnostic` events journaled and rendered; next composer send resumes the provider session. No dead-end states.
- **Unparseable provider output:** journaled as `raw`, rendered in the debug section — never silently dropped.
- **Permission races:** first decision wins; others receive `permission_resolved`.
- **Journal disk-write failure:** session continues on the in-memory journal; failure surfaced as a `diagnostic` event and daemon log. Degraded, never silent.

## Testing

- **Adapter fixtures:** captured real CLI output (Claude and Codex) drives translator unit tests in `kanna-agent-protocol`. CI gate: generated TS types must be current.
- **Daemon** (`crates/daemon/tests`, existing handoff-test patterns): a fake-agent script emitting scripted NDJSON tests spawn/attach/replay seq semantics, permission roundtrip, interrupt, crash-resume, journal reload from disk, and handoff with agent sessions — no real CLIs required.
- **Gateway + relay:** KSP frame contract tests; multiplexed fan-out tests; tunnel integration test (pair two sockets, verify blind splice).
- **CLI contract** (`tests/cli-contract`): pin Claude stream-json flags/control protocol and Codex JSON/approval flags.
- **E2E (desktop):** mock-mode — create themed task, events render in all three styles, composer send, permission allow/deny, interrupt, app-reload rehydrates from the journal. Real-mode with the Claude CLI mirroring `real/claude-session`.
- **E2E (mobile):** Appium smoke gains an agent-view path (LAN).

## Sequencing (sub-projects, each with its own implementation plan)

1. **`kanna-agent-protocol`** — neutral schema, ProviderAdapter trait, Claude + Codex adapters, TS type generation, fixture tests.
2. **Daemon agent sessions** — SpawnAgent/AttachAgent/journal/permissions/interrupt/resume/handoff + daemon tests.
3. **KSP + desktop adoption** — KSP in kanna-server; desktop app becomes a localhost gateway client for both agent streams and PTY terminal (`term_*`) frames; `AgentMessageView` (3 styles), composer, permission UI; NewTaskModal changes. *Feature is usable locally end-to-end after this phase.* Legacy deleted here: app-process agent code (`AgentState`, drainer, polling) and the `lib.rs` session event bridge.
4. **Relay as tunnel + remote desktop** — tunnel rebuild on the relay VM, desktop remote viewing via KSP-through-tunnel. Relay semantic vocabulary deleted here.
5. **Mobile adoption** — shared client + native agent view + composer; dual mobile transports deleted here.

Each phase leaves the system working; later phases delete the legacy they obsolete. Per the repo's E2E expectation, any phase that can't yet get end-to-end coverage documents why and what narrower tests cover it in its plan.

## Out of scope

- End-to-end encryption over the tunnel (enabled by the dumb relay; future project)
- Copilot / OpenCode themed adapters
- Live switching of a running task between TUI and themed mode
- Compact-log / terminal-look styles on mobile
- Per-task style overrides (style preference is global)
