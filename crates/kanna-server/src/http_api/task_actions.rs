use super::state::{db_write_error, AppState};
use super::task_blockers::{resolve_existing_task_id, start_dependents_unblocked_by_pr};
use super::task_input::{notify_task_completion, submit_task_input};
use crate::db::Db;
use axum::extract::State;
use axum::Json;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use std::sync::Arc;

pub(super) async fn run_merge_agent(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    #[cfg(test)]
    if let Some(merge_agent_runner) = state.merge_agent_runner.clone() {
        return merge_agent_runner(task_id)
            .map(Json)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let prepared = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        crate::task_creator::prepare_merge_agent_for_api(&db, &state.config, &task_id)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    };
    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    let created_task = crate::task_creator::spawn_prepared_task_for_api(&mut daemon, prepared)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id: created_task.task_id,
    }))
}

fn parent_chain_reaches(
    db: &Db,
    start: &str,
    target: &str,
) -> Result<bool, (axum::http::StatusCode, String)> {
    let mut current = Some(start.to_string());
    let mut steps = 0usize;
    while let Some(id) = current {
        if id == target {
            return Ok(true);
        }
        steps += 1;
        if steps > 10_000 {
            break;
        }
        current = db
            .pipeline_item_parent(&id)
            .map_err(|e| db_write_error("db error", e))?;
    }
    Ok(false)
}

pub(super) async fn set_task_parent(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::SetTaskParentRequest>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = resolve_existing_task_id(&db, &task_id)?;

    let parent_task_id = match payload.parent_task_id.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(raw) => {
            let parent_id = resolve_existing_task_id(&db, raw)?;
            if parent_id == task_id {
                return Err((
                    axum::http::StatusCode::BAD_REQUEST,
                    "task cannot be its own parent".to_string(),
                ));
            }
            let task = db
                .get_pipeline_item(&task_id)
                .map_err(|e| db_write_error("db error", e))?
                .ok_or_else(|| {
                    (
                        axum::http::StatusCode::NOT_FOUND,
                        format!("task not found: {task_id}"),
                    )
                })?;
            let parent = db
                .get_pipeline_item(&parent_id)
                .map_err(|e| db_write_error("db error", e))?
                .ok_or_else(|| {
                    (
                        axum::http::StatusCode::NOT_FOUND,
                        format!("parent task not found: {parent_id}"),
                    )
                })?;
            if task.repo_id != parent.repo_id {
                return Err((
                    axum::http::StatusCode::BAD_REQUEST,
                    "parent task belongs to a different repo".to_string(),
                ));
            }
            if parent_chain_reaches(&db, &parent_id, &task_id)? {
                return Err((
                    axum::http::StatusCode::BAD_REQUEST,
                    "cannot set parent because it would create a subtask cycle".to_string(),
                ));
            }
            Some(parent_id)
        }
    };

    db.update_pipeline_item_parent(&task_id, parent_task_id.as_deref())
        .map_err(|e| db_write_error("db error", e))?;
    Ok(Json(crate::mobile_api::TaskActionResponse { task_id }))
}

fn collect_retarget_instructions_for_merged_blocker(
    db: &Db,
    blocker_task_id: &str,
) -> Result<Vec<(String, String)>, (axum::http::StatusCode, String)> {
    let blocker = db
        .get_pipeline_item(blocker_task_id)
        .map_err(|e| db_write_error("db error", e))?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {blocker_task_id}"),
            )
        })?;
    if blocker.stage.as_deref() != Some("pr") {
        return Ok(Vec::new());
    }
    let repo = db
        .get_repo(&blocker.repo_id)
        .map_err(|e| db_write_error("db error", e))?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("repo not found for task: {blocker_task_id}"),
            )
        })?;
    let default_branch = repo.default_branch.unwrap_or_else(|| "main".to_string());
    let blocker_branch = blocker
        .branch
        .unwrap_or_else(|| blocker_task_id.to_string());

    let mut instructions = Vec::new();
    for dependent_id in db
        .list_tasks_blocked_by(blocker_task_id)
        .map_err(|e| db_write_error("db error", e))?
    {
        if db
            .get_task_worktree_path(&dependent_id)
            .map_err(|e| db_write_error("db error", e))?
            .is_none()
        {
            continue;
        }
        let Some(session_id) = db
            .resolve_task_terminal_session_id(&dependent_id)
            .map_err(|e| db_write_error("db error", e))?
        else {
            continue;
        };
        let message = format!(
            "Dependency branch `{blocker_branch}` has merged. Please retarget this stacked branch onto `{default_branch}` now: fetch the latest default branch, rebase your work onto `{default_branch}`, resolve conflicts if needed, and continue from the rebased branch."
        );
        instructions.push((session_id, message));
    }
    Ok(instructions)
}

pub(super) async fn close_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<axum::http::StatusCode, (axum::http::StatusCode, String)> {
    #[cfg(test)]
    if let Some(task_closer) = state.task_closer.clone() {
        return task_closer(task_id)
            .map(|_| axum::http::StatusCode::NO_CONTENT)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let pipeline_item_id = db
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
                format!("task not found: {}", task_id),
            )
        })?;

    let open_children = db.count_open_children(&pipeline_item_id).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    if open_children > 0 {
        return Err((
            axum::http::StatusCode::CONFLICT,
            "task has open subtasks; close or detach subtasks first".to_string(),
        ));
    }
    let retarget_instructions =
        collect_retarget_instructions_for_merged_blocker(&db, &pipeline_item_id)?;

    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;

    for (session_id, message) in retarget_instructions {
        submit_task_input(&mut daemon, &session_id, &message)
            .await
            .map_err(|(_, message)| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, message))?;
    }

    for session_id in [
        pipeline_item_id.to_string(),
        format!("shell-wt-{pipeline_item_id}"),
        format!("td-{pipeline_item_id}"),
    ] {
        let event = daemon
            .send_command(&DaemonCommand::Kill { session_id })
            .await
            .map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("daemon error: {}", e),
                )
            })?;

        match event {
            DaemonEvent::Ok => {}
            DaemonEvent::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                ..
            } => {}
            DaemonEvent::Error { message, .. }
                if message.to_ascii_lowercase().contains("session not found") => {}
            DaemonEvent::Error { message, .. } => {
                return Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, message));
            }
            other => {
                return Err((
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("unexpected daemon response: {:?}", other),
                ));
            }
        }
    }

    db.close_pipeline_item(&pipeline_item_id).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    notify_task_completion(&state.config, &pipeline_item_id, false)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub(super) async fn advance_stage(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    #[cfg(test)]
    if let Some(stage_advancer) = state.stage_advancer.clone() {
        return stage_advancer(task_id)
            .map(Json)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let (source_branch, transition) = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        let source_branch = db
            .get_pipeline_item(&task_id)
            .map_err(|e| db_write_error("db error", e))?
            .and_then(|item| item.branch);
        let transition =
            crate::task_creator::prepare_advance_stage_for_api(&db, &state.config, &task_id)
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
        (source_branch, transition)
    };
    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    match transition {
        crate::task_creator::PreparedStageTransition::Spawn(prepared) => {
            let created = crate::task_creator::spawn_prepared_task_for_api(&mut daemon, *prepared)
                .await
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
            if created.stage == "pr" {
                start_dependents_unblocked_by_pr(&state, &task_id, source_branch.clone()).await?;
            }
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            db.close_pipeline_item(&task_id).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;

            Ok(Json(crate::mobile_api::TaskActionResponse {
                task_id: created.task_id,
            }))
        }
        crate::task_creator::PreparedStageTransition::Continue(prepared) => {
            let continued = crate::task_creator::continue_prepared_stage_for_api(
                &state.config.db_path,
                &mut daemon,
                *prepared,
            )
            .await
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
            Ok(Json(continued))
        }
    }
}

pub(super) async fn complete_stage(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::CompleteStageRequest>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    #[cfg(test)]
    if let Some(stage_completer) = state.stage_completer.clone() {
        return stage_completer(task_id, payload)
            .map(Json)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    if payload.status != "success" && payload.status != "failure" {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "status must be success or failure".to_string(),
        ));
    }
    let should_auto_advance = payload.status == "success";

    let stage_result = serde_json::to_string(&serde_json::json!({
        "status": payload.status,
        "summary": payload.summary,
        "metadata": payload.metadata,
    }))
    .map_err(|e| {
        (
            axum::http::StatusCode::BAD_REQUEST,
            format!("invalid stage result: {}", e),
        )
    })?;

    let current = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        let current = db
            .get_pipeline_item(&task_id)
            .map_err(|e| db_write_error("db error", e))?;
        db.update_pipeline_item_stage_result(&task_id, &stage_result)
            .map_err(|e| db_write_error("db error", e))?;
        current
    };

    if !should_auto_advance {
        return Ok(Json(crate::mobile_api::TaskActionResponse { task_id }));
    }

    let transition = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        crate::task_creator::prepare_auto_stage_completion_for_api(&db, &state.config, &task_id)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    };
    let Some(transition) = transition else {
        if current.as_ref().and_then(|item| item.stage.as_deref()) == Some("pr") {
            start_dependents_unblocked_by_pr(
                &state,
                &task_id,
                current.and_then(|item| item.branch),
            )
            .await?;
        }
        return Ok(Json(crate::mobile_api::TaskActionResponse { task_id }));
    };

    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    match transition {
        crate::task_creator::PreparedStageTransition::Spawn(prepared) => {
            let created = crate::task_creator::spawn_prepared_task_for_api(&mut daemon, *prepared)
                .await
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
            if created.stage == "pr" {
                start_dependents_unblocked_by_pr(
                    &state,
                    &task_id,
                    current.as_ref().and_then(|item| item.branch.clone()),
                )
                .await?;
            }
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            db.close_pipeline_item(&task_id).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;

            Ok(Json(crate::mobile_api::TaskActionResponse {
                task_id: created.task_id,
            }))
        }
        crate::task_creator::PreparedStageTransition::Continue(prepared) => {
            let continued = crate::task_creator::continue_prepared_stage_for_api(
                &state.config.db_path,
                &mut daemon,
                *prepared,
            )
            .await
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
            Ok(Json(continued))
        }
    }
}

pub(super) async fn request_revision(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::RequestRevisionRequest>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    #[cfg(test)]
    if let Some(revision_requester) = state.revision_requester.clone() {
        return revision_requester(task_id, payload)
            .map(Json)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let stage_result = serde_json::to_string(&serde_json::json!({
        "status": "failure",
        "summary": payload.summary,
        "metadata": payload.metadata,
    }))
    .map_err(|e| {
        (
            axum::http::StatusCode::BAD_REQUEST,
            format!("invalid revision result: {}", e),
        )
    })?;
    let (source_task_id, prepared) = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        let source_task_id = db
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
                    format!("task not found: {}", task_id),
                )
            })?;
        db.update_pipeline_item_stage_result(&source_task_id, &stage_result)
            .map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
        crate::task_creator::prepare_revision_task_for_api(
            &db,
            &state.config,
            &source_task_id,
            &payload.target_stage,
            &payload.prompt,
        )
        .map(|prepared| (source_task_id, prepared))
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    };

    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    let created = crate::task_creator::spawn_prepared_task_for_api(&mut daemon, prepared)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    db.close_pipeline_item(&source_task_id).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;

    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id: created.task_id,
    }))
}
