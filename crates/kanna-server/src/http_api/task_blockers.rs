use super::state::{db_write_error, AppState};
use crate::db::Db;
use axum::extract::State;
use axum::Json;
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
    for blocker_id in resolved_blocker_ids {
        db.insert_task_blocker(task_id, blocker_id)
            .map_err(|e| db_write_error("db error", e))?;
    }
    db.update_pipeline_item_activity(task_id, "idle")
        .map_err(|e| db_write_error("db error", e))
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

pub(super) async fn start_dormant_task_if_ready(
    state: &Arc<AppState>,
    task_id: &str,
    blocker_branches: Vec<String>,
) -> Result<bool, (axum::http::StatusCode, String)> {
    let prepared = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        crate::task_creator::prepare_start_dormant_task_for_api(
            &db,
            &state.config,
            task_id,
            blocker_branches,
        )
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    };
    let Some(prepared) = prepared else {
        return Ok(false);
    };

    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    crate::task_creator::spawn_prepared_task_for_api_recording_stage_run(
        &state.config.db_path,
        &mut daemon,
        prepared,
    )
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(true)
}

pub(super) async fn start_dependents_unblocked_by_pr(
    state: &Arc<AppState>,
    blocker_task_id: &str,
    blocker_branch: Option<String>,
) -> Result<(), (axum::http::StatusCode, String)> {
    let ready_dependents = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        let mut ready = Vec::new();
        for blocked_id in db
            .list_tasks_blocked_by(blocker_task_id)
            .map_err(|e| db_write_error("db error", e))?
        {
            if db
                .task_has_unresolved_blockers_except(&blocked_id, blocker_task_id)
                .map_err(|e| db_write_error("db error", e))?
            {
                continue;
            }
            let mut branches = Vec::new();
            if let Some(branch) = blocker_branch
                .clone()
                .filter(|branch| !branch.trim().is_empty())
            {
                branches.push(branch);
            }
            for branch in db
                .list_resolved_blocker_branches_for_task(&blocked_id)
                .map_err(|e| db_write_error("db error", e))?
            {
                if !branches.contains(&branch) {
                    branches.push(branch);
                }
            }
            ready.push((blocked_id, branches));
        }
        ready
    };

    for (blocked_id, branches) in ready_dependents {
        start_dormant_task_if_ready(state, &blocked_id, branches).await?;
    }
    Ok(())
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
    db.remove_all_task_blockers(&task_id)
        .map_err(|e| db_write_error("db error", e))?;
    drop(db);
    start_dormant_task_if_ready(&state, &task_id, Vec::new()).await?;
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
    }))
}
