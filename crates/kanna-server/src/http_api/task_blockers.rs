use super::state::{db_write_error, AppState};
use crate::daemon_client::DaemonClient;
use crate::db::Db;
use axum::extract::State;
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use std::sync::Arc;

pub(super) fn resolve_existing_task_id(
    db: &Db,
    task_or_branch_id: &str,
) -> Result<String, (axum::http::StatusCode, String)> {
    db.resolve_pipeline_item_id(task_or_branch_id)
        .map_err(|e| db_write_error("db error", e))?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {}", task_or_branch_id),
            )
        })
}

pub(super) fn resolve_task_blocker_ids(
    db: &Db,
    blocker_task_ids: &[String],
) -> Result<Vec<String>, (axum::http::StatusCode, String)> {
    let mut resolved_blocker_ids = Vec::new();
    for blocker_task_id in blocker_task_ids {
        let blocker_id = resolve_existing_task_id(db, blocker_task_id)?;
        if !resolved_blocker_ids.contains(&blocker_id) {
            resolved_blocker_ids.push(blocker_id);
        }
    }
    Ok(resolved_blocker_ids)
}

pub(super) fn persist_resolved_task_blockers(
    db: &Db,
    task_id: &str,
    resolved_blocker_ids: &[String],
) -> Result<(), (axum::http::StatusCode, String)> {
    db.remove_all_task_blockers(task_id)
        .map_err(|e| db_write_error("db error", e))?;
    persist_task_blocker_rows(db, task_id, resolved_blocker_ids)?;
    db.update_pipeline_item_activity(task_id, "idle")
        .map_err(|e| db_write_error("db error", e))
}

pub(super) fn persist_task_blocker_rows(
    db: &Db,
    task_id: &str,
    resolved_blocker_ids: &[String],
) -> Result<(), (axum::http::StatusCode, String)> {
    for blocker_id in resolved_blocker_ids {
        db.insert_task_blocker(task_id, blocker_id)
            .map_err(|e| db_write_error("db error", e))?;
    }
    Ok(())
}

pub(super) fn apply_task_blockers(
    db: &Db,
    task_or_branch_id: &str,
    blocker_task_ids: &[String],
) -> Result<String, (axum::http::StatusCode, String)> {
    if blocker_task_ids.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "blockerTaskIds must contain at least one task id".to_string(),
        ));
    }

    let task_id = resolve_existing_task_id(db, task_or_branch_id)?;
    let resolved_blocker_ids = resolve_task_blocker_ids(db, blocker_task_ids)?;
    for blocker_id in &resolved_blocker_ids {
        if blocker_id == &task_id {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                "task cannot block itself".to_string(),
            ));
        }
        if db
            .task_dependency_has_path_to(blocker_id, &task_id)
            .map_err(|e| db_write_error("db error", e))?
        {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                "cannot add blocker because it would create a circular dependency".to_string(),
            ));
        }
    }

    persist_resolved_task_blockers(db, &task_id, &resolved_blocker_ids)?;
    Ok(task_id)
}

fn blocker_branches_for_task(
    db: &Db,
    blocked_task_id: &str,
) -> Result<Vec<String>, (axum::http::StatusCode, String)> {
    let blocked_task = db
        .get_pipeline_item(blocked_task_id)
        .map_err(|e| db_write_error("db error", e))?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {blocked_task_id}"),
            )
        })?;
    let blocker_ids = db
        .list_task_blocker_ids(blocked_task_id)
        .map_err(|e| db_write_error("db error", e))?;
    let mut branches = Vec::new();
    for blocker_id in blocker_ids {
        let blocker = db
            .get_pipeline_item(&blocker_id)
            .map_err(|e| db_write_error("db error", e))?
            .ok_or_else(|| {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    format!("task not found: {blocker_id}"),
                )
            })?;
        if blocker.repo_id != blocked_task.repo_id {
            continue;
        }
        let Some(branch) = blocker
            .branch
            .as_deref()
            .filter(|branch| !branch.trim().is_empty())
        else {
            continue;
        };
        let repo = db
            .get_repo(&blocker.repo_id)
            .map_err(|e| db_write_error("db error", e))?;
        let resolved_branch = db
            .get_pipeline_item_pr_branch(&blocker_id)
            .map_err(|e| db_write_error("db error", e))?
            .or_else(|| {
                repo.as_ref().and_then(|repo| {
                    crate::task_creator::resolve_current_source_worktree_branch(
                        &repo.path,
                        Some(branch),
                    )
                })
            })
            .unwrap_or_else(|| branch.to_string());
        branches.push(resolved_branch);
    }
    Ok(branches)
}

pub(super) async fn start_dormant_task_if_ready(
    state: &Arc<AppState>,
    task_id: &str,
    blocker_branches: Vec<String>,
) -> Result<bool, (axum::http::StatusCode, String)> {
    let prepared = prepare_dormant_task(state, task_id, blocker_branches);
    if matches!(prepared, Ok(None)) {
        return Ok(false);
    }
    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    match prepared {
        Ok(Some(prepared)) => {
            spawn_prepared_dormant_task(state, &mut daemon, prepared).await?;
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(crate::task_creator::DormantStartError::MergeConflict(conflict)) => {
            create_integration_task_for_conflict(state, &mut daemon, task_id, conflict).await?;
            Ok(true)
        }
        Err(crate::task_creator::DormantStartError::Other(error)) => {
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))
        }
    }
}

async fn start_dormant_task_if_ready_with_daemon(
    state: &Arc<AppState>,
    daemon: &mut DaemonClient,
    task_id: &str,
    blocker_branches: Vec<String>,
) -> Result<bool, (axum::http::StatusCode, String)> {
    match prepare_dormant_task(state, task_id, blocker_branches) {
        Ok(Some(prepared)) => {
            spawn_prepared_dormant_task(state, daemon, prepared).await?;
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(crate::task_creator::DormantStartError::MergeConflict(conflict)) => {
            create_integration_task_for_conflict(state, daemon, task_id, conflict).await?;
            Ok(true)
        }
        Err(crate::task_creator::DormantStartError::Other(error)) => {
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))
        }
    }
}

fn prepare_dormant_task(
    state: &Arc<AppState>,
    task_id: &str,
    blocker_branches: Vec<String>,
) -> Result<Option<crate::task_creator::PreparedTaskSpawn>, crate::task_creator::DormantStartError>
{
    let db = Db::open(&state.config.db_path)
        .map_err(|e| crate::task_creator::DormantStartError::Other(format!("db error: {}", e)))?;
    crate::task_creator::prepare_start_dormant_task_for_api(
        &db,
        &state.config,
        task_id,
        blocker_branches,
    )
}

async fn spawn_prepared_dormant_task(
    state: &Arc<AppState>,
    daemon: &mut DaemonClient,
    prepared: crate::task_creator::PreparedTaskSpawn,
) -> Result<(), (axum::http::StatusCode, String)> {
    crate::task_creator::spawn_prepared_task_for_api_recording_stage_run(
        &state.config.db_path,
        daemon,
        prepared,
    )
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(())
}

async fn create_integration_task_for_conflict(
    state: &Arc<AppState>,
    daemon: &mut DaemonClient,
    dependent_task_id: &str,
    conflict: crate::task_creator::DormantMergeConflict,
) -> Result<(), (axum::http::StatusCode, String)> {
    let (prepared, previous_blockers) = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        let previous_blockers = db
            .list_task_blocker_ids(dependent_task_id)
            .map_err(|e| db_write_error("db error", e))?;
        let prepared = crate::task_creator::prepare_integration_task_for_api(
            &db,
            &state.config,
            dependent_task_id,
            &conflict.base_branch,
            &conflict.remaining_branches,
        )
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
        let integration_task_id = prepared.task_id().to_string();
        db.replace_task_blockers(
            dependent_task_id,
            std::slice::from_ref(&integration_task_id),
        )
        .map_err(|e| db_write_error("db error", e))?;
        log::info!(
            "inserted integration task {integration_task_id} for dependent {dependent_task_id} after blocker branch merge conflict on {}",
            conflict.conflicting_branch
        );
        (prepared, previous_blockers)
    };

    match crate::task_creator::spawn_prepared_task_for_api_with_diagnostics(
        &state.config.db_path,
        daemon,
        prepared.clone(),
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(error) => {
            if let Ok(db) = Db::open(&state.config.db_path) {
                if let Err(restore_error) =
                    db.replace_task_blockers(dependent_task_id, &previous_blockers)
                {
                    log::error!(
                        "failed to restore blockers for {dependent_task_id} after integration spawn failure: {restore_error}"
                    );
                }
            }
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))
        }
    }
}

/// Start every dormant dependent whose last blocker just closed. Runs after
/// the blocker's close has already committed, so failures here must never
/// fail the close: each dependent is attempted independently and errors are
/// logged. Historically a swallowed failure in this path left dependents
/// permanently dormant with no trace — log loudly instead.
pub(super) async fn start_dependents_unblocked_by_close_with_daemon(
    state: &Arc<AppState>,
    daemon: &mut DaemonClient,
    blocker_task_id: &str,
) {
    let ready_dependents = {
        let db = match Db::open(&state.config.db_path) {
            Ok(db) => db,
            Err(error) => {
                log::error!(
                    "cannot start dependents unblocked by {blocker_task_id}: db error: {error}"
                );
                return;
            }
        };
        let blocked_ids = match db.list_tasks_blocked_by(blocker_task_id) {
            Ok(blocked_ids) => blocked_ids,
            Err(error) => {
                log::error!("cannot list dependents of closed blocker {blocker_task_id}: {error}");
                return;
            }
        };
        let mut ready = Vec::new();
        for blocked_id in blocked_ids {
            match db.count_open_task_blockers(&blocked_id) {
                Ok(0) => {}
                Ok(_) => continue,
                Err(error) => {
                    log::error!("cannot count open blockers for {blocked_id}: {error}");
                    continue;
                }
            }
            match blocker_branches_for_task(&db, &blocked_id) {
                Ok(blocker_branches) => ready.push((blocked_id, blocker_branches)),
                Err((_, error)) => {
                    log::error!("cannot resolve blocker branches for {blocked_id}: {error}");
                    ready.push((blocked_id, Vec::new()));
                }
            }
        }
        ready
    };

    for (blocked_id, blocker_branches) in ready_dependents {
        match start_dormant_task_if_ready_with_daemon(state, daemon, &blocked_id, blocker_branches)
            .await
        {
            Ok(true) => {
                log::info!(
                    "started dependent task {blocked_id} unblocked by close of {blocker_task_id}"
                );
            }
            Ok(false) => {}
            Err((_, error)) => {
                log::error!(
                    "failed to start dependent task {blocked_id} unblocked by close of {blocker_task_id}: {error}"
                );
            }
        }
    }
}

pub(super) async fn block_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::BlockTaskRequest>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = apply_task_blockers(&db, &task_id, &payload.blocker_task_ids)?;
    state.publish_state_changed(StateChangeScope::Blockers);
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
    }))
}

pub(super) async fn unblock_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = resolve_existing_task_id(&db, &task_id)?;
    let blocker_branches = blocker_branches_for_task(&db, &task_id)?;
    db.remove_all_task_blockers(&task_id)
        .map_err(|e| db_write_error("db error", e))?;
    drop(db);
    start_dormant_task_if_ready(&state, &task_id, blocker_branches).await?;
    state.publish_state_changed(StateChangeScope::Blockers);
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
    }))
}
