use super::state::AppState;
use crate::db::Db;
use crate::repo_commands::{
    build_repo_command_catalog, resolve_repo_command_launch, RepoCommandCatalog,
};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use std::sync::Arc;

type HttpError = (StatusCode, String);

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunRepoCommandRequest {
    catalog_revision: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunRepoCommandResponse {
    pub(crate) task_id: String,
    pub(crate) reused: bool,
    pub(crate) owner_desktop_id: String,
    pub(crate) owner_local_repo_id: String,
    pub(crate) owner_local_task_id: String,
}

pub(super) async fn list_repo_commands(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<String>,
) -> Result<Json<RepoCommandCatalog>, HttpError> {
    let db = open_db(&state)?;
    let repo = find_repo(&db, &repo_id)?;
    let catalog = build_repo_command_catalog(&repo)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(Json(catalog))
}

pub(super) async fn run_repo_command(
    State(state): State<Arc<AppState>>,
    Path((repo_id, command_id)): Path<(String, String)>,
    Json(payload): Json<RunRepoCommandRequest>,
) -> Result<Json<RunRepoCommandResponse>, HttpError> {
    let repo = {
        let db = open_db(&state)?;
        find_repo(&db, &repo_id)?
    };
    let (catalog_revision, launch) = resolve_repo_command_launch(&repo, &command_id)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
    if payload.catalog_revision != catalog_revision {
        return Err((
            StatusCode::CONFLICT,
            "repo command catalog changed; refresh and try again".to_string(),
        ));
    }
    let launch = launch.ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            format!("repo command not found: {command_id}"),
        )
    })?;

    if let Some(agent) = launch.singleton_agent.as_deref() {
        let response = super::signal_agent::signal_agent_request(
            Arc::clone(&state),
            repo_id.clone(),
            agent.to_string(),
            launch.prompt,
            crate::task_creator::SingletonAgentOverrides::default(),
        )
        .await?;
        let task_id = response.task_id;
        return Ok(Json(RunRepoCommandResponse {
            task_id: task_id.clone(),
            reused: !response.created,
            owner_desktop_id: state.config.desktop_id.clone(),
            owner_local_repo_id: repo_id,
            owner_local_task_id: task_id,
        }));
    }

    let response = super::tasks::create_task_with_requested_id(
        Arc::clone(&state),
        crate::mobile_api::CreateTaskRequest {
            repo_id: repo_id.clone(),
            prompt: launch.prompt,
            display_name: Some(launch.display_name),
            workflow_name: None,
            stage: launch.stage,
            base_ref: None,
            diff_base_ref: None,
            agent: launch.agent,
            agent_provider: launch.agent_provider,
            agent_type: launch.agent_type,
            terminal_cols: None,
            terminal_rows: None,
            model: launch.model,
            effort: launch.effort,
            permission_mode: launch.permission_mode,
            allowed_tools: launch.allowed_tools,
            disallowed_tools: launch.disallowed_tools,
            max_turns: launch.max_turns,
            max_budget_usd: launch.max_budget_usd,
            setup_cmds: launch.setup_cmds,
            task_template: launch.task_template,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            blocker_task_ids: None,
            notify_task_id: None,
            parent_task_id: None,
        },
        None,
    )
    .await?;
    state.publish_state_changed(StateChangeScope::Tasks);
    let task_id = response.0.task_id;
    Ok(Json(RunRepoCommandResponse {
        task_id: task_id.clone(),
        reused: false,
        owner_desktop_id: state.config.desktop_id.clone(),
        owner_local_repo_id: repo_id,
        owner_local_task_id: task_id,
    }))
}

fn open_db(state: &AppState) -> Result<Db, HttpError> {
    Db::open(&state.config.db_path).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {error}"),
        )
    })
}

fn find_repo(db: &Db, repo_id: &str) -> Result<crate::db::Repo, HttpError> {
    db.get_repo(repo_id)
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {error}"),
            )
        })?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("repo not found: {repo_id}")))
}
