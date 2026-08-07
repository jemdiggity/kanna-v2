//! Server-side task-transfer orchestration.
//!
//! Push, import, approve/reject, commit handling and failure reporting used to
//! live in `apps/desktop/src/stores/transfer.ts`, driven by whichever renderer
//! window had been elected to receive the sidecar's lifecycle events. That made
//! a transfer implicitly require an open, signed-in window, and on 2026-08-06 a
//! window that vanished mid-transfer took the finalization signal, the failure
//! report, and the commit acknowledgment with it — three failures, one design.
//!
//! The work lives here instead, in the process that already owns the DB rows,
//! the task lifecycle actions, the daemon event stream, and (since the sidecar
//! re-parent) the transfer control plane. What used to be at-least-once
//! delivery to a window is exactly-once execution in one process, and the four
//! lifecycle events that only existed in an in-memory Tauri queue are now rows
//! in a durable work queue that survives a restart.

pub mod control;
pub mod git;
pub mod payload;
pub mod queue;
pub mod session;

mod finalize;
mod import;
mod push;

use crate::db::TransferWorkItem;
use crate::http_api::AppState;
use queue::TransferWorkQueue;
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long the drain loop parks when nothing is runnable. Appends wake it
/// immediately; this only bounds how long a backed-off retry waits when no new
/// work arrives in the meantime.
const IDLE_POLL: Duration = Duration::from_secs(30);

/// How many work items the engine runs at once.
///
/// Serially, one item held the whole engine. That was fine while the slowest
/// step was a `SIGINT` and a 1500 ms sleep, and stopped being fine the moment
/// finalization started waiting on a person's agent: a `finalize` item can
/// legitimately hold its slot for 360 s (`transfer_engine/finalize.rs`) and an
/// `import` for the peer's whole finalization window plus a request budget —
/// ~615 s. Behind either one sat every other transfer work item on the machine,
/// including an unrelated import, a pairing cleanup, and a push the operator had
/// just asked for.
///
/// The number is a backstop, not a throughput target: these items are almost
/// entirely *waiting*, their heavy steps already run on the blocking pool
/// ([`run_blocking`]), and each holds no DB connection across its awaits. It is
/// the sidecar's `DEFAULT_MAX_FINALIZATION_WAITERS`, which bounds how many of
/// these long peer-blocked steps can be outstanding against this machine anyway.
const MAX_CONCURRENT_WORK: usize = 8;

/// How one claimed item is executed. Indirected so a test can hold an item open
/// on demand instead of waiting out a real 600 s finalization window; production
/// passes [`execute`].
type WorkExecutor = Arc<
    dyn Fn(
            Arc<AppState>,
            TransferWorkItem,
        ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync,
>;

/// Runs synchronous git, archive and filesystem work off the runtime workers.
///
/// The engine's slowest steps are `git clone`, `git bundle` and gzipping a
/// session archive, and every one of them is a fully blocking call that can run
/// for minutes on a large repository. The same Tokio runtime carries every KSP
/// terminal stream, the LAN listener and the relay socket; occupying a worker
/// with a clone freezes all of them. This is the engine's form of the
/// `run_handler_blocking` boundary the HTTP handlers use, for the same reason.
pub(crate) async fn run_blocking<T>(
    label: &'static str,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| format!("{label} worker failed: {error}"))?
}

/// Runs the engine for the life of the server.
///
/// Startup does the recovery the in-memory queue could never do: work whose
/// process died mid-flight returns to `pending`, and incoming transfers left
/// unfinished by an earlier run are re-enqueued. Only then does the loop drain.
pub async fn run(state: Arc<AppState>) {
    let queue = state.transfer_work();
    if let Err(error) = recover_interrupted_work(&queue) {
        log::error!("failed to recover interrupted transfer work: {error}");
    }
    drain(
        state,
        Arc::new(|state, item| Box::pin(async move { execute(&state, &item).await })),
    )
    .await
}

/// Claims work and runs it, up to [`MAX_CONCURRENT_WORK`] items at a time and at
/// most one item per transfer.
///
/// Concurrency is safe to add here because nothing in an item's own
/// at-most-once-ness depended on the loop being serial: the steps that may not
/// repeat claim durable phases in `transfer_work_phase`, and the claim that hands
/// an item out is a single statement no two callers can win. What *was* implicit
/// is the ordering *within* one transfer, which the claim's exclusion now states
/// outright.
async fn drain(state: Arc<AppState>, execute_item: WorkExecutor) {
    let queue = state.transfer_work();
    let mut running: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
    let busy: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    loop {
        if running.len() < MAX_CONCURRENT_WORK {
            match queue.open_db().and_then(|db| {
                db.claim_next_transfer_work(&busy_transfer_ids(&busy))
                    .map_err(|error| format!("db error: {error}"))
            }) {
                Ok(Some(item)) => {
                    let slot = TransferSlot::claim(&busy, item.transfer_id.clone());
                    let state = Arc::clone(&state);
                    let execute_item = Arc::clone(&execute_item);
                    running.spawn(async move {
                        // Held for the item's whole run. Dropping it is what lets
                        // this transfer's next item be claimed, and a guard rather
                        // than a call after the await so a panicking item frees
                        // its transfer too.
                        let _slot = slot;
                        let outcome = execute_item(Arc::clone(&state), item.clone()).await;
                        settle_item(&state, &item, outcome).await;
                    });
                    continue;
                }
                Ok(None) => {}
                Err(error) => {
                    log::error!("failed to read the transfer work queue: {error}");
                    queue.wait_for_work(IDLE_POLL).await;
                    continue;
                }
            }
        }

        // Nothing more can be started right now, either because the pool is full
        // or because every runnable row belongs to a transfer already in flight.
        // Both are ended by an item finishing, so that is the wake-up to wait for
        // alongside an append.
        if running.len() >= MAX_CONCURRENT_WORK {
            report_joined(running.join_next().await);
            continue;
        }
        let delay = queue
            .open_db()
            .and_then(|db| {
                db.next_transfer_work_delay_seconds(&busy_transfer_ids(&busy))
                    .map_err(|error| format!("db error: {error}"))
            })
            .ok()
            .flatten()
            .map(|seconds| Duration::from_secs(seconds.max(0) as u64))
            .unwrap_or(IDLE_POLL);
        tokio::select! {
            joined = running.join_next(), if !running.is_empty() => report_joined(joined),
            _ = queue.wait_for_work(delay.min(IDLE_POLL)) => {}
        }
    }
}

/// One transfer's place in the drain's in-flight set.
///
/// `settle_item` records every ordinary failure, so a worker only ends without
/// returning if it panicked — and a slot released by bookkeeping after the await
/// would then be held by nobody, parking every later item of that transfer until
/// the server restarted. `Drop` runs either way.
struct TransferSlot {
    busy: Arc<Mutex<HashSet<String>>>,
    /// `None` for work with no transfer id — a push, before anything has
    /// reserved one — which holds no slot.
    transfer_id: Option<String>,
}

impl TransferSlot {
    fn claim(busy: &Arc<Mutex<HashSet<String>>>, transfer_id: Option<String>) -> Self {
        if let Some(transfer_id) = transfer_id.clone() {
            lock_busy(busy).insert(transfer_id);
        }
        Self {
            busy: Arc::clone(busy),
            transfer_id,
        }
    }
}

impl Drop for TransferSlot {
    fn drop(&mut self) {
        if let Some(transfer_id) = &self.transfer_id {
            lock_busy(&self.busy).remove(transfer_id);
        }
    }
}

fn lock_busy(busy: &Arc<Mutex<HashSet<String>>>) -> std::sync::MutexGuard<'_, HashSet<String>> {
    busy.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn busy_transfer_ids(busy: &Arc<Mutex<HashSet<String>>>) -> Vec<String> {
    lock_busy(busy).iter().cloned().collect()
}

/// A panicking item is a bug rather than a transfer failure, and nothing else
/// will say so: its row stays `running` until the next startup requeues it.
fn report_joined(joined: Option<Result<(), tokio::task::JoinError>>) {
    if let Some(Err(error)) = joined {
        log::error!("a transfer work item panicked: {error}");
    }
}

/// Records what an item's run achieved, and publishes the change.
async fn settle_item(state: &Arc<AppState>, item: &TransferWorkItem, outcome: Result<(), String>) {
    let Ok(db) = state.transfer_work().open_db() else {
        // Nothing can be recorded without the DB; the item stays `running`
        // and the next startup requeues it rather than losing it.
        log::error!("failed to record transfer work {} outcome", item.id);
        return;
    };
    match outcome {
        Ok(()) => {
            if let Err(error) = db.complete_transfer_work(&item.id) {
                log::error!("failed to complete transfer work {}: {error}", item.id);
            }
        }
        Err(reason) => {
            log::error!(
                "transfer work {} ({}) attempt {} failed: {reason}",
                item.id,
                item.kind,
                item.attempts,
            );
            match db.fail_transfer_work_attempt(&item.id, item.attempts, &reason) {
                Ok(true) => {}
                // The attempt budget is spent. A transfer that can make no
                // further progress has to end visibly on both sides rather
                // than retry forever behind the operator's back.
                Ok(false) => report_exhausted_work(state, item, &reason).await,
                Err(error) => {
                    log::error!(
                        "failed to record transfer work failure {}: {error}",
                        item.id
                    )
                }
            }
        }
    }
    state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
}

fn recover_interrupted_work(queue: &Arc<TransferWorkQueue>) -> Result<(), String> {
    let db = queue.open_db()?;
    let requeued = db
        .requeue_interrupted_transfer_work()
        .map_err(|error| format!("db error: {error}"))?;
    if requeued > 0 {
        log::info!("resumed {requeued} transfer work item(s) interrupted by a restart");
    }
    // An incoming transfer the previous run recorded but never imported has a
    // durable row and no queued work — the app-restart case the renderer swept
    // by re-reading `pending` rows at window mount.
    for transfer in db
        .list_pending_incoming_transfers()
        .map_err(|error| format!("db error: {error}"))?
    {
        queue.enqueue(
            &format!("import:{}", transfer.id),
            queue::KIND_IMPORT,
            Some(&transfer.id),
            &serde_json::json!({ "transferId": transfer.id }),
        )?;
    }
    // The renderer swept these at every window mount too, and that sweep is the
    // only thing that ever released a *settled* transfer's sidecar reservation:
    // a committed one is exempt from TTL pruning, so each leftover permanently
    // consumes one of the destination's bounded reservation slots. The backlog
    // an upgrade inherits is swept the same way, because the query asks for
    // every terminal row whose cleanup never completed rather than only this
    // run's.
    for transfer_id in db
        .list_terminal_incoming_transfer_ids()
        .map_err(|error| format!("db error: {error}"))?
    {
        queue.enqueue(
            &format!("cleanup:{transfer_id}"),
            queue::KIND_SIDECAR_CLEANUP,
            Some(&transfer_id),
            &serde_json::json!({ "transferId": transfer_id }),
        )?;
    }
    Ok(())
}

async fn execute(state: &Arc<AppState>, item: &crate::db::TransferWorkItem) -> Result<(), String> {
    let payload: serde_json::Value = serde_json::from_str(&item.payload_json)
        .map_err(|error| format!("invalid transfer work payload: {error}"))?;
    match item.kind.as_str() {
        queue::KIND_INCOMING_REQUEST => import::record_incoming(state, &payload).await,
        queue::KIND_IMPORT => import::import_transfer(state, item, &payload).await,
        queue::KIND_REJECT => import::reject_transfer(state, &payload).await,
        queue::KIND_SIDECAR_CLEANUP => import::release_settled_reservation(state, &payload).await,
        queue::KIND_PUSH => push::push_task(state, item, &payload).await,
        queue::KIND_FINALIZE => push::finalize(state, item, &payload).await,
        queue::KIND_OUTGOING_COMMITTED => push::outgoing_committed(state, item, &payload).await,
        other => Err(format!("unknown transfer work kind {other}")),
    }
}

/// Ends a transfer whose work can no longer make progress.
///
/// The renderer reported this by throwing into a `.catch` that only logged. A
/// transfer that is never going to complete has to become a `failed` row —
/// visible in the sidebar, and no longer blocking another push of the same
/// task.
async fn report_exhausted_work(
    state: &Arc<AppState>,
    item: &crate::db::TransferWorkItem,
    reason: &str,
) {
    let reason = format!("transfer work {} gave up: {reason}", item.kind);
    let Some(transfer_id) = item.transfer_id.as_deref() else {
        // A push gives up before anything reserved a transfer id — the whole
        // point of running the eligibility read and the artifact plan first —
        // so there is no row to fail and nothing would reach the operator. Give
        // it the same `failed` row a refused push gets, or an exhausted push is
        // invisible on both machines.
        if item.kind == queue::KIND_PUSH {
            if let Ok(request) = serde_json::from_str::<serde_json::Value>(&item.payload_json) {
                if let Err(error) = push::report_terminal_push(state, item, &request, &reason) {
                    log::error!(
                        "failed to record an exhausted push for {}: {error}",
                        item.id
                    );
                }
            }
        }
        return;
    };
    let Ok(db) = state.transfer_work().open_db() else {
        return;
    };
    let transfer = db.get_task_transfer(transfer_id).ok().flatten();
    let failed = match transfer
        .as_ref()
        .map(|transfer| transfer.direction.as_str())
    {
        Some("outgoing") => db.fail_outgoing_task_transfer(transfer_id, &reason),
        Some("incoming") => db.fail_incoming_task_transfer(transfer_id, &reason),
        _ => Ok(false),
    };
    if let Err(error) = failed {
        log::error!("failed to mark transfer {transfer_id} failed: {error}");
    }
    // The sidecar holds reservations and staged artifacts for a transfer that
    // is now over; leaving them is the disk leak the duplicate-push race left.
    if transfer
        .as_ref()
        .map(|transfer| transfer.direction.as_str())
        == Some("incoming")
    {
        let _ = control::mark_import_ack_completed(state, transfer_id).await;
        let _ = db.mark_incoming_transfer_sidecar_cleanup_completed(transfer_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A drain with a scripted executor, so an item can be held open for as long
    /// as a test needs without waiting out a real finalization window.
    struct Harness {
        state: Arc<AppState>,
        /// Every item id the executor was handed, in the order it started.
        started: Arc<Mutex<Vec<String>>>,
        /// The most items that were ever inside the executor at once.
        peak_in_flight: Arc<AtomicUsize>,
        in_flight: Arc<AtomicUsize>,
        /// Released to let every held item return.
        release: Arc<tokio::sync::Notify>,
        finished: tokio::sync::mpsc::UnboundedSender<String>,
    }

    impl Harness {
        fn start(
            label: &str,
            seed: impl FnOnce(&crate::db::Db),
        ) -> (Self, tokio::sync::mpsc::UnboundedReceiver<String>) {
            let daemon_dir = format!("/tmp/kanna-engine-{label}-{}", std::process::id());
            std::fs::create_dir_all(&daemon_dir).expect("daemon dir");
            let state =
                crate::http_api::test_state_with_daemon_dir(label, label, &daemon_dir, |db| {
                    db.insert_test_repo("repo-engine", "Engine Repo")
                        .expect("repo");
                    seed(db);
                });
            let (finished, finished_rx) = tokio::sync::mpsc::unbounded_channel();
            (
                Self {
                    state,
                    started: Arc::new(Mutex::new(Vec::new())),
                    peak_in_flight: Arc::new(AtomicUsize::new(0)),
                    in_flight: Arc::new(AtomicUsize::new(0)),
                    release: Arc::new(tokio::sync::Notify::new()),
                    finished,
                },
                finished_rx,
            )
        }

        /// Spawns the drain. `hold` decides which items park until `release`.
        fn spawn(
            &self,
            hold: impl Fn(&TransferWorkItem) -> bool + Send + Sync + 'static,
        ) -> tokio::task::JoinHandle<()> {
            let started = Arc::clone(&self.started);
            let in_flight = Arc::clone(&self.in_flight);
            let peak = Arc::clone(&self.peak_in_flight);
            let release = Arc::clone(&self.release);
            let finished = self.finished.clone();
            let hold = Arc::new(hold);
            let executor: WorkExecutor = Arc::new(move |_state, item| {
                let started = Arc::clone(&started);
                let in_flight = Arc::clone(&in_flight);
                let peak = Arc::clone(&peak);
                let release = Arc::clone(&release);
                let finished = finished.clone();
                let hold = Arc::clone(&hold);
                Box::pin(async move {
                    started.lock().expect("started").push(item.id.clone());
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    if hold(&item) {
                        release.notified().await;
                    }
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    let _ = finished.send(item.id.clone());
                    Ok(())
                })
            });
            tokio::spawn(drain(Arc::clone(&self.state), executor))
        }

        fn started(&self) -> Vec<String> {
            self.started.lock().expect("started").clone()
        }

        fn status(&self, work_id: &str) -> Option<String> {
            self.state
                .transfer_work()
                .open_db()
                .expect("db")
                .transfer_work_status(work_id)
                .expect("status")
        }
    }

    /// The head-of-line regression.
    ///
    /// A `finalize` item legitimately holds its slot for minutes — it is waiting
    /// on a person's agent to wrap up — and an `import` for the peer's whole
    /// finalization window. Drained serially, either one stalled every other
    /// transfer work item on the machine: an unrelated import, a pairing cleanup,
    /// a push the operator had just asked for. The slot was ~1.5 s before
    /// finalization started waiting on the agent, which is why serial drained
    /// fine until it did not.
    #[tokio::test]
    async fn a_slow_item_does_not_hold_up_an_unrelated_transfer() {
        let (harness, mut finished) = Harness::start("desktop-engine-headofline", |db| {
            db.enqueue_transfer_work(
                "finalize:t-slow",
                queue::KIND_FINALIZE,
                Some("t-slow"),
                "{}",
            )
            .expect("slow work");
            db.enqueue_transfer_work("import:t-fast", queue::KIND_IMPORT, Some("t-fast"), "{}")
                .expect("fast work");
        });
        // The slow one is claimed first — it was queued first — and never returns
        // until this test lets it.
        let engine = harness.spawn(|item| item.transfer_id.as_deref() == Some("t-slow"));

        let ran = tokio::time::timeout(Duration::from_secs(5), finished.recv())
            .await
            .expect("an unrelated transfer waited behind a finalization")
            .expect("finished");
        assert_eq!(ran, "import:t-fast");
        assert_eq!(
            harness.status("import:t-fast").as_deref(),
            Some("done"),
            "the unrelated item ran but its outcome was not recorded",
        );
        assert_eq!(
            harness.status("finalize:t-slow").as_deref(),
            Some("running"),
            "the slow item was supposed to still be in flight",
        );

        harness.release.notify_waiters();
        let ran = tokio::time::timeout(Duration::from_secs(5), finished.recv())
            .await
            .expect("the released item never finished")
            .expect("finished");
        assert_eq!(ran, "finalize:t-slow");
        engine.abort();
    }

    /// …and concurrency stops at the transfer boundary.
    ///
    /// One transfer's items are a sequence, not a set: the finalization has to
    /// answer the destination's peer request before the commit receipt closes the
    /// source task. Serial draining gave that by accident; the claim's
    /// busy-transfer exclusion is what states it, so the two run one after the
    /// other in the order the queue hands them out
    /// (`a_transfer_already_in_flight_is_passed_over_without_spending_an_attempt`).
    #[tokio::test]
    async fn two_items_of_one_transfer_never_run_at_once() {
        let (harness, mut finished) = Harness::start("desktop-engine-sequence", |db| {
            db.enqueue_transfer_work("finalize:t-1", queue::KIND_FINALIZE, Some("t-1"), "{}")
                .expect("first");
            db.enqueue_transfer_work(
                "committed:t-1",
                queue::KIND_OUTGOING_COMMITTED,
                Some("t-1"),
                "{}",
            )
            .expect("second");
        });
        let engine = harness.spawn(|_| false);

        for _ in 0..2 {
            tokio::time::timeout(Duration::from_secs(5), finished.recv())
                .await
                .expect("an item of the same transfer never ran")
                .expect("finished");
        }
        engine.abort();

        assert_eq!(
            harness.peak_in_flight.load(Ordering::SeqCst),
            1,
            "two items of one transfer ran concurrently: {:?}",
            harness.started(),
        );
        let started = harness.started();
        assert_eq!(started.len(), 2, "{started:?}");
        assert_ne!(started[0], started[1], "one item ran twice: {started:?}");
    }
}
