# Batched Agent Teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route concurrent agent kills through one bounded lifecycle executor job that shares process-table snapshots across the kill batch.

**Architecture:** Add typed agent-kill jobs to the existing lifecycle queue, asynchronously backpressure them at `LIFECYCLE_QUEUE_CAP`, and have the lifecycle thread coalesce contiguous requests before calling a new batched verified-kill function. The batched kill freezes every valid leader first, uses `freeze_many` for shared discovery rounds, strikes each group independently, and returns results through per-request one-shot channels.

**Tech Stack:** Rust, Tokio one-shot/Notify primitives, macOS libproc process discovery, existing Kanna daemon lifecycle executor and test fixtures.

---

### Task 1: Add the failing concurrent-kill batching regression

**Files:**
- Modify: `crates/daemon/src/tests.rs:2756`

- [ ] **Step 1: Extend the real-child responsiveness test with a lifecycle gate and counters**

Before spawning the kill tasks, enqueue an ordinary lifecycle job that waits on
an atomic release flag. Wait asynchronously until it has entered, record
`agent_teardown_stats()`, spawn all kills, and wait until all requests have been
admitted before releasing the gate:

```rust
let gate_entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
let gate_released = Arc::new(std::sync::atomic::AtomicBool::new(false));
{
    let gate_entered = gate_entered.clone();
    let gate_released = gate_released.clone();
    kanna_daemon::reaper::run_teardown(move || {
        gate_entered.store(true, std::sync::atomic::Ordering::Release);
        while !gate_released.load(std::sync::atomic::Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(1));
        }
    });
}
while !gate_entered.load(std::sync::atomic::Ordering::Acquire) {
    tokio::task::yield_now().await;
}
let (requests_before, batches_before) =
    kanna_daemon::reaper::agent_teardown_stats();
```

After spawning the kills:

```rust
let admission_deadline = Instant::now() + Duration::from_secs(5);
loop {
    let (requests, _) = kanna_daemon::reaper::agent_teardown_stats();
    if requests - requests_before == SESSIONS as u64 {
        break;
    }
    assert!(
        Instant::now() < admission_deadline,
        "all concurrent agent kills must reach bounded lifecycle admission"
    );
    tokio::task::yield_now().await;
}
gate_released.store(true, std::sync::atomic::Ordering::Release);
```

After joining all kills, assert one batch handled the gated burst:

```rust
let (requests_after, batches_after) =
    kanna_daemon::reaper::agent_teardown_stats();
assert_eq!(requests_after - requests_before, SESSIONS as u64);
assert_eq!(
    batches_after - batches_before,
    1,
    "concurrent agent kills must share one lifecycle batch"
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p kanna-daemon concurrent_agent_kills_keep_the_runtime_responsive -- --nocapture
```

Expected: compilation fails because `agent_teardown_stats` and typed agent
teardown admission do not exist yet.

### Task 2: Add a batched identity-safe agent kill

**Files:**
- Modify: `crates/daemon/src/agent.rs:699`

- [ ] **Step 1: Add the internal plan representation**

Extract validation, leader freezing, and strike behavior:

```rust
#[derive(Debug, Clone, Copy)]
struct AgentKillPlan {
    pid: libc::pid_t,
    target: crate::proc_info::SessionTarget,
}

impl AgentKillPlan {
    fn prepare(
        raw_pid: u32,
        child_start: Option<crate::proc_info::StartTime>,
    ) -> std::io::Result<Self> {
        let refuse =
            |reason: String| std::io::Error::new(std::io::ErrorKind::NotFound, reason);
        let Some(pid) = crate::pty::validated_child_pid(raw_pid) else {
            return Err(refuse(format!(
                "agent pid {raw_pid} is out of range; refusing to signal"
            )));
        };
        let Some(start) = child_start else {
            return Err(refuse(format!(
                "agent pid {pid} has no start-time identity; refusing to signal"
            )));
        };
        let target = crate::proc_info::SessionTarget { pid, start };
        if !crate::proc_info::stop_verified(target) {
            return Err(refuse(format!(
                "agent pid {pid} could not be frozen under a verified identity; refusing to signal"
            )));
        }
        Ok(Self { pid, target })
    }

    fn strike(
        self,
        descendants: Vec<crate::proc_info::SessionTarget>,
    ) -> std::io::Result<()> {
        let group = unsafe { libc::kill(-self.pid, libc::SIGKILL) };
        let direct_needed = group != 0;
        for descendant in descendants {
            crate::proc_info::signal_verified(descendant, libc::SIGKILL);
        }
        if direct_needed && unsafe { libc::kill(self.pid, libc::SIGKILL) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}
```

- [ ] **Step 2: Add batch execution and make the scalar API delegate**

Prepare every request independently, call `freeze_many` only for ready plans,
and merge ready/error results back in input order:

```rust
pub fn kill_agent_groups_verified(
    requests: &[(u32, Option<crate::proc_info::StartTime>)],
) -> Vec<std::io::Result<()>> {
    let prepared: Vec<std::io::Result<AgentKillPlan>> = requests
        .iter()
        .map(|(pid, start)| AgentKillPlan::prepare(*pid, *start))
        .collect();
    let specs: Vec<_> = prepared
        .iter()
        .filter_map(|result| result.as_ref().ok())
        .map(|plan| (Some(plan.target), None))
        .collect();
    let mut frozen = crate::proc_info::freeze_many(&specs).into_iter();

    prepared
        .into_iter()
        .map(|result| match result {
            Ok(plan) => plan.strike(frozen.next().unwrap_or_default()),
            Err(error) => Err(error),
        })
        .collect()
}

pub fn kill_agent_group_verified(
    pid: u32,
    child_start: Option<crate::proc_info::StartTime>,
) -> std::io::Result<()> {
    kill_agent_groups_verified(&[(pid, child_start)])
        .into_iter()
        .next()
        .unwrap_or_else(|| {
            Err(std::io::Error::other(
                "agent kill batch returned no result for one request",
            ))
        })
}
```

- [ ] **Step 3: Add focused batch independence coverage**

In the macOS agent tests, spawn one real agent child and include an invalid
request before it:

```rust
#[cfg(target_os = "macos")]
#[test]
fn verified_group_kill_batch_keeps_results_ordered_and_independent() {
    let spec = SpawnSpec {
        executable: "/bin/sleep".to_string(),
        args: vec!["300".to_string()],
        env: Vec::new(),
        initial_stdin: None,
    };
    let mut spawned =
        spawn_agent_child(&spec, "/tmp", &HashMap::new()).expect("spawn agent child");

    let results = kill_agent_groups_verified(&[
        (0, Some((1, 1))),
        (spawned.pid, spawned.child_start),
    ]);
    assert_eq!(results.len(), 2);
    assert!(results[0].is_err(), "invalid first request must fail in place");
    assert!(results[1].is_ok(), "valid second request must still execute");
    assert!(!spawned.child.wait().expect("wait killed child").success());
    if let Some(fds) = spawned.handoff_fds.take() {
        fds.close();
    }
}
```

- [ ] **Step 4: Run the focused agent tests**

Run:

```bash
cargo test -p kanna-daemon verified_group_kill -- --nocapture
```

Expected: all matching verified group-kill tests pass.

### Task 3: Add typed bounded lifecycle batching

**Files:**
- Modify: `crates/daemon/src/reaper.rs:318`

- [ ] **Step 1: Replace the opaque queue item with typed jobs**

Add:

```rust
struct AgentTeardownJob {
    pid: u32,
    child_start: Option<StartTime>,
    completion: tokio::sync::oneshot::Sender<std::io::Result<()>>,
}

enum LifecycleJob {
    Teardown(TeardownJob),
    AgentTeardown(AgentTeardownJob),
}

struct Lifecycle {
    jobs: Mutex<VecDeque<LifecycleJob>>,
    wake: Condvar,
    capacity_available: tokio::sync::Notify,
    agent_requests: std::sync::atomic::AtomicU64,
    agent_batches: std::sync::atomic::AtomicU64,
}
```

Initialize the new fields in `lifecycle()`.

- [ ] **Step 2: Batch typed jobs on the lifecycle thread**

When the first job is `AgentTeardown`, allow a one-millisecond coalescing
window, then drain contiguous `AgentTeardown` entries without crossing an
ordinary teardown boundary:

```rust
match job {
    LifecycleJob::Teardown(job) => job(),
    LifecycleJob::AgentTeardown(first) => {
        std::thread::sleep(std::time::Duration::from_millis(1));
        let mut batch = vec![first];
        let mut jobs = lifecycle
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while matches!(jobs.front(), Some(LifecycleJob::AgentTeardown(_))) {
            if let Some(LifecycleJob::AgentTeardown(job)) = jobs.pop_front() {
                batch.push(job);
            }
        }
        drop(jobs);
        lifecycle.capacity_available.notify_waiters();
        lifecycle
            .agent_batches
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        let requests: Vec<_> = batch
            .iter()
            .map(|job| (job.pid, job.child_start))
            .collect();
        let results = crate::agent::kill_agent_groups_verified(&requests);
        for (job, result) in batch.into_iter().zip(results) {
            let _ = job.completion.send(result);
        }
    }
}
```

Notify async capacity waiters whenever jobs are popped from the queue.

- [ ] **Step 3: Preserve existing closure APIs over the typed queue**

Change `try_enqueue_teardown` to accept/return `LifecycleJob`, wrap ordinary
closures in `LifecycleJob::Teardown`, and retain the current inline fallback
only for the existing synchronous `run_teardown` API.

- [ ] **Step 4: Add async bounded agent admission and stats**

Use `Notify` with the notification future created before each admission attempt
to avoid a missed-capacity wakeup:

```rust
pub async fn run_agent_teardown_and_wait(
    pid: u32,
    child_start: Option<StartTime>,
) -> Option<std::io::Result<()>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut job = LifecycleJob::AgentTeardown(AgentTeardownJob {
        pid,
        child_start,
        completion: tx,
    });
    loop {
        let available = lifecycle().capacity_available.notified();
        match try_enqueue_teardown(job) {
            None => {
                lifecycle()
                    .agent_requests
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                break;
            }
            Some(rejected) => {
                job = rejected;
                available.await;
            }
        }
    }
    rx.await.ok()
}

pub fn agent_teardown_stats() -> (u64, u64) {
    let lifecycle = lifecycle();
    (
        lifecycle
            .agent_requests
            .load(std::sync::atomic::Ordering::Relaxed),
        lifecycle
            .agent_batches
            .load(std::sync::atomic::Ordering::Relaxed),
    )
}
```

- [ ] **Step 5: Run the concurrent test and verify it still fails for wiring**

Run:

```bash
cargo test -p kanna-daemon concurrent_agent_kills_keep_the_runtime_responsive -- --nocapture
```

Expected: the test compiles but times out waiting for agent teardown admissions
because `kill_agent_session` still uses `spawn_blocking`.

### Task 4: Route agent session teardown through the batch

**Files:**
- Modify: `crates/daemon/src/agent_runtime/lifecycle.rs:70`

- [ ] **Step 1: Replace `spawn_blocking` with lifecycle admission**

Replace the ad-hoc blocking job with:

```rust
let group_kill =
    kanna_daemon::reaper::run_agent_teardown_and_wait(record.pid, record.child_start).await;
match group_kill {
    Some(Err(error)) => super::log_info(format_args!(
        "[agent] kill {}: group signal refused: {}",
        session_id, error
    )),
    None => super::log_info(format_args!(
        "[agent] kill {}: lifecycle executor stopped before group teardown completed",
        session_id
    )),
    Some(Ok(())) => {}
}
```

Remove the now-unused `self` import from `kanna_daemon::agent`.

- [ ] **Step 2: Run the concurrent regression and verify GREEN**

Run:

```bash
cargo test -p kanna-daemon concurrent_agent_kills_keep_the_runtime_responsive -- --nocapture
```

Expected: PASS with 24 admitted requests, one lifecycle batch, and a nonzero
heartbeat.

- [ ] **Step 3: Run the daemon unit suite**

Run:

```bash
cargo test -p kanna-daemon --lib
```

Expected: PASS.

### Task 5: Refactor, format, and verify

**Files:**
- Modify: `crates/daemon/src/agent.rs`
- Modify: `crates/daemon/src/reaper.rs`
- Modify: `crates/daemon/src/agent_runtime/lifecycle.rs`
- Modify: `crates/daemon/src/tests.rs`

- [ ] **Step 1: Refactor only after green**

Remove duplicated kill logic, make queue/batch comments match actual behavior,
and ensure no lifecycle lock is held during process scanning or result delivery.

- [ ] **Step 2: Format and inspect**

Run:

```bash
cargo fmt --all
git diff --check
git diff --stat
```

Expected: clean formatting and no whitespace errors.

- [ ] **Step 3: Run Clippy for the daemon**

Run:

```bash
cargo clippy -p kanna-daemon --all-targets -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 4: Run canonical Rust verification**

Run:

```bash
./kd test rust
```

Expected: all workspace Rust tests pass.

- [ ] **Step 5: Commit the implementation**

```bash
git add crates/daemon/src/agent.rs \
  crates/daemon/src/reaper.rs \
  crates/daemon/src/agent_runtime/lifecycle.rs \
  crates/daemon/src/tests.rs \
  docs/superpowers/plans/2026-07-26-batched-agent-teardown.md
git commit -m "fix(daemon): batch concurrent agent teardown scans"
```
