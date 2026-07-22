# Provider-Neutral Revision Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume review revisions in the target stage's existing workspace for every provider with a recorded, supported session handle, falling back to a numbered fresh workspace only when resumption is unavailable.

**Architecture:** Replace the Claude-only session binding with a provider-neutral binding consumed by the Rust provider command builder. Generalize revision eligibility around provider capabilities and provider-specific validation, and persist asynchronously discovered session IDs into the stage run that owns them. Keep `RunWorkspaceSpec::Resume` as the workspace adoption boundary and retain the existing fresh-fork fallback.

**Tech Stack:** Rust, Tokio daemon protocol, SQLite/rusqlite, Cargo tests

---

## File Structure

- `crates/kanna-server/src/task_creator/commands.rs` — provider-native initial/resume CLI syntax.
- `crates/kanna-server/src/task_creator/mod.rs` — provider-neutral session binding through PTY and headless prepared spawns.
- `crates/kanna-server/src/task_creator/types.rs` — carry a headless resume handle to daemon spawn construction.
- `crates/kanna-server/src/task_creator/stages.rs` — provider-neutral revision eligibility and workspace adoption.
- `crates/kanna-server/src/task_creator/resume.rs` — provider-specific resume prerequisites.
- `crates/kanna-server/src/task_creator/tests/core.rs` — command construction tests.
- `crates/kanna-server/src/task_creator/tests/revision.rs` — end-to-end preparation and fallback tests.
- `crates/kanna-server/src/db/stage_runs.rs` and `crates/kanna-server/src/db/tests.rs` — persist a provider handle on its owning run.
- `crates/daemon/src/protocol.rs` and `crates/daemon/src/agent_runtime/readers.rs` — publish newly discovered headless provider handles.
- `crates/daemon/src/agent_runtime/commands.rs` — start a headless provider through `resume_spawn` when requested.
- `crates/kanna-server/src/terminal_watcher.rs` — consume provider-handle and Codex exit metadata before completion filtering.
- `crates/kanna-tool-catalog/src/catalog.json` — describe capability-driven revision resume.
- `packages/db/src/schema.ts` — remove Claude-only schema commentary.

### Task 1: Provider-neutral command bindings

**Files:**
- Modify: `crates/kanna-server/src/task_creator/commands.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/types.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/daemon/src/protocol.rs`
- Modify: `crates/daemon/src/agent_runtime/commands.rs`
- Test: `crates/kanna-server/src/task_creator/tests/core.rs`

- [ ] **Step 1: Write failing provider command tests**

Add table-driven assertions that pass `ProviderSessionBinding::Resume("resume-id".into())` to `build_agent_command` and expect:

```rust
[
    (AgentProvider::Claude, "--resume 'resume-id'"),
    (AgentProvider::Codex, "'codex' resume "),
    (AgentProvider::Opencode, "run --interactive --session 'resume-id'"),
    (AgentProvider::Copilot, "--resume='resume-id'"),
    (AgentProvider::Antigravity, "--conversation 'resume-id'"),
]
```

Also assert that Copilot `Assign` emits `--session-id='assigned-id'`, and that a prepared non-Claude resume retains `provider_session_id`.

- [ ] **Step 2: Run tests to verify RED**

Run: `cargo test -p kanna-server build_agent_command_resumes_supported_providers`

Expected: FAIL because only `ClaudeSessionBinding` exists and non-Claude builders ignore it.

- [ ] **Step 3: Implement the generic binding**

Replace the Claude-only type with:

```rust
pub(super) enum ProviderSessionBinding {
    Assign(String),
    Resume(String),
}

impl ProviderSessionBinding {
    fn session_id(&self) -> &str {
        match self {
            Self::Assign(id) | Self::Resume(id) => id,
        }
    }
}
```

Update each provider branch to render its native syntax. Rename `claude_resume` parameters in `task_creator/mod.rs` to `resume_session_id`; for PTY sessions assign fresh IDs to Claude and Copilot, resume any supported provider when a handle is supplied, and return the binding's ID as `provider_session_id`.

Add `resume_session_id: Option<String>` to `PreparedSessionSpawn::Agent` and `AgentSpawnParams`, with serde defaults for protocol compatibility. In `spawn_agent_session`, choose the adapter entrypoint explicitly:

```rust
let mut spec = match params.resume_session_id.as_deref() {
    Some(id) => adapter.resume_spawn(&ctx, id, &params.prompt),
    None => adapter.initial_spawn(&ctx),
};
```

Return the requested resume ID as the prepared run's `provider_session_id`. Headless resume is allowed only for the existing headless-capable providers (Claude, Codex, and OpenCode); Copilot and Antigravity remain PTY-only.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `cargo test -p kanna-server build_agent_command_`

Expected: all provider command tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/kanna-server/src/task_creator/commands.rs crates/kanna-server/src/task_creator/mod.rs crates/kanna-server/src/task_creator/types.rs crates/kanna-server/src/task_creator/lifecycle.rs crates/kanna-server/src/task_creator/tests/core.rs crates/daemon/src/protocol.rs crates/daemon/src/agent_runtime/commands.rs
git commit -m "feat(server): generalize provider session commands"
```

### Task 2: Provider-neutral revision preparation

**Files:**
- Modify: `crates/kanna-server/src/task_creator/stages.rs`
- Modify: `crates/kanna-server/src/task_creator/resume.rs`
- Test: `crates/kanna-server/src/task_creator/tests/revision.rs`

- [ ] **Step 1: Write failing revision resume tests**

Refactor the existing resume fixture to accept a provider and session type. Add cases for Codex, OpenCode, Copilot, and Antigravity with a seeded `provider_session_id`, and assert:

```rust
assert_eq!(prepared.agent_provider, provider);
assert!(prepared.forked_workspace().is_none());
assert_eq!(prepared.resumed_workspace().unwrap().branch, "task-impl");
assert_eq!(prepared.provider_session_id.as_deref(), Some("provider-session"));
assert_eq!(prepared.resumed_from_run_id.as_deref(), Some("run-impl"));
```

Keep a separate Claude test proving a missing cwd-scoped transcript falls back to `forked_workspace()`.

- [ ] **Step 2: Run tests to verify RED**

Run: `cargo test -p kanna-server request_revision_resumes_supported_provider_session`

Expected: FAIL because `prepare_revision_resume` rejects every provider except Claude.

- [ ] **Step 3: Generalize eligibility and validation**

Add a provider capability helper:

```rust
fn provider_supports_resume(provider: &str) -> bool {
    matches!(provider, "claude" | "codex" | "opencode" | "copilot" | "antigravity")
}
```

Retain the existing worktree/tip checks for all providers. Run `claude_transcript_exists` only for Claude. Pass the prior run's provider handle through `RunWorkspaceSpec::Resume`, then require the prepared provider and returned session ID to match the prior run before accepting the resume.

- [ ] **Step 4: Run revision tests to verify GREEN**

Run: `cargo test -p kanna-server task_creator::tests::revision`

Expected: all revision tests pass, including fresh-fork fallbacks.

- [ ] **Step 5: Commit**

```bash
git add crates/kanna-server/src/task_creator/stages.rs crates/kanna-server/src/task_creator/resume.rs crates/kanna-server/src/task_creator/tests/revision.rs
git commit -m "feat(server): resume revisions across providers"
```

### Task 3: Persist discovered provider session handles

**Files:**
- Modify: `crates/daemon/src/protocol.rs`
- Modify: `crates/daemon/src/agent_runtime/readers.rs`
- Modify: `crates/kanna-server/src/db/stage_runs.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/terminal_watcher.rs`
- Test: `crates/daemon/src/tests.rs`
- Test: `crates/kanna-server/src/terminal_watcher.rs`

- [ ] **Step 1: Write failing persistence tests**

Add a DB test that inserts two runs sharing one daemon session ID, updates the completed run's missing provider handle, and asserts the newer running run remains untouched. Add a terminal watcher test proving a killed Codex exit persists its `resume_session_id` to the completed run before replacement filtering. Add a daemon protocol test for a new provider-session event.

- [ ] **Step 2: Run tests to verify RED**

Run: `cargo test -p kanna-server provider_session_id` and `cargo test -p kanna-daemon provider_session`

Expected: FAIL because killed exits are discarded and the daemon does not publish headless handle discovery.

- [ ] **Step 3: Add the owning-run update**

Add DB methods that update the latest matching run with a missing handle:

```sql
UPDATE stage_run
SET provider_session_id = ?
WHERE id = (
  SELECT id FROM stage_run
  WHERE session_id = ? AND provider_session_id IS NULL
    AND (? = 0 OR status != 'running')
  ORDER BY datetime(started_at) DESC, id DESC
  LIMIT 1
)
```

Use the completed-only mode for orchestrated kills and the general mode for natural exits or live headless discovery.

- [ ] **Step 4: Publish and consume live headless handles**

Add a backward-compatible daemon event:

```rust
ProviderSessionChanged {
    session_id: String,
    provider_session_id: String,
}
```

Broadcast it only when `agent_runtime::readers` observes a newly changed non-empty ID. In `terminal_watcher`, update both the owning stage run and the current pipeline item for live discovery. For `Exit`, persist a non-empty Codex `resume_session_id` to the owning run before the `replaced || killed` early return; update the pipeline item only for non-replacement exits.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run: `cargo test -p kanna-server provider_session_id` and `cargo test -p kanna-daemon provider_session`

Expected: all persistence and protocol tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/daemon/src/protocol.rs crates/daemon/src/agent_runtime/readers.rs crates/daemon/src/tests.rs crates/kanna-server/src/db/stage_runs.rs crates/kanna-server/src/db/tests.rs crates/kanna-server/src/terminal_watcher.rs
git commit -m "fix(server): retain resumable provider handles"
```

### Task 4: Align public contract and verify

**Files:**
- Modify: `crates/kanna-tool-catalog/src/catalog.json`
- Modify: `packages/db/src/schema.ts`
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/types.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`

- [ ] **Step 1: Update provider-neutral wording**

Describe `kanna_request_revision` as resuming any supported recorded provider session in its prior workspace, with a fresh numbered workspace fallback. Replace comments that equate provider session IDs exclusively with Claude UUIDs.

- [ ] **Step 2: Run formatting and focused suites**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kanna-server task_creator::tests::revision
cargo test -p kanna-server provider_session_id
cargo test -p kanna-daemon provider_session
cargo test -p kanna-tool-catalog
```

Expected: formatting check and all focused suites pass.

- [ ] **Step 3: Run canonical Rust verification**

Run: `./kd test rust`

Expected: the canonical Rust suite passes.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check && git status --short && git log --oneline --max-count=6`

Expected: no whitespace errors; only planned files differ from the approved design baseline.

- [ ] **Step 5: Commit contract updates if dirty**

```bash
git add crates/kanna-tool-catalog/src/catalog.json packages/db/src/schema.ts crates/kanna-server/src/db/mod.rs crates/kanna-server/src/task_creator/types.rs crates/kanna-server/src/task_creator/lifecycle.rs
git commit -m "docs: describe provider-neutral revision resume"
```
