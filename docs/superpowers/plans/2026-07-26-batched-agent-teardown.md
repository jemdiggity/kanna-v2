# Batched Agent Teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route concurrent agent kills through one bounded lifecycle executor job that shares process-table snapshots across the kill batch.

**Architecture:** Retarget above the finalized agent-incarnation prerequisite
at `4f10ee48` while keeping its finalized central bounded lifecycle executor
from `541717e2` unchanged. Add an agent-specific pending-request coalescer that
admits one opaque lifecycle job per concurrent burst, then freezes every valid
leader, uses `freeze_many` for shared discovery rounds, strikes each group
independently, and returns results through per-request one-shot channels.

**Tech Stack:** Rust, Tokio one-shot channels, macOS libproc process discovery, and `kanna_daemon::reaper::{try_run_teardown, run_teardown}`.

---

### Task 1: Add the failing concurrent-kill batching regression

**Files:**
- Modify: `crates/daemon/src/tests.rs`

- [x] **Step 1: Add a real-child test with a lifecycle gate and counters**

Spawn 24 real agent records. Enqueue an ordinary lifecycle job that waits on an
atomic release flag, record `agent_teardown_stats()`, spawn all kills, and wait
until all requests have reached the coalescer before releasing the gate.

After joining all kills, assert a nonzero heartbeat plus deltas of 24 requests,
one lifecycle job, and one shared process-snapshot batch.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p kanna-daemon concurrent_agent_kills_share_one_lifecycle_job_and_snapshot_batch -- --nocapture
```

Observed: compilation failed because `agent_teardown_stats` did not exist.

### Task 2: Add a batched identity-safe agent kill

**Files:**
- Modify: `crates/daemon/src/agent.rs:699`

- [x] **Step 1: Add the internal plan representation**

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

- [x] **Step 2: Add batch execution and make the scalar API delegate**

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

- [x] **Step 3: Add focused batch independence coverage**

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

- [x] **Step 4: Run the focused agent tests**

Run:

```bash
cargo test -p kanna-daemon verified_group_kill -- --nocapture
```

Observed: the ordered/independent batch regression passed.

### Task 3: Add agent batching above the central lifecycle executor

**Files:**
- Modify: `crates/daemon/src/agent.rs`

- [x] **Step 1: Add one shared pending-request coalescer**

Store pending pid/start identities and one-shot completion senders behind a
short synchronous mutex. Track whether one lifecycle job is already scheduled.
The first request schedules; concurrent requests only join the pending batch.

- [x] **Step 2: Admit the shared closure through the supplied API**

Call `try_run_teardown` for the first request. On `Full(job)`, retain that same
owned closure through async `run_teardown(job)` backpressure. The closure waits
one millisecond, drains pending requests, invokes
`kill_agent_groups_verified`, delivers ordered results, and repeats if more
requests arrived during the scan.

- [x] **Step 3: Add request, batch, and lifecycle-job diagnostics**

Expose `agent_teardown_stats() -> (u64, u64, u64)` for the real-child
regression.

### Task 4: Route agent session teardown through the batch

**Files:**
- Modify: `crates/daemon/src/agent_runtime/lifecycle.rs:70`

- [x] **Step 1: Replace the per-kill lifecycle closure**

Call `agent::kill_agent_group_batched(record.pid, record.child_start).await`
and retain the existing owned-child fallback/reaper handoff.

- [x] **Step 2: Run the concurrent regression and verify GREEN**

Run:

```bash
cargo test -p kanna-daemon concurrent_agent_kills_share_one_lifecycle_job_and_snapshot_batch -- --nocapture
```

Observed: PASS with 24 requests, one lifecycle job, one batch, and a nonzero
heartbeat.

- [x] **Step 3: Mutation-test lifecycle-job coalescing**

Temporarily force every request to schedule a lifecycle job. The regression
must fail with 24 jobs instead of one; restore the coalescer and verify green.

- [x] **Step 4: Run the daemon unit suite**

Run:

```bash
cargo test -p kanna-daemon --lib
```

Observed after retargeting above `4f10ee48`: 144 passed, 0 failed.

### Task 5: Refactor, format, and verify

**Files:**
- Modify: `crates/daemon/src/agent.rs`
- Modify: `crates/daemon/src/agent_runtime/lifecycle.rs`
- Modify: `crates/daemon/src/tests.rs`

- [x] **Step 1: Refactor only after green**

Remove duplicated kill logic, make queue/batch comments match actual behavior,
and ensure no lifecycle lock is held during process scanning or result delivery.

- [x] **Step 2: Format and inspect**

Run:

```bash
cargo fmt --all
git diff --check
git diff --stat
```

Observed: `cargo fmt --all` completed, `git diff --check` was clean, and the
central `crates/daemon/src/reaper.rs` dependency had no task-local diff.

- [x] **Step 3: Run Clippy for the daemon**

Run:

```bash
cargo clippy -p kanna-daemon --all-targets -- -D warnings
```

Observed on the earlier `7d7a7cab` checkpoint: PASS with no warnings. On the
finalized `4f10ee48` prerequisite, all-target Clippy reaches one pre-existing
`clippy::question_mark` finding in
`crates/daemon/src/agent_runtime/readers.rs`; this task does not modify that
reader path.

- [x] **Step 4: Run canonical Rust verification**

Run:

```bash
CARGO_INCREMENTAL=0 ./kd test rust
```

Observed after retargeting above `4f10ee48`: PASS. Protocol/type generation,
the desktop production build, all six staged sidecars, the workspace suites,
144 daemon library tests, 161 daemon binary tests, and all 32 reconnect tests
completed successfully. Incremental compilation remained disabled to limit
disk pressure from concurrent worktrees.

- [x] **Step 5: Commit the implementation**

```bash
git add crates/daemon/src/agent.rs \
  crates/daemon/src/agent_runtime/lifecycle.rs \
  crates/daemon/src/tests.rs \
  docs/superpowers/plans/2026-07-26-batched-agent-teardown.md \
  docs/superpowers/specs/2026-07-26-batched-agent-teardown-design.md
git commit -m "fix(daemon): batch concurrent agent teardown scans"
```
