# Dormant Task PR-Branch Unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep blocked tasks worktree-free until resolution, then create their worktree from every blocker's durable, actual PR branch even when an earlier blocker worktree has been cleaned up.

**Architecture:** Capture a PR-stage blocker's live renamed Git branch while its worktree still exists and persist it in a dedicated `pipeline_item.pr_branch` column. Keep `pipeline_item.branch` as the workspace identity, and let the existing dormant-start path base and merge the dependent worktree from durable PR branches only after all blockers resolve.

**Tech Stack:** Rust, Axum HTTP integration tests, rusqlite, Git worktrees, Tokio daemon protocol test fixture

---

### Task 1: Reproduce the cleaned-up renamed-branch failure

**Files:**
- Modify: `crates/kanna-server/src/http_api/tests/actions.rs`

- [ ] **Step 1: Convert the existing multi-blocker test into the production regression**

Rename `non_conflicting_multi_blocker_merge_starts_dependent_directly` to `renamed_multi_blocker_pr_branches_survive_earlier_worktree_cleanup`. Create blocker worktrees with stored workspace branch names, commit distinct files, and rename their checked-out branches to PR branch names:

```rust
let blocker_a_worktree = commit_branch_change(
    &repo_root,
    "blocker-a-workspace",
    "a.txt",
    "from a\n",
);
let blocker_b_worktree = commit_branch_change(
    &repo_root,
    "blocker-b-workspace",
    "b.txt",
    "from b\n",
);
for (worktree, pr_branch) in [
    (&blocker_a_worktree, "feat/blocker-a"),
    (&blocker_b_worktree, "feat/blocker-b"),
] {
    assert!(Command::new("git")
        .args(["branch", "-m", pr_branch])
        .current_dir(worktree)
        .status()
        .unwrap()
        .success());
}
```

Seed both blockers at the `pr` stage while retaining their stale workspace branch names in the database:

```rust
for (id, stored_branch) in [
    ("blocker-a", "blocker-a-workspace"),
    ("blocker-b", "blocker-b-workspace"),
] {
    db.insert_test_pipeline_item(
        id,
        "repo-1",
        "blocker prompt",
        Some(id),
        "pr",
        "2026-07-01T00:00:00Z",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        id,
        stored_branch,
        "default",
        None,
        "claude",
    )
    .unwrap();
}
```

After dependent creation, assert it is dormant. Close the first blocker, then assert its workspace branch remains stable, its live PR branch was persisted separately, its worktree was cleaned up, and the dependent still has no worktree:

```rust
assert!(db
    .get_task_worktree_path(&dependent.task_id)
    .unwrap()
    .is_none());

assert_eq!(
    app.clone()
        .oneshot(
            Request::post("/v1/tasks/blocker-a/actions/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
        .status(),
    StatusCode::NO_CONTENT
);

let db = Db::open(&config.db_path).unwrap();
assert_eq!(
    db.get_pipeline_item("blocker-a")
        .unwrap()
        .unwrap()
        .branch
        .as_deref(),
    Some("blocker-a-workspace")
);
assert_eq!(
    db.get_pipeline_item_pr_branch("blocker-a")
        .unwrap()
        .as_deref(),
    Some("feat/blocker-a")
);
assert!(!blocker_a_worktree.exists());
assert!(db
    .get_task_worktree_path(&dependent.task_id)
    .unwrap()
    .is_none());
drop(db);
```

Close the second blocker and retain the existing assertions that the dependent spawns once and its new worktree contains both `a.txt` and `b.txt`. Change the expected `base_ref` to `feat/blocker-a`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p kanna-server http_api::tests::actions::renamed_multi_blocker_pr_branches_survive_earlier_worktree_cleanup -- --nocapture
```

Expected: FAIL because no durable PR-branch field exists and the earlier renamed branch is lost after cleanup.

### Task 2: Persist the live PR branch at blocker resolution

**Files:**
- Modify: `crates/kanna-server/src/db/pipeline_items.rs`
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/test_support.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/http_api/task_blockers.rs`
- Test: `crates/kanna-server/src/http_api/tests/actions.rs`

- [ ] **Step 1: Add the durable PR-branch migration and database boundary**

Add migration `027_pipeline_item_pr_branch` with nullable `pipeline_item.pr_branch`, mirror it in the test schema, and add focused read/write methods:

```rust
pub fn get_pipeline_item_pr_branch(
    &self,
    id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    self.conn
        .query_row(
            "SELECT pr_branch FROM pipeline_item WHERE id = ?",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map(Option::flatten)
}

pub fn update_pipeline_item_pr_branch(
    &self,
    id: &str,
    branch: &str,
) -> Result<(), rusqlite::Error> {
    let rows_affected = self.conn.execute(
        "UPDATE pipeline_item SET pr_branch = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
        (branch, id),
    )?;
    if rows_affected == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}
```

- [ ] **Step 2: Persist a renamed blocker branch before close cleanup**

In `collect_blocker_resolution_instructions`, resolve the current branch from the blocker worktree and persist it without changing the workspace branch:

```rust
let blocker_branch = blocker
    .branch
    .as_deref()
    .and_then(|branch| {
        crate::task_creator::resolve_current_source_worktree_branch(&repo.path, Some(branch))
    })
    .or(blocker.branch)
    .unwrap_or_else(|| blocker_task_id.to_string());
db.update_pipeline_item_pr_branch(&blocker_task_id, &blocker_branch)
    .map_err(|error| db_write_error("db error", error))?;
```

Make blocker handoff prefer persisted `pr_branch`, then fall back to live worktree resolution and the workspace branch. This runs both when a PR becomes optimistically resolved and immediately before a PR-stage task closes, while the renamed worktree branch is still discoverable.

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```bash
cargo test -p kanna-server http_api::tests::actions::renamed_multi_blocker_pr_branches_survive_earlier_worktree_cleanup -- --nocapture
```

Expected: PASS; the first blocker branch is durable after cleanup and the dependent worktree includes both blocker commits.

- [ ] **Step 4: Run adjacent blocker lifecycle tests**

Run:

```bash
cargo test -p kanna-server http_api::tests::actions::complete_pr_stage_with_pr_url_starts_dormant_dependent_optimistically -- --nocapture
cargo test -p kanna-server http_api::tests::actions::close_last_blocker_starts_dormant_dependent_from_blocker_branch -- --nocapture
cargo test -p kanna-server db::tests::close_pipeline_item -- --nocapture
```

Expected: all selected tests PASS.

### Task 3: Verify and review the complete patch

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-dormant-task-pr-branch-unblock-design.md`
- Create: `docs/superpowers/plans/2026-07-16-dormant-task-pr-branch-unblock.md`
- Review: `crates/kanna-server/src/db/pipeline_items.rs`
- Review: `crates/kanna-server/src/http_api/task_actions.rs`
- Review: `crates/kanna-server/src/http_api/tests/actions.rs`

- [ ] **Step 1: Format and check the patch**

Run:

```bash
cargo fmt --all -- --check
git diff --check
```

Expected: both commands exit successfully with no output.

- [ ] **Step 2: Run the server test suite**

Run:

```bash
cargo test -p kanna-server
```

Expected: all `kanna-server` tests PASS.

- [ ] **Step 3: Review the final diff and worktree state**

Run:

```bash
git diff --stat
git diff -- crates/kanna-server/src/db/pipeline_items.rs crates/kanna-server/src/http_api/task_actions.rs crates/kanna-server/src/http_api/tests/actions.rs
git status --short
```

Expected: only the approved design, plan, regression test, database branch write, and PR-resolution persistence are changed. Do not commit; this Kanna workflow performs the commit after the user advances the task.
