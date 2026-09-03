use super::lan_trust::PrivilegedTaskAccess;
use super::state::{db_write_error, AppState};
use crate::config::Config;
use crate::db::{Db, MergeSignalSource};
use crate::task_creator::{PrepareTaskError, SingletonAgentOverrides};
use axum::extract::State;
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use kanna_tool_catalog::encode_path_segment;
use std::sync::Arc;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SignalAgentRequest {
    message: String,
    /// Provider the singleton agent should run as when this signal creates it,
    /// overriding the agent definition's own candidates and the configured
    /// default.
    #[serde(default)]
    agent_provider: Option<String>,
    /// Provider-native reasoning effort for the created singleton agent.
    #[serde(default)]
    effort: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SignalAgentResponse {
    pub(super) task_id: String,
    pub(super) created: bool,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SingletonCandidate {
    task_id: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SingletonLookupResponse {
    tasks: Vec<SingletonCandidate>,
}

/// Native half of account-wide singleton discovery. The caller is the signed,
/// authenticated desktop relay tunnel; this route deliberately does not fan
/// out again.
pub(super) async fn find_local_singletons(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    axum::extract::Path((remote_url_hash, agent)): axum::extract::Path<(String, String)>,
) -> Result<Json<SingletonLookupResponse>, (axum::http::StatusCode, String)> {
    let tasks = super::blocking::run_handler_blocking("local singleton lookup", move || {
        let db =
            Db::open(&state.config.db_path).map_err(|error| db_write_error("db error", error))?;
        db.find_open_agent_tasks_by_remote_url_hash(&remote_url_hash, &agent)
            .map_err(|error| db_write_error("db error", error))
    })
    .await?;
    Ok(Json(SingletonLookupResponse {
        tasks: tasks
            .into_iter()
            .map(|task| SingletonCandidate {
                task_id: task.task_id,
            })
            .collect(),
    }))
}

pub(super) async fn signal_agent(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    axum::extract::Path((repo_id, agent)): axum::extract::Path<(String, String)>,
    Json(payload): Json<SignalAgentRequest>,
) -> Result<Json<SignalAgentResponse>, (axum::http::StatusCode, String)> {
    signal_agent_request(
        state,
        repo_id,
        agent,
        payload.message,
        SingletonAgentOverrides {
            agent_provider: payload.agent_provider,
            effort: payload.effort,
        },
    )
    .await
    .map(Json)
}

/// Deliver an ordinary request to the repository's merge agent. Kanna does
/// not interpret approval history, bind candidate branches, or attest policy;
/// the merge agent applies the repository's checked-in policy.
pub(super) async fn signal_merge_handoff(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::MergeHandoffRequest>,
) -> Result<Json<SignalAgentResponse>, (axum::http::StatusCode, String)> {
    signal_merge_handoff_impl(state, task_id, payload)
        .await
        .map(Json)
}

async fn signal_merge_handoff_impl(
    state: Arc<AppState>,
    task_id: String,
    payload: crate::mobile_api::MergeHandoffRequest,
) -> Result<SignalAgentResponse, (axum::http::StatusCode, String)> {
    let task_id = super::task_actions::resolve_task_id_for_mutation(&state, &task_id).await?;
    deliver_merge_handoff(state, task_id, payload, MergeSignalSource::Agent).await
}

/// Deliver a task's merge request to the repo's merge agent and record that
/// the task no longer owes one. Shared by the approve post's own
/// `signal-merge-handoff` call and by the engine backstop that runs before a
/// task closes, so both deliver the identical wire line and both mark the
/// task as having handed off.
async fn deliver_merge_handoff(
    state: Arc<AppState>,
    task_id: String,
    payload: crate::mobile_api::MergeHandoffRequest,
    source: MergeSignalSource,
) -> Result<SignalAgentResponse, (axum::http::StatusCode, String)> {
    for (name, value) in [
        ("branch", payload.branch.trim()),
        ("target", payload.target.trim()),
        ("summary", payload.summary.trim()),
    ] {
        if value.is_empty() {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                format!("merge handoff {name} must be non-empty"),
            ));
        }
    }

    let branch = payload.branch.trim().to_string();
    let target = payload.target.trim().to_string();
    let pr_url = payload
        .pr_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let repo_id = {
        let state = Arc::clone(&state);
        let task_id = task_id.clone();
        super::blocking::run_handler_blocking("merge signal source read", move || {
            let db = Db::open(&state.config.db_path)
                .map_err(|error| db_write_error("db error", error))?;
            db.get_pipeline_item(&task_id)
                .map_err(|error| db_write_error("db error", error))?
                .ok_or_else(|| {
                    (
                        axum::http::StatusCode::NOT_FOUND,
                        format!("task not found: {task_id}"),
                    )
                })
                .map(|task| task.repo_id)
        })
        .await?
    };
    let message = format!(
        "MERGE {} -> {} [TASK {}]{}: {}",
        branch,
        target,
        task_id,
        pr_url
            .as_deref()
            .map(|url| format!(" [PR {url}]"))
            .unwrap_or_default(),
        payload.summary.trim(),
    );
    let response = signal_agent_request(
        state.clone(),
        repo_id,
        "merge".to_string(),
        message,
        SingletonAgentOverrides::default(),
    )
    .await?;
    // Recorded only after delivery: a task that still owes the merge agent a
    // request must look like it does, so the close-time backstop can send it.
    let recorded = {
        let state = Arc::clone(&state);
        let task_id = task_id.clone();
        let branch = branch.clone();
        let target = target.clone();
        let pr_url = pr_url.clone();
        super::blocking::run_handler_blocking("merge signal record", move || {
            let db = Db::open(&state.config.db_path)
                .map_err(|error| db_write_error("db error", error))?;
            db.record_task_merge_signal(&task_id, source, &branch, &target, pr_url.as_deref())
                .map_err(|error| db_write_error("db error", error))
        })
        .await?
    };
    if recorded {
        state.publish_state_changed(StateChangeScope::Tasks);
    }
    Ok(response)
}

/// Hand the task's PR to the repo's merge master before the workflow closes
/// it, when the approve post finished without doing so itself.
///
/// The post is injected into whatever agent session the pr stage left running,
/// so the handoff cannot rest on that agent having read and followed the post
/// prompt: a pr agent that was still mid-work when the post arrived reads it
/// as its next instruction, creates the PR, reports that, and never signals.
/// The workflow promised the handoff by declaring the post, so the engine —
/// which holds the recorded `pr_url` either way — owes it.
///
/// This delivers the same ordinary policy request the post would have. It
/// attests nothing about the merge; the merge agent resolves the live PR and
/// applies the repository's own policy.
pub(super) async fn ensure_merge_handoff_before_close(
    state: &Arc<AppState>,
    task_id: &str,
) -> Result<(), (axum::http::StatusCode, String)> {
    let Some(pending) = resolve_pending_merge_handoff(state, task_id).await? else {
        return Ok(());
    };
    let Some(pr_url) = pending.pr_url else {
        // Nothing to hand off, on a workflow whose final stage promised a
        // handoff: the approve post reported success without ever producing
        // the PR it exists to approve. Refuse the close so the task parks for
        // its human instead of disappearing as a completed workflow.
        let reason = format!(
            "task {task_id} finished stage '{}' whose post signals the merge master, but no PR \
             URL was ever recorded — nothing was handed off",
            pending.stage
        );
        log::error!("{reason}");
        let record_state = Arc::clone(state);
        let record_task_id = task_id.to_string();
        let record_reason = reason.clone();
        super::blocking::run_handler_blocking("merge handoff gap record", move || {
            let db = Db::open(&record_state.config.db_path)
                .map_err(|error| db_write_error("db error", error))?;
            db.record_task_merge_handoff_missing(&record_task_id, &record_reason)
                .map_err(|error| db_write_error("db error", error))?;
            db.update_pipeline_item_activity(&record_task_id, "unread")
                .map_err(|error| db_write_error("db error", error))
        })
        .await?;
        state.publish_state_changed(StateChangeScope::Tasks);
        return Err((axum::http::StatusCode::CONFLICT, reason));
    };
    log::warn!(
        "approve post for {task_id} closed without signaling the merge master; \
         delivering the handoff for PR {pr_url}"
    );
    let delivered = deliver_merge_handoff(
        Arc::clone(state),
        task_id.to_string(),
        crate::mobile_api::MergeHandoffRequest {
            branch: pending.branch,
            target: pending.target,
            pr_url: Some(pr_url),
            summary: pending.summary,
        },
        MergeSignalSource::Engine,
    )
    .await;
    let Err((status, reason)) = delivered else {
        return Ok(());
    };
    // The backstop exists because the approve post cannot be trusted to have
    // signalled; it must not itself fail quietly. The close is already
    // abandoned by returning an error, but the task would otherwise park
    // looking finished — mark it unread so its human meets it, and say in the
    // log which delivery was refused rather than only that a close failed.
    log::error!(
        "the pre-close merge handoff for {task_id} was not delivered: {reason}; the task stays \
         open at stage '{}'",
        pending.stage
    );
    let record_state = Arc::clone(state);
    let record_task_id = task_id.to_string();
    super::blocking::run_handler_blocking("merge handoff refusal record", move || {
        let db = Db::open(&record_state.config.db_path)
            .map_err(|error| db_write_error("db error", error))?;
        db.update_pipeline_item_activity(&record_task_id, "unread")
            .map_err(|error| db_write_error("db error", error))
    })
    .await?;
    state.publish_state_changed(StateChangeScope::Tasks);
    Err((status, reason))
}

/// What the engine would send on the task's behalf, or `None` when the task
/// owes nothing — its workflow never promised a handoff, or the approve post
/// already delivered one.
struct PendingMergeHandoff {
    stage: String,
    branch: String,
    target: String,
    pr_url: Option<String>,
    summary: String,
}

async fn resolve_pending_merge_handoff(
    state: &Arc<AppState>,
    task_id: &str,
) -> Result<Option<PendingMergeHandoff>, (axum::http::StatusCode, String)> {
    let state = Arc::clone(state);
    let task_id = task_id.to_string();
    super::blocking::run_handler_blocking("merge handoff close check", move || {
        let db =
            Db::open(&state.config.db_path).map_err(|error| db_write_error("db error", error))?;
        let Some(task) = db
            .get_pipeline_item(&task_id)
            .map_err(|error| db_write_error("db error", error))?
        else {
            return Ok(None);
        };
        let Some(stage) = task.stage.clone() else {
            return Ok(None);
        };
        if db
            .task_merge_signaled_at(&task_id)
            .map_err(|error| db_write_error("db error", error))?
            .is_some()
        {
            return Ok(None);
        }
        let Some(repo) = db
            .get_repo(&task.repo_id)
            .map_err(|error| db_write_error("db error", error))?
        else {
            return Ok(None);
        };
        let workflow_name = task
            .pipeline
            .clone()
            .unwrap_or_else(|| crate::task_creator::FALLBACK_WORKFLOW_NAME.to_string());
        let declares_post = crate::task_creator::stage_declares_merge_approve_post(
            &repo,
            &workflow_name,
            task.pipeline_def.as_deref(),
            &stage,
        )
        .map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to resolve workflow for {task_id}: {error}"),
            )
        })?;
        if !declares_post {
            return Ok(None);
        }
        // The pr agent renames the branch it pushes, so the stored workspace
        // name is usually not the PR's head. Resolve the worktree's live
        // branch the same way blocker-resolution instructions do; the merge
        // agent treats the PR URL as authoritative anyway.
        let branch = task
            .branch
            .as_deref()
            .and_then(|branch| {
                crate::task_creator::resolve_current_source_worktree_branch(
                    &repo.path,
                    Some(branch),
                )
            })
            .or_else(|| task.branch.clone())
            .unwrap_or_else(|| task_id.clone());
        // The repo's default branch, not the task's `base_ref`: `base_ref`
        // records where the task forked from and can be a commit sha or a
        // branch that no longer exists. The merge agent resolves the PR's own
        // base first, so this is a hint it can override, and a hint that names
        // a real branch is the only kind worth sending.
        let target = repo
            .default_branch
            .clone()
            .or_else(|| task.base_ref.clone())
            .filter(|target| !target.trim().is_empty())
            .unwrap_or_else(|| "main".to_string());
        let summary = task
            .display_name
            .clone()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| format!("task {task_id}"));
        Ok(Some(PendingMergeHandoff {
            stage,
            branch,
            target,
            pr_url: task.pr_url.clone().filter(|url| !url.trim().is_empty()),
            summary,
        }))
    })
    .await
}

pub(super) async fn signal_agent_request(
    state: Arc<AppState>,
    repo_id: String,
    agent: String,
    message: String,
    overrides: SingletonAgentOverrides,
) -> Result<SignalAgentResponse, (axum::http::StatusCode, String)> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "message must be a non-empty string".to_string(),
        ));
    }

    let owner = resolve_singleton_owner(&state, &repo_id, &agent).await?;

    match owner {
        Some(SingletonOwner::Remote {
            machine_id,
            task_id,
        }) => {
            let path = format!("/v1/tasks/{}/input", encode_path_segment(&task_id));
            let response = state
                .invoke_relay_desktop(
                    machine_id.clone(),
                    "POST".to_string(),
                    path,
                    serde_json::json!({ "input": message }),
                )
                .await
                .map_err(|error| remote_singleton_unreachable(&machine_id, &task_id, error))?;
            if response.status != axum::http::StatusCode::NO_CONTENT.as_u16() {
                let detail = response
                    .error
                    .or_else(|| {
                        response.body.and_then(|body| {
                            body.get("message")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string)
                        })
                    })
                    .unwrap_or_else(|| format!("HTTP {}", response.status));
                return Err(remote_singleton_unreachable(&machine_id, &task_id, detail));
            }
            return Ok(SignalAgentResponse {
                task_id,
                created: false,
            });
        }
        Some(SingletonOwner::Local(running)) => {
            return signal_local_singleton(&state, &repo_id, &agent, &message, running).await;
        }
        None => {}
    }

    let prepared = {
        let state = Arc::clone(&state);
        let repo_id = repo_id.clone();
        let agent = agent.clone();
        super::blocking::run_handler_blocking("singleton agent preparation", move || {
            let db = Db::open(&state.config.db_path).map_err(|e| db_write_error("db error", e))?;
            let prepared = crate::task_creator::prepare_singleton_agent_task_for_api(
                &db,
                &state.config,
                &repo_id,
                &agent,
                &message,
                overrides,
            )
            .map_err(prepare_singleton_error)?;
            db.pin_pipeline_item_at_top(&repo_id, prepared.task_id())
                .map_err(|e| db_write_error("db error", e))?;
            Ok(prepared)
        })
        .await?
    };
    let task_id = prepared.task_id().to_string();
    state.publish_state_changed(StateChangeScope::Tasks);
    spawn_signal_agent_task_detached(Arc::clone(&state), prepared);

    Ok(SignalAgentResponse {
        task_id,
        created: true,
    })
}

enum SingletonOwner {
    Local(crate::db::OpenAgentTask),
    Remote { machine_id: String, task_id: String },
}

async fn resolve_singleton_owner(
    state: &Arc<AppState>,
    repo_id: &str,
    agent: &str,
) -> Result<Option<SingletonOwner>, (axum::http::StatusCode, String)> {
    let (remote_url_hash, local_tasks) = {
        let state = Arc::clone(state);
        let repo_id = repo_id.to_string();
        let agent = agent.to_string();
        super::blocking::run_handler_blocking("singleton agent lookup", move || {
            let db = Db::open(&state.config.db_path)
                .map_err(|error| db_write_error("db error", error))?;
            let repo = db
                .get_repo(&repo_id)
                .map_err(|error| db_write_error("db error", error))?
                .ok_or_else(|| {
                    (
                        axum::http::StatusCode::NOT_FOUND,
                        format!("repo not found: {repo_id}"),
                    )
                })?;
            let tasks = match repo.remote_url_hash.as_deref() {
                Some(remote_url_hash) => db
                    .find_open_agent_tasks_by_remote_url_hash(remote_url_hash, &agent)
                    .map_err(|error| db_write_error("db error", error))?,
                None => db
                    .find_open_agent_task(&repo_id, &agent)
                    .map_err(|error| db_write_error("db error", error))?
                    .into_iter()
                    .collect(),
            };
            Ok((repo.remote_url_hash, tasks))
        })
        .await?
    };

    let Some(remote_url_hash) = remote_url_hash else {
        return Ok(local_tasks.into_iter().next().map(SingletonOwner::Local));
    };

    // A desktop without an account credential has no sibling namespace. Once
    // signed in, however, inability to inspect that namespace is uncertainty,
    // never permission to create a rival singleton.
    if state.config.desktop_secret.is_none() {
        return unique_singleton_owner(state, repo_id, agent, local_tasks, Vec::new());
    }
    let directory_owners = state
        .list_relay_repo_singletons(remote_url_hash.clone(), agent.to_string())
        .await
        .map_err(|error| {
            let reason = format!(
                "cannot resolve the {agent} singleton for repo {repo_id} from the account directory: {error}; no singleton was created"
            );
            log::error!("{reason}");
            (axum::http::StatusCode::SERVICE_UNAVAILABLE, reason)
        })?;
    state.replace_singleton_owners(
        &remote_url_hash,
        agent,
        directory_owners
            .into_iter()
            .filter(|owner| owner.machine_id != state.config.desktop_id)
            .collect(),
    );
    let machine_ids = state.list_active_relay_desktops().await.map_err(|error| {
        let reason = format!(
            "cannot resolve the {agent} singleton for repo {repo_id} across the signed-in account: {error}; no singleton was created"
        );
        log::error!("{reason}");
        (axum::http::StatusCode::SERVICE_UNAVAILABLE, reason)
    })?;
    let path = format!(
        "/v1/repo-singletons/{}/{}",
        encode_path_segment(&remote_url_hash),
        encode_path_segment(agent)
    );
    for machine_id in machine_ids {
        if machine_id == state.config.desktop_id {
            continue;
        }
        let response = state
            .invoke_relay_desktop(
                machine_id.clone(),
                "GET".to_string(),
                path.clone(),
                serde_json::Value::Null,
            )
            .await
            .map_err(|error| singleton_lookup_uncertain(repo_id, agent, &machine_id, error))?;
        if response.status != axum::http::StatusCode::OK.as_u16() {
            return Err(singleton_lookup_uncertain(
                repo_id,
                agent,
                &machine_id,
                response
                    .error
                    .unwrap_or_else(|| format!("HTTP {}", response.status)),
            ));
        }
        let lookup = response
            .body
            .ok_or_else(|| {
                singleton_lookup_uncertain(repo_id, agent, &machine_id, "response had no body")
            })
            .and_then(|body| {
                serde_json::from_value::<SingletonLookupResponse>(body).map_err(|error| {
                    singleton_lookup_uncertain(
                        repo_id,
                        agent,
                        &machine_id,
                        format!("invalid response: {error}"),
                    )
                })
            })?;
        let task_ids = lookup
            .tasks
            .into_iter()
            .map(|task| task.task_id)
            .collect::<Vec<_>>();
        state.observe_singleton_owners(&remote_url_hash, agent, &machine_id, task_ids.clone());
    }
    let remote_tasks = state.known_singleton_owners(&remote_url_hash, agent);
    unique_singleton_owner(state, repo_id, agent, local_tasks, remote_tasks)
}

fn unique_singleton_owner(
    state: &AppState,
    repo_id: &str,
    agent: &str,
    mut local_tasks: Vec<crate::db::OpenAgentTask>,
    remote_tasks: Vec<(String, String)>,
) -> Result<Option<SingletonOwner>, (axum::http::StatusCode, String)> {
    let count = local_tasks.len() + remote_tasks.len();
    if count > 1 {
        let mut owners = local_tasks
            .iter()
            .map(|task| format!("{}:{}", state.config.desktop_id, task.task_id))
            .chain(
                remote_tasks
                    .iter()
                    .map(|(machine_id, task_id)| format!("{machine_id}:{task_id}")),
            )
            .collect::<Vec<_>>();
        owners.sort();
        let reason = format!(
            "duplicate open {agent} singletons for repo {repo_id}: {}; close or explicitly reconcile the duplicates before signaling",
            owners.join(", ")
        );
        log::error!("{reason}");
        return Err((axum::http::StatusCode::CONFLICT, reason));
    }
    if let Some(task) = local_tasks.pop() {
        return Ok(Some(SingletonOwner::Local(task)));
    }
    Ok(remote_tasks
        .into_iter()
        .next()
        .map(|(machine_id, task_id)| SingletonOwner::Remote {
            machine_id,
            task_id,
        }))
}

fn singleton_lookup_uncertain(
    repo_id: &str,
    agent: &str,
    machine_id: &str,
    error: impl std::fmt::Display,
) -> (axum::http::StatusCode, String) {
    let reason = format!(
        "cannot verify the {agent} singleton for repo {repo_id} on machine {machine_id}: {error}; no singleton was created"
    );
    log::error!("{reason}");
    (axum::http::StatusCode::SERVICE_UNAVAILABLE, reason)
}

fn remote_singleton_unreachable(
    machine_id: &str,
    task_id: &str,
    error: impl std::fmt::Display,
) -> (axum::http::StatusCode, String) {
    let reason = format!(
        "singleton task {task_id} is owned by unreachable machine {machine_id}: {error}; no replacement was created"
    );
    log::error!("{reason}");
    (axum::http::StatusCode::SERVICE_UNAVAILABLE, reason)
}

async fn signal_local_singleton(
    state: &Arc<AppState>,
    repo_id: &str,
    agent: &str,
    message: &str,
    running: crate::db::OpenAgentTask,
) -> Result<SignalAgentResponse, (axum::http::StatusCode, String)> {
    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    // A singleton that refuses delivered input is the one failure here that
    // no retry fixes and that nothing else would ever surface.
    if let Err(error) =
        super::task_input::try_submit_task_input(&mut daemon, &running.session_id, message).await
    {
        return Err(match error {
            super::task_input::TaskInputError::InputBlocked(reason) => {
                super::task_input::record_input_blocked_target(state, &running.session_id).await;
                log::error!(
                    "the {agent} agent for repo {repo_id} refuses delivered input: {reason}"
                );
                (axum::http::StatusCode::CONFLICT, reason)
            }
            super::task_input::TaskInputError::HeldByRawDraft(reason) => {
                log::error!(
                    "the {agent} agent for repo {repo_id} queued delivered input behind an unsent human line: {reason}"
                );
                (axum::http::StatusCode::CONFLICT, reason)
            }
            super::task_input::TaskInputError::SessionNotFound => (
                axum::http::StatusCode::NOT_FOUND,
                format!("session not found: {}", running.session_id),
            ),
            super::task_input::TaskInputError::Uncertain(message) => (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                format!("terminal input delivery is uncertain: {message}"),
            ),
            super::task_input::TaskInputError::Other(message) => {
                (axum::http::StatusCode::INTERNAL_SERVER_ERROR, message)
            }
        });
    }
    Ok(SignalAgentResponse {
        task_id: running.task_id,
        created: false,
    })
}

/// A rejected provider or effort override is the caller's mistake, so it must
/// read as a bad request rather than a server failure.
fn prepare_singleton_error(error: PrepareTaskError) -> (axum::http::StatusCode, String) {
    match error {
        PrepareTaskError::InvalidRequest(error) => (axum::http::StatusCode::BAD_REQUEST, error),
        other => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            other.to_string(),
        ),
    }
}

fn spawn_signal_agent_task_detached(
    state: Arc<AppState>,
    prepared: crate::task_creator::PreparedTaskSpawn,
) {
    tokio::spawn(async move {
        let task_id = prepared.task_id().to_string();
        let config: Config = state.config().clone();
        let result = async {
            let mut daemon = crate::daemon_client::DaemonClient::connect(&config.daemon_dir)
                .await
                .map_err(|e| format!("daemon error: {}", e))?;
            crate::task_creator::spawn_prepared_task_for_api_with_diagnostics(
                &config.db_path,
                &mut daemon,
                prepared,
            )
            .await
            .map(|_| ())
        }
        .await;
        match result {
            Ok(()) => state.publish_state_changed(StateChangeScope::Tasks),
            Err(error) => {
                log::error!("failed to spawn signaled agent task {task_id}: {error}");
                state.publish_state_changed(StateChangeScope::Tasks);
            }
        }
    });
}
