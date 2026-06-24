use clap::{Parser, Subcommand};
use kanna_tool_catalog::{
    load_catalog, resolve_request, Catalog, Method as CatalogMethod, ResolvedRequest, ResponseKind,
    WaitUntil as CatalogWaitUntil,
};
use rusqlite::Connection;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::process;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

const DEFAULT_SERVER_BASE_URL: &str = "http://127.0.0.1:48120";

#[derive(Parser)]
#[command(name = "kanna-cli")]
#[command(about = "Kanna CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Print the generated Kanna task manual for the current spawned task
    Guide {
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Signal that a pipeline stage is complete
    StageComplete {
        /// The task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Completion status: "success" or "failure"
        #[arg(long)]
        status: String,

        /// Human-readable summary of what happened
        #[arg(long)]
        summary: String,

        /// Optional JSON string with extra metadata
        #[arg(long)]
        metadata: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// List repos from the desktop-backed local API
    Repo {
        #[command(subcommand)]
        command: RepoCommands,
    },
    /// Create and inspect tasks through the desktop-backed local API
    Task {
        #[command(subcommand)]
        command: TaskCommands,
    },
    /// List and call catalog-backed Kanna tools through the desktop local API
    Tool {
        #[command(subcommand)]
        command: ToolCommands,
    },
}

#[derive(Subcommand)]
enum RepoCommands {
    /// List repos known to the running desktop server
    List {
        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Register an existing local git repository with the running desktop server
    Add {
        /// Existing local git repository path
        #[arg(long)]
        path: String,

        /// Optional display name
        #[arg(long)]
        name: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
}

#[derive(Subcommand)]
enum TaskCommands {
    /// List recent tasks from the running desktop server
    List {
        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Show one recent task by exact ID
    Status {
        /// The task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Fetch one task by exact ID
    Get {
        /// The task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Wait for a task to finish or close
    Wait {
        /// The task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Maximum seconds to wait
        #[arg(long, default_value_t = 600)]
        timeout_secs: u64,

        /// Poll interval in seconds
        #[arg(long, default_value_t = 3)]
        poll_secs: u64,

        /// Condition to wait for: finished or closed
        #[arg(long, default_value = "finished")]
        until: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Print recent task logs
    Logs {
        /// The task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Number of recent relevant log events
        #[arg(long)]
        tail: Option<usize>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Create a task in a repo known to the running desktop server
    Create {
        /// The target repo ID
        #[arg(long)]
        repo_id: String,

        /// The task prompt
        #[arg(long)]
        prompt: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,

        /// Optional pipeline name override
        #[arg(long)]
        pipeline_name: Option<String>,

        /// Optional base ref override
        #[arg(long)]
        base_ref: Option<String>,

        /// Optional stage override
        #[arg(long)]
        stage: Option<String>,

        /// Optional agent provider override
        #[arg(long)]
        agent_provider: Option<String>,

        /// Task session type: "agent" for themed headless sessions or "pty" for raw terminal
        #[arg(long)]
        agent_type: Option<String>,

        /// Optional model override
        #[arg(long)]
        model: Option<String>,

        /// Optional permission mode override
        #[arg(long)]
        permission_mode: Option<String>,

        /// Allowed tool override. Repeat to pass multiple values.
        #[arg(long)]
        allowed_tool: Vec<String>,

        /// Task that blocks this task. Repeat to pass multiple blockers.
        #[arg(long)]
        blocker_task_id: Vec<String>,

        /// Task to notify when this task reaches a terminal state
        #[arg(long)]
        notify_task: Option<String>,
    },
    /// Request a new revision task from an existing task branch
    RequestRevision {
        /// The source task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Stage to create the revision task in
        #[arg(long, default_value = "in progress")]
        target_stage: String,

        /// Human-readable summary of why revision is needed
        #[arg(long)]
        summary: String,

        /// Prompt for the revision task
        #[arg(long)]
        prompt: String,

        /// Optional JSON string with extra metadata
        #[arg(long)]
        metadata: Option<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Send feedback or instructions to a running agent task
    SendInput {
        /// The target task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Message to send to the running agent session
        #[arg(long)]
        message: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Advance an accepted task to the next pipeline stage
    AdvanceStage {
        /// The accepted task/pipeline_item ID
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Mark a task as blocked by one or more tasks
    Block {
        /// The task/pipeline_item ID to block
        #[arg(long)]
        task_id: String,

        /// Task that blocks this task. Repeat to pass multiple blockers.
        #[arg(long)]
        blocker_task_id: Vec<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Remove all blockers from a task
    Unblock {
        /// The task/pipeline_item ID to unblock
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
    /// Close a task (kills its sessions and hides it from the sidebar)
    Close {
        /// The task/pipeline_item ID to close
        #[arg(long)]
        task_id: String,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
}

#[derive(Subcommand)]
enum ToolCommands {
    /// Print the active catalog tools as MCP tools/list JSON
    List,
    /// Call any catalog-backed Kanna tool
    Call {
        /// Catalog tool name
        name: String,

        /// Tool arguments as a JSON object
        #[arg(long)]
        json: Option<String>,

        /// Tool argument as key=value. Repeat to pass multiple values.
        #[arg(long)]
        arg: Vec<String>,

        /// Override the local Kanna server base URL
        #[arg(long)]
        server_url: Option<String>,
    },
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
struct RepoSummary {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RepoDetail {
    id: String,
    path: String,
    name: String,
    default_branch: Option<String>,
    hidden: Option<i64>,
    sort_order: Option<i64>,
    created_at: Option<String>,
    last_opened_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AddRepoRequest {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskSummary {
    id: String,
    repo_id: String,
    title: String,
    stage: Option<String>,
    activity: Option<String>,
    snippet: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskDetail {
    id: String,
    repo_id: String,
    title: String,
    stage: Option<String>,
    pipeline_name: Option<String>,
    stage_transition: Option<String>,
    activity: Option<String>,
    snippet: Option<String>,
    agent_type: Option<String>,
    agent_provider: Option<String>,
    branch: Option<String>,
    pr_url: Option<String>,
    closed_at: Option<String>,
    worktree_path: Option<String>,
    commits_ahead: i64,
    commits_behind: i64,
    dirty: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskStatusRow {
    id: String,
    repo_id: String,
    stage: String,
    activity: String,
    title: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CreateTaskRequest {
    repo_id: String,
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pipeline_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocker_task_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notify_task_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CreateTaskResponse {
    task_id: String,
    repo_id: String,
    title: String,
    stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktree_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CompleteStageRequest {
    status: String,
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RequestRevisionRequest {
    target_stage: String,
    summary: String,
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskInputRequest {
    input: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BlockTaskRequest {
    blocker_task_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskInputResponse {
    ok: bool,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskActionResponse {
    task_id: String,
}

struct TaskCreateOptions {
    repo_id: String,
    prompt: String,
    pipeline_name: Option<String>,
    base_ref: Option<String>,
    stage: Option<String>,
    agent_provider: Option<String>,
    agent_type: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tool: Vec<String>,
    blocker_task_id: Vec<String>,
    notify_task: Option<String>,
}

fn write_stage_result_to_db(
    db_path: &str,
    task_id: &str,
    stage_result: &str,
) -> Result<(), String> {
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open database: {e}"))?;

    let rows_updated = conn
        .execute(
            "UPDATE pipeline_item SET stage_result = ? WHERE id = ?",
            rusqlite::params![stage_result, task_id],
        )
        .map_err(|e| format!("Failed to update pipeline_item: {e}"))?;

    if rows_updated == 0 {
        return Err(format!("No pipeline_item found with id '{task_id}'"));
    }

    Ok(())
}

async fn notify_socket(socket_path: &str, task_id: &str) -> Result<(), String> {
    let mut stream = UnixStream::connect(socket_path)
        .await
        .map_err(|e| format!("Failed to connect to socket: {e}"))?;

    let message = serde_json::json!({
        "type": "stage_complete",
        "task_id": task_id,
    });

    let mut payload =
        serde_json::to_string(&message).map_err(|e| format!("Failed to serialize message: {e}"))?;
    payload.push('\n');

    stream
        .write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to socket: {e}"))?;

    stream
        .shutdown()
        .await
        .map_err(|e| format!("Failed to shutdown socket: {e}"))?;

    Ok(())
}

fn env_var_from_pairs(env_pairs: &[(&str, &str)], key: &str) -> Option<String> {
    env_pairs
        .iter()
        .find_map(|(candidate, value)| (*candidate == key).then(|| (*value).to_string()))
}

fn resolve_stage_db_path(env_pairs: &[(&str, &str)]) -> Result<String, String> {
    if let Some(db_path) = env_var_from_pairs(env_pairs, "KANNA_CLI_DB_PATH") {
        return Ok(db_path);
    }

    Err("KANNA_CLI_DB_PATH environment variable is not set".to_string())
}

fn resolve_stage_db_path_from_env() -> Result<String, String> {
    let env_pairs = env::vars().collect::<Vec<_>>();
    let borrowed_pairs = env_pairs
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    resolve_stage_db_path(&borrowed_pairs)
}

fn resolve_server_base_url(
    env_pairs: &[(&str, &str)],
    explicit_server_url: Option<&str>,
) -> String {
    explicit_server_url
        .map(str::to_string)
        .or_else(|| env_var_from_pairs(env_pairs, "KANNA_SERVER_BASE_URL"))
        .unwrap_or_else(|| DEFAULT_SERVER_BASE_URL.to_string())
}

fn resolve_optional_server_base_url(
    env_pairs: &[(&str, &str)],
    explicit_server_url: Option<&str>,
) -> Option<String> {
    explicit_server_url
        .map(str::to_string)
        .or_else(|| env_var_from_pairs(env_pairs, "KANNA_SERVER_BASE_URL"))
}

fn resolve_server_base_url_from_env(explicit_server_url: Option<&str>) -> String {
    let env_pairs = env::vars().collect::<Vec<_>>();
    let borrowed_pairs = env_pairs
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    resolve_server_base_url(&borrowed_pairs, explicit_server_url)
}

fn resolve_guide_task_id(env_pairs: &[(&str, &str)]) -> Option<String> {
    env_var_from_pairs(env_pairs, "KANNA_TASK_ID")
}

fn build_create_task_request(options: TaskCreateOptions) -> CreateTaskRequest {
    CreateTaskRequest {
        repo_id: options.repo_id,
        prompt: options.prompt,
        pipeline_name: options.pipeline_name,
        base_ref: options.base_ref,
        stage: options.stage,
        agent_provider: options.agent_provider,
        agent_type: options.agent_type,
        model: options.model,
        permission_mode: options.permission_mode,
        allowed_tools: (!options.allowed_tool.is_empty()).then_some(options.allowed_tool),
        blocker_task_ids: (!options.blocker_task_id.is_empty()).then_some(options.blocker_task_id),
        notify_task_id: options.notify_task,
    }
}

fn build_complete_stage_request(
    status: String,
    summary: String,
    metadata: Option<Value>,
) -> CompleteStageRequest {
    CompleteStageRequest {
        status,
        summary,
        metadata,
    }
}

fn build_request_revision_request(
    target_stage: String,
    summary: String,
    prompt: String,
    metadata: Option<Value>,
) -> RequestRevisionRequest {
    RequestRevisionRequest {
        target_stage,
        summary,
        prompt,
        metadata,
    }
}

fn build_send_task_input_request(message: String) -> TaskInputRequest {
    // Send the message text as-is. Submitting it to the agent terminal (typing
    // the text, then a discrete Enter keystroke) is the desktop server's job at
    // /v1/tasks/{id}/input — keeping that policy server-side means kanna-cli,
    // kanna-mcp, and the mobile app all submit consistently.
    TaskInputRequest { input: message }
}

fn build_block_task_request(blocker_task_ids: Vec<String>) -> BlockTaskRequest {
    BlockTaskRequest { blocker_task_ids }
}

fn build_add_repo_request(path: String, name: Option<String>) -> AddRepoRequest {
    AddRepoRequest { path, name }
}

fn parse_metadata_json(metadata: &Option<String>) -> Result<Option<Value>, String> {
    match metadata {
        Some(json_str) => serde_json::from_str(json_str)
            .map(Some)
            .map_err(|e| format!("--metadata is not valid JSON: {e}")),
        None => Ok(None),
    }
}

fn load_tool_catalog_from_current_dir() -> Result<Catalog, String> {
    let cwd = env::current_dir().map_err(|e| format!("failed to read current directory: {e}"))?;
    let loaded = load_catalog(&cwd);
    if let Some(warning) = loaded.warning {
        eprintln!("Warning: {warning}");
    }
    Ok(loaded.catalog)
}

fn build_tool_call_args(
    json_arg: &Option<String>,
    repeated_args: &[String],
) -> Result<Value, String> {
    let mut args = match json_arg {
        Some(raw) => serde_json::from_str::<Value>(raw)
            .map_err(|e| format!("--json is not valid JSON: {e}"))?,
        None => serde_json::json!({}),
    };

    let Some(args_object) = args.as_object_mut() else {
        return Err("--json must be a JSON object".to_string());
    };

    for raw_arg in repeated_args {
        let Some((key, raw_value)) = raw_arg.split_once('=') else {
            return Err(format!("--arg must be key=value, got {raw_arg}"));
        };
        let value = serde_json::from_str::<Value>(raw_value)
            .unwrap_or_else(|_| Value::String(raw_value.to_string()));
        args_object.insert(key.to_string(), value);
    }

    Ok(args)
}

#[cfg(test)]
fn task_create_flag_names() -> Vec<String> {
    vec![
        "repo_id",
        "prompt",
        "pipeline_name",
        "base_ref",
        "stage",
        "agent_provider",
        "model",
        "permission_mode",
        "allowed_tools",
        "blocker_task_ids",
        "notify_task_id",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

#[cfg(test)]
fn catalog_create_task_param_names() -> Vec<String> {
    kanna_tool_catalog::bundled_catalog()
        .tools
        .into_iter()
        .find(|tool| tool.name == "kanna_create_task")
        .map(|tool| tool.params.into_iter().map(|param| param.name).collect())
        .unwrap_or_default()
}

fn join_server_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

fn encode_path_segment(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn task_list_path() -> &'static str {
    "/v1/tasks/recent"
}

fn task_get_path(task_id: &str) -> String {
    format!("/v1/tasks/{}", encode_path_segment(task_id))
}

fn task_logs_path(task_id: &str, tail: Option<usize>) -> String {
    let task_id = encode_path_segment(task_id);
    match tail {
        Some(tail) => format!("/v1/tasks/{task_id}/logs?tail={tail}"),
        None => format!("/v1/tasks/{task_id}/logs"),
    }
}

async fn get_json<T: DeserializeOwned>(base_url: &str, path: &str) -> Result<T, String> {
    let response = reqwest::Client::new()
        .get(join_server_url(base_url, path))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let response = response
        .error_for_status()
        .map_err(|e| format!("request failed: {e}"))?;
    response
        .json::<T>()
        .await
        .map_err(|e| format!("failed to decode response: {e}"))
}

async fn get_text(base_url: &str, path: &str) -> Result<String, String> {
    let response = reqwest::Client::new()
        .get(join_server_url(base_url, path))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|e| format!("failed to read error body: {e}"));
        return Err(format!("request failed with status {status}: {body}"));
    }
    response
        .text()
        .await
        .map_err(|e| format!("failed to decode response: {e}"))
}

async fn post_json<B: Serialize, T: DeserializeOwned>(
    base_url: &str,
    path: &str,
    body: &B,
) -> Result<T, String> {
    let response = reqwest::Client::new()
        .post(join_server_url(base_url, path))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let response = response
        .error_for_status()
        .map_err(|e| format!("request failed: {e}"))?;
    response
        .json::<T>()
        .await
        .map_err(|e| format!("failed to decode response: {e}"))
}

async fn post_no_content_json<B: Serialize>(
    base_url: &str,
    path: &str,
    body: &B,
) -> Result<(), String> {
    let response = reqwest::Client::new()
        .post(join_server_url(base_url, path))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|e| format!("failed to read error body: {e}"));
        return Err(format!("request failed with status {status}: {body}"));
    }

    Ok(())
}

async fn post_catalog_json(base_url: &str, path: &str, body: &Value) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(join_server_url(base_url, path))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(serde_json::json!({ "ok": true }));
    }
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|e| format!("failed to read error body: {e}"));
        return Err(format!("request failed with status {status}: {body}"));
    }
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("failed to decode response: {e}"))
}

async fn list_repos_via_api(base_url: &str) -> Result<Vec<RepoSummary>, String> {
    get_json(base_url, "/v1/repos").await
}

async fn add_repo_via_api(base_url: &str, request: &AddRepoRequest) -> Result<RepoDetail, String> {
    post_json(base_url, "/v1/repos", request).await
}

async fn list_tasks_via_api(base_url: &str) -> Result<Vec<TaskSummary>, String> {
    get_json(base_url, task_list_path()).await
}

async fn get_task_via_api(base_url: &str, task_id: &str) -> Result<TaskDetail, String> {
    get_json(base_url, &task_get_path(task_id)).await
}

#[derive(Debug, Clone)]
struct GuideContext {
    task_id: String,
    task: Option<TaskDetail>,
    live_state_error: Option<String>,
    catalog: Catalog,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GuideTool<'a> {
    name: &'a str,
    description: &'a str,
}

fn guide_tools(catalog: &Catalog) -> Vec<GuideTool<'_>> {
    catalog
        .tools
        .iter()
        .map(|tool| GuideTool {
            name: &tool.name,
            description: &tool.description,
        })
        .collect()
}

fn render_guide_markdown(context: &GuideContext) -> String {
    let task = context.task.as_ref();
    let stage = task
        .and_then(|task| task.stage.as_deref())
        .unwrap_or("unknown");
    let pipeline = task
        .and_then(|task| task.pipeline_name.as_deref())
        .unwrap_or("unknown");
    let transition = task
        .and_then(|task| task.stage_transition.as_deref())
        .unwrap_or("manual");
    let branch = task
        .and_then(|task| task.branch.as_deref())
        .unwrap_or("unknown");

    let mut lines = vec![
        "# Kanna Task Guide".to_string(),
        String::new(),
        format!(
            "You are task `{}`, stage `{}` of pipeline `{}` (`{}`). Branch: `{}`.",
            context.task_id, stage, pipeline, transition, branch
        ),
        format!(
            "Done here means this stage has achieved its goal; then run `kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status success --summary \"...\"`."
        ),
    ];

    if let Some(error) = context.live_state_error.as_deref() {
        lines.push(String::new());
        lines.push(format!(
            "Live task state was unavailable: {error}. The catalog and workflow manual below are still generated from the bundled Kanna tool catalog."
        ));
    }

    lines.extend([
        String::new(),
        "## Workflow Semantics".to_string(),
        String::new(),
        "- Prefer `kanna-mcp` tools when your agent client exposes them; fall back to `kanna-cli` from the shell.".to_string(),
        "- `kanna_complete_stage` / `kanna-cli stage-complete` records the stage result. `success` can trigger an auto-transition when the current stage is configured for auto; `failure` records the failure and stops advancement.".to_string(),
        "- Manual transitions wait for a user or agent to request advancement.".to_string(),
        "- Advancing closes the current task and spawns a new task in a new worktree.".to_string(),
        "- Use create/spawn-subtask tools for follow-up work, `kanna_send_input` for feedback to a running task, `kanna_request_revision` for a new revision task from an existing branch, and blocker tools when this task depends on another task.".to_string(),
        String::new(),
        "## Catalog Tools".to_string(),
        String::new(),
    ]);

    for tool in &context.catalog.tools {
        lines.push(format!("- `{}`: {}", tool.name, tool.description));
    }

    lines.join("\n")
}

fn render_guide_json(context: &GuideContext) -> Result<Value, String> {
    serde_json::to_value(serde_json::json!({
        "taskId": context.task_id,
        "liveStateError": context.live_state_error,
        "task": context.task,
        "workflow": {
            "completeStage": "success can trigger auto-advance; failure records failure and stops advancement",
            "manualTransition": "manual stages wait for explicit advancement",
            "advanceStage": "advancing closes the current task and spawns a new task in a new worktree",
            "operations": [
                "prefer kanna-mcp tools",
                "fall back to kanna-cli",
                "send input to running tasks",
                "request revisions from existing task branches",
                "block and unblock tasks"
            ]
        },
        "tools": guide_tools(&context.catalog),
    }))
    .map_err(|e| format!("failed to render guide json: {e}"))
}

async fn build_guide_context(
    env_pairs: &[(&str, &str)],
    explicit_server_url: Option<&str>,
) -> GuideContext {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let task_id = resolve_guide_task_id(env_pairs).unwrap_or_else(|| "unknown".to_string());
    if task_id == "unknown" {
        return GuideContext {
            task_id,
            task: None,
            live_state_error: Some("KANNA_TASK_ID is not set".to_string()),
            catalog,
        };
    }

    let base_url = resolve_server_base_url(env_pairs, explicit_server_url);
    match get_task_via_api(&base_url, &task_id).await {
        Ok(task) => GuideContext {
            task_id,
            task: Some(task),
            live_state_error: None,
            catalog,
        },
        Err(error) => GuideContext {
            task_id,
            task: None,
            live_state_error: Some(error),
            catalog,
        },
    }
}

async fn task_logs_via_api(
    base_url: &str,
    task_id: &str,
    tail: Option<usize>,
) -> Result<String, String> {
    get_text(base_url, &task_logs_path(task_id, tail)).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WaitUntil {
    Finished,
    Closed,
}

fn parse_wait_until(value: &str) -> Result<WaitUntil, String> {
    match value {
        "finished" => Ok(WaitUntil::Finished),
        "closed" => Ok(WaitUntil::Closed),
        other => Err(format!("--until must be finished or closed, got {other}")),
    }
}

fn task_matches_wait_until(task: &TaskDetail, until: WaitUntil) -> bool {
    match until {
        WaitUntil::Finished => {
            task.closed_at.is_some() || task.activity.as_deref() == Some("unread")
        }
        WaitUntil::Closed => task.closed_at.is_some(),
    }
}

async fn wait_task_via_api(
    base_url: &str,
    task_id: &str,
    timeout_secs: u64,
    poll_secs: u64,
    until: WaitUntil,
) -> Result<TaskDetail, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let poll_interval = std::time::Duration::from_secs(poll_secs.max(1));
    loop {
        let task = get_task_via_api(base_url, task_id).await?;
        if task_matches_wait_until(&task, until) {
            return Ok(task);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!("timed out waiting for task {task_id}"));
        }
        tokio::time::sleep(poll_interval).await;
    }
}

fn catalog_task_matches_wait_until(task: &Value, until: CatalogWaitUntil) -> bool {
    let closed = task.get("closedAt").is_some_and(|value| !value.is_null());
    match until {
        CatalogWaitUntil::Finished => {
            closed || task.get("activity").and_then(Value::as_str) == Some("unread")
        }
        CatalogWaitUntil::Closed => closed,
    }
}

async fn wait_catalog_task_via_api(
    base_url: &str,
    task_id: &str,
    timeout_secs: u64,
    poll_secs: u64,
    until: CatalogWaitUntil,
) -> Result<Value, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let poll_interval = std::time::Duration::from_secs(poll_secs.max(1));
    let path = task_get_path(task_id);
    loop {
        let task: Value = get_json(base_url, &path).await?;
        if catalog_task_matches_wait_until(&task, until) {
            return Ok(task);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!("timed out waiting for task {task_id}"));
        }
        tokio::time::sleep(poll_interval).await;
    }
}

async fn execute_catalog_request(
    base_url: &str,
    request: ResolvedRequest,
) -> Result<Value, String> {
    match (request.method, request.kind) {
        (CatalogMethod::Get, ResponseKind::Json) => get_json(base_url, &request.path).await,
        (CatalogMethod::Get, ResponseKind::Text) => {
            get_text(base_url, &request.path).await.map(Value::String)
        }
        (CatalogMethod::Post, ResponseKind::Json) => {
            post_catalog_json(base_url, &request.path, &request.body).await
        }
        (_, ResponseKind::Wait) => {
            let wait = request
                .wait
                .ok_or_else(|| "wait request missing wait spec".to_string())?;
            wait_catalog_task_via_api(
                base_url,
                &wait.task_id,
                wait.timeout_secs,
                wait.poll_secs,
                wait.until,
            )
            .await
        }
        _ => Err(format!(
            "unsupported catalog request: {:?} {:?}",
            request.method, request.kind
        )),
    }
}

async fn call_catalog_tool(
    base_url: &str,
    catalog: &Catalog,
    name: &str,
    args: &Value,
) -> Result<(ResponseKind, Value), String> {
    let request = resolve_request(catalog, name, args)?;
    let kind = request.kind;
    let value = execute_catalog_request(base_url, request).await?;
    Ok((kind, value))
}

async fn create_task_via_api(
    base_url: &str,
    request: &CreateTaskRequest,
) -> Result<CreateTaskResponse, String> {
    post_json(base_url, "/v1/tasks", request).await
}

async fn complete_stage_via_api(
    base_url: &str,
    task_id: &str,
    request: &CompleteStageRequest,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/complete-stage"),
        request,
    )
    .await
}

async fn request_revision_via_api(
    base_url: &str,
    task_id: &str,
    request: &RequestRevisionRequest,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/request-revision"),
        request,
    )
    .await
}

async fn send_task_input_via_api(
    base_url: &str,
    task_id: &str,
    request: &TaskInputRequest,
) -> Result<TaskInputResponse, String> {
    post_no_content_json(base_url, &format!("/v1/tasks/{task_id}/input"), request)
        .await
        .map(|_| TaskInputResponse { ok: true })
}

async fn advance_stage_via_api(
    base_url: &str,
    task_id: &str,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/advance-stage"),
        &serde_json::json!({}),
    )
    .await
}

async fn block_task_via_api(
    base_url: &str,
    task_id: &str,
    request: &BlockTaskRequest,
) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/block"),
        request,
    )
    .await
}

async fn unblock_task_via_api(base_url: &str, task_id: &str) -> Result<TaskActionResponse, String> {
    post_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/unblock"),
        &serde_json::json!({}),
    )
    .await
}

async fn close_task_via_api(base_url: &str, task_id: &str) -> Result<(), String> {
    post_no_content_json(
        base_url,
        &format!("/v1/tasks/{task_id}/actions/close"),
        &serde_json::json!({}),
    )
    .await
}

fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    let rendered =
        serde_json::to_string_pretty(value).map_err(|e| format!("failed to render json: {e}"))?;
    println!("{rendered}");
    Ok(())
}

fn task_status_row(task: &TaskSummary) -> TaskStatusRow {
    TaskStatusRow {
        id: task.id.clone(),
        repo_id: task.repo_id.clone(),
        stage: task.stage.clone().unwrap_or_default(),
        activity: task.activity.clone().unwrap_or_default(),
        title: task.title.clone(),
    }
}

fn task_detail_status_row(task: &TaskDetail) -> TaskStatusRow {
    TaskStatusRow {
        id: task.id.clone(),
        repo_id: task.repo_id.clone(),
        stage: task.stage.clone().unwrap_or_default(),
        activity: task.activity.clone().unwrap_or_default(),
        title: task.title.clone(),
    }
}

fn task_status_rows(tasks: &[TaskSummary]) -> Vec<TaskStatusRow> {
    tasks.iter().map(task_status_row).collect()
}

fn format_task_list(tasks: &[TaskSummary]) -> Result<String, String> {
    serde_json::to_string_pretty(&task_status_rows(tasks))
        .map_err(|e| format!("failed to render json: {e}"))
}

#[cfg(test)]
fn find_task_status_row(tasks: &[TaskSummary], task_id: &str) -> Option<TaskStatusRow> {
    tasks
        .iter()
        .find(|task| task.id == task_id)
        .map(task_status_row)
}

fn format_task_status(task: &TaskStatusRow) -> Result<String, String> {
    serde_json::to_string_pretty(task).map_err(|e| format!("failed to render json: {e}"))
}

#[cfg(test)]
fn task_not_found_error(task_id: &str) -> String {
    format!("Task '{task_id}' was not found")
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Guide { json, server_url } => {
            let env_pairs = env::vars().collect::<Vec<_>>();
            let borrowed_pairs = env_pairs
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect::<Vec<_>>();
            let context = build_guide_context(&borrowed_pairs, server_url.as_deref()).await;
            if json {
                let rendered = render_guide_json(&context).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                if let Err(e) = print_json(&rendered) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            } else {
                println!("{}", render_guide_markdown(&context));
            }
        }
        Commands::StageComplete {
            task_id,
            status,
            summary,
            metadata,
            server_url,
        } => {
            // Validate status
            if status != "success" && status != "failure" {
                eprintln!(
                    "Error: --status must be \"success\" or \"failure\", got \"{}\"",
                    status
                );
                process::exit(1);
            }

            let metadata_value = parse_metadata_json(&metadata).unwrap_or_else(|e| {
                eprintln!("Error: {e}");
                process::exit(1);
            });

            let env_pairs = env::vars().collect::<Vec<_>>();
            let borrowed_pairs = env_pairs
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect::<Vec<_>>();
            if let Some(base_url) =
                resolve_optional_server_base_url(&borrowed_pairs, server_url.as_deref())
            {
                let request = build_complete_stage_request(
                    status.clone(),
                    summary.clone(),
                    metadata_value.clone(),
                );
                if let Err(e) = complete_stage_via_api(&base_url, &task_id, &request).await {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }

                match env::var("KANNA_SOCKET_PATH") {
                    Ok(socket_path) => {
                        if let Err(e) = notify_socket(&socket_path, &task_id).await {
                            eprintln!("Warning: Socket notification failed: {e}");
                        }
                    }
                    Err(_) => {
                        eprintln!(
                            "Warning: KANNA_SOCKET_PATH not set, skipping socket notification"
                        );
                    }
                }
                return;
            }

            // Build stage_result JSON
            let mut stage_result = serde_json::json!({
                "status": status,
                "summary": summary,
            });

            if let Some(meta) = metadata_value {
                stage_result["metadata"] = meta;
            }

            let stage_result_str = serde_json::to_string(&stage_result).unwrap_or_else(|e| {
                eprintln!("Error: Failed to serialize stage_result: {e}");
                process::exit(1);
            });

            // Step 1: Write to DB (critical path)
            let db_path = resolve_stage_db_path_from_env().unwrap_or_else(|e| {
                eprintln!("Error: {e}");
                process::exit(1);
            });

            if let Err(e) = write_stage_result_to_db(&db_path, &task_id, &stage_result_str) {
                eprintln!("Error: {e}");
                process::exit(1);
            }

            // Step 2: Notify via Unix socket (best-effort)
            match env::var("KANNA_SOCKET_PATH") {
                Ok(socket_path) => {
                    if let Err(e) = notify_socket(&socket_path, &task_id).await {
                        eprintln!("Warning: Socket notification failed: {e}");
                        // Best-effort — still exit 0
                    }
                }
                Err(_) => {
                    eprintln!("Warning: KANNA_SOCKET_PATH not set, skipping socket notification");
                }
            }
        }
        Commands::Repo { command } => match command {
            RepoCommands::List { server_url } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let repos = list_repos_via_api(&base_url).await.unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                if let Err(e) = print_json(&repos) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
            RepoCommands::Add {
                path,
                name,
                server_url,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let request = build_add_repo_request(path, name);
                let repo = add_repo_via_api(&base_url, &request)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) = print_json(&repo) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
        },
        Commands::Task { command } => match command {
            TaskCommands::List { server_url } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let tasks = list_tasks_via_api(&base_url).await.unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                let rendered = format_task_list(&tasks).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                println!("{rendered}");
            }
            TaskCommands::Status {
                task_id,
                server_url,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let task = get_task_via_api(&base_url, &task_id)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                let row = task_detail_status_row(&task);
                let rendered = format_task_status(&row).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                println!("{rendered}");
            }
            TaskCommands::Get {
                task_id,
                server_url,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let task = get_task_via_api(&base_url, &task_id)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) = print_json(&task) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
            TaskCommands::Wait {
                task_id,
                timeout_secs,
                poll_secs,
                until,
                server_url,
            } => {
                let until = parse_wait_until(&until).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let task = wait_task_via_api(&base_url, &task_id, timeout_secs, poll_secs, until)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) = print_json(&task) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
            TaskCommands::Logs {
                task_id,
                tail,
                server_url,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let logs = task_logs_via_api(&base_url, &task_id, tail)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                println!("{logs}");
            }
            TaskCommands::Create {
                repo_id,
                prompt,
                server_url,
                pipeline_name,
                base_ref,
                stage,
                agent_provider,
                agent_type,
                model,
                permission_mode,
                allowed_tool,
                blocker_task_id,
                notify_task,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let request = build_create_task_request(TaskCreateOptions {
                    repo_id,
                    prompt,
                    pipeline_name,
                    base_ref,
                    stage,
                    agent_provider,
                    agent_type,
                    model,
                    permission_mode,
                    allowed_tool,
                    blocker_task_id,
                    notify_task,
                });
                let created = create_task_via_api(&base_url, &request)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) = print_json(&created) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
            TaskCommands::RequestRevision {
                task_id,
                target_stage,
                summary,
                prompt,
                metadata,
                server_url,
            } => {
                let metadata_value = parse_metadata_json(&metadata).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let request =
                    build_request_revision_request(target_stage, summary, prompt, metadata_value);
                let created = request_revision_via_api(&base_url, &task_id, &request)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) = print_json(&created) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }

                match env::var("KANNA_SOCKET_PATH") {
                    Ok(socket_path) => {
                        if let Err(e) = notify_socket(&socket_path, &task_id).await {
                            eprintln!("Warning: Socket notification failed: {e}");
                        }
                    }
                    Err(_) => {
                        eprintln!(
                            "Warning: KANNA_SOCKET_PATH not set, skipping socket notification"
                        );
                    }
                }
            }
            TaskCommands::SendInput {
                task_id,
                message,
                server_url,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let request = build_send_task_input_request(message);
                let response = send_task_input_via_api(&base_url, &task_id, &request)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) = print_json(&response) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
            TaskCommands::AdvanceStage {
                task_id,
                server_url,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let advanced = advance_stage_via_api(&base_url, &task_id)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) = print_json(&advanced) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
            TaskCommands::Block {
                task_id,
                blocker_task_id,
                server_url,
            } => {
                if blocker_task_id.is_empty() {
                    eprintln!("Error: at least one --blocker-task-id is required");
                    process::exit(1);
                }
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let request = build_block_task_request(blocker_task_id);
                let blocked = block_task_via_api(&base_url, &task_id, &request)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) = print_json(&blocked) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
            TaskCommands::Unblock {
                task_id,
                server_url,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let unblocked = unblock_task_via_api(&base_url, &task_id)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) = print_json(&unblocked) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
            TaskCommands::Close {
                task_id,
                server_url,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                close_task_via_api(&base_url, &task_id)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) =
                    print_json(&serde_json::json!({ "taskId": task_id, "closed": true }))
                {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
        },
        Commands::Tool { command } => match command {
            ToolCommands::List => {
                let catalog = load_tool_catalog_from_current_dir().unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                if let Err(e) = print_json(&catalog.tools_list_value()) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
            ToolCommands::Call {
                name,
                json,
                arg,
                server_url,
            } => {
                let args = build_tool_call_args(&json, &arg).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                let catalog = load_tool_catalog_from_current_dir().unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let (kind, value) = call_catalog_tool(&base_url, &catalog, &name, &args)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if kind == ResponseKind::Text {
                    if let Some(text) = value.as_str() {
                        println!("{text}");
                        return;
                    }
                }
                if let Err(e) = print_json(&value) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        advance_stage_via_api, block_task_via_api, build_add_repo_request,
        build_block_task_request, build_complete_stage_request, build_create_task_request,
        build_request_revision_request, build_send_task_input_request, build_tool_call_args,
        catalog_create_task_param_names, close_task_via_api, create_task_via_api,
        find_task_status_row, format_task_list, format_task_status, get_task_via_api,
        parse_wait_until, render_guide_markdown, resolve_optional_server_base_url,
        resolve_server_base_url, resolve_stage_db_path, send_task_input_via_api,
        task_create_flag_names, task_get_path, task_list_path, task_logs_path,
        task_matches_wait_until, task_not_found_error, unblock_task_via_api, GuideContext,
        TaskCreateOptions, TaskDetail, TaskInputResponse, TaskSummary, WaitUntil,
    };
    use clap::Parser;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener as TokioTcpListener;

    #[test]
    fn prefers_cli_specific_db_path() {
        let env = [("KANNA_CLI_DB_PATH", "/tmp/worktree.db")];

        assert_eq!(
            resolve_stage_db_path(&env),
            Ok("/tmp/worktree.db".to_string())
        );
    }

    #[test]
    fn errors_when_cli_path_missing() {
        let env: [(&str, &str); 0] = [];
        assert_eq!(
            resolve_stage_db_path(&env),
            Err("KANNA_CLI_DB_PATH environment variable is not set".to_string())
        );
    }

    #[test]
    fn uses_explicit_server_url_before_env_or_default() {
        let env = [("KANNA_SERVER_BASE_URL", "http://127.0.0.1:9999")];

        assert_eq!(
            resolve_server_base_url(&env, Some("http://127.0.0.1:5555")),
            "http://127.0.0.1:5555".to_string()
        );
    }

    #[test]
    fn falls_back_to_default_local_server_url() {
        let env: [(&str, &str); 0] = [];

        assert_eq!(
            resolve_server_base_url(&env, None),
            "http://127.0.0.1:48120".to_string()
        );
    }

    #[test]
    fn optional_server_url_only_uses_explicit_or_env_values() {
        let empty_env: [(&str, &str); 0] = [];
        assert_eq!(resolve_optional_server_base_url(&empty_env, None), None);

        let env = [("KANNA_SERVER_BASE_URL", "http://127.0.0.1:48129")];
        assert_eq!(
            resolve_optional_server_base_url(&env, None),
            Some("http://127.0.0.1:48129".to_string())
        );
        assert_eq!(
            resolve_optional_server_base_url(&env, Some("http://127.0.0.1:5555")),
            Some("http://127.0.0.1:5555".to_string())
        );
    }

    #[test]
    fn builds_complete_stage_payload() {
        let request = build_complete_stage_request(
            "success".to_string(),
            "review passed".to_string(),
            Some(json!({ "coverage": "sufficient" })),
        );

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "status": "success",
                "summary": "review passed",
                "metadata": { "coverage": "sufficient" },
            })
        );
    }

    #[test]
    fn builds_request_revision_payload() {
        let request = build_request_revision_request(
            "in progress".to_string(),
            "missing e2e coverage".to_string(),
            "Add e2e coverage for task creation.".to_string(),
            None,
        );

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "targetStage": "in progress",
                "summary": "missing e2e coverage",
                "prompt": "Add e2e coverage for task creation.",
            })
        );
    }

    #[test]
    fn builds_send_task_input_payload() {
        let request = build_send_task_input_request("Please fix the failing typecheck".to_string());

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "input": "Please fix the failing typecheck",
            })
        );
    }

    #[test]
    fn builds_add_repo_payload() {
        let request =
            build_add_repo_request("/Users/me/project".to_string(), Some("Project".to_string()));

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "path": "/Users/me/project",
                "name": "Project",
            })
        );
    }

    #[test]
    fn parses_new_repo_and_task_subcommands() {
        let cli = super::Cli::try_parse_from(["kanna-cli", "guide", "--json"]).unwrap();
        match cli.command {
            super::Commands::Guide { json, .. } => assert!(json),
            _ => panic!("expected guide command"),
        }

        let cli = super::Cli::try_parse_from([
            "kanna-cli",
            "repo",
            "add",
            "--path",
            "/tmp/project",
            "--name",
            "Project",
            "--server-url",
            "http://127.0.0.1:48120",
        ])
        .unwrap();
        match cli.command {
            super::Commands::Repo {
                command:
                    super::RepoCommands::Add {
                        path,
                        name,
                        server_url,
                    },
            } => {
                assert_eq!(path, "/tmp/project");
                assert_eq!(name.as_deref(), Some("Project"));
                assert_eq!(server_url.as_deref(), Some("http://127.0.0.1:48120"));
            }
            _ => panic!("expected repo add command"),
        }

        let cli = super::Cli::try_parse_from([
            "kanna-cli",
            "task",
            "wait",
            "--task-id",
            "task-1",
            "--timeout-secs",
            "5",
            "--poll-secs",
            "1",
            "--until",
            "closed",
        ])
        .unwrap();
        match cli.command {
            super::Commands::Task {
                command:
                    super::TaskCommands::Wait {
                        task_id,
                        timeout_secs,
                        poll_secs,
                        until,
                        ..
                    },
            } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(timeout_secs, 5);
                assert_eq!(poll_secs, 1);
                assert_eq!(until, "closed");
            }
            _ => panic!("expected task wait command"),
        }

        let cli = super::Cli::try_parse_from([
            "kanna-cli",
            "task",
            "create",
            "--repo-id",
            "repo-1",
            "--prompt",
            "Child",
            "--notify-task",
            "task-parent",
        ])
        .unwrap();
        match cli.command {
            super::Commands::Task {
                command:
                    super::TaskCommands::Create {
                        repo_id,
                        prompt,
                        notify_task,
                        ..
                    },
            } => {
                assert_eq!(repo_id, "repo-1");
                assert_eq!(prompt, "Child");
                assert_eq!(notify_task.as_deref(), Some("task-parent"));
            }
            _ => panic!("expected task create command"),
        }

        let cli = super::Cli::try_parse_from([
            "kanna-cli",
            "task",
            "logs",
            "--task-id",
            "task-1",
            "--tail",
            "25",
        ])
        .unwrap();
        match cli.command {
            super::Commands::Task {
                command: super::TaskCommands::Logs { task_id, tail, .. },
            } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(tail, Some(25));
            }
            _ => panic!("expected task logs command"),
        }
    }

    #[test]
    fn parses_generic_tool_subcommands() {
        let cli = super::Cli::try_parse_from(["kanna-cli", "tool", "list"]).unwrap();
        assert!(matches!(
            cli.command,
            super::Commands::Tool {
                command: super::ToolCommands::List
            }
        ));

        let cli = super::Cli::try_parse_from([
            "kanna-cli",
            "tool",
            "call",
            "kanna_create_task",
            "--json",
            r#"{"repo_id":"repo-1","prompt":"Ship"}"#,
            "--arg",
            "stage=pr",
            "--server-url",
            "http://127.0.0.1:48120",
        ])
        .unwrap();
        match cli.command {
            super::Commands::Tool {
                command:
                    super::ToolCommands::Call {
                        name,
                        json,
                        arg,
                        server_url,
                    },
            } => {
                assert_eq!(name, "kanna_create_task");
                assert_eq!(
                    json.as_deref(),
                    Some(r#"{"repo_id":"repo-1","prompt":"Ship"}"#)
                );
                assert_eq!(arg, vec!["stage=pr".to_string()]);
                assert_eq!(server_url.as_deref(), Some("http://127.0.0.1:48120"));
            }
            _ => panic!("expected tool call command"),
        }
    }

    #[test]
    fn tool_call_args_merge_json_and_repeated_args() {
        let args = build_tool_call_args(
            &Some(r#"{"repo_id":"repo-1","prompt":"Ship","allowed_tools":["Read"]}"#.to_string()),
            &["stage=pr".to_string(), "timeout_secs=5".to_string()],
        )
        .unwrap();

        assert_eq!(
            args,
            json!({
                "repo_id": "repo-1",
                "prompt": "Ship",
                "allowed_tools": ["Read"],
                "stage": "pr",
                "timeout_secs": 5
            })
        );
    }

    #[test]
    fn typed_create_flags_cover_catalog_create_task_params_and_match_body() {
        let typed_flags = task_create_flag_names();
        let catalog_params = catalog_create_task_param_names();
        for param in catalog_params {
            assert!(
                typed_flags.contains(&param),
                "typed task create missing catalog param {param}"
            );
        }

        let request = build_create_task_request(TaskCreateOptions {
            repo_id: "repo-1".to_string(),
            prompt: "Ship it".to_string(),
            pipeline_name: Some("default".to_string()),
            base_ref: Some("origin/main".to_string()),
            stage: Some("pr".to_string()),
            agent_provider: Some("claude".to_string()),
            agent_type: None,
            model: Some("sonnet".to_string()),
            permission_mode: Some("acceptEdits".to_string()),
            allowed_tool: vec!["Read".to_string(), "Write".to_string()],
            blocker_task_id: vec!["blocker-1".to_string()],
            notify_task: Some("parent-1".to_string()),
        });
        let typed_body = serde_json::to_value(request).unwrap();
        let catalog = kanna_tool_catalog::bundled_catalog();
        let resolved = kanna_tool_catalog::resolve_request(
            &catalog,
            "kanna_create_task",
            &json!({
                "repo_id": "repo-1",
                "prompt": "Ship it",
                "pipeline_name": "default",
                "base_ref": "origin/main",
                "stage": "pr",
                "agent_provider": "claude",
                "model": "sonnet",
                "permission_mode": "acceptEdits",
                "allowed_tools": ["Read", "Write"],
                "blocker_task_ids": ["blocker-1"],
                "notify_task_id": "parent-1"
            }),
        )
        .unwrap();

        assert_eq!(typed_body, resolved.body);
    }

    #[test]
    fn send_task_input_payload_passes_message_through_unchanged() {
        // The server owns submission; the CLI sends the message verbatim.
        let request = build_send_task_input_request("continue\n".to_string());

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "input": "continue\n",
            })
        );
    }

    #[tokio::test]
    async fn send_task_input_posts_input_to_task_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let bytes_read = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..bytes_read]);
            assert!(request.starts_with("POST /v1/tasks/task-1/input HTTP/1.1"));
            assert!(request.contains(r#"{"input":"continue"}"#));

            stream
                .write_all(b"HTTP/1.1 204 No Content\r\ncontent-length: 0\r\n\r\n")
                .unwrap();
        });

        let response = send_task_input_via_api(
            &format!("http://{address}"),
            "task-1",
            &build_send_task_input_request("continue".to_string()),
        )
        .await;

        server.join().unwrap();
        assert_eq!(response, Ok(TaskInputResponse { ok: true }));
    }

    #[tokio::test]
    async fn send_task_input_preserves_http_error_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer).unwrap();

            stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: 21\r\n\r\ntask task-1 not found",
                )
                .unwrap();
        });

        let response = send_task_input_via_api(
            &format!("http://{address}"),
            "task-1",
            &build_send_task_input_request("continue".to_string()),
        )
        .await;

        server.join().unwrap();
        assert_eq!(
            response,
            Err("request failed with status 404 Not Found: task task-1 not found".to_string())
        );
    }

    #[test]
    fn builds_camel_case_task_request_payload() {
        let request = build_create_task_request(TaskCreateOptions {
            repo_id: "repo-1".to_string(),
            prompt: "Ship it".to_string(),
            pipeline_name: Some("default".to_string()),
            base_ref: Some("origin/main".to_string()),
            stage: Some("pr".to_string()),
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: Some("sonnet".to_string()),
            permission_mode: Some("dontAsk".to_string()),
            allowed_tool: vec!["Bash".to_string(), "Edit".to_string()],
            blocker_task_id: vec!["blocker-1".to_string(), "blocker-2".to_string()],
            notify_task: Some("orchestrator-1".to_string()),
        });

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "repoId": "repo-1",
                "prompt": "Ship it",
                "pipelineName": "default",
                "baseRef": "origin/main",
                "stage": "pr",
                "agentProvider": "claude",
                "agentType": "agent",
                "model": "sonnet",
                "permissionMode": "dontAsk",
                "allowedTools": ["Bash", "Edit"],
                "blockerTaskIds": ["blocker-1", "blocker-2"],
                "notifyTaskId": "orchestrator-1",
            })
        );
    }
    #[test]
    fn task_list_uses_recent_tasks_endpoint() {
        assert_eq!(task_list_path(), "/v1/tasks/recent");
    }

    #[test]
    fn task_get_uses_single_task_endpoint() {
        assert_eq!(task_get_path("task 1"), "/v1/tasks/task%201");
    }

    #[test]
    fn task_logs_uses_task_logs_endpoint() {
        assert_eq!(
            task_logs_path("task 1", Some(25)),
            "/v1/tasks/task%201/logs?tail=25"
        );
        assert_eq!(task_logs_path("task-1", None), "/v1/tasks/task-1/logs");
    }

    #[test]
    fn wait_until_matches_finished_and_closed_states() {
        let mut task: TaskDetail = serde_json::from_value(json!({
            "id": "task-1",
            "repoId": "repo-1",
            "title": "Wait",
            "stage": "in progress",
            "activity": "working",
            "snippet": null,
            "agentType": "pty",
            "agentProvider": "claude",
            "branch": "task-task-1",
            "prUrl": null,
            "closedAt": null,
            "worktreePath": null,
            "commitsAhead": 0,
            "commitsBehind": 0,
            "dirty": false
        }))
        .unwrap();

        assert_eq!(parse_wait_until("finished"), Ok(WaitUntil::Finished));
        assert_eq!(parse_wait_until("closed"), Ok(WaitUntil::Closed));
        assert!(!task_matches_wait_until(&task, WaitUntil::Finished));
        task.activity = Some("unread".to_string());
        assert!(task_matches_wait_until(&task, WaitUntil::Finished));
        assert!(!task_matches_wait_until(&task, WaitUntil::Closed));
        task.closed_at = Some("2026-06-13 00:00:00".to_string());
        assert!(task_matches_wait_until(&task, WaitUntil::Closed));
    }

    #[test]
    fn parses_task_summary_response_shape() {
        let task: TaskSummary = serde_json::from_value(json!({
            "id": "task-1",
            "repoId": "repo-1",
            "title": "Add status command",
            "stage": "in progress",
            "snippet": "working...",
            "activity": "working",
        }))
        .unwrap();

        assert_eq!(task.id, "task-1");
        assert_eq!(task.repo_id, "repo-1");
        assert_eq!(task.stage.as_deref(), Some("in progress"));
        assert_eq!(task.activity.as_deref(), Some("working"));
        assert_eq!(task.title, "Add status command");
    }

    #[test]
    fn parses_task_detail_response_shape() {
        let task: TaskDetail = serde_json::from_value(json!({
            "id": "task-1",
            "repoId": "repo-1",
            "title": "Add status command",
            "stage": "in progress",
            "pipelineName": "default",
            "stageTransition": "manual",
            "activity": "working",
            "snippet": "working...",
            "agentType": "pty",
            "agentProvider": "claude",
            "branch": "task-task-1",
            "prUrl": null,
            "closedAt": null,
            "worktreePath": "/tmp/worktree",
            "commitsAhead": 2,
            "commitsBehind": 1,
            "dirty": true
        }))
        .unwrap();

        assert_eq!(task.id, "task-1");
        assert_eq!(task.activity.as_deref(), Some("working"));
        assert_eq!(task.pipeline_name.as_deref(), Some("default"));
        assert_eq!(task.stage_transition.as_deref(), Some("manual"));
        assert_eq!(task.agent_provider.as_deref(), Some("claude"));
        assert_eq!(task.branch.as_deref(), Some("task-task-1"));
        assert_eq!(task.worktree_path.as_deref(), Some("/tmp/worktree"));
        assert_eq!(task.commits_ahead, 2);
        assert_eq!(task.commits_behind, 1);
        assert!(task.dirty);
    }

    #[test]
    fn guide_markdown_includes_live_context_and_all_catalog_tools() {
        let task = TaskDetail {
            id: "task-123".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Review branch".to_string(),
            stage: Some("review".to_string()),
            pipeline_name: Some("qa".to_string()),
            stage_transition: Some("auto".to_string()),
            activity: Some("working".to_string()),
            snippet: None,
            agent_type: Some("pty".to_string()),
            agent_provider: Some("claude".to_string()),
            branch: Some("task-task-123".to_string()),
            pr_url: None,
            closed_at: None,
            worktree_path: Some("/tmp/worktree".to_string()),
            commits_ahead: 0,
            commits_behind: 0,
            dirty: false,
        };

        let guide = render_guide_markdown(&GuideContext {
            task_id: "task-123".to_string(),
            task: Some(task),
            live_state_error: None,
            catalog: kanna_tool_catalog::bundled_catalog(),
        });

        assert!(guide.contains("You are task `task-123`, stage `review` of pipeline `qa` (`auto`)"));
        assert!(guide.contains("kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\""));
        assert!(guide.contains(
            "Advancing closes the current task and spawns a new task in a new worktree."
        ));
        for tool in kanna_tool_catalog::bundled_catalog().tools {
            assert!(
                guide.contains(&format!("`{}`", tool.name)),
                "guide missing catalog tool {}",
                tool.name
            );
        }
    }

    #[test]
    fn formats_task_list_as_script_friendly_json_rows() {
        let tasks = vec![TaskSummary {
            id: "task-1".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Add status command".to_string(),
            stage: Some("in progress".to_string()),
            snippet: Some("working...".to_string()),
            activity: Some("working".to_string()),
        }];

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&format_task_list(&tasks).unwrap()).unwrap(),
            json!([
                {
                    "id": "task-1",
                    "repoId": "repo-1",
                    "stage": "in progress",
                    "activity": "working",
                    "title": "Add status command",
                }
            ])
        );
    }

    #[test]
    fn formats_task_status_for_exact_task_id_only() {
        let tasks = vec![
            TaskSummary {
                id: "task-123".to_string(),
                repo_id: "repo-1".to_string(),
                title: "Wanted".to_string(),
                stage: Some("pr".to_string()),
                snippet: None,
                activity: Some("unread".to_string()),
            },
            TaskSummary {
                id: "task-123-extra".to_string(),
                repo_id: "repo-1".to_string(),
                title: "Wrong".to_string(),
                stage: Some("in progress".to_string()),
                snippet: None,
                activity: Some("working".to_string()),
            },
        ];

        let row = find_task_status_row(&tasks, "task-123").unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&format_task_status(&row).unwrap()).unwrap(),
            json!({
                "id": "task-123",
                "repoId": "repo-1",
                "stage": "pr",
                "activity": "unread",
                "title": "Wanted",
            })
        );
    }

    #[test]
    fn reports_clear_task_not_found_error() {
        assert_eq!(
            task_not_found_error("missing-task"),
            "Task 'missing-task' was not found".to_string()
        );
    }

    fn http_json_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    async fn serve_single_http_response(
        response: String,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://{addr}");
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0; 4096];
            let bytes_read = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
            socket.write_all(response.as_bytes()).await.unwrap();
            request
        });

        (base_url, handle)
    }

    #[tokio::test]
    async fn advance_stage_posts_to_task_action_path_with_empty_json_body() {
        let response = http_json_response("200 OK", "{\"taskId\":\"next-task-1\"}");
        let (base_url, handle) = serve_single_http_response(response).await;

        let action = advance_stage_via_api(&base_url, "task-123").await.unwrap();
        let request = handle.await.unwrap();

        assert_eq!(action.task_id, "next-task-1");
        assert!(request.starts_with("POST /v1/tasks/task-123/actions/advance-stage HTTP/1.1"));
        assert!(request.contains("content-type: application/json"));
        assert!(request.ends_with("{}"));
    }

    #[tokio::test]
    async fn get_task_via_api_fetches_single_task_path() {
        let response = http_json_response(
            "200 OK",
            r#"{
                "id": "task-123",
                "repoId": "repo-1",
                "title": "Wanted",
                "stage": "pr",
                "activity": "unread",
                "snippet": null,
                "agentType": "pty",
                "agentProvider": "claude",
                "branch": "task-task-123",
                "prUrl": "https://github.com/acme/kanna/pull/1",
                "closedAt": null,
                "worktreePath": null,
                "commitsAhead": 0,
                "commitsBehind": 0,
                "dirty": false
            }"#,
        );
        let (base_url, handle) = serve_single_http_response(response).await;

        let task = get_task_via_api(&base_url, "task-123").await.unwrap();
        let request = handle.await.unwrap();

        assert_eq!(task.id, "task-123");
        assert_eq!(task.activity.as_deref(), Some("unread"));
        assert!(request.starts_with("GET /v1/tasks/task-123 HTTP/1.1"));
    }

    #[tokio::test]
    async fn close_task_posts_to_close_action_path() {
        let response = "HTTP/1.1 204 No Content\r\ncontent-length: 0\r\n\r\n".to_string();
        let (base_url, handle) = serve_single_http_response(response).await;

        close_task_via_api(&base_url, "task-123").await.unwrap();
        let request = handle.await.unwrap();

        assert!(request.starts_with("POST /v1/tasks/task-123/actions/close HTTP/1.1"));
    }

    #[tokio::test]
    async fn advance_stage_surfaces_http_errors() {
        let response = http_json_response("409 Conflict", "{\"error\":\"task not accepted yet\"}");
        let (base_url, handle) = serve_single_http_response(response).await;

        let error = advance_stage_via_api(&base_url, "task-123")
            .await
            .unwrap_err();
        let request = handle.await.unwrap();

        assert!(request.starts_with("POST /v1/tasks/task-123/actions/advance-stage HTTP/1.1"));
        assert!(error.contains("409 Conflict"));
    }

    #[test]
    fn builds_block_task_payload() {
        let request =
            build_block_task_request(vec!["blocker-1".to_string(), "blocker-2".to_string()]);

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "blockerTaskIds": ["blocker-1", "blocker-2"],
            })
        );
    }

    #[tokio::test]
    async fn block_task_posts_to_task_action_path() {
        let response = http_json_response("200 OK", "{\"taskId\":\"task-123\"}");
        let (base_url, handle) = serve_single_http_response(response).await;

        let action = block_task_via_api(
            &base_url,
            "task-123",
            &build_block_task_request(vec!["blocker-1".to_string()]),
        )
        .await
        .unwrap();
        let request = handle.await.unwrap();

        assert_eq!(action.task_id, "task-123");
        assert!(request.starts_with("POST /v1/tasks/task-123/actions/block HTTP/1.1"));
        assert!(request.contains(r#"{"blockerTaskIds":["blocker-1"]}"#));
    }

    #[tokio::test]
    async fn unblock_task_posts_to_task_action_path() {
        let response = http_json_response("200 OK", "{\"taskId\":\"task-123\"}");
        let (base_url, handle) = serve_single_http_response(response).await;

        let action = unblock_task_via_api(&base_url, "task-123").await.unwrap();
        let request = handle.await.unwrap();

        assert_eq!(action.task_id, "task-123");
        assert!(request.starts_with("POST /v1/tasks/task-123/actions/unblock HTTP/1.1"));
        assert!(request.ends_with("{}"));
    }

    #[test]
    fn builds_task_request_omits_agent_provider_when_flag_absent() {
        let request = build_create_task_request(TaskCreateOptions {
            repo_id: "repo-1".to_string(),
            prompt: "Use the saved default provider".to_string(),
            pipeline_name: None,
            base_ref: None,
            stage: None,
            agent_provider: None,
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tool: Vec::new(),
            blocker_task_id: Vec::new(),
            notify_task: None,
        });

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "repoId": "repo-1",
                "prompt": "Use the saved default provider",
            })
        );
    }

    #[tokio::test]
    async fn create_task_via_api_posts_payload_without_agent_provider_when_flag_absent() {
        let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut buffer = [0_u8; 1024];
            let (body_start, content_length) = loop {
                let n = stream.read(&mut buffer).await.unwrap();
                assert!(n > 0, "client closed before sending request body");
                received.extend_from_slice(&buffer[..n]);
                if let Some(header_end) = received.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header_text = String::from_utf8(received[..header_end].to_vec()).unwrap();
                    let content_length = header_text
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length: ")
                                .or_else(|| line.strip_prefix("Content-Length: "))
                        })
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    break (header_end + 4, content_length);
                }
            };
            while received.len() < body_start + content_length {
                let n = stream.read(&mut buffer).await.unwrap();
                assert!(n > 0, "client closed before sending full request body");
                received.extend_from_slice(&buffer[..n]);
            }
            let body =
                String::from_utf8(received[body_start..body_start + content_length].to_vec())
                    .unwrap();
            let response_body = serde_json::json!({
                "taskId": "task-1",
                "repoId": "repo-1",
                "title": "Use the saved default provider",
                "stage": "in progress",
            })
            .to_string();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                        response_body.len(),
                        response_body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            body
        });

        let request = build_create_task_request(TaskCreateOptions {
            repo_id: "repo-1".to_string(),
            prompt: "Use the saved default provider".to_string(),
            pipeline_name: None,
            base_ref: None,
            stage: None,
            agent_provider: None,
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tool: Vec::new(),
            blocker_task_id: Vec::new(),
            notify_task: None,
        });

        let created = create_task_via_api(&format!("http://{addr}"), &request)
            .await
            .unwrap();
        let body = server.await.unwrap();

        assert_eq!(created.task_id, "task-1");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            json!({
                "repoId": "repo-1",
                "prompt": "Use the saved default provider",
            })
        );
    }
}
