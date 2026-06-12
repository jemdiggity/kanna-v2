# Phase 3 Implementation Plan — Kanna Stream Protocol + Desktop Adoption

**Spec:** `docs/superpowers/specs/2026-06-12-themed-agent-view-design.md` (sequencing step 3 of 5)
**Goal:** the feature becomes usable locally end-to-end: kanna-server exposes the Kanna Stream Protocol (KSP), the desktop app consumes it as a localhost gateway client, and themed tasks render in `AgentMessageView` with composer + permission UI.

## Sub-sequence (each lands green)

### 3.1 KSP frame schema (Rust source of truth)
- `frames` module in `crates/kanna-agent-protocol`: `ClientFrame` (`auth`, `attach { task_id, kind, from_seq }`, `detach`, `agent_input`, `agent_permission`, `agent_interrupt`, `term_input { data_b64 }`, `term_resize`, `request { id, method, path, body }`) and `ServerFrame` (`auth_ok`, `attached { task_id, next_seq }`, `agent_snapshot`, `agent_event { task_id, seq, event }`, `term_snapshot`, `term_output`, `status_changed`, `session_exit`, `response`, `error`). All ts-rs exported into `packages/agent-protocol`.
- Task-id addressed (not daemon session-id): kanna-server owns the task→session lookup, clients never see daemon ids.

### 3.2 KSP endpoint in kanna-server
- `GET /v1/stream` WebSocket: one multiplexed connection per client; auth frame first (reuse existing LAN auth/pairing model — localhost connections from the owning desktop are implicitly trusted, same trust the existing localhost API grants).
- Attach(agent) proxies daemon `AttachAgent`/`AgentEvent` per connection; inbound frames map to `AgentInput`/`AgentPermission`/`AgentInterrupt`.
- `request` frames route to the existing task API handlers (list/create/input/actions) — REST endpoints stay during the transition; deletion happens when all clients are off them (phase 5).
- Terminal frames (`term_*`) ride the same connection using the existing Observe/Input daemon paths (raw bytes base64). The richer AttachSnapshot/min-size semantics stay on the legacy path until phase 3.6.
- kanna-server spawns themed tasks by sending `SpawnAgent` (task create gains a display-mode/agent_type input).

### 3.3 Shared TS client (`packages/stream-client`)
- `@kanna/stream-client`: connect (WS URL strategy), auth handshake, per-task attach with `from_seq` resume, automatic reconnect with backoff, typed by the generated frame types. Vitest unit tests with a mock WS.

### 3.4 Desktop spawn path for themed tasks
- `NewTaskModal`: display-mode choice — **Themed** (default; enabled for claude + codex providers) / **Raw terminal** (all providers); stored as `pipeline_item.agent_type` `"agent" | "pty"` (the dormant `"sdk"` value retires).
- `tasks.ts` `createItem`: `agent_type === "agent"` spawns via daemon `SpawnAgent` (new Tauri command `spawn_agent_session` forwarding to the daemon), carrying provider, prompt, permission mode, resolved executable.
- Delete the app-process SDK path: `create_agent_session` drainer, `AgentState`, `agent_next_message` polling, `agent_send_message`, `agent_interrupt`, `agent_close_session` in `commands/agent.rs`.

### 3.5 AgentMessageView (replaces AgentView.vue)
- `useAgentStream` composable: attach via stream-client (localhost kanna-server), replay + live events, send input/permission/interrupt; transport-agnostic interface so remote tasks (phase 4) reuse the component unchanged.
- One component tree, three style variants (chat / compact log / terminal look) as CSS-level skins on `--kn-*` tokens; style switcher in footer; global preference in settings.
- markdown-it + shiki rendering, tool cards (Bash/Edit/Write/Read aware, generic fallback), collapsible thinking, turn stats footer, collapsed debug section for raw/diagnostic.
- Composer: Enter sends (mid-run steering), Shift+Enter newline, Stop button → interrupt, send-after-end resumes. Permission card: Allow / Allow for session / Deny with reason. Status drives sidebar working/unread via existing `status_changed`.
- `TerminalTabs.vue` routes `agent_type === "agent"` to the new view.

### 3.6 Local terminal frames over KSP + bridge deletion
- Move PTY viewing for the local app onto KSP `term_*` frames; retire the `lib.rs` session event bridge for terminal output (daemon spawn/reattach coordination stays native).
- This step is mechanical but wide; it may land as its own PR. If deferred, document why in the PR (the bridge stays for PTY only; agent events never touch it).

### 3.7 E2E (per repo expectation)
- Mock-mode e2e: create themed task → events render in all three styles → composer send → permission allow/deny → interrupt → app-reload rehydrates from journal.
- Real-mode e2e mirroring `real/claude-session` with the actual Claude CLI.

## Gates per step
`cargo clippy` / `cargo fmt` / daemon + server tests, `pnpm exec tsc --noEmit`, `pnpm test`, e2e for 3.5+.
