# Legacy Database Relocation Test Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the legacy database relocation integration tests safe under Cargo's default parallel test execution, then publish the complete task branch as a pull request.

**Architecture:** Replace the test's PID-and-clock temporary path with an owned `tempfile::TempDir`, preserving the existing `TestRoot` path and explicit-cleanup interface. Production database relocation code remains unchanged; the existing parallel integration suite provides the regression coverage.

**Tech Stack:** Rust 2021, Cargo, `tempfile`, `rusqlite`, Tokio integration tests, pnpm/Turbo, GitHub CLI

---

## File Structure

- Modify `crates/kanna-server/Cargo.toml` to declare the test-only `tempfile` dependency.
- Modify `crates/kanna-server/tests/legacy_database_relocation.rs` so `TestRoot` owns an atomically unique `TempDir`.
- Modify `Cargo.lock` only if Cargo records the new direct development dependency for `kanna-server`.

### Task 1: Replace the Colliding Test Root

**Files:**
- Modify: `crates/kanna-server/Cargo.toml`
- Modify: `crates/kanna-server/tests/legacy_database_relocation.rs:10-118`
- Modify if generated: `Cargo.lock`
- Test: `crates/kanna-server/tests/legacy_database_relocation.rs`

- [ ] **Step 1: Run the existing regression test under normal parallelism and verify RED**

Run:

```bash
cargo test -p kanna-server --test legacy_database_relocation -- --nocapture
```

Expected: FAIL in `canonical_database_wins_and_legacy_state_is_archived_when_both_paths_exist` with `table settings already exists`, and in `legacy_only_database_is_relocated_before_serving_and_persists_after_restart` because the crash writer cannot open the shared database path. This failure has already been reproduced twice; rerun it immediately before the implementation edit for the TDD record.

- [ ] **Step 2: Add the test-only dependency**

Append to `crates/kanna-server/Cargo.toml`:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Replace the hand-built root with an owned TempDir**

In `crates/kanna-server/tests/legacy_database_relocation.rs`, remove `SystemTime` and `UNIX_EPOCH` from the imports and replace `TestRoot`, its `Drop` implementation, and `unique_test_root` with:

```rust
struct TestRoot {
    temp_dir: Option<tempfile::TempDir>,
}

impl TestRoot {
    fn new() -> Self {
        let temp_dir = tempfile::Builder::new()
            .prefix("kanna-server-legacy-relocation-")
            .tempdir()
            .expect("test root should be created");
        Self {
            temp_dir: Some(temp_dir),
        }
    }

    fn path(&self) -> &Path {
        self.temp_dir
            .as_ref()
            .expect("test root should be present")
            .path()
    }

    fn cleanup(&mut self) -> std::io::Result<()> {
        let Some(temp_dir) = self.temp_dir.take() else {
            return Ok(());
        };
        temp_dir.close()
    }
}
```

Rely on `TempDir`'s `Drop` implementation for best-effort unwinding cleanup; do not retain the custom path-based `Drop` implementation.

- [ ] **Step 4: Format the Rust changes**

Run:

```bash
cargo fmt --all
```

Expected: exit 0 with the edited Rust file formatted.

- [ ] **Step 5: Run the regression test and verify GREEN**

Run:

```bash
cargo test -p kanna-server --test legacy_database_relocation -- --nocapture
```

Expected: PASS with 3 passed, 0 failed, and 1 ignored under default parallel execution.

- [ ] **Step 6: Review and commit the focused fix**

Run:

```bash
git diff --check
git diff -- crates/kanna-server/Cargo.toml crates/kanna-server/tests/legacy_database_relocation.rs Cargo.lock
git add crates/kanna-server/Cargo.toml crates/kanna-server/tests/legacy_database_relocation.rs Cargo.lock
git commit -m "test(server): isolate legacy relocation fixtures"
```

Expected: no whitespace errors; the commit contains only the dependency metadata and test-fixture isolation change. If `Cargo.lock` is unchanged, omit it from `git add`.

### Task 2: Rebase and Verify the Complete PR Branch

**Files:**
- Verify all task files relative to `origin/main`

- [ ] **Step 1: Rebase the committed branch onto the latest main**

Run:

```bash
git fetch origin
git rebase origin/main
```

Expected: successful rebase. If a conflict is ambiguous or outside this task's changes, abort the rebase and record a failed Kanna stage instead of publishing a half-rebased branch.

- [ ] **Step 2: Run the JavaScript and TypeScript suite**

Run:

```bash
pnpm test
```

Expected: exit 0 with every Turbo task successful.

- [ ] **Step 3: Run the canonical Rust verification**

Run:

```bash
./kd test rust
```

Expected: exit 0, including the frontend production build, sidecar build, workspace tests, and serialized daemon tests.

- [ ] **Step 4: Confirm the publish state is clean and scoped**

Run:

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: clean status and only the task's CLI-default work, approved design documents, and legacy relocation test-isolation fix.

### Task 3: Publish the Branch and Record Success

**Files:**
- No local file changes expected

- [ ] **Step 1: Rename and push the branch**

Run:

```bash
git branch -m fix/default-agent-sessions-to-cli
git push -u origin HEAD
```

Expected: the remote branch `fix/default-agent-sessions-to-cli` is created and configured as the upstream.

- [ ] **Step 2: Create the pull request against main**

Run:

```bash
PR_URL="$(gh pr create \
  --base main \
  --title "fix: default agent sessions to CLI mode" \
  --body "$(cat <<'EOF'
## Summary
- make CLI/PTY sessions the default agent execution type across generated provider metadata
- align server task creation and provider-resolution coverage with the CLI default
- isolate legacy database relocation fixtures so canonical Rust tests remain safe under parallel execution

## Test Plan
- pnpm test
- ./kd test rust
EOF
)" \
)"
printf '%s\n' "$PR_URL"
```

Expected: GitHub prints the full pull request URL.

- [ ] **Step 3: Record successful Kanna stage completion**

Call `kanna_complete_stage` with the current task ID, `status: "success"`, summary `Created PR` followed by the value of `PR_URL`, and metadata containing `pr_url` set to that same value.

Expected: Kanna records the PR URL without advancing this manual-transition stage automatically.
