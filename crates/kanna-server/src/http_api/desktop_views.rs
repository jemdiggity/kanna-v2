//! "Show this in the desktop" commands.
//!
//! An agent working inside a task can already read a file; what it could not
//! do was put one in front of the person watching that task. This lane closes
//! that gap: `POST /v1/desktop/views/open` records the request, the desktop
//! long-polls `GET /v1/desktop/view-commands` and opens the view as a tab in
//! the task's main content area.
//!
//! The request is advisory, and the response says so. Nothing about the task
//! changes, no row is written, and a window that is closed or not listening
//! loses the request rather than queuing it forever — which is the honest
//! shape for "please look at this", unlike a delivered task input, which is a
//! durable instruction.

use super::lan_trust::{DesktopLocalAccess, PrivilegedTaskAccess};
use super::state::AppState;
use crate::db::Db;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const DEFAULT_EVENT_LIMIT: usize = 100;
const MAX_EVENT_LIMIT: usize = 500;
const DEFAULT_WAIT_TIMEOUT_SECS: u64 = 25;
const MAX_WAIT_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OpenDesktopViewRequest {
    task_id: String,
    path: String,
    #[serde(default)]
    line: Option<u32>,
}

pub(super) async fn open_desktop_view(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    Json(request): Json<OpenDesktopViewRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let task_id = request.task_id.clone();
    let path = request.path.clone();
    let line = request.line;

    // Resolving the file here is what makes a mistyped path an error the agent
    // can act on instead of a window that quietly opens nothing. It is the
    // same resolution `/v1/tasks/{id}/files/content` performs, so a path
    // outside the task's workspace, a missing file, an oversized one, or one
    // the viewer could not render is refused before anything is queued. The
    // content it reads on the way is discarded: the desktop opens the file
    // from the worktree itself.
    let resolved_path = super::blocking::run_handler_blocking("desktop view open", {
        let task_id = task_id.clone();
        let path = path.clone();
        move || {
            let db = Db::open(&state.config().db_path).map_err(|error| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {error}"),
                )
            })?;
            let file = crate::task_files::read_task_file(&db, &task_id, &path)
                .map_err(super::task_files::map_task_file_error)?;
            state.desktop_view_commands().append(json!({
                "type": "desktop_view_open",
                "view": "file",
                "taskId": task_id,
                "path": file.path,
                "line": line,
            }));
            Ok(file.path)
        }
    })
    .await?;

    Ok(Json(json!({
        // Requested, not shown: this asks whichever desktop window is watching
        // the task to open the view. It is never a promise that one did.
        "requested": true,
        "view": "file",
        "taskId": task_id,
        "path": resolved_path,
        "line": line,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DesktopViewCommandsQuery {
    cursor: Option<u64>,
    stream_id: Option<String>,
    limit: Option<usize>,
    timeout_secs: Option<u64>,
}

/// Long-poll the desktop view command lane. Same cursor/streamId contract as
/// the transfer advisory lanes: a cursor is only meaningful inside the server
/// incarnation that issued it, and reading through one prunes it.
pub(super) async fn wait_desktop_view_commands(
    _access: DesktopLocalAccess,
    State(state): State<Arc<AppState>>,
    Query(query): Query<DesktopViewCommandsQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_EVENT_LIMIT)
        .clamp(1, MAX_EVENT_LIMIT);
    let timeout_secs = query
        .timeout_secs
        .unwrap_or(DEFAULT_WAIT_TIMEOUT_SECS)
        .clamp(1, MAX_WAIT_TIMEOUT_SECS);
    let batch = state
        .desktop_view_commands()
        .wait_for_events(
            query.cursor,
            query.stream_id.as_deref(),
            limit,
            Duration::from_secs(timeout_secs),
        )
        .await;
    Ok(Json(json!({
        "waitOutcome": if batch.events.is_empty() { "timeout" } else { "events" },
        "cursor": batch.cursor,
        "streamId": batch.stream_id,
        "events": batch.events,
        "hasMore": batch.has_more,
        "missedEvents": batch.missed_events,
    })))
}
