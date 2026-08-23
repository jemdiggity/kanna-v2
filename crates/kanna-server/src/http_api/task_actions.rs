use super::lan_trust::PrivilegedTaskAccess;
use super::state::{db_write_error, AppState};
use super::task_blockers::{
    resolve_existing_task_id, start_dependents_unblocked_by_close_with_daemon,
};
use super::task_input::{
    notify_task_completion_best_effort, submit_task_input, TaskCompletionTrigger,
};
use crate::db::Db;
use axum::extract::State;
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use serde::Deserialize;
use std::sync::Arc;

fn stage_action_error_status(error: &str) -> axum::http::StatusCode {
    if error.starts_with("task is blocked:") || error.starts_with("post is still running") {
        axum::http::StatusCode::CONFLICT
    } else {
        axum::http::StatusCode::INTERNAL_SERVER_ERROR
    }
}

fn resume_action_error_status(error: &str) -> axum::http::StatusCode {
    if error.starts_with("task is closed:")
        || error.starts_with("task has no stage run to resume:")
        || error.starts_with("latest run is ")
        || error.starts_with("latest interrupted run is not the task's current stage:")
    {
        axum::http::StatusCode::CONFLICT
    } else {
        axum::http::StatusCode::INTERNAL_SERVER_ERROR
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AdvanceStageRequest {
    expected_transition_revision: Option<String>,
}

pub(super) async fn resolve_task_id_for_mutation(
    state: &Arc<AppState>,
    task_or_branch_id: &str,
) -> Result<String, (axum::http::StatusCode, String)> {
    let state = Arc::clone(state);
    let task_or_branch_id = task_or_branch_id.to_string();
    super::blocking::run_handler_blocking("task mutation identity", move || {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        resolve_existing_task_id(&db, &task_or_branch_id)
    })
    .await
}

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
        let state = Arc::clone(&state);
        let task_id = task_id.clone();
        super::blocking::run_handler_blocking("merge agent prepare", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            crate::task_creator::prepare_merge_agent_for_api(&db, &state.config, &task_id)
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))
        })
        .await?
    };
    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    let created_task = crate::task_creator::spawn_prepared_task_for_api_recording_stage_run(
        &state.config.db_path,
        &mut daemon,
        prepared,
    )
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id: created_task.task_id,
        follow_task: None,
        revision_budget: None,
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
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    }))
}

pub(super) async fn set_task_workflow(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::SetTaskWorkflowRequest>,
) -> Result<Json<crate::mobile_api::SetTaskWorkflowResponse>, (axum::http::StatusCode, String)> {
    let workflow_name = payload.workflow_name.trim().to_string();
    if workflow_name.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "workflowName must be non-empty".to_string(),
        ));
    }

    let task_id = resolve_task_id_for_mutation(&state, &task_id).await?;
    let _task_mutation = state.begin_requested_task_mutation(&task_id).await;
    let (response, changed) = {
        let state = Arc::clone(&state);
        super::blocking::run_handler_blocking("task workflow update", move || {
            let db = Db::open(&state.config.db_path).map_err(|error| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {error}"),
                )
            })?;
            let item = db
                .get_pipeline_item(&task_id)
                .map_err(|error| db_write_error("db error", error))?
                .ok_or_else(|| {
                    (
                        axum::http::StatusCode::NOT_FOUND,
                        format!("task not found: {task_id}"),
                    )
                })?;
            if item.closed_at.is_some() {
                return Err((
                    axum::http::StatusCode::CONFLICT,
                    format!("cannot change workflow for closed task {task_id}"),
                ));
            }
            let stage = item.stage.clone().ok_or_else(|| {
                (
                    axum::http::StatusCode::CONFLICT,
                    format!(
                        "task {task_id} has no current stage to map into workflow {workflow_name}"
                    ),
                )
            })?;
            let repo = db
                .get_repo(&item.repo_id)
                .map_err(|error| db_write_error("db error", error))?
                .ok_or_else(|| {
                    (
                        axum::http::StatusCode::NOT_FOUND,
                        format!("repo not found for task {task_id}: {}", item.repo_id),
                    )
                })?;
            let snapshot =
                crate::task_creator::resolve_task_workflow_snapshot(&repo, &workflow_name)
                    .map_err(|error| (axum::http::StatusCode::BAD_REQUEST, error))?;
            if !snapshot.stage_names.iter().any(|name| name == &stage) {
                return Err((
                    axum::http::StatusCode::CONFLICT,
                    format!(
                        "cannot change task {task_id} from workflow {} to {workflow_name}: \
                         current stage '{stage}' is not present in the new workflow (stages: {})",
                        item.pipeline.as_deref().unwrap_or("<none>"),
                        snapshot.stage_names.join(", ")
                    ),
                ));
            }

            let changed = db
                .update_pipeline_item_pipeline(
                    &task_id,
                    &stage,
                    &workflow_name,
                    &snapshot.definition_json,
                    item.revision_rounds,
                    snapshot.revision_limit,
                )
                .map_err(|error| db_write_error("db error", error))?;
            Ok((
                crate::mobile_api::SetTaskWorkflowResponse {
                    task_id,
                    legacy_pipeline_name: workflow_name.clone(),
                    workflow_name,
                    stage,
                    revision_rounds: item.revision_rounds,
                    revision_limit: snapshot.revision_limit,
                },
                changed,
            ))
        })
        .await?
    };
    if changed {
        state.publish_state_changed(StateChangeScope::Tasks);
    }
    Ok(Json(response))
}

/// How a blocker resolved — determines the wording dependents receive.
/// Passed explicitly because the close paths collect instructions before
/// `closed_at` is written, so the row itself cannot be trusted mid-close.
#[derive(Clone, Copy, PartialEq)]
enum BlockerResolution {
    Closed,
    PrCreated,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PinTaskRequest {
    position: Option<i64>,
}

pub(super) async fn pin_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<PinTaskRequest>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = resolve_existing_task_id(&db, &task_id)?;
    if let Some(position) = payload.position {
        db.pin_pipeline_item(&task_id, position)
            .map_err(|e| db_write_error("db error", e))?;
    } else {
        let repo_id = db
            .get_pipeline_item(&task_id)
            .map_err(|e| db_write_error("db error", e))?
            .ok_or_else(|| {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    format!("task not found: {task_id}"),
                )
            })?
            .repo_id;
        db.pin_pipeline_item_at_top(&repo_id, &task_id)
            .map_err(|e| db_write_error("db error", e))?;
    }
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    }))
}

pub(super) async fn unpin_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = resolve_existing_task_id(&db, &task_id)?;
    db.unpin_pipeline_item(&task_id)
        .map_err(|e| db_write_error("db error", e))?;
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    }))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReorderPinnedTasksRequest {
    repo_id: String,
    ordered_ids: Vec<String>,
}

pub(super) async fn reorder_pinned_tasks(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ReorderPinnedTasksRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    db.reorder_pinned_items(&payload.repo_id, &payload.ordered_ids)
        .map_err(|e| db_write_error("db error", e))?;
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(
        serde_json::json!({ "updated": payload.ordered_ids.len() }),
    ))
}

/// Build per-dependent session messages announcing that a blocker at the
/// `pr` stage has resolved — either its PR was just created (optimistic
/// resolution: work committed, reviewed, and pushed, awaiting human merge)
/// or the task closed. Dependents that already have a workspace need to
/// pull the blocker's work in themselves, and the branch they need is the
/// blocker's *current* branch — the PR stage usually renames it away from
/// the stored fork name, so resolve it from the blocker's worktree HEAD.
fn collect_blocker_resolution_instructions(
    db: &Db,
    blocker_task_id: &str,
    resolution: BlockerResolution,
) -> Result<Vec<(String, String)>, (axum::http::StatusCode, String)> {
    let blocker_task_id = resolve_existing_task_id(db, blocker_task_id)?;
    let blocker = db
        .get_pipeline_item(&blocker_task_id)
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
        .as_deref()
        .and_then(|branch| {
            crate::task_creator::resolve_current_source_worktree_branch(&repo.path, Some(branch))
        })
        .or(blocker.branch)
        .unwrap_or_else(|| blocker_task_id.to_string());
    db.update_pipeline_item_pr_branch(&blocker_task_id, &blocker_branch)
        .map_err(|error| db_write_error("db error", error))?;
    let blocker_title = blocker
        .display_name
        .unwrap_or_else(|| blocker_task_id.to_string());
    let pr_reference = blocker
        .pr_url
        .map(|url| format!(" (PR: {url})"))
        .unwrap_or_default();
    let status_sentence = match resolution {
        BlockerResolution::Closed => {
            format!("Blocker task \"{blocker_title}\" has finished its workflow and closed.")
        }
        BlockerResolution::PrCreated => format!(
            "Blocker task \"{blocker_title}\" has completed its work and opened a PR awaiting human review."
        ),
    };

    let mut instructions = Vec::new();
    for dependent_id in db
        .list_tasks_blocked_by(&blocker_task_id)
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
            "{status_sentence} Its work is on branch `{blocker_branch}`{pr_reference}. Bring that work into this branch now: run `git fetch origin`, then rebase (or merge) this branch onto `{blocker_branch}` — or onto `{default_branch}` instead if that PR has already merged. Resolve conflicts if needed and continue your task."
        );
        instructions.push((session_id, message));
    }
    Ok(instructions)
}

/// Closes a task from inside the process, through the same action the route
/// serves.
///
/// The transfer engine closes the source task once the destination has
/// acknowledged the import. That has to be *this* close — WIP snapshotting,
/// session teardown, blocker instructions, the `closed` completion notification
/// — not a second implementation that drifts from it.
pub(crate) async fn close_task_in_process(
    state: Arc<AppState>,
    task_id: String,
) -> Result<(), (axum::http::StatusCode, String)> {
    close_task(
        PrivilegedTaskAccess,
        State(state),
        axum::extract::Path(task_id),
    )
    .await
    .map(|_| ())
}

pub(super) async fn close_task(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<axum::http::StatusCode, (axum::http::StatusCode, String)> {
    let task_id = resolve_task_id_for_mutation(&state, &task_id).await?;
    let _task_mutation = state.begin_requested_task_mutation(&task_id).await;

    #[cfg(test)]
    if let Some(task_closer) = state.task_closer.clone() {
        return task_closer(task_id)
            .map(|_| axum::http::StatusCode::NO_CONTENT)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let (pipeline_item_id, blocker_close_instructions, workspace_teardown) = {
        let state = Arc::clone(&state);
        super::blocking::run_handler_blocking("task close prepare", move || {
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
            let blocker_close_instructions = collect_blocker_resolution_instructions(
                &db,
                &pipeline_item_id,
                BlockerResolution::Closed,
            )?;
            let workspace_teardown = crate::task_creator::prepare_workspace_teardown_for_close(
                &db,
                &state.config,
                &pipeline_item_id,
            );
            Ok((
                pipeline_item_id,
                blocker_close_instructions,
                workspace_teardown,
            ))
        })
        .await?
    };
    let has_workspace_teardown = workspace_teardown.is_some();

    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;

    for (session_id, message) in blocker_close_instructions {
        if let Err((_, error)) = submit_task_input(&mut daemon, &session_id, &message).await {
            log::warn!(
                "failed to deliver blocker-close instructions to dependent session {session_id}: {error}"
            );
        }
    }

    for session_id in [
        pipeline_item_id.to_string(),
        format!("shell-wt-{pipeline_item_id}"),
    ] {
        crate::task_creator::kill_session_replacing(
            &mut daemon,
            &state.session_replacements,
            session_id.as_str(),
        )
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    }
    let teardown_session_id = workspace_teardown
        .as_ref()
        .map(|teardown| teardown.session_id.clone())
        .unwrap_or_else(|| format!("td-{pipeline_item_id}"));
    if let Err(error) = crate::task_creator::kill_session_replacing(
        &mut daemon,
        &state.session_replacements,
        teardown_session_id.as_str(),
    )
    .await
    {
        log::warn!("failed to replace workspace teardown session {teardown_session_id}: {error}");
    }
    {
        // Closing snapshots dirty worktrees into WIP commits and removes
        // them — synchronous git work that must not run on a runtime worker.
        let state = Arc::clone(&state);
        let pipeline_item_id = pipeline_item_id.clone();
        super::blocking::run_handler_blocking("task close finalize", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            db.close_pipeline_item(&pipeline_item_id).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            if !has_workspace_teardown {
                crate::worktree_cleanup::cleanup_closed_task_worktrees_by_id(
                    &db,
                    &pipeline_item_id,
                )
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
            }
            Ok(())
        })
        .await?
    };
    if has_workspace_teardown {
        crate::task_creator::spawn_prepared_workspace_teardown_best_effort(
            &mut daemon,
            workspace_teardown,
        )
        .await;
    }
    crate::task_creator::remove_completion_contexts(&state.config.daemon_dir, &pipeline_item_id);
    // Attachments belong to the task, not to a workspace, so they go here with
    // the task's other per-task on-disk artifacts rather than with a worktree.
    crate::task_input_attachments::remove_task_attachments(
        &state.config.db_path,
        &pipeline_item_id,
    );
    // A direct close reaches no verdict, so it is reported as `closed` — never
    // as a failure the receiving agent would try to diagnose. Best-effort:
    // the close has already committed, and a lost notification must not
    // report it as failed nor skip the dependents this close unblocked.
    notify_task_completion_best_effort(
        state.as_ref(),
        &pipeline_item_id,
        TaskCompletionTrigger::DirectClose,
    )
    .await;
    start_dependents_unblocked_by_close_with_daemon(&state, &mut daemon, &pipeline_item_id).await;
    state.publish_state_changed(StateChangeScope::Tasks);
    state.publish_state_changed(StateChangeScope::Blockers);

    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub(super) async fn abort_task_creation(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<axum::http::StatusCode, (axum::http::StatusCode, String)> {
    super::tasks::validate_requested_task_id(&task_id)?;
    let _operation = state.begin_requested_task_abort(&task_id).await;

    #[cfg(test)]
    if let Some(task_closer) = state.task_closer.clone() {
        return task_closer(task_id)
            .map(|_| axum::http::StatusCode::NO_CONTENT)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let task = {
        let state = Arc::clone(&state);
        let lookup_task_id = task_id.clone();
        super::blocking::run_handler_blocking("task creation abort lookup", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            db.get_pipeline_item(&lookup_task_id).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })
        })
        .await?
    };
    if task.is_none() || task.is_some_and(|task| task.closed_at.is_some()) {
        return Ok(axum::http::StatusCode::NO_CONTENT);
    }

    close_task(
        PrivilegedTaskAccess,
        State(state),
        axum::extract::Path(task_id),
    )
    .await
}

pub(super) async fn reopen_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let task_id = {
        let state = Arc::clone(&state);
        super::blocking::run_handler_blocking("task reopen", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            match crate::task_creator::reopen_task_for_api(&db, &task_id) {
                Ok(task_id) => Ok(task_id),
                Err(crate::task_creator::ReopenTaskError::OwnershipConflict) => Err((
                    axum::http::StatusCode::CONFLICT,
                    "cloud task ownership conflicts with an open local task".to_string(),
                )),
                Err(crate::task_creator::ReopenTaskError::Internal(error)) => {
                    Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))
                }
            }
        })
        .await?
    };
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    }))
}

/// Close a task that advanced past its final workflow stage. Shared by
/// `advance_stage` and `complete_stage`: hands blocker-close instructions to
/// dependents with workspaces, kills the task's daemon sessions, closes the
/// workflow item, and delivers the completion notification.
async fn close_task_after_final_stage(
    state: &Arc<AppState>,
    daemon: &mut crate::daemon_client::DaemonClient,
    task_id: String,
    workspace_teardown: Option<crate::task_creator::PreparedWorkspaceTeardown>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    // Before anything is torn down: a workflow whose final stage declares the
    // merge-signaling approve post must not close leaving an open PR the merge
    // master never heard about. An error here deliberately abandons the close
    // — the task parks at its final stage instead.
    super::signal_agent::ensure_merge_handoff_before_close(state, &task_id).await?;
    let has_workspace_teardown = workspace_teardown.is_some();
    let blocker_close_instructions = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        collect_blocker_resolution_instructions(&db, &task_id, BlockerResolution::Closed)?
    };
    for (session_id, message) in blocker_close_instructions {
        if let Err((_, error)) = submit_task_input(daemon, &session_id, &message).await {
            log::warn!(
                "failed to deliver blocker-close instructions to dependent session {session_id}: {error}"
            );
        }
    }
    for session_id in [task_id.to_string(), format!("shell-wt-{task_id}")] {
        crate::task_creator::kill_session_replacing(
            daemon,
            &state.session_replacements,
            session_id.as_str(),
        )
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    }
    let teardown_session_id = workspace_teardown
        .as_ref()
        .map(|teardown| teardown.session_id.clone())
        .unwrap_or_else(|| format!("td-{task_id}"));
    if let Err(error) = crate::task_creator::kill_session_replacing(
        daemon,
        &state.session_replacements,
        &teardown_session_id,
    )
    .await
    {
        log::warn!("failed to replace workspace teardown session {teardown_session_id}: {error}");
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
    crate::task_creator::remove_completion_contexts(&state.config.daemon_dir, &task_id);
    crate::task_input_attachments::remove_task_attachments(&state.config.db_path, &task_id);
    if has_workspace_teardown {
        crate::task_creator::spawn_prepared_workspace_teardown_best_effort(
            daemon,
            workspace_teardown,
        )
        .await;
    } else {
        crate::worktree_cleanup::cleanup_closed_task_worktrees_by_id(&db, &task_id)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    }
    // Reaching the end of the workflow is a normal completion: the reported
    // status comes from the run that terminated the task, not from the fact
    // that closing it killed the session. Best-effort for the same reason as
    // the direct close: the item is already closed, and the dependents this
    // close unblocks must be started whether or not the message lands.
    notify_task_completion_best_effort(
        state.as_ref(),
        &task_id,
        TaskCompletionTrigger::WorkflowCompleted,
    )
    .await;
    start_dependents_unblocked_by_close_with_daemon(state, daemon, &task_id).await;
    state.publish_state_changed(StateChangeScope::Tasks);
    state.publish_state_changed(StateChangeScope::Blockers);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: Some(false),
        revision_budget: None,
    }))
}

pub(super) async fn advance_stage(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    payload: Option<Json<AdvanceStageRequest>>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let task_id = resolve_task_id_for_mutation(&state, &task_id).await?;
    let response = crate::mobile_api::TaskActionResponse {
        task_id: task_id.clone(),
        follow_task: None,
        revision_budget: None,
    };
    let Some(stage_advance) = state.begin_requested_stage_advance(&task_id).await else {
        return Ok(Json(response));
    };

    if let Some(expected_transition_revision) =
        payload.and_then(|Json(payload)| payload.expected_transition_revision)
    {
        let current_transition_revision = {
            let state = Arc::clone(&state);
            let task_id = task_id.clone();
            super::blocking::run_handler_blocking("stage advance revision check", move || {
                let db = Db::open(&state.config.db_path).map_err(|e| {
                    (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        format!("db error: {}", e),
                    )
                })?;
                db.latest_stage_run(&task_id)
                    .map(|run| run.map(|run| run.id))
                    .map_err(|e| {
                        (
                            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                            format!("db error: {}", e),
                        )
                    })
            })
            .await?
        };
        if current_transition_revision.as_deref() != Some(expected_transition_revision.as_str()) {
            return Err((
                axum::http::StatusCode::CONFLICT,
                format!(
                    "stale stage advance for {task_id}: expected transition revision \
                     {expected_transition_revision}"
                ),
            ));
        }
    }

    #[cfg(test)]
    if let Some(stage_advancer) = state.stage_advancer.clone() {
        return stage_advancer(task_id)
            .map(Json)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let transition = {
        let state = Arc::clone(&state);
        let task_id = task_id.clone();
        super::blocking::run_handler_blocking("stage advance prepare", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            let latest = db.latest_stage_run(&task_id).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            if latest
                .as_ref()
                .is_some_and(|run| run.kind == "post" && run.status == "running")
            {
                return Ok(None);
            }
            crate::task_creator::prepare_advance_stage_for_api(&db, &state.config, &task_id)
                .map(Some)
                .map_err(|e| (stage_action_error_status(&e), e))
        })
        .await?
    };
    let Some(transition) = transition else {
        return Ok(Json(response));
    };
    execute_stage_transition_detached_holding(
        Arc::clone(&state),
        task_id,
        transition,
        StageTransitionOwnership {
            task_mutation: Some(stage_advance),
            requested_operation: None,
        },
    );
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(response))
}

/// Execute a prepared transition: swap to the next stage's run, dispatch a
/// post into the running session, or close past the final stage. Shared by
/// `advance_stage` and `complete_stage`.
async fn execute_stage_transition(
    state: &Arc<AppState>,
    daemon: &mut crate::daemon_client::DaemonClient,
    transition: crate::task_creator::PreparedStageTransition,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    match transition {
        crate::task_creator::PreparedStageTransition::Run(prepared) => {
            let advanced = crate::task_creator::spawn_prepared_stage_run_for_api(
                &state.config.db_path,
                daemon,
                &state.session_replacements,
                *prepared,
            )
            .await
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
            state.publish_state_changed(StateChangeScope::Tasks);
            Ok(Json(advanced))
        }
        crate::task_creator::PreparedStageTransition::Post(prepared) => {
            // A post never moves the task's stage, so it cannot newly enter
            // `pr`; no dependent start check is needed.
            let dispatched = crate::task_creator::dispatch_prepared_post_for_api(
                &state.config.db_path,
                daemon,
                &state.session_replacements,
                *prepared,
            )
            .await
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
            state.publish_state_changed(StateChangeScope::Tasks);
            Ok(Json(dispatched))
        }
        crate::task_creator::PreparedStageTransition::Close {
            task_id,
            workspace_teardown,
        } => {
            close_task_after_final_stage(
                state,
                daemon,
                task_id,
                workspace_teardown.map(|teardown| *teardown),
            )
            .await
        }
    }
}

/// Run a prepared transition on a detached task, NOT on the HTTP request's
/// future. Transitions kill the session they replace — and when the verdict
/// comes from an agent INSIDE that session (kanna-cli / kanna-mcp riding the
/// task's own process tree), killing it drops the HTTP connection and axum
/// cancels the in-flight handler, silently abandoning the transition between
/// the kill and the respawn. Detaching makes the transition immune to the
/// caller's death; failures are logged since the caller may not outlive the
/// work it triggered.
#[derive(Default)]
struct StageTransitionOwnership {
    task_mutation: Option<super::state::RequestedTaskMutation>,
    requested_operation: Option<super::state::RequestedTaskOperation>,
}

impl StageTransitionOwnership {
    fn release(self) {
        drop(self.task_mutation);
        drop(self.requested_operation);
    }
}

/// Same, but the detached worker takes ownership of a per-task operation
/// guard for the whole transition.
///
/// The handler must return before the transition runs — it kills and respawns
/// the caller's own session — so the guard cannot simply live in the handler:
/// dropping it at the 200 would reopen the task between the response and the
/// work landing, and a second request admitted in that window would spend
/// another budget slot and prepare a workspace from task state the in-flight
/// transition is about to change. Held here, it drops when the worker exits,
/// on every path including a daemon that never answers.
fn execute_stage_transition_detached_holding(
    state: Arc<AppState>,
    task_id: String,
    transition: crate::task_creator::PreparedStageTransition,
    ownership: StageTransitionOwnership,
) {
    // Stage execution interleaves async daemon I/O with synchronous git,
    // filesystem, and SQLite work (run records, fork rollback, teardown
    // prep). Drive the whole future from the blocking pool so none of it can
    // occupy a runtime worker and starve the shared KSP terminal transport.
    let worker_task_id = task_id.clone();
    tokio::spawn(async move {
        // Bound to the worker's own scope: every exit path below — daemon
        // connect failure, transition error, success, join error, or the task
        // being dropped at runtime shutdown — releases the task.
        let handle = tokio::runtime::Handle::current();
        let joined = tokio::task::spawn_blocking(move || {
            handle.block_on(async move {
                let mut daemon =
                    match crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
                        .await
                    {
                        Ok(daemon) => daemon,
                        Err(error) => {
                            log::error!(
                                "stage transition for {} failed to reach daemon: {}",
                                task_id,
                                error
                            );
                            return;
                        }
                    };
                if let Err((_, message)) =
                    execute_stage_transition(&state, &mut daemon, transition).await
                {
                    log::error!("stage transition for {} failed: {}", task_id, message);
                    state.publish_state_changed(StateChangeScope::Tasks);
                }
            })
        })
        .await;
        ownership.release();
        if let Err(join_error) = joined {
            log::error!(
                "stage transition worker for {} failed: {}",
                worker_task_id,
                join_error
            );
        }
    });
}

pub(super) async fn resume_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let task_id = resolve_task_id_for_mutation(&state, &task_id).await?;
    let task_mutation = state.begin_requested_task_mutation(&task_id).await;
    let prepared = {
        let state = Arc::clone(&state);
        let task_id = task_id.clone();
        super::blocking::run_handler_blocking("task resume prepare", move || {
            let db = Db::open(&state.config.db_path).map_err(|error| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {error}"),
                )
            })?;
            crate::task_creator::prepare_resume_task_for_api(&db, &state.config, &task_id)
                .map_err(|error| (resume_action_error_status(&error), error))
        })
        .await?
    };
    match crate::task_creator::daemon_session_presence(
        &state.config.daemon_dir,
        prepared.session_id(),
    )
    .await
    {
        crate::task_creator::DaemonSessionPresence::Present => {
            let db_path = state.config.db_path.clone();
            let restore_task_id = task_id.clone();
            let restored = super::blocking::run_handler_blocking(
                "task resume live-session reconciliation",
                move || {
                    crate::http_api::restore_task_run_for_live_session(&db_path, &restore_task_id)
                        .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))
                },
            )
            .await?;
            if restored {
                log::warn!(
                    "resume request found live daemon session for {task_id}; restored interrupted run instead of spawning"
                );
                state.publish_state_changed(StateChangeScope::Tasks);
                return Ok(Json(crate::mobile_api::TaskActionResponse {
                    task_id,
                    follow_task: None,
                    revision_budget: None,
                }));
            }
            return Err((
                axum::http::StatusCode::CONFLICT,
                format!("task session is still alive: {task_id}"),
            ));
        }
        crate::task_creator::DaemonSessionPresence::Unknown => {
            return Err((
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                format!("could not verify that task session is dead: {task_id}"),
            ));
        }
        crate::task_creator::DaemonSessionPresence::Absent => {}
    }
    execute_stage_transition_detached_holding(
        Arc::clone(&state),
        task_id.clone(),
        crate::task_creator::PreparedStageTransition::Run(Box::new(prepared)),
        StageTransitionOwnership {
            task_mutation: Some(task_mutation),
            requested_operation: None,
        },
    );
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    }))
}

pub(super) async fn rerun_stage(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let task_id = resolve_task_id_for_mutation(&state, &task_id).await?;
    let task_mutation = state.begin_requested_task_mutation(&task_id).await;

    #[cfg(test)]
    if let Some(stage_rerunner) = state.stage_rerunner.clone() {
        return stage_rerunner(task_id)
            .map(Json)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let prepared = {
        let state = Arc::clone(&state);
        let task_id = task_id.clone();
        super::blocking::run_handler_blocking("stage rerun prepare", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            crate::task_creator::prepare_rerun_stage_for_api(&db, &state.config, &task_id)
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))
        })
        .await?
    };
    // Detached for the same reason as execute_stage_transition_detached: the
    // rerun kills the session that may carry this very request. Driven from
    // the blocking pool for the same reason as well — the rerun records runs
    // and rolls back forks with synchronous git/SQLite work.
    let rerun_state = Arc::clone(&state);
    let rerun_task_id = task_id.clone();
    tokio::spawn(async move {
        let _task_mutation = task_mutation;
        let handle = tokio::runtime::Handle::current();
        let worker_task_id = rerun_task_id.clone();
        let joined = tokio::task::spawn_blocking(move || {
            handle.block_on(async move {
                let mut daemon = match crate::daemon_client::DaemonClient::connect(
                    &rerun_state.config.daemon_dir,
                )
                .await
                {
                    Ok(daemon) => daemon,
                    Err(error) => {
                        log::error!(
                            "stage rerun for {} failed to reach daemon: {}",
                            rerun_task_id,
                            error
                        );
                        return;
                    }
                };
                if let Err(error) = crate::task_creator::rerun_prepared_stage_for_api(
                    &rerun_state.config.db_path,
                    &mut daemon,
                    &rerun_state.session_replacements,
                    prepared,
                )
                .await
                {
                    log::error!("stage rerun for {} failed: {}", rerun_task_id, error);
                    rerun_state.publish_state_changed(StateChangeScope::Tasks);
                    return;
                }
                rerun_state.publish_state_changed(StateChangeScope::Tasks);
            })
        })
        .await;
        if let Err(join_error) = joined {
            log::error!(
                "stage rerun worker for {} failed: {}",
                worker_task_id,
                join_error
            );
        }
    });
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    }))
}

/// A pull-request URL carried by a stage-complete verdict: explicitly via
/// `metadata.pr_url`, or the first `…/pull/<n>` link in the summary (agents
/// reporting through plain `kanna-cli` tend to put it there).
fn pr_url_from_verdict(metadata: Option<&serde_json::Value>, summary: &str) -> Option<String> {
    if let Some(url) = metadata
        .and_then(|metadata| metadata.get("pr_url"))
        .and_then(|value| value.as_str())
        .filter(|url| !url.trim().is_empty())
    {
        return Some(url.trim().to_string());
    }
    summary
        .split_whitespace()
        .map(|token| token.trim_end_matches(['.', ',', ')', ']', ';']))
        .find(|token| {
            token.starts_with("https://")
                && token.rsplit_once("/pull/").is_some_and(|(_, number)| {
                    !number.is_empty() && number.chars().all(|c| c.is_ascii_digit())
                })
        })
        .map(str::to_string)
}

fn pr_number_from_url(pr_url: &str) -> Option<i64> {
    pr_url
        .rsplit_once("/pull/")
        .and_then(|(_, number)| number.parse::<i64>().ok())
}

pub(super) async fn complete_stage(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::CompleteStageRequest>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let task_id = resolve_task_id_for_mutation(&state, &task_id).await?;
    let task_mutation = state.begin_requested_task_mutation(&task_id).await;

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
    let stage_result_value = serde_json::json!({
        "status": payload.status,
        "summary": payload.summary,
        "metadata": payload.metadata,
    });
    let stage_result = serde_json::to_string(&stage_result_value).map_err(|e| {
        (
            axum::http::StatusCode::BAD_REQUEST,
            format!("invalid stage result: {}", e),
        )
    })?;

    let completion_attempt_key = payload.completion_attempt_key.clone();
    let completion_attempt_key_for_record = completion_attempt_key.clone();
    let completion_run_id = payload.run_id.clone();
    let (task_id, finished_run, already_closed, replayed) = {
        let state = Arc::clone(&state);
        let payload_status = payload.status;
        let payload_summary = payload.summary;
        let payload_metadata = payload.metadata;
        let payload_run_id = payload.run_id;
        super::blocking::run_handler_blocking("stage completion record", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            let task_id = db
                .resolve_pipeline_item_id(&task_id)
                .map_err(|e| db_write_error("db error", e))?
                .ok_or_else(|| {
                    (
                        axum::http::StatusCode::NOT_FOUND,
                        format!("task not found: {}", task_id),
                    )
                })?;
            if db
                .get_pipeline_item(&task_id)
                .map_err(|e| db_write_error("db error", e))?
                .is_some_and(|item| item.closed_at.is_some())
            {
                return Ok((task_id, None, true, false));
            }
            let run_status = if payload_status == "success" {
                "succeeded"
            } else {
                "failed"
            };
            let current_run = db
                .latest_stage_run(&task_id)
                .map_err(|e| db_write_error("db error", e))?
                .ok_or_else(|| {
                    (
                        axum::http::StatusCode::CONFLICT,
                        format!("task has no stage run to complete: {task_id}"),
                    )
                })?;
            let mut payload_run_id = match payload_run_id {
                Some(run_id) if !run_id.trim().is_empty() => run_id,
                Some(_) => {
                    return Err((
                        axum::http::StatusCode::BAD_REQUEST,
                        "runId must be non-empty when provided".into(),
                    ))
                }
                None => {
                    if db
                        .stage_run_completion_bound(&current_run.id)
                        .map_err(|e| db_write_error("db error", e))?
                    {
                        return Err((
                            axum::http::StatusCode::CONFLICT,
                            "runId is required for this spawned run; restart the completion adapter if it predates the run".into(),
                        ));
                    }
                    current_run.id.clone()
                }
            };
            if let Some(attempt_key) = completion_attempt_key_for_record.as_deref() {
                if let Some(original_run_id) =
                    crate::task_creator::resolve_legacy_completion_retry_run(
                        &state.config.daemon_dir,
                        &db,
                        &task_id,
                        &payload_run_id,
                        attempt_key,
                    )
                {
                    payload_run_id = original_run_id;
                }
            }
            if current_run.id != payload_run_id {
                let prior = db
                    .stage_run(&payload_run_id)
                    .map_err(|e| db_write_error("db error", e))?;
                if prior.as_ref().is_some_and(|run| {
                    run.task_id == task_id
                        && run.status == run_status
                        && run.result.as_deref() == Some(stage_result.as_str())
                }) {
                    return Ok((task_id, None, false, true));
                }
                return Err((
                    axum::http::StatusCode::CONFLICT,
                    format!(
                        "stale stage completion for run {payload_run_id}; current run is {}",
                        current_run.id
                    ),
                ));
            }
            if current_run.status == run_status
                && current_run.result.as_deref() == Some(stage_result.as_str())
            {
                return Ok((task_id, None, false, true));
            }
            if !matches!(
                current_run.status.as_str(),
                "running" | "succeeded" | "failed"
            ) {
                return Err((
                    axum::http::StatusCode::CONFLICT,
                    format!(
                        "stage run {payload_run_id} cannot be completed from status {}",
                        current_run.status
                    ),
                ));
            }
            let finished_run = Some(crate::db::FinishedStageRun {
                kind: current_run.kind,
                completion_transition: current_run.completion_transition,
            });
            db.finish_stage_run(
                &payload_run_id,
                run_status,
                Some(&stage_result),
                Some(&payload_summary),
            )
            .map_err(|e| db_write_error("db error", e))?;
            if payload_status == "success" {
                if let Some(pr_url) =
                    pr_url_from_verdict(payload_metadata.as_ref(), &payload_summary)
                {
                    db.update_pipeline_item_pr(&task_id, pr_number_from_url(&pr_url), &pr_url)
                        .map_err(|e| db_write_error("db error", e))?;
                }
            }
            Ok((task_id, finished_run, false, false))
        })
        .await?
    };

    if let (Some(run_id), Some(attempt_key)) = (
        completion_run_id.as_deref(),
        completion_attempt_key.as_deref(),
    ) {
        mark_completion_context_succeeded(&state.config.daemon_dir, &task_id, run_id, attempt_key);
    }

    if already_closed || replayed {
        return Ok(Json(crate::mobile_api::TaskActionResponse {
            task_id,
            follow_task: None,
            revision_budget: None,
        }));
    }

    if !should_auto_advance {
        state.publish_state_changed(StateChangeScope::Tasks);
        return Ok(Json(crate::mobile_api::TaskActionResponse {
            task_id,
            follow_task: None,
            revision_budget: None,
        }));
    }

    let transition = {
        let state = Arc::clone(&state);
        let task_id = task_id.clone();
        super::blocking::run_handler_blocking("stage completion prepare", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            crate::task_creator::prepare_stage_completion_for_api(
                &db,
                &state.config,
                &task_id,
                finished_run.as_ref().map(|run| run.kind.as_str()),
                finished_run
                    .as_ref()
                    .and_then(|run| run.completion_transition.as_deref()),
            )
            .map_err(|e| (stage_action_error_status(&e), e))
        })
        .await?
    };
    let Some(transition) = transition else {
        state.publish_state_changed(StateChangeScope::Tasks);
        // Parked at a manual-transition stage. When that stage is `pr` and
        // the PR exists, the task's work is final enough for dependents:
        // resolve blockers optimistically instead of waiting for the human
        // review/merge loop to close the task. Best-effort — a failure here
        // must not fail the recorded completion.
        unblock_dependents_of_pr_resolved_blocker(&state, &task_id).await;
        return Ok(Json(crate::mobile_api::TaskActionResponse {
            task_id,
            follow_task: None,
            revision_budget: None,
        }));
    };

    let response = crate::mobile_api::TaskActionResponse {
        task_id: task_id.clone(),
        follow_task: None,
        revision_budget: None,
    };
    execute_stage_transition_detached_holding(
        Arc::clone(&state),
        task_id,
        transition,
        StageTransitionOwnership {
            task_mutation: Some(task_mutation),
            requested_operation: None,
        },
    );
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(response))
}

fn mark_completion_context_succeeded(
    daemon_dir: &str,
    task_id: &str,
    run_id: &str,
    attempt_key: &str,
) {
    let directory = std::path::Path::new(daemon_dir)
        .join("runtime")
        .join("completion");
    let task_path = directory.join(format!("task-{task_id}.json"));
    let legacy_path = directory.join(format!("{run_id}.json"));
    let legacy_shared_path =
        kanna_runtime_defaults::socket_path(&std::path::Path::new(daemon_dir).join("pipeline"))
            .parent()
            .unwrap_or(std::path::Path::new(daemon_dir))
            .join("runtime")
            .join("completion")
            .join(format!("{run_id}.json"));
    let path = if legacy_path.exists() {
        Some(legacy_path)
    } else if task_path.exists() {
        Some(task_path)
    } else if legacy_shared_path.exists() {
        Some(legacy_shared_path)
    } else {
        find_rebound_completion_context(&directory, task_id, run_id).or_else(|| {
            legacy_shared_path
                .parent()
                .and_then(|directory| find_rebound_completion_context(directory, task_id, run_id))
        })
    };
    let Some(path) = path else {
        return;
    };
    if let Err(error) = kanna_tool_catalog::mutate_completion_context(&path, |current| {
        let mut context =
            current.ok_or_else(|| format!("completion context {} disappeared", path.display()))?;
        context.record_completed_attempt(run_id, attempt_key);
        Ok(context)
    }) {
        log::warn!("failed to persist completion retry binding for {run_id}: {error}");
    }
}

fn find_rebound_completion_context(
    directory: &std::path::Path,
    task_id: &str,
    run_id: &str,
) -> Option<std::path::PathBuf> {
    let prefix = format!("run-{task_id}-");
    std::fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("json")
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&prefix))
                && kanna_tool_catalog::read_completion_context(path)
                    .is_ok_and(|context| context.run_id == run_id)
        })
}

/// Optimistic blocker resolution: a task parked at the `pr` stage with a
/// created PR has committed, reviewed, rebased, and pushed work — dependents
/// can start stacking on its branch now rather than waiting for the PR to
/// merge and the task to close. Dormant dependents whose blockers are all
/// resolved get started; dependents with a live workspace get a session
/// message naming the resolved branch. The close path later delivers the
/// "closed" variant of the same message as a catch-up.
async fn unblock_dependents_of_pr_resolved_blocker(state: &Arc<AppState>, task_id: &str) {
    let instructions = {
        let state = Arc::clone(state);
        let task_id = task_id.to_string();
        let gathered = tokio::task::spawn_blocking(move || {
            let db = match Db::open(&state.config.db_path) {
                Ok(db) => db,
                Err(error) => {
                    log::error!("optimistic unblock for {task_id}: db error: {error}");
                    return None;
                }
            };
            let item = match db.get_pipeline_item(&task_id) {
                Ok(Some(item)) => item,
                Ok(None) => return None,
                Err(error) => {
                    log::error!("optimistic unblock for {task_id}: db error: {error}");
                    return None;
                }
            };
            let parked_at_pr_with_pr = item.closed_at.is_none()
                && item.stage.as_deref() == Some("pr")
                && item.pr_url.is_some();
            if !parked_at_pr_with_pr {
                return None;
            }
            match db.list_tasks_blocked_by(&task_id) {
                Ok(dependents) if dependents.is_empty() => return None,
                Ok(_) => {}
                Err(error) => {
                    log::error!("optimistic unblock for {task_id}: db error: {error}");
                    return None;
                }
            }
            match collect_blocker_resolution_instructions(
                &db,
                &task_id,
                BlockerResolution::PrCreated,
            ) {
                Ok(instructions) => Some(instructions),
                Err((_, error)) => {
                    log::error!("optimistic unblock for {task_id}: {error}");
                    Some(Vec::new())
                }
            }
        })
        .await;
        match gathered {
            Ok(Some(instructions)) => instructions,
            Ok(None) => return,
            Err(join_error) => {
                log::error!("optimistic unblock worker failed: {join_error}");
                return;
            }
        }
    };

    let mut daemon =
        match crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir).await {
            Ok(daemon) => daemon,
            Err(error) => {
                log::error!("optimistic unblock for {task_id}: daemon error: {error}");
                return;
            }
        };
    for (session_id, message) in instructions {
        if let Err((_, error)) = submit_task_input(&mut daemon, &session_id, &message).await {
            log::warn!(
                "failed to deliver blocker-resolution instructions to dependent session {session_id}: {error}"
            );
        }
    }
    start_dependents_unblocked_by_close_with_daemon(state, &mut daemon, task_id).await;
    state.publish_state_changed(StateChangeScope::Tasks);
    state.publish_state_changed(StateChangeScope::Blockers);
}

pub(super) async fn request_revision(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::RequestRevisionRequest>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let task_id = resolve_task_id_for_mutation(&state, &task_id).await?;
    let Some(revision_in_flight) = state.begin_requested_task_revision(&task_id) else {
        return Err((
            axum::http::StatusCode::CONFLICT,
            format!("a revision is already in progress for task {task_id}"),
        ));
    };
    let task_mutation = state.begin_requested_task_mutation(&task_id).await;

    #[cfg(test)]
    if let Some(revision_requester) = state.revision_requester.clone() {
        return revision_requester(task_id, payload)
            .map(Json)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let origin = payload.origin.unwrap_or_default();
    // The reviewer's findings live in `prompt`; `summary` is only the headline
    // shown to the user. An agent that sends an empty `prompt` starts an agent
    // with nothing to act on and burns a budgeted round proving it, so the
    // request is refused here — before the round is claimed and before the
    // review run is closed — leaving the reviewer able to retry with the
    // findings. A human request is never refused: the compose path falls back
    // to the terminating run's verdict for it.
    if origin.is_agent() && payload.prompt.trim().is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "revision request carried no reviewer feedback: `prompt` must contain the findings \
             the revising agent has to act on (what is wrong, where, and what must change). \
             `summary` is only the one-line headline shown to the user. No revision was started \
             and no revision round was spent — retry this request with the findings in `prompt`."
                .to_string(),
        ));
    }
    // `resolve_task_id_for_mutation` returned the durable id before either
    // ownership guard was acquired. The nonblocking revision guard is taken
    // before waiting for the broader mutation lease so a duplicate revision
    // is refused immediately instead of sleeping until the first transition
    // lands and then spending another round.
    let source_task_id = task_id;

    let outcome = {
        let state = Arc::clone(&state);
        let source_task_id = source_task_id.clone();
        super::blocking::run_handler_blocking("revision prepare", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            let budget = match crate::task_creator::resolve_revision_budget(&db, &source_task_id) {
                Ok(budget) => budget,
                Err(error) => return Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, error)),
            };

            // Claim a round atomically rather than checking and spending in
            // two steps: `try_claim_agent_revision_round` reads and increments
            // inside one immediate transaction, so concurrent requests cannot
            // both be admitted on the last free slot. `None` means the budget
            // is spent. A human request claims nothing — it is never refused.
            let claimed_round = if origin.is_agent() {
                let claimed = db
                    .try_claim_agent_revision_round(&source_task_id, budget.limit)
                    .map_err(|e| {
                        (
                            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                            format!("db error: {}", e),
                        )
                    })?;
                if claimed.is_none() {
                    // Budget spent: record the review verdict, park the task
                    // where it is, and start nothing. This is the backstop
                    // against a review agent driving a scoped task through
                    // endless revise/review rounds — only a human can hand out
                    // more rounds.
                    return park_exhausted_revision(&db, source_task_id, &payload, budget);
                }
                claimed
            } else {
                None
            };

            // Only a capped agent round is announced to the revising agent as
            // a round; a human-requested revision is the human's own call.
            let round = (origin.is_agent() && budget.limit > 0).then_some(
                crate::task_creator::RevisionRound {
                    number: claimed_round.unwrap_or(budget.rounds + 1),
                    limit: budget.limit,
                },
            );
            // Historically an empty explicit prompt fell back to the verdict
            // after that verdict had already been written to the current run.
            // Resolve the same effective feedback before preparation so a
            // preparation error cannot leave that run falsely terminated.
            let revision_prompt = if payload.prompt.trim().is_empty() {
                &payload.summary
            } else {
                &payload.prompt
            };
            let prepared = match crate::task_creator::prepare_revision_task_for_api(
                &db,
                &state.config,
                &source_task_id,
                &payload.target_stage,
                revision_prompt,
                round,
            ) {
                Ok(prepared) => prepared,
                Err(error) => {
                    // The round was claimed before preparation so the check
                    // and the spend could not be split; preparation failing
                    // means no agent ran, so hand the round back.
                    if claimed_round.is_some() {
                        if let Err(release_error) =
                            db.release_agent_revision_round(&source_task_id)
                        {
                            log::error!(
                                "failed to release revision round for task {source_task_id}: {release_error}"
                            );
                        }
                    }
                    return Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, error));
                }
            };
            // Only close the review run after revision preparation succeeds.
            // An error response above therefore means the verdict and task
            // lifecycle were not advanced behind the caller's back.
            let stage_result = revision_stage_result(&payload.summary, &payload.metadata)?;
            let _ = db
                .finish_latest_running_stage_run(
                    &source_task_id,
                    "failed",
                    Some(&stage_result),
                    Some(&payload.summary),
                )
                .map_err(|e| {
                    (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        format!("db error: {}", e),
                    )
                })?;
            let rounds = match claimed_round {
                Some(rounds) => rounds,
                None => {
                    // A human request spends no round and hands the budget
                    // back, so the agents get a fresh set to satisfy it.
                    db.reset_task_revision_rounds(&source_task_id)
                        .map_err(|e| {
                            (
                                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                                format!("db error: {}", e),
                            )
                        })?;
                    0
                }
            };
            let budget = crate::task_creator::RevisionBudget {
                rounds,
                limit: budget.limit,
            };
            append_revision_requested_event(&db, &source_task_id, &payload, &budget, false)?;
            Ok(RevisionOutcome::Started {
                source_task_id,
                prepared: Box::new(prepared),
                budget,
            })
        })
        .await?
    };

    match outcome {
        RevisionOutcome::Parked {
            source_task_id,
            budget,
        } => {
            state.publish_state_changed(StateChangeScope::Tasks);
            Ok(Json(crate::mobile_api::TaskActionResponse {
                task_id: source_task_id,
                follow_task: None,
                revision_budget: Some(crate::mobile_api::RevisionBudgetStatus {
                    rounds: budget.rounds,
                    limit: budget.limit,
                    exhausted: true,
                    message: format!(
                        "No revision was started: this task has already used its \
                         {limit} automatic revision round(s). The task is parked at its current \
                         stage for its human, who decides whether to revise again. Do not retry \
                         this request — report your findings and stop.",
                        limit = budget.limit,
                    ),
                }),
            }))
        }
        RevisionOutcome::Started {
            source_task_id,
            prepared,
            budget,
        } => {
            // Ownership moves into the worker: the task stays claimed until
            // the revision has actually landed, not just until this response.
            execute_stage_transition_detached_holding(
                Arc::clone(&state),
                source_task_id.clone(),
                crate::task_creator::PreparedStageTransition::Run(prepared),
                StageTransitionOwnership {
                    task_mutation: Some(task_mutation),
                    requested_operation: Some(revision_in_flight),
                },
            );
            state.publish_state_changed(StateChangeScope::Tasks);

            let message = if budget.limit > 0 && origin.is_agent() {
                format!(
                    "Revision round {rounds} of {limit} started.",
                    rounds = budget.rounds,
                    limit = budget.limit,
                )
            } else if budget.limit > 0 {
                format!(
                    "Revision started; the automatic revision budget was reset to 0 of {limit} \
                     round(s).",
                    limit = budget.limit,
                )
            } else {
                "Revision started; this workflow sets no revision-round limit.".to_string()
            };
            Ok(Json(crate::mobile_api::TaskActionResponse {
                task_id: source_task_id,
                follow_task: None,
                revision_budget: Some(crate::mobile_api::RevisionBudgetStatus {
                    rounds: budget.rounds,
                    limit: budget.limit,
                    exhausted: false,
                    message,
                }),
            }))
        }
    }
}

/// Either a revision run to dispatch, or a parked task whose revision budget
/// is spent.
enum RevisionOutcome {
    Parked {
        source_task_id: String,
        budget: crate::task_creator::RevisionBudget,
    },
    Started {
        source_task_id: String,
        prepared: Box<crate::task_creator::PreparedStageRunSpawn>,
        budget: crate::task_creator::RevisionBudget,
    },
}

/// Record the review verdict, park the task at its current stage for its
/// human, and start nothing. Used when the revision-round budget is spent.
fn park_exhausted_revision(
    db: &Db,
    source_task_id: String,
    payload: &crate::mobile_api::RequestRevisionRequest,
    budget: crate::task_creator::RevisionBudget,
) -> Result<RevisionOutcome, (axum::http::StatusCode, String)> {
    let parked_summary = format!(
        "Parked for human review: this task's automatic revision budget \
         ({limit} round(s)) is spent, so Kanna did not start another revision. \
         Review verdict: {summary}",
        limit = budget.limit,
        summary = payload.summary,
    );
    let parked_result = revision_stage_result(&parked_summary, &payload.metadata)?;
    // The requested changes stay on the run as feedback so nothing the
    // reviewer found is lost when the loop stops.
    let _ = db
        .finish_latest_running_stage_run(
            &source_task_id,
            "failed",
            Some(&parked_result),
            Some(&payload.prompt),
        )
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
    db.update_pipeline_item_activity(&source_task_id, "unread")
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
    append_revision_requested_event(db, &source_task_id, payload, &budget, true)?;
    Ok(RevisionOutcome::Parked {
        source_task_id,
        budget,
    })
}

/// A revision request is a state change a watcher cares about whether or not it
/// started anything: an exhausted budget parks the task for its human, which is
/// exactly when an orchestrator must stop waiting for a fix and report.
fn append_revision_requested_event(
    db: &Db,
    task_id: &str,
    payload: &crate::mobile_api::RequestRevisionRequest,
    budget: &crate::task_creator::RevisionBudget,
    exhausted: bool,
) -> Result<(), (axum::http::StatusCode, String)> {
    db.append_task_event(
        task_id,
        crate::db::TaskEventKind::RevisionRequested,
        serde_json::json!({
            "targetStage": payload.target_stage,
            "summary": payload.summary,
            "origin": if payload.origin.unwrap_or_default().is_agent() { "agent" } else { "human" },
            "rounds": budget.rounds,
            "limit": budget.limit,
            "exhausted": exhausted,
        }),
    )
    .map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })
}

/// The `{status, summary, metadata}` verdict JSON a revision request records
/// on the run it closes.
fn revision_stage_result(
    summary: &str,
    metadata: &Option<serde_json::Value>,
) -> Result<String, (axum::http::StatusCode, String)> {
    serde_json::to_string(&serde_json::json!({
        "status": "failure",
        "summary": summary,
        "metadata": metadata,
    }))
    .map_err(|e| {
        (
            axum::http::StatusCode::BAD_REQUEST,
            format!("invalid revision result: {}", e),
        )
    })
}
