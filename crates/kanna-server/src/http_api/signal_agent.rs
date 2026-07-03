use super::state::{db_write_error, AppState};
use super::task_input::submit_task_input;
use crate::config::Config;
use crate::db::Db;
use axum::extract::State;
use axum::Json;
use std::sync::Arc;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SignalAgentRequest {
    message: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SignalAgentResponse {
    task_id: String,
    created: bool,
}

pub(super) async fn signal_agent(
    State(state): State<Arc<AppState>>,
    axum::extract::Path((repo_id, agent)): axum::extract::Path<(String, String)>,
    Json(payload): Json<SignalAgentRequest>,
) -> Result<Json<SignalAgentResponse>, (axum::http::StatusCode, String)> {
    let message = payload.message.trim();
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
        db.find_open_running_agent_task(&repo_id, &agent)
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
        return Ok(Json(SignalAgentResponse {
            task_id: running.task_id,
            created: false,
        }));
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
        )
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
        db.pin_pipeline_item_at_top(&repo_id, prepared.task_id())
            .map_err(|e| db_write_error("db error", e))?;
        prepared
    };
    let task_id = prepared.task_id().to_string();
    spawn_signal_agent_task_detached(state.config.clone(), prepared);

    Ok(Json(SignalAgentResponse {
        task_id,
        created: true,
    }))
}

fn spawn_signal_agent_task_detached(
    config: Config,
    prepared: crate::task_creator::PreparedTaskSpawn,
) {
    tokio::spawn(async move {
        let task_id = prepared.task_id().to_string();
        let result = async {
            let mut daemon = crate::daemon_client::DaemonClient::connect(&config.daemon_dir)
                .await
                .map_err(|e| format!("daemon error: {}", e))?;
            crate::task_creator::spawn_prepared_task_for_api_with_rollback(
                &config.db_path,
                &mut daemon,
                prepared,
            )
            .await
            .map(|_| ())
        }
        .await;
        if let Err(error) = result {
            log::error!("failed to spawn signaled agent task {task_id}: {error}");
        }
    });
}
