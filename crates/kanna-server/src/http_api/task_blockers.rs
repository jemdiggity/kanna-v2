use super::state::{db_write_error, AppState};
use crate::daemon_client::DaemonClient;
use crate::db::{Db, ReplaceTaskBlockersError};
use axum::extract::State;
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use std::sync::Arc;

pub(super) fn resolve_existing_task_id(
    db: &Db,
    task_or_branch_id: &str,
) -> Result<String, (axum::http::StatusCode, String)> {
    db.resolve_pipeline_item_id(task_or_branch_id)
        .map_err(|e| db_write_error("db error", e))?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {}", task_or_branch_id),
            )
        })
}

pub(super) fn resolve_task_blocker_ids(
    db: &Db,
    blocker_task_ids: &[String],
) -> Result<Vec<String>, (axum::http::StatusCode, String)> {
    let mut resolved_blocker_ids = Vec::new();
    for blocker_task_id in blocker_task_ids {
        let blocker_id = resolve_existing_task_id(db, blocker_task_id)?;
        if !resolved_blocker_ids.contains(&blocker_id) {
            resolved_blocker_ids.push(blocker_id);
        }
    }
    Ok(resolved_blocker_ids)
}

pub(super) fn persist_resolved_task_blockers(
    db: &Db,
    task_id: &str,
    resolved_blocker_ids: &[String],
) -> Result<(), (axum::http::StatusCode, String)> {
    db.remove_all_task_blockers(task_id)
        .map_err(|e| db_write_error("db error", e))?;
    persist_task_blocker_rows(db, task_id, resolved_blocker_ids)?;
    db.update_pipeline_item_activity(task_id, "idle")
        .map_err(|e| db_write_error("db error", e))
}

pub(super) fn persist_task_blocker_rows(
    db: &Db,
    task_id: &str,
    resolved_blocker_ids: &[String],
) -> Result<(), (axum::http::StatusCode, String)> {
    for blocker_id in resolved_blocker_ids {
        db.insert_task_blocker(task_id, blocker_id)
            .map_err(|e| db_write_error("db error", e))?;
    }
    Ok(())
}

pub(super) fn apply_task_blockers(
    db: &Db,
    task_or_branch_id: &str,
    blocker_task_ids: &[String],
) -> Result<String, (axum::http::StatusCode, String)> {
    if blocker_task_ids.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "blockerTaskIds must contain at least one task id".to_string(),
        ));
    }

    db.replace_task_blockers_atomically(task_or_branch_id, blocker_task_ids)
        .map_err(task_blocker_replacement_error)
}

fn task_blocker_replacement_error(
    error: ReplaceTaskBlockersError,
) -> (axum::http::StatusCode, String) {
    let status = match error {
        ReplaceTaskBlockersError::TaskNotFound(_)
        | ReplaceTaskBlockersError::BlockerNotFound(_) => axum::http::StatusCode::NOT_FOUND,
        ReplaceTaskBlockersError::SelfDependency | ReplaceTaskBlockersError::CircularDependency => {
            axum::http::StatusCode::BAD_REQUEST
        }
        ReplaceTaskBlockersError::Database(_) => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, error.to_string())
}

/// Same-repo branches a dependent should inherit from its resolved blockers:
/// the first becomes the dependent's base ref, the rest are merged in.
///
/// Only branches git actually has are returned. A blocker that never started
/// its first stage still carries a `pipeline_item.branch`, but no such ref
/// exists — feeding that name to `git worktree add` or `git merge` fails the
/// whole unblock ("not something we can merge") and leaves every dependent
/// permanently dormant. A blocker with nothing to inherit is simply not an
/// inheritance source.
fn blocker_branches_for_task(
    db: &Db,
    blocked_task_id: &str,
) -> Result<Vec<String>, (axum::http::StatusCode, String)> {
    let blocked_task = db
        .get_pipeline_item(blocked_task_id)
        .map_err(|e| db_write_error("db error", e))?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {blocked_task_id}"),
            )
        })?;
    let blocker_ids = db
        .list_task_blocker_ids(blocked_task_id)
        .map_err(|e| db_write_error("db error", e))?;
    let mut branches = Vec::new();
    for blocker_id in blocker_ids {
        let blocker = db
            .get_pipeline_item(&blocker_id)
            .map_err(|e| db_write_error("db error", e))?
            .ok_or_else(|| {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    format!("task not found: {blocker_id}"),
                )
            })?;
        if blocker.repo_id != blocked_task.repo_id {
            continue;
        }
        let Some(branch) = blocker
            .branch
            .as_deref()
            .filter(|branch| !branch.trim().is_empty())
        else {
            continue;
        };
        let repo = db
            .get_repo(&blocker.repo_id)
            .map_err(|e| db_write_error("db error", e))?;
        let Some(repo) = repo else {
            continue;
        };
        let resolved_branch = db
            .get_pipeline_item_pr_branch(&blocker_id)
            .map_err(|e| db_write_error("db error", e))?
            .or_else(|| {
                crate::task_creator::resolve_current_source_worktree_branch(
                    &repo.path,
                    Some(branch),
                )
            })
            .unwrap_or_else(|| branch.to_string());
        if !crate::task_creator::local_branch_exists(&repo.path, &resolved_branch) {
            log::info!(
                "blocker {blocker_id} of {blocked_task_id} has no branch {resolved_branch} to inherit; skipping it"
            );
            continue;
        }
        branches.push(resolved_branch);
    }
    Ok(branches)
}

pub(super) async fn start_dormant_task_if_ready(
    state: &Arc<AppState>,
    task_id: &str,
    blocker_branches: Vec<String>,
) -> Result<bool, (axum::http::StatusCode, String)> {
    let prepared = prepare_dormant_task(state, task_id, blocker_branches).await;
    if matches!(prepared, Ok(None)) {
        return Ok(false);
    }
    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    match prepared {
        Ok(Some(prepared)) => {
            spawn_prepared_dormant_task(state, &mut daemon, prepared).await?;
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(crate::task_creator::DormantStartError::MergeConflict(conflict)) => {
            create_integration_task_for_conflict(state, &mut daemon, task_id, conflict).await?;
            Ok(true)
        }
        Err(crate::task_creator::DormantStartError::Other(error)) => {
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))
        }
    }
}

async fn start_dormant_task_if_ready_with_daemon(
    state: &Arc<AppState>,
    daemon: &mut DaemonClient,
    task_id: &str,
    blocker_branches: Vec<String>,
) -> Result<bool, (axum::http::StatusCode, String)> {
    match prepare_dormant_task(state, task_id, blocker_branches).await {
        Ok(Some(prepared)) => {
            spawn_prepared_dormant_task(state, daemon, prepared).await?;
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(crate::task_creator::DormantStartError::MergeConflict(conflict)) => {
            create_integration_task_for_conflict(state, daemon, task_id, conflict).await?;
            Ok(true)
        }
        Err(crate::task_creator::DormantStartError::Other(error)) => {
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))
        }
    }
}

/// Dormant-task preparation resolves repository definitions (`git fetch
/// origin`) and creates/merges the dependent's worktree — synchronous git
/// work that must run on the blocking pool, never on a runtime worker.
async fn prepare_dormant_task(
    state: &Arc<AppState>,
    task_id: &str,
    blocker_branches: Vec<String>,
) -> Result<Option<crate::task_creator::PreparedTaskSpawn>, crate::task_creator::DormantStartError>
{
    let state = Arc::clone(state);
    let task_id = task_id.to_string();
    tokio::task::spawn_blocking(move || {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            crate::task_creator::DormantStartError::Other(format!("db error: {}", e))
        })?;
        crate::task_creator::prepare_start_dormant_task_for_api(
            &db,
            &state.config,
            &task_id,
            blocker_branches,
        )
    })
    .await
    .map_err(|join_error| {
        crate::task_creator::DormantStartError::Other(format!(
            "dormant start worker failed: {join_error}"
        ))
    })?
}

async fn spawn_prepared_dormant_task(
    state: &Arc<AppState>,
    daemon: &mut DaemonClient,
    prepared: crate::task_creator::PreparedTaskSpawn,
) -> Result<(), (axum::http::StatusCode, String)> {
    crate::task_creator::spawn_prepared_task_for_api_recording_stage_run(
        &state.config.db_path,
        daemon,
        prepared,
    )
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(())
}

async fn create_integration_task_for_conflict(
    state: &Arc<AppState>,
    daemon: &mut DaemonClient,
    dependent_task_id: &str,
    conflict: crate::task_creator::DormantMergeConflict,
) -> Result<(), (axum::http::StatusCode, String)> {
    // Integration-task preparation resolves definitions and creates a merge
    // worktree — synchronous git work behind the blocking boundary.
    let (prepared, previous_blockers) = {
        let state = Arc::clone(state);
        let dependent_task_id = dependent_task_id.to_string();
        super::blocking::run_handler_blocking("integration task prepare", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            let previous_blockers = db
                .list_task_blocker_ids(&dependent_task_id)
                .map_err(|e| db_write_error("db error", e))?;
            let prepared = crate::task_creator::prepare_integration_task_for_api(
                &db,
                &state.config,
                &dependent_task_id,
                &conflict.base_branch,
                &conflict.remaining_branches,
            )
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
            let integration_task_id = prepared.task_id().to_string();
            db.replace_task_blockers_atomically(
                &dependent_task_id,
                std::slice::from_ref(&integration_task_id),
            )
            .map_err(task_blocker_replacement_error)?;
            log::info!(
                "inserted integration task {integration_task_id} for dependent {dependent_task_id} after blocker branch merge conflict on {}",
                conflict.conflicting_branch
            );
            Ok((prepared, previous_blockers))
        })
        .await?
    };

    match crate::task_creator::spawn_prepared_task_for_api_with_diagnostics(
        &state.config.db_path,
        daemon,
        prepared.clone(),
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(error) => {
            // Best-effort blocker restore, also off the runtime.
            let restore_state = Arc::clone(state);
            let restore_task_id = dependent_task_id.to_string();
            let restored = tokio::task::spawn_blocking(move || {
                if let Ok(db) = Db::open(&restore_state.config.db_path) {
                    if let Err(restore_error) =
                        db.replace_task_blockers_atomically(&restore_task_id, &previous_blockers)
                    {
                        log::error!(
                            "failed to restore blockers for {restore_task_id} after integration spawn failure: {restore_error}"
                        );
                    }
                }
            })
            .await;
            if let Err(join_error) = restored {
                log::error!("blocker restore worker failed for {dependent_task_id}: {join_error}");
            }
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))
        }
    }
}

/// Start every dormant dependent whose last blocker just closed. Runs after
/// the blocker's close has already committed, so failures here must never
/// fail the close: each dependent is attempted independently and errors are
/// logged. Historically a swallowed failure in this path left dependents
/// permanently dormant with no trace — log loudly instead.
pub(super) async fn start_dependents_unblocked_by_close_with_daemon(
    state: &Arc<AppState>,
    daemon: &mut DaemonClient,
    blocker_task_id: &str,
) {
    // Discover durable dependent ids first. Readiness is deliberately not
    // decided here: a concurrent re-block or another last-blocker close may
    // commit before this dependent acquires its shared mutation lease.
    let dependent_ids = {
        let state = Arc::clone(state);
        let gather_blocker_task_id = blocker_task_id.to_string();
        let gathered = tokio::task::spawn_blocking(move || {
            let blocker_task_id = gather_blocker_task_id;
            let db = match Db::open(&state.config.db_path) {
                Ok(db) => db,
                Err(error) => {
                    log::error!(
                        "cannot start dependents unblocked by {blocker_task_id}: db error: {error}"
                    );
                    return Vec::new();
                }
            };
            match db.list_tasks_blocked_by(&blocker_task_id) {
                Ok(dependent_ids) => dependent_ids,
                Err(error) => {
                    log::error!(
                        "cannot list dependents of closed blocker {blocker_task_id}: {error}"
                    );
                    Vec::new()
                }
            }
        })
        .await;
        match gathered {
            Ok(dependent_ids) => dependent_ids,
            Err(join_error) => {
                log::error!(
                    "dependent discovery worker failed for closed blocker {blocker_task_id}: {join_error}"
                );
                return;
            }
        }
    };

    for blocked_id in dependent_ids {
        // The same durable-id lease is used by block/unblock, lifecycle
        // actions, and every competing last-blocker close. Hold it through
        // the authoritative blocker re-read, worktree preparation, spawn,
        // and possible integration-task substitution.
        let _dependent_mutation = state.begin_requested_task_mutation(&blocked_id).await;
        let blocker_branches = {
            let state = Arc::clone(state);
            let ready_task_id = blocked_id.clone();
            match tokio::task::spawn_blocking(move || {
                let db = Db::open(&state.config.db_path).map_err(|error| {
                    format!("cannot open db while starting {ready_task_id}: {error}")
                })?;
                match db.count_open_task_blockers(&ready_task_id) {
                    Ok(0) => blocker_branches_for_task(&db, &ready_task_id)
                        .map(Some)
                        .map_err(|(_, error)| error),
                    Ok(_) => Ok(None),
                    Err(error) => Err(format!(
                        "cannot count open blockers for {ready_task_id}: {error}"
                    )),
                }
            })
            .await
            {
                Ok(Ok(Some(blocker_branches))) => blocker_branches,
                Ok(Ok(None)) => continue,
                Ok(Err(error)) => {
                    log::error!("{error}");
                    continue;
                }
                Err(join_error) => {
                    log::error!("dependent readiness worker failed for {blocked_id}: {join_error}");
                    continue;
                }
            }
        };
        match start_dormant_task_if_ready_with_daemon(state, daemon, &blocked_id, blocker_branches)
            .await
        {
            Ok(true) => {
                log::info!(
                    "started dependent task {blocked_id} unblocked by close of {blocker_task_id}"
                );
            }
            Ok(false) => {}
            Err((_, error)) => {
                log::error!(
                    "failed to start dependent task {blocked_id} unblocked by close of {blocker_task_id}: {error}"
                );
            }
        }
    }
}

pub(super) async fn block_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::BlockTaskRequest>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let task_id = super::task_actions::resolve_task_id_for_mutation(&state, &task_id).await?;
    let _task_mutation = state.begin_requested_task_mutation(&task_id).await;
    let task_id = {
        let state = Arc::clone(&state);
        super::blocking::run_handler_blocking("task block", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            apply_task_blockers(&db, &task_id, &payload.blocker_task_ids)
        })
        .await?
    };
    state.publish_state_changed(StateChangeScope::Blockers);
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    }))
}

pub(super) async fn unblock_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let task_id = super::task_actions::resolve_task_id_for_mutation(&state, &task_id).await?;
    let _task_mutation = state.begin_requested_task_mutation(&task_id).await;
    // Blocker-branch resolution shells out to git; the whole discovery and
    // removal section runs behind the blocking boundary.
    let (task_id, blocker_branches) = {
        let state = Arc::clone(&state);
        super::blocking::run_handler_blocking("task unblock", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {}", e),
                )
            })?;
            let task_id = resolve_existing_task_id(&db, &task_id)?;
            let blocker_branches = blocker_branches_for_task(&db, &task_id)?;
            db.replace_task_blockers_atomically(&task_id, &[])
                .map_err(task_blocker_replacement_error)?;
            Ok((task_id, blocker_branches))
        })
        .await?
    };
    start_dormant_task_if_ready(&state, &task_id, blocker_branches).await?;
    state.publish_state_changed(StateChangeScope::Blockers);
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    }))
}
