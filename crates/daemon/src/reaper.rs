//! Central bounded ownership for child reaping and expensive teardown work.
//!
//! Admission is nonblocking and ownership is returned on saturation. A single
//! worker owns accepted children until they are reaped; per-entry deadlines
//! ensure new work cannot postpone escalation of an older survivor.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Condvar, Mutex, OnceLock, TryLockError};
use std::time::{Duration, Instant};

use crate::proc_info::StartTime;

const REAP_CAPACITY: usize = 4096;
const POLL_MIN: Duration = Duration::from_millis(20);
const POLL_MAX: Duration = Duration::from_millis(200);
const ESCALATE_AFTER: Duration = Duration::from_millis(400);

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ReapIdentity {
    pub pid: libc::pid_t,
    pub start: Option<StartTime>,
}

#[derive(Debug)]
pub enum ReapOwnership {
    Child {
        child: std::process::Child,
        identity: ReapIdentity,
    },
    Pid(ReapIdentity),
}

impl ReapOwnership {
    fn identity(&self) -> ReapIdentity {
        match self {
            Self::Child { child, identity } => ReapIdentity {
                pid: child.id() as libc::pid_t,
                start: identity.start,
            },
            Self::Pid(identity) => *identity,
        }
    }
}

#[derive(Debug)]
pub enum AdmissionError {
    Duplicate(ReapOwnership),
    Full(ReapOwnership),
}

impl AdmissionError {
    pub fn into_ownership(self) -> ReapOwnership {
        match self {
            Self::Duplicate(ownership) | Self::Full(ownership) => ownership,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ReaperStats {
    pub accepted: u64,
    pub reaped: u64,
    pub queued: usize,
    pub in_flight: usize,
    pub capacity: usize,
}

impl ReaperStats {
    pub fn outstanding(self) -> usize {
        self.queued + self.in_flight
    }
}

struct Pending {
    ownership: ReapOwnership,
    admitted_at: Instant,
    next_check: Instant,
    poll_delay: Duration,
    escalated: bool,
    schedule_id: u64,
}

#[derive(Default)]
struct ReaperState {
    entries: HashMap<ReapIdentity, Pending>,
    schedule: BinaryHeap<Reverse<(Instant, u64, ReapIdentity)>>,
    tracked: HashSet<ReapIdentity>,
    accepted: u64,
    reaped: u64,
    in_flight: usize,
    next_schedule_id: u64,
}

struct ReaperCore {
    state: Mutex<ReaperState>,
    wake: Condvar,
    capacity_ready: tokio::sync::Notify,
    capacity: usize,
}

#[derive(Clone)]
struct ReaperHandle {
    core: Arc<ReaperCore>,
}

impl ReaperHandle {
    fn new(capacity: usize, running: bool) -> Self {
        let handle = Self {
            core: Arc::new(ReaperCore {
                state: Mutex::new(ReaperState::default()),
                wake: Condvar::new(),
                capacity_ready: tokio::sync::Notify::new(),
                capacity,
            }),
        };
        if running {
            let core = Arc::clone(&handle.core);
            std::thread::Builder::new()
                .name("kanna-reaper".to_string())
                .spawn(move || reaper_loop(core))
                .expect("failed to start the child reaper");
        }
        handle
    }

    #[cfg(test)]
    fn new_for_test(capacity: usize) -> Self {
        Self::new(capacity, false)
    }

    #[cfg(test)]
    fn new_running_for_test(capacity: usize) -> Self {
        Self::new(capacity, true)
    }

    fn try_reap(&self, ownership: ReapOwnership) -> Result<(), AdmissionError> {
        let identity = ownership.identity();
        if identity.pid <= 1 {
            return Err(AdmissionError::Duplicate(ownership));
        }
        let mut state = match self.core.state.try_lock() {
            Ok(state) => state,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return Err(AdmissionError::Full(ownership)),
        };
        if state.tracked.contains(&identity) {
            return Err(AdmissionError::Duplicate(ownership));
        }
        if state.tracked.len() >= self.core.capacity {
            return Err(AdmissionError::Full(ownership));
        }

        let now = Instant::now();
        let schedule_id = state.next_schedule_id;
        state.next_schedule_id = state.next_schedule_id.wrapping_add(1);
        state.tracked.insert(identity);
        state.entries.insert(
            identity,
            Pending {
                ownership,
                admitted_at: now,
                next_check: now,
                poll_delay: POLL_MIN,
                escalated: false,
                schedule_id,
            },
        );
        state.schedule.push(Reverse((now, schedule_id, identity)));
        state.accepted += 1;
        drop(state);
        self.core.wake.notify_one();
        Ok(())
    }

    fn stats(&self) -> ReaperStats {
        let state = self
            .core
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ReaperStats {
            accepted: state.accepted,
            reaped: state.reaped,
            queued: state.entries.len(),
            in_flight: state.in_flight,
            capacity: self.core.capacity,
        }
    }

    #[cfg(test)]
    fn mark_in_flight_for_test(&self, identity: ReapIdentity) {
        let mut state = self
            .core
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(state.tracked.insert(identity));
        state.in_flight += 1;
    }

    #[cfg(test)]
    fn next_check_for_test(&self, identity: ReapIdentity) -> Option<Instant> {
        let state = self
            .core
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.entries.get(&identity).map(|entry| entry.next_check)
    }

    #[cfg(test)]
    fn defer_for_test(&self, identity: ReapIdentity, duration: Duration) {
        let mut state = self
            .core
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let next_check = Instant::now() + duration;
        let schedule_id = state.next_schedule_id;
        state.next_schedule_id = state.next_schedule_id.wrapping_add(1);
        let entry = state.entries.get_mut(&identity).expect("identity tracked");
        entry.next_check = next_check;
        entry.schedule_id = schedule_id;
        state
            .schedule
            .push(Reverse((next_check, schedule_id, identity)));
    }
}

fn reaper_loop(core: Arc<ReaperCore>) {
    loop {
        let mut pending = {
            let mut state = core
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            loop {
                let Some(Reverse((next_check, schedule_id, identity))) =
                    state.schedule.peek().copied()
                else {
                    state = core
                        .wake
                        .wait(state)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    continue;
                };
                let now = Instant::now();
                if next_check > now {
                    let (next_state, _) = core
                        .wake
                        .wait_timeout(state, next_check.saturating_duration_since(now))
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    state = next_state;
                    continue;
                }
                state.schedule.pop();
                if state
                    .entries
                    .get(&identity)
                    .is_none_or(|pending| pending.schedule_id != schedule_id)
                {
                    continue;
                }
                let pending = state
                    .entries
                    .remove(&identity)
                    .expect("schedule and entry checked together");
                state.in_flight += 1;
                break pending;
            }
        };

        let completed = poll_pending(&mut pending);

        let mut state = core
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.in_flight -= 1;
        let identity = pending.ownership.identity();
        if completed {
            state.tracked.remove(&identity);
            state.reaped += 1;
            drop(state);
            core.capacity_ready.notify_waiters();
        } else {
            let schedule_id = state.next_schedule_id;
            state.next_schedule_id = state.next_schedule_id.wrapping_add(1);
            pending.schedule_id = schedule_id;
            state
                .schedule
                .push(Reverse((pending.next_check, schedule_id, identity)));
            state.entries.insert(identity, pending);
        }
    }
}

fn poll_pending(pending: &mut Pending) -> bool {
    match &mut pending.ownership {
        ReapOwnership::Child { child, identity } => match child.try_wait() {
            Ok(Some(_)) | Err(_) => true,
            Ok(None) => {
                if !pending.escalated && pending.admitted_at.elapsed() >= ESCALATE_AFTER {
                    let _ =
                        kanna_daemon::agent::kill_agent_group_verified(child.id(), identity.start);
                    let _ = child.kill();
                    pending.escalated = true;
                }
                pending.next_check = Instant::now() + pending.poll_delay;
                pending.poll_delay = (pending.poll_delay * 2).min(POLL_MAX);
                false
            }
        },
        ReapOwnership::Pid(identity) => {
            let result =
                unsafe { libc::waitpid(identity.pid, std::ptr::null_mut(), libc::WNOHANG) };
            if result == 0 {
                pending.next_check = Instant::now() + pending.poll_delay;
                pending.poll_delay = (pending.poll_delay * 2).min(POLL_MAX);
                false
            } else {
                true
            }
        }
    }
}

fn global_reaper() -> &'static ReaperHandle {
    static REAPER: OnceLock<ReaperHandle> = OnceLock::new();
    REAPER.get_or_init(|| ReaperHandle::new(REAP_CAPACITY, true))
}

pub fn try_reap(ownership: ReapOwnership) -> Result<(), AdmissionError> {
    global_reaper().try_reap(ownership)
}

pub async fn reap(mut ownership: ReapOwnership) {
    loop {
        let notified = global_reaper().core.capacity_ready.notified();
        match try_reap(ownership) {
            Ok(()) => return,
            Err(error) => {
                ownership = error.into_ownership();
                tokio::select! {
                    _ = notified => {}
                    _ = tokio::time::sleep(Duration::from_millis(1)) => {}
                }
            }
        }
    }
}

pub fn try_reap_child(
    child: std::process::Child,
    start: Option<StartTime>,
) -> Result<(), AdmissionError> {
    let identity = ReapIdentity {
        pid: child.id() as libc::pid_t,
        start,
    };
    try_reap(ReapOwnership::Child { child, identity })
}

pub fn try_reap_pid(identity: ReapIdentity) -> Result<(), AdmissionError> {
    try_reap(ReapOwnership::Pid(identity))
}

pub fn stats() -> ReaperStats {
    global_reaper().stats()
}

// ---- Bounded lifecycle executor ----

pub type TeardownJob = Box<dyn FnOnce() + Send + 'static>;

pub enum TeardownAdmission {
    Accepted,
    Full(TeardownJob),
}

struct LifecycleState {
    jobs: VecDeque<TeardownJob>,
    in_flight: usize,
}

struct LifecycleCore {
    state: Mutex<LifecycleState>,
    wake: Condvar,
    capacity_ready: tokio::sync::Notify,
    capacity: usize,
}

fn lifecycle() -> &'static Arc<LifecycleCore> {
    const CAPACITY: usize = 512;
    static LIFECYCLE: OnceLock<Arc<LifecycleCore>> = OnceLock::new();
    LIFECYCLE.get_or_init(|| new_lifecycle(CAPACITY, true))
}

fn new_lifecycle(capacity: usize, running: bool) -> Arc<LifecycleCore> {
    let core = Arc::new(LifecycleCore {
        state: Mutex::new(LifecycleState {
            jobs: VecDeque::new(),
            in_flight: 0,
        }),
        wake: Condvar::new(),
        capacity_ready: tokio::sync::Notify::new(),
        capacity,
    });
    if running {
        let worker = Arc::clone(&core);
        std::thread::Builder::new()
            .name("kanna-lifecycle".to_string())
            .spawn(move || lifecycle_loop(worker))
            .expect("failed to start lifecycle executor");
    }
    core
}

fn lifecycle_loop(core: Arc<LifecycleCore>) {
    loop {
        let job = {
            let mut state = core
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            while state.jobs.is_empty() {
                state = core
                    .wake
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            let job = state.jobs.pop_front().expect("queue checked nonempty");
            state.in_flight += 1;
            job
        };
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).is_err() {
            log::error!("lifecycle teardown job panicked; continuing with the next job");
        }
        let mut state = core
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.in_flight -= 1;
        drop(state);
        core.capacity_ready.notify_waiters();
    }
}

pub fn try_run_teardown(job: TeardownJob) -> TeardownAdmission {
    try_run_teardown_on(lifecycle(), job)
}

fn try_run_teardown_on(core: &Arc<LifecycleCore>, job: TeardownJob) -> TeardownAdmission {
    let mut state = match core.state.try_lock() {
        Ok(state) => state,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => return TeardownAdmission::Full(job),
    };
    if state.jobs.len() + state.in_flight >= core.capacity {
        return TeardownAdmission::Full(job);
    }
    state.jobs.push_back(job);
    drop(state);
    core.wake.notify_one();
    TeardownAdmission::Accepted
}

pub async fn run_teardown(job: TeardownJob) {
    run_teardown_on(lifecycle(), job).await;
}

async fn run_teardown_on(core: &Arc<LifecycleCore>, mut job: TeardownJob) {
    loop {
        let notified = core.capacity_ready.notified();
        match try_run_teardown_on(core, job) {
            TeardownAdmission::Accepted => return,
            TeardownAdmission::Full(rejected) => {
                job = rejected;
                tokio::select! {
                    _ = notified => {}
                    _ = tokio::time::sleep(Duration::from_millis(1)) => {}
                }
            }
        }
    }
}

pub async fn run_teardown_and_wait<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    run_teardown(Box::new(move || {
        let _ = tx.send(job());
    }))
    .await;
    rx.await.ok()
}

pub fn lifecycle_stats() -> (usize, usize) {
    lifecycle_stats_on(lifecycle())
}

fn lifecycle_stats_on(core: &Arc<LifecycleCore>) -> (usize, usize) {
    let state = core
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    (state.jobs.len(), state.in_flight)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_until(mut predicate: impl FnMut() -> bool, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if predicate() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        predicate()
    }

    #[test]
    fn admission_never_blocks_and_total_depth_never_exceeds_cap() {
        let reaper = ReaperHandle::new_for_test(2);
        let first = ReapOwnership::Pid(ReapIdentity {
            pid: 42,
            start: Some((1, 1)),
        });
        let second = ReapOwnership::Pid(ReapIdentity {
            pid: 43,
            start: Some((1, 1)),
        });
        reaper.try_reap(first).expect("first admission");
        reaper.try_reap(second).expect("second admission");

        // At capacity, admission must refuse rather than wait for a permit —
        // and nothing here ever frees one, so a waiting implementation blocks
        // forever. The ceiling only has to be finite; keep it far above what a
        // loaded box adds to a lock-free refusal.
        let began = std::time::Instant::now();
        let rejected = reaper.try_reap(ReapOwnership::Pid(ReapIdentity {
            pid: 44,
            start: Some((1, 1)),
        }));
        assert!(began.elapsed() < std::time::Duration::from_secs(10));
        assert!(matches!(rejected, Err(AdmissionError::Full(_))));
        assert_eq!(reaper.stats().outstanding(), 2);
    }

    #[test]
    fn a_recycled_pid_is_admitted_as_its_own_reap_identity() {
        let reaper = ReaperHandle::new_for_test(4);
        reaper
            .try_reap(ReapOwnership::Pid(ReapIdentity {
                pid: 42,
                start: Some((1, 1)),
            }))
            .expect("first incarnation admitted");
        reaper
            .try_reap(ReapOwnership::Pid(ReapIdentity {
                pid: 42,
                start: Some((1, 2)),
            }))
            .expect("recycled pid is a distinct identity");
    }

    #[test]
    fn admission_never_waits_for_the_owner_thread_mutex() {
        let reaper = ReaperHandle::new_for_test(2);
        let core = Arc::clone(&reaper.core);
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        // The holder keeps the state mutex until this test hands it back, so
        // "did not wait on the mutex" is a happens-before rather than a
        // wall-clock budget: an admission that took the lock could not return
        // before `release_tx` fires below, whatever the machine's load.
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _guard = core
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            locked_tx.send(()).expect("announce held lock");
            release_rx.recv().expect("test releases the held lock");
        });
        locked_rx.recv().expect("owner thread holds lock");

        let result = reaper.try_reap(ReapOwnership::Pid(ReapIdentity {
            pid: 42,
            start: Some((1, 1)),
        }));
        assert!(matches!(result, Err(AdmissionError::Full(_))));
        release_tx.send(()).expect("release held lock");
        holder.join().expect("owner thread exits");
    }

    #[test]
    fn in_flight_ownership_counts_against_the_admission_cap() {
        let reaper = ReaperHandle::new_for_test(1);
        reaper.mark_in_flight_for_test(ReapIdentity {
            pid: 42,
            start: Some((1, 1)),
        });
        let result = reaper.try_reap(ReapOwnership::Pid(ReapIdentity {
            pid: 43,
            start: Some((1, 1)),
        }));
        assert!(matches!(result, Err(AdmissionError::Full(_))));
        assert_eq!(reaper.stats().in_flight, 1);
        assert_eq!(reaper.stats().outstanding(), 1);
    }

    #[test]
    fn a_fresh_admission_does_not_reset_a_survivors_deadline() {
        let reaper = ReaperHandle::new_for_test(4);
        let survivor = ReapIdentity {
            pid: 42,
            start: Some((1, 1)),
        };
        reaper
            .try_reap(ReapOwnership::Pid(survivor))
            .expect("survivor admitted");
        reaper.defer_for_test(survivor, Duration::from_secs(30));
        let deadline = reaper
            .next_check_for_test(survivor)
            .expect("survivor deadline");

        reaper
            .try_reap(ReapOwnership::Pid(ReapIdentity {
                pid: 43,
                start: Some((1, 1)),
            }))
            .expect("fresh admission");
        assert_eq!(
            reaper.next_check_for_test(survivor),
            Some(deadline),
            "fresh work must not rewrite an older entry's schedule"
        );
    }

    #[test]
    fn running_reaper_escalates_and_reaps_a_stubborn_child() {
        use std::os::unix::process::CommandExt;

        let reaper = ReaperHandle::new_running_for_test(8);
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "trap '' TERM; sleep 300"]);
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().expect("spawn stubborn child");
        let pid = child.id() as libc::pid_t;
        let start = crate::proc_info::process_info(pid).map(|info| info.start);
        reaper
            .try_reap(ReapOwnership::Child {
                child,
                identity: ReapIdentity { pid, start },
            })
            .expect("admit stubborn child");

        assert!(
            wait_until(|| reaper.stats().reaped == 1, Duration::from_secs(5)),
            "elapsed-time escalation must reap the stubborn child"
        );
    }

    #[tokio::test]
    async fn lifecycle_backpressure_is_bounded_async_and_counts_in_flight_work() {
        let lifecycle = new_lifecycle(1, true);
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        run_teardown_on(
            &lifecycle,
            Box::new(move || {
                release_rx.recv().expect("test releases worker");
            }),
        )
        .await;
        assert!(wait_until(
            || lifecycle_stats_on(&lifecycle).1 == 1,
            Duration::from_secs(2)
        ));

        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ran_in_job = Arc::clone(&ran);
        // The only permit is held by a worker parked until this test releases
        // it, so an admission that waited for capacity would never return. The
        // ceiling only has to be finite, not tight.
        let began = Instant::now();
        let rejected = try_run_teardown_on(
            &lifecycle,
            Box::new(move || ran_in_job.store(true, std::sync::atomic::Ordering::SeqCst)),
        );
        assert!(began.elapsed() < Duration::from_secs(10));
        let TeardownAdmission::Full(job) = rejected else {
            panic!("in-flight work must consume the only permit");
        };
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));

        let waiting_lifecycle = Arc::clone(&lifecycle);
        let waiter = tokio::spawn(async move {
            run_teardown_on(&waiting_lifecycle, job).await;
        });
        tokio::task::yield_now().await;
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        release_tx.send(()).expect("release first job");
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("backpressured admission should complete")
            .expect("waiter task should succeed");
        assert!(wait_until(
            || ran.load(std::sync::atomic::Ordering::SeqCst),
            Duration::from_secs(2)
        ));
    }

    #[tokio::test]
    async fn lifecycle_owner_survives_a_panicking_teardown() {
        let lifecycle = new_lifecycle(2, true);
        run_teardown_on(&lifecycle, Box::new(|| panic!("test panic"))).await;

        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ran_in_job = Arc::clone(&ran);
        run_teardown_on(
            &lifecycle,
            Box::new(move || ran_in_job.store(true, std::sync::atomic::Ordering::SeqCst)),
        )
        .await;
        assert!(
            wait_until(
                || ran.load(std::sync::atomic::Ordering::SeqCst),
                Duration::from_secs(2)
            ),
            "a panicking teardown must not kill the sole lifecycle owner"
        );
    }
}
