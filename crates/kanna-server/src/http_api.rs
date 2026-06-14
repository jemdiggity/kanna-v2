use crate::config::Config;
use crate::db::Db;
use crate::mobile_api::MobileApi;
use crate::pairing::{self, PairingSession};
use axum::body::Body;
use axum::extract::ws::{Message as WebSocketMessage, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::Request;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use kanna_agent_protocol::AgentEvent;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::ServiceExt;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct AppState {
    config: Config,
    pairing_session: Arc<Mutex<Option<PairingSession>>>,
    #[cfg(test)]
    task_creator: Option<TestTaskCreator>,
    #[cfg(test)]
    merge_agent_runner: Option<TestMergeAgentRunner>,
    #[cfg(test)]
    task_input_sender: Option<TestTaskInputSender>,
    #[cfg(test)]
    task_closer: Option<TestTaskCloser>,
    #[cfg(test)]
    stage_advancer: Option<TestStageAdvancer>,
    #[cfg(test)]
    stage_completer: Option<TestStageCompleter>,
    #[cfg(test)]
    revision_requester: Option<TestRevisionRequester>,
    #[cfg(test)]
    task_terminal_streamer: Option<TestTaskTerminalStreamer>,
}

#[cfg(test)]
type TestTaskCreator = Arc<
    dyn Fn(
            crate::mobile_api::CreateTaskRequest,
        ) -> Result<crate::mobile_api::CreateTaskResponse, String>
        + Send
        + Sync,
>;

#[cfg(test)]
type TestMergeAgentRunner =
    Arc<dyn Fn(String) -> Result<crate::mobile_api::TaskActionResponse, String> + Send + Sync>;

#[cfg(test)]
type TestTaskInputSender = Arc<dyn Fn(String, String) -> Result<(), String> + Send + Sync>;

#[cfg(test)]
type TestTaskCloser = Arc<dyn Fn(String) -> Result<(), String> + Send + Sync>;

#[cfg(test)]
type TestStageAdvancer =
    Arc<dyn Fn(String) -> Result<crate::mobile_api::TaskActionResponse, String> + Send + Sync>;

#[cfg(test)]
type TestStageCompleter = Arc<
    dyn Fn(
            String,
            crate::mobile_api::CompleteStageRequest,
        ) -> Result<crate::mobile_api::TaskActionResponse, String>
        + Send
        + Sync,
>;

#[cfg(test)]
type TestRevisionRequester = Arc<
    dyn Fn(
            String,
            crate::mobile_api::RequestRevisionRequest,
        ) -> Result<crate::mobile_api::TaskActionResponse, String>
        + Send
        + Sync,
>;

#[cfg(test)]
type TestTaskTerminalStreamer =
    Arc<dyn Fn(String) -> Result<Vec<TaskTerminalStreamEvent>, String> + Send + Sync>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TaskTerminalStreamEvent {
    Ready { task_id: String },
    Output { task_id: String, text: String },
    Exit { task_id: String, code: i32 },
    Error { task_id: String, message: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpInvokeResponse {
    pub status: u16,
    pub body: Option<serde_json::Value>,
    pub error: Option<String>,
}

fn db_write_error(message_prefix: &str, err: rusqlite::Error) -> (axum::http::StatusCode, String) {
    match err {
        rusqlite::Error::QueryReturnedNoRows => (
            axum::http::StatusCode::NOT_FOUND,
            format!("{message_prefix}: not found"),
        ),
        err => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("{message_prefix}: {}", err),
        ),
    }
}

impl AppState {
    pub(crate) fn config(&self) -> &Config {
        &self.config
    }

    pub fn new(config: Config) -> Self {
        if let Err(err) = pairing::PairingStore::load(Path::new(&config.pairing_store_path)) {
            log::warn!(
                "failed to load pairing store {}: {}",
                config.pairing_store_path,
                err
            );
        }

        Self {
            config,
            pairing_session: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            task_creator: None,
            #[cfg(test)]
            merge_agent_runner: None,
            #[cfg(test)]
            task_input_sender: None,
            #[cfg(test)]
            task_closer: None,
            #[cfg(test)]
            stage_advancer: None,
            #[cfg(test)]
            stage_completer: None,
            #[cfg(test)]
            revision_requester: None,
            #[cfg(test)]
            task_terminal_streamer: None,
        }
    }

    pub async fn mobile_server_status(&self) -> crate::mobile_api::MobileServerStatus {
        let pairing_code = {
            let session = self.pairing_session.lock().await;
            pairing::active_pairing_code(session.as_ref())
        };
        crate::mobile_api::build_mobile_server_status(&self.config, pairing_code)
    }

    #[cfg(test)]
    fn with_task_creator(config: Config, task_creator: TestTaskCreator) -> Self {
        let mut state = Self::new(config);
        state.task_creator = Some(task_creator);
        state
    }

    #[cfg(test)]
    fn with_merge_agent_runner(config: Config, merge_agent_runner: TestMergeAgentRunner) -> Self {
        let mut state = Self::new(config);
        state.merge_agent_runner = Some(merge_agent_runner);
        state
    }

    #[cfg(test)]
    fn with_task_input_sender(config: Config, task_input_sender: TestTaskInputSender) -> Self {
        let mut state = Self::new(config);
        state.task_input_sender = Some(task_input_sender);
        state
    }

    #[cfg(test)]
    fn with_task_closer(config: Config, task_closer: TestTaskCloser) -> Self {
        let mut state = Self::new(config);
        state.task_closer = Some(task_closer);
        state
    }

    #[cfg(test)]
    fn with_stage_advancer(config: Config, stage_advancer: TestStageAdvancer) -> Self {
        let mut state = Self::new(config);
        state.stage_advancer = Some(stage_advancer);
        state
    }

    #[cfg(test)]
    fn with_stage_completer(config: Config, stage_completer: TestStageCompleter) -> Self {
        let mut state = Self::new(config);
        state.stage_completer = Some(stage_completer);
        state
    }

    #[cfg(test)]
    fn with_revision_requester(config: Config, revision_requester: TestRevisionRequester) -> Self {
        let mut state = Self::new(config);
        state.revision_requester = Some(revision_requester);
        state
    }

    #[cfg(test)]
    fn with_task_terminal_streamer(
        config: Config,
        task_terminal_streamer: TestTaskTerminalStreamer,
    ) -> Self {
        let mut state = Self::new(config);
        state.task_terminal_streamer = Some(task_terminal_streamer);
        state
    }
}

async fn list_desktops(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::mobile_api::DesktopDescriptor>>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let api = MobileApi::new(state.config.clone(), db);
    let desktops = api
        .list_desktops()
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(desktops))
}

async fn list_repos(
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

async fn add_repo(
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
    api.add_repo(payload).map(Json).map_err(|e| {
        let status = match &e {
            crate::mobile_api::AddRepoError::InvalidPath(_) => axum::http::StatusCode::BAD_REQUEST,
            crate::mobile_api::AddRepoError::DuplicatePath => axum::http::StatusCode::CONFLICT,
            crate::mobile_api::AddRepoError::Internal(_) => {
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        (status, e.message())
    })
}

async fn list_repo_tasks(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(repo_id): axum::extract::Path<String>,
) -> Result<Json<Vec<crate::mobile_api::TaskSummary>>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let api = MobileApi::new(state.config.clone(), db);
    let tasks = api
        .list_repo_tasks(&repo_id)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(tasks))
}

async fn status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<crate::mobile_api::MobileServerStatus>, (axum::http::StatusCode, String)> {
    Ok(Json(state.mobile_server_status().await))
}

async fn list_recent_tasks(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::mobile_api::TaskSummary>>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let api = MobileApi::new(state.config.clone(), db);
    let tasks = api
        .list_recent_tasks()
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(tasks))
}

async fn get_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::TaskDetail>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let api = MobileApi::new(state.config.clone(), db);
    let task = api
        .get_task(&task_id)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {task_id}"),
            )
        })?;
    Ok(Json(task))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchTasksQuery {
    query: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskInputRequest {
    input: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskLogsQuery {
    tail: Option<usize>,
}

const DEFAULT_TASK_LOG_TAIL: usize = 50;

/// Delay between typing a task-input message and the synthesized Enter.
///
/// The agent CLI coalesces a single bulk write (message text plus a trailing
/// carriage return) as a *paste*, where the CR is folded into the buffer as a
/// literal newline and the message is never submitted. Writing the text and the
/// carriage return as two Input commands separated by a short pause makes the CR
/// register as a discrete Enter keystroke — exactly how a human types then
/// presses Enter. 150ms was validated against the live Claude CLI.
const SUBMIT_ENTER_DELAY_MS: u64 = 150;

/// The message portion of a `/v1/tasks/{id}/input` payload: the caller's text
/// with any trailing CR/LF stripped (callers vary — the CLI may append `\r`, the
/// MCP appends nothing). The Enter is synthesized separately by the handler.
fn task_input_message(input: &str) -> &str {
    input.trim_end_matches(['\r', '\n'])
}

/// Send one raw Input command to a daemon session, mapping daemon failures to
/// an HTTP error.
async fn send_session_input(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    data: Vec<u8>,
) -> Result<(), (axum::http::StatusCode, String)> {
    let event = daemon
        .send_command(&DaemonCommand::Input {
            session_id: session_id.to_string(),
            data,
        })
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;
    match event {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error { message, .. } => {
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, message))
        }
        other => Err((
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("unexpected daemon response: {:?}", other),
        )),
    }
}

pub(crate) async fn submit_task_input(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    input: &str,
) -> Result<(), (axum::http::StatusCode, String)> {
    // Type the message, then press Enter as a discrete keystroke (see
    // SUBMIT_ENTER_DELAY_MS). The daemon stays a raw byte pipe; this submission
    // policy lives here so every client — kanna-cli, kanna-mcp, mobile, and
    // server-side notifications — submits consistently.
    let message = task_input_message(input);
    if !message.is_empty() {
        send_session_input(daemon, session_id, message.as_bytes().to_vec()).await?;
        tokio::time::sleep(std::time::Duration::from_millis(SUBMIT_ENTER_DELAY_MS)).await;
    }
    send_session_input(daemon, session_id, vec![b'\r']).await?;
    Ok(())
}

async fn search_tasks(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<SearchTasksQuery>,
) -> Result<Json<Vec<crate::mobile_api::TaskSummary>>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let api = MobileApi::new(state.config.clone(), db);
    let tasks = api
        .search_tasks(&query.query)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(tasks))
}

async fn create_pairing_session(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PairingSession>, (axum::http::StatusCode, String)> {
    let session = pairing::create_pairing_session(&state.config)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    {
        let mut pairing_session = state.pairing_session.lock().await;
        *pairing_session = Some(session.clone());
    }
    Ok(Json(session))
}

async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<crate::mobile_api::CreateTaskRequest>,
) -> Result<Json<crate::mobile_api::CreateTaskResponse>, (axum::http::StatusCode, String)> {
    #[cfg(test)]
    if let Some(task_creator) = state.task_creator.clone() {
        return task_creator(payload)
            .map(Json)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let blocker_task_ids = payload.blocker_task_ids.clone().unwrap_or_default();
    let resolved_blocker_ids = if blocker_task_ids.is_empty() {
        Vec::new()
    } else {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        resolve_task_blocker_ids(&db, &blocker_task_ids)?
    };
    let prepared = {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        crate::task_creator::prepare_task_for_api(&db, &state.config, payload)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
    };
    if !resolved_blocker_ids.is_empty() {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        if let Err(err) = persist_resolved_task_blockers(
            &db,
            crate::task_creator::prepared_task_id(&prepared),
            &resolved_blocker_ids,
        ) {
            let rollback_result =
                crate::task_creator::rollback_prepared_task_for_api(&db, &prepared);
            return Err(match rollback_result {
                Ok(()) => err,
                Err(rollback_err) => (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("{}; rollback failed: {}", err.1, rollback_err),
                ),
            });
        }
    }
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
    Ok(Json(created))
}

fn parse_tags_json(tags_json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(tags_json).unwrap_or_default()
}

fn render_tags_json(tags: &[String]) -> Result<String, (axum::http::StatusCode, String)> {
    serde_json::to_string(tags).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to serialize tags: {}", e),
        )
    })
}

fn add_blocked_tag(db: &Db, task_id: &str) -> Result<(), (axum::http::StatusCode, String)> {
    let tags_json = db
        .pipeline_item_tags(task_id)
        .map_err(|e| db_write_error("db error", e))?;
    let mut tags = parse_tags_json(&tags_json);
    if !tags.iter().any(|tag| tag == "blocked") {
        tags.push("blocked".to_string());
    }
    let rendered = render_tags_json(&tags)?;
    db.update_pipeline_item_tags(task_id, &rendered)
        .map_err(|e| db_write_error("db error", e))
}

fn remove_blocked_tag(db: &Db, task_id: &str) -> Result<(), (axum::http::StatusCode, String)> {
    let tags_json = db
        .pipeline_item_tags(task_id)
        .map_err(|e| db_write_error("db error", e))?;
    let tags = parse_tags_json(&tags_json)
        .into_iter()
        .filter(|tag| tag != "blocked")
        .collect::<Vec<_>>();
    let rendered = render_tags_json(&tags)?;
    db.update_pipeline_item_tags(task_id, &rendered)
        .map_err(|e| db_write_error("db error", e))
}

fn resolve_existing_task_id(
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

fn resolve_task_blocker_ids(
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

fn persist_resolved_task_blockers(
    db: &Db,
    task_id: &str,
    resolved_blocker_ids: &[String],
) -> Result<(), (axum::http::StatusCode, String)> {
    for blocker_id in resolved_blocker_ids {
        db.insert_task_blocker(task_id, blocker_id)
            .map_err(|e| db_write_error("db error", e))?;
    }
    add_blocked_tag(db, task_id)?;
    db.update_pipeline_item_activity(task_id, "idle")
        .map_err(|e| db_write_error("db error", e))
}

fn apply_task_blockers(
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

    let task_id = resolve_existing_task_id(db, task_or_branch_id)?;
    let resolved_blocker_ids = resolve_task_blocker_ids(db, blocker_task_ids)?;
    for blocker_id in &resolved_blocker_ids {
        if blocker_id == &task_id {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                "task cannot block itself".to_string(),
            ));
        }
        if db
            .task_dependency_has_path_to(&blocker_id, &task_id)
            .map_err(|e| db_write_error("db error", e))?
        {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                "cannot add blocker because it would create a circular dependency".to_string(),
            ));
        }
    }

    persist_resolved_task_blockers(db, &task_id, &resolved_blocker_ids)?;
    Ok(task_id)
}

async fn block_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<crate::mobile_api::BlockTaskRequest>,
) -> Result<Json<crate::mobile_api::TaskActionResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = apply_task_blockers(&db, &task_id, &payload.blocker_task_ids)?;
    Ok(Json(crate::mobile_api::TaskActionResponse { task_id }))
}

async fn unblock_task(
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
    db.remove_all_task_blockers(&task_id)
        .map_err(|e| db_write_error("db error", e))?;
    remove_blocked_tag(&db, &task_id)?;
    Ok(Json(crate::mobile_api::TaskActionResponse { task_id }))
}

async fn run_merge_agent(
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

async fn send_task_input(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<TaskInputRequest>,
) -> Result<axum::http::StatusCode, (axum::http::StatusCode, String)> {
    #[cfg(test)]
    if let Some(task_input_sender) = state.task_input_sender.clone() {
        return task_input_sender(task_id, payload.input)
            .map(|_| axum::http::StatusCode::NO_CONTENT)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e));
    }

    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;

    submit_task_input(&mut daemon, &task_id, &payload.input).await?;

    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub(crate) async fn handle_task_terminal_state(
    config: &Config,
    task_id: &str,
    success: bool,
) -> Result<(), String> {
    let pipeline_item_id = {
        let db = Db::open(&config.db_path).map_err(|e| format!("db error: {}", e))?;
        let Some(pipeline_item_id) = db
            .resolve_pipeline_item_id(task_id)
            .map_err(|e| format!("db error: {}", e))?
        else {
            return Ok(());
        };
        db.update_pipeline_item_activity(&pipeline_item_id, "unread")
            .map_err(|e| format!("db error: {}", e))?;
        pipeline_item_id
    };
    notify_task_completion(config, &pipeline_item_id, success).await
}

async fn notify_task_completion(
    config: &Config,
    child_id: &str,
    success: bool,
) -> Result<(), String> {
    let notification = {
        let db = Db::open(&config.db_path).map_err(|e| format!("db error: {}", e))?;
        db.claim_task_notification(child_id)
            .map_err(|e| format!("db error: {}", e))?
    };
    let Some(notification) = notification else {
        return Ok(());
    };
    let status = if success { "success" } else { "failure" };
    let message = format!(
        "TASK {} DONE [{}]: {}",
        notification.child_id, status, notification.title
    );
    let mut daemon = crate::daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("daemon error: {}", e))?;
    submit_task_input(&mut daemon, &notification.notify_task_id, &message)
        .await
        .map_err(|(_, message)| message)
}

async fn task_logs(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<TaskLogsQuery>,
) -> Result<Response, (axum::http::StatusCode, String)> {
    let tail = query.tail.unwrap_or(DEFAULT_TASK_LOG_TAIL).max(1);
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
                format!("task not found: {task_id}"),
            )
        })?;
    let item = db.get_pipeline_item(&pipeline_item_id).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let Some(item) = item else {
        return Err((
            axum::http::StatusCode::NOT_FOUND,
            format!("task not found: {task_id}"),
        ));
    };
    let text = if item.agent_type.as_deref() == Some("agent") {
        render_agent_journal_logs(&state.config.daemon_dir, &pipeline_item_id, tail)?
    } else {
        render_pty_snapshot_logs(&state.config.daemon_dir, &pipeline_item_id).await
    };
    Ok((
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        text,
    )
        .into_response())
}

fn render_agent_journal_logs(
    daemon_dir: &str,
    session_id: &str,
    tail: usize,
) -> Result<String, (axum::http::StatusCode, String)> {
    let path = Path::new(daemon_dir)
        .join("agent-journals")
        .join(format!("{session_id}.ndjson"));
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok("no logs for agent session".to_string());
        }
        Err(error) => {
            return Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read agent journal: {error}"),
            ));
        }
    };
    let mut rendered = contents
        .lines()
        .filter_map(|line| serde_json::from_str::<kanna_daemon::protocol::SeqAgentEvent>(line).ok())
        .filter_map(|entry| render_agent_event(entry.event))
        .collect::<Vec<_>>();
    if rendered.len() > tail {
        rendered = rendered.split_off(rendered.len() - tail);
    }
    if rendered.is_empty() {
        Ok("no relevant agent logs".to_string())
    } else {
        Ok(rendered.join("\n"))
    }
}

fn render_agent_event(event: AgentEvent) -> Option<String> {
    match event {
        AgentEvent::AssistantText { text, .. } => Some(text),
        AgentEvent::ToolResult {
            output, is_error, ..
        } => {
            let prefix = if is_error {
                "tool error"
            } else {
                "tool result"
            };
            Some(format!("{prefix}: {output}"))
        }
        _ => None,
    }
}

async fn render_pty_snapshot_logs(daemon_dir: &str, session_id: &str) -> String {
    let mut daemon = match crate::daemon_client::DaemonClient::connect(daemon_dir).await {
        Ok(daemon) => daemon,
        Err(error) => return format!("no logs for pty session: daemon unavailable: {error}"),
    };
    let event = daemon
        .send_command(&DaemonCommand::Snapshot {
            session_id: session_id.to_string(),
        })
        .await;
    match event {
        Ok(DaemonEvent::Snapshot { snapshot, .. }) => strip_ansi(&snapshot.vt),
        Ok(DaemonEvent::Error { message, .. }) => {
            format!("no logs for pty session: {message}")
        }
        Ok(other) => format!("no logs for pty session: unexpected daemon response: {other:?}"),
        Err(error) => format!("no logs for pty session: daemon error: {error}"),
    }
}

fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            let _ = chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            output.push(ch);
        }
    }
    output
}

async fn close_task(
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

    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("daemon error: {}", e),
            )
        })?;

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

async fn advance_stage(
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
    match transition {
        crate::task_creator::PreparedStageTransition::Spawn(prepared) => {
            let created = crate::task_creator::spawn_prepared_task_for_api(&mut daemon, prepared)
                .await
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
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
                prepared,
            )
            .await
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
            Ok(Json(continued))
        }
    }
}

async fn complete_stage(
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

    {
        let db = Db::open(&state.config.db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?;
        db.update_pipeline_item_stage_result(&task_id, &stage_result)
            .map_err(|e| db_write_error("db error", e))?;
    }

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
            let created = crate::task_creator::spawn_prepared_task_for_api(&mut daemon, prepared)
                .await
                .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
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
                prepared,
            )
            .await
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
            Ok(Json(continued))
        }
    }
}

async fn request_revision(
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

async fn task_terminal(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> axum::response::Response {
    ws.on_upgrade(move |socket| stream_task_terminal(socket, state, task_id))
}

async fn ksp_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    ws.on_upgrade(move |socket| crate::ksp::handle_stream(socket, state))
}

async fn stream_task_terminal(socket: WebSocket, state: Arc<AppState>, task_id: String) {
    #[cfg(test)]
    if let Some(task_terminal_streamer) = state.task_terminal_streamer.clone() {
        match task_terminal_streamer(task_id.clone()) {
            Ok(events) => {
                stream_prebuilt_task_terminal_events(socket, events).await;
            }
            Err(message) => {
                stream_prebuilt_task_terminal_events(
                    socket,
                    vec![TaskTerminalStreamEvent::Error { task_id, message }],
                )
                .await;
            }
        }
        return;
    }

    let mut socket = socket;
    let daemon_session_id = match Db::open(&state.config.db_path)
        .and_then(|db| db.resolve_task_terminal_session_id(&task_id))
    {
        Ok(Some(session_id)) => session_id,
        Ok(None) => {
            let _ = send_task_terminal_event(
                &mut socket,
                TaskTerminalStreamEvent::Error {
                    task_id,
                    message: "No terminal session is available for this task.".to_string(),
                },
            )
            .await;
            return;
        }
        Err(error) => {
            let _ = send_task_terminal_event(
                &mut socket,
                TaskTerminalStreamEvent::Error {
                    task_id,
                    message: format!("db error: {error}"),
                },
            )
            .await;
            return;
        }
    };

    let daemon_result = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|error| format!("daemon error: {error}"));
    let mut daemon = match daemon_result {
        Ok(daemon) => daemon,
        Err(message) => {
            let _ = send_task_terminal_event(
                &mut socket,
                TaskTerminalStreamEvent::Error { task_id, message },
            )
            .await;
            return;
        }
    };

    let observe_result = daemon
        .send_command(&DaemonCommand::Observe {
            session_id: daemon_session_id.clone(),
        })
        .await
        .map_err(|error| format!("daemon error: {error}"));
    match observe_result {
        Ok(DaemonEvent::Ok) => {
            if send_task_terminal_event(
                &mut socket,
                TaskTerminalStreamEvent::Ready {
                    task_id: task_id.clone(),
                },
            )
            .await
            .is_err()
            {
                return;
            }

            match read_initial_task_terminal_event(&mut daemon, &task_id, &daemon_session_id).await
            {
                Ok(Some(initial_event)) => {
                    let should_stop = matches!(
                        initial_event,
                        TaskTerminalStreamEvent::Exit { .. }
                            | TaskTerminalStreamEvent::Error { .. }
                    );
                    if send_task_terminal_event(&mut socket, initial_event)
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if should_stop {
                        return;
                    }
                }
                Ok(None) => {}
                Err(message) => {
                    let _ = send_task_terminal_event(
                        &mut socket,
                        TaskTerminalStreamEvent::Error { task_id, message },
                    )
                    .await;
                    return;
                }
            }
        }
        Ok(DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
            ..
        }) => {
            let _ = send_task_terminal_event(
                &mut socket,
                TaskTerminalStreamEvent::Error {
                    task_id,
                    message: "No terminal session is available for this task.".to_string(),
                },
            )
            .await;
            return;
        }
        Ok(DaemonEvent::Error { message, .. }) => {
            let _ = send_task_terminal_event(
                &mut socket,
                TaskTerminalStreamEvent::Error { task_id, message },
            )
            .await;
            return;
        }
        Ok(other) => {
            let _ = send_task_terminal_event(
                &mut socket,
                TaskTerminalStreamEvent::Error {
                    task_id,
                    message: format!("unexpected daemon response: {:?}", other),
                },
            )
            .await;
            return;
        }
        Err(message) => {
            let _ = send_task_terminal_event(
                &mut socket,
                TaskTerminalStreamEvent::Error { task_id, message },
            )
            .await;
            return;
        }
    }

    loop {
        let event = match daemon
            .read_event()
            .await
            .map_err(|error| format!("daemon read error: {error}"))
        {
            Ok(event) => event,
            Err(message) => {
                let _ = send_task_terminal_event(
                    &mut socket,
                    TaskTerminalStreamEvent::Error {
                        task_id: task_id.clone(),
                        message,
                    },
                )
                .await;
                break;
            }
        };

        let next_event = match daemon_event_to_task_terminal_event(&task_id, event) {
            Some(next_event) => next_event,
            None => continue,
        };

        let should_stop = matches!(
            next_event,
            TaskTerminalStreamEvent::Exit { .. } | TaskTerminalStreamEvent::Error { .. }
        );
        if send_task_terminal_event(&mut socket, next_event)
            .await
            .is_err()
        {
            break;
        }
        if should_stop {
            break;
        }
    }
}

async fn read_initial_task_terminal_event(
    daemon: &mut crate::daemon_client::DaemonClient,
    task_id: &str,
    daemon_session_id: &str,
) -> Result<Option<TaskTerminalStreamEvent>, String> {
    let mut event = daemon
        .send_command(&DaemonCommand::Snapshot {
            session_id: daemon_session_id.to_string(),
        })
        .await
        .map_err(|error| format!("daemon snapshot error: {error}"))?;

    loop {
        match event {
            DaemonEvent::Snapshot { snapshot, .. } => {
                return Ok(snapshot_output_event(task_id, snapshot));
            }
            DaemonEvent::Exit { code, .. } => {
                return Ok(Some(TaskTerminalStreamEvent::Exit {
                    task_id: task_id.to_string(),
                    code,
                }))
            }
            DaemonEvent::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                ..
            } => return Ok(None),
            DaemonEvent::Error { message, .. } => {
                return Ok(Some(TaskTerminalStreamEvent::Error {
                    task_id: task_id.to_string(),
                    message,
                }));
            }
            DaemonEvent::Output { .. } | DaemonEvent::StatusChanged { .. } => {
                event = daemon
                    .read_event()
                    .await
                    .map_err(|error| format!("daemon snapshot error: {error}"))?;
            }
            _ => {
                event = daemon
                    .read_event()
                    .await
                    .map_err(|error| format!("daemon snapshot error: {error}"))?;
            }
        }
    }
}

fn daemon_event_to_task_terminal_event(
    task_id: &str,
    event: DaemonEvent,
) -> Option<TaskTerminalStreamEvent> {
    match event {
        DaemonEvent::Output { data, .. } => {
            let text = String::from_utf8_lossy(&data).to_string();
            if text.is_empty() {
                return None;
            }

            Some(TaskTerminalStreamEvent::Output {
                task_id: task_id.to_string(),
                text,
            })
        }
        DaemonEvent::Exit { code, .. } => Some(TaskTerminalStreamEvent::Exit {
            task_id: task_id.to_string(),
            code,
        }),
        DaemonEvent::Error { message, .. } => Some(TaskTerminalStreamEvent::Error {
            task_id: task_id.to_string(),
            message,
        }),
        _ => None,
    }
}

fn snapshot_output_event(
    task_id: &str,
    snapshot: kanna_daemon::protocol::TerminalSnapshot,
) -> Option<TaskTerminalStreamEvent> {
    let text = snapshot.vt;
    if text.is_empty() {
        return None;
    }

    Some(TaskTerminalStreamEvent::Output {
        task_id: task_id.to_string(),
        text,
    })
}

#[cfg(test)]
async fn stream_prebuilt_task_terminal_events(
    mut socket: WebSocket,
    events: Vec<TaskTerminalStreamEvent>,
) {
    for event in events {
        let should_stop = matches!(
            event,
            TaskTerminalStreamEvent::Exit { .. } | TaskTerminalStreamEvent::Error { .. }
        );
        if send_task_terminal_event(&mut socket, event).await.is_err() {
            break;
        }
        if should_stop {
            break;
        }
    }
}

async fn send_task_terminal_event(
    socket: &mut WebSocket,
    event: TaskTerminalStreamEvent,
) -> Result<(), ()> {
    let json = serde_json::to_string(&event).map_err(|_| ())?;
    socket
        .send(WebSocketMessage::Text(json.into()))
        .await
        .map_err(|_| ())
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/status", get(status))
        .route("/v1/stream", get(ksp_stream))
        .route("/v1/desktops", get(list_desktops))
        .route("/v1/repos", get(list_repos).post(add_repo))
        .route("/v1/repos/{repo_id}/tasks", get(list_repo_tasks))
        .route("/v1/tasks/recent", get(list_recent_tasks))
        .route("/v1/tasks/search", get(search_tasks))
        .route("/v1/tasks", post(create_task))
        .route("/v1/tasks/{task_id}", get(get_task))
        .route("/v1/tasks/{task_id}/logs", get(task_logs))
        .route("/v1/tasks/{task_id}/terminal", get(task_terminal))
        .route("/v1/tasks/{task_id}/input", post(send_task_input))
        .route("/v1/tasks/{task_id}/actions/block", post(block_task))
        .route("/v1/tasks/{task_id}/actions/unblock", post(unblock_task))
        .route(
            "/v1/tasks/{task_id}/actions/advance-stage",
            post(advance_stage),
        )
        .route(
            "/v1/tasks/{task_id}/actions/complete-stage",
            post(complete_stage),
        )
        .route(
            "/v1/tasks/{task_id}/actions/request-revision",
            post(request_revision),
        )
        .route("/v1/tasks/{task_id}/actions/close", post(close_task))
        .route(
            "/v1/tasks/{task_id}/actions/run-merge-agent",
            post(run_merge_agent),
        )
        .route("/v1/pairing/sessions", post(create_pairing_session))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

pub async fn dispatch_http_invoke(
    state: Arc<AppState>,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> HttpInvokeResponse {
    let method = match method.parse::<axum::http::Method>() {
        Ok(method) => method,
        Err(error) => {
            return HttpInvokeResponse {
                status: axum::http::StatusCode::BAD_REQUEST.as_u16(),
                body: None,
                error: Some(format!("invalid HTTP method: {error}")),
            };
        }
    };

    if !path.starts_with('/') {
        return HttpInvokeResponse {
            status: axum::http::StatusCode::BAD_REQUEST.as_u16(),
            body: None,
            error: Some("HTTP invoke path must start with /".to_string()),
        };
    }

    let body = if body.is_null() {
        Body::empty()
    } else {
        match serde_json::to_vec(&body) {
            Ok(bytes) => Body::from(bytes),
            Err(error) => {
                return HttpInvokeResponse {
                    status: axum::http::StatusCode::BAD_REQUEST.as_u16(),
                    body: None,
                    error: Some(format!("invalid HTTP invoke body: {error}")),
                };
            }
        }
    };

    let request = match Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(body)
    {
        Ok(request) => request,
        Err(error) => {
            return HttpInvokeResponse {
                status: axum::http::StatusCode::BAD_REQUEST.as_u16(),
                body: None,
                error: Some(format!("invalid HTTP invoke request: {error}")),
            };
        }
    };

    match router(state).oneshot(request).await {
        Ok(response) => response_to_http_invoke(response).await,
        Err(error) => HttpInvokeResponse {
            status: axum::http::StatusCode::INTERNAL_SERVER_ERROR.as_u16(),
            body: None,
            error: Some(format!("HTTP invoke dispatch failed: {error}")),
        },
    }
}

async fn response_to_http_invoke(response: axum::response::Response) -> HttpInvokeResponse {
    let status = response.status();
    let bytes = match axum::body::to_bytes(response.into_body(), usize::MAX).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return HttpInvokeResponse {
                status: axum::http::StatusCode::INTERNAL_SERVER_ERROR.as_u16(),
                body: None,
                error: Some(format!("failed to read HTTP invoke response: {error}")),
            };
        }
    };

    let body = if bytes.is_empty() {
        None
    } else {
        Some(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_else(|_| {
                serde_json::Value::String(String::from_utf8_lossy(&bytes).into_owned())
            }),
        )
    };
    let error = if status.is_success() {
        None
    } else {
        Some(match &body {
            Some(serde_json::Value::String(message)) => message.clone(),
            Some(value) => value.to_string(),
            None => status.to_string(),
        })
    };

    HttpInvokeResponse {
        status: status.as_u16(),
        body,
        error,
    }
}

pub async fn serve(state: Arc<AppState>) -> Result<(), String> {
    let bind_addr = format!("{}:{}", state.config.lan_host, state.config.lan_port);
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .map_err(|e| format!("failed to bind LAN API on {}: {}", bind_addr, e))?;
    log::info!("LAN API listening on {}", bind_addr);
    axum::serve(listener, router(state))
        .await
        .map_err(|e| format!("LAN API server failed: {}", e))
}

#[cfg(test)]
pub(crate) fn test_router(desktop_id: &str, desktop_name: &str) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(1);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::new(config)))
}

#[cfg(test)]
fn test_router_with_seed(desktop_id: &str, desktop_name: &str, seed: impl FnOnce(&Db)) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(5_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).expect("open test db");
    seed(&db);
    router(Arc::new(AppState::new(config)))
}

#[cfg(test)]
fn test_state_with_seed(
    desktop_id: &str,
    desktop_name: &str,
    seed: impl FnOnce(&Db),
) -> Arc<AppState> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(6_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-invoke-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-invoke-{desktop_id}-{test_db_id}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).expect("open test db");
    seed(&db);
    Arc::new(AppState::new(config))
}

#[cfg(test)]
fn test_state_with_task_input_sender(
    desktop_id: &str,
    desktop_name: &str,
    task_input_sender: TestTaskInputSender,
) -> Arc<AppState> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(7_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-invoke-input-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!(
            "/tmp/kanna-pairings-invoke-input-{desktop_id}-{test_db_id}.json"
        ),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    Arc::new(AppState::with_task_input_sender(config, task_input_sender))
}

#[cfg(test)]
fn test_router_with_task_creator(
    desktop_id: &str,
    desktop_name: &str,
    task_creator: TestTaskCreator,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(10_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_task_creator(config, task_creator)))
}

#[cfg(test)]
fn test_router_with_merge_agent_runner(
    desktop_id: &str,
    desktop_name: &str,
    merge_agent_runner: TestMergeAgentRunner,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(20_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_merge_agent_runner(
        config,
        merge_agent_runner,
    )))
}

#[cfg(test)]
fn test_router_with_task_input_sender(
    desktop_id: &str,
    desktop_name: &str,
    task_input_sender: TestTaskInputSender,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(25_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_task_input_sender(
        config,
        task_input_sender,
    )))
}

#[cfg(test)]
fn test_router_with_task_closer(
    desktop_id: &str,
    desktop_name: &str,
    task_closer: TestTaskCloser,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(27_500);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_task_closer(config, task_closer)))
}

#[cfg(test)]
fn test_router_with_stage_advancer(
    desktop_id: &str,
    desktop_name: &str,
    stage_advancer: TestStageAdvancer,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(28_500);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_stage_advancer(
        config,
        stage_advancer,
    )))
}

#[cfg(test)]
fn test_router_with_stage_completer(
    desktop_id: &str,
    desktop_name: &str,
    stage_completer: TestStageCompleter,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(29_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_stage_completer(
        config,
        stage_completer,
    )))
}

#[cfg(test)]
fn test_router_with_revision_requester(
    desktop_id: &str,
    desktop_name: &str,
    revision_requester: TestRevisionRequester,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(29_500);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_revision_requester(
        config,
        revision_requester,
    )))
}

#[cfg(test)]
fn test_router_with_terminal_streamer(
    desktop_id: &str,
    desktop_name: &str,
    task_terminal_streamer: TestTaskTerminalStreamer,
) -> Router {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(30_000);
    let test_db_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path(&format!("http-api-{desktop_id}-{test_db_id}")),
        kanna_cli_path: None,
        desktop_id: desktop_id.to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: desktop_name.to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}-{test_db_id}.json"),
    };
    let _ = Db::open_for_tests(&config.db_path).expect("open test db");
    router(Arc::new(AppState::with_task_terminal_streamer(
        config,
        task_terminal_streamer,
    )))
}

#[cfg(test)]
mod tests {
    use crate::config::Config;
    use crate::db::Db;
    use crate::mobile_api::{CreateTaskResponse, MobileServerStatus, TaskActionResponse};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::{routing::post, Json, Router};
    use kanna_agent_protocol::AgentEvent;
    use serde_json::from_slice;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn daemon_socket_path_for_dir(daemon_dir: &str) -> PathBuf {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let dir = PathBuf::from(daemon_dir);
        let mut hasher = DefaultHasher::new();
        dir.hash(&mut hasher);
        let hash = hasher.finish() as u32;
        PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
    }

    fn pipeline_socket_path_for_daemon_dir(daemon_dir: &str) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let dir = PathBuf::from(daemon_dir).join("pipeline");
        let mut hasher = DefaultHasher::new();
        dir.hash(&mut hasher);
        let hash = hasher.finish() as u32;
        format!("/tmp/kanna-{hash:08x}.sock")
    }

    fn ensure_test_kanna_cli_sidecar() -> (PathBuf, bool) {
        let sidecar_path = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("kanna-cli");
        if sidecar_path.exists() {
            return (sidecar_path, false);
        }

        std::fs::write(&sidecar_path, "#!/bin/sh\nexit 0\n").unwrap();
        (sidecar_path, true)
    }

    fn init_test_git_repo(repo_root: &Path) {
        let _ = std::fs::remove_dir_all(repo_root);
        std::fs::create_dir_all(repo_root).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["add", "README.md"])
            .current_dir(repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(repo_root)
            .status()
            .unwrap()
            .success());
    }

    #[tokio::test]
    async fn list_desktops_route_returns_configured_desktop() {
        let app = super::test_router("desktop-1", "Studio Mac");
        let response = app
            .oneshot(Request::get("/v1/desktops").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn list_repos_route_returns_repo_summaries() {
        let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_repo("repo-2", "Repo Two").unwrap();
        });

        let response = app
            .oneshot(Request::get("/v1/repos").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let repos: Vec<crate::mobile_api::RepoSummary> = from_slice(&body).unwrap();
        assert_eq!(
            repos,
            vec![
                crate::mobile_api::RepoSummary {
                    id: "repo-1".to_string(),
                    name: "Repo One".to_string(),
                },
                crate::mobile_api::RepoSummary {
                    id: "repo-2".to_string(),
                    name: "Repo Two".to_string(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn add_repo_route_registers_existing_git_repo() {
        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        );
        let repo_root = std::env::temp_dir().join(format!("kanna-http-add-repo-{unique}"));
        init_test_git_repo(&repo_root);
        let app = super::test_router("desktop-1", "Studio Mac");

        let response = app
            .oneshot(
                Request::post("/v1/repos")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "path": repo_root,
                            "name": "Registered Repo"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let repo: crate::mobile_api::RepoDetail = from_slice(&body).unwrap();
        assert_eq!(repo.name, "Registered Repo");
        assert_eq!(repo.default_branch.as_deref(), Some("main"));
        assert_eq!(repo.hidden, Some(0));

        let _ = std::fs::remove_dir_all(repo_root);
    }

    #[tokio::test]
    async fn add_repo_route_rejects_duplicate_path() {
        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        );
        let repo_root = std::env::temp_dir().join(format!("kanna-http-add-repo-dupe-{unique}"));
        init_test_git_repo(&repo_root);
        let app = super::test_router("desktop-1", "Studio Mac");
        let body = Body::from(
            serde_json::json!({
                "path": repo_root,
            })
            .to_string(),
        );
        let first = app
            .clone()
            .oneshot(
                Request::post("/v1/repos")
                    .header("content-type", "application/json")
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);

        let second = app
            .oneshot(
                Request::post("/v1/repos")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "path": repo_root,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(second.status(), StatusCode::CONFLICT);
        let _ = std::fs::remove_dir_all(repo_root);
    }

    #[tokio::test]
    async fn list_repo_tasks_route_returns_repo_scoped_tasks() {
        let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_repo("repo-2", "Repo Two").unwrap();
            db.insert_test_pipeline_item(
                "task-repo-1",
                "repo-1",
                "repo one prompt",
                Some("Repo One Task"),
                "in progress",
                "2026-04-17 07:00:00",
            )
            .unwrap();
            db.insert_test_pipeline_item(
                "task-repo-2",
                "repo-2",
                "repo two prompt",
                Some("Repo Two Task"),
                "pr",
                "2026-04-17 08:00:00",
            )
            .unwrap();
        });

        let response = app
            .oneshot(
                Request::get("/v1/repos/repo-1/tasks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "task-repo-1");
        assert_eq!(tasks[0].repo_id, "repo-1");
        assert_eq!(tasks[0].activity.as_deref(), Some("idle"));
    }

    #[tokio::test]
    async fn list_recent_tasks_route_returns_open_tasks_in_updated_order() {
        let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-older",
                "repo-1",
                "older prompt",
                Some("Older Task"),
                "in progress",
                "2026-04-17 06:00:00",
            )
            .unwrap();
            db.insert_test_pipeline_item(
                "task-newer",
                "repo-1",
                "newer prompt",
                Some("Newer Task"),
                "pr",
                "2026-04-17 07:00:00",
            )
            .unwrap();
            db.insert_test_pipeline_item(
                "task-done",
                "repo-1",
                "done prompt",
                Some("Done Task"),
                "done",
                "2026-04-17 08:00:00",
            )
            .unwrap();
            db.close_pipeline_item("task-done").unwrap();
            db.update_test_pipeline_item_preview("task-newer", Some("Latest agent output preview"))
                .unwrap();
        });

        let response = app
            .oneshot(
                Request::get("/v1/tasks/recent")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].id, "task-newer");
        assert_eq!(
            tasks[0].snippet.as_deref(),
            Some("Latest agent output preview")
        );
        assert_eq!(tasks[0].activity.as_deref(), Some("idle"));
        assert_eq!(tasks[1].id, "task-older");
    }

    #[tokio::test]
    async fn get_task_route_returns_full_task_detail_by_id() {
        let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "Review MCP task detail",
                Some("Review MCP"),
                "in progress",
                "2026-04-18 10:00:00",
            )
            .unwrap();
        });

        let response = app
            .oneshot(
                Request::get("/v1/tasks/task-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();

        assert_eq!(task.id, "task-1");
        assert_eq!(task.repo_id, "repo-1");
        assert_eq!(task.title, "Review MCP");
        assert_eq!(task.stage.as_deref(), Some("in progress"));
        assert_eq!(task.activity.as_deref(), Some("idle"));
        assert_eq!(task.agent_type.as_deref(), Some("pty"));
        assert_eq!(task.agent_provider.as_deref(), Some("claude"));
        assert_eq!(task.branch.as_deref(), Some("branch-task-1"));
        assert_eq!(task.pr_url, None);
        assert_eq!(task.closed_at, None);
        assert_eq!(task.worktree_path, None);
        assert_eq!(task.commits_ahead, 0);
        assert_eq!(task.commits_behind, 0);
        assert!(!task.dirty);
    }

    #[tokio::test]
    async fn get_task_route_returns_worktree_git_state() {
        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        );
        let repo_root = std::env::temp_dir().join(format!("kanna-http-detail-repo-{unique}"));
        let worktree = std::env::temp_dir().join(format!("kanna-http-detail-worktree-{unique}"));
        init_test_git_repo(&repo_root);
        assert!(Command::new("git")
            .args([
                "worktree",
                "add",
                "-b",
                "task-detail",
                worktree.to_str().unwrap()
            ])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        std::fs::write(worktree.join("feature.txt"), "feature").unwrap();
        assert!(Command::new("git")
            .args(["add", "feature.txt"])
            .current_dir(&worktree)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "feature"])
            .current_dir(&worktree)
            .status()
            .unwrap()
            .success());
        std::fs::write(worktree.join("dirty.txt"), "dirty").unwrap();

        let worktree_string = worktree.to_string_lossy().to_string();
        let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
                .unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "Review MCP task detail",
                Some("Review MCP"),
                "in progress",
                "2026-04-18 10:00:00",
            )
            .unwrap();
            db.update_test_pipeline_item_stage_context(
                "task-1",
                "task-detail",
                "default",
                None,
                "claude",
            )
            .unwrap();
            db.update_test_pipeline_item_base_ref("task-1", "main")
                .unwrap();
            db.upsert_worktree("wt-task-1", "task-1", &worktree_string, "task-detail")
                .unwrap();
        });

        let response = app
            .oneshot(
                Request::get("/v1/tasks/task-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();

        assert_eq!(
            task.worktree_path.as_deref(),
            Some(worktree_string.as_str())
        );
        assert_eq!(task.commits_ahead, 1);
        assert_eq!(task.commits_behind, 0);
        assert!(task.dirty);

        let _ = Command::new("git")
            .args(["worktree", "remove", "--force", worktree.to_str().unwrap()])
            .current_dir(&repo_root)
            .status();
        let _ = std::fs::remove_dir_all(repo_root);
        let _ = std::fs::remove_dir_all(worktree);
    }

    #[tokio::test]
    async fn get_task_route_accepts_branch_name_alias() {
        let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "Review MCP task detail",
                Some("Review MCP"),
                "in progress",
                "2026-04-18 10:00:00",
            )
            .unwrap();
        });

        let response = app
            .oneshot(
                Request::get("/v1/tasks/branch-task-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();

        assert_eq!(task.id, "task-1");
        assert_eq!(task.branch.as_deref(), Some("branch-task-1"));
    }

    #[tokio::test]
    async fn get_task_route_returns_not_found_for_unknown_task() {
        let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
        });

        let response = app
            .oneshot(
                Request::get("/v1/tasks/missing-task")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn task_logs_route_renders_agent_journal_tail() {
        let task_id = format!(
            "task-agent-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        );
        let journal_dir = PathBuf::from("/tmp/kanna-daemon").join("agent-journals");
        std::fs::create_dir_all(&journal_dir).unwrap();
        let journal_path = journal_dir.join(format!("{task_id}.ndjson"));
        let lines = [
            serde_json::to_string(&kanna_daemon::protocol::SeqAgentEvent {
                seq: 0,
                event: AgentEvent::AssistantText {
                    text: "first assistant".to_string(),
                    truncated: false,
                },
            })
            .unwrap(),
            serde_json::to_string(&kanna_daemon::protocol::SeqAgentEvent {
                seq: 1,
                event: AgentEvent::ToolResult {
                    call_id: "call-1".to_string(),
                    output: "tool output".to_string(),
                    truncated: false,
                    is_error: false,
                },
            })
            .unwrap(),
            serde_json::to_string(&kanna_daemon::protocol::SeqAgentEvent {
                seq: 2,
                event: AgentEvent::AssistantText {
                    text: "second assistant".to_string(),
                    truncated: false,
                },
            })
            .unwrap(),
        ]
        .join("\n");
        std::fs::write(&journal_path, lines).unwrap();

        let seeded_task_id = task_id.clone();
        let app = super::test_router_with_seed("desktop-1", "Studio Mac", move |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                &seeded_task_id,
                "repo-1",
                "Read logs",
                Some("Read logs"),
                "in progress",
                "2026-04-18 10:00:00",
            )
            .unwrap();
            db.update_test_pipeline_item_agent_type(&seeded_task_id, "agent")
                .unwrap();
        });

        let response = app
            .oneshot(
                Request::get(format!("/v1/tasks/{task_id}/logs?tail=2"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&body),
            "tool result: tool output\nsecond assistant"
        );

        let _ = std::fs::remove_file(journal_path);
    }

    #[tokio::test]
    async fn http_invoke_dispatches_shared_mobile_get_routes() {
        let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-newer",
                "repo-1",
                "newer prompt",
                Some("Newer Task"),
                "in progress",
                "2026-04-17 07:00:00",
            )
            .unwrap();
        });

        let repos = super::dispatch_http_invoke(
            Arc::clone(&state),
            "GET",
            "/v1/repos",
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(repos.status, 200);
        assert_eq!(
            repos.body,
            Some(serde_json::json!([
                {
                    "id": "repo-1",
                    "name": "Repo One"
                }
            ]))
        );
        assert_eq!(repos.error, None);

        let recent = super::dispatch_http_invoke(
            Arc::clone(&state),
            "GET",
            "/v1/tasks/recent",
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(recent.status, 200);
        assert_eq!(recent.body.as_ref().unwrap()[0]["id"], "task-newer");
        assert_eq!(recent.body.as_ref().unwrap()[0]["activity"], "idle");
        assert_eq!(recent.error, None);
    }

    #[tokio::test]
    async fn search_tasks_route_filters_by_query_text() {
        let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-merge",
                "repo-1",
                "follow up on merge conflicts",
                Some("Merge Cleanup"),
                "in progress",
                "2026-04-17 07:00:00",
            )
            .unwrap();
            db.insert_test_pipeline_item(
                "task-other",
                "repo-1",
                "write release notes",
                Some("Docs"),
                "in progress",
                "2026-04-17 06:00:00",
            )
            .unwrap();
            db.insert_test_pipeline_item(
                "task-done",
                "repo-1",
                "merge old branch",
                Some("Done Merge"),
                "done",
                "2026-04-17 08:00:00",
            )
            .unwrap();
            db.close_pipeline_item("task-done").unwrap();
        });

        let response = app
            .oneshot(
                Request::get("/v1/tasks/search?query=merge")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "task-merge");
        assert_eq!(tasks[0].title, "Merge Cleanup");
        assert_eq!(tasks[0].activity.as_deref(), Some("idle"));
    }

    #[tokio::test]
    async fn create_pairing_session_route_returns_pairing_payload() {
        let app = super::test_router("desktop-1", "Studio Mac");
        let response = app
            .oneshot(
                Request::post("/v1/pairing/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let pairing: crate::pairing::PairingSession = from_slice(&body).unwrap();
        assert_eq!(pairing.desktop_id, "desktop-1");
        assert_eq!(pairing.desktop_name, "Studio Mac");
        assert_eq!(pairing.lan_port, 48120);
        assert_eq!(pairing.code.len(), 6);
    }

    #[tokio::test]
    async fn create_pairing_session_route_uses_local_identity_without_desktop_secret() {
        let daemon_dir =
            std::env::temp_dir().join(format!("kanna-http-local-pairing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&daemon_dir);

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: crate::db::Db::test_db_path("http-local-pairing"),
            kanna_cli_path: None,
            desktop_id: "desktop-local".to_string(),
            desktop_secret: None,
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            pairing_store_path: PathBuf::from("/tmp/kanna-pairings-http-local.json")
                .to_string_lossy()
                .to_string(),
        };
        let _ = crate::db::Db::open_for_tests(&config.db_path).unwrap();
        let app = super::router(Arc::new(super::AppState::new(config)));

        let response = app
            .oneshot(
                Request::post("/v1/pairing/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let pairing: crate::pairing::PairingSession = from_slice(&body).unwrap();
        assert_eq!(pairing.desktop_id, "desktop-local");
        assert_eq!(pairing.desktop_name, "Studio Mac");
        assert_eq!(pairing.code.len(), 6);

        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn create_task_route_uses_task_creator() {
        let app = super::test_router_with_task_creator(
            "desktop-1",
            "Studio Mac",
            Arc::new(|payload| {
                assert_eq!(
                    payload.blocker_task_ids,
                    Some(vec!["blocker-1".to_string()])
                );
                Ok(CreateTaskResponse {
                    task_id: "task-1".to_string(),
                    repo_id: payload.repo_id,
                    title: payload.prompt,
                    stage: "in progress".to_string(),
                    agent_type: "agent".to_string(),
                    worktree_path: Some("/tmp/worktree".to_string()),
                })
            }),
        );

        let response = app
            .oneshot(
                Request::post("/v1/tasks")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "repoId": "repo-1",
                            "prompt": "Ship it",
                            "blockerTaskIds": ["blocker-1"]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: CreateTaskResponse = from_slice(&body).unwrap();
        assert_eq!(created.task_id, "task-1");
        assert_eq!(created.repo_id, "repo-1");
        assert_eq!(created.title, "Ship it");
        assert_eq!(created.stage, "in progress");
    }

    #[tokio::test]
    async fn create_task_route_uses_saved_default_agent_provider_when_payload_omits_provider() {
        use kanna_daemon::protocol::{
            AgentProvider, Command as DaemonCommand, Event as DaemonEvent,
        };
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixListener;

        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let repo_root =
            std::env::temp_dir().join(format!("kanna-http-create-default-provider-{unique}"));
        init_test_git_repo(&repo_root);

        let daemon_dir = std::env::temp_dir().join(format!(
            "kanna-http-create-default-provider-daemon-{unique}"
        ));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);
        let daemon_listener = UnixListener::bind(&socket_path).unwrap();
        let daemon_server = tokio::spawn(async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            let session_id = match command {
                DaemonCommand::Spawn {
                    session_id,
                    cwd,
                    agent_provider,
                    ..
                } => {
                    assert_eq!(agent_provider, Some(AgentProvider::Copilot));
                    assert!(cwd.contains(".kanna-worktrees/task-"));
                    session_id
                }
                other => panic!("expected spawn command, got {:?}", other),
            };
            write_half
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&DaemonEvent::SessionCreated { session_id }).unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: Db::test_db_path(&format!("http-api-default-provider-{unique}")),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-default-provider-{unique}.json"),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.set_test_setting("defaultAgentProvider", "copilot")
            .unwrap();
        drop(db);

        let app = super::router(Arc::new(super::AppState::new(config.clone())));
        let response = app
            .oneshot(
                Request::post("/v1/tasks")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "repoId": "repo-1",
                            "prompt": "Use the saved default provider"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: CreateTaskResponse = from_slice(&body).unwrap();
        let db = Db::open(&config.db_path).unwrap();
        let created_source = db.get_task_stage_source(&created.task_id).unwrap().unwrap();
        assert_eq!(created_source.agent_provider.as_deref(), Some("copilot"));

        daemon_server.await.unwrap();
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[tokio::test]
    async fn create_task_route_sends_kanna_cli_runtime_env_to_daemon_spawn() {
        use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixListener;

        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let repo_root = std::env::temp_dir().join(format!("kanna-http-create-env-{unique}"));
        init_test_git_repo(&repo_root);

        let (kanna_cli_path, created_test_sidecar) = ensure_test_kanna_cli_sidecar();
        let kanna_cli_path_string = kanna_cli_path.to_string_lossy().to_string();
        let kanna_cli_dir = kanna_cli_path
            .parent()
            .unwrap()
            .to_string_lossy()
            .to_string();

        let daemon_dir =
            std::env::temp_dir().join(format!("kanna-http-create-env-daemon-{unique}"));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let pipeline_socket_path =
            pipeline_socket_path_for_daemon_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);

        // Full desktop E2E would require launching the Tauri app plus staged sidecars
        // and a runnable agent CLI. This boundary test keeps the real HTTP handler,
        // task preparation, DB writes, worktree creation, and daemon Spawn contract in scope.
        let daemon_listener = UnixListener::bind(&socket_path).unwrap();
        let daemon_server = tokio::spawn({
            let expected_cli_path = kanna_cli_path_string.clone();
            let expected_cli_dir = kanna_cli_dir.clone();
            let expected_db_path = Db::test_db_path(&format!("http-api-create-env-{unique}"));
            let expected_socket_path = pipeline_socket_path.clone();
            async move {
                let (stream, _) = daemon_listener.accept().await.unwrap();
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
                let session_id = match command {
                    DaemonCommand::SpawnAgent { session_id, params } => {
                        assert!(params.cwd.contains(".kanna-worktrees/task-"));
                        let env = params.env;
                        assert_eq!(
                            env.get("KANNA_CLI_PATH").map(String::as_str),
                            Some(expected_cli_path.as_str())
                        );
                        assert_eq!(
                            env.get("KANNA_CLI_DB_PATH").map(String::as_str),
                            Some(expected_db_path.as_str())
                        );
                        assert_eq!(
                            env.get("KANNA_SOCKET_PATH").map(String::as_str),
                            Some(expected_socket_path.as_str())
                        );
                        assert_eq!(
                            env.get("KANNA_SERVER_BASE_URL").map(String::as_str),
                            Some("http://127.0.0.1:48120")
                        );
                        let path = env.get("PATH").expect("PATH should be set for sidecar");
                        assert_eq!(path.split(':').next(), Some(expected_cli_dir.as_str()));
                        session_id
                    }
                    other => panic!("expected SpawnAgent command, got {:?}", other),
                };
                write_half
                    .write_all(
                        format!(
                            "{}\n",
                            serde_json::to_string(&DaemonEvent::SessionCreated { session_id })
                                .unwrap()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });

        let db_path = Db::test_db_path(&format!("http-api-create-env-{unique}"));
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: db_path.clone(),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-create-env-{unique}.json"),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        drop(db);

        let app = super::router(Arc::new(super::AppState::new(config.clone())));
        let response = app
            .oneshot(
                Request::post("/v1/tasks")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "repoId": "repo-1",
                            "prompt": "Exercise server-created task spawn env",
                            "agentProvider": "claude"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        if response.status() != StatusCode::OK {
            daemon_server.abort();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            panic!(
                "expected create task to send Spawn env, got {status}: {}",
                String::from_utf8_lossy(&body)
            );
        }

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: CreateTaskResponse = from_slice(&body).unwrap();
        assert_eq!(created.repo_id, "repo-1");
        assert_eq!(created.stage, "in progress");

        daemon_server.await.unwrap();
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
        let _ = std::fs::remove_dir_all(&repo_root);
        if created_test_sidecar {
            let _ = std::fs::remove_file(&kanna_cli_path);
        }
    }

    #[tokio::test]
    async fn create_task_route_rejects_invalid_blocker_before_creating_task_or_spawning() {
        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let repo_root =
            std::env::temp_dir().join(format!("kanna-http-create-invalid-blocker-{unique}"));
        init_test_git_repo(&repo_root);

        let daemon_dir =
            std::env::temp_dir().join(format!("kanna-http-create-invalid-blocker-daemon-{unique}"));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: Db::test_db_path(&format!("http-api-invalid-blocker-{unique}")),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-invalid-blocker-{unique}.json"),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        drop(db);

        let app = super::router(Arc::new(super::AppState::new(config.clone())));
        let response = app
            .oneshot(
                Request::post("/v1/tasks")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "repoId": "repo-1",
                            "prompt": "Do not create this task",
                            "blockerTaskIds": ["missing-blocker"]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(
            String::from_utf8_lossy(&body).contains("task not found: missing-blocker"),
            "unexpected body: {}",
            String::from_utf8_lossy(&body)
        );
        assert!(
            !socket_path.exists(),
            "route should reject before daemon connection can be required"
        );
        let db = Db::open(&config.db_path).unwrap();
        assert_eq!(db.count_test_pipeline_items_for_repo("repo-1").unwrap(), 0);
        assert_eq!(db.count_test_worktrees_for_repo("repo-1").unwrap(), 0);
        assert_eq!(
            db.count_test_terminal_sessions_for_repo("repo-1").unwrap(),
            0
        );
        assert!(
            !repo_root.join(".kanna-worktrees").exists(),
            "route should reject before creating a git worktree"
        );

        let _ = std::fs::remove_dir_all(&daemon_dir);
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[tokio::test]
    async fn create_task_route_persists_blocker_before_daemon_spawn() {
        use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixListener;

        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let repo_root = std::env::temp_dir().join(format!("kanna-http-create-blocker-{unique}"));
        init_test_git_repo(&repo_root);

        let daemon_dir =
            std::env::temp_dir().join(format!("kanna-http-create-blocker-daemon-{unique}"));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);

        let db_path = Db::test_db_path(&format!("http-api-create-blocker-{unique}"));
        let db_path_for_daemon = db_path.clone();
        let daemon_listener = UnixListener::bind(&socket_path).unwrap();
        let daemon_server = tokio::spawn(async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            let session_id = match command {
                DaemonCommand::Spawn {
                    session_id, cwd, ..
                } => {
                    assert!(cwd.contains(".kanna-worktrees/task-"));
                    let db = Db::open(&db_path_for_daemon).unwrap();
                    assert_eq!(
                        db.count_test_task_blockers(&session_id, "blocker-1")
                            .unwrap(),
                        1,
                        "blocker row must exist before daemon spawn is issued"
                    );
                    session_id
                }
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert!(params.cwd.contains(".kanna-worktrees/task-"));
                    let db = Db::open(&db_path_for_daemon).unwrap();
                    assert_eq!(
                        db.count_test_task_blockers(&session_id, "blocker-1")
                            .unwrap(),
                        1,
                        "blocker row must exist before daemon spawn is issued"
                    );
                    session_id
                }
                other => panic!("expected spawn command, got {:?}", other),
            };
            write_half
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&DaemonEvent::SessionCreated { session_id }).unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: db_path.clone(),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-create-blocker-{unique}.json"),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "blocker-1",
            "repo-1",
            "blocker prompt",
            Some("Blocker Task"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        drop(db);

        let app = super::router(Arc::new(super::AppState::new(config.clone())));
        let response = app
            .oneshot(
                Request::post("/v1/tasks")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "repoId": "repo-1",
                            "prompt": "Create after blocker validation",
                            "blockerTaskIds": ["blocker-1"]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: CreateTaskResponse = from_slice(&body).unwrap();
        assert_eq!(created.repo_id, "repo-1");
        assert_eq!(created.stage, "in progress");

        daemon_server.await.unwrap();
        let db = Db::open(&config.db_path).unwrap();
        assert_eq!(
            db.count_test_task_blockers(&created.task_id, "blocker-1")
                .unwrap(),
            1
        );
        assert_eq!(
            db.get_test_pipeline_item_tags(&created.task_id).unwrap(),
            "[\"in progress\",\"blocked\"]"
        );

        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[tokio::test]
    async fn run_merge_agent_route_uses_merge_agent_runner() {
        let app = super::test_router_with_merge_agent_runner(
            "desktop-1",
            "Studio Mac",
            Arc::new(|task_id| {
                Ok(TaskActionResponse {
                    task_id: format!("merge-{task_id}"),
                })
            }),
        );

        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-1/actions/run-merge-agent")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: TaskActionResponse = from_slice(&body).unwrap();
        assert_eq!(created.task_id, "merge-task-1");
    }

    #[test]
    fn task_input_message_strips_trailing_terminators() {
        // The Enter is synthesized separately, so the message carries no
        // terminator regardless of what the caller appended.
        assert_eq!(super::task_input_message("continue"), "continue");
        assert_eq!(super::task_input_message("continue\n"), "continue");
        assert_eq!(super::task_input_message("continue\r"), "continue");
        assert_eq!(super::task_input_message("continue\r\n\n"), "continue");
        assert_eq!(super::task_input_message(""), "");
        // Internal newlines are preserved (only trailing ones are stripped).
        assert_eq!(super::task_input_message("a\nb\n"), "a\nb");
    }

    #[tokio::test]
    async fn send_task_input_route_uses_input_sender() {
        let app = super::test_router_with_task_input_sender(
            "desktop-1",
            "Studio Mac",
            Arc::new(|task_id, input| {
                assert_eq!(task_id, "task-1");
                assert_eq!(input, "continue");
                Ok(())
            }),
        );

        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "input": "continue"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn submit_task_input_sends_text_then_enter_as_discrete_inputs() {
        use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixListener;

        let unique = format!(
            "kanna-submit-input-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut inputs = Vec::new();
            for _ in 0..2 {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
                match command {
                    DaemonCommand::Input { session_id, data } => {
                        assert_eq!(session_id, "task-target");
                        inputs.push(data);
                    }
                    other => panic!("expected Input command, got {other:?}"),
                }
                write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            inputs
        });

        let mut daemon = crate::daemon_client::DaemonClient::connect(&daemon_dir.to_string_lossy())
            .await
            .unwrap();
        super::submit_task_input(&mut daemon, "task-target", "hello\n")
            .await
            .unwrap();
        let inputs = server.await.unwrap();

        assert_eq!(inputs, vec![b"hello".to_vec(), vec![b'\r']]);

        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn terminal_state_notification_sends_once_to_notify_target() {
        use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixListener;

        let unique = format!(
            "kanna-notify-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut inputs = Vec::new();
            for _ in 0..2 {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
                match command {
                    DaemonCommand::Input { session_id, data } => {
                        assert_eq!(session_id, "task-parent");
                        inputs.push(data);
                    }
                    other => panic!("expected Input command, got {other:?}"),
                }
                write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            inputs
        });

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
            firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: Db::test_db_path(&unique),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-child",
            "repo-1",
            "Child prompt first line\nsecond line",
            Some("Child Display"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_notify_task("task-child", "task-parent")
            .unwrap();
        drop(db);

        super::handle_task_terminal_state(&config, "task-child", true)
            .await
            .unwrap();
        let inputs = server.await.unwrap();
        assert_eq!(
            inputs,
            vec![
                b"TASK task-child DONE [success]: Child Display".to_vec(),
                vec![b'\r']
            ]
        );

        super::handle_task_terminal_state(&config, "task-child", true)
            .await
            .unwrap();
        let db = Db::open(&config.db_path).unwrap();
        let task = db.get_pipeline_item("task-child").unwrap().unwrap();
        assert_eq!(task.activity.as_deref(), Some("unread"));
        assert!(task.notified_at.is_some());

        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn http_invoke_dispatches_shared_mobile_post_routes_with_json_body() {
        let received = Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
        let received_for_sender = Arc::clone(&received);
        let state = super::test_state_with_task_input_sender(
            "desktop-1",
            "Studio Mac",
            Arc::new(move |task_id, input| {
                received_for_sender.lock().unwrap().push((task_id, input));
                Ok(())
            }),
        );

        let response = super::dispatch_http_invoke(
            state,
            "POST",
            "/v1/tasks/task-1/input",
            serde_json::json!({
                "input": "continue"
            }),
        )
        .await;

        assert_eq!(response.status, 204);
        assert_eq!(response.body, None);
        assert_eq!(response.error, None);
        assert_eq!(
            *received.lock().unwrap(),
            vec![("task-1".to_string(), "continue".to_string())]
        );
    }

    #[tokio::test]
    async fn close_task_route_uses_task_closer() {
        let app = super::test_router_with_task_closer(
            "desktop-1",
            "Studio Mac",
            Arc::new(|task_id| {
                assert_eq!(task_id, "task-1");
                Ok(())
            }),
        );

        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-1/actions/close")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn close_task_route_resolves_branch_style_task_id() {
        use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixListener;

        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("kanna-http-close-daemon-{unique}"));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);
        let daemon_listener = UnixListener::bind(&socket_path).unwrap();
        let daemon_server = tokio::spawn(async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let expected = ["710917fb", "shell-wt-710917fb", "td-710917fb"];

            for expected_session_id in expected {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
                match command {
                    DaemonCommand::Kill { session_id } => {
                        assert_eq!(session_id, expected_session_id)
                    }
                    other => panic!("expected kill command, got {:?}", other),
                }
                write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });

        let db_path = Db::test_db_path(&format!("http-close-branch-{unique}"));
        let db = Db::open_for_tests(&db_path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "710917fb",
            "repo-1",
            "",
            None,
            "in progress",
            "2026-05-11 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "710917fb",
            "task-710917fb",
            "default",
            None,
            "claude",
        )
        .unwrap();
        drop(db);

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: db_path.clone(),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-close-{unique}.json"),
        };
        let app = super::router(Arc::new(super::AppState::new(config)));

        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-710917fb/actions/close")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        daemon_server.await.unwrap();

        let db = Db::open(&db_path).expect("reopen db");
        let item = db.get_pipeline_item("710917fb").unwrap().unwrap();
        assert_eq!(item.stage.as_deref(), Some("done"));

        let _ = std::fs::remove_dir_all(daemon_dir);
        let _ = std::fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn block_task_route_marks_task_blocked_by_requested_tasks() {
        let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "blocked prompt",
                Some("Blocked Task"),
                "in progress",
                "2026-04-17 07:00:00",
            )
            .unwrap();
            db.insert_test_pipeline_item(
                "blocker-1",
                "repo-1",
                "blocker prompt",
                Some("Blocker Task"),
                "in progress",
                "2026-04-17 08:00:00",
            )
            .unwrap();
        });
        let db_path = state.config.db_path.clone();
        let app = super::router(state);

        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-1/actions/block")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "blockerTaskIds": ["blocker-1"]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let db = Db::open(&db_path).unwrap();
        assert_eq!(
            db.count_test_task_blockers("task-1", "blocker-1").unwrap(),
            1
        );
        let item = db.get_pipeline_item("task-1").unwrap().unwrap();
        assert_eq!(item.activity.as_deref(), Some("idle"));
        assert_eq!(
            db.get_test_pipeline_item_tags("task-1").unwrap(),
            "[\"blocked\"]"
        );
    }

    #[tokio::test]
    async fn block_task_route_rejects_circular_dependencies() {
        let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "task prompt",
                Some("Task"),
                "in progress",
                "2026-04-17 07:00:00",
            )
            .unwrap();
            db.insert_test_pipeline_item(
                "blocker-1",
                "repo-1",
                "blocker prompt",
                Some("Blocker"),
                "in progress",
                "2026-04-17 08:00:00",
            )
            .unwrap();
            db.insert_test_task_blocker("blocker-1", "task-1").unwrap();
        });
        let app = super::router(state);

        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-1/actions/block")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "blockerTaskIds": ["blocker-1"]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn unblock_task_route_removes_blockers_and_blocked_tag() {
        let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "blocked prompt",
                Some("Blocked Task"),
                "in progress",
                "2026-04-17 07:00:00",
            )
            .unwrap();
            db.insert_test_pipeline_item(
                "blocker-1",
                "repo-1",
                "blocker prompt",
                Some("Blocker Task"),
                "in progress",
                "2026-04-17 08:00:00",
            )
            .unwrap();
            db.insert_test_task_blocker("task-1", "blocker-1").unwrap();
            db.set_test_pipeline_item_tags("task-1", "[\"blocked\"]")
                .unwrap();
        });
        let db_path = state.config.db_path.clone();
        let app = super::router(state);

        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-1/actions/unblock")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let db = Db::open(&db_path).unwrap();
        assert_eq!(
            db.count_test_task_blockers("task-1", "blocker-1").unwrap(),
            0
        );
        assert_eq!(db.get_test_pipeline_item_tags("task-1").unwrap(), "[]");
    }

    #[tokio::test]
    async fn advance_stage_route_uses_stage_advancer() {
        let app = super::test_router_with_stage_advancer(
            "desktop-1",
            "Studio Mac",
            Arc::new(|task_id| {
                assert_eq!(task_id, "task-1");
                Ok(TaskActionResponse {
                    task_id: "task-2".to_string(),
                })
            }),
        );

        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-1/actions/advance-stage")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: TaskActionResponse = from_slice(&body).unwrap();
        assert_eq!(created.task_id, "task-2");
    }

    #[tokio::test]
    async fn complete_stage_route_uses_stage_completer() {
        let app = super::test_router_with_stage_completer(
            "desktop-1",
            "Studio Mac",
            Arc::new(|task_id, payload| {
                assert_eq!(task_id, "task-1");
                assert_eq!(payload.status, "success");
                assert_eq!(payload.summary, "review passed");
                assert_eq!(
                    payload.metadata,
                    Some(serde_json::json!({ "coverage": "sufficient" }))
                );
                Ok(TaskActionResponse {
                    task_id: "task-2".to_string(),
                })
            }),
        );

        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-1/actions/complete-stage")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "status": "success",
                            "summary": "review passed",
                            "metadata": { "coverage": "sufficient" }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: TaskActionResponse = from_slice(&body).unwrap();
        assert_eq!(created.task_id, "task-2");
    }

    #[tokio::test]
    async fn complete_stage_missing_task_returns_not_found() {
        let app = super::test_router("desktop-1", "Studio Mac");

        let response = app
            .oneshot(
                Request::post("/v1/tasks/missing-task/actions/complete-stage")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "status": "success",
                            "summary": "done"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn complete_stage_for_already_closed_task_is_idempotent() {
        let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
            db.insert_test_repo("repo-1", "Repo One").unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "Implement it",
                Some("Implement it"),
                "in progress",
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
            db.close_pipeline_item("task-1").unwrap();
        });

        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-1/actions/complete-stage")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "status": "success",
                            "summary": "done again"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let completed: TaskActionResponse = from_slice(&body).unwrap();
        assert_eq!(completed.task_id, "task-1");
    }

    #[tokio::test]
    async fn request_revision_route_uses_revision_requester() {
        let app = super::test_router_with_revision_requester(
            "desktop-1",
            "Studio Mac",
            Arc::new(|task_id, payload| {
                assert_eq!(task_id, "review-task");
                assert_eq!(payload.target_stage, "in progress");
                assert_eq!(payload.summary, "missing e2e coverage");
                assert_eq!(payload.prompt, "Add e2e coverage for task creation.");
                Ok(TaskActionResponse {
                    task_id: "revision-task".to_string(),
                })
            }),
        );

        let response = app
            .oneshot(
                Request::post("/v1/tasks/review-task/actions/request-revision")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "targetStage": "in progress",
                            "summary": "missing e2e coverage",
                            "prompt": "Add e2e coverage for task creation."
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: TaskActionResponse = from_slice(&body).unwrap();
        assert_eq!(created.task_id, "revision-task");
    }

    #[tokio::test]
    async fn request_revision_route_resolves_branch_style_task_id() {
        use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
        use std::time::{SystemTime, UNIX_EPOCH};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixListener;

        let unique = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let repo_root = std::env::temp_dir().join(format!("kanna-http-revision-branch-{unique}"));
        init_test_git_repo(&repo_root);
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
        std::fs::write(
            repo_root.join(".kanna/pipelines/qa.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual", "agent": "implement", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "auto" },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
        )
        .unwrap();
        std::fs::write(
            repo_root.join(".kanna/agents/implement/AGENT.md"),
            "---\nagent_provider: claude\n---\nImplement revision:\n$TASK_PROMPT",
        )
        .unwrap();
        assert!(Command::new("git")
            .args(["add", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "add pipeline"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "task-710917fb"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let daemon_dir = std::env::temp_dir().join(format!("kanna-http-revision-daemon-{unique}"));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);
        // Full daemon/agent E2E would require staged sidecars plus a runnable agent CLI.
        // This fake daemon keeps the real HTTP handler, DB lookup, revision preparation,
        // Spawn protocol, stage-result persistence, and source-task close in scope.
        let daemon_listener = UnixListener::bind(&socket_path).unwrap();
        let daemon_server = tokio::spawn(async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            let session_id = match command {
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert!(params.cwd.contains(".kanna-worktrees/task-"));
                    session_id
                }
                other => panic!("expected SpawnAgent command, got {:?}", other),
            };
            write_half
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&DaemonEvent::SessionCreated { session_id }).unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: Db::test_db_path(&format!("http-api-revision-branch-{unique}")),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-revision-branch-{unique}.json"),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "710917fb",
            "repo-1",
            "Review branch",
            Some("Review branch"),
            "review",
            "2026-05-11 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "710917fb",
            "task-710917fb",
            "qa",
            None,
            "claude",
        )
        .unwrap();
        drop(db);

        let app = super::router(Arc::new(super::AppState::new(config.clone())));
        let response = app
            .oneshot(
                Request::post("/v1/tasks/task-710917fb/actions/request-revision")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "targetStage": "in progress",
                            "summary": "missing e2e coverage",
                            "prompt": "Add e2e coverage for task creation."
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        if response.status() != StatusCode::OK {
            daemon_server.abort();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            panic!(
                "expected request revision to resolve branch-style task id, got {status}: {}",
                String::from_utf8_lossy(&body)
            );
        }

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: TaskActionResponse = from_slice(&body).unwrap();
        assert_ne!(created.task_id, "710917fb");

        let db = Db::open(&config.db_path).unwrap();
        let source = db.get_task_stage_source("710917fb").unwrap().unwrap();
        assert_eq!(source.stage.as_deref(), Some("done"));
        assert!(source.closed_at.is_some());
        let stage_result = source.stage_result.as_deref().unwrap();
        assert!(stage_result.contains("\"status\":\"failure\""));
        assert!(stage_result.contains("missing e2e coverage"));

        let revision = db.get_task_stage_source(&created.task_id).unwrap().unwrap();
        assert_eq!(revision.stage.as_deref(), Some("in progress"));
        assert_eq!(revision.base_ref.as_deref(), Some("task-710917fb"));

        daemon_server.await.unwrap();
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[tokio::test]
    async fn request_revision_route_preserves_title_and_sends_revision_prompt() {
        use kanna_daemon::protocol::{
            AgentProvider, Command as DaemonCommand, Event as DaemonEvent,
        };
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixListener;

        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let repo_root = std::env::temp_dir().join(format!("kanna-http-revision-title-{unique}"));
        init_test_git_repo(&repo_root);
        let kanna_dir = repo_root.join(".kanna");
        std::fs::create_dir_all(kanna_dir.join("pipelines")).unwrap();
        std::fs::create_dir_all(kanna_dir.join("agents/revision")).unwrap();
        std::fs::write(
            kanna_dir.join("pipelines/revision.json"),
            serde_json::json!({
                "name": "revision",
                "stages": [
                    {
                        "name": "in progress",
                        "transition": "manual",
                        "agent": "revision"
                    },
                    { "name": "review", "transition": "auto" }
                ]
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            kanna_dir.join("agents/revision/AGENT.md"),
            [
                "---",
                "name: Revision",
                "agent_provider: codex",
                "---",
                "Implement revision:",
                "$TASK_PROMPT",
                "",
            ]
            .join("\n"),
        )
        .unwrap();
        assert!(Command::new("git")
            .args(["add", ".kanna"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "add revision pipeline"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["branch", "task-reviewed"])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());

        let daemon_dir = std::env::temp_dir().join(format!("kanna-http-revision-daemon-{unique}"));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);
        let daemon_listener = UnixListener::bind(&socket_path).unwrap();
        let daemon_server = tokio::spawn(async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            let session_id = match command {
                DaemonCommand::SpawnAgent { session_id, params } => {
                    assert_eq!(params.agent_provider, AgentProvider::Codex);
                    assert!(params.cwd.contains(".kanna-worktrees/task-"));
                    assert!(params.prompt.contains("Implement revision:"));
                    assert!(params
                        .prompt
                        .contains("Add E2E coverage for title preservation."));
                    assert!(!params
                        .prompt
                        .contains("Review prompt that should stay hidden."));
                    session_id
                }
                other => panic!("expected SpawnAgent command, got {:?}", other),
            };
            write_half
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&DaemonEvent::SessionCreated { session_id }).unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: Db::test_db_path(&format!("http-api-revision-title-{unique}")),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-revision-title-{unique}.json"),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "review-task",
            "repo-1",
            "Review prompt that should stay hidden.",
            Some("Preserved review title"),
            "review",
            "2026-05-12 07:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "review-task",
            "task-reviewed",
            "revision",
            Some("{\"status\":\"success\",\"summary\":\"ready for review\"}"),
            "codex",
        )
        .unwrap();
        drop(db);

        let app = super::router(Arc::new(super::AppState::new(config.clone())));
        let response = app
            .oneshot(
                Request::post("/v1/tasks/review-task/actions/request-revision")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "targetStage": "in progress",
                            "summary": "missing title coverage",
                            "prompt": "Add E2E coverage for title preservation."
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: TaskActionResponse = from_slice(&body).unwrap();
        assert_ne!(created.task_id, "review-task");

        let db = Db::open(&config.db_path).unwrap();
        let reviewed = db.get_task_stage_source("review-task").unwrap().unwrap();
        let revision = db.get_task_stage_source(&created.task_id).unwrap().unwrap();
        assert_eq!(reviewed.stage.as_deref(), Some("done"));
        assert!(reviewed.closed_at.is_some());
        assert_eq!(revision.stage.as_deref(), Some("in progress"));
        assert_eq!(
            revision.display_name.as_deref(),
            Some("Preserved review title")
        );
        assert_eq!(
            revision.prompt.as_deref(),
            Some("Implement revision:\nAdd E2E coverage for title preservation.")
        );

        daemon_server.await.unwrap();
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[tokio::test]
    async fn task_terminal_route_streams_output_events() {
        use futures_util::StreamExt;
        use serde_json::Value;
        use tokio::net::TcpListener;
        use tokio_tungstenite::connect_async;
        use tokio_tungstenite::tungstenite::Message;

        let app = super::test_router_with_terminal_streamer(
            "desktop-1",
            "Studio Mac",
            Arc::new(|task_id| {
                Ok(vec![
                    super::TaskTerminalStreamEvent::Ready {
                        task_id: task_id.clone(),
                    },
                    super::TaskTerminalStreamEvent::Output {
                        task_id: task_id.clone(),
                        text: "hello from daemon".to_string(),
                    },
                    super::TaskTerminalStreamEvent::Exit { task_id, code: 0 },
                ])
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });

        let (mut socket, _) = connect_async(format!("ws://{addr}/v1/tasks/task-1/terminal"))
            .await
            .unwrap();

        let ready = socket.next().await.unwrap().unwrap();
        let output = socket.next().await.unwrap().unwrap();
        let exit = socket.next().await.unwrap().unwrap();

        server.abort();

        let parse = |message: Message| -> Value {
            match message {
                Message::Text(text) => serde_json::from_str(&text).unwrap(),
                other => panic!("expected text websocket frame, got {:?}", other),
            }
        };

        assert_eq!(parse(ready)["type"], "ready");
        assert_eq!(parse(output)["text"], "hello from daemon");
        assert_eq!(parse(exit)["type"], "exit");
    }

    #[tokio::test]
    async fn task_terminal_route_replays_snapshot_when_output_arrives_before_snapshot_response() {
        use futures_util::StreamExt;
        use kanna_daemon::protocol::{
            Command as DaemonCommand, Event as DaemonEvent, TerminalSnapshot,
        };
        use serde_json::Value;
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::{TcpListener, UnixListener};
        use tokio_tungstenite::connect_async;
        use tokio_tungstenite::tungstenite::Message;

        static NEXT_TEST_DB_ID: AtomicUsize = AtomicUsize::new(31_000);

        fn test_socket_path_for_dir(daemon_dir: &str) -> PathBuf {
            let dir = PathBuf::from(daemon_dir);
            let mut hasher = DefaultHasher::new();
            dir.hash(&mut hasher);
            let hash = hasher.finish() as u32;
            PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
        }

        let test_id = NEXT_TEST_DB_ID.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "kanna-http-api-daemon-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = test_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);
        let daemon_listener = UnixListener::bind(&socket_path).unwrap();
        let daemon_server = tokio::spawn(async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);

            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let observe: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            match observe {
                DaemonCommand::Observe { session_id } => assert_eq!(session_id, "daemon-task-1"),
                other => panic!("expected observe command, got {:?}", other),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();

            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let snapshot: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            match snapshot {
                DaemonCommand::Snapshot { session_id } => assert_eq!(session_id, "daemon-task-1"),
                other => panic!("expected snapshot command, got {:?}", other),
            }

            let out_of_order_output = DaemonEvent::Output {
                session_id: "daemon-task-1".to_string(),
                data: b"ignored live delta".to_vec(),
            };
            let snapshot_response = DaemonEvent::Snapshot {
                session_id: "daemon-task-1".to_string(),
                snapshot: TerminalSnapshot {
                    version: 1,
                    rows: 24,
                    cols: 80,
                    cursor_row: 1,
                    cursor_col: 0,
                    cursor_visible: true,
                    saved_at: 0,
                    sequence: 0,
                    vt: "hello from snapshot".to_string(),
                },
            };
            let exit = DaemonEvent::Exit {
                session_id: "daemon-task-1".to_string(),
                code: 0,
                resume_session_id: None,
            };

            for event in [out_of_order_output, snapshot_response, exit] {
                write_half
                    .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
                    .await
                    .unwrap();
            }
        });

        let config = crate::config::Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: crate::db::Db::test_db_path(&format!("http-api-snapshot-race-{test_id}")),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-snapshot-race-{test_id}.json"),
        };
        let db = crate::db::Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Review branch",
            Some("Review branch"),
            "review",
            "2026-05-11 10:00:00",
        )
        .unwrap();
        db.insert_test_terminal_session("terminal-1", "repo-1", "task-1", "agent", "daemon-task-1")
            .unwrap();
        let app = super::router(Arc::new(super::AppState::new(config)));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });

        let (mut socket, _) = connect_async(format!("ws://{addr}/v1/tasks/task-1/terminal"))
            .await
            .unwrap();

        let ready = socket.next().await.unwrap().unwrap();
        let output = socket.next().await.unwrap().unwrap();

        server.abort();
        daemon_server.abort();
        let _ = std::fs::remove_file(&socket_path);

        let parse = |message: Message| -> Value {
            match message {
                Message::Text(text) => serde_json::from_str(&text).unwrap(),
                other => panic!("expected text websocket frame, got {:?}", other),
            }
        };

        let ready = parse(ready);
        let output = parse(output);

        assert_eq!(ready["type"], "ready");
        assert_eq!(output["type"], "output");
        assert_eq!(output["task_id"], "task-1");
        assert_eq!(output["text"], "hello from snapshot");
    }

    #[test]
    fn snapshot_output_event_uses_snapshot_text_for_mobile_terminal() {
        let snapshot = kanna_daemon::protocol::TerminalSnapshot {
            version: 1,
            rows: 24,
            cols: 80,
            cursor_row: 1,
            cursor_col: 0,
            cursor_visible: true,
            saved_at: 0,
            sequence: 0,
            vt: "hello from snapshot".to_string(),
        };

        let event = super::snapshot_output_event("task-1", snapshot)
            .expect("expected snapshot to produce an output event");

        match event {
            super::TaskTerminalStreamEvent::Output { task_id, text } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(text, "hello from snapshot");
            }
            other => panic!("expected output event, got {:?}", other),
        }
    }

    #[test]
    fn snapshot_output_event_preserves_terminal_control_sequences_for_xterm() {
        let snapshot = kanna_daemon::protocol::TerminalSnapshot {
            version: 1,
            rows: 24,
            cols: 80,
            cursor_row: 1,
            cursor_col: 0,
            cursor_visible: true,
            saved_at: 0,
            sequence: 0,
            vt: "\u{1b}[2KThinking\u{1b}[1Bstill same terminal frame".to_string(),
        };

        let event = super::snapshot_output_event("task-1", snapshot)
            .expect("expected snapshot to produce an output event");

        match event {
            super::TaskTerminalStreamEvent::Output { text, .. } => {
                assert_eq!(text, "\u{1b}[2KThinking\u{1b}[1Bstill same terminal frame");
            }
            other => panic!("expected output event, got {:?}", other),
        }
    }

    #[test]
    fn live_terminal_output_preserves_terminal_control_sequences_for_xterm() {
        let event = super::daemon_event_to_task_terminal_event(
            "task-1",
            kanna_daemon::protocol::Event::Output {
                session_id: "task-1".to_string(),
                data: b"\x1b[2KThinking\x1b[1Bstill same terminal frame".to_vec(),
            },
        )
        .expect("expected output event");

        match event {
            super::TaskTerminalStreamEvent::Output { text, .. } => {
                assert_eq!(text, "\u{1b}[2KThinking\u{1b}[1Bstill same terminal frame");
            }
            other => panic!("expected output event, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn status_route_reflects_pairing_session() {
        let app = super::test_router("desktop-1", "Studio Mac");
        let pairing_response = app
            .clone()
            .oneshot(
                Request::post("/v1/pairing/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(pairing_response.status(), StatusCode::OK);

        let status_response = app
            .oneshot(Request::get("/v1/status").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(status_response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(status_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let status: MobileServerStatus = from_slice(&body).unwrap();

        assert_eq!(status.desktop_name, "Studio Mac");
        assert_eq!(status.state, "running");
        assert!(status.pairing_code.is_some());
    }
}
