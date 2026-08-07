//! The source side of a transfer: push, finalize, and the commit
//! acknowledgment that closes the source task.
//!
//! Port of `pushTaskToPeer`, `runOutgoingTransferFinalization` and
//! `handleOutgoingTransferCommitted`. Two things change with the move. The
//! duplicate-push guard is now transactional rather than a renderer snapshot
//! racing the DB — the row this process is about to write is the row it just
//! read. And the phase that must happen at most once (signalling the source
//! agent) claims a durable phase rather than an in-memory set, so a resumed
//! work item cannot signal a second time.

use super::control;
use super::payload::{
    self, OutgoingTransferPayload, RepoAcquisitionMode, TransferBundlePayload,
    TransferFinalizationState, TransferRepoPayload, TransferTaskPayload,
};
use super::session;
use crate::db::{Db, TransferWorkItem};
use crate::http_api::AppState;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

/// How long the source waits for its agent session to exit after the SIGINT.
///
/// Ported unchanged from the renderer. The finalization redesign (T7) replaces
/// this whole sequence with notify → idle → quit → exit driven off the daemon
/// status events the server already consumes; until then a session that does
/// not exit inside the window degrades the transfer rather than failing it.
const SOURCE_FINALIZATION_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

/// The source task as the engine needs it: the pipeline row plus the two
/// fields that live beside it — the provider session a push must ship, and the
/// worktree that session's transcript is keyed by.
struct SourceTask {
    item: crate::db::PipelineItem,
    agent_session_id: Option<String>,
    worktree_path: Option<std::path::PathBuf>,
}

impl SourceTask {
    fn load(db: &Db, task_id: &str) -> Result<Option<Self>, String> {
        let Some(item) = db
            .get_pipeline_item(task_id)
            .map_err(|error| format!("db error: {error}"))?
        else {
            return Ok(None);
        };
        Ok(Some(Self {
            agent_session_id: db
                .task_agent_session_id(&item.id)
                .map_err(|error| format!("db error: {error}"))?,
            worktree_path: db
                .get_task_worktree_path(&item.id)
                .map_err(|error| format!("db error: {error}"))?
                .map(std::path::PathBuf::from),
            item,
        }))
    }

    fn plan_identity(&self) -> String {
        session::session_plan_identity(
            self.agent_session_id.as_deref(),
            self.item.agent_provider.as_deref(),
            self.item.agent_type.as_deref(),
            self.item.branch.as_deref(),
        )
    }

    /// Locates the session state a transfer of this task would promise.
    fn plan(&self) -> Result<Option<session::SessionArtifactPlan>, String> {
        session::plan_session_artifacts(
            &home_dir()?,
            self.agent_session_id.as_deref(),
            self.item.agent_provider.as_deref(),
            self.item.agent_type.as_deref(),
            self.worktree_path.as_deref(),
            &self.item.id,
        )
        .map_err(|missing| missing.0)
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn home_dir() -> Result<std::path::PathBuf, String> {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .map_err(|_| "HOME is unset; the transfer engine cannot locate session state".to_string())
}

/// Where engine-owned staging files (bundles, session archives) are written
/// before the sidecar takes ownership of them.
fn staging_dir() -> std::path::PathBuf {
    std::env::temp_dir()
}

/// Pushes a task to a peer.
///
/// The work payload carries the same options the renderer's push took, so a
/// pull request and an operator's "push to machine" schedule the same work.
pub async fn push_task(state: &Arc<AppState>, work: &Value) -> Result<(), String> {
    let peer_id = string_field(work, "requester_peer_id")
        .or_else(|| string_field(work, "peerId"))
        .ok_or_else(|| "transfer push work is missing a peer id".to_string())?;
    let source_task_id = string_field(work, "source_task_id")
        .or_else(|| string_field(work, "sourceTaskId"))
        .ok_or_else(|| "transfer push work is missing a source task id".to_string())?;
    let transport = string_field(work, "transport");
    let cloud_fallback = work
        .get("cloudFallback")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let target_desktop_id = string_field(work, "targetDesktopId");

    let db = state.transfer_work().open_db()?;
    let Some(source) = SourceTask::load(&db, &source_task_id)? else {
        return Err(format!("task not found: {source_task_id}"));
    };
    if source.item.closed_at.is_some() {
        // A closed task is not a failure to retry: whatever the requester
        // wanted has already ended.
        log::info!("skipping transfer push for closed task {source_task_id}");
        return Ok(());
    }
    // The authoritative eligibility read. In the renderer this was a snapshot
    // that lagged the DB, which is how two pull deliveries both passed it and
    // collided on `idx_task_transfer_active_outgoing_source`.
    if let Some(existing) = db
        .active_outgoing_transfer_for_source(&source_task_id)
        .map_err(|error| format!("db error: {error}"))?
    {
        log::info!(
            "task {source_task_id} already has active outgoing transfer {}; skipping duplicate push",
            existing.id
        );
        return Ok(());
    }
    let repo = db
        .get_repo(&source.item.repo_id)
        .map_err(|error| format!("db error: {error}"))?
        .ok_or_else(|| format!("repo not found for task: {source_task_id}"))?;
    let repo_path = std::path::PathBuf::from(&repo.path);

    let source_desktop_id = target_desktop_id
        .as_ref()
        .map(|_| state.config().desktop_id.trim().to_string())
        .filter(|desktop_id| !desktop_id.is_empty());
    if target_desktop_id.is_some() && source_desktop_id.is_none() {
        return Err("source desktop identity is unavailable for cloud transfer".to_string());
    }

    let preflight = control::preflight(
        state,
        &source_task_id,
        &peer_id,
        transport.as_deref(),
        cloud_fallback,
    )
    .await?;

    // Everything below owns durable sidecar state. A failure past this point
    // releases it rather than leaving a reservation and staged files behind.
    let result = stage_and_commit(
        state,
        &db,
        &preflight,
        &source,
        &repo,
        &repo_path,
        &peer_id,
        source_desktop_id.as_deref(),
        target_desktop_id.as_deref(),
    )
    .await;
    if result.is_err() {
        release_reservation(state, &preflight.transfer_id).await;
    }
    result
}

/// Hands a never-to-be-committed preflight reservation back to the sidecar.
///
/// The reservation is durable on both machines and may already own staged
/// artifacts, so failing to release it leaks disk state. A release that itself
/// fails is reported rather than swallowed: the reservation is then genuinely
/// orphaned, and only the operator can clear it.
async fn release_reservation(state: &Arc<AppState>, transfer_id: &str) {
    if let Err(error) = control::abandon(state, transfer_id).await {
        log::error!(
            "failed to release abandoned transfer reservation {transfer_id}; \
             it is orphaned until an operator clears it: {error}"
        );
    }
}

#[allow(clippy::too_many_arguments)]
async fn stage_and_commit(
    state: &Arc<AppState>,
    db: &Db,
    preflight: &control::PreflightResult,
    source: &SourceTask,
    repo: &crate::db::Repo,
    repo_path: &Path,
    peer_id: &str,
    source_desktop_id: Option<&str>,
    target_desktop_id: Option<&str>,
) -> Result<(), String> {
    let transfer_id = preflight.transfer_id.as_str();
    let remote_url = if preflight.target_has_repo {
        None
    } else {
        super::git::remote_url(repo_path)
    };

    let mut bundle = None;
    if !preflight.target_has_repo && remote_url.is_none() {
        let bundle_path = session::bundle_staging_path(&staging_dir(), transfer_id);
        let ref_name = super::git::create_bundle(
            repo_path,
            &bundle_path,
            source.item.branch.as_deref(),
            source.item.base_ref.as_deref(),
        )?;
        let artifact_id = session::artifact_id(transfer_id, "repo-bundle");
        control::stage_artifact(state, transfer_id, &artifact_id, &bundle_path, true).await?;
        bundle = Some(TransferBundlePayload {
            artifact_id,
            filename: format!("{transfer_id}.bundle"),
            ref_name,
        });
    }

    let artifacts = stage_session_artifacts(state, source, transfer_id).await?;
    let payload = build_payload(
        state,
        source,
        repo,
        preflight,
        peer_id,
        source_desktop_id,
        target_desktop_id,
        remote_url.as_deref(),
        bundle,
        artifacts,
        TransferFinalizationState::clean(),
    )
    .await?;
    let encoded = payload::encode_outgoing_transfer_payload(&payload)?;

    match db.insert_task_transfer(&crate::db::NewTaskTransfer {
        id: transfer_id.to_string(),
        direction: "outgoing".into(),
        status: "pending".into(),
        source_peer_id: Some(preflight.source_peer_id.clone()),
        target_peer_id: Some(peer_id.to_string()),
        source_desktop_id: source_desktop_id.map(str::to_string),
        target_desktop_id: target_desktop_id.map(str::to_string),
        source_task_id: Some(source.item.id.clone()),
        local_task_id: Some(source.item.id.clone()),
        error: None,
        payload_json: Some(serde_json::to_string(&encoded).map_err(|error| error.to_string())?),
    }) {
        Ok(()) => {}
        // Another push won the race between the read above and this insert.
        // Both reads are now this process's own, so this is a genuine
        // concurrency window rather than a stale snapshot — and the loser's
        // reservation is released by the caller.
        Err(error) if crate::db::is_active_outgoing_transfer_conflict(&error) => {
            return Err(format!(
                "active_outgoing_transfer_exists for {}: releasing duplicate reservation",
                source.item.id
            ));
        }
        Err(error) => return Err(format!("db error: {error}")),
    }

    control::commit(state, transfer_id, &encoded).await
}

async fn stage_session_artifacts(
    state: &Arc<AppState>,
    source: &SourceTask,
    transfer_id: &str,
) -> Result<Vec<payload::TransferArtifactPayload>, String> {
    let Some(plan) = source.plan()? else {
        return Ok(Vec::new());
    };
    let staged = session::stage_plan(&plan, transfer_id, &staging_dir())?;
    let mut artifacts = Vec::with_capacity(staged.len());
    for artifact in staged {
        control::stage_artifact(
            state,
            transfer_id,
            &artifact.payload.artifact_id,
            &artifact.source_path,
            artifact.owned,
        )
        .await?;
        artifacts.push(artifact.payload);
    }
    Ok(artifacts)
}

#[allow(clippy::too_many_arguments)]
async fn build_payload(
    state: &Arc<AppState>,
    source: &SourceTask,
    repo: &crate::db::Repo,
    preflight: &control::PreflightResult,
    peer_id: &str,
    source_desktop_id: Option<&str>,
    target_desktop_id: Option<&str>,
    remote_url: Option<&str>,
    bundle: Option<TransferBundlePayload>,
    artifacts: Vec<payload::TransferArtifactPayload>,
    finalization: TransferFinalizationState,
) -> Result<OutgoingTransferPayload, String> {
    let mode = payload::choose_repo_acquisition_mode(remote_url, preflight.target_has_repo);
    Ok(OutgoingTransferPayload {
        target_peer_id: peer_id.to_string(),
        target_desktop_id: target_desktop_id.map(str::to_string),
        task: TransferTaskPayload {
            cloud_task_id: source
                .item
                .cloud_task_id
                .clone()
                .unwrap_or_else(|| source.item.id.clone()),
            source_peer_id: preflight.source_peer_id.clone(),
            source_desktop_id: source_desktop_id.map(str::to_string),
            source_task_id: source.item.id.clone(),
            local_task_id: Some(source.item.id.clone()),
            resume_session_id: source.agent_session_id.clone(),
            prompt: source.item.prompt.clone(),
            stage: source
                .item
                .stage
                .clone()
                .unwrap_or_else(|| "in progress".into()),
            branch: source.item.branch.clone(),
            pipeline: source
                .item
                .pipeline
                .clone()
                .unwrap_or_else(|| "no-review".into()),
            display_name: source.item.display_name.clone(),
            base_ref: source.item.base_ref.clone(),
            agent_type: source.item.agent_type.clone(),
            agent_provider: source
                .item
                .agent_provider
                .clone()
                .unwrap_or_else(|| "claude".to_string()),
        },
        repo: TransferRepoPayload {
            mode,
            remote_url: remote_url.map(str::to_string),
            path: Some(repo.path.clone()),
            name: Some(repo.name.clone()),
            default_branch: repo.default_branch.clone(),
            bundle: (mode == RepoAcquisitionMode::BundleRepo)
                .then_some(bundle)
                .flatten(),
        },
        recovery: session_recovery_snapshot(state, &source.item.id).await,
        artifacts,
        finalization,
    })
}

/// The terminal snapshot the destination replays before the agent takes over.
///
/// Best effort by design: a session that has already exited, or a daemon that
/// is between generations, means the destination starts with a blank terminal
/// rather than the transfer failing.
async fn session_recovery_snapshot(
    state: &Arc<AppState>,
    session_id: &str,
) -> Option<crate::mobile_api::CreateTaskRecoverySnapshot> {
    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config().daemon_dir)
        .await
        .ok()?;
    let event = daemon
        .send_command(&kanna_daemon::protocol::Command::Snapshot {
            session_id: session_id.to_string(),
        })
        .await
        .ok()?;
    let kanna_daemon::protocol::Event::Snapshot { snapshot, .. } = event else {
        return None;
    };
    let snapshot = crate::mobile_api::CreateTaskRecoverySnapshot {
        serialized: snapshot.vt,
        cols: snapshot.cols,
        rows: snapshot.rows,
        cursor_row: snapshot.cursor_row,
        cursor_col: snapshot.cursor_col,
        cursor_visible: snapshot.cursor_visible,
        saved_at: snapshot.saved_at,
        sequence: snapshot.sequence,
    };
    // The payload is validated as a whole before it is committed, so a snapshot
    // the destination would refuse is dropped here rather than failing the
    // transfer over a terminal picture.
    snapshot.validate().ok().map(|()| snapshot)
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

/// Answers the destination's finalization request.
///
/// A finalization that cannot honour the payload it is about to write fails the
/// transfer instead of shipping whatever happened to be on disk. The source
/// task is deliberately left alone: losing the transfer is recoverable, losing
/// the conversation is not.
pub async fn finalize(
    state: &Arc<AppState>,
    work: &TransferWorkItem,
    event: &Value,
) -> Result<(), String> {
    let transfer_id = string_field(event, "transfer_id")
        .or_else(|| string_field(event, "transferId"))
        .ok_or_else(|| "finalization work is missing a transfer id".to_string())?;

    match run_finalization(state, work, &transfer_id).await {
        Ok((encoded, finalized_cleanly)) => {
            control::complete_finalization(
                state,
                &transfer_id,
                Some(&encoded),
                finalized_cleanly,
                None,
            )
            .await
        }
        Err(reason) => {
            let db = state.transfer_work().open_db()?;
            if let Err(error) = db.fail_outgoing_task_transfer(&transfer_id, &reason) {
                log::error!("failed to mark outgoing transfer {transfer_id} failed: {error}");
            }
            // The destination is blocked on this answer. Reporting the failure
            // is what ends its side too; the renderer could not do this once
            // its window was gone, which is why the 2026-08-06 transfer hung.
            control::complete_finalization(state, &transfer_id, None, false, Some(&reason)).await?;
            Err(reason)
        }
    }
}

async fn run_finalization(
    state: &Arc<AppState>,
    work: &TransferWorkItem,
    transfer_id: &str,
) -> Result<(Value, bool), String> {
    let db = state.transfer_work().open_db()?;
    let transfer = db
        .get_task_transfer(transfer_id)
        .map_err(|error| format!("db error: {error}"))?
        .ok_or_else(|| format!("outgoing transfer not found: {transfer_id}"))?;
    if transfer.direction != "outgoing" {
        return Err(format!("transfer is not outgoing: {transfer_id}"));
    }
    let existing = payload::parse_outgoing_transfer_payload(
        &serde_json::from_str::<Value>(transfer.payload_json.as_deref().unwrap_or("null"))
            .map_err(|error| format!("persisted transfer payload is invalid: {error}"))?,
    )?;
    let local_task_id = transfer
        .local_task_id
        .clone()
        .ok_or_else(|| format!("outgoing transfer has no local task: {transfer_id}"))?;
    let source = SourceTask::load(&db, &local_task_id)?
        .ok_or_else(|| format!("source task not found for outgoing transfer: {transfer_id}"))?;
    let repo = db
        .get_repo(&source.item.repo_id)
        .map_err(|error| format!("db error: {error}"))?
        .ok_or_else(|| format!("repo not found for outgoing transfer: {transfer_id}"))?;

    // Locate the session state this payload will promise *before* signalling
    // the agent: a transfer that cannot ship the conversation must fail with
    // the source task still alive and running, not after it has been shut down.
    let planned_identity = source.plan_identity();
    source.plan()?;

    let mut finalized_cleanly = source.item.agent_type.as_deref() != Some("pty");
    let mut degraded_reason = None;
    if source.item.agent_type.as_deref() == Some("pty") {
        // Signalling is single-flight for the life of this work item, durably:
        // a retry after a partial failure must not interrupt the agent twice.
        let should_signal = db
            .claim_transfer_work_phase(&work.id, "pty-finalization-signal")
            .map_err(|error| format!("db error: {error}"))?;
        let signal_failure = if should_signal {
            signal_source_session(state, &source.item.id).await.err()
        } else {
            None
        };
        let exited = wait_for_session_exit(state, &source.item.id, SOURCE_FINALIZATION_WAIT).await;
        finalized_cleanly = exited && signal_failure.is_none();
        degraded_reason = match (&signal_failure, exited) {
            // The daemon refuses signals for adopted sessions by design — every
            // session older than the running daemon, so every task predating an
            // app upgrade. Too common to fail the transfer over, too important
            // to swallow: it degrades the transfer instead.
            (Some(failure), _) => Some(format!(
                "the source agent session could not be signalled to finish: {failure}"
            )),
            (None, false) => Some(format!(
                "the source agent session did not exit within {}ms",
                SOURCE_FINALIZATION_WAIT.as_millis()
            )),
            (None, true) => None,
        };
    }

    // The plan was located against the pre-signal task; re-plan only if the
    // session identity moved under us while the agent was shutting down.
    let refreshed = SourceTask::load(&db, &local_task_id)?.unwrap_or(source);
    if refreshed.plan_identity() != planned_identity {
        refreshed.plan()?;
    }

    let artifacts = stage_session_artifacts(state, &refreshed, transfer_id).await?;
    let remote_url = if existing.repo.mode == RepoAcquisitionMode::ReuseLocal {
        None
    } else {
        super::git::remote_url(Path::new(&repo.path)).or(existing.repo.remote_url.clone())
    };
    let finalization = match degraded_reason {
        Some(reason) => TransferFinalizationState::degraded(reason),
        None => TransferFinalizationState::clean(),
    };
    let payload = build_payload(
        state,
        &refreshed,
        &repo,
        &control::PreflightResult {
            transfer_id: transfer_id.to_string(),
            source_peer_id: transfer
                .source_peer_id
                .clone()
                .unwrap_or(existing.task.source_peer_id.clone()),
            target_has_repo: existing.repo.mode == RepoAcquisitionMode::ReuseLocal,
        },
        transfer
            .target_peer_id
            .as_deref()
            .unwrap_or(&existing.target_peer_id),
        transfer
            .source_desktop_id
            .as_deref()
            .or(existing.task.source_desktop_id.as_deref()),
        transfer
            .target_desktop_id
            .as_deref()
            .or(existing.target_desktop_id.as_deref()),
        remote_url.as_deref(),
        existing.repo.bundle.clone(),
        artifacts,
        finalization,
    )
    .await?;
    let encoded = payload::encode_outgoing_transfer_payload(&payload)?;
    let payload_json =
        serde_json::to_string(&encoded).map_err(|error| format!("db error: {error}"))?;
    if !db
        .update_task_transfer_payload(transfer_id, &payload_json, None)
        .map_err(|error| format!("db error: {error}"))?
    {
        return Err(format!(
            "failed to persist finalized outgoing transfer payload: {transfer_id}"
        ));
    }
    Ok((encoded, finalized_cleanly))
}

async fn signal_source_session(state: &Arc<AppState>, session_id: &str) -> Result<(), String> {
    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config().daemon_dir)
        .await
        .map_err(|error| format!("daemon error: {error}"))?;
    match daemon
        .send_command(&kanna_daemon::protocol::Command::Signal {
            session_id: session_id.to_string(),
            signal: "SIGINT".to_string(),
        })
        .await
        .map_err(|error| format!("daemon error: {error}"))?
    {
        kanna_daemon::protocol::Event::Ok => Ok(()),
        kanna_daemon::protocol::Event::Error { message, .. } => Err(message),
        other => Err(format!("unexpected daemon signal response: {other:?}")),
    }
}

/// Waits for the source agent session to end, bounded.
///
/// Subscribed rather than polled: the daemon already publishes `Exit`, and a
/// session that has already gone is answered by the `List` this opens with.
async fn wait_for_session_exit(
    state: &Arc<AppState>,
    session_id: &str,
    timeout: std::time::Duration,
) -> bool {
    let observe = async {
        let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config().daemon_dir)
            .await
            .ok()?;
        daemon
            .send_command(&kanna_daemon::protocol::Command::Subscribe)
            .await
            .ok()?;
        match daemon
            .send_command(&kanna_daemon::protocol::Command::List)
            .await
            .ok()?
        {
            kanna_daemon::protocol::Event::SessionList { sessions } => {
                if !sessions
                    .iter()
                    .any(|session| session.session_id == session_id)
                {
                    return Some(true);
                }
            }
            _ => return None,
        }
        loop {
            match daemon.read_event().await.ok()? {
                kanna_daemon::protocol::Event::Exit {
                    session_id: exited, ..
                } if exited == session_id => return Some(true),
                _ => continue,
            }
        }
    };
    matches!(tokio::time::timeout(timeout, observe).await, Ok(Some(true)))
}

// ---------------------------------------------------------------------------
// Commit acknowledgment
// ---------------------------------------------------------------------------

/// The destination has imported the task; close the source copy.
///
/// The close goes through the server's own close action — WIP snapshotting,
/// session teardown, the `closed` completion notification — rather than a
/// second implementation of it.
pub async fn outgoing_committed(
    state: &Arc<AppState>,
    work: &TransferWorkItem,
    event: &Value,
) -> Result<(), String> {
    let transfer_id = string_field(event, "transfer_id")
        .ok_or_else(|| "commit work is missing a transfer id".to_string())?;
    let source_task_id = string_field(event, "source_task_id")
        .ok_or_else(|| "commit work is missing a source task id".to_string())?;

    let db = state.transfer_work().open_db()?;
    let Some(transfer) = db
        .get_task_transfer(&transfer_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        // The durable row may already have been compacted after a previously
        // successful delivery whose sidecar response was lost. Tombstone the
        // receipt so it is not replayed after the next sidecar restart.
        return control::mark_import_commit_applied(state, &transfer_id).await;
    };
    if transfer.direction != "outgoing" {
        return Err(format!("transfer is not outgoing: {transfer_id}"));
    }
    if transfer.source_task_id.as_deref() != Some(source_task_id.as_str()) {
        return Err(format!(
            "outgoing transfer source task mismatch for {transfer_id}: expected {:?}, got {source_task_id}",
            transfer.source_task_id,
        ));
    }

    // Closing is single-flight for this work item: a retry after a partial
    // failure must not run a second close over a task that is already gone.
    if db
        .claim_transfer_work_phase(&work.id, "source-task-close")
        .map_err(|error| format!("db error: {error}"))?
    {
        if let Err((status, message)) =
            crate::http_api::close_task_in_process(Arc::clone(state), source_task_id.clone()).await
        {
            let already_closed = db
                .get_pipeline_item(&source_task_id)
                .map_err(|error| format!("db error: {error}"))?
                .is_some_and(|item| item.closed_at.is_some());
            if !already_closed {
                return Err(format!(
                    "failed to close source task for outgoing transfer {transfer_id}: {status} {message}"
                ));
            }
        }
    }

    if !db
        .mark_task_transfer_completed(
            &transfer_id,
            transfer.local_task_id.as_deref().unwrap_or(&source_task_id),
            None,
        )
        .map_err(|error| format!("db error: {error}"))?
    {
        return Err(format!(
            "failed to complete outgoing transfer: {transfer_id}"
        ));
    }
    control::mark_import_commit_applied(state, &transfer_id).await
}
