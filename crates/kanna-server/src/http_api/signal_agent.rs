use super::lan_trust::PrivilegedTaskAccess;
use super::state::{db_write_error, AppState};
use super::task_input::submit_task_input;
use crate::config::Config;
use crate::db::Db;
use crate::task_creator::{PrepareTaskError, SingletonAgentOverrides};
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
    let message = payload.message.trim();
    if agent == "merge" {
        if message.starts_with("KANNA_MERGE_HANDOFF ") {
            return Err((
                axum::http::StatusCode::CONFLICT,
                "caller-built merge handoffs are forbidden; use the canonical task handoff action"
                    .into(),
            ));
        }
        if let Some((task_id, legacy)) = parse_legacy_merge_handoff(message) {
            return signal_merge_handoff_impl(state, task_id, legacy, Some(repo_id))
                .await
                .map(Json);
        }
        return Err((
            axum::http::StatusCode::CONFLICT,
            "the agent-callable merge signal accepts no natural-language merge authority; type operator requests directly in the merge terminal or use the canonical task handoff action".into(),
        ));
    }
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

/// Deliver an approval handoff whose lineage state is built by the server,
/// never supplied by the approve agent. The merge singleton can therefore
/// distinguish a clean approval from a deliberate recorded override and an
/// unresolved hold can never reach it through this path.
pub(super) async fn signal_merge_handoff(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::MergeHandoffRequest>,
) -> Result<Json<SignalAgentResponse>, (axum::http::StatusCode, String)> {
    signal_merge_handoff_impl(state, task_id, payload, None)
        .await
        .map(Json)
}

async fn signal_merge_handoff_impl(
    state: Arc<AppState>,
    task_id: String,
    payload: crate::mobile_api::MergeHandoffRequest,
    expected_repo_id: Option<String>,
) -> Result<SignalAgentResponse, (axum::http::StatusCode, String)> {
    let task_id = super::task_actions::resolve_task_id_for_mutation(&state, &task_id).await?;
    // Serialize the gate read and the daemon delivery with every transition,
    // completion, and override mutation for this task. Otherwise a new hold
    // could be committed after the read but before the handoff was delivered.
    let _task_mutation = state.begin_requested_task_mutation(&task_id).await;
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

    let authorization = {
        let state = Arc::clone(&state);
        let task_id = task_id.clone();
        super::blocking::run_handler_blocking("merge handoff approval read", move || {
            let db = Db::open(&state.config.db_path).map_err(|error| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {error}"),
                )
            })?;
            let current_run = db
                .latest_stage_run(&task_id)
                .map_err(|error| db_write_error("db error", error))?
                .ok_or_else(|| {
                    (
                        axum::http::StatusCode::CONFLICT,
                        format!("task has no active approval run: {task_id}"),
                    )
                })?;
            if current_run.kind != "post"
                || current_run.stage != "approve"
                || current_run.status != "running"
            {
                return Err((
                    axum::http::StatusCode::CONFLICT,
                    format!("task is not in an active approval run: {task_id}"),
                ));
            }
            let gate = db
                .task_approval_gate(&task_id)
                .map_err(|error| db_write_error("db error", error))?;
            if !gate.permits_approval() {
                return Err((
                    axum::http::StatusCode::CONFLICT,
                    format!("approval held for task {task_id}"),
                ));
            }
            // Approve sessions survive upgrades. A pre-upgrade session has no
            // authorization row, so establish the same server-owned snapshot
            // lazily while the task mutation lease still excludes lineage
            // changes. Caller-supplied candidate fields are checked against it
            // below exactly as they are for a newly spawned approve post.
            let authorization = match db
                .approval_authorization(&task_id, &current_run.id)
                .map_err(|error| db_write_error("db error", error))?
            {
                Some(authorization) => authorization,
                None => {
                    db.record_approval_authorization(&task_id, &current_run.id)
                        .map_err(|error| db_write_error("db error", error))?;
                    db.approval_authorization(&task_id, &current_run.id)
                        .map_err(|error| db_write_error("db error", error))?
                        .ok_or_else(|| {
                            (
                                axum::http::StatusCode::CONFLICT,
                                format!("task has no durable approval authorization: {task_id}"),
                            )
                        })?
                }
            };
            if gate != authorization.approval {
                return Err((
                    axum::http::StatusCode::CONFLICT,
                    format!("approval authorization is stale or held for task {task_id}"),
                ));
            }
            Ok(authorization)
        })
        .await?
    };

    if expected_repo_id
        .as_deref()
        .is_some_and(|repo_id| repo_id != authorization.repo_id)
    {
        return Err((
            axum::http::StatusCode::CONFLICT,
            "legacy merge handoff repo does not match the authorized task".into(),
        ));
    }
    let requested_pr_url = payload
        .pr_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if payload.branch.trim() != authorization.branch
        || payload.target.trim() != authorization.target
        || requested_pr_url != authorization.pr_url.as_deref()
    {
        return Err((
            axum::http::StatusCode::CONFLICT,
            "merge candidate does not match the task's authorized branch, target, and PR".into(),
        ));
    }
    if authorization.delivered_at.is_some() {
        return Err((
            axum::http::StatusCode::CONFLICT,
            "approval handoff was already delivered".into(),
        ));
    }

    let handoff = serde_json::json!({
        "version": 1,
        "taskId": task_id,
        "branch": payload.branch.trim(),
        "target": payload.target.trim(),
        "prUrl": payload.pr_url.as_deref().map(str::trim).filter(|value| !value.is_empty()),
        "summary": payload.summary.trim(),
        "approval": authorization.approval.clone(),
    });
    let canonical_message = format!(
        "KANNA_MERGE_HANDOFF {}",
        serde_json::to_string(&handoff).map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to serialize merge handoff: {error}"),
            )
        })?
    );
    let legacy_message = format!(
        "MERGE {} -> {} [TASK {}]{}: {}",
        authorization.branch,
        authorization.target,
        authorization.task_id,
        authorization
            .pr_url
            .as_deref()
            .map(|url| format!(" [PR {url}]"))
            .unwrap_or_default(),
        payload.summary.trim(),
    );
    let protocol = merge_protocol_for_repo(&state, &authorization.repo_id).await?;
    if protocol == 0
        && !matches!(
            authorization.approval.state,
            crate::db::ApprovalGateState::Eligible
        )
    {
        return Err((
            axum::http::StatusCode::CONFLICT,
            "the surviving merge session predates override-aware handoffs; restart it before delivering an overridden approval".into(),
        ));
    }
    let response = signal_agent_request(
        Arc::clone(&state),
        authorization.repo_id.clone(),
        "merge".into(),
        if protocol == 0 {
            legacy_message
        } else {
            canonical_message
        },
        SingletonAgentOverrides::default(),
    )
    .await?;
    {
        let state = Arc::clone(&state);
        let run_id = authorization.run_id;
        super::blocking::run_handler_blocking("merge handoff delivery record", move || {
            let db = Db::open(&state.config.db_path)
                .map_err(|error| db_write_error("db error", error))?;
            db.mark_approval_authorization_delivered(&run_id)
                .map_err(|error| db_write_error("db error", error))
        })
        .await?;
    }
    Ok(response)
}

async fn merge_protocol_for_repo(
    state: &Arc<AppState>,
    repo_id: &str,
) -> Result<i64, (axum::http::StatusCode, String)> {
    let state = Arc::clone(state);
    let repo_id = repo_id.to_string();
    super::blocking::run_handler_blocking("merge signal protocol read", move || {
        let db =
            Db::open(&state.config.db_path).map_err(|error| db_write_error("db error", error))?;
        let Some(running) = db
            .find_open_agent_task(&repo_id, "merge")
            .map_err(|error| db_write_error("db error", error))?
        else {
            return Ok(1);
        };
        db.merge_handoff_protocol(&running.task_id)
            .map_err(|error| db_write_error("db error", error))
    })
    .await
}

fn parse_legacy_merge_handoff(
    message: &str,
) -> Option<(String, crate::mobile_api::MergeHandoffRequest)> {
    let body = message.strip_prefix("MERGE ")?;
    let (branch, rest) = body.split_once(" -> ")?;
    let (target, rest) = rest.split_once(" [TASK ")?;
    let (task_id, rest) = rest.split_once(']')?;
    let rest = rest.trim_start();
    let (pr_url, rest) = if let Some(rest) = rest.strip_prefix("[PR ") {
        let (url, rest) = rest.split_once(']')?;
        (Some(url.trim().to_string()), rest)
    } else {
        (None, rest)
    };
    let summary = rest.strip_prefix(':')?.trim();
    if [branch.trim(), target.trim(), task_id.trim(), summary]
        .iter()
        .any(|value| value.is_empty())
    {
        return None;
    }
    Some((
        task_id.trim().to_string(),
        crate::mobile_api::MergeHandoffRequest {
            branch: branch.trim().to_string(),
            target: target.trim().to_string(),
            pr_url,
            summary: summary.to_string(),
        },
    ))
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
        let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
            .await
            .map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("daemon error: {}", e),
                )
            })?;
        submit_task_input(&mut daemon, &running.session_id, &message).await?;
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
            if agent == "merge" {
                db.set_merge_handoff_protocol(prepared.task_id(), 1)
                    .map_err(|e| db_write_error("db error", e))?;
            }
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
