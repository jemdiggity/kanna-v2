# Phase 1 Implementation Plan — `kanna-agent-protocol`

**Spec:** `docs/superpowers/specs/2026-06-12-themed-agent-view-design.md` (sequencing step 1 of 5)
**Goal:** the foundation crate — neutral `AgentEvent` schema, `ProviderAdapter` trait, Claude + Codex adapters, generated TypeScript types, fixture tests. No daemon/UI wiring in this phase.

## Findings that shape the plan

- Codex CLI 0.133.0: `codex exec --json` prints JSONL events; multi-turn is `codex exec resume <session_id> --json`; interactive approvals exist only in the experimental `app-server` mode. **Adapter consequence:** Codex uses a process-per-turn model (each user message spawns `exec resume`), and `permission_request` support is a per-adapter capability — Claude yes (control protocol), Codex no for now (runs under its configured sandbox/approval policy, chosen at task creation). The trait models both.
- Claude CLI: long-lived process, `--input-format stream-json` accepts mid-run user messages; control protocol carries interrupt + `can_use_tool`. `crates/claude-agent-sdk` already has the message/control types — the adapter depends on it rather than duplicating parsing.

## Tasks

### 1. Crate scaffold
- `crates/kanna-agent-protocol/` added to workspace members.
- Deps: serde, serde_json, ts-rs (behind a `typescript` feature), claude-agent-sdk (path).
- **Verify:** `cargo check -p kanna-agent-protocol`.

### 2. Neutral event schema (`src/events.rs`)
- `AgentEvent` enum (serde tag `type`, camelCase): `TurnStarted`, `AssistantText`, `Thinking`, `ToolCall { call_id, tool_name, input }`, `ToolResult { call_id, output, is_error }`, `ToolProgress`, `PermissionRequest { request_id, tool_name, input }`, `PermissionResolved { request_id, decision }`, `TurnCompleted { stats }`, `SessionEnded { code, reason }`, `UserMessage`, `Diagnostic`, `Raw { line }`.
- `TurnStats { duration_ms, cost_usd, turns }`, `PermissionDecision { Allow, AllowSession, Deny { reason } }`.
- Truncation helper: cap text payloads (64 KiB) with explicit `truncated: bool` marker fields where applicable (tool output, raw).
- All types derive `ts(export)`.
- **Verify:** unit tests for serde round-trip + truncation.

### 3. `ProviderAdapter` trait (`src/adapter.rs`)
- `Capabilities { permission_requests: bool, mid_run_input: bool }`.
- `TurnModel { Persistent, PerTurn }` — daemon (phase 2) uses this to decide respawn-per-input.
- `fn initial_spawn(&self, ctx: &SpawnCtx) -> SpawnSpec` and `fn resume_spawn(&self, ctx, session_id, message) -> SpawnSpec` (`SpawnSpec { executable, args, env }`).
- `fn parse_line(&mut self, line: &str) -> Vec<AgentEvent>` — infallible; unrecognized input becomes `Raw`.
- `fn provider_session_id(&self) -> Option<String>` (captured during parsing).
- `fn encode_input(&self, text: &str) -> Option<String>` (stdin line; `None` for PerTurn adapters).
- `fn encode_interrupt(&self) -> InterruptAction` (`StdinLine(String)` for Claude control request, `Signal` for Codex).
- `fn encode_permission_response(&self, request_id, decision) -> Option<String>`.
- **Verify:** compiles; trait object-safe (`Box<dyn ProviderAdapter + Send>`).

### 4. ClaudeAdapter (`src/claude.rs`)
- Spawn: `claude -p <prompt> --output-format stream-json --input-format stream-json --verbose` + permission-mode flag (camelCase values); resume adds `--resume <id>`.
- Parse via `claude-agent-sdk` `Message`/control types → neutral events (assistant content blocks fan out to `AssistantText`/`Thinking`/`ToolCall`; `control_request: can_use_tool` → `PermissionRequest`; `result` → `TurnCompleted`).
- Input encoding: stream-json user message line. Interrupt: control request envelope. Permission response: control response envelope.
- **Verify:** fixture tests (task 6).

### 5. CodexAdapter (`src/codex.rs`)
- Spawn: `codex exec --json <prompt>` (+ `-c` sandbox/approval config from ctx); resume: `codex exec resume <session_id> --json <message>`.
- Parse Codex JSONL events → neutral events; capture session id from the session-start event; unknown events → `Raw`.
- `TurnModel::PerTurn`, `permission_requests: false`, interrupt = `Signal`.
- **Verify:** fixture tests (task 6).

### 6. Fixtures + translator tests (`tests/`)
- Capture real output: run `claude -p` (stream-json) and `codex exec --json` on a trivial prompt in a scratch dir; sanitize; store as `tests/fixtures/claude-*.ndjson`, `tests/fixtures/codex-*.jsonl`.
- Tests: full-fixture translation snapshots; permission roundtrip encoding (Claude); session-id capture (both); garbage lines → `Raw`.
- Add/extend `tests/cli-contract` entries pinning the flags used by both adapters.
- **Verify:** `cargo test -p kanna-agent-protocol`; contract tests pass with installed CLIs.

### 7. TypeScript type generation (`packages/agent-protocol/`)
- ts-rs export task (`cargo test -p kanna-agent-protocol --features typescript export_bindings`) writing to `packages/agent-protocol/src/generated/`.
- Minimal pnpm package (`@kanna/agent-protocol`) re-exporting generated types; consumed later by desktop/mobile.
- Staleness check script (`scripts/check-agent-protocol-types.sh`): regenerate into temp dir, diff against committed output, fail on drift; wire into CI workflow if one runs Rust.
- **Verify:** `pnpm exec tsc --noEmit` in the package; staleness script passes clean and fails on an induced edit.

### 8. Quality gates
- `cargo clippy -p kanna-agent-protocol` clean, `cargo fmt --all`, `pnpm test` unaffected, full `cargo check` workspace.

## Out of scope (later phases)
Daemon `SpawnAgent`/journal (phase 2), KSP/kanna-server/desktop UI (phase 3), relay tunnel (phase 4), mobile (phase 5).

## Deviation from spec (recorded)
Codex themed tasks ship **without** interactive permission prompts (capability-flagged); they rely on Codex's sandbox/approval policy set at creation. Revisit when Codex `app-server` stabilizes.
