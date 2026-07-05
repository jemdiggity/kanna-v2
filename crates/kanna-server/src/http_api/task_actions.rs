use super::state::{db_write_error, AppState};
use super::task_blockers::{
    resolve_existing_task_id, start_dependents_unblocked_by_close_with_daemon,
};
use super::task_input::{notify_task_completion, submit_task_input};
use crate::db::Db;
use axum::extract::State;
use axum::Json;
use std::sync::Arc;

fn stage_action_error_status(error: &str) -> axum::http::StatusCode {
    if error.starts_with("task is blocked:") {
        axum::http::StatusCode::CONFLICT
    } else {
        axum::http::StatusCode::INTERNAL_SERVER_ERROR
    }
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
    let created_task = crate::task_creator::spawn_prepared_task_for_api_recording_stage_run(
        &state.config.db_path,
        &mut daemon,
        prepared,
    )
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id: created_task.task_id,
        follow_task: None,
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
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
    }))
}

/// Build per-dependent session messages announcing that a blocker at the
/// `pr` stage has closed. Dependents that already have a workspace need to
/// pull the blocker's work in themselves, and the branch they need is the
/// blocker's *current* branch — the PR stage usually renames it away from
/// the stored fork name, so resolve it from the blocker's worktree HEAD.
fn collect_blocker_close_instructions(
    db: &Db,
    blocker_task_id: &str,
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
    let blocker_title = blocker
        .display_name
        .unwrap_or_else(|| blocker_task_id.to_string());
    let pr_reference = blocker
        .pr_url
        .map(|url| format!(" (PR: {url})"))
        .unwrap_or_default();

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
            "Blocker task \"{blocker_title}\" has finished its pipeline and closed. Its work is on branch `{blocker_branch}`{pr_reference}. Bring that work into this branch now: run `git fetch origin`, then rebase (or merge) this branch onto `{blocker_branch}` — or onto `{default_branch}` instead if that PR has already merged. Resolve conflicts if needed and continue your task."
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
    let blocker_close_instructions = collect_blocker_close_instructions(&db, &pipeline_item_id)?;
    let workspace_teardown = crate::task_creator::prepare_workspace_teardown_for_close(
        &db,
        &state.config,
        &pipeline_item_id,
    );

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
    crate::task_creator::spawn_prepared_workspace_teardown_best_effort(
        &mut daemon,
        workspace_teardown,
    )
    .await;

    db.close_pipeline_item(&pipeline_item_id).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    notify_task_completion(&state.config, &pipeline_item_id, false)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    start_dependents_unblocked_by_close_with_daemon(&state, &mut daemon, &pipeline_item_id).await;

    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// Close a task that advanced past its final pipeline stage. Shared by
/// `advance_stage` and `complete_stage`: hands blocker-close instructions to
/// dependents with workspaces, kills the task's daemon sessions, closes the
/// pipeline item, and delivers the completion notification.
async fn close_task_after_final_stage(
    state: &Arc<AppState>,
    daemon: &mut crate::daemon_client::DaemonClient,
    task_id: String,
    workspace_teardown: Option<crate::task_creator::PreparedWorkspaceTeardown>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let blocker_close_instructions = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        collect_blocker_close_instructions(&db, &task_id)?
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
    crate::task_creator::spawn_prepared_workspace_teardown_best_effort(daemon, workspace_teardown)
        .await;
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
    notify_task_completion(&state.config, &task_id, false)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    start_dependents_unblocked_by_close_with_daemon(state, daemon, &task_id).await;
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: Some(false),
    }))
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

    let transition = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        crate::task_creator::prepare_advance_stage_for_api(&db, &state.config, &task_id)
            .map_err(|e| (stage_action_error_status(&e), e))?
    };
    let response = crate::mobile_api::TaskActionResponse {
        task_id: task_id.clone(),
        follow_task: None,
    };
    execute_stage_transition_detached(Arc::clone(&state), task_id, transition);
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
fn execute_stage_transition_detached(
    state: Arc<AppState>,
    task_id: String,
    transition: crate::task_creator::PreparedStageTransition,
) {
    tokio::spawn(async move {
        let mut daemon =
            match crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir).await {
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
        if let Err((_, message)) = execute_stage_transition(&state, &mut daemon, transition).await {
            log::error!("stage transition for {} failed: {}", task_id, message);
        }
    });
}

pub(super) async fn rerun_stage(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    #[cfg(test)]
    if let Some(stage_rerunner) = state.stage_rerunner.clone() {
        return stage_rerunner(task_id)
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
        crate::task_creator::prepare_rerun_stage_for_api(&db, &state.config, &task_id)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    };
    // Detached for the same reason as execute_stage_transition_detached: the
    // rerun kills the session that may carry this very request.
    let rerun_state = Arc::clone(&state);
    let rerun_task_id = task_id.clone();
    tokio::spawn(async move {
        let mut daemon =
            match crate::daemon_client::DaemonClient::connect(&rerun_state.config.daemon_dir).await
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
        }
    });
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
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

    let (task_id, finished_run) = {
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
        let run_status = if payload.status == "success" {
            "succeeded"
        } else {
            "failed"
        };
        let finished_run = db
            .finish_latest_running_stage_run(
                &task_id,
                run_status,
                Some(&stage_result),
                Some(&payload.summary),
            )
            .map_err(|e| db_write_error("db error", e))?;
        // A parked task has no running run (its last verdict finished it).
        // An agent may recover after reporting failure — e.g. the commit
        // post cleans up and reports success — and that late verdict must
        // both stick and keep its run identity, or a corrected post would
        // never perform its deferred transition.
        let finished_run = match finished_run {
            Some(run) => Some(run),
            None => db
                .refinish_latest_stage_run(
                    &task_id,
                    run_status,
                    Some(&stage_result),
                    Some(&payload.summary),
                )
                .map_err(|e| db_write_error("db error", e))?,
        };
        if payload.status == "success" {
            if let Some(pr_url) = pr_url_from_verdict(payload.metadata.as_ref(), &payload.summary) {
                db.update_pipeline_item_pr(&task_id, pr_number_from_url(&pr_url), &pr_url)
                    .map_err(|e| db_write_error("db error", e))?;
            }
        }
        (task_id, finished_run)
    };

    if !should_auto_advance {
        return Ok(Json(crate::mobile_api::TaskActionResponse {
            task_id,
            follow_task: None,
        }));
    }

    let transition = {
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
        )
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    };
    let Some(transition) = transition else {
        return Ok(Json(crate::mobile_api::TaskActionResponse {
            task_id,
            follow_task: None,
        }));
    };

    let response = crate::mobile_api::TaskActionResponse {
        task_id: task_id.clone(),
        follow_task: None,
    };
    execute_stage_transition_detached(Arc::clone(&state), task_id, transition);
    Ok(Json(response))
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

    execute_stage_transition_detached(
        Arc::clone(&state),
        source_task_id.clone(),
        crate::task_creator::PreparedStageTransition::Run(Box::new(prepared)),
    );

    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id: source_task_id,
        follow_task: None,
    }))
}
