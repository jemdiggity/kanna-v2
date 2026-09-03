use super::state::{db_write_error, AppState};
use super::task_blockers::resolve_existing_task_id;
use crate::db::Db;
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeStatusRequest {
    status: String,
    selected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskActivityResponse {
    task_id: String,
    activity: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MarkTaskReadRequest {
    expected_activity_revision: Option<i64>,
}

pub(crate) fn activity_for_runtime_status(
    current_activity: Option<&str>,
    status: &str,
    selected: bool,
) -> Option<&'static str> {
    match status {
        "busy" => {
            if current_activity == Some("working") {
                None
            } else {
                Some("working")
            }
        }
        "idle" | "waiting" => match (selected, current_activity) {
            (true, Some("working" | "unread")) => Some("idle"),
            (false, Some("working")) => Some("unread"),
            _ => None,
        },
        _ => None,
    }
}

pub(super) async fn apply_runtime_status(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
    Json(payload): Json<RuntimeStatusRequest>,
) -> Result<Json<TaskActivityResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = resolve_existing_task_id(&db, &task_id)?;
    let item = db
        .get_pipeline_item(&task_id)
        .map_err(|e| db_write_error("db error", e))?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {task_id}"),
            )
        })?;
    if item.closed_at.is_some() {
        return Ok(Json(TaskActivityResponse {
            task_id,
            activity: None,
        }));
    }

    // The attached desktop reports the same daemon-derived status the terminal
    // watcher sees; record it so the event feed does not depend on which
    // observer got there first.
    let mut changed = db
        .update_pipeline_item_runtime_status(
            &task_id,
            payload.status.as_str(),
            item.last_output_preview.as_deref(),
        )
        .map_err(|e| db_write_error("db error", e))?;

    let activity = activity_for_runtime_status(
        item.activity.as_deref(),
        payload.status.as_str(),
        payload.selected,
    );

    if let Some(activity) = activity {
        db.update_pipeline_item_activity(&task_id, activity)
            .map_err(|e| db_write_error("db error", e))?;
        changed = true;
    }
    if changed {
        state.publish_task_state_changed(&task_id);
    }
    Ok(Json(TaskActivityResponse {
        task_id,
        activity: activity.map(str::to_string),
    }))
}

pub(super) async fn mark_task_read(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
    payload: Option<Json<MarkTaskReadRequest>>,
) -> Result<Json<TaskActivityResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = resolve_existing_task_id(&db, &task_id)?;
    let item = db
        .get_pipeline_item(&task_id)
        .map_err(|e| db_write_error("db error", e))?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {task_id}"),
            )
        })?;
    if item.closed_at.is_some() || item.activity.as_deref() != Some("unread") {
        return Ok(Json(TaskActivityResponse {
            task_id,
            activity: None,
        }));
    }

    let expected_activity_revision = payload
        .as_ref()
        .and_then(|Json(payload)| payload.expected_activity_revision);
    let marked_read = db
        .mark_pipeline_item_read_if_unchanged(&task_id, expected_activity_revision)
        .map_err(|e| db_write_error("db error", e))?;
    if !marked_read {
        return Ok(Json(TaskActivityResponse {
            task_id,
            activity: None,
        }));
    }
    state.publish_task_state_changed(&task_id);
    Ok(Json(TaskActivityResponse {
        task_id,
        activity: Some("idle".to_string()),
    }))
}

#[cfg(test)]
mod tests {
    use super::activity_for_runtime_status;

    #[test]
    fn selected_idle_repairs_unread_to_idle() {
        assert_eq!(
            activity_for_runtime_status(Some("unread"), "idle", true),
            Some("idle")
        );
    }

    #[test]
    fn selected_waiting_repairs_unread_to_idle() {
        assert_eq!(
            activity_for_runtime_status(Some("unread"), "waiting", true),
            Some("idle")
        );
    }

    #[test]
    fn unselected_idle_or_waiting_does_not_rewrite_unread() {
        for status in ["idle", "waiting"] {
            assert_eq!(
                activity_for_runtime_status(Some("unread"), status, false),
                None,
                "status={status}"
            );
        }
    }

    #[test]
    fn busy_transitions_are_selection_independent() {
        for selected in [false, true] {
            for current in [None, Some("idle"), Some("unread")] {
                assert_eq!(
                    activity_for_runtime_status(current, "busy", selected),
                    Some("working"),
                    "current={current:?} selected={selected}"
                );
            }
            assert_eq!(
                activity_for_runtime_status(Some("working"), "busy", selected),
                None
            );
        }
    }
}
