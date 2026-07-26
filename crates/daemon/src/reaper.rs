//! Central bounded child reaper.
//!
//! Every child this daemon forks must eventually be waited on, but no code
//! path may block a Tokio worker (or hold a registry/PTY lock) waiting for a
//! child that is stuck exiting inside the kernel. Previously each such child
//! got its own detached thread (or an uncancellable `spawn_blocking` task),
//! and the PTY reaper abandoned the child entirely after 60 seconds —
//! dropping its handle, which leaks the zombie for the daemon's remaining
//! life and, for a PTY child, keeps its pty slot allocated.
//!
//! This module owns exactly one background thread that polls a queue of
//! pending children with `WNOHANG` and never gives up: a child that cannot
//! be reaped now is retried on the next tick for as long as the daemon
//! lives. Ownership is one-shot — a child is handed over once and the queue
//! holds the only remaining handle.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, OnceLock};

use crate::proc_info::StartTime;

/// A child awaiting reaping. `Owned` for our own forks (whose `Child` handle
/// reaps on `try_wait`); `Pid` for PTY session children, which the daemon
/// tracks by pid rather than as a `Child`.
enum Pending {
    Owned {
        child: std::process::Child,
        /// Lets the reaper escalate to an identity-verified group kill.
        start: Option<StartTime>,
        /// When this child was handed over; the escalation deadline is
        /// measured from here so it is independent of poll cadence.
        admitted: std::time::Instant,
        escalated: bool,
    },
    Pid {
        pid: libc::pid_t,
    },
}

#[derive(Default)]
struct Queue {
    pending: VecDeque<Pending>,
    /// Pids currently owned by the reaper, for one-shot deduplicated
    /// admission.
    tracked: std::collections::HashSet<libc::pid_t>,
    /// Handed over since start; observable for diagnostics and tests.
    accepted: u64,
    /// Successfully reaped (or confirmed not ours).
    reaped: u64,
}

struct Reaper {
    queue: Mutex<Queue>,
    wake: Condvar,
}

/// How long a child may linger before the reaper escalates to an
/// identity-verified group SIGKILL. Its caller already asked it to die; this
/// is the backstop for a child that ignored that request.
///
/// This is deliberately an ELAPSED-TIME deadline, not a poll-tick count. The
/// poll cadence below is adaptive (TICK_MIN -> TICK_MAX), so counting ticks
/// made the effective threshold depend on how often the queue happened to be
/// polled: with one lingering child the backoff stretched 20 ticks from the
/// intended ~400ms out to ~26s, and the escalation regression only passed when
/// unrelated admissions happened to reset the backoff.
const ESCALATE_AFTER: std::time::Duration = std::time::Duration::from_millis(400);
/// Fast first poll: the overwhelming majority of children are already dead
/// when handed over, so the first check should be immediate-ish.
const TICK_MIN: std::time::Duration = std::time::Duration::from_millis(20);
/// Ceiling for the adaptive backoff. A child stuck exiting in the kernel is
/// polled at this rate forever rather than at a fixed 100ms — ownership is
/// retained either way, but an idle-ish stuck child costs far fewer wakeups.
const TICK_MAX: std::time::Duration = std::time::Duration::from_millis(200);

fn reaper() -> &'static Reaper {
    static REAPER: OnceLock<&'static Reaper> = OnceLock::new();
    REAPER.get_or_init(|| {
        let reaper: &'static Reaper = Box::leak(Box::new(Reaper {
            queue: Mutex::new(Queue::default()),
            wake: Condvar::new(),
        }));
        std::thread::Builder::new()
            .name("kanna-reaper".to_string())
            .spawn(move || reaper_loop(reaper))
            .expect("failed to start the child reaper thread");
        reaper
    })
}

fn lock(reaper: &'static Reaper) -> std::sync::MutexGuard<'static, Queue> {
    reaper
        .queue
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn reaper_loop(reaper: &'static Reaper) {
    let mut backoff = TICK_MIN;
    let mut last_seen_accepted = 0u64;
    loop {
        // Sleep until there is something to do, then poll on a fixed tick.
        let mut queue = lock(reaper);
        while queue.pending.is_empty() {
            // Nothing pending: sleep until a hand-over wakes us. No polling.
            let (guard, _) = reaper
                .wake
                .wait_timeout(queue, TICK_MAX)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            queue = guard;
        }

        // Fresh admissions deserve a fast first check.
        if queue.accepted != last_seen_accepted {
            last_seen_accepted = queue.accepted;
            backoff = TICK_MIN;
        }
        let mut still_pending = VecDeque::with_capacity(queue.pending.len());
        let mut reaped = 0u64;
        while let Some(entry) = queue.pending.pop_front() {
            match entry {
                Pending::Owned {
                    mut child,
                    start,
                    admitted,
                    escalated,
                } => match child.try_wait() {
                    Ok(Some(_)) => reaped += 1,
                    // The child is not ours / already reaped elsewhere.
                    Err(_) => reaped += 1,
                    Ok(None) => {
                        let escalated = if !escalated && admitted.elapsed() >= ESCALATE_AFTER {
                            log::warn!(
                                "[reaper] child {} still alive after {:?}; escalating to SIGKILL",
                                child.id(),
                                admitted.elapsed()
                            );
                            let _ = crate::agent::kill_agent_group_verified(child.id(), start);
                            let _ = child.kill();
                            true
                        } else {
                            escalated
                        };
                        still_pending.push_back(Pending::Owned {
                            child,
                            start,
                            admitted,
                            escalated,
                        });
                    }
                },
                Pending::Pid { pid } => {
                    let ret = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
                    if ret == 0 {
                        // Still exiting — retry forever rather than abandon.
                        still_pending.push_back(Pending::Pid { pid });
                    } else {
                        reaped += 1;
                    }
                }
            }
        }
        // Release ownership of everything reaped this pass so a future
        // hand-over of a (necessarily different) child with the same pid is
        // admitted again.
        let surviving: std::collections::HashSet<libc::pid_t> = still_pending
            .iter()
            .map(|entry| match entry {
                Pending::Owned { child, .. } => child.id() as libc::pid_t,
                Pending::Pid { pid } => *pid,
            })
            .collect();
        queue.tracked.retain(|pid| surviving.contains(pid));
        queue.pending = still_pending;
        queue.reaped += reaped;
        let outstanding = queue.pending.len();
        drop(queue);

        if outstanding > 0 {
            // Adaptive: poll fast while a child is likely about to be reapable,
            // then back off geometrically toward TICK_MAX so a genuinely stuck
            // child costs a couple of wakeups per second instead of ten.
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(TICK_MAX);
        } else {
            backoff = TICK_MIN;
        }
    }
}

/// Admission cap. Reap ownership is one-shot per child, so the steady-state
/// depth is bounded by live children; this is the backstop against a runaway
/// caller. On saturation the child is reaped inline (blocking briefly) rather
/// than dropped — losing a child handle would leak the zombie permanently.
const REAP_QUEUE_CAP: usize = 4096;

fn enqueue(entry: Pending) {
    let reaper = reaper();
    let mut queue = lock(reaper);
    // Deduplicate: the same pid must never be admitted twice. A second entry
    // would let one waiter observe the exit status and leave the other polling
    // a pid that may later be recycled.
    let pid = match &entry {
        Pending::Owned { child, .. } => child.id() as libc::pid_t,
        Pending::Pid { pid } => *pid,
    };
    if queue.tracked.contains(&pid) {
        log::debug!("[reaper] pid {pid} is already owned by the reaper; ignoring re-admission");
        return;
    }
    if queue.pending.len() >= REAP_QUEUE_CAP {
        drop(queue);
        log::warn!("[reaper] queue saturated; reaping pid {pid} inline");
        match entry {
            Pending::Owned { mut child, .. } => {
                let _ = child.wait();
            }
            Pending::Pid { pid } => {
                unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
            }
        }
        return;
    }
    queue.tracked.insert(pid);
    queue.pending.push_back(entry);
    queue.accepted += 1;
    drop(queue);
    reaper.wake.notify_all();
}

/// Hand over a child we own. One-shot: the queue holds the only remaining
/// handle and retries until the child is actually reaped. `start` lets the
/// reaper escalate to an identity-verified group kill.
pub fn reap_detached(child: std::process::Child, start: Option<StartTime>) {
    enqueue(Pending::Owned {
        child,
        start,
        admitted: std::time::Instant::now(),
        escalated: false,
    });
}

/// Hand over a bare pid (a PTY session child the daemon never held as a
/// `Child`). Retried until reaped; never abandoned.
pub fn reap_pid(pid: libc::pid_t) {
    if pid > 1 {
        enqueue(Pending::Pid { pid });
    }
}

/// `(accepted, reaped, outstanding)` counters for diagnostics and tests.
pub fn stats() -> (u64, u64, usize) {
    let queue = lock(reaper());
    (queue.accepted, queue.reaped, queue.pending.len())
}

// ---- Bounded lifecycle executor ----

type TeardownJob = Box<dyn FnOnce() + Send + 'static>;

struct Lifecycle {
    jobs: Mutex<VecDeque<TeardownJob>>,
    wake: Condvar,
}

/// Serialized, bounded executor for teardown work that scans or signals the
/// whole process table. Such work must never run on a Tokio worker (it is
/// syscall-heavy and unbounded in duration) nor under a session lock.
/// Serializing it also coalesces naturally during many-session teardown.
fn lifecycle() -> &'static Lifecycle {
    static LIFECYCLE: OnceLock<&'static Lifecycle> = OnceLock::new();
    LIFECYCLE.get_or_init(|| {
        let lifecycle: &'static Lifecycle = Box::leak(Box::new(Lifecycle {
            jobs: Mutex::new(VecDeque::new()),
            wake: Condvar::new(),
        }));
        std::thread::Builder::new()
            .name("kanna-lifecycle".to_string())
            .spawn(move || loop {
                let job = {
                    let mut jobs = lifecycle
                        .jobs
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    loop {
                        if let Some(job) = jobs.pop_front() {
                            break job;
                        }
                        jobs = lifecycle
                            .wake
                            .wait(jobs)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                };
                job();
            })
            .expect("failed to start the lifecycle executor thread");
        lifecycle
    })
}

/// Depth cap for the lifecycle queue. Teardown is single-flight per session,
/// so the steady-state depth is bounded by the session count; this is the
/// backstop that keeps a pathological caller from growing the queue without
/// limit.
const LIFECYCLE_QUEUE_CAP: usize = 512;

/// Try to queue teardown work. On saturation the job is handed back so the
/// caller can apply backpressure instead of growing memory without bound.
fn try_enqueue_teardown(job: TeardownJob) -> Option<TeardownJob> {
    let lifecycle = lifecycle();
    let mut jobs = lifecycle
        .jobs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if jobs.len() >= LIFECYCLE_QUEUE_CAP {
        log::warn!(
            "[lifecycle] teardown queue saturated at {} jobs; applying backpressure",
            jobs.len()
        );
        return Some(job);
    }
    jobs.push_back(job);
    drop(jobs);
    lifecycle.wake.notify_one();
    None
}

/// Queue teardown work on the bounded lifecycle executor, running it inline
/// if the queue is saturated (backpressure rather than unbounded growth).
pub fn run_teardown(job: impl FnOnce() + Send + 'static) {
    if let Some(rejected) = try_enqueue_teardown(Box::new(job)) {
        rejected();
    }
}

/// Current lifecycle queue depth (diagnostics/tests).
pub fn lifecycle_depth() -> usize {
    let lifecycle = lifecycle();
    let jobs = lifecycle
        .jobs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    jobs.len()
}

/// Queue teardown work and wait for it to finish (used where the caller must
/// observe completion, e.g. a synchronous kill reply).
pub async fn run_teardown_and_wait<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    run_teardown(move || {
        let _ = tx.send(job());
    });
    rx.await.ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_until(mut predicate: impl FnMut() -> bool, timeout: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if predicate() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        predicate()
    }

    fn is_unwaitable(pid: libc::pid_t) -> bool {
        (unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) }) == -1
    }

    #[test]
    fn reaps_an_exited_child_without_a_dedicated_thread() {
        let child = std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("spawn true");
        let pid = child.id() as libc::pid_t;
        reap_detached(child, None);
        assert!(
            wait_until(|| is_unwaitable(pid), std::time::Duration::from_secs(5)),
            "the reaper must reap an exited child"
        );
    }

    /// Stuck/unreapable-child coverage: a child that ignores its caller's
    /// termination request must still be reaped. The reaper escalates to a
    /// verified SIGKILL and keeps retrying instead of abandoning the handle
    /// (which previously leaked the zombie for the daemon's whole life).
    #[test]
    fn escalates_and_reaps_a_stubborn_child() {
        // Ignores SIGTERM; only SIGKILL ends it.
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; sleep 300"])
            .spawn()
            .expect("spawn stubborn child");
        let pid = child.id() as libc::pid_t;
        let start = crate::proc_info::process_info(pid).map(|info| info.start);

        reap_detached(child, start);
        assert!(
            wait_until(
                || unsafe { libc::kill(pid, 0) } != 0,
                std::time::Duration::from_secs(15)
            ),
            "the reaper must escalate to SIGKILL and reap a stubborn child"
        );
    }

    /// The PTY layer hands over a bare pid (it never owns a `Child`).
    /// Admission is deduplicated: handing the same pid over twice must not
    /// create two owners, or one waiter would consume the exit status and the
    /// other would poll a pid that can later be recycled.
    #[test]
    fn admission_is_deduplicated_per_pid() {
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 5"])
            .spawn()
            .expect("spawn");
        let pid = child.id() as libc::pid_t;
        std::mem::forget(child);

        let (accepted_before, _, _) = stats();
        reap_pid(pid);
        let (accepted_after_first, _, _) = stats();
        reap_pid(pid);
        let (accepted_after_second, _, _) = stats();
        assert_eq!(
            accepted_after_first,
            accepted_before + 1,
            "the first hand-over is admitted"
        );
        assert_eq!(
            accepted_after_second, accepted_after_first,
            "a duplicate hand-over of the same pid must be ignored"
        );

        unsafe { libc::kill(pid, libc::SIGKILL) };
        assert!(
            wait_until(|| is_unwaitable(pid), std::time::Duration::from_secs(10)),
            "the single owner still reaps the child"
        );
    }

    #[test]
    fn reaps_a_bare_pid_handed_over_by_the_pty_layer() {
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .expect("spawn pid child");
        let pid = child.id() as libc::pid_t;
        // Leak the handle so nothing else can reap it: exactly the PTY case,
        // where the daemon knows only the pid.
        std::mem::forget(child);
        reap_pid(pid);
        assert!(
            wait_until(|| is_unwaitable(pid), std::time::Duration::from_secs(5)),
            "the reaper must reap a bare pid"
        );
    }
}
