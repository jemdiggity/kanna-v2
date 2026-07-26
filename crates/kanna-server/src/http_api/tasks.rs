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
    create_task_with_requested_id(state, payload, None).await
}

pub(super) async fn put_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::CreateTaskRequest>,
) -> Result<Json<crate::mobile_api::CreateTaskResponse>, (axum::http::StatusCode, String)> {
    validate_requested_task_id(&task_id)?;
    let _flight = state
        .begin_requested_task_creation(&task_id)
        .ok_or_else(|| {
            (
                axum::http::StatusCode::CONFLICT,
                format!("task creation already in progress: {task_id}"),
            )
        })?;
    create_task_with_requested_id(state, payload, Some(task_id)).await
}

pub(super) async fn create_task_with_requested_id(
    state: Arc<AppState>,
    payload: crate::mobile_api::CreateTaskRequest,
    requested_task_id: Option<String>,
) -> Result<Json<crate::mobile_api::CreateTaskResponse>, (axum::http::StatusCode, String)> {
    if let Some(task_id) = requested_task_id.as_deref() {
        validate_requested_task_id(task_id)?;
    }
    if let Some(snapshot) = payload.recovery_snapshot.as_ref() {
        snapshot
            .validate()
            .map_err(|message| (axum::http::StatusCode::BAD_REQUEST, message))?;
    }

    #[cfg(test)]
    if let Some(task_creator) = state.task_creator.clone() {
        return task_creator(payload)
            .map(Json)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    // Everything before the daemon spawn is synchronous git/SQLite work —
    // task preparation creates the worktree and runs repo-config setup, so
    // it must run on the blocking pool, never on a runtime worker.
    enum PreparedCreateOutcome {
        Done(crate::mobile_api::CreateTaskResponse),
        DormantCreated(crate::mobile_api::CreateTaskResponse),
        Repair {
            existing: crate::mobile_api::CreateTaskResponse,
            prepared: crate::task_creator::PreparedStageRerun,
        },
        Spawn {
            prepared: crate::task_creator::PreparedTaskSpawn,
            resolved_blocker_ids: Vec<String>,
        },
    }
    let outcome = {
        let state = Arc::clone(&state);
        super::blocking::run_handler_blocking("task create prepare", move || {
            if let Some(task_id) = requested_task_id.as_deref() {
                let db = Db::open(&state.config.db_path).map_err(|e| {
                    (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        format!("db error: {}", e),
                    )
                })?;
                if let Some(existing) =
                    existing_create_task_response(&db, task_id, &payload.repo_id, &payload.prompt)?
                {
                    let existing_is_open = db
                        .get_pipeline_item(task_id)
                        .map_err(|e| db_write_error("db error", e))?
                        .is_some_and(|item| item.closed_at.is_none());
                    if existing_is_open
                        && !db
                            .has_durable_running_task_session(task_id)
                            .map_err(|e| db_write_error("db error", e))?
                    {
                        let prepared = crate::task_creator::prepare_create_task_repair_for_api(
                            &db,
                            &state.config,
                            task_id,
                        )
                        .and_then(|prepared| {
                            prepared.map(Ok).unwrap_or_else(|| {
                                crate::task_creator::prepare_rerun_stage_for_api(
                                    &db,
                                    &state.config,
                                    task_id,
                                )
                            })
                        })
                        .map_err(|error| {
                            (
                                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                                format!("task spawn repair prepare failed: {error}"),
                            )
                        })?;
                        return Ok(PreparedCreateOutcome::Repair { existing, prepared });
                    }
                    return Ok(PreparedCreateOutcome::Done(existing));
                }
            }

            let requested_task = requested_task_id.as_ref().map(|task_id| {
                (
                    task_id.clone(),
                    payload.repo_id.clone(),
                    payload.prompt.clone(),
                )
            });
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
                let has_open_blockers =
                    resolved_blocker_ids
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
                    let created = match crate::task_creator::create_dormant_task_for_api_with_error(
                        &db,
                        payload,
                        requested_task_id.clone(),
                    ) {
                        Ok(created) => created,
                        Err(error) => {
                            let requested_task =
                                requested_task.as_ref().map(|(task_id, repo_id, prompt)| {
                                    (task_id.as_str(), repo_id.as_str(), prompt.as_str())
                                });
                            let existing =
                                resolve_create_task_prepare_error(&db, error, requested_task)?;
                            return Ok(PreparedCreateOutcome::Done(existing));
                        }
                    };
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
                    return Ok(PreparedCreateOutcome::DormantCreated(created));
                }
            }

            let prepared = {
                let db = Db::open(&state.config.db_path).map_err(|e| {
                    (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        format!("db error: {}", e),
                    )
                })?;
                match crate::task_creator::prepare_task_for_api_with_error(
                    &db,
                    &state.config,
                    payload,
                    requested_task_id,
                ) {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        let requested_task =
                            requested_task.as_ref().map(|(task_id, repo_id, prompt)| {
                                (task_id.as_str(), repo_id.as_str(), prompt.as_str())
                            });
                        let existing =
                            resolve_create_task_prepare_error(&db, error, requested_task)?;
                        return Ok(PreparedCreateOutcome::Done(existing));
                    }
                }
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
            Ok(PreparedCreateOutcome::Spawn {
                prepared,
                resolved_blocker_ids,
            })
        })
        .await?
    };
    let (prepared, resolved_blocker_ids) = match outcome {
        PreparedCreateOutcome::Done(existing) => return Ok(Json(existing)),
        PreparedCreateOutcome::DormantCreated(created) => {
            state.publish_state_changed(StateChangeScope::Tasks);
            state.publish_state_changed(StateChangeScope::Blockers);
            return Ok(Json(created));
        }
        PreparedCreateOutcome::Repair { existing, prepared } => {
            let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
                .await
                .map_err(|e| {
                    (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        format!("daemon error: {}", e),
                    )
                })?;
            crate::task_creator::rerun_prepared_stage_for_api(
                &state.config.db_path,
                &mut daemon,
                &state.session_replacements,
                prepared,
            )
            .await
            .map_err(|error| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("task spawn repair failed: {error}"),
                )
            })?;
            state.publish_state_changed(StateChangeScope::Tasks);
            return Ok(Json(existing));
        }
        PreparedCreateOutcome::Spawn {
            prepared,
            resolved_blocker_ids,
        } => (prepared, resolved_blocker_ids),
    };
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

pub(super) fn validate_requested_task_id(
    task_id: &str,
) -> Result<(), (axum::http::StatusCode, String)> {
    let valid_length = (8..=64).contains(&task_id.len());
    let lowercase_hex = task_id
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if valid_length && lowercase_hex {
        Ok(())
    } else {
        Err((
            axum::http::StatusCode::BAD_REQUEST,
            "taskId must be 8 to 64 lowercase hexadecimal characters".to_string(),
        ))
    }
}

fn existing_create_task_response(
    db: &Db,
    task_id: &str,
    repo_id: &str,
    prompt: &str,
) -> Result<Option<crate::mobile_api::CreateTaskResponse>, (axum::http::StatusCode, String)> {
    let Some(item) = db
        .get_pipeline_item(task_id)
        .map_err(|e| db_write_error("db error", e))?
    else {
        return Ok(None);
    };
    if item.repo_id != repo_id || item.prompt.as_deref() != Some(prompt) {
        return Err((
            axum::http::StatusCode::CONFLICT,
            format!("taskId already exists with different task data: {task_id}"),
        ));
    }
    let title = item
        .display_name
        .clone()
        .or(item.prompt.clone())
        .unwrap_or_else(|| item.id.clone());
    let stage = item.stage.clone().ok_or_else(|| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("task {task_id} is missing its current stage"),
        )
    })?;
    let agent_type = item.agent_type.clone().ok_or_else(|| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("task {task_id} is missing its current agent type"),
        )
    })?;
    let worktree_path = db
        .get_task_worktree_path(task_id)
        .map_err(|e| db_write_error("db error", e))?;
    Ok(Some(crate::mobile_api::CreateTaskResponse {
        task_id: item.id,
        repo_id: item.repo_id,
        title,
        prompt: prompt.to_string(),
        stage,
        agent_type,
        worktree_path,
    }))
}

pub(super) fn resolve_create_task_prepare_error(
    db: &Db,
    error: crate::task_creator::PrepareTaskError,
    requested_task: Option<(&str, &str, &str)>,
) -> Result<crate::mobile_api::CreateTaskResponse, (axum::http::StatusCode, String)> {
    match error {
        crate::task_creator::PrepareTaskError::RequestedTaskIdAlreadyExists => {
            let Some((task_id, repo_id, prompt)) = requested_task else {
                return Err((
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "generated task id collided with an existing task".to_string(),
                ));
            };
            existing_create_task_response(db, task_id, repo_id, prompt)?.ok_or_else(|| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("taskId collision disappeared before replay: {task_id}"),
                )
            })
        }
        crate::task_creator::PrepareTaskError::Other(error) => {
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))
        }
    }
}
