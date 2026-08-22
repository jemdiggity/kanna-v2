use super::lan_trust::TrustedLanDeviceAccess;
use super::state::AppState;
use super::task_files::AuthenticatedTaskFileAccess;
use crate::db::Db;
use crate::repo_browser::{BrowseError, DirectoryListing, FileRange};
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use std::sync::Arc;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DirectoryQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    show_all_files: bool,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_page_size")]
    limit: usize,
    filter: Option<String>,
}
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileQuery {
    path: String,
    #[serde(default)]
    start_line: usize,
    #[serde(default)]
    start_byte: usize,
    #[serde(default = "default_page_size")]
    line_count: usize,
    #[serde(default)]
    metadata_only: bool,
}
fn default_page_size() -> usize {
    60
}

pub(super) async fn list_task_directory(
    State(state): State<Arc<AppState>>,
    relay: Option<Extension<AuthenticatedTaskFileAccess>>,
    lan: Option<Extension<TrustedLanDeviceAccess>>,
    Path(task_id): Path<String>,
    Query(query): Query<DirectoryQuery>,
) -> Result<Json<DirectoryListing>, (StatusCode, String)> {
    require_access(relay, lan)?;
    super::blocking::run_handler_blocking("task directory browse", move || {
        let db = open_db(&state)?;
        let root = crate::repo_browser::task_root(&db, &task_id).map_err(map_error)?;
        crate::repo_browser::list_directory(
            &root,
            &query.path,
            query.show_all_files,
            query.offset,
            query.limit,
            query.filter.as_deref(),
        )
        .map(Json)
        .map_err(map_error)
    })
    .await
}

pub(super) async fn read_task_file_range(
    State(state): State<Arc<AppState>>,
    relay: Option<Extension<AuthenticatedTaskFileAccess>>,
    lan: Option<Extension<TrustedLanDeviceAccess>>,
    Path(task_id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<Json<FileRange>, (StatusCode, String)> {
    require_access(relay, lan)?;
    super::blocking::run_handler_blocking("task file range browse", move || {
        let db = open_db(&state)?;
        let root = crate::repo_browser::task_root(&db, &task_id).map_err(map_error)?;
        crate::repo_browser::read_file_range(
            &root,
            &query.path,
            query.start_line,
            query.start_byte,
            query.line_count,
            query.metadata_only,
        )
        .map(Json)
        .map_err(map_error)
    })
    .await
}

fn require_access(
    relay: Option<Extension<AuthenticatedTaskFileAccess>>,
    lan: Option<Extension<TrustedLanDeviceAccess>>,
) -> Result<(), (StatusCode, String)> {
    if relay.is_some() || lan.is_some() {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            "file browsing requires an authenticated relay or a paired device".into(),
        ))
    }
}
fn open_db(state: &AppState) -> Result<Db, (StatusCode, String)> {
    Db::open(&state.config().db_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("db error: {e}")))
}
fn map_error(error: BrowseError) -> (StatusCode, String) {
    let status = match error {
        BrowseError::InvalidPath | BrowseError::NotFile => StatusCode::BAD_REQUEST,
        BrowseError::RootNotFound | BrowseError::TargetNotFound => StatusCode::NOT_FOUND,
        BrowseError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, error.to_string())
}
