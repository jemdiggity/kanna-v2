use super::state::{db_write_error, AppState};
use super::task_blockers::{
    persist_resolved_task_blockers, persist_task_blocker_rows, resolve_task_blocker_ids,
};
use crate::db::Db;
use crate::mobile_api::MobileApi;
use axum::extract::State;
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use std::sync::Arc;

pub(super) async fn list_recent_tasks(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::mobile_api::TaskSummary>>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    if crate::mobile_api::record_orphaned_initialized_tasks(&db)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    {
        state.publish_state_changed(StateChangeScope::Tasks);
    }
    let api = MobileApi::new(state.config.clone(), db);
    let tasks = api
        .list_recent_tasks()
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(tasks))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClosedTaskIdentitiesResponse {
    tasks: Vec<crate::db::ClosedTaskIdentity>,
}

pub(super) async fn list_closed_task_identities(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ClosedTaskIdentitiesResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let tasks = db
        .list_closed_task_identities()
        .map_err(|e| db_write_error("db error", e))?;
    Ok(Json(ClosedTaskIdentitiesResponse { tasks }))
}

pub(super) async fn get_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::TaskDetail>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    if crate::mobile_api::record_orphaned_initialized_tasks(&db)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    {
        state.publish_state_changed(StateChangeScope::Tasks);
    }
    let api = MobileApi::new(state.config.clone(), db);
    let task = api
        .get_task(&task_id)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {task_id}"),
            )
        })?;
    Ok(Json(task))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateTaskRequest {
    #[serde(default, deserialize_with = "deserialize_nullable_field")]
    display_name: Option<Option<String>>,
}

fn deserialize_nullable_field<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    <Option<T> as serde::Deserialize>::deserialize(deserializer).map(Some)
}

pub(super) async fn update_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<UpdateTaskRequest>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let display_name = match payload.display_name {
        Some(Some(value)) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                return Err((
                    axum::http::StatusCode::BAD_REQUEST,
                    "displayName must be non-empty when provided".to_string(),
                ));
            }
            Some(trimmed)
        }
        Some(None) => None,
        None => {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                "displayName must be provided".to_string(),
            ));
        }
    };
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = db
        .resolve_pipeline_item_id(&task_id)
        .map_err(|e| db_write_error("db error", e))?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                "db error: not found".to_string(),
            )
        })?;
    db.update_pipeline_item_display_name(&task_id, display_name.as_deref())
        .map_err(|e| db_write_error("db error", e))?;
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
    }))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SearchTasksQuery {
    query: String,
}

pub(super) async fn search_tasks(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<SearchTasksQuery>,
) -> Result<Json<Vec<crate::mobile_api::TaskSummary>>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    if crate::mobile_api::record_orphaned_initialized_tasks(&db)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    {
        state.publish_state_changed(StateChangeScope::Tasks);
    }
    let api = MobileApi::new(state.config.clone(), db);
    let tasks = api
        .search_tasks(&query.query)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(tasks))
}

pub(super) async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<crate::mobile_api::CreateTaskRequest>,
) -> Result<Json<crate::mobile_api::CreateTaskResponse>, (axum::http::StatusCode, String)> {
    #[cfg(test)]
    if let Some(task_creator) = state.task_creator.clone() {
        return task_creator(payload)
            .map(Json)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let blocker_task_ids = payload.blocker_task_ids.clone().unwrap_or_default();
    let resolved_blocker_ids = if blocker_task_ids.is_empty() {
        Vec::new()
    } else {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        resolve_task_blocker_ids(&db, &blocker_task_ids)?
    };
    if !resolved_blocker_ids.is_empty() {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        let has_open_blockers = resolved_blocker_ids
            .iter()
            .try_fold(false, |has_open, id| {
                if has_open {
                    Ok(true)
                } else {
                    let blocker = db
                        .get_pipeline_item(id)
                        .map_err(|e| db_write_error("db error", e))?
                        .ok_or_else(|| {
                            (
                                axum::http::StatusCode::NOT_FOUND,
                                format!("task not found: {id}"),
                            )
                        })?;
                    Ok(blocker.closed_at.is_none())
                }
            })?;
        if has_open_blockers {
            let created = crate::task_creator::create_dormant_task_for_api(&db, payload)
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
            if let Err(err) =
                persist_resolved_task_blockers(&db, &created.task_id, &resolved_blocker_ids)
            {
                let rollback_result = db.delete_task_creation_artifacts(&created.task_id);
                return Err(match rollback_result {
                    Ok(()) => err,
                    Err(rollback_err) => (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        format!("{}; rollback failed: {}", err.1, rollback_err),
                    ),
                });
            }
            state.publish_state_changed(StateChangeScope::Tasks);
            state.publish_state_changed(StateChangeScope::Blockers);
            return Ok(Json(created));
        }
    }

    let prepared = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        crate::task_creator::prepare_task_for_api(&db, &state.config, payload)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    };
    if !resolved_blocker_ids.is_empty() {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        if let Err(err) = persist_task_blocker_rows(
            &db,
            crate::task_creator::prepared_task_id(&prepared),
            &resolved_blocker_ids,
        ) {
            let rollback_result =
                crate::task_creator::rollback_prepared_task_for_api(&db, &prepared);
            return Err(match rollback_result {
                Ok(()) => err,
                Err(rollback_err) => (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("{}; rollback failed: {}", err.1, rollback_err),
                ),
            });
        }
    }
    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    let created = crate::task_creator::spawn_prepared_task_for_api_with_diagnostics(
        &state.config.db_path,
        &mut daemon,
        prepared,
    )
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.publish_state_changed(StateChangeScope::Tasks);
    if !resolved_blocker_ids.is_empty() {
        state.publish_state_changed(StateChangeScope::Blockers);
    }
    Ok(Json(created))
}
