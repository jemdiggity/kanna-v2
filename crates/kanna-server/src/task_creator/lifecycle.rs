use super::environment::{resolve_headless_agent_executable, run_workspace_setup_commands};
use super::types::{
    CreatedTask, PreparedPostDispatch, PreparedRunWorkspace, PreparedSessionSpawn,
    PreparedStageRerun, PreparedStageRunSpawn, PreparedStageTransition, PreparedTaskSpawn,
    PreparedWorkspaceTeardown,
};
use super::worktree::remove_prepared_worktree;
use crate::daemon_client::DaemonClient;
use crate::db::{
    Db, NewStageRun, PendingStageActionTarget, PendingTaskActionRequest, ReplacedStageRunSource,
};
use crate::http_api::{try_submit_task_input, TaskInputError};
use crate::session_replacements::SessionReplacements;
use kanna_daemon::protocol::{
    AgentSpawnParams, Command as DaemonCommand, Event as DaemonEvent, TerminalSnapshot,
};
use std::collections::{HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex, Weak};

const STARTUP_LIFECYCLE_BUFFER_PERIOD: std::time::Duration = std::time::Duration::from_millis(50);
#[cfg(not(test))]
const STARTUP_DAEMON_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
#[cfg(test)]
const STARTUP_DAEMON_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(100);
const SPAWN_RECONCILIATION_ATTEMPTS: usize = 3;
#[cfg(not(test))]
const SPAWN_RECONCILIATION_ATTEMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
#[cfg(test)]
const SPAWN_RECONCILIATION_ATTEMPT_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(50);
#[cfg(not(test))]
const LIVE_SPAWN_RECONCILIATION_BASE_DELAY: std::time::Duration =
    std::time::Duration::from_millis(250);
#[cfg(test)]
const LIVE_SPAWN_RECONCILIATION_BASE_DELAY: std::time::Duration =
    std::time::Duration::from_millis(5);
#[cfg(not(test))]
const LIVE_SPAWN_RECONCILIATION_MAX_DELAY: std::time::Duration = std::time::Duration::from_secs(30);
#[cfg(test)]
const LIVE_SPAWN_RECONCILIATION_MAX_DELAY: std::time::Duration =
    std::time::Duration::from_millis(80);
#[cfg(not(test))]
const LIVE_SPAWN_LIFECYCLE_FENCE_DELAY: std::time::Duration = std::time::Duration::from_millis(50);
#[cfg(test)]
const LIVE_SPAWN_LIFECYCLE_FENCE_DELAY: std::time::Duration = std::time::Duration::from_millis(10);

pub(crate) struct LiveSpawnReconciler {
    active_runs: Mutex<HashSet<String>>,
    shutdown: tokio::sync::watch::Sender<bool>,
    state_changes: tokio::sync::broadcast::Sender<kanna_agent_protocol::ServerFrame>,
}

static LIVE_SPAWN_RECONCILERS: std::sync::LazyLock<
    Mutex<std::collections::HashMap<String, Weak<LiveSpawnReconciler>>>,
> = std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

pub(crate) fn register_live_spawn_reconciler(
    db_path: &str,
    state_changes: tokio::sync::broadcast::Sender<kanna_agent_protocol::ServerFrame>,
) -> Arc<LiveSpawnReconciler> {
    let (shutdown, _) = tokio::sync::watch::channel(false);
    let reconciler = Arc::new(LiveSpawnReconciler {
        active_runs: Mutex::new(HashSet::new()),
        shutdown,
        state_changes,
    });
    LIVE_SPAWN_RECONCILERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(db_path.to_string(), Arc::downgrade(&reconciler));
    reconciler
}

pub(crate) fn shutdown_live_spawn_reconciler(reconciler: &LiveSpawnReconciler) {
    reconciler.shutdown.send_replace(true);
}

enum SpawnAcceptanceReconciliation {
    Accepted,
    Rejected(String),
    Indeterminate(String),
}

#[cfg(test)]
struct LivePostReservationPause {
    reached: std::sync::Arc<tokio::sync::Semaphore>,
    release: std::sync::Arc<tokio::sync::Semaphore>,
}

#[cfg(test)]
static LIVE_POST_RESERVATION_PAUSES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, LivePostReservationPause>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[cfg(test)]
static LIVE_POST_DELIVERY_PAUSES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, LivePostReservationPause>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[cfg(test)]
pub(crate) fn pause_next_live_post_after_reservation(
    key: &str,
) -> (
    std::sync::Arc<tokio::sync::Semaphore>,
    std::sync::Arc<tokio::sync::Semaphore>,
) {
    let reached = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
    let release = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
    LIVE_POST_RESERVATION_PAUSES.lock().unwrap().insert(
        key.to_string(),
        LivePostReservationPause {
            reached: std::sync::Arc::clone(&reached),
            release: std::sync::Arc::clone(&release),
        },
    );
    (reached, release)
}

#[cfg(test)]
pub(crate) fn pause_next_live_post_after_delivery(
    key: &str,
) -> (
    std::sync::Arc<tokio::sync::Semaphore>,
    std::sync::Arc<tokio::sync::Semaphore>,
) {
    let reached = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
    let release = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
    LIVE_POST_DELIVERY_PAUSES.lock().unwrap().insert(
        key.to_string(),
        LivePostReservationPause {
            reached: std::sync::Arc::clone(&reached),
            release: std::sync::Arc::clone(&release),
        },
    );
    (reached, release)
}

#[cfg(test)]
async fn pause_live_post_after_reservation(key: Option<&str>) {
    let pause = key.and_then(|key| LIVE_POST_RESERVATION_PAUSES.lock().unwrap().remove(key));
    if let Some(pause) = pause {
        pause.reached.add_permits(1);
        let _ = pause.release.acquire().await;
    }
}

#[cfg(test)]
async fn pause_live_post_after_delivery(key: Option<&str>) {
    let pause = key.and_then(|key| LIVE_POST_DELIVERY_PAUSES.lock().unwrap().remove(key));
    if let Some(pause) = pause {
        pause.reached.add_permits(1);
        let _ = pause.release.acquire().await;
    }
}

#[derive(Debug)]
pub(crate) enum StageSpawnError {
    Failed(String),
    Indeterminate(String),
}

impl StageSpawnError {
    pub(crate) fn is_indeterminate(&self) -> bool {
        matches!(self, Self::Indeterminate(_))
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, pattern: &str) -> bool {
        self.to_string().contains(pattern)
    }
}

impl From<String> for StageSpawnError {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

impl std::fmt::Display for StageSpawnError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed(error) | Self::Indeterminate(error) => formatter.write_str(error),
        }
    }
}

pub(crate) fn prepared_task_id(prepared: &PreparedTaskSpawn) -> &str {
    &prepared.created_task.task_id
}

/// Resolve stage actions that were durably reserved when the server exited.
/// This runs before HTTP services start, so no new action can replace the
/// pending successor while recovery compares it with daemon ownership.
pub(crate) async fn reconcile_pending_stage_actions_on_startup(
    config: &crate::config::Config,
) -> Result<Option<crate::terminal_watcher::StartupLifecycleHandoff>, String> {
    let actions = Db::open(&config.db_path)
        .map_err(|error| format!("startup action reconciliation db error: {error}"))?
        .pending_stage_actions()
        .map_err(|error| format!("startup action reconciliation query failed: {error}"))?;
    if actions.is_empty() {
        return Ok(None);
    }

    let mut lifecycle = DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|error| format!("startup action lifecycle subscription failed: {error}"))?;
    lifecycle
        .send_one_way(&DaemonCommand::SubscribeEvents {
            version: kanna_daemon::protocol::CURRENT_EVENT_STREAM_VERSION,
        })
        .await
        .map_err(|error| format!("startup action lifecycle subscribe failed: {error}"))?;
    match tokio::time::timeout(STARTUP_DAEMON_RESPONSE_TIMEOUT, lifecycle.read_event())
        .await
        .map_err(|_| "startup action lifecycle acknowledgement timed out".to_string())?
        .map_err(|error| format!("startup action lifecycle acknowledgement failed: {error}"))?
    {
        DaemonEvent::Ok => {}
        DaemonEvent::Error { message, .. } => {
            return Err(format!(
                "startup action lifecycle subscription rejected: {message}"
            ));
        }
        other => {
            return Err(format!(
                "unexpected startup action lifecycle acknowledgement: {other:?}"
            ));
        }
    }

    let mut daemon = DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|error| format!("startup action reconciliation daemon error: {error}"))?;
    let listed = tokio::time::timeout(STARTUP_DAEMON_RESPONSE_TIMEOUT, daemon.list())
        .await
        .map_err(|_| "startup action reconciliation list timed out".to_string())?
        .map_err(|error| format!("startup action reconciliation list failed: {error}"))?;
    let expected_successors = actions
        .iter()
        .map(|action| {
            (
                action.session_id.clone(),
                Some(action.successor_run_id.clone()),
            )
        })
        .collect::<HashSet<_>>();
    let mut exited_successors = HashSet::new();
    let mut landed_successors = HashSet::new();
    let mut buffered_lifecycle_events = VecDeque::new();
    let lifecycle_deadline = tokio::time::Instant::now() + STARTUP_LIFECYCLE_BUFFER_PERIOD;
    loop {
        match tokio::time::timeout_at(lifecycle_deadline, lifecycle.read_event()).await {
            Err(_) => break,
            Ok(Ok(event)) => {
                match &event {
                    DaemonEvent::Exit {
                        session_id,
                        run_id,
                        killed: false,
                        ..
                    } => {
                        let owner = (session_id.clone(), run_id.clone());
                        if expected_successors.contains(&owner) {
                            exited_successors.insert(owner);
                        }
                    }
                    DaemonEvent::ShuttingDown => {
                        return Err(
                            "daemon shut down during startup action lifecycle reconciliation"
                                .to_string(),
                        );
                    }
                    _ => {}
                }
                buffered_lifecycle_events.push_back(event);
            }
            Ok(Err(error)) => {
                return Err(format!(
                    "startup action lifecycle subscription failed: {error}"
                ));
            }
        }
    }

    for action in actions {
        let successor_is_live = listed.sessions.iter().any(|session| {
            session.session_id == action.session_id
                && session.run_id.as_deref() == Some(action.successor_run_id.as_str())
                && matches!(session.state, kanna_daemon::protocol::SessionState::Active)
                && !exited_successors.contains(&(
                    session.session_id.clone(),
                    Some(action.successor_run_id.clone()),
                ))
        });
        let db = Db::open(&config.db_path)
            .map_err(|error| format!("startup action reconciliation db error: {error}"))?;
        if successor_is_live {
            db.land_pending_stage_action(&action).map_err(|error| {
                format!(
                    "failed to land recovered successor {} for task {}: {}",
                    action.successor_run_id, action.task_id, error
                )
            })?;
            landed_successors.insert(action.successor_run_id.clone());
            log::info!(
                "landed recovered successor {} for task {}",
                action.successor_run_id,
                action.task_id
            );
        } else {
            db.rollback_pending_stage_action(&action).map_err(|error| {
                format!(
                    "failed to restore source for pending successor {} on task {}: {}",
                    action.successor_run_id, action.task_id, error
                )
            })?;
            // Restore durable task ownership before touching the filesystem.
            // If workspace cleanup is interrupted or fails, the normal
            // orphan-worktree reconciliation can retry it without leaving
            // the source run closed or blocking all new task actions.
            if action.remove_worktree_on_rollback {
                let path = action.target_worktree_path.as_deref().ok_or_else(|| {
                    format!(
                        "pending successor {} is missing rollback worktree path",
                        action.successor_run_id
                    )
                })?;
                let branch = action.target_worktree_branch.as_deref().ok_or_else(|| {
                    format!(
                        "pending successor {} is missing rollback branch",
                        action.successor_run_id
                    )
                })?;
                if let Err(error) = remove_prepared_worktree(path, branch) {
                    log::warn!(
                        "restored source for pending successor {} but could not remove \
                         its unaccepted workspace; startup worktree reconciliation will retry: {}",
                        action.successor_run_id,
                        error
                    );
                }
            }
            log::info!(
                "restored source after unaccepted successor {} for task {}",
                action.successor_run_id,
                action.task_id
            );
        }
    }
    Ok(Some(crate::terminal_watcher::StartupLifecycleHandoff {
        daemon: lifecycle,
        buffered: buffered_lifecycle_events,
        recovered_successor_run_ids: landed_successors,
    }))
}

pub(crate) fn rollback_prepared_task_for_api(
    db: &Db,
    prepared: &PreparedTaskSpawn,
) -> Result<(), String> {
    let task_id = prepared_task_id(prepared);
    let db_result = db
        .delete_task_creation_artifacts(task_id)
        .map_err(|e| format!("db rollback error: {}", e));
    let worktree_result = remove_prepared_worktree(&prepared.cwd, &prepared.branch);

    match (db_result, worktree_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(db_err), Ok(())) => Err(db_err),
        (Ok(()), Err(worktree_err)) => Err(worktree_err),
        (Err(db_err), Err(worktree_err)) => Err(format!("{db_err}; {worktree_err}")),
    }
}

pub(super) async fn spawn_prepared_task(
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<CreatedTask, String> {
    if let Some(snapshot) = prepared.recovery_snapshot.as_ref() {
        seed_recovery_snapshot(daemon, &prepared.session_id, snapshot).await?;
    }
    let command = spawn_session_command(
        prepared.session_id,
        prepared.cwd,
        prepared.env,
        None,
        prepared.session,
    );

    let event = daemon
        .send_command(&command)
        .await
        .map_err(|e| format!("daemon error: {}", e))?;

    match event {
        DaemonEvent::SessionCreated { .. } => Ok(prepared.created_task),
        DaemonEvent::Error { message, .. } => Err(format!("daemon error: {}", message)),
        other => Err(format!("unexpected daemon response: {:?}", other)),
    }
}

async fn seed_recovery_snapshot(
    daemon: &mut DaemonClient,
    session_id: &str,
    snapshot: &crate::mobile_api::CreateTaskRecoverySnapshot,
) -> Result<(), String> {
    let event = daemon
        .send_command(&DaemonCommand::SeedSnapshot {
            session_id: session_id.to_string(),
            snapshot: TerminalSnapshot {
                version: 1,
                rows: snapshot.rows,
                cols: snapshot.cols,
                cursor_row: snapshot.cursor_row,
                cursor_col: snapshot.cursor_col,
                cursor_visible: snapshot.cursor_visible,
                saved_at: snapshot.saved_at,
                sequence: snapshot.sequence,
                vt: snapshot.serialized.clone(),
            },
        })
        .await
        .map_err(|error| format!("daemon recovery seed error: {error}"))?;
    match event {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error { message, .. } => Err(format!("daemon recovery seed error: {message}")),
        other => Err(format!(
            "unexpected daemon recovery seed response: {other:?}"
        )),
    }
}

pub(crate) async fn spawn_prepared_task_for_api(
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
    let created = spawn_prepared_task(daemon, prepared).await?;
    Ok(crate::mobile_api::CreateTaskResponse {
        task_id: created.task_id,
        repo_id: created.repo_id,
        title: created.title,
        prompt: created.prompt,
        stage: created.stage,
        agent_type: created.agent_type,
        worktree_path: Some(created.worktree_path),
    })
}

pub(crate) async fn spawn_prepared_task_for_api_recording_stage_run(
    db_path: &str,
    daemon: &mut DaemonClient,
    mut prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
    let resumes_headless_provider = matches!(
        &prepared.session,
        PreparedSessionSpawn::Agent {
            resume_session_id: Some(session_id),
            ..
        } if !session_id.trim().is_empty()
    );
    if resumes_headless_provider {
        let compatibility = async {
            let capabilities = daemon
                .capabilities()
                .await
                .map_err(|error| format!("daemon capability negotiation failed: {error}"))?;
            crate::daemon_client::require_provider_resume(&capabilities)
        }
        .await;
        if let Err(error) = compatibility {
            let rollback_db_path = db_path.to_string();
            let rollback_prepared = prepared.clone();
            let rollback = tokio::task::spawn_blocking(move || {
                let db =
                    Db::open(&rollback_db_path).map_err(|e| format!("db rollback error: {e}"))?;
                rollback_prepared_task_for_api(&db, &rollback_prepared)
            })
            .await
            .map_err(|join_error| format!("task resume rollback worker failed: {join_error}"))?;
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; {rollback_error}"),
            });
        }
    }

    let run_id = generate_stage_run_id(&prepared.created_task.task_id);
    prepared.session_id = run_id.clone();
    prepared
        .env
        .insert("KANNA_STAGE_RUN_ID".to_string(), run_id.clone());
    let record_db_path = db_path.to_string();
    let pending = prepared.clone();
    let pending_run_id = run_id.clone();
    tokio::task::spawn_blocking(move || {
        record_spawned_stage_run(&record_db_path, &pending, &pending_run_id)
    })
    .await
    .map_err(|join_error| format!("stage run record worker failed: {join_error}"))??;

    match spawn_prepared_task_for_api(daemon, prepared.clone()).await {
        Ok(created) => {
            let record_db_path = db_path.to_string();
            let task_id = prepared.created_task.task_id.clone();
            let landing_run_id = run_id.clone();
            let landing = tokio::task::spawn_blocking(move || {
                let db = Db::open(&record_db_path).map_err(|e| format!("db error: {e}"))?;
                db.start_initial_stage_run_if_current(&task_id, &landing_run_id)
                    .map_err(|e| format!("db error: {e}"))
            })
            .await
            .map_err(|join_error| format!("stage run start worker failed: {join_error}"))?;
            match landing {
                Ok(()) => Ok(created),
                Err(error) => {
                    let kill_result = match daemon
                        .send_command(&DaemonCommand::Kill {
                            session_id: prepared.session_id.clone(),
                            expected_run_id: Some(run_id.clone()),
                        })
                        .await
                    {
                        Ok(DaemonEvent::Ok)
                        | Ok(DaemonEvent::Error {
                            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                            ..
                        }) => Ok(()),
                        Ok(DaemonEvent::Error { message, .. }) => {
                            Err(format!("daemon error: {message}"))
                        }
                        Ok(other) => Err(format!("unexpected daemon response: {other:?}")),
                        Err(kill_error) => Err(kill_error.to_string()),
                    };
                    let rollback_db_path = db_path.to_string();
                    let rollback_run_id = run_id.clone();
                    let rollback = tokio::task::spawn_blocking(move || {
                        Db::open(&rollback_db_path)
                            .and_then(|db| {
                                db.delete_unstarted_stage_run_and_restore_provider_session_id(
                                    &rollback_run_id,
                                )
                            })
                            .map_err(|db_error| format!("db error: {db_error}"))
                    })
                    .await
                    .map_err(|join_error| {
                        format!("stage run rollback worker failed: {join_error}")
                    })?;
                    let mut message = format!(
                        "task {} spawn could not land: {error}",
                        prepared.created_task.task_id
                    );
                    if let Err(kill_error) = kill_result {
                        message
                            .push_str(&format!("; guarded session cleanup failed: {kill_error}"));
                    }
                    if let Err(rollback_error) = rollback {
                        message
                            .push_str(&format!("; pending run rollback failed: {rollback_error}"));
                    }
                    Err(message)
                }
            }
        }
        Err(error) => {
            let record_db_path = db_path.to_string();
            let failure = error.clone();
            tokio::task::spawn_blocking(move || {
                let db = Db::open(&record_db_path).map_err(|e| format!("db error: {e}"))?;
                record_prepared_task_spawn_failure(&db, &prepared, &run_id, &failure)
            })
            .await
            .map_err(|join_error| format!("spawn diagnostics worker failed: {join_error}"))??;
            Err(error)
        }
    }
}

pub(crate) async fn spawn_prepared_task_for_api_with_diagnostics(
    db_path: &str,
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<crate::mobile_api::CreateTaskResponse, String> {
    match spawn_prepared_task_for_api_recording_stage_run(db_path, daemon, prepared.clone()).await {
        Ok(created) => Ok(created),
        Err(err) => Err(format!(
            "task {} failed to spawn: {err}",
            prepared.created_task.task_id
        )),
    }
}

/// Spawn a new stage run on an existing task: kill the previous stage's
/// agent session and respawn the same daemon session id with the target
/// stage's agent. A stage transition runs in a freshly forked workspace
/// (new branch + worktree from the committed tip) and moves
/// `pipeline_item.branch` with it; a resumed revision moves the branch back
/// to the adopted previous workspace; post fallbacks and reruns keep the
/// task's current workspace. The task id never changes.
pub(crate) async fn spawn_prepared_stage_run_for_api(
    db_path: &str,
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    mut prepared: PreparedStageRunSpawn,
) -> Result<crate::mobile_api::TaskActionResponse, StageSpawnError> {
    let task_id = prepared.task_id.clone();
    let source_session_id = prepared.source_session_id.clone();
    let blocking_teardown_session_id =
        prepared.blocking_teardown_session_id.clone().or_else(|| {
            matches!(prepared.workspace, PreparedRunWorkspace::Forked(_))
                .then(|| {
                    prepared
                        .workspace_teardown
                        .as_ref()
                        .map(|teardown| teardown.session_id.clone())
                })
                .flatten()
        });

    if prepared.resumed_from_run_id.is_some() {
        let source_run_id = prepared
            .expected_source
            .process_run_id
            .as_deref()
            .ok_or_else(|| {
                StageSpawnError::Failed(
                    "provider resume requires an exact source process owner".to_string(),
                )
            })?;
        let listed = daemon
            .list()
            .await
            .map_err(|error| format!("daemon capability negotiation failed: {error}"))?;
        crate::daemon_client::require_owned_provider_resume(
            &listed,
            &prepared.source_session_id,
            source_run_id,
        )?;
    }

    // Establish immutable ownership before the daemon can emit lifecycle
    // events. The same token is inherited by the child process and echoed by
    // the daemon on SessionCreated, ProviderSessionChanged, and Exit.
    let run_id = generate_stage_run_id(&task_id);
    let session_id = run_id.clone();
    prepared
        .env
        .insert("KANNA_STAGE_RUN_ID".to_string(), run_id.clone());
    if let Some(provider_session_id) = prepared.provider_session_id.as_ref() {
        prepared.env.insert(
            "KANNA_PROVIDER_SESSION_ID".to_string(),
            provider_session_id.clone(),
        );
    }
    let (target_branch, target_worktree) = match &prepared.workspace {
        PreparedRunWorkspace::Forked(workspace) | PreparedRunWorkspace::Resumed(workspace) => (
            Some(workspace.branch.clone()),
            Some((
                format!("wt-{task_id}"),
                workspace.worktree_path.clone(),
                workspace.branch.clone(),
            )),
        ),
        PreparedRunWorkspace::Current => (None, None),
    };
    let action_success_body = prepared
        .action_request_key
        .as_ref()
        .map(|_| {
            prepared.action_success_body.clone().map_or_else(
                || {
                    serde_json::to_string(&crate::mobile_api::TaskActionResponse {
                        task_id: task_id.clone(),
                        follow_task: None,
                        revision_budget: None,
                    })
                },
                Ok,
            )
        })
        .transpose()
        .map_err(|error| format!("failed to serialize task action result: {error}"))?;
    // Reserving the successor atomically snapshots the source row and marks
    // a still-running source accepted before the kill. If that kill fails,
    // rollback can therefore restore the exact pre-action source status.
    let replaced_source = {
        let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
        match db.replace_current_run_with_pending_action(
            NewStageRun {
                id: &run_id,
                task_id: &task_id,
                stage: &prepared.run_stage,
                kind: prepared.run_kind,
                agent: prepared.stage_agent.as_deref(),
                agent_provider: Some(prepared.agent_provider.as_str()),
                model: prepared.model.as_deref(),
                status: "pending",
                result: None,
                feedback: prepared.feedback.as_deref(),
                session_id: Some(&session_id),
                provider_session_id: prepared.provider_session_id.as_deref(),
                cwd: Some(&prepared.cwd),
                resumed_from_run_id: prepared.resumed_from_run_id.as_deref(),
            },
            Some(prepared.completion_transition.as_str()),
            &prepared.expected_source,
            prepared.source_completion_status,
            prepared.source_completion_result.as_deref(),
            prepared.source_completion_feedback.as_deref(),
            PendingStageActionTarget {
                session_id: &session_id,
                stage: &prepared.next_stage,
                branch: target_branch.as_deref(),
                worktree: target_worktree
                    .as_ref()
                    .map(|(id, path, branch)| (id.as_str(), path.as_str(), branch.as_str())),
                remove_worktree_on_rollback: matches!(
                    &prepared.workspace,
                    PreparedRunWorkspace::Forked(_)
                ),
                action_request: prepared
                    .action_request_key
                    .as_deref()
                    .map(|idempotency_key| PendingTaskActionRequest {
                        idempotency_key,
                        success_status: 200,
                        success_response_body: action_success_body
                            .as_deref()
                            .expect("action request response was serialized"),
                    }),
            },
        ) {
            Ok(source) => source,
            Err(error) => {
                let message = if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
                    format!("task {task_id} changed while the stage action was being prepared")
                } else {
                    format!("db error: {error}")
                };
                return Err(rollback_prepared_stage_fork(&prepared, message).into());
            }
        }
    };

    // Only a freshly forked workspace is rolled back on failure; a resumed
    // workspace pre-exists this spawn and must survive it.
    if let Err(error) = kill_session_replacing_if_owned(
        daemon,
        replacements,
        &source_session_id,
        prepared.expected_source.process_run_id.as_deref(),
    )
    .await
    {
        return Err(rollback_prepared_stage_reservation(
            db_path,
            &run_id,
            &prepared,
            replaced_source.as_ref(),
            error,
        )
        .into());
    }
    if !matches!(prepared.workspace, PreparedRunWorkspace::Current) {
        // The prewarmed shell session points at the previous worktree; kill
        // it so the next ⌘J opens in the run's workspace.
        if let Err(error) =
            kill_session_replacing(daemon, replacements, &format!("shell-wt-{task_id}")).await
        {
            return Err(fail_prepared_stage_spawn(db_path, &run_id, &prepared, error).into());
        }
        if let Some(teardown_session_id) = blocking_teardown_session_id.as_deref() {
            if let Err(error) =
                kill_session_replacing(daemon, replacements, teardown_session_id).await
            {
                return Err(fail_prepared_stage_spawn(
                    db_path,
                    &run_id,
                    &prepared,
                    format!(
                        "failed to stop workspace teardown session {teardown_session_id}: {error}"
                    ),
                )
                .into());
            }
        }
    }
    if let Err(error) = prepare_deferred_stage_setup(&mut prepared) {
        return Err(fail_prepared_stage_spawn(db_path, &run_id, &prepared, error).into());
    }

    let command = spawn_session_command(
        session_id.clone(),
        prepared.cwd.clone(),
        prepared.env.clone(),
        prepared.terminal_prelude.clone(),
        prepared.session.clone(),
    );
    let spawn_result = daemon
        .send_command(&command)
        .await
        .map_err(|error| format!("daemon error: {error}"));
    let event = match spawn_result {
        Ok(event) => Some(event),
        Err(command_error) => {
            match reconcile_spawn_acceptance(daemon, &session_id, &run_id).await {
                SpawnAcceptanceReconciliation::Accepted => None,
                SpawnAcceptanceReconciliation::Rejected(reconcile_error) => {
                    return Err(fail_prepared_stage_spawn(
                        db_path,
                        &run_id,
                        &prepared,
                        format!("{command_error}; {reconcile_error}"),
                    )
                    .into());
                }
                SpawnAcceptanceReconciliation::Indeterminate(reconcile_error) => {
                    reconcile_indeterminate_spawn_in_background(
                        db_path.to_string(),
                        daemon.daemon_dir().to_string(),
                        run_id.clone(),
                    );
                    return Err(StageSpawnError::Indeterminate(format!(
                    "{command_error}; {reconcile_error}; successor reservation retained for live reconciliation"
                )));
                }
            }
        }
    };
    match event {
        None => {}
        Some(DaemonEvent::SessionCreated {
            run_id: Some(created_run_id),
            ..
        }) if created_run_id == run_id => {}
        Some(DaemonEvent::SessionCreated { run_id: None, .. })
            if prepared.resumed_from_run_id.is_none() => {}
        Some(DaemonEvent::SessionCreated {
            run_id: created_run_id,
            ..
        }) => {
            let ownership_error = format!(
                "daemon returned mismatched run ownership (expected {run_id}, got {created_run_id:?})"
            );
            if let Err(cleanup_error) =
                kill_session_replacing(daemon, replacements, &session_id).await
            {
                log::warn!(
                    "failed to clean up mismatched stage session {session_id}: {cleanup_error}"
                );
            }
            return Err(
                fail_prepared_stage_spawn(db_path, &run_id, &prepared, ownership_error).into(),
            );
        }
        Some(DaemonEvent::Error { message, .. }) => {
            return Err(fail_prepared_stage_spawn(
                db_path,
                &run_id,
                &prepared,
                format!("daemon error: {}", message),
            )
            .into())
        }
        Some(other) => {
            return Err(fail_prepared_stage_spawn(
                db_path,
                &run_id,
                &prepared,
                format!("unexpected daemon response: {:?}", other),
            )
            .into())
        }
    }

    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    if let Err(error) = db.land_stage_run_if_reserved(
        &task_id,
        &run_id,
        &prepared.next_stage,
        target_branch.as_deref(),
        target_worktree
            .as_ref()
            .map(|(id, path, branch)| (id.as_str(), path.as_str(), branch.as_str())),
        Some(&prepared.expected_source),
    ) {
        if let Err(kill_error) =
            kill_session_replacing_if_owned(daemon, replacements, &session_id, Some(&run_id)).await
        {
            log::warn!("failed to clean up unlanded stage session {session_id}: {kill_error}");
        }
        let message = format!("task {task_id} stage transition could not land: {error}");
        return Err(if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
            rollback_closed_stage_spawn(db_path, &run_id, &prepared, message)
        } else {
            fail_prepared_stage_spawn(db_path, &run_id, &prepared, message)
        }
        .into());
    }

    spawn_prepared_workspace_teardown_best_effort(daemon, prepared.workspace_teardown).await;

    Ok(crate::mobile_api::TaskActionResponse {
        task_id,
        follow_task: None,
        revision_budget: None,
    })
}

fn fail_prepared_stage_spawn(
    db_path: &str,
    run_id: &str,
    prepared: &PreparedStageRunSpawn,
    error: String,
) -> String {
    let recorded_error = match Db::open(db_path).and_then(|db| {
        db.finish_stage_run(run_id, "failed", Some(&error), Some("stage spawn failed"))
    }) {
        Ok(()) => error,
        Err(db_error) => format!("{error}; failed to record stage spawn failure: {db_error}"),
    };
    rollback_prepared_stage_fork(prepared, recorded_error)
}

fn prepare_deferred_stage_setup(prepared: &mut PreparedStageRunSpawn) -> Result<(), String> {
    if prepared.deferred_setup.is_empty() {
        return Ok(());
    }
    run_workspace_setup_commands(&prepared.deferred_setup, &prepared.cwd, &prepared.env)?;
    let PreparedSessionSpawn::Agent {
        agent_provider,
        executable,
        ..
    } = &mut prepared.session
    else {
        return Err("deferred resumed setup requires a headless agent session".to_string());
    };
    *executable = resolve_headless_agent_executable(
        *agent_provider,
        prepared.env.get("PATH").map(String::as_str),
        &prepared.cwd,
    )?;
    prepared.deferred_setup.clear();
    Ok(())
}

fn rollback_prepared_stage_reservation(
    db_path: &str,
    run_id: &str,
    prepared: &PreparedStageRunSpawn,
    replaced_source: Option<&ReplacedStageRunSource>,
    error: String,
) -> String {
    let rollback_error = match Db::open(db_path).and_then(|db| {
        db.rollback_pending_replacement_and_restore_source(
            &prepared.task_id,
            run_id,
            &prepared.expected_source,
            replaced_source,
        )
    }) {
        Ok(()) => error,
        Err(db_error) => {
            format!("{error}; failed to restore source stage ownership: {db_error}")
        }
    };
    rollback_prepared_stage_fork(prepared, rollback_error)
}

fn rollback_closed_stage_spawn(
    db_path: &str,
    run_id: &str,
    prepared: &PreparedStageRunSpawn,
    error: String,
) -> String {
    let rollback_error = match Db::open(db_path)
        .and_then(|db| db.delete_unstarted_stage_run_and_restore_provider_session_id(run_id))
    {
        Ok(()) => error,
        Err(db_error) => format!("{error}; failed to roll back unstarted stage run: {db_error}"),
    };
    rollback_prepared_stage_fork(prepared, rollback_error)
}

fn rollback_prepared_stage_fork(prepared: &PreparedStageRunSpawn, error: String) -> String {
    if let PreparedRunWorkspace::Forked(fork) = &prepared.workspace {
        if let Err(rollback_err) = remove_prepared_worktree(&fork.worktree_path, &fork.branch) {
            return format!("{error}; fork rollback failed: {rollback_err}");
        }
    }
    error
}

pub(crate) fn rollback_prepared_stage_transition_for_api(
    transition: &PreparedStageTransition,
) -> Result<(), String> {
    let PreparedStageTransition::Run(prepared) = transition else {
        return Ok(());
    };
    let PreparedRunWorkspace::Forked(fork) = &prepared.workspace else {
        return Ok(());
    };
    remove_prepared_worktree(&fork.worktree_path, &fork.branch)
}

async fn reconcile_spawn_acceptance(
    daemon: &mut DaemonClient,
    session_id: &str,
    run_id: &str,
) -> SpawnAcceptanceReconciliation {
    let mut failures = Vec::with_capacity(SPAWN_RECONCILIATION_ATTEMPTS);
    for attempt in 1..=SPAWN_RECONCILIATION_ATTEMPTS {
        let listed =
            tokio::time::timeout(SPAWN_RECONCILIATION_ATTEMPT_TIMEOUT, async {
                daemon.reconnect().await.map_err(|error| {
                    format!("spawn reconciliation could not reconnect: {error}")
                })?;
                daemon.list().await.map_err(|error| {
                    format!("spawn reconciliation could not list sessions: {error}")
                })
            })
            .await;
        let sessions = match listed {
            Ok(Ok(sessions)) => sessions,
            Ok(Err(error)) => {
                failures.push(format!("attempt {attempt}: {error}"));
                continue;
            }
            Err(_) => {
                failures.push(format!(
                    "attempt {attempt}: spawn reconciliation timed out after {:?}",
                    SPAWN_RECONCILIATION_ATTEMPT_TIMEOUT
                ));
                continue;
            }
        };
        return classify_spawn_acceptance(&sessions, session_id, run_id);
    }
    SpawnAcceptanceReconciliation::Indeterminate(format!(
        "spawn reconciliation remained indeterminate after {SPAWN_RECONCILIATION_ATTEMPTS} attempts ({})",
        failures.join("; ")
    ))
}

async fn reconcile_spawn_acceptance_with_lifecycle_fence(
    daemon_dir: &str,
    session_id: &str,
    run_id: &str,
) -> SpawnAcceptanceReconciliation {
    let mut lifecycle = match tokio::time::timeout(
        SPAWN_RECONCILIATION_ATTEMPT_TIMEOUT,
        DaemonClient::connect(daemon_dir),
    )
    .await
    {
        Ok(Ok(lifecycle)) => lifecycle,
        Ok(Err(error)) => {
            return SpawnAcceptanceReconciliation::Indeterminate(format!(
                "spawn lifecycle fence could not connect: {error}"
            ));
        }
        Err(_) => {
            return SpawnAcceptanceReconciliation::Indeterminate(
                "spawn lifecycle fence connection timed out".to_string(),
            );
        }
    };
    let subscription = tokio::time::timeout(SPAWN_RECONCILIATION_ATTEMPT_TIMEOUT, async {
        lifecycle
            .send_one_way(&DaemonCommand::SubscribeEvents {
                version: kanna_daemon::protocol::CURRENT_EVENT_STREAM_VERSION,
            })
            .await
            .map_err(|error| error.to_string())?;
        lifecycle
            .read_event()
            .await
            .map_err(|error| error.to_string())
    })
    .await;
    match subscription {
        Ok(Ok(DaemonEvent::Ok)) => {}
        Ok(Ok(DaemonEvent::Error { message, .. })) => {
            return SpawnAcceptanceReconciliation::Indeterminate(format!(
                "spawn lifecycle fence subscription rejected: {message}"
            ));
        }
        Ok(Ok(other)) => {
            return SpawnAcceptanceReconciliation::Indeterminate(format!(
                "spawn lifecycle fence received unexpected acknowledgement: {other:?}"
            ));
        }
        Ok(Err(error)) => {
            return SpawnAcceptanceReconciliation::Indeterminate(format!(
                "spawn lifecycle fence subscription failed: {error}"
            ));
        }
        Err(_) => {
            return SpawnAcceptanceReconciliation::Indeterminate(
                "spawn lifecycle fence subscription timed out".to_string(),
            );
        }
    }

    let listed = tokio::time::timeout(SPAWN_RECONCILIATION_ATTEMPT_TIMEOUT, async {
        let mut daemon = DaemonClient::connect(daemon_dir)
            .await
            .map_err(|error| error.to_string())?;
        daemon.list().await.map_err(|error| error.to_string())
    })
    .await;
    let listed = match listed {
        Ok(Ok(sessions)) => classify_spawn_acceptance(&sessions, session_id, run_id),
        Ok(Err(error)) => SpawnAcceptanceReconciliation::Indeterminate(format!(
            "spawn lifecycle fence control probe failed: {error}"
        )),
        Err(_) => SpawnAcceptanceReconciliation::Indeterminate(
            "spawn lifecycle fence control probe timed out".to_string(),
        ),
    };
    if !matches!(listed, SpawnAcceptanceReconciliation::Accepted) {
        return listed;
    }

    // Subscription starts before List, so an Exit/removal racing the daemon
    // snapshot is queued here. Buffer briefly before the guarded DB land, as
    // startup reconciliation does, instead of trusting a stale List result.
    let deadline = tokio::time::Instant::now() + LIVE_SPAWN_LIFECYCLE_FENCE_DELAY;
    loop {
        match tokio::time::timeout_at(deadline, lifecycle.read_event()).await {
            Err(_) => return SpawnAcceptanceReconciliation::Accepted,
            Ok(Ok(DaemonEvent::Exit {
                session_id: exited_session,
                run_id: exited_run,
                ..
            })) if exited_session == session_id && exited_run.as_deref() == Some(run_id) => {
                return SpawnAcceptanceReconciliation::Rejected(format!(
                    "spawn lifecycle fence observed expected run {run_id} exit before land"
                ));
            }
            Ok(Ok(DaemonEvent::Exit {
                session_id: exited_session,
                run_id: None,
                ..
            })) if exited_session == session_id => {
                return SpawnAcceptanceReconciliation::Indeterminate(format!(
                    "spawn lifecycle fence observed ownershipless exit for {session_id}"
                ));
            }
            Ok(Ok(DaemonEvent::ShuttingDown)) => {
                return SpawnAcceptanceReconciliation::Indeterminate(
                    "daemon shut down during spawn lifecycle fence".to_string(),
                );
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                return SpawnAcceptanceReconciliation::Indeterminate(format!(
                    "spawn lifecycle fence failed: {error}"
                ));
            }
        }
    }
}

fn classify_spawn_acceptance(
    sessions: &crate::daemon_client::DaemonList,
    session_id: &str,
    run_id: &str,
) -> SpawnAcceptanceReconciliation {
    let strict_ownership = sessions.capabilities.immutable_run_ownership;
    match sessions
        .sessions
        .iter()
        .find(|session| session.session_id == session_id)
    {
        Some(session)
            if session.run_id.as_deref() == Some(run_id)
                && matches!(session.state, kanna_daemon::protocol::SessionState::Active) =>
        {
            SpawnAcceptanceReconciliation::Accepted
        }
        Some(session) if session.run_id.as_deref() == Some(run_id) => {
            SpawnAcceptanceReconciliation::Rejected(format!(
                "spawn reconciliation found expected session {session_id} no longer active"
            ))
        }
        Some(session) if session.run_id.is_none() => {
            SpawnAcceptanceReconciliation::Indeterminate(format!(
                "spawn reconciliation found legacy session {session_id} without run ownership \
                 (strict ownership: {strict_ownership})"
            ))
        }
        Some(session) => SpawnAcceptanceReconciliation::Rejected(format!(
            "spawn reconciliation found session {session_id} owned by {:?}, expected {run_id}",
            session.run_id
        )),
        None => SpawnAcceptanceReconciliation::Rejected(format!(
            "spawn reconciliation did not find accepted session {session_id}"
        )),
    }
}

#[cfg(test)]
mod live_spawn_classification_tests {
    use super::*;

    fn listed(
        state: Option<kanna_daemon::protocol::SessionState>,
        run_id: Option<&str>,
        current_capabilities: bool,
    ) -> crate::daemon_client::DaemonList {
        crate::daemon_client::DaemonList {
            sessions: state
                .map(|state| kanna_daemon::protocol::SessionInfo {
                    session_id: "session-1".to_string(),
                    pid: 42,
                    cwd: "/tmp/task".to_string(),
                    state,
                    idle_seconds: 0,
                    status: kanna_daemon::protocol::SessionStatus::Busy,
                    kind: Default::default(),
                    run_id: run_id.map(str::to_string),
                })
                .into_iter()
                .collect(),
            capabilities: if current_capabilities {
                kanna_daemon::protocol::DaemonCapabilities::current()
            } else {
                kanna_daemon::protocol::DaemonCapabilities::legacy()
            },
        }
    }

    #[test]
    fn late_probe_rejects_an_already_exited_exact_run() {
        assert!(matches!(
            classify_spawn_acceptance(
                &listed(
                    Some(kanna_daemon::protocol::SessionState::Exited(0)),
                    Some("run-1"),
                    true,
                ),
                "session-1",
                "run-1",
            ),
            SpawnAcceptanceReconciliation::Rejected(_)
        ));
    }

    #[test]
    fn late_probe_fence_rejects_exit_between_list_and_land() {
        let before_exit = listed(
            Some(kanna_daemon::protocol::SessionState::Active),
            Some("run-1"),
            true,
        );
        assert!(matches!(
            classify_spawn_acceptance(&before_exit, "session-1", "run-1"),
            SpawnAcceptanceReconciliation::Accepted
        ));
        let after_exit = listed(
            Some(kanna_daemon::protocol::SessionState::Exited(0)),
            Some("run-1"),
            true,
        );
        assert!(matches!(
            classify_spawn_acceptance(&after_exit, "session-1", "run-1"),
            SpawnAcceptanceReconciliation::Rejected(_)
        ));
    }

    #[test]
    fn late_probe_rejects_disappearance_before_the_probe() {
        assert!(matches!(
            classify_spawn_acceptance(&listed(None, None, true), "session-1", "run-1"),
            SpawnAcceptanceReconciliation::Rejected(_)
        ));
    }

    #[test]
    fn late_probe_keeps_a_legacy_accepted_session_indeterminate() {
        assert!(matches!(
            classify_spawn_acceptance(
                &listed(
                    Some(kanna_daemon::protocol::SessionState::Active),
                    None,
                    false,
                ),
                "session-1",
                "run-1",
            ),
            SpawnAcceptanceReconciliation::Indeterminate(_)
        ));
    }

    #[tokio::test]
    async fn live_reconciliation_deduplicates_one_owner_per_run_and_cancels() {
        let db_path = Db::test_db_path("live-reconcile-deduplicate");
        let state_changes = tokio::sync::broadcast::channel(8).0;
        let reconciler = register_live_spawn_reconciler(&db_path, state_changes);
        reconcile_indeterminate_spawn_in_background(
            db_path.clone(),
            "/tmp/missing-live-reconcile-daemon".to_string(),
            "run-deduplicated".to_string(),
        );
        reconcile_indeterminate_spawn_in_background(
            db_path,
            "/tmp/missing-live-reconcile-daemon".to_string(),
            "run-deduplicated".to_string(),
        );
        assert_eq!(
            reconciler
                .active_runs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .len(),
            1
        );
        shutdown_live_spawn_reconciler(&reconciler);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if reconciler
                    .active_runs
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .is_empty()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("shutdown did not cancel the live reconciler");
    }

    #[test]
    fn live_reconciliation_backoff_is_bounded_and_jittered_per_run() {
        let first = (0..16)
            .map(|attempt| live_spawn_retry_delay("run-a", attempt))
            .collect::<Vec<_>>();
        assert!(first
            .iter()
            .all(|delay| *delay <= LIVE_SPAWN_RECONCILIATION_MAX_DELAY));
        assert!(
            first.windows(2).all(|pair| pair[0] <= pair[1]),
            "backoff must not regress: {first:?}"
        );
        assert!(
            (0..8).any(|attempt| {
                live_spawn_retry_delay("run-a", attempt) != live_spawn_retry_delay("run-b", attempt)
            }),
            "distinct runs must not synchronize every probe"
        );
    }
}

fn reconcile_indeterminate_spawn_in_background(
    db_path: String,
    daemon_dir: String,
    run_id: String,
) {
    let reconciler = LIVE_SPAWN_RECONCILERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&db_path)
        .and_then(Weak::upgrade);
    let Some(reconciler) = reconciler else {
        log::warn!(
            "live spawn reconciliation for {run_id} has no registered server owner; \
             startup reconciliation will retain ownership"
        );
        return;
    };
    {
        let mut active = reconciler
            .active_runs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !active.insert(run_id.clone()) {
            return;
        }
    }
    tokio::spawn(async move {
        reconcile_indeterminate_spawn_loop(
            Arc::clone(&reconciler),
            db_path,
            daemon_dir,
            run_id.clone(),
        )
        .await;
        reconciler
            .active_runs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&run_id);
    });
}

fn live_spawn_retry_delay(run_id: &str, attempt: usize) -> std::time::Duration {
    let exponent = attempt.min(7) as u32;
    let base_ms = LIVE_SPAWN_RECONCILIATION_BASE_DELAY
        .as_millis()
        .saturating_mul(1u128 << exponent)
        .min(LIVE_SPAWN_RECONCILIATION_MAX_DELAY.as_millis());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    run_id.hash(&mut hasher);
    attempt.hash(&mut hasher);
    let jitter_window = (base_ms / 2).max(1);
    let jitter = u128::from(hasher.finish()) % jitter_window;
    std::time::Duration::from_millis(
        (base_ms + jitter).min(LIVE_SPAWN_RECONCILIATION_MAX_DELAY.as_millis()) as u64,
    )
}

async fn reconcile_indeterminate_spawn_loop(
    reconciler: Arc<LiveSpawnReconciler>,
    db_path: String,
    daemon_dir: String,
    run_id: String,
) {
    let mut shutdown = reconciler.shutdown.subscribe();
    let mut attempt = 0usize;
    loop {
        if *shutdown.borrow() {
            return;
        }
        let delay = live_spawn_retry_delay(&run_id, attempt);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
        }
        let lookup_db_path = db_path.clone();
        let lookup_run_id = run_id.clone();
        let action = match tokio::task::spawn_blocking(move || {
            Db::open(&lookup_db_path)?.pending_stage_action(&lookup_run_id)
        })
        .await
        {
            Ok(Ok(action)) => action,
            Ok(Err(error)) => {
                log::warn!(
                    "live spawn reconciliation could not read reservation {run_id}: {error}"
                );
                attempt = attempt.saturating_add(1);
                continue;
            }
            Err(error) => {
                log::warn!("live spawn reconciliation lookup worker failed for {run_id}: {error}");
                attempt = attempt.saturating_add(1);
                continue;
            }
        };
        let Some(action) = action else {
            return;
        };
        let outcome = tokio::select! {
            outcome = reconcile_spawn_acceptance_with_lifecycle_fence(
                &daemon_dir,
                &action.session_id,
                &run_id,
            ) => outcome,
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
                continue;
            }
        };
        match outcome {
            SpawnAcceptanceReconciliation::Accepted => {
                let land_db_path = db_path.clone();
                let land_action = action.clone();
                match tokio::task::spawn_blocking(move || {
                    Db::open(&land_db_path)?.land_pending_stage_action(&land_action)
                })
                .await
                {
                    Ok(Ok(())) => {
                        let _ = reconciler.state_changes.send(
                            kanna_agent_protocol::ServerFrame::StateChanged {
                                scope: kanna_agent_protocol::StateChangeScope::Tasks,
                            },
                        );
                        log::info!(
                            "landed late-confirmed successor {run_id} for task {}",
                            action.task_id
                        );
                        return;
                    }
                    Ok(Err(error)) => {
                        log::warn!("live spawn reconciliation could not land {run_id}: {error}")
                    }
                    Err(error) => {
                        log::warn!(
                            "live spawn reconciliation land worker failed for {run_id}: {error}"
                        )
                    }
                }
            }
            SpawnAcceptanceReconciliation::Rejected(reason) => {
                let rollback_db_path = db_path.clone();
                let rollback_action = action.clone();
                let rolled_back = tokio::task::spawn_blocking(move || {
                    let db = Db::open(&rollback_db_path)?;
                    db.rollback_pending_stage_action(&rollback_action)?;
                    let cleanup_error = if rollback_action.remove_worktree_on_rollback {
                        match (
                            rollback_action.target_worktree_path.as_deref(),
                            rollback_action.target_worktree_branch.as_deref(),
                        ) {
                            (Some(path), Some(branch)) => {
                                remove_prepared_worktree(path, branch).err()
                            }
                            _ => Some("rollback worktree metadata is incomplete".to_string()),
                        }
                    } else {
                        None
                    };
                    Ok::<Option<String>, rusqlite::Error>(cleanup_error)
                })
                .await;
                match rolled_back {
                    Ok(Ok(cleanup_error)) => {
                        let _ = reconciler.state_changes.send(
                            kanna_agent_protocol::ServerFrame::StateChanged {
                                scope: kanna_agent_protocol::StateChangeScope::Tasks,
                            },
                        );
                        if let Some(error) = cleanup_error {
                            log::warn!(
                                "restored source for late-rejected successor {run_id}, but its \
                                 worktree cleanup failed and will be retried by normal orphan \
                                 reconciliation: {error}"
                            );
                        }
                        log::info!(
                            "rolled back late-rejected successor {run_id} for task {}: {reason}",
                            action.task_id
                        );
                        return;
                    }
                    Ok(Err(error)) => log::warn!(
                        "live spawn reconciliation could not roll back {run_id}: {error}"
                    ),
                    Err(error) => log::warn!(
                        "live spawn reconciliation rollback worker failed for {run_id}: {error}"
                    ),
                }
            }
            SpawnAcceptanceReconciliation::Indeterminate(reason) => {
                log::warn!(
                    "live spawn reconciliation remains indeterminate for {run_id}: {reason}"
                );
            }
        }
        attempt = attempt.saturating_add(1);
    }
}

pub(crate) async fn spawn_prepared_workspace_teardown_best_effort(
    daemon: &mut DaemonClient,
    prepared: Option<PreparedWorkspaceTeardown>,
) {
    let Some(prepared) = prepared else {
        return;
    };
    let session_id = prepared.session_id.clone();
    let command = spawn_session_command(
        prepared.session_id,
        prepared.cwd,
        prepared.env,
        None,
        prepared.session,
    );
    match daemon.send_command(&command).await {
        Ok(DaemonEvent::SessionCreated { .. }) => {}
        Ok(DaemonEvent::Error { message, .. }) => {
            log::warn!("workspace teardown session {session_id} failed to start: {message}");
        }
        Ok(other) => {
            log::warn!(
                "workspace teardown session {session_id} returned unexpected daemon response: {other:?}"
            );
        }
        Err(error) => {
            log::warn!("workspace teardown session {session_id} daemon error: {error}");
        }
    }
}

/// Dispatch a stage's post into the task's live agent session; when the
/// session is dead, fall back to spawning the post as a fresh session with
/// the post's agent. Either way the execution is recorded as a `stage_run`
/// with `kind = 'post'` and the task's stage does not change.
pub(crate) async fn dispatch_prepared_post_for_api(
    db_path: &str,
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    prepared: PreparedPostDispatch,
) -> Result<crate::mobile_api::TaskActionResponse, StageSpawnError> {
    let task_id = prepared.task_id.clone();
    let response = crate::mobile_api::TaskActionResponse {
        task_id: task_id.clone(),
        follow_task: None,
        revision_budget: None,
    };
    let response_body = prepared
        .action_request_key
        .as_ref()
        .map(|_| serde_json::to_string(&response))
        .transpose()
        .map_err(|error| format!("failed to serialize task action response: {error}"))?;
    let (run_id, source) = {
        let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
        // The live session keeps whatever agent is already running; attribute
        // the reserved post to it rather than to the fallback binding.
        let inherited = db
            .latest_stage_run(&task_id)
            .map_err(|e| format!("db error: {}", e))?;
        let completion_owner_run_id = inherited.as_ref().map(|run| {
            if run.kind == "post" {
                run.resumed_from_run_id
                    .clone()
                    .unwrap_or_else(|| run.id.clone())
            } else {
                run.id.clone()
            }
        });
        let (agent, agent_provider, model, provider_session_id, cwd) = match inherited {
            Some(run) => (
                run.agent,
                run.agent_provider,
                run.model,
                run.provider_session_id,
                run.cwd,
            ),
            None => (
                prepared.fallback.stage_agent.clone(),
                Some(prepared.fallback.agent_provider.clone()),
                prepared.fallback.model.clone(),
                None,
                Some(prepared.fallback.cwd.clone()),
            ),
        };
        let run_id = generate_stage_run_id(&task_id);
        let source = db
            .reserve_live_post_action(
                NewStageRun {
                    id: &run_id,
                    task_id: &task_id,
                    stage: &prepared.run_stage,
                    kind: "post",
                    agent: agent.as_deref(),
                    agent_provider: agent_provider.as_deref(),
                    model: model.as_deref(),
                    status: "pending",
                    result: None,
                    feedback: None,
                    session_id: Some(&prepared.session_id),
                    provider_session_id: provider_session_id.as_deref(),
                    cwd: cwd.as_deref(),
                    resumed_from_run_id: completion_owner_run_id.as_deref(),
                },
                Some(prepared.fallback.completion_transition.as_str()),
                &prepared.completion_attempt,
                &prepared.fallback.expected_source,
                prepared
                    .action_request_key
                    .as_deref()
                    .map(|idempotency_key| PendingTaskActionRequest {
                        idempotency_key,
                        success_status: 200,
                        success_response_body: response_body
                            .as_deref()
                            .expect("action response was serialized"),
                    }),
            )
            .map_err(|e| format!("db error: {}", e))?;
        (run_id, source)
    };
    #[cfg(test)]
    pause_live_post_after_reservation(prepared.action_request_key.as_deref()).await;

    if prepared.action_request_key.is_some() {
        if let Err(error) = Db::open(db_path)
            .and_then(|db| db.mark_reserved_live_post_delivery_started(&task_id, &run_id))
        {
            let rollback = Db::open(db_path)
                .and_then(|db| db.rollback_reserved_live_post(&task_id, &run_id, source.as_ref()))
                .map_err(|rollback_error| rollback_error.to_string());
            return match rollback {
                Ok(()) => Err(format!("db error: {error}").into()),
                Err(rollback_error) => Err(StageSpawnError::Indeterminate(format!(
                    "db error: {error}; failed to roll back undelivered live post \
                     {run_id}: {rollback_error}"
                ))),
            };
        }
    }
    match try_submit_task_input(daemon, &prepared.session_id, &prepared.message).await {
        Ok(()) => {
            #[cfg(test)]
            pause_live_post_after_delivery(prepared.action_request_key.as_deref()).await;
            if let Err(error) =
                Db::open(db_path).and_then(|db| db.land_reserved_live_post(&task_id, &run_id))
            {
                return Err(StageSpawnError::Indeterminate(format!(
                    "db error: {error}; live post reservation {run_id} retained because \
                     daemon delivery was acknowledged"
                )));
            }
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
                revision_budget: None,
            })
        }
        Err(TaskInputError::SessionNotFound) => {
            Db::open(db_path)
                .and_then(|db| db.rollback_reserved_live_post(&task_id, &run_id, source.as_ref()))
                .map_err(|e| format!("db error: {}", e))?;
            spawn_prepared_stage_run_for_api(db_path, daemon, replacements, prepared.fallback).await
        }
        Err(TaskInputError::Other(message)) => Err(StageSpawnError::Indeterminate(format!(
            "{message}; live post reservation {run_id} retained because delivery is indeterminate"
        ))),
    }
}

pub(crate) async fn rerun_prepared_stage_for_api(
    db_path: &str,
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    mut prepared: PreparedStageRerun,
) -> Result<crate::mobile_api::TaskActionResponse, StageSpawnError> {
    let task_id = prepared.task_id.clone();
    let source_session_id = prepared.source_session_id.clone();
    let stage = prepared.stage.clone();
    let run_kind = prepared.run_kind;
    let stage_agent = prepared.stage_agent.clone();
    let agent_provider = prepared.agent_provider.clone();
    let model = prepared.model.clone();
    let completion_transition = prepared.completion_transition;
    let provider_session_id = prepared.provider_session_id.clone();
    let cwd = prepared.cwd.clone();
    let run_id = generate_stage_run_id(&task_id);
    let session_id = run_id.clone();
    prepared
        .env
        .insert("KANNA_STAGE_RUN_ID".to_string(), run_id.clone());
    let replaced_source = {
        let db = Db::open(db_path).map_err(|e| format!("db error: {e}"))?;
        let action_success_body = prepared
            .action_request_key
            .as_ref()
            .map(|_| {
                serde_json::to_string(&crate::mobile_api::TaskActionResponse {
                    task_id: task_id.clone(),
                    follow_task: None,
                    revision_budget: None,
                })
            })
            .transpose()
            .map_err(|error| format!("failed to serialize task action result: {error}"))?;
        db.replace_current_run_with_pending_action(
            NewStageRun {
                id: &run_id,
                task_id: &task_id,
                stage: &stage,
                kind: run_kind,
                agent: stage_agent.as_deref(),
                agent_provider: Some(&agent_provider),
                model: model.as_deref(),
                status: "pending",
                result: None,
                feedback: None,
                session_id: Some(&session_id),
                provider_session_id: provider_session_id.as_deref(),
                cwd: Some(&cwd),
                resumed_from_run_id: None,
            },
            Some(completion_transition.as_str()),
            &prepared.expected_source,
            "cancelled",
            None,
            None,
            PendingStageActionTarget {
                session_id: &session_id,
                stage: &stage,
                branch: None,
                worktree: None,
                remove_worktree_on_rollback: false,
                action_request: prepared
                    .action_request_key
                    .as_deref()
                    .map(|idempotency_key| PendingTaskActionRequest {
                        idempotency_key,
                        success_status: 200,
                        success_response_body: action_success_body
                            .as_deref()
                            .expect("action request response was serialized"),
                    }),
            },
        )
        .map_err(|error| {
            if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
                format!("task {task_id} changed while the rerun was being prepared")
            } else {
                format!("db error: {error}")
            }
        })?
    };
    let record_failure = |error: String| match record_rerun_stage_failure(
        db_path, &run_id, &task_id, &stage, &error,
    ) {
        Ok(()) => error,
        Err(record_error) => {
            format!("{error}; failed to record stage rerun failure: {record_error}")
        }
    };
    if let Err(error) = kill_session_replacing_if_owned(
        daemon,
        replacements,
        &source_session_id,
        prepared.expected_source.process_run_id.as_deref(),
    )
    .await
    {
        return Err(rollback_rerun_stage_reservation(
            db_path,
            &run_id,
            &task_id,
            &prepared.expected_source,
            replaced_source.as_ref(),
            error,
        )
        .into());
    }
    if let Err(error) = prepare_deferred_rerun_setup(&mut prepared) {
        return Err(record_failure(error).into());
    }
    if let Some(snapshot) = prepared.recovery_snapshot.as_ref() {
        if let Err(error) = seed_recovery_snapshot(daemon, &session_id, snapshot).await {
            return Err(record_failure(error).into());
        }
    }

    let command = spawn_session_command(
        session_id.clone(),
        prepared.cwd,
        prepared.env,
        None,
        prepared.session,
    );

    let spawn_result = daemon
        .send_command(&command)
        .await
        .map_err(|error| format!("daemon error: {error}"));
    let event = match spawn_result {
        Ok(event) => Some(event),
        Err(command_error) => {
            match reconcile_spawn_acceptance(daemon, &session_id, &run_id).await {
                SpawnAcceptanceReconciliation::Accepted => None,
                SpawnAcceptanceReconciliation::Rejected(reconcile_error) => {
                    return Err(
                        record_failure(format!("{command_error}; {reconcile_error}")).into(),
                    );
                }
                SpawnAcceptanceReconciliation::Indeterminate(reconcile_error) => {
                    reconcile_indeterminate_spawn_in_background(
                        db_path.to_string(),
                        daemon.daemon_dir().to_string(),
                        run_id.clone(),
                    );
                    return Err(StageSpawnError::Indeterminate(format!(
                    "{command_error}; {reconcile_error}; successor reservation retained for live reconciliation"
                )));
                }
            }
        }
    };
    match event {
        None => {
            start_rerun_stage_run(db_path, &run_id, &task_id, provider_session_id.as_deref())?;
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
                revision_budget: None,
            })
        }
        Some(DaemonEvent::SessionCreated {
            run_id: Some(created_run_id),
            ..
        }) if created_run_id == run_id => {
            start_rerun_stage_run(db_path, &run_id, &task_id, provider_session_id.as_deref())?;
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
                revision_budget: None,
            })
        }
        Some(DaemonEvent::SessionCreated { run_id: None, .. }) => {
            start_rerun_stage_run(db_path, &run_id, &task_id, provider_session_id.as_deref())?;
            Ok(crate::mobile_api::TaskActionResponse {
                task_id,
                follow_task: None,
                revision_budget: None,
            })
        }
        Some(DaemonEvent::SessionCreated {
            run_id: created_run_id,
            ..
        }) => {
            let mut error = format!(
                "daemon returned mismatched run ownership (expected {run_id}, got {created_run_id:?})"
            );
            if let Err(kill_error) = kill_session_replacing(daemon, replacements, &session_id).await
            {
                error.push_str(&format!(
                    "; failed to kill mismatched session: {kill_error}"
                ));
            }
            Err(record_failure(error).into())
        }
        Some(DaemonEvent::Error { message, .. }) => {
            Err(record_failure(format!("daemon error: {message}")).into())
        }
        Some(other) => Err(record_failure(format!("unexpected daemon response: {other:?}")).into()),
    }
}

fn rollback_rerun_stage_reservation(
    db_path: &str,
    run_id: &str,
    task_id: &str,
    expected_source: &crate::db::TaskActionState,
    replaced_source: Option<&ReplacedStageRunSource>,
    error: String,
) -> String {
    match Db::open(db_path).and_then(|db| {
        db.rollback_pending_replacement_and_restore_source(
            task_id,
            run_id,
            expected_source,
            replaced_source,
        )
    }) {
        Ok(()) => error,
        Err(db_error) => {
            format!("{error}; failed to restore source stage ownership: {db_error}")
        }
    }
}

fn prepare_deferred_rerun_setup(prepared: &mut PreparedStageRerun) -> Result<(), String> {
    if prepared.deferred_setup.is_empty() {
        return Ok(());
    }
    run_workspace_setup_commands(&prepared.deferred_setup, &prepared.cwd, &prepared.env)?;
    let PreparedSessionSpawn::Agent {
        agent_provider,
        executable,
        ..
    } = &mut prepared.session
    else {
        return Err("deferred rerun setup requires a headless agent session".to_string());
    };
    *executable = resolve_headless_agent_executable(
        *agent_provider,
        prepared.env.get("PATH").map(String::as_str),
        &prepared.cwd,
    )?;
    Ok(())
}

/// Kill a session as part of an orchestrated replacement (stage swap, rerun,
/// close). The replacement entry is registered BEFORE the Kill is sent —
/// the daemon broadcasts the resulting Exit concurrently with the Kill
/// response — and cancelled when the session turns out not to exist (no
/// Exit will come, and a stale entry would swallow a future legitimate one).
pub(crate) async fn kill_session_replacing(
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    session_id: &str,
) -> Result<(), String> {
    kill_session_replacing_if_owned(daemon, replacements, session_id, None).await
}

pub(crate) async fn kill_session_replacing_if_owned(
    daemon: &mut DaemonClient,
    replacements: &SessionReplacements,
    session_id: &str,
    expected_run_id: Option<&str>,
) -> Result<(), String> {
    let replacement_marker = replacements.begin_for_run(session_id, expected_run_id);
    let mut kill = daemon
        .send_command(&DaemonCommand::Kill {
            session_id: session_id.to_string(),
            expected_run_id: expected_run_id.map(str::to_string),
        })
        .await
        .map_err(|e| {
            replacements.cancel(session_id, replacement_marker);
            format!("daemon error: {}", e)
        })?;
    if matches!(
        kill,
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionOwnershipMismatch),
            ..
        }
    ) && expected_run_id.is_some()
    {
        let capabilities = daemon
            .send_command(&DaemonCommand::List)
            .await
            .map_err(|error| {
                replacements.cancel(session_id, replacement_marker);
                format!("daemon capability negotiation failed after ownership mismatch: {error}")
            })?;
        if matches!(
            capabilities,
            DaemonEvent::SessionList {
                ref sessions,
                capabilities: Some(ref capabilities),
                ..
            } if !capabilities.immutable_run_ownership
                && sessions.iter().any(|session| {
                    session.session_id == session_id && session.run_id.is_none()
                })
        ) {
            kill = daemon
                .send_command(&DaemonCommand::Kill {
                    session_id: session_id.to_string(),
                    expected_run_id: None,
                })
                .await
                .map_err(|error| {
                    replacements.cancel(session_id, replacement_marker);
                    format!("daemon error after legacy ownership negotiation: {error}")
                })?;
        }
    }
    match kill {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
            ..
        } => {
            replacements.cancel(session_id, replacement_marker);
            Ok(())
        }
        DaemonEvent::Error { message, .. }
            if message.to_ascii_lowercase().contains("session not found") =>
        {
            replacements.cancel(session_id, replacement_marker);
            Ok(())
        }
        DaemonEvent::Error { message, .. } => {
            replacements.cancel(session_id, replacement_marker);
            Err(format!("daemon error: {}", message))
        }
        other => {
            replacements.cancel(session_id, replacement_marker);
            Err(format!("unexpected daemon response: {:?}", other))
        }
    }
}

fn spawn_session_command(
    session_id: String,
    cwd: String,
    env: std::collections::HashMap<String, String>,
    terminal_prelude: Option<Vec<u8>>,
    session: PreparedSessionSpawn,
) -> DaemonCommand {
    match session {
        PreparedSessionSpawn::Pty {
            executable,
            args,
            cols,
            rows,
            agent_provider,
        } => DaemonCommand::Spawn {
            session_id,
            executable,
            args,
            cwd,
            env,
            cols,
            rows,
            agent_provider: Some(agent_provider),
            terminal_prelude,
        },
        PreparedSessionSpawn::Agent {
            agent_provider,
            prompt,
            model,
            permission_mode,
            allowed_tools,
            disallowed_tools,
            max_turns,
            max_budget_usd,
            system_prompt,
            mcp_config_path,
            executable,
            resume_session_id,
        } => DaemonCommand::SpawnAgent {
            session_id,
            params: AgentSpawnParams {
                agent_provider,
                prompt,
                cwd,
                env,
                model,
                permission_mode,
                allowed_tools,
                disallowed_tools,
                max_turns,
                max_budget_usd,
                system_prompt: Some(system_prompt),
                mcp_config_path,
                executable,
                resume_session_id,
            },
        },
    }
}

fn record_spawned_stage_run(
    db_path: &str,
    prepared: &PreparedTaskSpawn,
    run_id: &str,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.with_immediate_transaction(|db| {
        db.update_pipeline_item_agent_session_id(
            &prepared.created_task.task_id,
            prepared.provider_session_id.as_deref(),
        )?;
        db.insert_stage_run_with_completion_transition(
            NewStageRun {
                id: run_id,
                task_id: &prepared.created_task.task_id,
                stage: &prepared.created_task.stage,
                kind: "main",
                agent: prepared.stage_agent.as_deref(),
                agent_provider: Some(prepared.agent_provider.as_str()),
                model: prepared.model.as_deref(),
                status: "pending",
                result: None,
                feedback: None,
                session_id: Some(&prepared.session_id),
                provider_session_id: prepared.provider_session_id.as_deref(),
                cwd: Some(&prepared.cwd),
                resumed_from_run_id: None,
            },
            Some(prepared.completion_transition.as_str()),
        )?;
        db.delete_create_task_intent(&prepared.created_task.task_id)
    })
    .map_err(|e| format!("db error: {}", e))
}

fn record_prepared_task_spawn_failure(
    db: &Db,
    prepared: &PreparedTaskSpawn,
    run_id: &str,
    error: &str,
) -> Result<(), String> {
    let task_id = prepared.created_task.task_id.as_str();
    let result = format!("failed to spawn task {task_id}: {error}");
    db.cancel_running_stage_runs(task_id)
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_activity(task_id, "unread")
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(task_id, prepared.provider_session_id.as_deref())
        .map_err(|e| format!("db error: {}", e))?;
    db.finish_stage_run(run_id, "failed", Some(&result), Some("task spawn failed"))
        .map_err(|e| format!("db error: {}", e))
}

#[allow(clippy::too_many_arguments)]
fn record_rerun_stage_run(
    db_path: &str,
    run_id: &str,
    task_id: &str,
    stage: &str,
    run_kind: &'static str,
    stage_agent: Option<&str>,
    agent_provider: &str,
    model: Option<&str>,
    completion_transition: &str,
    session_id: &str,
    provider_session_id: Option<&str>,
    cwd: &str,
    status: &str,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.with_immediate_transaction(|db| {
        db.insert_stage_run_with_completion_transition(
            NewStageRun {
                id: run_id,
                task_id,
                stage,
                kind: run_kind,
                agent: stage_agent,
                agent_provider: Some(agent_provider),
                model,
                status,
                result: None,
                feedback: None,
                session_id: Some(session_id),
                provider_session_id,
                cwd: Some(cwd),
                resumed_from_run_id: None,
            },
            Some(completion_transition),
        )?;
        db.delete_create_task_intent(task_id)
    })
    .map_err(|e| format!("db error: {}", e))
}

fn start_rerun_stage_run(
    db_path: &str,
    run_id: &str,
    task_id: &str,
    provider_session_id: Option<&str>,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(task_id, provider_session_id)
        .map_err(|e| format!("db error: {}", e))?;
    db.start_stage_run(run_id)
        .map_err(|e| format!("db error: {}", e))
}

fn record_rerun_stage_failure(
    db_path: &str,
    run_id: &str,
    task_id: &str,
    stage: &str,
    error: &str,
) -> Result<(), String> {
    let db = Db::open(db_path).map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_activity(task_id, "unread")
        .map_err(|e| format!("db error: {}", e))?;
    db.update_pipeline_item_agent_session_id(task_id, None)
        .map_err(|e| format!("db error: {}", e))?;
    let result = format!("failed to rerun stage {stage}: {error}");
    db.finish_stage_run(run_id, "failed", Some(&result), Some("stage rerun failed"))
        .map_err(|e| format!("db error: {}", e))
}

fn generate_stage_run_id(task_id: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("run-{task_id}-{nanos}")
}
