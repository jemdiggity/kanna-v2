# Desktop Interaction Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make New Task and Close Task update presentation state immediately while caching repeated remote definition reads in the local server.

**Architecture:** New Task mounts before starting option discovery and fences asynchronous results by invocation generation. The local Kanna server owns a 30-second resolved-definition cache used by definition HTTP routes; authoritative task creation remains uncached. Close Task projects a closed item through the existing optimistic snapshot overlay and restores it only when a genuine server rejection occurs without newer navigation.

**Tech Stack:** Vue 3, Pinia, TypeScript, Vitest, Rust, Axum, Tokio/Kanna server tests

---

## File map

- Create `crates/kanna-server/src/task_creator/definition_cache.rs`: bounded-freshness cache for resolved remote repository definitions.
- Modify `crates/kanna-server/src/task_creator/mod.rs`: register the cache module and route definition loaders through a supplied cache.
- Modify `crates/kanna-server/src/http_api/state.rs`: own one shared cache per local server process.
- Modify `crates/kanna-server/src/http_api/repos.rs`: use the shared cache for manifest, workflow, and agent definition routes.
- Modify `apps/desktop/src/composables/useAppTaskCreation.ts`: render first, load options asynchronously, and discard stale loads.
- Modify `apps/desktop/src/composables/useAppTaskCreation.test.ts`: cover immediate visibility and stale-load fencing.
- Modify `apps/desktop/src/components/NewTaskModal.vue`: represent option loading without blocking prompt entry.
- Modify `apps/desktop/src/components/AppModalLayer.vue`: pass option-loading and prior-submission state into the modal.
- Modify `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`: cover loading controls and submission behavior.
- Modify `apps/desktop/src/i18n/locales/en.json`: add the English task-option loading label.
- Modify `apps/desktop/src/i18n/locales/ja.json`: add the Japanese task-option loading label.
- Modify `apps/desktop/src/i18n/locales/ko.json`: add the Korean task-option loading label.
- Modify `apps/desktop/src/stores/taskCloseActions.ts`: add optimistic close projection and guarded rollback.
- Modify `apps/desktop/src/stores/taskCloseActions.test.ts`: cover UI changes before the server response and rollback behavior.

### Task 1: Cache server-side remote definitions

**Files:**
- Create: `crates/kanna-server/src/task_creator/definition_cache.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Modify: `crates/kanna-server/src/http_api/repos.rs`
- Test: `crates/kanna-server/src/task_creator/definition_cache.rs`

- [ ] **Step 1: Write cache tests before the implementation**

Add unit tests around a generic timed entry helper so no Git process is needed. Cover one loader call inside the freshness interval, a second loader call after expiry, key isolation, and failure non-caching:

```rust
#[test]
fn fresh_entry_reuses_the_loaded_value() {
    let cache = TimedCache::new(Duration::from_secs(30));
    let loads = AtomicUsize::new(0);
    let started = Instant::now();

    let first = cache.get_or_try_insert_with("repo", started, || {
        loads.fetch_add(1, Ordering::SeqCst);
        Ok::<_, String>("revision-1".to_string())
    }).unwrap();
    let second = cache.get_or_try_insert_with("repo", started + Duration::from_secs(1), || {
        loads.fetch_add(1, Ordering::SeqCst);
        Ok::<_, String>("revision-2".to_string())
    }).unwrap();

    assert_eq!(first.as_str(), "revision-1");
    assert_eq!(second.as_str(), "revision-1");
    assert_eq!(loads.load(Ordering::SeqCst), 1);
}
```

- [ ] **Step 2: Run the cache test and verify RED**

Run: `cargo test -p kanna-server task_creator::definition_cache::tests -- --nocapture`

Expected: compilation fails because `TimedCache` and the definition-cache module do not exist.

- [ ] **Step 3: Implement the generic timed cache and repository wrapper**

Use a cache key containing the repo id, path, and default branch. Keep the Git-backed load outside the map lock:

```rust
const REPO_DEFINITION_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RepoDefinitionCacheKey {
    id: String,
    path: String,
    default_branch: Option<String>,
}

pub(crate) struct RepoDefinitionsCache {
    definitions: TimedCache<RepoDefinitionCacheKey, RepoDefinitions>,
}

impl RepoDefinitionsCache {
    pub(crate) fn with_definitions<T>(
        &self,
        repo: &Repo,
        read: impl FnOnce(&RepoDefinitions) -> Result<T, DefinitionLookupError>,
    ) -> Result<T, DefinitionLookupError> {
        let definitions = self.definitions.get_or_try_insert_with(
            RepoDefinitionCacheKey::from(repo),
            Instant::now(),
            || RepoDefinitions::resolve(repo).map_err(DefinitionLookupError::Other),
        )?;
        read(&definitions)
    }
}
```

Store values in `Arc<V>`, check freshness under a `std::sync::Mutex`, drop the guard before calling the loader, and insert only successful results.

- [ ] **Step 4: Connect the cache to the server definition routes**

Add `repo_definitions: RepoDefinitionsCache` to `AppState`, initialize it in `AppState::new`, and change the three definition loader functions to accept `&RepoDefinitionsCache`. Their parsing logic remains unchanged; only `RepoDefinitions::resolve(repo)` becomes `cache.with_definitions(repo, |definitions| ...)`.

Update route handlers as follows:

```rust
crate::task_creator::load_repo_kanna_definitions(&state.repo_definitions, &repo)
```

Apply the same boundary to workflow and agent definition routes. Do not route task creation or stage lifecycle resolution through this cache.

- [ ] **Step 5: Run cache and definition-route tests**

Run:

```bash
cargo test -p kanna-server task_creator::definition_cache::tests -- --nocapture
cargo test -p kanna-server http_api::tests::repo_definitions -- --nocapture
```

Expected: all selected Rust tests pass.

- [ ] **Step 6: Commit the server cache**

```bash
git add crates/kanna-server/src/task_creator/definition_cache.rs crates/kanna-server/src/task_creator/mod.rs crates/kanna-server/src/http_api/state.rs crates/kanna-server/src/http_api/repos.rs
git commit -m "perf(server): cache remote repository definitions"
```

### Task 2: Render New Task before loading options

**Files:**
- Modify: `apps/desktop/src/composables/useAppTaskCreation.test.ts`
- Modify: `apps/desktop/src/composables/useAppTaskCreation.ts`
- Modify: `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`
- Modify: `apps/desktop/src/components/NewTaskModal.vue`
- Modify: `apps/desktop/src/components/AppModalLayer.vue`

- [ ] **Step 1: Write the immediate-visibility failing test**

Use deferred promises for definitions, providers, and branch invokes. Call `openNewTaskModal()` without awaiting it and assert visibility synchronously:

```ts
const openPromise = creation.openNewTaskModal();

expect(showNewTaskModal.value).toBe(true);
expect(creation.newTaskOptionsLoading.value).toBe(true);
expect(definitions).toHaveBeenCalledWith("repo-1");
```

Resolve the deferred calls and await `openPromise` so the test cleans up.

- [ ] **Step 2: Write the stale-generation failing test**

Start an option load for repo A, switch to repo B, start another load, then resolve B before A. Assert B's workflows, providers, and branches remain after A completes.

- [ ] **Step 3: Run the composable tests and verify RED**

Run: `pnpm --dir apps/desktop test -- src/composables/useAppTaskCreation.test.ts`

Expected: immediate visibility and `newTaskOptionsLoading` assertions fail against the current await-before-show flow.

- [ ] **Step 4: Implement render-first generation-fenced loading**

Add `newTaskOptionsLoading`, reactive `newTaskSubmissionPending`, an incrementing load generation, and option-reset/application helpers. `openNewTaskModal` must set visibility before starting discovery:

```ts
async function openNewTaskModal(repoId?: string) {
  const loadGeneration = ++newTaskOptionsLoadGeneration;
  const targetRepoId = resolveTargetRepoId(repoId);
  if (targetRepoId) store.selectedRepoId = targetRepoId;

  resetNewTaskOptions();
  newTaskOptionsLoading.value = true;
  showNewTaskModal.value = true;

  try {
    const options = await loadNewTaskOptions(targetRepoId);
    if (loadGeneration !== newTaskOptionsLoadGeneration || !showNewTaskModal.value) return;
    applyNewTaskOptions(options);
  } finally {
    if (loadGeneration === newTaskOptionsLoadGeneration) {
      newTaskOptionsLoading.value = false;
    }
  }
}
```

Do not await `pendingNewTaskSubmit` before mounting. Keep the existing submission single-flight guard, set `newTaskSubmissionPending` for the promise lifetime, and pass it to the modal so a second prompt can be written immediately but cannot be submitted until the preceding creation finishes.

- [ ] **Step 5: Add the modal loading-state failing test**

Mount `NewTaskModal` with `optionsLoading: true`, enter prompt text, and assert the prompt remains editable while branch/workflow changes and Create are disabled. Assert a `data-testid="task-options-loading"` label is present. Add a second assertion that `submissionPending: true` disables Create without disabling the prompt.

- [ ] **Step 6: Run the modal test and verify RED**

Run: `pnpm --dir apps/desktop test -- src/components/__tests__/NewTaskModal.test.ts`

Expected: the new prop and loading label do not yet exist.

- [ ] **Step 7: Implement the modal loading presentation**

Add `optionsLoading?: boolean` and `submissionPending?: boolean`, pass them through `AppModalLayer`, and render `tasks.loadingOptions` through a `data-testid="task-options-loading"` element. Add `"Loading task options…"`, `"タスクオプションを読み込んでいます…"`, and `"작업 옵션을 불러오는 중…"` to the English, Japanese, and Korean locale files respectively. Disable option pickers while options load, and include both props in the Create disabled condition. Do not disable the prompt or Cancel button.

- [ ] **Step 8: Run focused New Task tests**

Run:

```bash
pnpm --dir apps/desktop test -- src/composables/useAppTaskCreation.test.ts
pnpm --dir apps/desktop test -- src/components/__tests__/NewTaskModal.test.ts
pnpm --dir apps/desktop test -- src/App.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 9: Commit render-first New Task**

```bash
git add apps/desktop/src/composables/useAppTaskCreation.ts apps/desktop/src/composables/useAppTaskCreation.test.ts apps/desktop/src/components/NewTaskModal.vue apps/desktop/src/components/AppModalLayer.vue apps/desktop/src/components/__tests__/NewTaskModal.test.ts apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/ja.json apps/desktop/src/i18n/locales/ko.json
git commit -m "perf(desktop): open new task before loading options"
```

### Task 3: Optimistically remove closing tasks

**Files:**
- Modify: `apps/desktop/src/stores/taskCloseActions.test.ts`
- Modify: `apps/desktop/src/stores/taskCloseActions.ts`

- [ ] **Step 1: Add an optimistic overlay to the test harness**

Back `withOptimisticItemOverlay` with a test snapshot, applying the overlay to `state.items` before invoking `run` and restoring authoritative state in `finally`. This exercises presentation state rather than only checking a mock call.

- [ ] **Step 2: Write the unresolved-close failing test**

Hold `closeDesktopTask` unresolved, call `actions.closeTask`, and assert before resolving it:

```ts
expect(state.items.find((candidate) => candidate.id === durableItem.id)?.closed_at).not.toBeNull();
expect(services.selectReplacementAfterItemRemoval).toHaveBeenCalledWith(durableItem);
```

The close promise must still be pending at this point.

- [ ] **Step 3: Write rollback and newer-intent failing tests**

For a rejected close whose verification snapshot still contains the open task, assert the overlay is removed and the original selection is restored. Then increment `selectionIntentVersion` while another rejected close is pending and assert rollback does not overwrite the newer selection.

- [ ] **Step 4: Run close-action tests and verify RED**

Run: `pnpm --dir apps/desktop test -- src/stores/taskCloseActions.test.ts`

Expected: the unresolved-close test shows `closed_at` is still null and replacement selection has not begun.

- [ ] **Step 5: Implement optimistic close with guarded rollback**

Project the target item as closed through `withOptimisticItemOverlay`:

```ts
function closeProjection(taskId: string, closedAt: string) {
  return (snapshot: KannaSnapshot): KannaSnapshot => ({
    ...snapshot,
    entries: snapshot.entries.map((entry) => ({
      ...entry,
      items: entry.items.map((candidate) =>
        candidate.id === taskId ? { ...candidate, closed_at: closedAt } : candidate,
      ),
    })),
  });
}
```

Begin replacement selection from the pre-overlay ordering, then start the overlay-backed close request. Preserve the existing committed-after-error verification. If the task remains open, remove the overlay, restore the original task only when `selectionIntentVersion` still matches, and persist the restored selection after any earlier optimistic selection write.

- [ ] **Step 6: Run focused close and app tests**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/taskCloseActions.test.ts
pnpm --dir apps/desktop test -- src/App.test.ts
pnpm --dir apps/desktop test -- src/stores/selection.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit optimistic close**

```bash
git add apps/desktop/src/stores/taskCloseActions.ts apps/desktop/src/stores/taskCloseActions.test.ts
git commit -m "perf(desktop): update task close state optimistically"
```

### Task 4: Regression verification

**Files:**
- Verify all modified files

- [ ] **Step 1: Run formatting and static checks**

Run:

```bash
pnpm --dir apps/desktop typecheck
cargo fmt --all -- --check
cargo check -p kanna-server
```

Expected: every command exits successfully with no formatting diff.

- [ ] **Step 2: Run canonical test suites**

Run:

```bash
pnpm test
./kd test rust
```

Expected: both canonical suites pass. If an unrelated environment-dependent suite cannot run, record the exact command and error while retaining all focused test evidence.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git status --short
git diff --check HEAD~3..HEAD
git log --oneline -5
```

Expected: only the latency design, plan, implementation, tests, and translations are present; `git diff --check` reports no whitespace errors.
