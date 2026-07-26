# Review Contract Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the shipped activity-revision database contract, serialize both teardown edges of resumed revisions, and make daemon event-stream negotiation lossless.

**Architecture:** Keep `029_pipeline_item_activity_revision` immutable and append stage-run migrations as 030 and 031. Model a resumed transition with separate pre-spawn target-teardown and post-landing departed-teardown responsibilities, deferring resumed setup until the target teardown has stopped. Pump both daemon subscriptions continuously and merge their events with cross-stream deduplication instead of discarding the legacy stream when the versioned acknowledgement arrives.

**Tech Stack:** Rust, Tokio, rusqlite/SQLite, TypeScript, pnpm.

---

### Task 1: Restore activity revision compatibility

**Files:**
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/pipeline_items.rs`
- Modify: `crates/kanna-server/src/db/snapshot.rs`
- Modify: `crates/kanna-server/src/db/test_support.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/db/worktrees.rs`
- Modify: `crates/kanna-server/src/http_api/task_activity.rs`
- Modify: `packages/db/src/migrations/001_initial.sql`
- Modify: `packages/db/src/queries.ts`
- Modify: `packages/db/src/schema.ts`

- [ ] Add tests proving migration order is `029_pipeline_item_activity_revision`, `030_stage_run_ownership_version`, then `031_pending_stage_action`.
- [ ] Add tests proving stale mark-read revisions cannot overwrite newer unread activity and every activity mutation increments the revision.
- [ ] Run the focused database tests and confirm they fail because the column and guarded write are absent.
- [ ] Restore the column in serialized item/snapshot types and every item/snapshot query.
- [ ] Restore activity increments in server and TypeScript writes and the guarded mark-read endpoint.
- [ ] Renumber the new stage-run migrations without changing the shipped 029 identifier.
- [ ] Re-run focused Rust and TypeScript database tests.

### Task 2: Serialize resumed workspace lifecycle

**Files:**
- Modify: `crates/kanna-server/src/task_creator/types.rs`
- Modify: `crates/kanna-server/src/task_creator/stages.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/revision.rs`

- [ ] Add a fake-daemon regression with a blocked target `td-{branch}` session and assert the resumed provider is not spawned until its kill completes.
- [ ] Confirm the regression fails with the provider spawn overlapping the target teardown.
- [ ] Record the target teardown session separately from the departed workspace teardown.
- [ ] Defer resumed workspace setup so it runs only after the target teardown kill completes.
- [ ] Attach the departed workspace teardown to resumed transitions and start it only after the new run lands.
- [ ] Re-run revision lifecycle tests.

### Task 3: Preserve daemon events across subscription cutover

**Files:**
- Modify: `crates/kanna-server/src/terminal_watcher.rs`

- [ ] Add a regression that sends legacy `Ok`, then a legacy-only owning `Exit`, then versioned `Ok`, and assert the owning stage run completes.
- [ ] Confirm the regression fails because the legacy connection is discarded after negotiation.
- [ ] Pump both subscription sockets while acknowledgements are pending.
- [ ] Keep both accepted receivers active and deduplicate only matching cross-stream events.
- [ ] Fall back to either surviving stream if the other closes.
- [ ] Re-run terminal watcher tests.

### Task 4: Verification

**Files:**
- Inspect every modified file.

- [ ] Run focused Kanna server database, revision, and terminal watcher tests.
- [ ] Run relevant package database tests.
- [ ] Run `cargo fmt --check`, `git diff --check`, and the canonical Rust verification practical for this revision.
- [ ] Review the final diff against all three reviewer findings.
- [ ] Record Kanna stage completion with the verified result.
