# Daemon Process-Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port identity-safe process teardown, a bounded central reaper, agent-session incarnation fencing, and transactional daemon handoff onto current `main` as four independently reviewable production commits.

**Architecture:** Stack the already-reviewed descriptor/session-id prerequisites exactly, then port one lifecycle layer at a time from `hardening-daemon-lifecycle-eb76b59d`. Each layer starts with focused failing regressions, is mutation-verified, and is committed before the next layer begins. The old tag supplies behavior and test fixtures, but current-main lifecycle boundaries remain authoritative.

**Tech Stack:** Rust, Tokio, macOS `libproc`, Unix signals/process groups, PTYs, Unix-domain sockets, SCM_RIGHTS, `./kd test rust`

---

## File Structure

- Create `crates/daemon/src/proc_info.rs`: macOS process identity,
  ancestry/TTY discovery, verified stop/signal, pipe and socket provenance.
- Create `crates/daemon/src/reaper.rs`: bounded one-owner child reaper and
  bounded asynchronous lifecycle work admission.
- Modify `crates/daemon/src/pty.rs`: carry child start time and tty identity;
  build identity-safe kill plans; hand bare child identities to the reaper.
- Modify `crates/daemon/src/session.rs`: integrate PTY kill plans with current
  per-id lifecycle locks and current-main retired handles.
- Modify `crates/daemon/src/agent.rs`: process identity, incarnation allocator,
  shared sequencer/publication state, handoff descriptor metadata.
- Modify `crates/daemon/src/agent_runtime.rs`: single-flight agent handoff seal.
- Modify `crates/daemon/src/agent_runtime/{commands,lifecycle,readers,adoption}.rs`:
  exact-life reservations, reader fences, teardown tombstones, authenticated
  adoption, ordered Exit publication.
- Modify `crates/daemon/src/{handoff,fd_transfer,connection,startup,output}.rs`:
  transactional seal/claims, descriptor authentication, and adoption
  reconciliation without changing SCM_RIGHTS framing.
- Modify `crates/daemon/src/tests.rs`: focused in-process concurrency,
  lifecycle, mutation, and handoff regressions.
- Modify `crates/daemon/tests/{agent_sessions,handoff}.rs`: daemon-level agent
  EOF/teardown and old-daemon/adopter reconciliation coverage.

### Task 1: Stack the Exact Prerequisites

**Files:**
- Existing commits only: `1027b7bf`, `1293308d`

- [ ] **Step 1: Confirm the prerequisite tips and clean worktree**

Run:

```bash
git show --no-patch --oneline 1027b7bf 1293308d
git status --short
```

Expected: both commits resolve and the worktree is clean.

- [ ] **Step 2: Cherry-pick the exact commits**

Run:

```bash
git cherry-pick 1027b7bf 1293308d
```

Expected: two commits are added unchanged after the design/plan commits.

- [ ] **Step 3: Verify the prerequisite regressions**

Run:

```bash
cargo test -p kanna-daemon \
  spawned_children_do_not_inherit_prior_sessions_pty_masters \
  -- --test-threads=1 --nocapture
cargo test -p kanna-daemon \
  an_unterminated_legacy_journal_survives_append_and_repeated_reopen \
  -- --test-threads=1 --nocapture
```

Expected: both focused filters pass.

### Task 2: Add Process Identity and Verified Signalling Tests

**Files:**
- Create: `crates/daemon/src/proc_info.rs`
- Modify: `crates/daemon/src/lib.rs`
- Modify: `crates/daemon/src/tests.rs`
- Modify: `crates/daemon/src/pty.rs`

- [ ] **Step 1: Add failing identity and PTY teardown regressions**

Port and adapt these test behaviors from the tag:

```rust
#[test]
fn signal_verified_refuses_stale_identity_and_accepts_current() {
    let child = spawn_sleeping_child();
    let info = process_info(child.id() as libc::pid_t).expect("child identity");
    assert!(!signal_verified(
        SessionTarget { start: (info.start.0, info.start.1 + 1), ..info.into() },
        libc::SIGTERM,
    ));
    assert!(signal_verified(info.into(), libc::SIGTERM));
}

#[test]
fn stop_verified_rolls_back_when_target_changes_inside_the_window() {
    let target = current_child_target();
    assert!(!stop_verified_with(target, |_pid| false));
    assert_process_is_not_stopped(target.pid);
}

#[test]
fn kill_terminates_descendants_that_escape_with_setsid() {
    let (session, escaped_pid) = spawn_pty_with_setsid_descendant();
    session.kill().expect("kill session tree");
    assert_dies_within(escaped_pid, Duration::from_secs(5), "setsid descendant");
}

#[test]
fn kill_reaches_detached_grandchildren_behind_on_terminal_intermediates() {
    let (session, detached_grandchild) = spawn_terminal_intermediate_fixture();
    session.kill().expect("kill session tree");
    assert_dies_within(
        detached_grandchild,
        Duration::from_secs(5),
        "tty-linked grandchild",
    );
}
```

- [ ] **Step 2: Run the tests and observe RED**

Run:

```bash
cargo test -p kanna-daemon signal_verified_refuses_stale_identity \
  -- --test-threads=1 --nocapture
cargo test -p kanna-daemon kill_terminates_descendants_that_escape_with_setsid \
  -- --test-threads=1 --nocapture
```

Expected: compilation fails because `proc_info` and identity-aware teardown do
not exist, or the teardown regression leaves the escaped child alive.

- [ ] **Step 3: Implement the process identity boundary**

Create these public types and entry points in `proc_info.rs`:

```rust
pub type StartTime = (u64, u64);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ProcessIdentity {
    pub pid: libc::pid_t,
    pub start: StartTime,
}

#[derive(Clone, Copy, Debug)]
pub struct ProcessInfo {
    pub pid: libc::pid_t,
    pub ppid: libc::pid_t,
    pub pgid: libc::pid_t,
    pub sid: libc::pid_t,
    pub tty_dev: Option<u32>,
    pub start: StartTime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionTarget {
    pub pid: libc::pid_t,
    pub pgid: libc::pid_t,
    pub start: StartTime,
}

pub fn process_info(pid: libc::pid_t) -> Option<ProcessInfo>;
pub fn all_process_info() -> Vec<ProcessInfo>;
pub fn identity_matches(identity: ProcessIdentity) -> bool;
pub fn identity_alive(identity: ProcessIdentity) -> bool;
pub fn stop_verified(target: SessionTarget) -> bool;
pub fn signal_verified(target: SessionTarget, sig: libc::c_int) -> bool;
pub fn kill_process_verified(target: SessionTarget) -> bool;
pub fn freeze_many(
    specs: &[(Option<SessionTarget>, Option<u32>)],
) -> Vec<Vec<SessionTarget>>;
pub fn freeze_session_processes(
    leader: Option<SessionTarget>,
    tty_dev: Option<u32>,
) -> Vec<SessionTarget>;
```

The macOS implementation uses `proc_listpids`, `proc_pidinfo`, and
`proc_pidfdinfo`. Non-macOS implementations return `None`/empty collections and
must never claim an identity or descriptor is authenticated.

- [ ] **Step 4: Thread identity through PTY signal/kill paths**

Extend `PtySession` with captured start time and tty slave device. Replace bare
pid signalling with a plan:

```rust
pub struct PtyKillPlan {
    child: Option<ProcessIdentity>,
    leader: Option<SessionTarget>,
    tty_dev: Option<u32>,
    reap: Option<ProcessIdentity>,
}

impl PtyKillPlan {
    pub fn execute(self, table: Option<&[ProcessInfo]>) -> io::Result<()>;
    pub fn execute_batch(plans: Vec<Self>) -> Vec<io::Result<()>>;
}
```

`PtySession::signal` must refuse adopted/unverified targets. `begin_kill`
claims child ownership once, freezes the verified target set, signals every
member, resumes stopped survivors, and leaves reaping to the later reaper
layer.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
cargo test -p kanna-daemon proc_info::tests -- --test-threads=1 --nocapture
cargo test -p kanna-daemon kill_terminates -- --test-threads=1 --nocapture
cargo test -p kanna-daemon adopted_sessions_refuse_non_destructive_signals \
  -- --test-threads=1 --nocapture
```

Expected: all focused identity and descendant tests pass.

- [ ] **Step 6: Mutation-verify identity safety**

Temporarily make `identity_matches` compare only the pid and run:

```bash
cargo test -p kanna-daemon signal_verified_refuses_stale_identity \
  -- --test-threads=1 --nocapture
```

Expected: FAIL because the stale identity is signalled.

Restore the start-time comparison. Then temporarily omit the TTY sweep from
`freeze_session_processes` and run:

```bash
cargo test -p kanna-daemon \
  kill_reaches_detached_grandchildren_behind_on_terminal_intermediates \
  -- --test-threads=1 --nocapture
```

Expected: FAIL because the detached grandchild survives. Restore the sweep and
rerun both tests to PASS.

- [ ] **Step 7: Commit identity-safe signalling**

Run:

```bash
git add crates/daemon/src/proc_info.rs crates/daemon/src/lib.rs \
  crates/daemon/src/pty.rs crates/daemon/src/session.rs \
  crates/daemon/src/agent.rs crates/daemon/src/agent_runtime/lifecycle.rs \
  crates/daemon/src/tests.rs
git commit -m "fix(daemon): make process teardown identity-safe"
```

### Task 3: Build a Truly Bounded Nonblocking Reaper

**Files:**
- Create: `crates/daemon/src/reaper.rs`
- Modify: `crates/daemon/src/lib.rs`
- Modify: `crates/daemon/src/pty.rs`
- Modify: `crates/daemon/src/session.rs`
- Modify: `crates/daemon/src/agent_runtime/readers.rs`
- Test: `crates/daemon/src/reaper.rs`
- Test: `crates/daemon/src/tests.rs`

- [ ] **Step 1: Add failing ownership, capacity, and cadence tests**

Add tests with a test-local small-cap reaper constructor:

```rust
#[test]
fn admission_never_blocks_and_total_depth_never_exceeds_cap() {
    let reaper = TestReaper::new(2);
    let first = reaper.admit(stubborn_child()).expect("first");
    let second = reaper.admit(stubborn_child()).expect("second");
    let began = Instant::now();
    let rejected = reaper.admit(stubborn_child());
    assert!(began.elapsed() < Duration::from_millis(50));
    assert!(matches!(rejected, Err(AdmissionError::Full(_))));
    assert_eq!(reaper.stats().outstanding, 2);
    drop((first, second));
}

#[test]
fn a_recycled_pid_is_admitted_as_its_own_reap_identity() {
    let reaper = TestReaper::new(4);
    assert!(reaper.track_for_test((42, Some((1, 1)))));
    assert!(reaper.track_for_test((42, Some((1, 2)))));
}

#[test]
fn a_fresh_admission_does_not_reset_a_survivors_deadline() {
    let reaper = TestReaper::new(8);
    let stubborn = reaper.admit(stubborn_child()).expect("admit");
    flood_fresh_exited_children(&reaper, Duration::from_secs(1));
    assert!(stubborn.was_escalated_before(Duration::from_secs(1)));
}
```

- [ ] **Step 2: Run and observe RED**

Run:

```bash
cargo test -p kanna-daemon reaper::tests::admission_never_blocks \
  -- --test-threads=1 --nocapture
cargo test -p kanna-daemon reaper::tests::a_recycled_pid \
  -- --test-threads=1 --nocapture
```

Expected: compilation fails because the reaper module and admission result do
not exist.

- [ ] **Step 3: Implement bounded admission and per-entry scheduling**

Use these externally visible types:

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ReapIdentity {
    pub pid: libc::pid_t,
    pub start: Option<StartTime>,
}

pub enum ReapOwnership {
    Child {
        child: std::process::Child,
        identity: ReapIdentity,
    },
    Pid(ReapIdentity),
}

pub enum AdmissionError {
    Duplicate(ReapOwnership),
    Full(ReapOwnership),
}

#[derive(Clone, Copy, Debug)]
pub struct ReaperStats {
    pub accepted: u64,
    pub reaped: u64,
    pub queued: usize,
    pub in_flight: usize,
    pub capacity: usize,
}

pub fn try_reap(ownership: ReapOwnership) -> Result<(), AdmissionError>;
pub async fn reap(ownership: ReapOwnership);
pub fn try_reap_child(
    child: std::process::Child,
    start: Option<StartTime>,
) -> Result<(), AdmissionError>;
pub fn try_reap_pid(identity: ReapIdentity) -> Result<(), AdmissionError>;
pub fn stats() -> ReaperStats;
```

Reserve a capacity permit under a short mutex before returning success. The
permit remains held while an entry is queued or in flight and is released only
after reaping. The owner thread uses a min-heap keyed by each entry's
`next_check` and `escalate_at`; new work wakes a condition variable but does not
rewrite survivor deadlines.

When the primary queue is full, return the still-owned handle immediately.
Callers enqueue that ownership onto the bounded asynchronous lifecycle
backpressure path; no caller calls `wait`, performs a process scan, or blocks on
queue space.

Expose lifecycle work without doing task `1161fa5d`'s batching:

```rust
pub type TeardownJob = Box<dyn FnOnce() + Send + 'static>;

pub enum TeardownAdmission {
    Accepted,
    Full(TeardownJob),
}

pub fn try_run_teardown(job: TeardownJob) -> TeardownAdmission;
pub async fn run_teardown(job: TeardownJob);
pub async fn run_teardown_and_wait<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Option<T>;
pub fn lifecycle_stats() -> (usize, usize);
```

`try_run_teardown` is the nonblocking primitive. `run_teardown` waits for
capacity with `tokio::sync::Notify`, retaining the rejected job across awaits;
it never executes the scan inline. `run_teardown_and_wait` uses that async
admission and a oneshot for completion.

- [ ] **Step 4: Integrate every reap owner**

Replace `session.rs::reap_child_in_background`, agent reader detached wait
threads, and PTY bare-pid polling with `try_reap_child`/`try_reap_pid`.
Duplicate/full results must retain ownership and route to the bounded fallback;
they must never drop a `Child`.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
cargo test -p kanna-daemon reaper::tests -- --test-threads=1 --nocapture
cargo test -p kanna-daemon \
  lingering_child_after_stdout_eof_is_reaped_without_wedging_the_registry \
  -- --test-threads=1 --nocapture
```

Expected: bounded admission, escalation, identity deduplication, and agent/PTY
reaping tests pass.

- [ ] **Step 6: Mutation-verify all four review fixes**

Perform and restore these mutations one at a time:

1. omit `in_flight` from permit/depth accounting;
2. hash only `pid` in `ReapIdentity`;
3. use blocking `send` instead of nonblocking admission;
4. reset every survivor's `next_check` when fresh work arrives.

Run the matching focused test after each mutation. Expected: each test FAILS
for its named invariant. Restore production code and rerun
`reaper::tests` to PASS.

- [ ] **Step 7: Commit the central reaper**

Run:

```bash
git add crates/daemon/src/reaper.rs crates/daemon/src/lib.rs \
  crates/daemon/src/pty.rs crates/daemon/src/session.rs \
  crates/daemon/src/agent_runtime/readers.rs crates/daemon/src/tests.rs
git commit -m "fix(daemon): centralize bounded child reaping"
git rev-parse HEAD
```

- [ ] **Step 8: Notify dependent task `1161fa5d`**

Capture the exact hash and send these API notes through `kanna_send_task_input`
or the CLI fallback:

```bash
reaper_commit=$(git rev-parse HEAD)
kanna-cli task send-input --task-id 1161fa5d --message \
  "Central reaper commit: ${reaper_commit}. Use try_run_teardown, run_teardown, \
and run_teardown_and_wait for bounded lifecycle admission. The try API never \
blocks; the async APIs retain rejected jobs and wait for capacity without \
running scans on a Tokio worker. Reap dedup keys on ReapIdentity(pid,start); \
stats include queued plus in-flight capacity. Your task still owns agent \
teardown batching and shared process snapshots."
```

### Task 4: Add Agent Incarnation and Publication Regressions

**Files:**
- Modify: `crates/daemon/src/agent.rs`
- Modify: `crates/daemon/src/agent_runtime.rs`
- Modify: `crates/daemon/src/agent_runtime/{commands,lifecycle,readers}.rs`
- Modify: `crates/daemon/src/connection.rs`
- Test: `crates/daemon/src/tests.rs`
- Test: `crates/daemon/tests/agent_sessions.rs`

- [ ] **Step 1: Add failing exact-life and fanout regressions**

Port these named tests from the tag and adapt them to current helpers:

```rust
#[tokio::test]
async fn stale_installer_from_previous_life_cannot_take_over_recreated_session();

#[tokio::test]
async fn teardown_tombstone_blocks_same_id_replacement_until_cleanup_completes();

#[tokio::test]
async fn concurrent_lives_of_one_session_id_share_one_sequence_space();

#[tokio::test]
async fn a_stale_lifes_output_never_reaches_the_replacements_clients();

#[tokio::test]
async fn killing_an_initial_reservation_emits_exactly_one_exit();

#[tokio::test]
async fn killing_an_idle_per_turn_session_emits_exactly_one_exit();
```

Add an integration fixture whose stdout closes before delayed stderr:

```rust
#[test]
fn stdout_eof_waits_for_stderr_before_final_exit() {
    // fake agent: close stdout; sleep; emit a stderr line; exit
    // assert stderr is journaled/fanned out before the only Exit.
}
```

- [ ] **Step 2: Run and observe RED**

Run:

```bash
cargo test -p kanna-daemon stale_installer_from_previous_life \
  -- --test-threads=1 --nocapture
cargo test -p kanna-daemon a_stale_lifes_output_never_reaches \
  -- --test-threads=1 --nocapture
cargo test -p kanna-daemon stdout_eof_waits_for_stderr \
  -- --test-threads=1 --nocapture
```

Expected: stale work mutates the replacement, stale output reaches shared
writers, or Exit precedes delayed stderr.

- [ ] **Step 3: Introduce never-reused incarnations and shared sequencers**

Add:

```rust
pub type AgentIncarnation = u64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitPublication {
    Unclaimed,
    Publishing(AgentIncarnation),
    Published,
}

pub struct AgentShared {
    pub journal: AgentJournal,
    pub writers: Vec<AgentClientWriter>,
    pub next_incarnation: AgentIncarnation,
    pub exit_publication: ExitPublication,
}

pub struct AgentLife {
    pub incarnation: AgentIncarnation,
    pub shared: Arc<Mutex<AgentShared>>,
}
```

Allocation increments under the per-session shared-state lock and never
reuses a token. Weak shared-state registry entries are removed after the last
life drops.

- [ ] **Step 4: Fence reservations, installs, readers, and teardown**

Every async plan captures `AgentLife`. Registry mutation uses
`is_current_life(session_id, incarnation)`. Removal installs a tombstone before
dropping the record and clears it only after child/process cleanup and Exit
publication complete.

Reader processing uses:

```rust
enum ReaderDisposition {
    JournalAndFanout,
    JournalOnly,
}
```

The reader appends through the shared sequencer in both cases, but only
`JournalAndFanout` touches `writers`, status, broadcast, or pending permission
state.

- [ ] **Step 5: Make Exit publication a single-owner transaction**

Implement exact-life claim/complete helpers:

```rust
fn claim_exit_publication(
    shared: &mut AgentShared,
    incarnation: AgentIncarnation,
) -> bool;

fn complete_exit_publication(
    shared: &mut AgentShared,
    incarnation: AgentIncarnation,
);
```

Do not set `Published` until the terminal journal event, agent fanout, status
change, and daemon `Event::Exit` have all succeeded or been deliberately
accounted for. Coordinate stdout and stderr readers with a two-reader completion
count; neither EOF alone finalizes the life.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
cargo test -p kanna-daemon stale_ -- --test-threads=1 --nocapture
cargo test -p kanna-daemon exactly_one_exit -- --test-threads=1 --nocapture
cargo test -p kanna-daemon stdout_eof_waits_for_stderr \
  -- --test-threads=1 --nocapture
```

Expected: all incarnation, stale-reader, sequencing, tombstone, and publication
tests pass.

- [ ] **Step 7: Mutation-verify incarnation regressions**

One at a time:

1. let stale readers fan out after journaling;
2. reuse incarnation `0` for recreated sessions;
3. mark `Published` before fanout/daemon Exit;
4. finalize on stdout EOF without waiting for stderr.

Run the matching focused regression and observe FAIL, then restore and rerun to
PASS.

- [ ] **Step 8: Commit agent incarnations**

Run:

```bash
git add crates/daemon/src/agent.rs crates/daemon/src/agent_runtime.rs \
  crates/daemon/src/agent_runtime/commands.rs \
  crates/daemon/src/agent_runtime/lifecycle.rs \
  crates/daemon/src/agent_runtime/readers.rs \
  crates/daemon/src/connection.rs crates/daemon/src/tests.rs \
  crates/daemon/tests/agent_sessions.rs
git commit -m "fix(daemon): fence agent session incarnations"
```

### Task 5: Add Transactional Handoff Regressions

**Files:**
- Modify: `crates/daemon/src/handoff.rs`
- Modify: `crates/daemon/src/fd_transfer.rs`
- Modify: `crates/daemon/src/agent.rs`
- Modify: `crates/daemon/src/agent_runtime.rs`
- Modify: `crates/daemon/src/agent_runtime/{adoption,commands,lifecycle,readers}.rs`
- Modify: `crates/daemon/src/{connection,output,protocol,pty,session,startup}.rs`
- Test: `crates/daemon/src/tests.rs`
- Test: `crates/daemon/tests/handoff.rs`

- [ ] **Step 1: Add failing transaction and provenance tests**

Port/adapt:

```rust
#[tokio::test]
async fn sealed_registry_rejects_in_flight_installs_until_unsealed();

#[tokio::test]
async fn a_pty_exit_during_a_sealed_handoff_defers_to_the_transfer_outcome();

#[tokio::test]
async fn a_seal_beginning_inside_the_exit_window_still_defers_the_exit();

#[tokio::test]
async fn forged_agent_handoff_cannot_target_unrelated_processes();

#[test]
fn pty_descriptor_authentication_binds_a_master_to_its_own_child();

#[test]
fn only_a_real_pty_master_authenticates_as_a_pty_slot();

#[test]
fn test_adopter_publishes_only_after_delayed_old_daemon_exits();
```

Add a new single-flight regression:

```rust
#[tokio::test]
async fn only_the_handoff_owner_can_commit_or_rollback_the_seal() {
    let first = begin_handoff().await.expect("first owner");
    assert!(matches!(begin_handoff().await, Err(HandoffBusy)));
    assert!(!rollback_handoff(forged_owner_token()));
    assert!(registry_is_sealed());
    assert!(rollback_handoff(first.owner));
    assert!(!registry_is_sealed());
}
```

- [ ] **Step 2: Run and observe RED**

Run:

```bash
cargo test -p kanna-daemon only_the_handoff_owner \
  -- --test-threads=1 --nocapture
cargo test -p kanna-daemon pty_descriptor_authentication \
  -- --test-threads=1 --nocapture
cargo test -p kanna-daemon forged_agent_handoff \
  -- --test-threads=1 --nocapture
```

Expected: ownership API is absent and forged/cross-session descriptors are
accepted by the pre-hardening path.

- [ ] **Step 3: Implement owner-token seals and exact claims**

Add:

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct HandoffOwner(u128);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HandoffEpoch(u64);

pub struct HandoffTransaction {
    pub owner: HandoffOwner,
    pub epoch: HandoffEpoch,
    pub pty_claims: Vec<PtyHandoffClaim>,
    pub agent_claims: Vec<AgentHandoffClaim>,
}
```

`begin_handoff` atomically rejects a second owner, seals both registries, and
captures exact handles/incarnations plus Exit-publication state. `commit` and
`rollback` compare the owner token and epoch before changing registry state.
Dropping an uncommitted transaction rolls back only its own seal.

- [ ] **Step 4: Authenticate descriptor provenance**

Use `proc_info` helpers:

```rust
pub enum PipeEnd {
    Read,
    Write,
}

pub fn pipe_end_belongs_to(
    fd: RawFd,
    child: ProcessIdentity,
    expected: PipeEnd,
) -> bool;

pub fn slave_device_of_master(master_fd: RawFd) -> Option<u32>;
pub fn socket_peer_pid(socket_fd: RawFd) -> Option<libc::pid_t>;
```

An agent bundle is all-or-nothing: stdout/stderr are daemon-readable pipe ends,
stdin is daemon-writable, and every peer end belongs to the exact child
identity. A PTY master must resolve to the slave tty device owned by the exact
claimed child.

- [ ] **Step 5: Reconcile exits and preserve publication state**

Include exact incarnation and `ExitPublication` in in-memory transfer metadata.
Before ACK, revalidate old-daemon identity and every claim. Adoption must:

- discard a claim known to have naturally exited;
- resume unfinished publication exactly once;
- preserve `Published` without rebroadcasting Exit;
- defer the new reader until old ownership has crossed the ACK/connection-close
  barrier.

Keep `send_fds`/`recv_fds` as one aggregate message. Do not add loops that
accumulate multiple SCM_RIGHTS messages.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
cargo test -p kanna-daemon handoff -- --test-threads=1 --nocapture
cargo test -p kanna-daemon descriptor_authentication \
  -- --test-threads=1 --nocapture
cargo test -p kanna-daemon adopter_publishes_only \
  -- --test-threads=1 --nocapture
```

Expected: transaction ownership, exact claims, provenance, and exit
reconciliation tests pass.

- [ ] **Step 7: Mutation-verify handoff**

One at a time:

1. accept rollback without matching the owner token;
2. authenticate only descriptor type/direction, not child identity;
3. drop transferred Exit-publication state;
4. adopt before the old-daemon ownership barrier.

Run each corresponding focused regression and observe FAIL. Restore and rerun
the handoff filters to PASS.

- [ ] **Step 8: Guard against forbidden wire chunking**

Run:

```bash
git diff 1293308d..HEAD -- crates/daemon/src/fd_transfer.rs \
  | rg -n "chunk|accumul|multiple.*message|recv.*loop" && exit 1 || true
```

Expected: no newly added multi-message send/receive accumulation.

- [ ] **Step 9: Commit transactional handoff**

Run:

```bash
git add crates/daemon/src/handoff.rs crates/daemon/src/fd_transfer.rs \
  crates/daemon/src/agent.rs crates/daemon/src/agent_runtime.rs \
  crates/daemon/src/agent_runtime/adoption.rs \
  crates/daemon/src/agent_runtime/commands.rs \
  crates/daemon/src/agent_runtime/lifecycle.rs \
  crates/daemon/src/agent_runtime/readers.rs \
  crates/daemon/src/connection.rs crates/daemon/src/output.rs \
  crates/daemon/src/protocol.rs crates/daemon/src/pty.rs \
  crates/daemon/src/session.rs crates/daemon/src/startup.rs \
  crates/daemon/src/tests.rs crates/daemon/tests/handoff.rs
git commit -m "fix(daemon): make session handoff transactional"
```

### Task 6: Release Handoff-Dependent Child Tasks

**Tasks:**
- `aa0ecc72`: successor peer authentication
- `1ec192c7`: retryable sealed-window consumer contract

- [ ] **Step 1: Send the transactional base to both child tasks**

Run:

```bash
handoff_commit=$(git rev-parse HEAD)
kanna-cli task send-input --task-id aa0ecc72 --message \
  "Transactional handoff base is ready at ${handoff_commit}. Retarget your \
successor-authentication checkpoint onto this exact commit. Preserve the \
single-flight owner token and authenticate the successor before arming its \
seal or sending descriptors."
kanna-cli task send-input --task-id 1ec192c7 --message \
  "Transactional handoff base is ready at ${handoff_commit}. Retarget your \
sealed-window retry contract onto this exact commit. Preserve exact-incarnation \
claims and idempotent Exit publication across consumer retries."
```

Expected: both child sessions receive the exact base commit and scope notes.

- [ ] **Step 2: Confirm child task state**

Use `kanna_get_task` for both ids.

Expected: `parentTaskId` is `5f1fe24b`, and each task's terminal snippet
reflects the retarget instruction or subsequent work.

### Task 7: Full Verification and Commit-Series Audit

**Files:**
- Verify all changed daemon and documentation files

- [ ] **Step 1: Format and inspect**

Run:

```bash
cargo fmt --all -- --check
git diff --check origin/main...HEAD
git status --short
```

Expected: formatting and whitespace checks pass; no uncommitted changes.

- [ ] **Step 2: Run the supported Rust suite**

Run:

```bash
./kd test rust
```

Expected: PASS. If only `overflowing_subscriber_resyncs` or
`overflowing_observer_resyncs` flakes under load, rerun the exact supported
suite once and report both outputs without weakening those tests.

- [ ] **Step 3: Audit commit boundaries**

Run:

```bash
git log --oneline --reverse origin/main..HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- crates/daemon/src/fd_transfer.rs
```

Expected: the two prerequisite commits remain byte-identical; the four
production commits are separately reviewable; no SCM_RIGHTS multi-message
chunking appears.

- [ ] **Step 4: Review against related-task boundaries**

Confirm the branch does not implement:

```text
ff5b9da6: capability negotiation / cross-binary legacy-v2 policy
1ec192c7: retryable sealed-window consumer contract
aa0ecc72: successor peer authorization
1161fa5d: agent teardown batching/shared process snapshots
```

Expected: this branch exposes the lifecycle/reaper foundations but leaves those
features to their owners.
