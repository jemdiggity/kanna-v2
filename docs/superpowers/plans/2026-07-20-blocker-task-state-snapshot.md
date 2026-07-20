# Blocker Task State Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent resolved blockers from reappearing as blocked when their task rows are absent from the visible task snapshot.

**Architecture:** Keep `pipeline_item` as the sole lifecycle source of truth. Add a minimal `blockerTaskStates` projection to `UiSnapshot`, keyed by referenced blocker task ID, then use that projection wherever a snapshot relationship is classified as resolved or unresolved. Preserve conservative fallback behavior when state is missing.

**Tech Stack:** Rust, rusqlite, serde, Vue 3, TypeScript, Vitest, pnpm

---

### Task 1: Transport authoritative blocker task state

**Files:**
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/snapshot.rs`
- Test: `crates/kanna-server/src/http_api/tests/core_routes.rs`

- [ ] **Step 1: Write the failing snapshot regression test**

Make `task-closed` a second blocker of `task-visible`, then assert that it remains absent from `entries[].items` but appears in the new projection:

```rust
db.insert_task_blocker("task-visible", "task-closed").unwrap();

assert_eq!(
    snapshot["blockerTaskStates"]["task-closed"]["closed_at"]
        .as_str()
        .is_some(),
    true,
);
assert_eq!(snapshot["blockerTaskStates"]["task-blocker"]["stage"], "review");
```

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test -p kanna-server snapshot_route_returns_ui_hydration_payload`

Expected: FAIL because `blockerTaskStates` is absent.

- [ ] **Step 3: Add the snapshot projection**

Define a serialized state whose fields match the blocking task:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotBlockerTaskState {
    pub closed_at: Option<String>,
    pub stage: Option<String>,
    pub pr_url: Option<String>,
}

impl SnapshotBlockerTaskState {
    pub fn is_resolved(&self) -> bool {
        self.closed_at.is_some()
            || (self.stage.as_deref() == Some("pr") && self.pr_url.is_some())
    }
}
```

Add `blocker_task_states: HashMap<String, SnapshotBlockerTaskState>` to `UiSnapshot`. Populate it with one query joining distinct `task_blocker.blocker_item_id` values to `pipeline_item`, without filtering closed tasks or hidden repositories.

- [ ] **Step 4: Run the focused Rust test and verify GREEN**

Run: `cargo test -p kanna-server snapshot_route_returns_ui_hydration_payload`

Expected: PASS.

### Task 2: Use blocker task state in desktop classification

**Files:**
- Modify: `apps/desktop/src/types/kanna.ts`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/queries.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/stores/selection.ts`
- Modify: `apps/desktop/src/components/Sidebar.vue`
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.ts`
- Modify: `apps/desktop/src/utils/sidebarOrdering.ts`
- Test: `apps/desktop/src/utils/sidebarOrdering.test.ts`

- [ ] **Step 1: Write the failing sidebar regression test**

Add a test where the blocker is absent from `items` but present in `blockerTaskStates` as closed:

```ts
const groups = groupedSidebarItemsByStage({
  repoId: "repo-1",
  items: [item({ id: "dependent" })],
  blockers: [{ blocked_item_id: "dependent", blocker_item_id: "closed-upstream" }],
  blockerTaskStates: {
    "closed-upstream": { closed_at: "2026-07-19T22:49:04Z", stage: "pr", pr_url: null },
  },
  getStageOrder,
});
expect(groups.flatMap((group) => group.items.map((entry) => entry.id))).toContain("dependent");
```

Keep or add a companion assertion that an unknown blocker remains blocked.

- [ ] **Step 2: Run the focused Vitest test and verify RED**

Run: `pnpm --dir apps/desktop test --run src/utils/sidebarOrdering.test.ts`

Expected: FAIL because ordering does not accept or consult `blockerTaskStates`.

- [ ] **Step 3: Add TypeScript state and snapshot plumbing**

Add:

```ts
export type BlockerTaskState = Pick<PipelineItem, "closed_at" | "stage" | "pr_url">;
export type BlockerTaskStates = Record<string, BlockerTaskState>;
```

Make `blockerTaskStates` optional on client-side snapshot interfaces for fixture/version compatibility, but initialize store state to `{}` and synchronize with `snapshot.blockerTaskStates ?? {}`. Expose the state from the Pinia store and pass it to sidebar ordering, store ordering, and task navigation.

Update ordering and navigation lookup order to:

```ts
const blockerState = options.blockerTaskStates?.[blocker.blocker_item_id]
  ?? itemsByTaskId.get(blocker.blocker_item_id);
if (!blockerState || !isBlockerResolved(blockerState)) {
  blocked.add(blocker.blocked_item_id);
}
```

- [ ] **Step 4: Run the focused Vitest test and verify GREEN**

Run: `pnpm --dir apps/desktop test --run src/utils/sidebarOrdering.test.ts`

Expected: PASS.

### Task 3: Keep LAN and cloud task status consistent

**Files:**
- Modify: `apps/desktop/src/services/desktopLanTaskIndex.ts`
- Test: `apps/desktop/src/services/desktopLanTaskIndex.test.ts`
- Modify: `crates/kanna-server/src/cloud_task_publisher.rs`
- Test: `crates/kanna-server/src/cloud_task_publisher.rs`

- [ ] **Step 1: Write failing publisher regressions**

For LAN publication, return a snapshot containing a relationship and closed blocker state, publish, and assert `blockedByTaskIds` is empty. For the Rust cloud mapper, create `blocker_task_states` with a resolved blocker and assert the resulting task status is `active` and its blocker list is empty.

- [ ] **Step 2: Run both focused tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop test --run src/services/desktopLanTaskIndex.test.ts
cargo test -p kanna-server cloud_task_publisher::tests::snapshot_mapping_omits_resolved_blockers
```

Expected: both FAIL because all relationship rows are currently published as active blockers.

- [ ] **Step 3: Filter relationships through task state**

Pass `snapshot.blockerTaskStates` into the LAN helper and retain only relationships whose state is missing or unresolved. In `map_ui_snapshot`, consult `snapshot.blocker_task_states` and `SnapshotBlockerTaskState::is_resolved()` before inserting a blocker ID into the cloud map.

- [ ] **Step 4: Run both focused tests and verify GREEN**

Repeat the commands from Step 2. Expected: PASS.

### Task 4: Verify the integrated change

**Files:**
- Verify all modified files

- [ ] **Step 1: Run desktop type checking and focused tests**

Run:

```bash
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop test --run src/utils/sidebarOrdering.test.ts src/services/desktopLanTaskIndex.test.ts src/services/desktopServerClient.test.ts
```

Expected: PASS with no type errors.

- [ ] **Step 2: Run the server test suite**

Run: `cargo test -p kanna-server`

Expected: PASS.

- [ ] **Step 3: Run repository diff checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only task-related files are modified.
