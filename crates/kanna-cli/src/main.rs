use clap::{Parser, Subcommand};
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
}

#[derive(Subcommand)]
enum RepoCommands {
    /// List repos known to the running desktop server
    List {
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

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
struct RepoSummary {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskSummary {
    id: String,
    repo_id: String,
    title: String,
    stage: Option<String>,
    snippet: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskStatusRow {
    id: String,
    repo_id: String,
    stage: String,
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
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocker_task_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CreateTaskResponse {
    task_id: String,
    repo_id: String,
    title: String,
    stage: String,
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
    model: Option<String>,
    permission_mode: Option<String>,
    allowed_tool: Vec<String>,
    blocker_task_id: Vec<String>,
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

fn build_create_task_request(options: TaskCreateOptions) -> CreateTaskRequest {
    CreateTaskRequest {
        repo_id: options.repo_id,
        prompt: options.prompt,
        pipeline_name: options.pipeline_name,
        base_ref: options.base_ref,
        stage: options.stage,
        agent_provider: options.agent_provider,
        model: options.model,
        permission_mode: options.permission_mode,
        allowed_tools: (!options.allowed_tool.is_empty()).then_some(options.allowed_tool),
        blocker_task_ids: (!options.blocker_task_id.is_empty()).then_some(options.blocker_task_id),
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
    let input = if message.ends_with('\n') {
        message
    } else {
        format!("{message}\n")
    };
    TaskInputRequest { input }
}

fn build_block_task_request(blocker_task_ids: Vec<String>) -> BlockTaskRequest {
    BlockTaskRequest { blocker_task_ids }
}

fn parse_metadata_json(metadata: &Option<String>) -> Result<Option<Value>, String> {
    match metadata {
        Some(json_str) => serde_json::from_str(json_str)
            .map(Some)
            .map_err(|e| format!("--metadata is not valid JSON: {e}")),
        None => Ok(None),
    }
}

fn join_server_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

fn task_list_path() -> &'static str {
    "/v1/tasks/recent"
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

async fn list_repos_via_api(base_url: &str) -> Result<Vec<RepoSummary>, String> {
    get_json(base_url, "/v1/repos").await
}

async fn list_tasks_via_api(base_url: &str) -> Result<Vec<TaskSummary>, String> {
    get_json(base_url, task_list_path()).await
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

fn find_task_status_row(tasks: &[TaskSummary], task_id: &str) -> Option<TaskStatusRow> {
    tasks
        .iter()
        .find(|task| task.id == task_id)
        .map(task_status_row)
}

fn format_task_status(task: &TaskStatusRow) -> Result<String, String> {
    serde_json::to_string_pretty(task).map_err(|e| format!("failed to render json: {e}"))
}

fn task_not_found_error(task_id: &str) -> String {
    format!("Task '{task_id}' was not found in recent tasks")
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
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
                let tasks = list_tasks_via_api(&base_url).await.unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                let row = find_task_status_row(&tasks, &task_id).unwrap_or_else(|| {
                    eprintln!("Error: {}", task_not_found_error(&task_id));
                    process::exit(1);
                });
                let rendered = format_task_status(&row).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                println!("{rendered}");
            }
            TaskCommands::Create {
                repo_id,
                prompt,
                server_url,
                pipeline_name,
                base_ref,
                stage,
                agent_provider,
                model,
                permission_mode,
                allowed_tool,
                blocker_task_id,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let request = build_create_task_request(TaskCreateOptions {
                    repo_id,
                    prompt,
                    pipeline_name,
                    base_ref,
                    stage,
                    agent_provider,
                    model,
                    permission_mode,
                    allowed_tool,
                    blocker_task_id,
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
    }
}

#[cfg(test)]
mod tests {
    use super::{
        advance_stage_via_api, block_task_via_api, build_block_task_request,
        build_complete_stage_request, build_create_task_request, build_request_revision_request,
        build_send_task_input_request, create_task_via_api, find_task_status_row, format_task_list,
        format_task_status, resolve_optional_server_base_url, resolve_server_base_url,
        resolve_stage_db_path, send_task_input_via_api, task_list_path, task_not_found_error,
        unblock_task_via_api, close_task_via_api, TaskCreateOptions, TaskInputResponse,
        TaskSummary,
    };
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
                "input": "Please fix the failing typecheck\n",
            })
        );
    }

    #[test]
    fn preserves_existing_send_task_input_newline() {
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
            assert!(request.contains(r#"{"input":"continue\n"}"#));

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
            model: Some("sonnet".to_string()),
            permission_mode: Some("dontAsk".to_string()),
            allowed_tool: vec!["Bash".to_string(), "Edit".to_string()],
            blocker_task_id: vec!["blocker-1".to_string(), "blocker-2".to_string()],
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
                "model": "sonnet",
                "permissionMode": "dontAsk",
                "allowedTools": ["Bash", "Edit"],
                "blockerTaskIds": ["blocker-1", "blocker-2"],
            })
        );
    }
    #[test]
    fn task_list_uses_recent_tasks_endpoint() {
        assert_eq!(task_list_path(), "/v1/tasks/recent");
    }

    #[test]
    fn parses_task_summary_response_shape() {
        let task: TaskSummary = serde_json::from_value(json!({
            "id": "task-1",
            "repoId": "repo-1",
            "title": "Add status command",
            "stage": "in progress",
            "snippet": "working...",
        }))
        .unwrap();

        assert_eq!(task.id, "task-1");
        assert_eq!(task.repo_id, "repo-1");
        assert_eq!(task.stage.as_deref(), Some("in progress"));
        assert_eq!(task.title, "Add status command");
    }

    #[test]
    fn formats_task_list_as_script_friendly_json_rows() {
        let tasks = vec![TaskSummary {
            id: "task-1".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Add status command".to_string(),
            stage: Some("in progress".to_string()),
            snippet: Some("working...".to_string()),
        }];

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&format_task_list(&tasks).unwrap()).unwrap(),
            json!([
                {
                    "id": "task-1",
                    "repoId": "repo-1",
                    "stage": "in progress",
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
            },
            TaskSummary {
                id: "task-123-extra".to_string(),
                repo_id: "repo-1".to_string(),
                title: "Wrong".to_string(),
                stage: Some("in progress".to_string()),
                snippet: None,
            },
        ];

        let row = find_task_status_row(&tasks, "task-123").unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&format_task_status(&row).unwrap()).unwrap(),
            json!({
                "id": "task-123",
                "repoId": "repo-1",
                "stage": "pr",
                "title": "Wanted",
            })
        );
    }

    #[test]
    fn reports_clear_task_not_found_error() {
        assert_eq!(
            task_not_found_error("missing-task"),
            "Task 'missing-task' was not found in recent tasks".to_string()
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
            model: None,
            permission_mode: None,
            allowed_tool: Vec::new(),
            blocker_task_id: Vec::new(),
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
            model: None,
            permission_mode: None,
            allowed_tool: Vec::new(),
            blocker_task_id: Vec::new(),
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
