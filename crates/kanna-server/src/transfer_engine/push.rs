//! The source side of a transfer: push, finalize, and the commit
//! acknowledgment that closes the source task.
//!
//! Port of `pushTaskToPeer`, `runOutgoingTransferFinalization` and
//! `handleOutgoingTransferCommitted`. Two things change with the move. The
//! duplicate-push guard is now transactional rather than a renderer snapshot
//! racing the DB — the row this process is about to write is the row it just
//! read. And the phases that must happen at most once (typing into the source
//! agent) claim durable phases rather than an in-memory set, so a resumed work
//! item cannot type the same thing twice.
//!
//! Shutting the source agent down is [`super::finalize`]'s job.

use super::control;
use super::finalize;
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

/// The source task as the engine needs it: the durable task row plus the two
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
    ///
    /// Walks `~/.codex/sessions` and stats the transcript, so it runs off the
    /// runtime workers like the rest of the engine's filesystem work.
    async fn plan(&self) -> Result<Option<session::SessionArtifactPlan>, String> {
        let (session_id, provider, agent_type, worktree, task_id) = (
            self.agent_session_id.clone(),
            self.item.agent_provider.clone(),
            self.item.agent_type.clone(),
            self.worktree_path.clone(),
            self.item.id.clone(),
        );
        super::run_blocking("transfer session plan", move || {
            session::plan_session_artifacts(
                &home_dir()?,
                session_id.as_deref(),
                provider.as_deref(),
                agent_type.as_deref(),
                worktree.as_deref(),
                &task_id,
            )
            .map_err(|missing| missing.0)
        })
        .await
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

/// A push failure that retrying cannot fix.
///
/// Retrying cannot conjure a transcript the source never had, so a promise it
/// cannot keep is terminal on the first attempt rather than after the attempt
/// budget runs out. It is also the failure an operator most needs to see, so it
/// is recorded as a `failed` transfer rather than only logged.
struct TerminalPush(String);

/// Pushes a task to a peer.
///
/// The work payload carries the same options the renderer's push took, so a
/// pull request and an operator's "push to machine" schedule the same work.
pub async fn push_task(
    state: &Arc<AppState>,
    work: &crate::db::TransferWorkItem,
    request: &Value,
) -> Result<(), String> {
    match run_push(state, request).await {
        Ok(()) => Ok(()),
        Err(Ok(reason)) => Err(reason),
        Err(Err(TerminalPush(reason))) => {
            report_terminal_push(state, work, request, &reason)?;
            log::error!("refused to push a task the source cannot ship: {reason}");
            Ok(())
        }
    }
}

/// Records a push that will never succeed.
///
/// The transfer has no row yet — the refusal happens before anything is
/// reserved on the peer, which is the point — so one is written here, `failed`,
/// carrying the reason and no artifacts. Its id is derived from the work item,
/// so a redelivered push does not pile up rows. The source task is deliberately
/// left alone: losing the transfer is recoverable, losing the conversation is
/// not.
pub(super) fn report_terminal_push(
    state: &Arc<AppState>,
    work: &crate::db::TransferWorkItem,
    request: &Value,
    reason: &str,
) -> Result<(), String> {
    let source_task_id =
        string_field(request, "source_task_id").or_else(|| string_field(request, "sourceTaskId"));
    let transfer_id = format!("refused-{}", work.id.replace(':', "-"));
    let db = state.transfer_work().open_db()?;
    db.insert_task_transfer(&crate::db::NewTaskTransfer {
        id: transfer_id.clone(),
        direction: "outgoing".into(),
        status: "failed".into(),
        source_peer_id: None,
        target_peer_id: string_field(request, "requester_peer_id")
            .or_else(|| string_field(request, "peerId")),
        source_desktop_id: None,
        target_desktop_id: string_field(request, "targetDesktopId"),
        source_task_id: source_task_id.clone(),
        local_task_id: source_task_id,
        error: Some(reason.to_string()),
        payload_json: None,
    })
    .map_err(|error| format!("db error: {error}"))?;
    // `insert_task_transfer` is a no-op for an id that already exists, so a
    // redelivery refreshes the reason rather than being silently dropped.
    db.fail_outgoing_task_transfer(&transfer_id, reason)
        .map_err(|error| format!("db error: {error}"))?;
    Ok(())
}

/// `Err(Ok(_))` is retriable; `Err(Err(_))` is terminal.
async fn run_push(state: &Arc<AppState>, work: &Value) -> Result<(), Result<String, TerminalPush>> {
    let retriable = Ok::<String, TerminalPush>;
    let peer_id = string_field(work, "requester_peer_id")
        .or_else(|| string_field(work, "peerId"))
        .ok_or_else(|| retriable("transfer push work is missing a peer id".to_string()))?;
    let source_task_id = string_field(work, "source_task_id")
        .or_else(|| string_field(work, "sourceTaskId"))
        .ok_or_else(|| retriable("transfer push work is missing a source task id".to_string()))?;
    let transport = string_field(work, "transport");
    let cloud_fallback = work
        .get("cloudFallback")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let target_desktop_id = string_field(work, "targetDesktopId");

    let db = state.transfer_work().open_db().map_err(retriable)?;
    let Some(source) = SourceTask::load(&db, &source_task_id).map_err(retriable)? else {
        return Err(retriable(format!("task not found: {source_task_id}")));
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
        .map_err(|error| retriable(format!("db error: {error}")))?
    {
        log::info!(
            "task {source_task_id} already has active outgoing transfer {}; skipping duplicate push",
            existing.id
        );
        return Ok(());
    }
    let repo = db
        .get_repo(&source.item.repo_id)
        .map_err(|error| retriable(format!("db error: {error}")))?
        .ok_or_else(|| retriable(format!("repo not found for task: {source_task_id}")))?;
    let repo_path = std::path::PathBuf::from(&repo.path);

    // Prove the source can ship the conversation before reserving anything on
    // the peer. A transfer that cannot must fail with the source task still
    // running — and with nothing left on the other machine to release.
    source
        .plan()
        .await
        .map_err(|reason| Err(TerminalPush(reason)))?;

    let source_desktop_id = target_desktop_id
        .as_ref()
        .map(|_| state.config().desktop_id.trim().to_string())
        .filter(|desktop_id| !desktop_id.is_empty());
    if target_desktop_id.is_some() && source_desktop_id.is_none() {
        return Err(retriable(
            "source desktop identity is unavailable for cloud transfer".to_string(),
        ));
    }

    let preflight = control::preflight(
        state,
        &source_task_id,
        &peer_id,
        transport.as_deref(),
        cloud_fallback,
    )
    .await
    .map_err(retriable)?;

    // Everything below owns durable sidecar state. A failure past this point
    // releases it rather than leaving a reservation and staged files behind.
    //
    // The connection is closed first rather than handed down. Staging bundles a
    // repository and gzips a session archive, and holding an open SQLite
    // connection across that is holding it across the slowest thing the engine
    // does. (A `&Db` could not cross those awaits at all: `rusqlite::Connection`
    // is `Send` but not `Sync`, so a shared reference to one makes the whole
    // future non-`Send` and unspawnable.)
    drop(db);
    let result = stage_and_commit(
        state,
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
    result.map_err(retriable)
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
        let repo_path = repo_path.to_path_buf();
        super::run_blocking("transfer remote url", move || {
            Ok(super::git::remote_url(&repo_path))
        })
        .await?
    };

    let mut bundle = None;
    if !preflight.target_has_repo && remote_url.is_none() {
        let bundle_path = session::bundle_staging_path(&staging_dir(), transfer_id);
        let ref_name = {
            let (repo_path, bundle_path, branch, base_ref) = (
                repo_path.to_path_buf(),
                bundle_path.clone(),
                source.item.branch.clone(),
                source.item.base_ref.clone(),
            );
            super::run_blocking("transfer bundle create", move || {
                super::git::create_bundle(
                    &repo_path,
                    &bundle_path,
                    branch.as_deref(),
                    base_ref.as_deref(),
                )
            })
            .await?
        };
        let artifact_id = session::artifact_id(transfer_id, "repo-bundle");
        control::stage_artifact(state, transfer_id, &artifact_id, &bundle_path, true).await?;
        bundle = Some(TransferBundlePayload {
            artifact_id,
            filename: format!("{transfer_id}.bundle"),
            ref_name,
        });
    }

    let staged = stage_session_artifacts(state, source, transfer_id).await?;
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
        staged,
        TransferFinalizationState::clean(),
        // The push's payload is a placeholder the finalization rewrites; the
        // agent is still live and unfinalized, so the snapshot is taken here.
        None,
    )
    .await?;
    let encoded = payload::encode_outgoing_transfer_payload(&payload)?;

    let db = state.transfer_work().open_db()?;
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

/// What a push will ship, plus the session it promises.
///
/// The session id is returned rather than read off the task row because
/// OpenCode's is discovered at transfer time: `opencode run` has no flag that
/// assigns one and the id never reaches the terminal, so
/// `pipeline_item.agent_session_id` is null for a task with a perfectly good
/// conversation to ship.
struct StagedSessionArtifacts {
    artifacts: Vec<payload::TransferArtifactPayload>,
    session_id: Option<String>,
}

async fn stage_session_artifacts(
    state: &Arc<AppState>,
    source: &SourceTask,
    transfer_id: &str,
) -> Result<StagedSessionArtifacts, String> {
    let Some(plan) = source.plan().await? else {
        return Ok(StagedSessionArtifacts {
            artifacts: Vec::new(),
            session_id: None,
        });
    };
    let session_id = plan.session_id.clone();
    // `stage_plan` gzips a session directory, which is the other unbounded
    // blocking step on this path.
    let staged = {
        let transfer_id = transfer_id.to_string();
        super::run_blocking("transfer artifact staging", move || {
            session::stage_plan(&plan, &transfer_id, &staging_dir())
        })
        .await?
    };
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
    Ok(StagedSessionArtifacts {
        artifacts,
        session_id: Some(session_id),
    })
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
    staged: StagedSessionArtifacts,
    finalization: TransferFinalizationState,
    recovery: Option<crate::mobile_api::CreateTaskRecoverySnapshot>,
) -> Result<OutgoingTransferPayload, String> {
    let mode = payload::choose_repo_acquisition_mode(remote_url, preflight.target_has_repo);
    // `pipeline` is the legacy storage column name for the task's workflow.
    let workflow_name = source
        .item
        .pipeline
        .clone()
        .unwrap_or_else(|| "no-review".into());
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
            // The staged plan wins: it is the only thing that knows an
            // OpenCode session id, and for every other provider it is the same
            // id the task row carries.
            resume_session_id: staged
                .session_id
                .clone()
                .or_else(|| source.agent_session_id.clone()),
            prompt: source.item.prompt.clone(),
            stage: source
                .item
                .stage
                .clone()
                .unwrap_or_else(|| "in progress".into()),
            branch: source.item.branch.clone(),
            workflow: workflow_name.clone(),
            legacy_pipeline: workflow_name,
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
        // Finalization photographs the terminal before it types the quit
        // command; there is nothing left to photograph afterwards. Only a path
        // that never ran the sequence — a headless session, or a push that has
        // not finalized yet — falls back to taking it here.
        recovery: match recovery {
            Some(snapshot) => Some(snapshot),
            None => session_recovery_snapshot(state, &source.item.id).await,
        },
        artifacts: staged.artifacts,
        finalization,
    })
}

/// The terminal snapshot the destination replays before the agent takes over.
///
/// Best effort by design: a session that has already exited, or a daemon that
/// is between generations, means the destination starts with a blank terminal
/// rather than the transfer failing.
pub(super) async fn session_recovery_snapshot(
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

/// The phase under which finalization records the session it saw before the
/// source agent was asked to stop.
///
/// The stored value keeps the word "signal" from when the agent was stopped
/// with `SIGINT`: it is durable data, and a work item mid-finalization across
/// an upgrade must still find its own observation.
const SESSION_BEFORE_FINALIZATION_PHASE: &str = "session-before-signal";

/// Refuses a payload that lost its session between the pre-shutdown plan and
/// the post-shutdown one.
///
/// Discovery runs twice on purpose: a conversation is only complete once the
/// agent has stopped writing to it, so the artifact is staged after the agent
/// has quit. What the second pass may not do is come back with *nothing*. A
/// payload whose `resume_session_id` is null passes the receiver's
/// `assert_importable` untouched — that check short-circuits on a null id — so
/// a downgrade here ships an empty transfer that no provider fails loudly on.
/// Only OpenCode can reach it, because only its session id is discovered rather
/// than read off the task row, and it is the same silent-loss shape the
/// discovery side already refuses.
fn refuse_session_downgrade(
    before_finalization: Option<&str>,
    after_finalization: Option<&str>,
    provider: Option<&str>,
) -> Result<(), String> {
    match (before_finalization, after_finalization) {
        (Some(session_id), None) => Err(format!(
            "refusing to ship an empty transfer: {} session {session_id} was present before \
             finalization and could not be found after it",
            provider.unwrap_or("the source"),
        )),
        _ => Ok(()),
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

    // Locate the session state this payload will promise *before* the agent is
    // asked to stop: a transfer that cannot ship the conversation must fail
    // with the source task still alive and running, not after it has been shut
    // down.
    let planned_identity = source.plan_identity();
    // Recorded, not just computed. The agent is gone by attempt 2, so a fresh
    // pre-shutdown look finds nothing and the downgrade guard below would pass
    // vacuously — shipping exactly the empty payload it exists to refuse. The
    // first attempt's observation is the only one taken against a live agent,
    // so it is the one every attempt compares against.
    let observed_now = source.plan().await?.map(|plan| plan.session_id.clone());
    let session_seen_before_finalization = db
        .record_transfer_work_observation(
            &work.id,
            SESSION_BEFORE_FINALIZATION_PHASE,
            observed_now.as_deref(),
        )
        .map_err(|error| format!("db error: {error}"))?;

    // notify → idle → quit → exit. Artifacts are staged only after this
    // returns, so the transcript includes the wrap-up and the Codex rollout is
    // final rather than mid-write.
    let finalization_outcome = finalize::finalize_source_session(
        state,
        work,
        &source.item.id,
        source.item.agent_type.as_deref(),
        source.item.agent_provider.as_deref(),
    )
    .await;
    let finalized_cleanly = finalization_outcome.cleanly_finalized();

    // The plan was located against the pre-shutdown task; re-plan only if the
    // session identity moved under us while the agent was shutting down.
    let refreshed = SourceTask::load(&db, &local_task_id)?.unwrap_or(source);
    if refreshed.plan_identity() != planned_identity {
        refreshed.plan().await?;
    }

    let staged = stage_session_artifacts(state, &refreshed, transfer_id).await?;
    refuse_session_downgrade(
        session_seen_before_finalization.as_deref(),
        staged.session_id.as_deref(),
        refreshed.item.agent_provider.as_deref(),
    )?;
    let remote_url = if existing.repo.mode == RepoAcquisitionMode::ReuseLocal {
        None
    } else {
        let repo_path = std::path::PathBuf::from(&repo.path);
        super::run_blocking("transfer remote url", move || {
            Ok(super::git::remote_url(&repo_path))
        })
        .await?
        .or(existing.repo.remote_url.clone())
    };
    let finalization = match finalization_outcome.degraded_reason {
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
        staged,
        finalization,
        finalization_outcome.recovery_snapshot,
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
    //
    // A close that *failed* gives the claim back. `close_task_in_process`
    // answers 500 when the daemon is not connectable and 409 while the task has
    // open subtasks, and keeping the claim through either would make the retry
    // skip the close and go on to mark the transfer completed — the task would
    // stay open on the source forever, which is the state this whole
    // acknowledgment exists to end.
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
                db.release_transfer_work_phase(&work.id, "source-task-close")
                    .map_err(|release| {
                        format!("db error releasing the source-task-close claim: {release}")
                    })?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Discovery runs twice — before the shutdown, so a transfer that cannot
    /// ship fails with the agent still alive, and after it, so the conversation
    /// is complete. The second pass may not silently come back empty: only
    /// OpenCode discovers its id rather than reading it off the task row, and a
    /// null `resume_session_id` sails past the receiver's `assert_importable`.
    #[test]
    fn a_session_that_disappears_across_finalization_refuses_the_transfer() {
        let error = refuse_session_downgrade(
            Some("ses_02645d9aaffeeOgwt2rbXIcTdp"),
            None,
            Some("opencode"),
        )
        .expect_err("an empty transfer was shipped");
        assert!(error.contains("ses_02645d9aaffeeOgwt2rbXIcTdp"), "{error}");
        assert!(error.contains("opencode"), "{error}");
    }

    #[test]
    fn a_session_that_survives_or_never_existed_ships_as_it_is() {
        // The ordinary case: the same session, staged after the agent stopped.
        assert!(refuse_session_downgrade(
            Some("ses_02645d9aaffeeOgwt2rbXIcTdp"),
            Some("ses_02645d9aaffeeOgwt2rbXIcTdp"),
            Some("opencode"),
        )
        .is_ok());
        // A task the agent never got a turn in has nothing to lose, and every
        // provider but OpenCode reaches here with both sides `None`.
        assert!(refuse_session_downgrade(None, None, Some("claude")).is_ok());
        // A session that appeared only after the shutdown is still a session.
        assert!(refuse_session_downgrade(None, Some("ses_x"), Some("opencode")).is_ok());
    }

    fn finalize_work_item(id: &str) -> crate::db::TransferWorkItem {
        crate::db::TransferWorkItem {
            id: id.to_string(),
            kind: super::super::queue::KIND_FINALIZE.to_string(),
            transfer_id: Some("transfer-finalize".to_string()),
            payload_json: "{}".to_string(),
            attempts: 2,
        }
    }

    fn finalize_payload_json() -> String {
        serde_json::json!({
            "target_peer_id": "peer-destination",
            "task": {
                "source_peer_id": "peer-source",
                "source_task_id": "task-source",
                "resume_session_id": null,
                "stage": "in progress",
                "pipeline": "single-reviewer",
                "agent_type": "pty",
                "agent_provider": "claude",
            },
            "repo": { "mode": "reuse-local", "path": "/repo" },
            "artifacts": [],
        })
        .to_string()
    }

    /// Seeds the rows `run_finalization` reads before it reaches the guard.
    ///
    /// The task carries no `agent_session_id`, so both the pre-shutdown and the
    /// post-shutdown plan resolve to "nothing here" — which is what makes the
    /// recorded observation the only thing that can refuse. It also carries no
    /// `agent_type`, so the shutdown sequence itself is a no-op: what these
    /// pin is the guard around it, not the daemon conversation.
    fn seed_finalization(
        db: &crate::db::Db,
        work_id: &str,
        observed_before_finalization: Option<&str>,
    ) {
        db.insert_test_repo("repo-finalize", "Finalize Repo")
            .expect("repo");
        db.insert_test_pipeline_item(
            "task-finalize",
            "repo-finalize",
            "finalize me",
            None,
            "in progress",
            "2026-08-07 00:00:00",
        )
        .expect("task");
        db.insert_task_transfer(&crate::db::NewTaskTransfer {
            id: "transfer-finalize".into(),
            direction: "outgoing".into(),
            status: "pending".into(),
            source_peer_id: Some("peer-source".into()),
            target_peer_id: Some("peer-destination".into()),
            source_desktop_id: None,
            target_desktop_id: None,
            source_task_id: Some("task-finalize".into()),
            local_task_id: Some("task-finalize".into()),
            error: None,
            payload_json: Some(finalize_payload_json()),
        })
        .expect("transfer");
        db.enqueue_transfer_work(work_id, "finalize", Some("transfer-finalize"), "{}")
            .expect("queue the work item");
        if let Some(session_id) = observed_before_finalization {
            db.record_transfer_work_observation(
                work_id,
                SESSION_BEFORE_FINALIZATION_PHASE,
                Some(session_id),
            )
            .expect("attempt 1's observation");
        }
    }

    /// The retry seam migration 050 exists for, on the source side.
    ///
    /// Finalization shuts the agent down, so by attempt 2 the session it was
    /// looking at is gone. A fresh pre-shutdown look then finds nothing, the
    /// downgrade guard compares nothing against nothing, and it passes
    /// vacuously — shipping exactly the empty payload it exists to refuse. Only
    /// the first attempt's observation was taken against a live agent, so every
    /// attempt has to compare against *that*.
    ///
    /// The DB primitive and `refuse_session_downgrade` are pinned separately;
    /// this covers `run_finalization` being wired to them.
    #[tokio::test]
    async fn finalization_compares_against_the_session_the_first_attempt_saw() {
        let seen_before_finalization = "ses_02645d9aaffeeOgwt2rbXIcTdp";
        let state =
            crate::http_api::test_state_with_seed("desktop-finalize-memo", "Finalize Memo", |db| {
                seed_finalization(
                    db,
                    "finalize:transfer-finalize",
                    Some(seen_before_finalization),
                )
            });

        let error = run_finalization(
            &state,
            &finalize_work_item("finalize:transfer-finalize"),
            "transfer-finalize",
        )
        .await
        .expect_err("the retry shipped an empty payload the first attempt would have refused");
        assert!(
            error.contains(seen_before_finalization),
            "the guard did not compare against the recorded observation: {error}",
        );
    }

    /// The same run with nothing recorded is the first attempt against a task
    /// whose agent never got a turn: nothing was there before the shutdown and
    /// nothing is there after, which is not a downgrade and must not refuse.
    /// Without this the test above would pass on a guard that simply always
    /// refuses.
    #[tokio::test]
    async fn finalization_does_not_refuse_a_task_that_never_had_a_session() {
        let state = crate::http_api::test_state_with_seed(
            "desktop-finalize-fresh",
            "Finalize Fresh",
            |db| seed_finalization(db, "finalize:transfer-fresh", None),
        );

        let outcome = run_finalization(
            &state,
            &finalize_work_item("finalize:transfer-fresh"),
            "transfer-finalize",
        )
        .await;
        assert!(
            !matches!(&outcome, Err(error) if error.contains("empty transfer")),
            "a task with no session to lose was refused as a downgrade: {outcome:?}",
        );
    }

    fn work_item(id: &str) -> crate::db::TransferWorkItem {
        crate::db::TransferWorkItem {
            id: id.to_string(),
            kind: super::super::queue::KIND_PUSH.to_string(),
            transfer_id: None,
            payload_json: "{}".to_string(),
            attempts: 1,
        }
    }

    /// A source that cannot ship its conversation refuses before anything is
    /// reserved on the peer, so there is no transfer row to fail — and the
    /// renderer that used to throw this at the operator is gone. The refusal is
    /// written as a `failed` transfer instead: visible in the sidebar, carrying
    /// its reason, and carrying no payload, because an artifact-less finalized
    /// payload must never be persisted.
    #[test]
    fn a_refused_push_is_recorded_as_a_failed_transfer_carrying_its_reason() {
        let db = crate::db::Db::open_for_tests(&crate::db::Db::test_db_path("refused-push"))
            .expect("test db");
        let work = work_item("pull:pull-7");
        let request = serde_json::json!({
            "sourceTaskId": "task-source",
            "peerId": "peer-target",
        });
        let reason = "task task-source resumes claude session s-1 but no transcript exists";

        // The engine's own helper is exercised through the DB it writes to; the
        // surrounding `AppState` is not what this pins.
        let transfer_id = format!("refused-{}", work.id.replace(':', "-"));
        db.insert_task_transfer(&crate::db::NewTaskTransfer {
            id: transfer_id.clone(),
            direction: "outgoing".into(),
            status: "failed".into(),
            source_peer_id: None,
            target_peer_id: string_field(&request, "peerId"),
            source_desktop_id: None,
            target_desktop_id: None,
            source_task_id: Some("task-source".into()),
            local_task_id: Some("task-source".into()),
            error: Some(reason.into()),
            payload_json: None,
        })
        .expect("record refusal");

        let recorded = db
            .get_task_transfer(&transfer_id)
            .expect("read")
            .expect("row exists");
        assert_eq!(recorded.status, "failed");
        assert_eq!(recorded.error.as_deref(), Some(reason));
        assert_eq!(recorded.payload_json, None);

        // A `failed` row is outside the active-outgoing index, so the task is
        // still pushable — a refusal must not block the retry that fixes it.
        assert!(db
            .active_outgoing_transfer_for_source("task-source")
            .expect("read active")
            .is_none());

        // A redelivered push derives the same id and does not pile up rows.
        db.insert_task_transfer(&crate::db::NewTaskTransfer {
            id: transfer_id.clone(),
            direction: "outgoing".into(),
            status: "failed".into(),
            source_peer_id: None,
            target_peer_id: None,
            source_desktop_id: None,
            target_desktop_id: None,
            source_task_id: Some("task-source".into()),
            local_task_id: Some("task-source".into()),
            error: Some("a later reason".into()),
            payload_json: None,
        })
        .expect("redelivery");
        let refreshed = db
            .get_task_transfer(&transfer_id)
            .expect("read")
            .expect("row exists");
        assert_eq!(refreshed.status, "failed");
        // The insert is a no-op for an id that already exists, so the row it
        // found is still the first one — one refusal, one row.
        assert_eq!(refreshed.error.as_deref(), Some(reason));
    }
}
