use super::state::AppState;
use crate::db::{Db, PipelineItem, RepoPatch};
use crate::mobile_api::MobileApi;
use axum::extract::Query;
use axum::extract::{Path, State};
use axum::Json;
use kanna_agent_protocol::{AgentProvider, StateChangeScope};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::Path as FsPath;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use super::state::RepoCheckoutOperation;

static REPO_CHECKOUT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) async fn list_repos(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::mobile_api::RepoSummary>>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let api = MobileApi::new(state.config.clone(), db);
    let repos = api
        .list_repos()
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(repos))
}

pub(super) async fn add_repo(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<crate::mobile_api::AddRepoRequest>,
) -> Result<Json<crate::mobile_api::RepoDetail>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let api = MobileApi::new(state.config.clone(), db);
    let repo = api.add_repo(payload).map_err(|e| {
        let status = match &e {
            crate::mobile_api::AddRepoError::InvalidPath(_) => axum::http::StatusCode::BAD_REQUEST,
            crate::mobile_api::AddRepoError::DuplicatePath => axum::http::StatusCode::CONFLICT,
            crate::mobile_api::AddRepoError::Internal(_) => {
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        (status, e.message())
    })?;
    state.publish_state_changed(StateChangeScope::Repos);
    Ok(Json(repo))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StartRepoCheckoutRequest {
    name: String,
    remote_url: String,
    remote_url_hash: String,
}

pub(super) async fn start_repo_checkout(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<StartRepoCheckoutRequest>,
) -> Result<Json<RepoCheckoutOperation>, (axum::http::StatusCode, String)> {
    let name = payload.name.trim().to_string();
    let remote_url = payload.remote_url.trim().to_string();
    let remote_url_hash = payload.remote_url_hash.trim().to_lowercase();
    if name.is_empty() || remote_url.is_empty() || remote_url_hash.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "name, remoteUrl, and remoteUrlHash are required".to_string(),
        ));
    }
    if !crate::transfer_engine::git::is_credential_free_clone_source(&remote_url) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            credential_free_origin_error(&state.config.desktop_name),
        ));
    }
    let actual_hash = format!("{:x}", Sha256::digest(remote_url.as_bytes()));
    if actual_hash != remote_url_hash {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "remoteUrl does not match remoteUrlHash".to_string(),
        ));
    }

    let db = Db::open(&state.config.db_path).map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {error}"),
        )
    })?;
    if let Some(repo) = db
        .list_repos_for_maintenance()
        .map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {error}"),
            )
        })?
        .into_iter()
        .find(|repo| repo.remote_url_hash.as_deref() == Some(remote_url_hash.as_str()))
    {
        return Ok(Json(RepoCheckoutOperation {
            id: new_repo_checkout_id(),
            state: "done",
            repo_name: repo.name,
            remote_url_hash,
            repo_id: Some(repo.id),
            error: None,
        }));
    }

    let operation = {
        let mut operations = state
            .repo_checkouts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = operations
            .values()
            .find(|operation| {
                operation.remote_url_hash == remote_url_hash && operation.state == "running"
            })
            .cloned()
        {
            return Ok(Json(existing));
        }
        let operation = RepoCheckoutOperation {
            id: new_repo_checkout_id(),
            state: "running",
            repo_name: name.clone(),
            remote_url_hash: remote_url_hash.clone(),
            repo_id: None,
            error: None,
        };
        operations.insert(operation.id.clone(), operation.clone());
        operation
    };

    let operation_id = operation.id.clone();
    let checkout_state = Arc::clone(&state);
    tokio::spawn(async move {
        let root = checkout_state.repo_checkout_root.clone();
        let worker_state = Arc::clone(&checkout_state);
        let worker_result = tokio::task::spawn_blocking(move || {
            clone_and_register_repo(worker_state, &root, &name, &remote_url, &remote_url_hash)
        })
        .await;
        let result = match worker_result {
            Ok(Ok(repo_id)) => Ok(repo_id),
            Ok(Err(error)) => {
                log::error!("repository checkout {operation_id} failed: {error}");
                Err(credential_free_origin_error(
                    &checkout_state.config.desktop_name,
                ))
            }
            Err(error) => {
                log::error!("repository checkout {operation_id} worker failed: {error}");
                Err(credential_free_origin_error(
                    &checkout_state.config.desktop_name,
                ))
            }
        };

        let mut operations = checkout_state
            .repo_checkouts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(stored) = operations.get_mut(&operation_id) {
            match result {
                Ok(repo_id) => {
                    stored.state = "done";
                    stored.repo_id = Some(repo_id);
                    checkout_state.publish_state_changed(StateChangeScope::Repos);
                }
                Err(error) => {
                    stored.state = "failed";
                    stored.error = Some(error);
                }
            }
        }
    });

    Ok(Json(operation))
}

pub(super) async fn get_repo_checkout(
    State(state): State<Arc<AppState>>,
    Path(operation_id): Path<String>,
) -> Result<Json<RepoCheckoutOperation>, (axum::http::StatusCode, String)> {
    state
        .repo_checkouts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&operation_id)
        .cloned()
        .map(Json)
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("repository checkout not found: {operation_id}"),
            )
        })
}

fn new_repo_checkout_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = REPO_CHECKOUT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("checkout-{nanos:x}-{sequence:x}")
}

fn clone_and_register_repo(
    state: Arc<AppState>,
    root: &FsPath,
    name: &str,
    remote_url: &str,
    remote_url_hash: &str,
) -> Result<String, String> {
    let destination = crate::transfer_engine::git::allocate_repo_path(root, name)?;
    if crate::transfer_engine::git::clone_remote(remote_url, &destination).is_err() {
        return Err(cleanup_checkout_error(
            &destination,
            credential_free_origin_error(&state.config.desktop_name),
        ));
    }

    let db = Db::open(&state.config.db_path)
        .map_err(|error| cleanup_checkout_error(&destination, format!("db error: {error}")))?;
    let api = MobileApi::new(state.config.clone(), db);
    let path = destination.to_string_lossy().to_string();
    let repo = match api.add_repo(crate::mobile_api::AddRepoRequest {
        path,
        name: Some(name.to_string()),
        default_branch: None,
    }) {
        Ok(repo) => repo,
        Err(error) => return Err(cleanup_checkout_error(&destination, error.message())),
    };

    let db = Db::open(&state.config.db_path).map_err(|error| {
        rollback_registered_checkout(
            &state.config.db_path,
            &repo.id,
            &destination,
            format!("db error: {error}"),
        )
    })?;
    if let Err(error) = db.patch_repo(
        &repo.id,
        RepoPatch {
            remote_url: Some(Some(remote_url)),
            remote_url_hash: Some(Some(remote_url_hash)),
            ..RepoPatch::default()
        },
    ) {
        return Err(rollback_registered_checkout(
            &state.config.db_path,
            &repo.id,
            &destination,
            format!("could not persist repository remote metadata: {error}"),
        ));
    }
    Ok(repo.id)
}

fn credential_free_origin_error(desktop_name: &str) -> String {
    format!(
        "Could not check out the repository on {desktop_name}. Configure a credential-free origin and git credentials on {desktop_name}, then try again."
    )
}

fn rollback_registered_checkout(
    db_path: &str,
    repo_id: &str,
    destination: &FsPath,
    error: String,
) -> String {
    let rollback_error = Db::open(db_path)
        .and_then(|db| db.delete_repo(repo_id))
        .err()
        .map(|rollback| format!("; registry rollback failed: {rollback}"))
        .unwrap_or_default();
    format!(
        "{}{}",
        cleanup_checkout_error(destination, error),
        rollback_error
    )
}

fn cleanup_checkout_error(destination: &FsPath, error: String) -> String {
    match std::fs::remove_dir_all(destination) {
        Ok(()) => error,
        Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => error,
        Err(cleanup) => format!(
            "{error}; checkout cleanup failed for {}: {cleanup}",
            destination.display()
        ),
    }
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct RepoByPathQuery {
    path: String,
}

pub(super) async fn get_repo_by_path(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RepoByPathQuery>,
) -> Result<Json<crate::db::SnapshotRepo>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let mut candidate_paths = vec![query.path.clone()];
    if let Ok(canonical) = std::fs::canonicalize(&query.path) {
        let canonical = canonical.to_string_lossy().to_string();
        if !candidate_paths.iter().any(|path| path == &canonical) {
            candidate_paths.push(canonical);
        }
    }

    for path in &candidate_paths {
        if let Some(repo) = db.get_snapshot_repo_by_path(path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {e}"),
            )
        })? {
            return Ok(Json(repo));
        }
    }

    Err((
        axum::http::StatusCode::NOT_FOUND,
        format!("repo not found for path: {}", query.path),
    ))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PatchRepoRequest {
    name: Option<String>,
    #[serde(default)]
    remote_url: Option<Option<String>>,
    #[serde(default)]
    remote_url_hash: Option<Option<String>>,
    hidden: Option<bool>,
    default_branch: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PatchRepoResponse {
    repo_id: String,
}

pub(super) async fn patch_repo(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<String>,
    Json(payload): Json<PatchRepoRequest>,
) -> Result<Json<PatchRepoResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let default_branch = payload
        .default_branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty());
    if payload.default_branch.is_some() && default_branch.is_none() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "defaultBranch must not be blank".to_string(),
        ));
    }
    db.patch_repo(
        &repo_id,
        RepoPatch {
            name: payload.name.as_deref(),
            remote_url: payload.remote_url.as_ref().map(|value| value.as_deref()),
            remote_url_hash: payload
                .remote_url_hash
                .as_ref()
                .map(|value| value.as_deref()),
            hidden: payload.hidden,
            default_branch,
            default_branch_source: default_branch.map(|_| "api_update"),
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => (
            axum::http::StatusCode::NOT_FOUND,
            format!("repo not found: {repo_id}"),
        ),
        e => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {e}"),
        ),
    })?;
    state.publish_state_changed(StateChangeScope::Repos);
    Ok(Json(PatchRepoResponse { repo_id }))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReconcileRepoMetadataRequest {
    #[serde(default = "default_true")]
    apply: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReconcileRepoMetadataResponse {
    repo_id: String,
    recorded_default_branch: Option<String>,
    recorded_default_branch_source: Option<String>,
    detected_default_branch: String,
    detected_default_branch_source: String,
    drift: bool,
    updated: bool,
}

pub(super) async fn reconcile_repo_metadata(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<String>,
    Json(payload): Json<ReconcileRepoMetadataRequest>,
) -> Result<Json<ReconcileRepoMetadataResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {error}"),
        )
    })?;
    let repo = db
        .get_repo(&repo_id)
        .map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {error}"),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("repo not found: {repo_id}"),
            )
        })?;
    let detected =
        crate::mobile_api::resolve_git_default_branch(std::path::Path::new(&repo.path), None)
            .map_err(|error| (axum::http::StatusCode::BAD_GATEWAY, error))?;
    let drift = repo.default_branch.as_deref() != Some(detected.branch.as_str());
    let updated = payload.apply
        && (drift || repo.default_branch_source.as_deref() != Some(detected.source.as_str()));
    if updated {
        db.patch_repo(
            &repo_id,
            RepoPatch {
                default_branch: Some(&detected.branch),
                default_branch_source: Some(&detected.source),
                ..RepoPatch::default()
            },
        )
        .map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {error}"),
            )
        })?;
        state.repo_definitions.invalidate(&repo);
        state.publish_state_changed(StateChangeScope::Repos);
        log::info!(
            "reconciled repository `{repo_id}` default branch from `{:?}` (source: {:?}) to `{}` (source: {})",
            repo.default_branch,
            repo.default_branch_source,
            detected.branch,
            detected.source,
        );
    }
    Ok(Json(ReconcileRepoMetadataResponse {
        repo_id,
        recorded_default_branch: repo.default_branch,
        recorded_default_branch_source: repo.default_branch_source,
        detected_default_branch: detected.branch,
        detected_default_branch_source: detected.source,
        drift,
        updated,
    }))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReorderReposRequest {
    #[serde(default)]
    ordered_ids: Vec<String>,
    #[serde(default)]
    ordered_repos: Vec<ReorderRepoInput>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderRepoInput {
    id: String,
    remote_url_hash: Option<String>,
}

pub(super) async fn reorder_repos(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ReorderReposRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let ordered_repos = if payload.ordered_repos.is_empty() {
        payload
            .ordered_ids
            .iter()
            .map(|id| crate::db::RepoOrderInput {
                id,
                remote_url_hash: None,
            })
            .collect::<Vec<_>>()
    } else {
        payload
            .ordered_repos
            .iter()
            .map(|repo| crate::db::RepoOrderInput {
                id: &repo.id,
                remote_url_hash: repo.remote_url_hash.as_deref(),
            })
            .collect::<Vec<_>>()
    };
    let result = db.reorder_repos(&ordered_repos).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {e}"),
        )
    })?;
    state.publish_state_changed(StateChangeScope::Repos);
    Ok(Json(serde_json::json!({
        "updated": result.updated_ids.len(),
        "updatedIds": result.updated_ids,
        "notPersistedIds": result.not_persisted_ids,
    })))
}

pub(super) async fn list_repo_tasks(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(repo_id): axum::extract::Path<String>,
) -> Result<Json<Vec<crate::mobile_api::TaskSummary>>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    if crate::mobile_api::record_orphaned_initialized_tasks(&db)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    {
        state.publish_state_changed(StateChangeScope::Tasks);
    }
    let api = MobileApi::new(state.config.clone(), db);
    let tasks = api
        .list_repo_tasks(&repo_id)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(tasks))
}

/// How many distinct recently-used workflows to report. The caller keeps the
/// first name its repo still offers, so a handful is enough to stay useful
/// after a workflow is renamed or dropped from `.kanna/workflows`.
const RECENT_REPO_WORKFLOW_LIMIT: u32 = 10;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecentRepoWorkflowsResponse {
    workflows: Vec<String>,
    #[serde(rename = "pipelines")]
    legacy_pipelines: Vec<String>,
}

/// Workflows this repo's tasks were most recently created with, newest first.
///
/// Served straight from the durable task rows, so every writer of a task row —
/// desktop, LAN/mobile, relay — feeds it without needing to be instrumented,
/// and every reader (any window, before or after a restart) agrees.
pub(super) async fn list_recent_repo_workflows(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<String>,
) -> Result<Json<RecentRepoWorkflowsResponse>, HttpError> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let workflows = db
        .recent_repo_workflows(&repo_id, RECENT_REPO_WORKFLOW_LIMIT)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
    // Durable task rows can name a retired built-in workflow; resolve those to
    // the current name so the sticky default keeps matching what the repo
    // offers. An unknown repo (or one whose definitions cannot load) serves
    // the stored names untouched.
    let workflows = match db.get_repo(&repo_id) {
        Ok(Some(repo)) => crate::task_creator::canonicalize_recent_workflow_names(
            &state.repo_definitions,
            &repo,
            workflows,
        ),
        _ => workflows,
    };
    Ok(Json(RecentRepoWorkflowsResponse {
        legacy_pipelines: workflows.clone(),
        workflows,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AvailableAgentProvider {
    id: AgentProvider,
    executable: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AvailableAgentProvidersResponse {
    providers: Vec<AvailableAgentProvider>,
}

type HttpError = (axum::http::StatusCode, String);

fn get_definition_repo(state: &AppState, repo_id: &str) -> Result<crate::db::Repo, HttpError> {
    let db = Db::open(&state.config.db_path).map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {error}"),
        )
    })?;
    db.get_repo(repo_id)
        .map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {error}"),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("repo not found: {repo_id}"),
            )
        })
}

fn map_definition_lookup_error(error: crate::task_creator::DefinitionLookupError) -> HttpError {
    let status = match &error {
        crate::task_creator::DefinitionLookupError::InvalidName(_) => {
            axum::http::StatusCode::BAD_REQUEST
        }
        crate::task_creator::DefinitionLookupError::NotFound(_) => {
            axum::http::StatusCode::NOT_FOUND
        }
        crate::task_creator::DefinitionLookupError::Other(_) => {
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    (status, error.to_string())
}

async fn run_blocking_http<T, F>(operation: F) -> Result<T, HttpError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, HttpError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("repository definition worker failed: {error}"),
            )
        })?
}

pub(super) async fn get_repo_kanna_definitions(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<String>,
) -> Result<Json<crate::task_creator::RepoKannaDefinitions>, HttpError> {
    run_blocking_http(move || {
        let repo = get_definition_repo(&state, &repo_id)?;
        crate::task_creator::load_repo_kanna_definitions(&state.repo_definitions, &repo)
            .map_err(map_definition_lookup_error)
    })
    .await
    .map(Json)
}

/// Fetch `origin` for this repo, then answer with the definitions it now
/// resolves to. Clients call this before offering a workflow or base-branch
/// choice; it is the one definitions route allowed to wait on the network,
/// which is why nothing renders behind it.
pub(super) async fn refresh_repo_origin(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<String>,
) -> Result<Json<crate::task_creator::RepoKannaDefinitions>, HttpError> {
    run_blocking_http(move || {
        let repo = get_definition_repo(&state, &repo_id)?;
        crate::task_creator::refresh_repo_origin(&state.repo_definitions, &repo)
            .map_err(map_definition_lookup_error)
    })
    .await
    .map(Json)
}

pub(super) async fn get_repo_workflow_definition(
    State(state): State<Arc<AppState>>,
    Path((repo_id, workflow_name)): Path<(String, String)>,
) -> Result<Json<crate::task_creator::RevisionedWorkflowDefinition>, HttpError> {
    run_blocking_http(move || {
        let repo = get_definition_repo(&state, &repo_id)?;
        crate::task_creator::load_repo_workflow_definition(
            &state.repo_definitions,
            &repo,
            &workflow_name,
        )
        .map_err(map_definition_lookup_error)
    })
    .await
    .map(Json)
}

pub(super) async fn get_repo_agent_definition(
    State(state): State<Arc<AppState>>,
    Path((repo_id, agent_selector)): Path<(String, String)>,
) -> Result<Json<crate::task_creator::RevisionedAgentDefinition>, HttpError> {
    run_blocking_http(move || {
        let repo = get_definition_repo(&state, &repo_id)?;
        crate::task_creator::load_repo_agent_definition(
            &state.repo_definitions,
            &repo,
            &agent_selector,
        )
        .map_err(map_definition_lookup_error)
    })
    .await
    .map(Json)
}

pub(super) async fn list_repo_agents(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<String>,
) -> Result<Json<Vec<crate::task_creator::ResolvedAgentDefinition>>, HttpError> {
    run_blocking_http(move || {
        let repo = get_definition_repo(&state, &repo_id)?;
        crate::task_creator::list_repo_agents(&state.repo_definitions, &repo)
            .map_err(map_definition_lookup_error)
    })
    .await
    .map(Json)
}

pub(super) async fn list_available_agent_providers(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<String>,
) -> Result<Json<AvailableAgentProvidersResponse>, HttpError> {
    run_blocking_http(move || {
        let repo = get_definition_repo(&state, &repo_id)?;
        let providers =
            crate::task_creator::resolve_available_agent_providers(&state.repo_definitions, &repo)
                .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))?
                .into_iter()
                .map(|(id, executable)| AvailableAgentProvider { id, executable })
                .collect();
        Ok(AvailableAgentProvidersResponse { providers })
    })
    .await
    .map(Json)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DependentTaskInfo {
    task_id: String,
    title: String,
    branch: Option<String>,
    base_ref: Option<String>,
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DependentTasksExistResponse {
    exists: bool,
    dependent_tasks: Vec<DependentTaskInfo>,
}

pub(super) async fn dependent_tasks_exist(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<DependentTasksExistResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = db
        .resolve_pipeline_item_id(&task_id)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {task_id}"),
            )
        })?;
    let task = db
        .get_pipeline_item(&task_id)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {task_id}"),
            )
        })?;
    let repo = db
        .get_repo(&task.repo_id)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("repo not found: {}", task.repo_id),
            )
        })?;
    let branch = resolve_task_branch(&repo.path, &task).ok_or_else(|| {
        (
            axum::http::StatusCode::BAD_REQUEST,
            format!("task has no branch: {task_id}"),
        )
    })?;
    let open_items = db.list_pipeline_items(&task.repo_id).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;

    let mut dependent_tasks = Vec::new();
    let mut seen = HashSet::new();

    let dependent_ids = db.list_tasks_blocked_by(&task_id).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    for dependent_id in dependent_ids {
        let Some(dependent) = db.get_pipeline_item(&dependent_id).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?
        else {
            continue;
        };
        if dependent.closed_at.is_none() && dependent.repo_id == task.repo_id {
            push_dependent_task(&mut dependent_tasks, &mut seen, dependent, "task_blocker");
        }
    }

    for item in open_items {
        if ref_matches_branch(item.base_ref.as_deref(), &branch) {
            push_dependent_task(&mut dependent_tasks, &mut seen, item, "base_ref");
        }
    }

    Ok(Json(DependentTasksExistResponse {
        exists: !dependent_tasks.is_empty(),
        dependent_tasks,
    }))
}

fn push_dependent_task(
    dependent_tasks: &mut Vec<DependentTaskInfo>,
    seen: &mut HashSet<(String, String)>,
    item: PipelineItem,
    reason: &str,
) {
    let key = (item.id.clone(), reason.to_string());
    if !seen.insert(key) {
        return;
    }
    let title = item
        .display_name
        .clone()
        .or(item.prompt.clone())
        .unwrap_or_else(|| item.id.clone());
    dependent_tasks.push(DependentTaskInfo {
        task_id: item.id,
        title,
        branch: item.branch,
        base_ref: item.base_ref,
        reason: reason.to_string(),
    });
}

fn resolve_task_branch(repo_path: &str, item: &PipelineItem) -> Option<String> {
    let stored_branch = item.branch.as_deref();
    let live_branch =
        crate::task_creator::resolve_current_source_worktree_branch(repo_path, stored_branch);
    live_branch
        .as_deref()
        .or(stored_branch)
        .and_then(normalize_branch_ref)
}

fn ref_matches_branch(value: Option<&str>, branch: &str) -> bool {
    value
        .and_then(normalize_branch_ref)
        .as_deref()
        .is_some_and(|normalized| normalized == branch)
}

fn normalize_branch_ref(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(
        trimmed
            .strip_prefix("refs/remotes/origin/")
            .or_else(|| trimmed.strip_prefix("refs/heads/"))
            .or_else(|| trimmed.strip_prefix("origin/"))
            .unwrap_or(trimmed)
            .to_string(),
    )
}

#[cfg(test)]
mod blocking_tests {
    use super::run_blocking_http;
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_definition_lookup_does_not_block_async_runtime() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lookup = tokio::spawn(run_blocking_http(move || {
            let _ = started_tx.send(());
            release_rx.recv().unwrap();
            Ok(())
        }));

        started_rx.await.unwrap();
        tokio::time::timeout(
            Duration::from_millis(100),
            tokio::time::sleep(Duration::from_millis(1)),
        )
        .await
        .expect("async runtime stayed responsive");
        release_tx.send(()).unwrap();
        lookup.await.unwrap().unwrap();
    }
}
