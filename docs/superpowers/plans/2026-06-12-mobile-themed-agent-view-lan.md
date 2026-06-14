# Mobile Themed Agent View LAN Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement phase 5 LAN-only mobile adoption for themed agent tasks.

**Architecture:** Server task creation accepts `agentType` and spawns either a PTY daemon session or a headless daemon agent session. Mobile task summaries include `agentType`; the controller routes `agent` tasks to a native React Native event view backed by `@kanna/stream-client` on `ws://host:port/v1/stream`, while `pty` tasks keep the existing terminal WebView and legacy LAN/relay terminal path.

**Tech Stack:** Rust axum/kanna-server, kanna-cli clap/reqwest, React Native, TypeScript, `@kanna/agent-protocol`, `@kanna/stream-client`, Vitest/Appium.

---

### Task 1: Server And CLI Agent-Type Creation

**Files:**
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/src/task_creator.rs`
- Modify: `crates/kanna-cli/src/main.rs`

- [ ] Add failing Rust tests proving `CreateTaskRequest.agent_type` serializes as `agentType`, defaults to `agent` for Claude/Codex, keeps PTY for Copilot/OpenCode, and sends `SpawnAgent` for agent tasks.
- [ ] Run `cargo test -p kanna-server -p kanna-cli` and confirm the new tests fail because `agent_type` is missing and server creation always emits `Spawn`.
- [ ] Add an `AgentSessionKind`/`PreparedSessionSpawn` split in `task_creator.rs`; keep DB/worktree/terminal_session creation shared, set `pipeline_item.agent_type` to the resolved kind, and build `DaemonCommand::SpawnAgent { session_id, params }` for agent tasks with the same prompt/model/permission/allowed_tools env semantics as desktop `spawn_agent_session`.
- [ ] Add `agent_type` to `CreateTaskRequest`, `TaskCreateOptions`, the `task create --agent-type <pty|agent>` clap command, and JSON request building.
- [ ] Run focused server/CLI tests until green, then commit.

### Task 2: Mobile Types, LAN KSP Stream, And Store State

**Files:**
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify: `apps/mobile/src/lib/api/client.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`

- [ ] Add failing TypeScript tests showing LAN task summaries preserve `agentType`, LAN transport exposes an agent stream subscription over `/v1/stream`, and the controller does not start `observeTaskTerminal` for `agent` tasks.
- [ ] Run the focused mobile tests and confirm they fail.
- [ ] Add mobile API types for `agentType`, agent stream events, permission decisions, and agent stream subscriptions.
- [ ] Implement LAN `observeTaskAgent` using `StreamClient.attachAgent`, `sendAgentInput`, `sendAgentPermission`, and `sendAgentInterrupt`, deriving the WS URL from the current LAN base URL.
- [ ] Add session store state/actions for agent events, status, and errors without removing the terminal state.
- [ ] Update the mobile controller to start/stop agent streams for `agent` tasks and terminal streams for all others; agent input uses message text, PTY input keeps the bracketed paste encoding.
- [ ] Run focused mobile tests until green, then commit.

### Task 3: Native Mobile Agent Message View

**Files:**
- Create: `apps/mobile/src/screens/AgentMessageView.tsx`
- Create: `apps/mobile/src/screens/AgentMessageView.test.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/e2eTestIds.ts`

- [ ] Add failing component tests proving `agent` tasks render native chat messages/tool cards/permission cards/debug details and do not render `TerminalWebView`.
- [ ] Run the focused component tests and confirm they fail.
- [ ] Implement `AgentMessageView` as chat-style React Native UI over neutral `AgentEvent` entries with user/assistant bubbles, collapsible tool/thinking/debug sections, permission buttons, turn stats, Send, and Stop.
- [ ] Route `TaskScreen` by `task.agentType === "agent"` and wire composer/permission/interrupt callbacks.
- [ ] Run focused component tests until green, then commit.

### Task 4: E2E Smoke And Full Verification

**Files:**
- Modify: `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts`
- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Modify or create: focused Appium helper tests if needed.

- [ ] Extend the Appium smoke to treat either the terminal WebView becoming live or the agent message view appearing as a valid opened task path; add a narrower unit test for the selector logic if the live smoke cannot force an agent task reliably.
- [ ] Run `cargo fmt`, `cargo clippy`, `cargo test -p kanna-server -p kanna-cli`, `pnpm --dir apps/mobile exec tsc --noEmit`, `pnpm --dir packages/stream-client exec tsc --noEmit`, and `pnpm test`.
- [ ] If Appium cannot be run locally, document the reason and the narrower coverage in the final response.
- [ ] Commit final verification/E2E updates.

