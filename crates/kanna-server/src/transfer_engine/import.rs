//! The destination side of a transfer: record the request, acquire the
//! repository, materialize the conversation, create the task, acknowledge.
//!
//! Port of `recordIncomingTransfer`, `approveIncomingTransfer`,
//! `ensureIncomingTransferRepo` and `importTransferredResumeState`. The renderer
//! guarded this with two overlapping leases — a Tauri delivery lease and a DB
//! claim lease keyed on renderer-generated owner tokens — because two windows
//! could otherwise import the same transfer. One process cannot race itself:
//! the work queue's item id is the whole exclusion, and the DB claim columns
//! stay only as the record of which import owns the row.

use super::control;
use super::payload::{self, OutgoingTransferPayload, RepoAcquisitionMode};
use super::session;
use crate::db::TransferWorkItem;
use crate::http_api::AppState;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The claim token an engine import writes. The lease columns exist because the
/// DB statements still key on them; the exclusion itself is the work queue.
const ENGINE_CLAIM_TOKEN: &str = "kanna-server-transfer-engine";

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME is unset; the transfer engine cannot import session state".to_string())
}

/// Records an incoming transfer request and schedules its import.
///
/// Recording and importing are separate work items so the row exists — and is
/// visible in the sidebar — even if the import itself has to retry.
pub async fn record_incoming(state: &Arc<AppState>, event: &Value) -> Result<(), String> {
    let transfer_id = string_field(event, "transfer_id")
        .ok_or_else(|| "incoming transfer event is missing a transfer id".to_string())?;
    let source_peer_id = string_field(event, "source_peer_id");
    let source_task_id = string_field(event, "source_task_id");
    let raw_payload = event
        .get("payload")
        .ok_or_else(|| "incoming transfer event is missing a payload".to_string())?;
    let parsed = payload::parse_outgoing_transfer_payload(raw_payload)?;

    let queue = state.transfer_work();
    let db = queue.open_db()?;
    db.insert_task_transfer(&crate::db::NewTaskTransfer {
        id: transfer_id.clone(),
        direction: "incoming".into(),
        status: "pending".into(),
        source_peer_id,
        target_peer_id: None,
        source_desktop_id: parsed.task.source_desktop_id.clone(),
        target_desktop_id: parsed.target_desktop_id.clone(),
        source_task_id,
        local_task_id: None,
        error: None,
        payload_json: Some(
            serde_json::to_string(raw_payload).map_err(|error| format!("db error: {error}"))?,
        ),
    })
    .map_err(|error| format!("db error: {error}"))?;
    control::mark_incoming_event_recorded(state, &transfer_id).await?;
    queue.enqueue(
        &format!("import:{transfer_id}"),
        super::queue::KIND_IMPORT,
        Some(&transfer_id),
        &serde_json::json!({ "transferId": transfer_id }),
    )?;
    Ok(())
}

/// Rejects an incoming transfer on the operator's behalf.
pub async fn reject_transfer(state: &Arc<AppState>, work: &Value) -> Result<(), String> {
    let transfer_id = string_field(work, "transferId")
        .ok_or_else(|| "reject work is missing a transfer id".to_string())?;
    let db = state.transfer_work().open_db()?;
    let transfer = db
        .get_task_transfer(&transfer_id)
        .map_err(|error| format!("db error: {error}"))?
        .ok_or_else(|| format!("incoming transfer not found: {transfer_id}"))?;
    if transfer.direction != "incoming" {
        return Err(format!("transfer is not incoming: {transfer_id}"));
    }
    if !matches!(transfer.status.as_str(), "rejected") {
        db.mark_task_transfer_rejected(&transfer_id, "Rejected locally")
            .map_err(|error| format!("db error: {error}"))?;
    }
    release_incoming_reservation(state, &transfer_id).await
}

/// Releases the sidecar state a transfer that settled earlier still owns.
///
/// Queued by the engine's startup sweep for every terminal incoming row whose
/// cleanup never completed. The renderer used to do this at window mount, and
/// it is the only thing that frees a *committed* reservation: those are exempt
/// from TTL pruning, so each one left behind permanently consumes one of the
/// destination's bounded reservation slots.
pub async fn release_settled_reservation(
    state: &Arc<AppState>,
    work: &Value,
) -> Result<(), String> {
    let transfer_id = string_field(work, "transferId")
        .ok_or_else(|| "sidecar cleanup work is missing a transfer id".to_string())?;
    release_incoming_reservation(state, &transfer_id).await
}

/// Releases the sidecar state a settled incoming transfer still owns.
async fn release_incoming_reservation(
    state: &Arc<AppState>,
    transfer_id: &str,
) -> Result<(), String> {
    control::mark_import_ack_completed(state, transfer_id).await?;
    state
        .transfer_work()
        .open_db()?
        .mark_incoming_transfer_sidecar_cleanup_completed(transfer_id)
        .map_err(|error| format!("db error: {error}"))?;
    Ok(())
}

/// Imports an approved incoming transfer.
///
/// Runs the whole sequence the renderer did — finalize the source, acquire the
/// repository, materialize the conversation, create the task, acknowledge the
/// commit — but every step that must happen once claims a durable phase, so a
/// resumed work item continues rather than repeating.
pub async fn import_transfer(
    state: &Arc<AppState>,
    work: &TransferWorkItem,
    request: &Value,
) -> Result<(), String> {
    let transfer_id = string_field(request, "transferId")
        .ok_or_else(|| "import work is missing a transfer id".to_string())?;
    match run_import(state, work, &transfer_id).await {
        Ok(()) => Ok(()),
        Err(ImportFailure::Retry(reason)) => Err(reason),
        // Retrying cannot conjure session state the payload never carried, so
        // this transfer is terminal now rather than after N attempts — both
        // machines need a visible end state.
        Err(ImportFailure::Terminal(reason)) => {
            let db = state.transfer_work().open_db()?;
            db.fail_incoming_task_transfer(&transfer_id, &reason)
                .map_err(|error| format!("db error: {error}"))?;
            log::error!("refused incoming transfer {transfer_id}: {reason}");
            release_incoming_reservation(state, &transfer_id).await?;
            Ok(())
        }
    }
}

#[derive(Debug)]
enum ImportFailure {
    Retry(String),
    Terminal(String),
}

impl From<String> for ImportFailure {
    fn from(reason: String) -> Self {
        Self::Retry(reason)
    }
}

async fn run_import(
    state: &Arc<AppState>,
    work: &TransferWorkItem,
    transfer_id: &str,
) -> Result<(), ImportFailure> {
    let db = state.transfer_work().open_db()?;
    let transfer = db
        .get_task_transfer(transfer_id)
        .map_err(|error| format!("db error: {error}"))?
        .ok_or_else(|| format!("incoming transfer not found: {transfer_id}"))?;
    if transfer.direction != "incoming" {
        return Err(format!("transfer is not incoming: {transfer_id}").into());
    }
    if matches!(
        transfer.status.as_str(),
        "completed" | "rejected" | "failed"
    ) {
        return Ok(());
    }
    db.claim_pending_incoming_transfer(transfer_id, ENGINE_CLAIM_TOKEN, true)
        .map_err(|error| format!("db error: {error}"))?;

    let mut local_task_id = transfer.local_task_id.clone();
    let stored = payload::parse_outgoing_transfer_payload(
        &serde_json::from_str::<Value>(transfer.payload_json.as_deref().unwrap_or("null"))
            .map_err(|error| format!("persisted transfer payload is invalid: {error}"))?,
    )
    .map_err(ImportFailure::Terminal)?;

    let payload = if local_task_id.is_some() {
        stored
    } else {
        let finalized = control::finalize_from_source(state, transfer_id).await?;
        let payload = payload::parse_outgoing_transfer_payload(&finalized.payload)
            .map_err(ImportFailure::Terminal)?;
        assert_payload_matches_reservation(&transfer, &payload)?;
        if !finalized.finalized_cleanly {
            // The source could not shut its agent down cleanly. The
            // conversation still crosses, but this machine's operator has to
            // know the handoff was degraded — it is their task now.
            log::warn!(
                "incoming transfer {transfer_id} was not cleanly finalized: {}",
                payload
                    .finalization
                    .degraded_reason
                    .as_deref()
                    .unwrap_or("the source reported no reason"),
            );
        }
        let payload_json = serde_json::to_string(&finalized.payload)
            .map_err(|error| format!("db error: {error}"))?;
        if !db
            .update_task_transfer_payload(transfer_id, &payload_json, Some(ENGINE_CLAIM_TOKEN))
            .map_err(|error| format!("db error: {error}"))?
        {
            return Err(format!(
                "failed to persist finalized incoming transfer payload: {transfer_id}"
            )
            .into());
        }
        payload
    };

    if local_task_id.is_none() {
        // A payload that promises a resumable session and ships no way to
        // resume it must not be imported: minting a fresh session here is what
        // silently left the conversation behind on the source machine.
        session::assert_importable(
            transfer_id,
            payload.task.agent_type.as_deref(),
            Some(payload.task.agent_provider.as_str()),
            payload.task.resume_session_id.as_deref(),
            &payload.artifacts,
        )
        .map_err(|missing| ImportFailure::Terminal(missing.0))?;

        let (repo_id, repo_path) = acquire_repo(state, transfer_id, &payload).await?;
        // The destination task id — and therefore its worktree — is
        // deterministic before creation, which is what lets the transcript be
        // re-keyed to the destination slug before the agent spawns `--resume`.
        let destination_task_id = session::destination_task_id(transfer_id);
        let destination_worktree =
            session::destination_worktree_path(&repo_path, &destination_task_id);
        let resume_session_id =
            materialize_resume_state(state, work, transfer_id, &payload, &destination_worktree)
                .await?;

        let created = crate::http_api::create_task_in_process(
            Arc::clone(state),
            build_create_request(state, &repo_id, &payload, resume_session_id.clone()).await,
            destination_task_id.clone(),
        )
        .await
        .map_err(|(status, message)| {
            format!("failed to create the transferred task ({status}): {message}")
        })?;
        local_task_id = Some(created.task_id);

        if !db
            .mark_incoming_transfer_importing(
                transfer_id,
                local_task_id.as_deref().unwrap_or_default(),
                ENGINE_CLAIM_TOKEN,
            )
            .map_err(|error| format!("db error: {error}"))?
        {
            return Err(
                format!("failed to claim imported task for transfer: {transfer_id}").into(),
            );
        }
    }

    let local_task_id = local_task_id
        .ok_or_else(|| format!("incoming transfer has no local task: {transfer_id}"))?;

    db.set_cloud_task_identity(&local_task_id, &payload.task.cloud_task_id)
        .map_err(|error| format!("db error: {error}"))?;
    db.insert_task_transfer_provenance(&crate::db::NewTaskTransferProvenance {
        pipeline_item_id: local_task_id.clone(),
        source_peer_id: payload.task.source_peer_id.clone(),
        source_task_id: payload.task.source_task_id.clone(),
        source_machine_task_label: payload.task.branch.clone(),
    })
    .map_err(|error| format!("db error: {error}"))?;
    if !db
        .mark_incoming_transfer_awaiting_acknowledgment(
            transfer_id,
            &local_task_id,
            ENGINE_CLAIM_TOKEN,
        )
        .map_err(|error| format!("db error: {error}"))?
    {
        return Err(format!(
            "failed to mark incoming transfer awaiting acknowledgment: {transfer_id}"
        )
        .into());
    }
    state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);

    // Acknowledging is what closes the source task, so it happens at most once
    // for this work item even across a restart that resumes it.
    //
    // A *failed* acknowledgment gives the claim back. Keeping it would make the
    // retry skip the ack and fall straight through to marking this transfer
    // completed — the destination would report success while the source was
    // never told, leaving its task open and the same task live on two machines.
    if db
        .claim_transfer_work_phase(&work.id, "acknowledge-import")
        .map_err(|error| format!("db error: {error}"))?
    {
        if let Err(error) = control::acknowledge_import_committed(
            state,
            transfer_id,
            &payload.task.source_task_id,
            &local_task_id,
        )
        .await
        {
            db.release_transfer_work_phase(&work.id, "acknowledge-import")
                .map_err(|release| {
                    format!("db error releasing the acknowledge-import claim: {release}")
                })?;
            return Err(error.into());
        }
    }
    if !db
        .mark_task_transfer_completed(transfer_id, &local_task_id, Some(ENGINE_CLAIM_TOKEN))
        .map_err(|error| format!("db error: {error}"))?
    {
        return Err(
            format!("failed to complete acknowledged incoming transfer: {transfer_id}").into(),
        );
    }
    release_incoming_reservation(state, transfer_id).await?;
    Ok(())
}

fn assert_payload_matches_reservation(
    transfer: &crate::db::TaskTransfer,
    payload: &OutgoingTransferPayload,
) -> Result<(), ImportFailure> {
    let matches = transfer.source_peer_id.as_deref() == Some(payload.task.source_peer_id.as_str())
        && transfer.source_task_id.as_deref() == Some(payload.task.source_task_id.as_str());
    if matches {
        return Ok(());
    }
    // A payload whose identity does not match the reservation it arrived under
    // is not a transient failure — it is a different transfer.
    Err(ImportFailure::Terminal(format!(
        "incoming transfer payload source identity does not match reservation: {}",
        transfer.id
    )))
}

// ---------------------------------------------------------------------------
// Repository acquisition
// ---------------------------------------------------------------------------

async fn acquire_repo(
    state: &Arc<AppState>,
    transfer_id: &str,
    payload: &OutgoingTransferPayload,
) -> Result<(String, PathBuf), ImportFailure> {
    let repo_name = payload.repo.name.clone().unwrap_or_else(|| "repo".into());
    let default_branch = payload
        .repo
        .default_branch
        .clone()
        .unwrap_or_else(|| "main".into());

    // Runs `git remote get-url` once per registered repo, so it is blocking
    // work proportional to how many repos this machine has.
    let matched = {
        let queue = state.transfer_work();
        let remote_url = payload.repo.remote_url.clone();
        let payload_path = payload.repo.path.clone();
        super::run_blocking("transfer repo match", move || {
            find_matching_repo(
                &queue.open_db()?,
                remote_url.as_deref(),
                payload_path.as_deref(),
            )
        })
        .await?
    };
    if let Some((repo_id, repo_path)) = matched {
        return Ok((repo_id, PathBuf::from(repo_path)));
    }

    let repo_path = match payload.repo.mode {
        RepoAcquisitionMode::ReuseLocal => {
            let repo_path = payload
                .repo
                .path
                .clone()
                .ok_or_else(|| "incoming transfer payload is missing a local repo path".to_string())
                .map_err(ImportFailure::Terminal)?;
            if !Path::new(&repo_path).exists() {
                return Err(ImportFailure::Terminal(format!(
                    "incoming transfer repo path does not exist: {repo_path}"
                )));
            }
            PathBuf::from(repo_path)
        }
        RepoAcquisitionMode::CloneRemote => {
            let remote_url = payload
                .repo
                .remote_url
                .clone()
                .ok_or_else(|| "incoming transfer payload is missing a remote URL".to_string())
                .map_err(ImportFailure::Terminal)?;
            let repo_name = repo_name.clone();
            super::run_blocking("transfer repo clone", move || {
                let repo_path = super::git::allocate_repo_path(&repos_home()?, &repo_name)?;
                super::git::clone_remote(&remote_url, &repo_path)?;
                Ok(repo_path)
            })
            .await?
        }
        RepoAcquisitionMode::BundleRepo => {
            let bundle = payload
                .repo
                .bundle
                .as_ref()
                .ok_or_else(|| "incoming transfer payload is missing bundle metadata".to_string())
                .map_err(ImportFailure::Terminal)?;
            let fetched = control::fetch_artifact(state, transfer_id, &bundle.artifact_id).await?;
            let checkout_ref = bundle
                .ref_name
                .clone()
                .or_else(|| payload.task.branch.clone())
                .or_else(|| payload.task.base_ref.clone());
            let repo_name = repo_name.clone();
            super::run_blocking("transfer repo restore", move || {
                let repo_path = super::git::allocate_repo_path(&repos_home()?, &repo_name)?;
                super::git::init_from_bundle(&repo_path, &fetched, checkout_ref.as_deref())?;
                Ok(repo_path)
            })
            .await?
        }
    };

    // `add_repo` canonicalizes the path and reads the repo's default branch
    // with git before it writes the row.
    let repo_id = {
        let (state, path, name, branch) = (
            Arc::clone(state),
            repo_path.clone(),
            repo_name.clone(),
            default_branch.clone(),
        );
        super::run_blocking("transfer repo register", move || {
            register_repo(&state, &path, &name, &branch)
        })
        .await?
    };
    Ok((repo_id, repo_path))
}

/// Matches the payload's repository against one this machine already has —
/// first by remote URL, then by the source's own path in case both machines
/// check the repo out to the same place.
fn find_matching_repo(
    db: &crate::db::Db,
    remote_url: Option<&str>,
    payload_path: Option<&str>,
) -> Result<Option<(String, String)>, String> {
    let normalized_remote = remote_url.map(str::trim).filter(|url| !url.is_empty());
    let repos = db
        .list_repos_for_maintenance()
        .map_err(|error| format!("db error: {error}"))?;
    if let Some(remote) = normalized_remote {
        for repo in &repos {
            if super::git::remote_url(Path::new(&repo.path)).as_deref() == Some(remote) {
                return Ok(Some((repo.id.clone(), repo.path.clone())));
            }
        }
    }
    if let Some(path) = payload_path {
        if let Some(repo) = repos.iter().find(|repo| repo.path == path) {
            return Ok(Some((repo.id.clone(), repo.path.clone())));
        }
    }
    Ok(None)
}

fn register_repo(
    state: &Arc<AppState>,
    repo_path: &Path,
    repo_name: &str,
    default_branch: &str,
) -> Result<String, String> {
    let db = state.transfer_work().open_db()?;
    let path = repo_path.to_string_lossy().to_string();
    let api = crate::mobile_api::MobileApi::new(state.config().clone(), db);
    match api.add_repo(crate::mobile_api::AddRepoRequest {
        path: path.clone(),
        name: Some(repo_name.to_string()),
        default_branch: Some(default_branch.to_string()),
    }) {
        Ok(repo) => Ok(repo.id),
        Err(crate::mobile_api::AddRepoError::DuplicatePath) => {
            let db = state.transfer_work().open_db()?;
            db.get_snapshot_repo_by_path(&path)
                .map_err(|error| format!("db error: {error}"))?
                .map(|repo| repo.id)
                .ok_or_else(|| format!("repo {path} is registered but could not be read back"))
        }
        Err(error) => Err(error.message()),
    }
}

fn repos_home() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".kanna").join("repos"))
}

// ---------------------------------------------------------------------------
// Resume state
// ---------------------------------------------------------------------------

/// Materializes the session artifacts the payload carries, returning the
/// session id the destination agent will resume — or `None` when the resume
/// must be abandoned because the conversation state could not be established.
/// The phase under which an import records what it materialized.
///
/// Materialization is not re-observable: once a transcript is on disk or an
/// OpenCode session is installed, attempt 2 sees an occupied destination and
/// would read it as "someone else was here" — abandoning the conversation this
/// transfer already imported, and acking the source anyway. Recording the
/// answer once is what makes a retry recognise its own success.
const MATERIALIZE_PHASE: &str = "materialize-resume-state";

/// A recorded materialization that resolved to "no resume".
///
/// The observation column stores `Option<String>`, and `None` there already
/// means "never observed" — so the abandoned-resume decision needs a value of
/// its own rather than an absent one.
const RESUME_ABANDONED: &str = "";

async fn materialize_resume_state(
    state: &Arc<AppState>,
    work: &TransferWorkItem,
    transfer_id: &str,
    payload: &OutgoingTransferPayload,
    destination_worktree: &Path,
) -> Result<Option<String>, ImportFailure> {
    // What an earlier attempt already decided. Reusing it is the whole point:
    // the destinations it wrote are exactly what a fresh look would now
    // misread.
    if let Some(recorded) = state
        .transfer_work()
        .open_db()?
        .read_transfer_work_observation(&work.id, MATERIALIZE_PHASE)
        .map_err(|error| format!("db error: {error}"))?
    {
        return Ok(recorded.filter(|session_id| session_id != RESUME_ABANDONED));
    }

    let Some(resume_session_id) = payload.task.resume_session_id.clone() else {
        return Ok(None);
    };
    let provider = payload.task.agent_provider.as_str();
    let artifacts: Vec<_> = payload
        .artifacts
        .iter()
        .filter(|artifact| artifact.provider == provider)
        .collect();
    if artifacts.is_empty() {
        return Ok(None);
    }

    let home = home_dir()?;
    let mut materialized = Vec::with_capacity(artifacts.len());
    for artifact in &artifacts {
        let source_path =
            control::fetch_artifact(state, transfer_id, &artifact.artifact_id).await?;
        // OpenCode keeps its conversations in a shared SQLite store that only
        // its own CLI may write, so this artifact never reaches the filesystem
        // fence. The import runs in the destination worktree because that is
        // what re-keys the session to this machine's path — without it
        // `opencode run --session <id>` is a silent no-op.
        if artifact.materialization == payload::TransferArtifactMaterialization::OpencodeImport {
            let (session_id, worktree) = (
                resume_session_id.clone(),
                destination_worktree.to_path_buf(),
            );
            // Read now rather than earlier: the guard is about what this
            // operator is using at the moment of the import, and an import that
            // retries minutes later must see the tasks that are open then.
            let live_worktrees = super::git::LiveLocalWorktrees::new(
                state
                    .transfer_work()
                    .open_db()?
                    .list_open_task_worktree_paths()
                    .map_err(|error| format!("db error: {error}"))?
                    .into_iter()
                    .map(|(_, path)| PathBuf::from(path)),
            );
            let imported = super::run_blocking("transfer opencode import", move || {
                Ok(super::git::import_opencode_session(
                    &source_path,
                    &session_id,
                    &worktree,
                    &live_worktrees,
                ))
            })
            .await?;
            match imported {
                Ok(()) => materialized.push((artifact.artifact_id.clone(), true)),
                // The receiver already owns this id. Reported like every other
                // occupied destination — `wrote = false`, which abandons the
                // resume rather than overwriting a conversation of the
                // operator's own.
                Err(super::git::OpencodeImportError::DestinationExists(session_id)) => {
                    log::warn!(
                        "skipping the transferred OpenCode session: {session_id} already exists here"
                    );
                    materialized.push((artifact.artifact_id.clone(), false));
                }
                // A payload this machine will refuse every time it looks.
                Err(refused @ super::git::OpencodeImportError::Refused(_)) => {
                    return Err(ImportFailure::Terminal(refused.to_string()));
                }
                // The CLI, not the payload — OpenCode's store is one shared
                // SQLite file that many agents write, and `import` exits
                // non-zero while another holds the write lock. Retrying is what
                // keeps a lock that clears in seconds from permanently losing a
                // conversation the source has already been shut down to hand over.
                Err(unavailable @ super::git::OpencodeImportError::Unavailable(_)) => {
                    return Err(ImportFailure::Retry(unavailable.to_string()));
                }
            }
            continue;
        }
        // Extracting a gzipped session archive is unbounded blocking work, and
        // it runs against the operator's home directory — the one place the
        // engine must never stall the runtime that is also serving terminals.
        let wrote = {
            let (home, provider, resume_session_id, filename, kind, materialization, worktree) = (
                home.clone(),
                provider.to_string(),
                resume_session_id.clone(),
                artifact.filename.clone(),
                artifact.kind.as_str().to_string(),
                artifact.materialization.as_str().to_string(),
                (artifact.kind == payload::TransferArtifactKind::SessionTranscript)
                    .then(|| destination_worktree.to_path_buf()),
            );
            super::run_blocking("transfer artifact materialization", move || {
                crate::transfer_artifact::materialize_transfer_artifact_at_home(
                    &home,
                    &source_path,
                    crate::transfer_artifact::TransferArtifactContract {
                        provider: &provider,
                        resume_session_id: &resume_session_id,
                        filename: &filename,
                        kind: &kind,
                        materialization: &materialization,
                        // A Claude transcript is cwd-keyed, so only the receiver
                        // can name where it lands. The sender never supplies a
                        // destination.
                        destination_worktree_path: worktree.as_deref(),
                    },
                )
            })
            .await
            // A contract violation, or a worker that panicked doing this — a
            // payload this machine cannot safely materialize is not something a
            // retry fixes.
            .map_err(ImportFailure::Terminal)?
        };
        materialized.push((artifact.artifact_id.clone(), wrote));
    }

    let owned: Vec<_> = artifacts.into_iter().cloned().collect();
    let resolved = if session::resume_survives_existing_destination(&owned, &materialized) {
        Some(resume_session_id)
    } else {
        log::warn!(
            "skipping transferred session import for {provider} session {resume_session_id}: \
             the provider destination already exists"
        );
        None
    };

    // Recorded before the task is created, so the answer a retry reads is the
    // one this attempt acted on. A crash between the two leaves the record and
    // the materialized state agreeing, which is what the retry needs.
    let recorded = state
        .transfer_work()
        .open_db()?
        .record_transfer_work_observation(
            &work.id,
            MATERIALIZE_PHASE,
            Some(resolved.as_deref().unwrap_or(RESUME_ABANDONED)),
        )
        .map_err(|error| format!("db error: {error}"))?;
    Ok(recorded.filter(|session_id| session_id != RESUME_ABANDONED))
}

async fn build_create_request(
    state: &Arc<AppState>,
    repo_id: &str,
    payload: &OutgoingTransferPayload,
    resume_session_id: Option<String>,
) -> crate::mobile_api::CreateTaskRequest {
    crate::mobile_api::CreateTaskRequest {
        repo_id: repo_id.to_string(),
        prompt: payload.task.prompt.clone().unwrap_or_default(),
        display_name: payload.task.display_name.clone(),
        workflow_name: Some(payload.task.workflow.clone()),
        stage: Some(payload.task.stage.clone()),
        base_ref: payload::resolve_incoming_base_branch(payload),
        // An imported task keeps the base it was transferred with; nothing in
        // the transfer payload distinguishes a fork point from a diff base.
        diff_base_ref: None,
        agent: None,
        agent_provider: Some(payload.task.agent_provider.clone()),
        agent_type: Some(
            match payload.task.agent_type.as_deref() {
                Some("agent") | Some("sdk") => "agent",
                _ => "pty",
            }
            .to_string(),
        ),
        terminal_cols: None,
        terminal_rows: None,
        model: None,
        effort: None,
        permission_mode: None,
        allowed_tools: None,
        disallowed_tools: None,
        max_turns: None,
        max_budget_usd: None,
        setup_cmds: None,
        task_template: None,
        transfer_import: Some(crate::mobile_api::TransferImportSummary {
            source_machine: resolve_source_machine_name(state, &payload.task.source_peer_id).await,
            repo_mode: Some(payload.repo.mode.as_str().to_string()),
            session_restored: resume_session_id.is_some(),
        }),
        resume_session_id,
        recovery_snapshot: payload.recovery.clone(),
        blocker_task_ids: None,
        notify_task_id: None,
        parent_task_id: None,
    }
}

/// Peer display names live in the sidecar's registry, not in the payload.
/// Resolving one is best effort: an unreachable sidecar or an unknown peer
/// falls back to the peer id, which still identifies the machine.
async fn resolve_source_machine_name(state: &Arc<AppState>, peer_id: &str) -> Option<String> {
    let peers = state
        .transfer_sidecar()
        .control("list-peers", serde_json::json!({}))
        .await
        .ok()?;
    let name = peers.as_array()?.iter().find_map(|peer| {
        let matches = peer.get("peer_id").and_then(Value::as_str) == Some(peer_id);
        matches
            .then(|| peer.get("display_name").and_then(Value::as_str))
            .flatten()
            .map(str::to_string)
    });
    Some(name.unwrap_or_else(|| peer_id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work_item(id: &str) -> TransferWorkItem {
        TransferWorkItem {
            id: id.to_string(),
            kind: super::super::queue::KIND_IMPORT.to_string(),
            transfer_id: Some("transfer-1".to_string()),
            payload_json: "{}".to_string(),
            attempts: 2,
        }
    }

    /// A payload whose recompute path would answer `None`, so the only way a
    /// recorded answer can come back is if the memo is actually consulted.
    fn payload_promising(session_id: Option<&str>) -> OutgoingTransferPayload {
        payload::parse_outgoing_transfer_payload(&serde_json::json!({
            "target_peer_id": "peer-destination",
            "task": {
                "source_peer_id": "peer-source",
                "source_task_id": "task-source",
                "resume_session_id": session_id,
                "stage": "in progress",
                "pipeline": "single-reviewer",
                "agent_type": "pty",
                "agent_provider": "claude",
            },
            // No artifacts, so a second look at this payload resolves to "no
            // resume" — which is exactly what must *not* be returned once an
            // earlier attempt has already materialized one.
            "repo": { "mode": "reuse-local", "path": "/repo" },
            "artifacts": [],
        }))
        .expect("a valid payload")
    }

    /// The retry seam migration 050 exists for.
    ///
    /// Attempt 1 fetches the artifacts and writes them to disk; by attempt 2
    /// those destinations are occupied *by attempt 1*, so a fresh look reads
    /// its own output as somebody else's and abandons the resume. The recorded
    /// answer is the only one taken against the machine as it was, so attempt 2
    /// has to return it rather than recompute.
    ///
    /// The DB primitive and the pure predicate are pinned elsewhere; what this
    /// covers is that `materialize_resume_state` is wired to them.
    #[tokio::test]
    async fn a_retried_import_returns_the_session_the_first_attempt_materialized() {
        let work = work_item("import:transfer-1");
        let recorded = "364643cc-5e6d-48fc-86ca-ca7764380900";
        let state =
            crate::http_api::test_state_with_seed("desktop-import-memo", "Import Memo", |db| {
                db.enqueue_transfer_work(&work_item("import:transfer-1").id, "import", None, "{}")
                    .expect("queue the work item");
                db.record_transfer_work_observation(
                    "import:transfer-1",
                    MATERIALIZE_PHASE,
                    Some(recorded),
                )
                .expect("attempt 1's answer");
            });

        // The payload names a *different* session and would recompute to
        // `None`, so neither value can be reached by accident.
        let resolved = materialize_resume_state(
            &state,
            &work,
            "transfer-1",
            &payload_promising(Some("11111111-2222-3333-4444-555555555555")),
            Path::new("/tmp/kanna-import-memo-destination"),
        )
        .await
        .expect("the retry failed instead of reusing attempt 1's answer");
        assert_eq!(resolved.as_deref(), Some(recorded));

        // Reading is not writing: the recorded answer is still attempt 1's, so
        // a third attempt sees the same thing.
        assert_eq!(
            state
                .transfer_work()
                .open_db()
                .expect("db")
                .read_transfer_work_observation("import:transfer-1", MATERIALIZE_PHASE)
                .expect("read"),
            Some(Some(recorded.to_string())),
        );
    }

    /// The other half of the recorded value: its encoding.
    ///
    /// `None` in the observation column already means "never observed", so an
    /// attempt that decided the resume had to be abandoned records the empty
    /// marker instead. Reading that back as a session id would spawn the
    /// destination agent with `--resume ""`. Unlike the test above this one does
    /// not distinguish the memo from a recompute — both answer `None` for this
    /// payload — it pins the decoding the memo needs to be usable at all.
    #[tokio::test]
    async fn the_abandoned_marker_reads_back_as_no_resume_rather_than_a_session_id() {
        let work = work_item("import:transfer-abandoned");
        let state = crate::http_api::test_state_with_seed(
            "desktop-import-abandoned",
            "Import Abandoned",
            |db| {
                db.enqueue_transfer_work("import:transfer-abandoned", "import", None, "{}")
                    .expect("queue the work item");
                db.record_transfer_work_observation(
                    "import:transfer-abandoned",
                    MATERIALIZE_PHASE,
                    Some(RESUME_ABANDONED),
                )
                .expect("attempt 1's answer");
            },
        );

        let resolved = materialize_resume_state(
            &state,
            &work,
            "transfer-abandoned",
            &payload_promising(Some("364643cc-5e6d-48fc-86ca-ca7764380900")),
            Path::new("/tmp/kanna-import-abandoned-destination"),
        )
        .await
        .expect("the retry failed instead of reusing attempt 1's answer");
        assert_eq!(
            resolved, None,
            "the abandoned marker leaked out as a session id",
        );
    }
}
