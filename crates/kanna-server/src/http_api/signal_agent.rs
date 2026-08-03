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
    State(state): State<Arc<AppState>>,
    axum::extract::Path((repo_id, agent)): axum::extract::Path<(String, String)>,
    Json(payload): Json<SignalAgentRequest>,
) -> Result<Json<SignalAgentResponse>, (axum::http::StatusCode, String)> {
    // Pipeline approval used to send this exact free-text shape through the
    // generic singleton endpoint. It carries a task id but no server-owned
    // lineage projection, so accepting it would preserve the laundering path
    // that the gated handoff endpoint closes. Direct operator conversation in
    // the merge terminal remains valid; only automation-shaped HTTP handoffs
    // are rejected here.
    let message = payload.message.trim();
    if agent == "merge"
        && (message.starts_with("KANNA_MERGE_HANDOFF ")
            || (message.starts_with("MERGE ") && message.contains("[TASK ")))
    {
        return Err((
            axum::http::StatusCode::CONFLICT,
            "pipeline merge handoffs must use /v1/tasks/{task_id}/actions/signal-merge-handoff so the server can attach approval lineage"
                .into(),
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

    let (repo_id, gate) = {
        let db = Db::open(&state.config.db_path).map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {error}"),
            )
        })?;
        let task = db
            .get_pipeline_item(&task_id)
            .map_err(|error| db_write_error("db error", error))?
            .ok_or_else(|| {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    format!("task not found: {task_id}"),
                )
            })?;
        let gate = db
            .task_approval_gate(&task_id)
            .map_err(|error| db_write_error("db error", error))?;
        if !gate.permits_approval() {
            return Err((
                axum::http::StatusCode::CONFLICT,
                format!(
                    "approval held: task {task_id} has unresolved lineage disposition(s); a recorded human override is required"
                ),
            ));
        }
        (task.repo_id, gate)
    };

    let handoff = serde_json::json!({
        "version": 1,
        "taskId": task_id,
        "branch": payload.branch.trim(),
        "target": payload.target.trim(),
        "prUrl": payload.pr_url.as_deref().map(str::trim).filter(|value| !value.is_empty()),
        "summary": payload.summary.trim(),
        "approval": gate,
    });
    let message = format!(
        "KANNA_MERGE_HANDOFF {}",
        serde_json::to_string(&handoff).map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to serialize merge handoff: {error}"),
            )
        })?
    );
    signal_agent_request(
        state,
        repo_id,
        "merge".into(),
        message,
        SingletonAgentOverrides::default(),
    )
    .await
    .map(Json)
}

pub(super) async fn signal_agent_request(
    state: Arc<AppState>,
    repo_id: String,
    agent: String,
    message: String,
    overrides: SingletonAgentOverrides,
) -> Result<SignalAgentResponse, (axum::http::StatusCode, String)> {
    let message = message.trim();
    if message.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "message must be a non-empty string".to_string(),
        ));
    }

    let running = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        db.find_open_agent_task(&repo_id, &agent)
            .map_err(|e| db_write_error("db error", e))?
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
        submit_task_input(&mut daemon, &running.session_id, message).await?;
        return Ok(SignalAgentResponse {
            task_id: running.task_id,
            created: false,
        });
    }

    let prepared = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        let prepared = crate::task_creator::prepare_singleton_agent_task_for_api(
            &db,
            &state.config,
            &repo_id,
            &agent,
            message,
            overrides,
        )
        .map_err(prepare_singleton_error)?;
        db.pin_pipeline_item_at_top(&repo_id, prepared.task_id())
            .map_err(|e| db_write_error("db error", e))?;
        prepared
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
