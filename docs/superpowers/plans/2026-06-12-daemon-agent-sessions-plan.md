# Phase 2 Implementation Plan — Daemon Agent Sessions

**Spec:** `docs/superpowers/specs/2026-06-12-themed-agent-view-design.md` (sequencing step 2 of 5)
**Goal:** the daemon owns headless agent sessions: spawn via provider adapters, translate + journal neutral events, attach/replay by seq, permissions, interrupt, crash-resume, handoff.

## Design decisions

- **Separate subsystem.** Agent sessions live in a new `crates/daemon/src/agent.rs` with their own registry, not inside `SessionManager` — PTY paths stay untouched. `List` merges both registries; `Kill`/`Signal` dispatch on kind.
- **One lock per agent session guards journal + attached writers** so attach-snapshot-then-stream is atomic against concurrent appends (the agent analog of `finish_attach_cutover`).
- **Provider session id lives on the daemon record**, refreshed from the adapter after each parse batch — survives handoff in `HandoffSession` without widening the adapter trait.
- **Adopted agent sessions restart their reader immediately** (unlike adopted PTY sessions, which wait for first `AttachSnapshot`): the journal must capture output while detached; there is no emulation-handshake reason to delay.
- **`AllowSession` is a daemon-side auto-approval rule** keyed by tool name; matching future `permission_request`s are answered immediately and journaled as request+resolved pairs without ever surfacing `Waiting`.
- **Status derivation from the stream:** `ToolCall`/`AssistantText`/`Thinking`/`TurnStarted` → Busy, `PermissionRequest` → Waiting, `TurnCompleted`/`SessionEnded` → Idle. Emitted as existing `StatusChanged` events. No `kanna-hook` involvement.
- **Resume-respawn:** if the child has exited, the next `AgentInput` respawns via `adapter.resume_spawn(ctx, provider_session_id, text)`. Codex (`TurnModel::PerTurn`) takes this path for every message. The daemon journals `UserMessage` itself at spawn/input time (providers do not echo plain user input).

## Tasks

1. **Protocol additions** (`protocol.rs`, daemon depends on `kanna-agent-protocol`):
   - `SessionKind { Pty, Agent }` (`#[serde(default)]` Pty everywhere for handoff compat)
   - Commands: `SpawnAgent { session_id, cwd, env, agent_provider, prompt, model?, permission_mode?, allowed_tools, max_turns?, max_budget_usd?, system_prompt?, executable? }` · `AttachAgent { session_id, from_seq }` · `AgentInput { session_id, text }` · `AgentPermission { session_id, request_id, decision }` · `AgentInterrupt { session_id }`
   - Events: `AgentSnapshot { session_id, last_seq, events: Vec<SeqAgentEvent> }` · `AgentEvent { session_id, seq, event }`
   - `ErrorCode`: `AgentSpawnFailed`, `NotAgentSession`, `UnknownPermissionRequest`
   - `HandoffSession`: `kind`, `provider_session_id`, `agent_fd_count` fields
   - `SessionInfo`: `kind` field
2. **`agent.rs`:** `AgentJournal` (memory + NDJSON file under `<daemon-data>/agent-journals/{id}.ndjson`, load-on-open, append→seq, `events_from`), `AgentSessionRecord`, registry, spawn (pipes + `setsid`, write `initial_stdin` or close stdin), stdout/stderr reader threads → translate → journal → fan out to attached writers + `Subscribe` broadcast, status updates, input/resume, interrupt, permission answer + auto-allow rules, kill.
3. **Dispatch** in `main.rs` `handle_command` for the five new commands; `List`/`Kill`/`Signal` handle agent sessions; `SessionCreated` broadcast on spawn.
4. **Handoff:** old daemon sends `HandoffSession{kind: Agent, …}` + `[stdout, stderr, stdin]` fds via existing `send_fds`; new daemon adopts, reopens journal from disk, restarts readers immediately.
5. **Tests** (`crates/daemon/tests/agent_sessions.rs`, fake-agent shell scripts emitting claude-shaped NDJSON, `--test-threads=1` like existing daemon tests):
   - spawn → attach(0) → snapshot + live events; journal file persisted
   - attach with `from_seq` replays only the tail
   - input mid-session reaches stdin; input after exit respawns with resume args
   - permission request → Waiting status → `AgentPermission` allow → response on stdin → `permission_resolved` journaled; `AllowSession` auto-answers the second request
   - interrupt: stdin-line for claude adapter path
   - handoff: spawn agent session, restart daemon, journal + live stream resume (mirrors existing handoff test patterns)
6. **Gates:** clippy, fmt, daemon tests single-threaded, workspace check.

## Out of scope (phase 3+)
Tauri/app integration, kanna-server attach, UI. The existing `Observe` raw-byte path stays PTY-only; agent observers use `AttachAgent` in phase 3/4.
