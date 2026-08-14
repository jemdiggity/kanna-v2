use super::lan_trust::PrivilegedTaskAccess;
use super::state::{db_write_error, AppState};
use super::task_input::submit_task_input;
use crate::config::Config;
use crate::db::{Db, MergeSignalSource};
use crate::task_creator::{PrepareTaskError, SingletonAgentOverrides};
use crate::task_input_queue::TaskInputSource;
use axum::extract::State;
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use std::sync::Arc;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SignalAgentRequest {
    message: String,
    /// Provider the singleton agent should run as when this signal creates it,
    /// overriding the agent definition's own candidates and the configured
    /// default.
    #[serde(default)]
    agent_provider: Option<String>,
    /// Provider-native reasoning effort for the created singleton agent.
    #[serde(default)]
    effort: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SignalAgentResponse {
    pub(super) task_id: String,
    pub(super) created: bool,
}

pub(super) async fn signal_agent(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    axum::extract::Path((repo_id, agent)): axum::extract::Path<(String, String)>,
    Json(payload): Json<SignalAgentRequest>,
) -> Result<Json<SignalAgentResponse>, (axum::http::StatusCode, String)> {
    signal_agent_request(
        state,
        repo_id,
        agent,
        payload.message,
        SingletonAgentOverrides {
            agent_provider: payload.agent_provider,
            effort: payload.effort,
        },
    )
    .await
    .map(Json)
}

/// Deliver an ordinary request to the repository's merge agent. Kanna does
/// not interpret approval history, bind candidate branches, or attest policy;
/// the merge agent applies the repository's checked-in policy.
pub(super) async fn signal_merge_handoff(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::MergeHandoffRequest>,
) -> Result<Json<SignalAgentResponse>, (axum::http::StatusCode, String)> {
    signal_merge_handoff_impl(state, task_id, payload)
        .await
        .map(Json)
}

async fn signal_merge_handoff_impl(
    state: Arc<AppState>,
    task_id: String,
    payload: crate::mobile_api::MergeHandoffRequest,
) -> Result<SignalAgentResponse, (axum::http::StatusCode, String)> {
    let task_id = super::task_actions::resolve_task_id_for_mutation(&state, &task_id).await?;
    deliver_merge_handoff(state, task_id, payload, MergeSignalSource::Agent).await
}

/// Deliver a task's merge request to the repo's merge agent and record that
/// the task no longer owes one. Shared by the approve post's own
/// `signal-merge-handoff` call and by the engine backstop that runs before a
/// task closes, so both deliver the identical wire line and both mark the
/// task as having handed off.
async fn deliver_merge_handoff(
    state: Arc<AppState>,
    task_id: String,
    payload: crate::mobile_api::MergeHandoffRequest,
    source: MergeSignalSource,
) -> Result<SignalAgentResponse, (axum::http::StatusCode, String)> {
    for (name, value) in [
        ("branch", payload.branch.trim()),
        ("target", payload.target.trim()),
        ("summary", payload.summary.trim()),
    ] {
        if value.is_empty() {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                format!("merge handoff {name} must be non-empty"),
            ));
        }
    }

    let branch = payload.branch.trim().to_string();
    let target = payload.target.trim().to_string();
    let pr_url = payload
        .pr_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let repo_id = {
        let state = Arc::clone(&state);
        let task_id = task_id.clone();
        super::blocking::run_handler_blocking("merge signal source read", move || {
            let db = Db::open(&state.config.db_path)
                .map_err(|error| db_write_error("db error", error))?;
            db.get_pipeline_item(&task_id)
                .map_err(|error| db_write_error("db error", error))?
                .ok_or_else(|| {
                    (
                        axum::http::StatusCode::NOT_FOUND,
                        format!("task not found: {task_id}"),
                    )
                })
                .map(|task| task.repo_id)
        })
        .await?
    };
    let message = format!(
        "MERGE {} -> {} [TASK {}]{}: {}",
        branch,
        target,
        task_id,
        pr_url
            .as_deref()
            .map(|url| format!(" [PR {url}]"))
            .unwrap_or_default(),
        payload.summary.trim(),
    );
    let response = signal_agent_request(
        state.clone(),
        repo_id,
        "merge".to_string(),
        message,
        SingletonAgentOverrides::default(),
    )
    .await?;
    // Recorded only after delivery: a task that still owes the merge agent a
    // request must look like it does, so the close-time backstop can send it.
    let recorded = {
        let state = Arc::clone(&state);
        let task_id = task_id.clone();
        let branch = branch.clone();
        let target = target.clone();
        let pr_url = pr_url.clone();
        super::blocking::run_handler_blocking("merge signal record", move || {
            let db = Db::open(&state.config.db_path)
                .map_err(|error| db_write_error("db error", error))?;
            db.record_task_merge_signal(&task_id, source, &branch, &target, pr_url.as_deref())
                .map_err(|error| db_write_error("db error", error))
        })
        .await?
    };
    if recorded {
        state.publish_state_changed(StateChangeScope::Tasks);
    }
    Ok(response)
}

/// Hand the task's PR to the repo's merge master before the workflow closes
/// it, when the approve post finished without doing so itself.
///
/// The post is injected into whatever agent session the pr stage left running,
/// so the handoff cannot rest on that agent having read and followed the post
/// prompt: a pr agent that was still mid-work when the post arrived reads it
/// as its next instruction, creates the PR, reports that, and never signals.
/// The workflow promised the handoff by declaring the post, so the engine —
/// which holds the recorded `pr_url` either way — owes it.
///
/// This delivers the same ordinary policy request the post would have. It
/// attests nothing about the merge; the merge agent resolves the live PR and
/// applies the repository's own policy.
pub(super) async fn ensure_merge_handoff_before_close(
    state: &Arc<AppState>,
    task_id: &str,
) -> Result<(), (axum::http::StatusCode, String)> {
    let Some(pending) = resolve_pending_merge_handoff(state, task_id).await? else {
        return Ok(());
    };
    let Some(pr_url) = pending.pr_url else {
        // Nothing to hand off, on a workflow whose final stage promised a
        // handoff: the approve post reported success without ever producing
        // the PR it exists to approve. Refuse the close so the task parks for
        // its human instead of disappearing as a completed workflow.
        let reason = format!(
            "task {task_id} finished stage '{}' whose post signals the merge master, but no PR \
             URL was ever recorded — nothing was handed off",
            pending.stage
        );
        log::error!("{reason}");
        let record_state = Arc::clone(state);
        let record_task_id = task_id.to_string();
        let record_reason = reason.clone();
        super::blocking::run_handler_blocking("merge handoff gap record", move || {
            let db = Db::open(&record_state.config.db_path)
                .map_err(|error| db_write_error("db error", error))?;
            db.record_task_merge_handoff_missing(&record_task_id, &record_reason)
                .map_err(|error| db_write_error("db error", error))?;
            db.update_pipeline_item_activity(&record_task_id, "unread")
                .map_err(|error| db_write_error("db error", error))
        })
        .await?;
        state.publish_state_changed(StateChangeScope::Tasks);
        return Err((axum::http::StatusCode::CONFLICT, reason));
    };
    log::warn!(
        "approve post for {task_id} closed without signaling the merge master; \
         delivering the handoff for PR {pr_url}"
    );
    deliver_merge_handoff(
        Arc::clone(state),
        task_id.to_string(),
        crate::mobile_api::MergeHandoffRequest {
            branch: pending.branch,
            target: pending.target,
            pr_url: Some(pr_url),
            summary: pending.summary,
        },
        MergeSignalSource::Engine,
    )
    .await
    .map(|_| ())
}

/// What the engine would send on the task's behalf, or `None` when the task
/// owes nothing — its workflow never promised a handoff, or the approve post
/// already delivered one.
struct PendingMergeHandoff {
    stage: String,
    branch: String,
    target: String,
    pr_url: Option<String>,
    summary: String,
}

async fn resolve_pending_merge_handoff(
    state: &Arc<AppState>,
    task_id: &str,
) -> Result<Option<PendingMergeHandoff>, (axum::http::StatusCode, String)> {
    let state = Arc::clone(state);
    let task_id = task_id.to_string();
    super::blocking::run_handler_blocking("merge handoff close check", move || {
        let db =
            Db::open(&state.config.db_path).map_err(|error| db_write_error("db error", error))?;
        let Some(task) = db
            .get_pipeline_item(&task_id)
            .map_err(|error| db_write_error("db error", error))?
        else {
            return Ok(None);
        };
        let Some(stage) = task.stage.clone() else {
            return Ok(None);
        };
        if db
            .task_merge_signaled_at(&task_id)
            .map_err(|error| db_write_error("db error", error))?
            .is_some()
        {
            return Ok(None);
        }
        let Some(repo) = db
            .get_repo(&task.repo_id)
            .map_err(|error| db_write_error("db error", error))?
        else {
            return Ok(None);
        };
        let workflow_name = task
            .pipeline
            .clone()
            .unwrap_or_else(|| crate::task_creator::FALLBACK_WORKFLOW_NAME.to_string());
        let declares_post = crate::task_creator::stage_declares_merge_approve_post(
            &repo,
            &workflow_name,
            task.pipeline_def.as_deref(),
            &stage,
        )
        .map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to resolve workflow for {task_id}: {error}"),
            )
        })?;
        if !declares_post {
            return Ok(None);
        }
        // The pr agent renames the branch it pushes, so the stored workspace
        // name is usually not the PR's head. Resolve the worktree's live
        // branch the same way blocker-resolution instructions do; the merge
        // agent treats the PR URL as authoritative anyway.
        let branch = task
            .branch
            .as_deref()
            .and_then(|branch| {
                crate::task_creator::resolve_current_source_worktree_branch(
                    &repo.path,
                    Some(branch),
                )
            })
            .or_else(|| task.branch.clone())
            .unwrap_or_else(|| task_id.clone());
        // The repo's default branch, not the task's `base_ref`: `base_ref`
        // records where the task forked from and can be a commit sha or a
        // branch that no longer exists. The merge agent resolves the PR's own
        // base first, so this is a hint it can override, and a hint that names
        // a real branch is the only kind worth sending.
        let target = repo
            .default_branch
            .clone()
            .or_else(|| task.base_ref.clone())
            .filter(|target| !target.trim().is_empty())
            .unwrap_or_else(|| "main".to_string());
        let summary = task
            .display_name
            .clone()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| format!("task {task_id}"));
        Ok(Some(PendingMergeHandoff {
            stage,
            branch,
            target,
            pr_url: task.pr_url.clone().filter(|url| !url.trim().is_empty()),
            summary,
        }))
    })
    .await
}

pub(super) async fn signal_agent_request(
    state: Arc<AppState>,
    repo_id: String,
    agent: String,
    message: String,
    overrides: SingletonAgentOverrides,
) -> Result<SignalAgentResponse, (axum::http::StatusCode, String)> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "message must be a non-empty string".to_string(),
        ));
    }

    let running = {
        let state = Arc::clone(&state);
        let repo_id = repo_id.clone();
        let agent = agent.clone();
        super::blocking::run_handler_blocking("singleton agent lookup", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| db_write_error("db error", e))?;
            db.find_open_agent_task(&repo_id, &agent)
                .map_err(|e| db_write_error("db error", e))
        })
        .await?
    };

    if let Some(running) = running {
        submit_task_input(
            &state,
            &running.task_id,
            &running.session_id,
            TaskInputSource::Api,
            &message,
        )
        .await?;
        return Ok(SignalAgentResponse {
            task_id: running.task_id,
            created: false,
        });
    }

    let prepared = {
        let state = Arc::clone(&state);
        let repo_id = repo_id.clone();
        let agent = agent.clone();
        super::blocking::run_handler_blocking("singleton agent preparation", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| db_write_error("db error", e))?;
            let prepared = crate::task_creator::prepare_singleton_agent_task_for_api(
                &db,
                &state.config,
                &repo_id,
                &agent,
                &message,
                overrides,
            )
            .map_err(prepare_singleton_error)?;
            db.pin_pipeline_item_at_top(&repo_id, prepared.task_id())
                .map_err(|e| db_write_error("db error", e))?;
            Ok(prepared)
        })
        .await?
    };
    let task_id = prepared.task_id().to_string();
    state.publish_state_changed(StateChangeScope::Tasks);
    spawn_signal_agent_task_detached(Arc::clone(&state), prepared);

    Ok(SignalAgentResponse {
        task_id,
        created: true,
    })
}

/// A rejected provider or effort override is the caller's mistake, so it must
/// read as a bad request rather than a server failure.
fn prepare_singleton_error(error: PrepareTaskError) -> (axum::http::StatusCode, String) {
    match error {
        PrepareTaskError::InvalidRequest(error) => (axum::http::StatusCode::BAD_REQUEST, error),
        other => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            other.to_string(),
        ),
    }
}

fn spawn_signal_agent_task_detached(
    state: Arc<AppState>,
    prepared: crate::task_creator::PreparedTaskSpawn,
) {
    tokio::spawn(async move {
        let task_id = prepared.task_id().to_string();
        let config: Config = state.config().clone();
        let result = async {
            let mut daemon = crate::daemon_client::DaemonClient::connect(&config.daemon_dir)
                .await
                .map_err(|e| format!("daemon error: {}", e))?;
            crate::task_creator::spawn_prepared_task_for_api_with_diagnostics(
                &config.db_path,
                &mut daemon,
                prepared,
            )
            .await
            .map(|_| ())
        }
        .await;
        match result {
            Ok(()) => state.publish_state_changed(StateChangeScope::Tasks),
            Err(error) => {
                log::error!("failed to spawn signaled agent task {task_id}: {error}");
                state.publish_state_changed(StateChangeScope::Tasks);
            }
        }
    });
}
