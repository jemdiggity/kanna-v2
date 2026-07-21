# Terminal Transport Runtime Starvation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep keyboard input and every task terminal flowing while repository definitions refresh, without issuing redundant refresh work during state-change bursts.

**Architecture:** Keep the shared KSP data plane, but move complete repository-definition HTTP lookups onto Tokio's blocking pool and make expired cache loads single-flight per repository. On the desktop, serialize KSP-driven snapshot refreshes and collapse invalidations received during a refresh into one trailing refresh.

**Tech Stack:** Rust, Tokio, Axum, Vue 3, TypeScript, Vitest

---

### Task 1: Single-flight repository-definition cache

**Files:**
- Modify: `crates/kanna-server/src/task_creator/definition_cache.rs`

- [ ] **Step 1: Add concurrent cache regression tests**

Extend the existing tests with a loader gate and two threads. One test starts
two calls for the same missing key, holds the loader open until both callers
are in flight, and asserts the loader `AtomicUsize` is `1`. Both results must
contain `revision-1`. A second test makes the shared load return
`Err("unavailable")`; both callers receive that error and a subsequent call
executes a new successful loader.

- [ ] **Step 2: Run the cache tests and verify the regression fails**

Run:

```bash
cargo test -p kanna-server task_creator::definition_cache::tests -- --nocapture
```

Expected: the concurrent test observes two loads with the current
check-then-load cache.

- [ ] **Step 3: Represent in-flight loads explicitly**

Replace the value-only map with entries that are ready or loading:

```rust
enum CacheEntry<V, E> {
    Ready(TimedEntry<V>),
    Loading(Arc<LoadFlight<V, E>>),
}

struct LoadFlight<V, E> {
    result: Mutex<Option<Result<Arc<V>, E>>>,
    ready: Condvar,
}
```

`LoadFlight::wait` waits until it can clone the shared result;
`LoadFlight::finish` stores the result and wakes every waiter. Constrain the
cache error type to `Clone`. Under the cache mutex, return a fresh value, join
an existing flight, or insert a new flight. Release the mutex before calling
the loader. On success replace the flight with a ready entry timestamped after
the load; on failure remove it. Existing waiters retain the flight and receive
the original failure, while later requests can retry.

- [ ] **Step 4: Run the cache tests and verify they pass**

```bash
cargo test -p kanna-server task_creator::definition_cache::tests -- --nocapture
```

Expected: all cache tests pass, including one-load concurrency and retry.

- [ ] **Step 5: Commit the cache boundary**

```bash
git add crates/kanna-server/src/task_creator/definition_cache.rs
git commit -m "fix: single-flight repository definition loads"
```

### Task 2: Isolate definition HTTP work from Tokio

**Files:**
- Modify: `crates/kanna-server/src/http_api/repos.rs`

- [ ] **Step 1: Add a blocking-worker responsiveness test**

Add a current-thread Tokio test around a missing `run_blocking_http` helper.
The operation sends a started signal, waits on a standard channel, then returns
`Ok(())`. After the started signal, a short Tokio timer must complete before
the operation is released:

```rust
#[tokio::test(flavor = "current_thread")]
async fn blocking_definition_lookup_does_not_block_async_runtime() {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let lookup = tokio::spawn(run_blocking_http(move || {
        let _ = started_tx.send(());
        release_rx.recv().unwrap();
        Ok(())
    }));
    started_rx.await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_millis(100),
        tokio::time::sleep(std::time::Duration::from_millis(1)),
    ).await.expect("async runtime stayed responsive");
    release_tx.send(()).unwrap();
    lookup.await.unwrap().unwrap();
}
```

- [ ] **Step 2: Run the test and verify the helper is missing**

```bash
cargo test -p kanna-server blocking_definition_lookup_does_not_block_async_runtime -- --nocapture
```

Expected: compilation fails because `run_blocking_http` is undefined.

- [ ] **Step 3: Add the blocking HTTP boundary**

Add this private helper to `repos.rs`:

```rust
async fn run_blocking_http<T, F>(operation: F) -> Result<T, HttpError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, HttpError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation).await.map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("repository definition worker failed: {error}"),
        )
    })?
}
```

For all three definition endpoints, clone `Arc<AppState>`, move owned path
parameters into the closure, and perform `get_definition_repo` plus the
corresponding `load_repo_*` call inside `run_blocking_http`. Map definition
errors inside the closure and wrap the awaited result in `Json`. This moves
SQLite access, Git commands, and snapshot file reads for these endpoints onto
blocking workers.

- [ ] **Step 4: Run route and responsiveness tests**

```bash
cargo test -p kanna-server http_api::tests::repo_definitions -- --nocapture
cargo test -p kanna-server blocking_definition_lookup_does_not_block_async_runtime -- --nocapture
```

Expected: both commands pass.

- [ ] **Step 5: Commit runtime isolation**

```bash
git add crates/kanna-server/src/http_api/repos.rs
git commit -m "fix: isolate definition lookup from async runtime"
```

### Task 3: Coalesce KSP state-change refresh bursts

**Files:**
- Modify: `apps/desktop/src/stores/init.ts`
- Modify: `apps/desktop/src/stores/init.test.ts`

- [ ] **Step 1: Add an active-plus-trailing refresh test**

Initialize the Tauri path with a `reloadSnapshot` mock whose first and second
calls have separate deferred completion gates. Emit the KSP state-change
listener three times while the first call is blocked and assert one call. Open
the first gate, wait for a second call, open the second gate, and assert no
third call appears. Also assert the selected task remains selected.

- [ ] **Step 2: Run the frontend test and verify redundant reloads occur**

```bash
pnpm --dir apps/desktop test -- init.test.ts
```

Expected: the new test sees three concurrent reloads rather than one.

- [ ] **Step 3: Add a trailing async coordinator**

Add this module-level helper in `init.ts`:

```ts
function createTrailingAsyncCoordinator(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  let running = false;
  let trailing = false;
  async function drain(): Promise<void> {
    running = true;
    do {
      trailing = false;
      try {
        await run();
      } catch (error) {
        onError(error);
      }
    } while (trailing);
    running = false;
  }
  return () => {
    if (running) {
      trailing = true;
      return;
    }
    void drain();
  };
}
```

Inside `init`, create one coordinator whose `run` captures current focus,
awaits `reloadSnapshot`, and preserves focus. Register it with
`client.onStateChanged`, retaining the existing error log callback.

- [ ] **Step 4: Run store tests and type checking**

```bash
pnpm --dir apps/desktop test -- init.test.ts
pnpm --dir apps/desktop exec vue-tsc --noEmit
```

Expected: coalescing, existing focus tests, and type checking pass.

- [ ] **Step 5: Commit frontend coalescing**

```bash
git add apps/desktop/src/stores/init.ts apps/desktop/src/stores/init.test.ts
git commit -m "fix: coalesce task state refresh bursts"
```

### Task 4: Integrated verification

**Files:**
- Verify only

- [ ] **Step 1: Format and inspect**

```bash
cargo fmt --all -- --check
git diff --check
git status --short
```

Expected: formatting and whitespace checks pass.

- [ ] **Step 2: Run complete relevant suites**

```bash
cargo test -p kanna-server
pnpm --dir apps/desktop test
```

Expected: all server and desktop tests pass.

- [ ] **Step 3: Review final history**

```bash
git log --oneline --max-count=5
git status --short
```

Expected: the design and three implementation commits are present and the
worktree is clean.
