use super::lan_trust::TrustedLanDeviceAccess;
use super::state::{AppState, TunneledHttpInvoke};
use crate::db::Db;
use crate::task_files::{
    TaskFileContent, TaskFileError, TaskFileMention, TaskFileMentionResolution,
};
use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use std::net::SocketAddr;
use std::sync::Arc;

#[derive(Debug, serde::Deserialize)]
pub(super) struct TaskFileQuery {
    path: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResolveTaskFileMentionsRequest {
    mentions: Vec<TaskFileMention>,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct AuthenticatedTaskFileAccess;

pub(super) async fn get_task_file(
    State(state): State<Arc<AppState>>,
    relay: Option<Extension<AuthenticatedTaskFileAccess>>,
    lan: Option<Extension<TrustedLanDeviceAccess>>,
    tunneled: Option<Extension<TunneledHttpInvoke>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Path(task_id): Path<String>,
    Query(query): Query<TaskFileQuery>,
) -> Result<Json<TaskFileContent>, (StatusCode, String)> {
    require_task_file_access(relay, lan, tunneled, peer)?;

    let db = open_db(&state)?;

    crate::task_files::read_task_file(&db, &task_id, &query.path)
        .map(Json)
        .map_err(map_task_file_error)
}

pub(super) async fn resolve_task_file_mentions(
    State(state): State<Arc<AppState>>,
    relay: Option<Extension<AuthenticatedTaskFileAccess>>,
    lan: Option<Extension<TrustedLanDeviceAccess>>,
    tunneled: Option<Extension<TunneledHttpInvoke>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Path(task_id): Path<String>,
    Json(request): Json<ResolveTaskFileMentionsRequest>,
) -> Result<Json<TaskFileMentionResolution>, (StatusCode, String)> {
    require_task_file_access(relay, lan, tunneled, peer)?;

    super::blocking::run_handler_blocking("task file mention resolution", move || {
        resolve_task_file_mentions_sync(&state, &task_id, request.mentions)
    })
    .await
}

fn resolve_task_file_mentions_sync(
    state: &AppState,
    task_id: &str,
    mentions: Vec<TaskFileMention>,
) -> Result<Json<TaskFileMentionResolution>, (StatusCode, String)> {
    #[cfg(test)]
    if let Some(hook) = &state.task_file_resolution_hook {
        hook();
    }

    let db = open_db(state)?;
    crate::task_files::resolve_task_file_mentions(&db, task_id, mentions)
        .map(Json)
        .map_err(map_task_file_error)
}

fn require_task_file_access(
    relay: Option<Extension<AuthenticatedTaskFileAccess>>,
    lan: Option<Extension<TrustedLanDeviceAccess>>,
    tunneled: Option<Extension<TunneledHttpInvoke>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
) -> Result<(), (StatusCode, String)> {
    let desktop_local = tunneled.is_none()
        && peer.is_some_and(|Extension(ConnectInfo(addr))| addr.ip().is_loopback());
    if relay.is_some() || lan.is_some() || desktop_local {
        return Ok(());
    }
    Err((
        StatusCode::UNAUTHORIZED,
        "task file preview requires an authenticated relay, a paired device, or the local desktop"
            .to_string(),
    ))
}

fn open_db(state: &AppState) -> Result<Db, (StatusCode, String)> {
    Db::open(&state.config().db_path).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {error}"),
        )
    })
}

pub(super) fn map_task_file_error(error: TaskFileError) -> (StatusCode, String) {
    let status = match &error {
        TaskFileError::InvalidPath(_) => StatusCode::BAD_REQUEST,
        TaskFileError::TaskNotFound | TaskFileError::FileNotFound => StatusCode::NOT_FOUND,
        TaskFileError::WorkspaceUnavailable => StatusCode::CONFLICT,
        TaskFileError::RequestTooLarge | TaskFileError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        TaskFileError::UnsupportedContent => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        TaskFileError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, error.to_string())
}
