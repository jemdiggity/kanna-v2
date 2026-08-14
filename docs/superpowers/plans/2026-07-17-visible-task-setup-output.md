# Visible Task Setup Output Implementation Plan

> **For agentic workers:** Execute the steps in order with `superpowers:test-driven-development`; this is one tightly coupled Rust task, so keep execution in the current worktree rather than delegating it.

**Goal:** Show new PTY task setup commands and live output in the agent terminal before the agent starts, while preserving headless task setup behavior.

**Architecture:** Split initial task preparation by session type. Headless requests continue to execute setup on the server before resolving an absolute provider executable. PTY requests with setup bind the first configured provider immediately and pass setup into the existing daemon PTY bootstrap shell, which prints and executes setup before launching the provider in the same shell and scrollback. Setup-free PTY requests retain ordered availability fallback.

**Tech Stack:** Rust, Tokio, kanna-server task creator, kanna-daemon PTY test utility, Cargo tests

**Stage constraint:** Do not commit during this implementation stage; Kanna's later workflow stage owns commits.

---

### Task 1: Specify Initial PTY Setup Deferral

**Files:**
- Modify: `crates/kanna-server/src/task_creator/tests/setup.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`

- [ ] **Step 1: Add a failing PTY integration test**

Add `initial_pty_task_streams_setup_before_starting_setup_created_provider` beside the existing initial-headless setup test. Create a repository whose setup command prints a unique sentinel and installs a fake Codex executable in the configured workspace `PATH`. Prepare a PTY task and assert:

- the provider executable does not exist immediately after preparation;
- the prepared shell command includes the setup command and `Running startup...`;
- spawning that prepared PTY produces the setup sentinel before the provider sentinel; and
- the setup-created provider runs successfully.

- [ ] **Step 2: Change the custom-setup contract assertion to the desired behavior**

Update `prepare_task_persists_create_spawn_options_and_custom_setup` so it expects `.kanna/custom-setup-ran` to be absent after preparation and expects the PTY shell command to contain the custom setup command. Keep the spawn-option assertions unchanged.

- [ ] **Step 3: Add a failing provider-precedence test**

Add a focused test with candidates `claude,codex` and setup that installs only Codex. Assert that PTY preparation binds Claude, includes setup in the PTY command, and does not execute setup eagerly. This specifies deterministic pre-setup provider precedence.

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```bash
cargo test -p kanna-server task_creator::tests::setup::initial_pty_task_streams_setup_before_starting_setup_created_provider -- --exact --nocapture
cargo test -p kanna-server task_creator::tests::core::prepare_task_persists_create_spawn_options_and_custom_setup -- --exact --nocapture
cargo test -p kanna-server task_creator::tests::setup::initial_pty_task_binds_first_provider_before_setup -- --exact --nocapture
```

Expected: FAIL because current new-task preparation executes setup synchronously and chooses the first provider available afterward.

### Task 2: Defer Initial PTY Setup into the Daemon Shell

**Files:**
- Modify: `crates/kanna-server/src/task_creator/mod.rs`

- [ ] **Step 1: Implement the session-type split in `prepare_new_task_session`**

Use the normalized requested session type to distinguish headless requests from PTY/default requests:

- For headless requests, retain `run_workspace_setup_commands`, post-setup availability selection across provider candidates, and absolute executable resolution through `build_prepared_session` with an empty setup list.
- For PTY/default requests with setup, select the first configured provider, validate it as PTY-compatible, skip `run_workspace_setup_commands`, and pass the complete setup list into `build_prepared_session`.
- For setup-free PTY/default requests, preserve the existing ordered availability selection and direct executable launch.

Keep terminal geometry handling and persisted provider/session bindings unchanged.

- [ ] **Step 2: Run the focused tests and verify GREEN**

Run the three commands from Task 1.

Expected: PASS. The PTY integration output includes the startup banner, setup sentinel, and provider sentinel in that order; the headless setup fixture remains unchanged.

- [ ] **Step 3: Run setup-path regression tests**

Run:

```bash
cargo test -p kanna-server task_creator::tests::setup -- --nocapture
cargo test -p kanna-server task_creator::tests::core::prepare_task -- --nocapture
```

Expected: PASS, including the existing initial-headless setup and stage-fork setup coverage.

### Task 3: Verify the Server Boundary

**Files:**
- Verify: `crates/kanna-server/src/task_creator/mod.rs`
- Verify: `crates/kanna-server/src/task_creator/tests/setup.rs`
- Verify: `crates/kanna-server/src/task_creator/tests/core.rs`

- [ ] **Step 1: Format and run the full server test target**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kanna-server
```

Expected: formatting and all `kanna-server` tests PASS.

- [ ] **Step 2: Run repository-level Rust verification if focused checks are green**

Run:

```bash
./kd test rust
```

Expected: canonical Rust verification PASS. If an unrelated pre-existing failure occurs, capture the exact command and failure without changing unrelated code.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
git diff -- crates/kanna-server/src/task_creator/mod.rs crates/kanna-server/src/task_creator/tests/setup.rs crates/kanna-server/src/task_creator/tests/core.rs docs/superpowers/specs/2026-07-17-visible-task-setup-output-design.md docs/superpowers/plans/2026-07-17-visible-task-setup-output.md
```

Expected: only the approved setup-output design, implementation plan, focused tests, and task-creator behavior are changed.
