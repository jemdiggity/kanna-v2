# Agent Task Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class agent task control through `kanna-server`, with CLI and MCP frontends plus a QA review workflow.

**Architecture:** Implement task-control operations in `kanna-server` and expose them over HTTP. Update `kanna-cli` to call those routes, and add `kanna-cli mcp serve` as a stdio JSON-RPC bridge for MCP tools. Add repo-local QA workflow and review agent definitions.

**Tech Stack:** Rust, Axum, Tokio, serde, reqwest, SQLite via rusqlite, Kanna workflow JSON, MCP-compatible JSON-RPC over stdio.

---

### Task 1: Server Task-Control Contract

**Files:**
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/src/http_api.rs`
- Test: `crates/kanna-server/src/http_api.rs`

- [ ] Add request/response types for `complete_stage` and `request_revision`.
- [ ] Add route tests that fail because the routes do not exist.
- [ ] Implement `POST /v1/tasks/{task_id}/actions/complete-stage`.
- [ ] Implement `POST /v1/tasks/{task_id}/actions/request-revision`.
- [ ] Run `cargo test -p kanna-server`.

### Task 2: Server Revision Orchestration

**Files:**
- Modify: `crates/kanna-server/src/task_creator.rs`
- Modify: `crates/kanna-server/src/db.rs`
- Test: `crates/kanna-server/src/task_creator.rs`

- [ ] Add tests proving revision tasks start from the reviewed branch and target the requested stage.
- [ ] Extract a reusable stage-task preparation helper that can target any stage.
- [ ] Use the helper from both forward advance and request revision.
- [ ] Close the source task only after the replacement task spawns.
- [ ] Run `cargo test -p kanna-server task_creator`.

### Task 3: CLI Frontend

**Files:**
- Modify: `crates/kanna-cli/src/main.rs`

- [ ] Add tests for request payloads and server URL resolution.
- [ ] Change `stage-complete` to prefer `kanna-server`.
- [ ] Add `task request-revision`.
- [ ] Preserve direct DB/socket fallback only when no server URL is available.
- [ ] Run `cargo test -p kanna-cli`.

### Task 4: MCP Stdio Frontend

**Files:**
- Modify: `crates/kanna-cli/src/main.rs`

- [ ] Add tests for MCP `initialize`, `tools/list`, and `tools/call`.
- [ ] Implement `kanna-cli mcp serve`.
- [ ] Expose `complete_stage`, `request_revision`, `advance_stage`, and `create_task` tools.
- [ ] Route tool calls through the same HTTP client helpers as CLI commands.
- [ ] Run `cargo test -p kanna-cli`.

### Task 5: QA Workflow

**Files:**
- Create: `.kanna/agents/review/AGENT.md`
- Create: `.kanna/workflows/qa.json`

- [ ] Add review agent instructions for test sufficiency and E2E expectations.
- [ ] Add QA workflow definition.
- [ ] Validate the workflow JSON through existing parser tests or a focused command.

### Task 6: Verification

**Files:**
- Modify as needed based on compile failures.

- [ ] Run `cargo test -p kanna-server`.
- [ ] Run `cargo test -p kanna-cli`.
- [ ] Run `cargo clippy -p kanna-server --all-targets -- -D warnings`.
- [ ] Run `cargo clippy -p kanna-cli --all-targets -- -D warnings`.

