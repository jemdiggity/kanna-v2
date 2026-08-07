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

mod import;
mod push;

use crate::http_api::AppState;
use queue::TransferWorkQueue;
use std::sync::Arc;
use std::time::Duration;

/// How long the drain loop parks when nothing is runnable. Appends wake it
/// immediately; this only bounds how long a backed-off retry waits when no new
/// work arrives in the meantime.
const IDLE_POLL: Duration = Duration::from_secs(30);

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
    loop {
        let claimed = match queue.open_db().and_then(|db| {
            db.claim_next_transfer_work()
                .map_err(|error| format!("db error: {error}"))
        }) {
            Ok(claimed) => claimed,
            Err(error) => {
                log::error!("failed to read the transfer work queue: {error}");
                queue.wait_for_work(IDLE_POLL).await;
                continue;
            }
        };
        let Some(item) = claimed else {
            let delay = queue
                .open_db()
                .and_then(|db| {
                    db.next_transfer_work_delay_seconds()
                        .map_err(|error| format!("db error: {error}"))
                })
                .ok()
                .flatten()
                .map(|seconds| Duration::from_secs(seconds.max(0) as u64))
                .unwrap_or(IDLE_POLL);
            queue.wait_for_work(delay.min(IDLE_POLL)).await;
            continue;
        };

        let outcome = execute(&state, &item).await;
        let Ok(db) = queue.open_db() else {
            // Nothing can be recorded without the DB; the item stays `running`
            // and the next startup requeues it rather than losing it.
            log::error!("failed to record transfer work {} outcome", item.id);
            continue;
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
                    Ok(false) => report_exhausted_work(&state, &item, &reason).await,
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
    Ok(())
}

async fn execute(state: &Arc<AppState>, item: &crate::db::TransferWorkItem) -> Result<(), String> {
    let payload: serde_json::Value = serde_json::from_str(&item.payload_json)
        .map_err(|error| format!("invalid transfer work payload: {error}"))?;
    match item.kind.as_str() {
        queue::KIND_INCOMING_REQUEST => import::record_incoming(state, &payload).await,
        queue::KIND_IMPORT => import::import_transfer(state, item, &payload).await,
        queue::KIND_REJECT => import::reject_transfer(state, &payload).await,
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
    let Some(transfer_id) = item.transfer_id.as_deref() else {
        return;
    };
    let Ok(db) = state.transfer_work().open_db() else {
        return;
    };
    let reason = format!("transfer work {} gave up: {reason}", item.kind);
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
