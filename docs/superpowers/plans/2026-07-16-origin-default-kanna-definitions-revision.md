# Origin-default Kanna Definitions Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore environment precedence, repo-config parser compatibility, and desktop definition-failure isolation without changing the origin-default definition architecture.

**Architecture:** Centralize server spawn environment layering, normalize repo config from JSON values with TypeScript-equivalent rules, and split authoritative snapshot publication from optional manifest enrichment. New Task owns manifest failure presentation through the existing toast service while remaining usable.

**Tech Stack:** Rust, Serde/serde_json, Axum integration tests, Vue 3, Pinia, Vitest, Vue Test Utils.

---

### Task 1: Lock down spawn environment precedence

**Files:**
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`
- Modify: `crates/kanna-server/src/task_creator/environment.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`

- [x] Extend `task_creation_uses_one_remote_default_branch_definition_context` with conflicting remote `workspace.env` values for the claimed port and Kanna runtime keys, plus workspace PATH entries.
- [x] Run `cargo test -p kanna-server task_creation_uses_one_remote_default_branch_definition_context -- --nocapture` and confirm the new assertions fail because workspace values currently overwrite authoritative values.
- [x] Replace split `build_spawn_env` plus `apply_workspace_config_env` call-site assembly with a single builder that accepts the worktree and repo config, then applies base, workspace env, workspace path, ports, and runtime metadata in order.
- [x] Make `write_kanna_mcp_config` receive the authoritative server URL explicitly and update every task/session call path.
- [x] Re-run the focused task-creation test and confirm it passes.

### Task 2: Restore repo-config normalization parity

**Files:**
- Modify: `crates/kanna-server/src/task_creator/definitions.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`
- Modify: `crates/kanna-server/src/http_api/tests/repo_definitions.rs`

- [x] Replace the semantic-type-failure expectation with table-driven parity cases covering `test`, `stage_order`, mixed `ports`/`flavors`/`vars`, and `workspace.env/path` values.
- [x] Add an HTTP manifest assertion that valid siblings survive malformed optional fields and invalid map entries are omitted.
- [x] Run the focused Rust tests and confirm direct Serde decoding fails them.
- [x] Add a `parse_repo_config` normalizer over `serde_json::Value` that mirrors `parseRepoConfig`, leaving syntax errors fatal.
- [x] Route `RepoDefinitions::resolve_path` through the normalizer and re-run the focused parser/HTTP tests.

### Task 3: Isolate desktop manifest failures

**Files:**
- Modify: `apps/desktop/src/stores/kanna.querySnapshot.test.ts`
- Modify: `apps/desktop/src/composables/useAppTaskCreation.test.ts`
- Modify: `apps/desktop/src/App.test.ts`
- Modify: `apps/desktop/src/stores/queries.ts`
- Modify: `apps/desktop/src/composables/useAppTaskCreation.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`

- [x] Change the query regression test to expect authoritative repos/items to publish and the refresh to resolve when one manifest fails.
- [x] Change the composable regression test to expect a visible error toast, cleared pipeline metadata, and an open modal while branch/provider loading continues.
- [x] Add mounted-App integration cases proving a definition failure does not blank rendered task state and New Task opens with a toast.
- [x] Run `pnpm --dir apps/desktop exec vitest run src/stores/kanna.querySnapshot.test.ts src/composables/useAppTaskCreation.test.ts src/App.test.ts` and confirm the new cases fail for the current behavior.
- [x] Publish the snapshot before manifest enrichment, isolate each manifest failure, and handle New Task manifest failure inside the composable.
- [x] Re-run the focused desktop tests and confirm they pass.

### Task 4: Full verification and review

**Files:**
- Review all files changed above.

- [x] Run the reviewer-requested focused desktop and Rust tests.
- [x] Run `pnpm test`.
- [x] Run `cd crates/daemon && cargo test -- --test-threads=1`, treating only the documented unrelated timeout as baseline if it reproduces and confirming the test alone.
- [x] Run `cargo test -p kanna-server`.
- [x] Run formatting/type checks required by changed files, inspect `git diff --check`, and review the final diff for unrelated changes.
