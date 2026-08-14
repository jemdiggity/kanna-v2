# Codebase Review QA Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven QA gaps left by the codebase-review remediation while preserving server ownership of persistence and provider resolution.

**Architecture:** `kanna-server` relocates the legacy database before the first SQLite open and remains authoritative for provider-list resolution, capability checks, and repo-scoped executable availability. Desktop clients omit provider overrides when an agent definition owns the ordered candidates, and consume server-reported availability for repo-scoped task creation. Boundary tests spawn the real server/CLI binaries where restart and process behavior matter.

**Tech Stack:** Rust, Axum, rusqlite, Tokio, Vue 3, TypeScript, Vitest, WebDriver E2E, pnpm, kd.

---

### Task 1: Relocate Legacy Databases Before Server Open

**Files:**
- Create: `crates/kanna-server/tests/legacy_database_relocation.rs`
- Modify: `crates/kanna-server/src/config.rs`
- Modify: `apps/desktop/src/stores/db.ts`
- Modify: `apps/desktop/src/stores/db.test.ts`
- Modify: `apps/desktop/src/composables/useBackup.ts`
- Modify: `apps/desktop/src/composables/useBackup.test.ts`

- [ ] Write an executable-level test that creates only `com.kanna.app/kanna-v2.db`, starts `kanna-server`, writes a setting through `PUT /v1/settings/{key}`, stops it, restarts it, and reads the value from the canonical database.
- [ ] Run `cargo test -p kanna-server --test legacy_database_relocation -- --nocapture` and confirm it fails because startup still opens the legacy path.
- [ ] Add a test-isolated app-support-root override and a pre-open relocation helper that creates the canonical directory and renames WAL/SHM before renaming the main DB file.
- [ ] Remove `migrateLegacyDatabaseIfNeeded` and all frontend DB/WAL/SHM copy code and assertions.
- [ ] Re-run the executable test and `pnpm --dir apps/desktop test -- src/stores/db.test.ts src/composables/useBackup.test.ts`.

### Task 2: Preserve Provider Candidates and Enforce Provider Contracts

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/composables/useAppPreferences.ts`
- Modify: `apps/desktop/src/composables/useAppTaskCreation.ts`
- Modify: `apps/desktop/src/composables/useAppTaskCreation.test.ts`
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.ts`
- Modify: `crates/kanna-server/src/task_creator/definitions.rs`
- Modify: `crates/kanna-server/src/task_creator/provider.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`
- Modify: `crates/kanna-server/src/http_api/tests/create_task.rs`
- Modify: `services/firebase-functions/src/types.ts`
- Modify: `services/firebase-functions/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] Add failing desktop tests proving agent-backed setup/custom launches omit `agentProvider`, leaving ordered candidates for the server.
- [ ] Add failing Rust tests for empty, mixed, non-string, and unknown workflow/AGENT provider lists and for Copilot/Antigravity headless rejection before durable state.
- [ ] Add an HTTP/server integration case where the request omits `agentProvider` and an unavailable first agent candidate falls back to the available second candidate.
- [ ] Remove App-level first-provider selection from agent-definition launch paths; keep scalar preference validation local to `useAppPreferences`.
- [ ] Make Rust workflow and YAML frontmatter parsing validate the same non-empty known-provider contract as TypeScript/schema parsing.
- [ ] Make `resolve_agent_type` reject explicit/default headless sessions when `supports_headless` is false before task ID, DB insert, or worktree creation.
- [ ] Import generated `AgentProvider` in Firebase function types and add the workspace dependency.
- [ ] Run focused desktop, core, server, and Firebase type checks.

### Task 3: Make Repo-Scoped Provider Availability Server-Owned

**Files:**
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/http_api/repos.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/composables/useAppModals.ts`
- Modify: `apps/desktop/src/composables/useAppTaskCreation.ts`
- Modify: `apps/desktop/src/components/AppModalLayer.vue`
- Modify: `apps/desktop/src/components/NewTaskModal.vue`
- Modify: `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`

- [ ] Add a failing HTTP test proving a provider executable in a repo `workspace.path.prepend` directory is reported available.
- [ ] Add a server endpoint returning available provider ids for a repo by calling the same executable resolver task creation uses.
- [ ] Fetch that list when opening New Task and pass it to the modal; remove the modal's global-only `which_binary` probing.
- [ ] Retain all-provider fallback only when repo-scoped availability cannot be fetched.
- [ ] Run the focused component/composable/server route tests.

### Task 4: Cover OpenCode Headless Creation in Desktop E2E

**Files:**
- Modify: `apps/desktop/tests/e2e/mock/new-task-modal.test.ts`

- [ ] Add an executable fake OpenCode fixture beside the existing fake Claude CLI.
- [ ] Add a WebDriver test that selects `opencode sdk`, submits the modal, and queries the persisted task.
- [ ] Assert `agent_provider = opencode` and `agent_type = agent`.
- [ ] Start with `./kd dev up`, run `pnpm --dir apps/desktop test:e2e -- mock/new-task-modal.test.ts`, and always stop with `./kd dev down`.

### Task 5: Put Generated Drift Detection on the Canonical Lane

**Files:**
- Modify: `tools/kd/src/runtime/rust-test.ts`
- Modify: `tools/kd/tests/rust-test.test.ts`
- Modify: `tools/kd/tests/ci-workflow.test.ts`

- [ ] Add failing command-plan assertions for `./scripts/check-agent-protocol-types.sh` as the first `./kd test rust` command.
- [ ] Update fail-fast/result accumulation tests for the new command.
- [ ] Assert CI delegates to a Rust plan containing the generated drift check.
- [ ] Run `pnpm --dir tools/kd test -- rust-test.test.ts ci-workflow.test.ts test-orchestration.test.ts` and `./scripts/check-agent-protocol-types.sh`.

### Task 6: Remove Deterministic Shared-State Test Races

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `crates/kanna-server/src/main.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`
- Modify: `crates/kanna-server/src/http_api/tests.rs`
- Modify: `crates/kanna-server/src/http_api/tests/actions.rs`
- Modify: `crates/kanna-server/src/http_api/tests/create_task.rs`

- [ ] Add a test-only scoped environment guard and prove inherited WebDriver/worktree values are restored.
- [ ] Acquire `test_env_lock` around both lib.rs environment-mutating tests.
- [ ] Replace module-local sidecar locks with one crate-level RAII fixture/lock shared by task-creator and HTTP tests.
- [ ] Hold the fixture for every test that creates process-wide `kanna-cli` or `kanna-mcp` files and remove manual cleanup races.
- [ ] Run desktop tests with multiple test threads and kanna-server both serialized and at default concurrency.

### Task 7: Add the Missing CLI Process Contract and Refresh Docs

**Files:**
- Create: `crates/kanna-cli/tests/dependent_tasks_exist.rs`
- Modify: `AGENTS.md`

- [ ] Add a failing executable integration test with a local TCP server, encoded task id, explicit `--server-url`, success exit, empty stderr, and exact JSON stdout.
- [ ] Return the existing camelCase dependent-task response and verify the compiled binary passes the contract.
- [ ] Update the provider inventory to Claude, Copilot, Codex, OpenCode, and Antigravity, including headless capability and `agy` executable notes; remove the stale frontend DB-copy description.
- [ ] Run `cargo test -p kanna-cli --test dependent_tasks_exist` and `git diff --check`.

### Task 8: Complete Verification

- [ ] Run all focused commands listed in the reviewer feedback.
- [ ] Run `pnpm test`.
- [ ] Run `(cd crates/daemon && cargo test -- --test-threads=1)`.
- [ ] Run `cargo test -p kanna-server`.
- [ ] Review `git diff`, run `git diff --check`, and request a final independent code review.

This revision task intentionally does not commit; Kanna's later workflow stage owns the commit.
