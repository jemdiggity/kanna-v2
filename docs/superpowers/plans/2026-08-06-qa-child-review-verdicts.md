# QA Child Review Verdicts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give QA dispatcher rounds a durable read-only query for earlier specialty child verdicts, including closed children.

**Architecture:** Add one direct-child database query and expose it through a focused server route and shared catalog tool. The response maps each child's latest stage run into the existing verdict shape while adding the run's agent name, allowing the dispatcher to reduce chronological children to the latest verdict per specialty without duplicating state.

**Tech Stack:** Rust, rusqlite, Axum, serde, JSON tool catalog, Vitest

---

### Task 1: Real-router contract for direct child verdict history

**Files:**
- Modify: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/tasks.rs`
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/src/db/pipeline_items.rs`

- [ ] **Step 1: Write the failing HTTP test**

Seed one parent, two direct children (one closed), one grandchild, and one unrelated task in `test_router_with_seed`. Attach a terminal `NewStageRun` to each direct child with agents `review-security` and `review-compat` and JSON verdict results. Request `/v1/tasks/task-parent/children` and assert status 200, chronological child ids, the two agent names, closed timestamp preservation, and mapped `latestRun` status/summary. Assert the grandchild and unrelated task are absent.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cargo test -p kanna-server http_api::tests::core_routes::list_task_children_route_returns_open_and_closed_direct_children_with_verdicts`

Expected: FAIL with `404 Not Found` because the route is not registered.

- [ ] **Step 3: Add the minimal DB query and response mapping**

Add `Db::list_pipeline_item_children(parent_id)` using the existing full `PipelineItem` projection, with no `closed_at` predicate and `ORDER BY datetime(created_at) ASC, id ASC`. Add serializable `TaskChild` with `id`, `agent`, `created_at`, `closed_at`, and `latest_run`; implement `MobileApi::list_task_children` by resolving the parent id, verifying it exists, loading direct children, and pairing each with `latest_stage_run`. Reuse `map_task_latest_run` for verdict JSON parsing and take `agent` from the same latest run.

- [ ] **Step 4: Register the route**

Add `get_task_children` in `http_api/tasks.rs`, mapping a missing parent to 404 and database failures to 500, then register `GET /v1/tasks/{task_id}/children` before the generic task route.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the command from Step 2.

Expected: PASS.

### Task 2: Shared MCP/CLI catalog surface

**Files:**
- Modify: `crates/kanna-tool-catalog/src/catalog.json`
- Modify: `crates/kanna-tool-catalog/tests/catalog.rs`
- Modify: `crates/kanna-cli/src/tests/mod.rs`

- [ ] **Step 1: Write failing catalog assertions**

Add `kanna_list_task_children` to the expected bundled tool names, assert its generated schema has `readOnlyHint: true`, and add a resolution case proving `{ "task_id": "task 1" }` maps to `GET /v1/tasks/task%201/children` with an empty request body. Update the CLI's mirrored expected tool-name list.

- [ ] **Step 2: Run catalog and CLI tests and verify RED**

Run: `cargo test -p kanna-tool-catalog --test catalog && cargo test -p kanna-cli`

Expected: FAIL because the bundled catalog does not contain the tool.

- [ ] **Step 3: Add the catalog declaration**

Add the read-only JSON tool beside `kanna_get_task`, describing that it lists direct children including closed children and exposes their latest recorded stage-run verdict. Give it one required string path parameter, `task_id`, and path `/v1/tasks/{task_id}/children`.

- [ ] **Step 4: Re-run catalog and CLI tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

### Task 3: Dispatcher carry-forward contract and documentation

**Files:**
- Modify: `packages/core/src/pipeline/qa-assets.test.ts`
- Modify: `.kanna/agents/qa-dispatcher/AGENT.md`
- Modify: `docs/specs/qa-dispatch-review.md`

- [ ] **Step 1: Write failing shipped-asset assertions**

Extend the incremental-round test to require `kanna_list_task_children`, `latest verdict per specialty`, an explicit rule that a prior FAIL remains unresolved until that specialty records a later PASS, and aggregate summaries that cite carried verdicts rather than claiming only that a surface was unchanged.

- [ ] **Step 2: Run the asset test and verify RED**

Run: `pnpm --dir packages/core test -- qa-assets.test.ts`

Expected: FAIL on the new dispatcher phrases.

- [ ] **Step 3: Update dispatcher steps 1, 2, 4, and 6**

In step 1, query direct child history and reduce it chronologically to the latest terminal verdict per specialty. In step 2, carry untouched specialties only from an actual recorded verdict; keep a recorded FAIL blocking until a later PASS. In step 4, retain the current wait/get/close behavior for this round's new children. In step 6, report newly reviewed and carried-forward per-specialty verdicts, and include unresolved carried FAIL findings in the existing filtered, five-item closed revision list. Keep the ancestor / range-diff / full-branch fallbacks and `$PREV_MAIN_RESULT` declined-findings check intact.

- [ ] **Step 4: Replace the known-gap documentation**

Document the direct-child endpoint as the durable verdict source, the latest-per-specialty reduction rule, closed-child inclusion, missing-verdict fail-closed behavior, and the fact that no migration or aggregate table is needed.

- [ ] **Step 5: Re-run the asset test and verify GREEN**

Run the command from Step 2.

Expected: PASS.

### Task 4: Integrated verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused suites**

Run: `cargo test -p kanna-server http_api::tests::core_routes::list_task_children_route && cargo test -p kanna-tool-catalog --test catalog && pnpm --dir packages/core test -- qa-assets.test.ts`

Expected: all PASS.

- [ ] **Step 2: Run repository verification**

Run: `pnpm test`

Run: `./kd test rust`

Expected: both PASS, or any unrelated environmental failure is recorded with its exact output.

- [ ] **Step 3: Check the patch**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only task-related files are modified.
