use super::state::AppState;
use crate::db::Db;
use crate::task_files::{
    TaskFileContent, TaskFileError, TaskFileMention, TaskFileMentionResolution,
};
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
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
    access: Option<Extension<AuthenticatedTaskFileAccess>>,
    Path(task_id): Path<String>,
    Query(query): Query<TaskFileQuery>,
) -> Result<Json<TaskFileContent>, (StatusCode, String)> {
    require_authenticated_task_file_access(access)?;
    let db = open_db(&state)?;

    crate::task_files::read_task_file(&db, &task_id, &query.path)
        .map(Json)
        .map_err(map_task_file_error)
}

pub(super) async fn resolve_task_file_mentions(
    State(state): State<Arc<AppState>>,
    access: Option<Extension<AuthenticatedTaskFileAccess>>,
    Path(task_id): Path<String>,
    Json(request): Json<ResolveTaskFileMentionsRequest>,
) -> Result<Json<TaskFileMentionResolution>, (StatusCode, String)> {
    require_authenticated_task_file_access(access)?;
    let db = open_db(&state)?;

    crate::task_files::resolve_task_file_mentions(&db, &task_id, request.mentions)
        .map(Json)
        .map_err(map_task_file_error)
}

fn require_authenticated_task_file_access(
    access: Option<Extension<AuthenticatedTaskFileAccess>>,
) -> Result<(), (StatusCode, String)> {
    if access.is_some() {
        return Ok(());
    }
    Err((
        StatusCode::UNAUTHORIZED,
        "task file preview requires an authenticated relay".to_string(),
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

fn map_task_file_error(error: TaskFileError) -> (StatusCode, String) {
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
