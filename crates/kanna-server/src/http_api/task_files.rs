use super::state::{AppState, TunneledHttpInvoke};
use crate::db::Db;
use crate::task_files::{TaskFileContent, TaskFileError};
use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use std::net::SocketAddr;
use std::sync::Arc;

#[derive(Debug, serde::Deserialize)]
pub(super) struct TaskFileQuery {
    path: String,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct AuthenticatedTaskFileAccess;

pub(super) async fn get_task_file(
    State(state): State<Arc<AppState>>,
    access: Option<Extension<AuthenticatedTaskFileAccess>>,
    tunneled: Option<Extension<TunneledHttpInvoke>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Path(task_id): Path<String>,
    Query(query): Query<TaskFileQuery>,
) -> Result<Json<TaskFileContent>, (StatusCode, String)> {
    // Desktop-local processes (the app and its transfer sidecar) reach the
    // server over the real loopback listener and carry no tunnel marker;
    // relay/KSP dispatches synthesize a loopback peer but are marked tunneled.
    let desktop_local = tunneled.is_none()
        && peer.is_some_and(|Extension(ConnectInfo(addr))| addr.ip().is_loopback());
    if access.is_none() && !desktop_local {
        return Err((
            StatusCode::UNAUTHORIZED,
            "task file preview requires an authenticated relay or the local desktop".to_string(),
        ));
    }

    let db = Db::open(&state.config().db_path).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {error}"),
        )
    })?;

    crate::task_files::read_task_file(&db, &task_id, &query.path)
        .map(Json)
        .map_err(map_task_file_error)
}

fn map_task_file_error(error: TaskFileError) -> (StatusCode, String) {
    let status = match &error {
        TaskFileError::InvalidPath(_) => StatusCode::BAD_REQUEST,
        TaskFileError::TaskNotFound | TaskFileError::FileNotFound => StatusCode::NOT_FOUND,
        TaskFileError::WorkspaceUnavailable => StatusCode::CONFLICT,
        TaskFileError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        TaskFileError::UnsupportedContent => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        TaskFileError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, error.to_string())
}
