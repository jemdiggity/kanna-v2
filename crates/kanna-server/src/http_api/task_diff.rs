use super::lan_trust::TrustedLanDeviceAccess;
use super::state::{AppState, TunneledHttpInvoke};
use super::task_files::AuthenticatedTaskFileAccess;
use crate::db::Db;
use crate::task_diff::{TaskDiff, TaskDiffError, TaskDiffRequest};
use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use std::net::SocketAddr;
use std::sync::Arc;

#[derive(Debug, serde::Deserialize)]
pub(super) struct TaskDiffQuery {
    scope: Option<String>,
    mode: Option<String>,
}

pub(super) async fn get_task_diff(
    State(state): State<Arc<AppState>>,
    relay_access: Option<Extension<AuthenticatedTaskFileAccess>>,
    lan_access: Option<Extension<TrustedLanDeviceAccess>>,
    tunneled: Option<Extension<TunneledHttpInvoke>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Path(task_id): Path<String>,
    Query(query): Query<TaskDiffQuery>,
) -> Result<Json<TaskDiff>, (StatusCode, String)> {
    let desktop_local = tunneled.is_none()
        && peer.is_some_and(|Extension(ConnectInfo(addr))| addr.ip().is_loopback());
    if relay_access.is_none() && lan_access.is_none() && !desktop_local {
        return Err((
            StatusCode::UNAUTHORIZED,
            "task diff requires an authenticated relay or a paired device".to_string(),
        ));
    }

    let request = TaskDiffRequest::parse(query.scope.as_deref(), query.mode.as_deref())
        .map_err(map_task_diff_error)?;

    // Reading a task diff shells out to git against the task worktree —
    // seconds of synchronous work on large branches that must not occupy a
    // runtime worker.
    super::blocking::run_handler_blocking("task diff read", move || {
        let db = Db::open(&state.config().db_path).map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {error}"),
            )
        })?;

        crate::task_diff::read_task_diff(&db, &task_id, request)
            .map(Json)
            .map_err(map_task_diff_error)
    })
    .await
}

fn map_task_diff_error(error: TaskDiffError) -> (StatusCode, String) {
    let status = match &error {
        TaskDiffError::InvalidRequest(_) => StatusCode::BAD_REQUEST,
        TaskDiffError::TaskNotFound => StatusCode::NOT_FOUND,
        TaskDiffError::WorkspaceUnavailable => StatusCode::CONFLICT,
        TaskDiffError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, error.to_string())
}
