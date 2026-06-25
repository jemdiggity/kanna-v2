use super::state::{db_write_error, AppState};
use crate::db::Db;
use axum::extract::State;
use axum::Json;
use std::sync::Arc;

fn parse_tags_json(tags_json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(tags_json).unwrap_or_default()
}

fn render_tags_json(tags: &[String]) -> Result<String, (axum::http::StatusCode, String)> {
    serde_json::to_string(tags).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to serialize tags: {}", e),
        )
    })
}

fn add_blocked_tag(db: &Db, task_id: &str) -> Result<(), (axum::http::StatusCode, String)> {
    let tags_json = db
        .pipeline_item_tags(task_id)
        .map_err(|e| db_write_error("db error", e))?;
    let mut tags = parse_tags_json(&tags_json);
    if !tags.iter().any(|tag| tag == "blocked") {
        tags.push("blocked".to_string());
    }
    let rendered = render_tags_json(&tags)?;
    db.update_pipeline_item_tags(task_id, &rendered)
        .map_err(|e| db_write_error("db error", e))
}

fn remove_blocked_tag(db: &Db, task_id: &str) -> Result<(), (axum::http::StatusCode, String)> {
    let tags_json = db
        .pipeline_item_tags(task_id)
        .map_err(|e| db_write_error("db error", e))?;
    let tags = parse_tags_json(&tags_json)
        .into_iter()
        .filter(|tag| tag != "blocked")
        .collect::<Vec<_>>();
    let rendered = render_tags_json(&tags)?;
    db.update_pipeline_item_tags(task_id, &rendered)
        .map_err(|e| db_write_error("db error", e))
}

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
    add_blocked_tag(db, task_id)?;
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
    Ok(Json(crate::mobile_api::TaskActionResponse { task_id }))
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
    remove_blocked_tag(&db, &task_id)?;
    Ok(Json(crate::mobile_api::TaskActionResponse { task_id }))
}
