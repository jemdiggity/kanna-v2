use clap::{Parser, Subcommand};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::env;
use std::io::{BufRead, Write};
use std::process;

const DEFAULT_SERVER_BASE_URL: &str = "http://127.0.0.1:48120";

#[derive(Parser)]
#[command(name = "kanna-mcp")]
#[command(about = "Kanna MCP server")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Serve MCP over newline-delimited JSON-RPC on stdin/stdout.
    Serve {
        /// Override the local Kanna server base URL.
        #[arg(long)]
        server_url: Option<String>,
    },
}

fn env_var_from_pairs(env_pairs: &[(&str, &str)], key: &str) -> Option<String> {
    env_pairs
        .iter()
        .find_map(|(candidate, value)| (*candidate == key).then(|| (*value).to_string()))
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

fn resolve_server_base_url_from_env(explicit_server_url: Option<&str>) -> String {
    let env_pairs = env::vars().collect::<Vec<_>>();
    let borrowed_pairs = env_pairs
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    resolve_server_base_url(&borrowed_pairs, explicit_server_url)
}

fn mcp_response(id: Value, result: Value) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn mcp_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}

fn mcp_tool_error_code(message: &str) -> i64 {
    if message.starts_with("missing required argument:")
        || message.contains(" must be ")
        || message == "status must be success or failure"
    {
        -32602
    } else {
        -32603
    }
}

fn mcp_tools() -> Value {
    serde_json::json!([
        {
            "name": "kanna_list_repos",
            "description": "List repositories known to the running Kanna desktop server.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "kanna_add_repo",
            "description": "Register an existing local git repository with Kanna.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "name": { "type": "string" }
                },
                "required": ["path"]
            }
        },
        {
            "name": "kanna_list_recent_tasks",
            "description": "List recent open Kanna tasks.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "kanna_get_task",
            "description": "Fetch one Kanna task by task ID or branch name.",
            "inputSchema": {
                "type": "object",
                "properties": { "task_id": { "type": "string" } },
                "required": ["task_id"]
            }
        },
        {
            "name": "kanna_wait_task",
            "description": "Poll a Kanna task until it finishes or closes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "timeout_secs": { "type": "integer" },
                    "poll_secs": { "type": "integer" },
                    "until": { "type": "string", "enum": ["finished", "closed"] }
                },
                "required": ["task_id"]
            }
        },
        {
            "name": "kanna_task_logs",
            "description": "Fetch recent logs for a Kanna task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "tail": { "type": "integer" }
                },
                "required": ["task_id"]
            }
        },
        {
            "name": "kanna_search_tasks",
            "description": "Search Kanna tasks by query text.",
            "inputSchema": {
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"]
            }
        },
        {
            "name": "kanna_list_repo_tasks",
            "description": "List Kanna tasks for a repository.",
            "inputSchema": {
                "type": "object",
                "properties": { "repo_id": { "type": "string" } },
                "required": ["repo_id"]
            }
        },
        {
            "name": "kanna_create_task",
            "description": "Create a new Kanna task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo_id": { "type": "string" },
                    "prompt": { "type": "string" },
                    "pipeline_name": { "type": "string" },
                    "base_ref": { "type": "string" },
                    "stage": { "type": "string" },
                    "agent_provider": { "type": "string" },
                    "model": { "type": "string" },
                    "permission_mode": { "type": "string" },
                    "notify_task_id": { "type": "string" },
                    "allowed_tools": { "type": "array", "items": { "type": "string" } },
                    "blocker_task_ids": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["repo_id", "prompt"]
            }
        },
        {
            "name": "kanna_send_task_input",
            "description": "Send input text to a Kanna task terminal session.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "input": { "type": "string" }
                },
                "required": ["task_id", "input"]
            }
        },
        {
            "name": "kanna_close_task",
            "description": "Close a Kanna task.",
            "inputSchema": {
                "type": "object",
                "properties": { "task_id": { "type": "string" } },
                "required": ["task_id"]
            }
        },
        {
            "name": "kanna_advance_stage",
            "description": "Advance a Kanna task to the next pipeline stage.",
            "inputSchema": {
                "type": "object",
                "properties": { "task_id": { "type": "string" } },
                "required": ["task_id"]
            }
        },
        {
            "name": "kanna_block_task",
            "description": "Mark a Kanna task as blocked by one or more tasks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "blocker_task_ids": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["task_id", "blocker_task_ids"]
            }
        },
        {
            "name": "kanna_unblock_task",
            "description": "Remove all blockers from a Kanna task.",
            "inputSchema": {
                "type": "object",
                "properties": { "task_id": { "type": "string" } },
                "required": ["task_id"]
            }
        },
        {
            "name": "kanna_complete_stage",
            "description": "Record completion for a Kanna pipeline stage.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "status": { "type": "string", "enum": ["success", "failure"] },
                    "summary": { "type": "string" },
                    "metadata": { "type": "object" }
                },
                "required": ["task_id", "status", "summary"]
            }
        },
        {
            "name": "kanna_request_revision",
            "description": "Create a revision task from an existing Kanna task branch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "target_stage": { "type": "string" },
                    "summary": { "type": "string" },
                    "prompt": { "type": "string" },
                    "metadata": { "type": "object" }
                },
                "required": ["task_id", "summary", "prompt"]
            }
        }
    ])
}

async fn handle_mcp_request(message: Value, base_url: &str) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return mcp_error(id, -32600, "missing method");
    };

    match method {
        "initialize" => mcp_response(
            id,
            serde_json::json!({
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "kanna-mcp",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        ),
        "notifications/initialized" => Value::Null,
        "tools/list" => mcp_response(id, serde_json::json!({ "tools": mcp_tools() })),
        "tools/call" => {
            let params = message
                .get("params")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return mcp_error(id, -32602, "missing tool name");
            };
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            match handle_mcp_tool_call(base_url, name, args).await {
                Ok(value) => mcp_response(
                    id,
                    serde_json::json!({
                        "content": [{
                            "type": "text",
                            "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
                        }]
                    }),
                ),
                Err(message) => mcp_error(id, mcp_tool_error_code(&message), message),
            }
        }
        _ => mcp_error(id, -32601, format!("unknown method: {method}")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ToolRequest {
    Get(String),
    GetText(String),
    PostJson {
        path: String,
        body: Value,
    },
    WaitTask {
        task_id: String,
        timeout_secs: u64,
        poll_secs: u64,
        until: WaitUntil,
    },
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

fn required_string(args: &Value, name: &str) -> Result<String, String> {
    args.get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing required argument: {name}"))
}

fn optional_string(args: &Value, name: &str) -> Option<String> {
    args.get(name).and_then(Value::as_str).map(str::to_string)
}

fn optional_u64(args: &Value, name: &str) -> Result<Option<u64>, String> {
    match args.get(name) {
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("{name} must be an unsigned integer")),
        None => Ok(None),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WaitUntil {
    Finished,
    Closed,
}

fn parse_wait_until(value: Option<String>) -> Result<WaitUntil, String> {
    match value.as_deref().unwrap_or("finished") {
        "finished" => Ok(WaitUntil::Finished),
        "closed" => Ok(WaitUntil::Closed),
        other => Err(format!("until must be finished or closed, got {other}")),
    }
}

fn task_matches_wait_until(task: &Value, until: WaitUntil) -> bool {
    let closed = task.get("closedAt").is_some_and(|value| !value.is_null());
    match until {
        WaitUntil::Finished => {
            closed || task.get("activity").and_then(Value::as_str) == Some("unread")
        }
        WaitUntil::Closed => closed,
    }
}

fn optional_string_array(args: &Value, name: &str) -> Result<Option<Vec<String>>, String> {
    let Some(value) = args.get(name) else {
        return Ok(None);
    };
    let Some(values) = value.as_array() else {
        return Err(format!("{name} must be an array of strings"));
    };
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{name} must be an array of strings"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn build_tool_request(name: &str, args: Value) -> Result<ToolRequest, String> {
    match name {
        "kanna_list_repos" => Ok(ToolRequest::Get("/v1/repos".to_string())),
        "kanna_add_repo" => {
            let mut body = serde_json::Map::new();
            body.insert(
                "path".to_string(),
                Value::String(required_string(&args, "path")?),
            );
            if let Some(name) = optional_string(&args, "name") {
                body.insert("name".to_string(), Value::String(name));
            }
            Ok(ToolRequest::PostJson {
                path: "/v1/repos".to_string(),
                body: Value::Object(body),
            })
        }
        "kanna_list_recent_tasks" => Ok(ToolRequest::Get("/v1/tasks/recent".to_string())),
        "kanna_get_task" => {
            let task_id = encode_path_segment(&required_string(&args, "task_id")?);
            Ok(ToolRequest::Get(format!("/v1/tasks/{task_id}")))
        }
        "kanna_wait_task" => {
            let task_id = required_string(&args, "task_id")?;
            let timeout_secs = optional_u64(&args, "timeout_secs")?.unwrap_or(600).min(600);
            let poll_secs = optional_u64(&args, "poll_secs")?.unwrap_or(3).max(1);
            let until = parse_wait_until(optional_string(&args, "until"))?;
            Ok(ToolRequest::WaitTask {
                task_id,
                timeout_secs,
                poll_secs,
                until,
            })
        }
        "kanna_task_logs" => {
            let task_id = encode_path_segment(&required_string(&args, "task_id")?);
            let path = match optional_u64(&args, "tail")? {
                Some(tail) => format!("/v1/tasks/{task_id}/logs?tail={tail}"),
                None => format!("/v1/tasks/{task_id}/logs"),
            };
            Ok(ToolRequest::GetText(path))
        }
        "kanna_search_tasks" => {
            let query = encode_path_segment(&required_string(&args, "query")?);
            Ok(ToolRequest::Get(format!("/v1/tasks/search?query={query}")))
        }
        "kanna_list_repo_tasks" => {
            let repo_id = encode_path_segment(&required_string(&args, "repo_id")?);
            Ok(ToolRequest::Get(format!("/v1/repos/{repo_id}/tasks")))
        }
        "kanna_create_task" => {
            let allowed_tools = optional_string_array(&args, "allowed_tools")?;
            let blocker_task_ids = optional_string_array(&args, "blocker_task_ids")?;
            let mut body = serde_json::Map::new();
            body.insert(
                "repoId".to_string(),
                Value::String(required_string(&args, "repo_id")?),
            );
            body.insert(
                "prompt".to_string(),
                Value::String(required_string(&args, "prompt")?),
            );
            for (arg_name, body_name) in [
                ("pipeline_name", "pipelineName"),
                ("base_ref", "baseRef"),
                ("stage", "stage"),
                ("agent_provider", "agentProvider"),
                ("model", "model"),
                ("permission_mode", "permissionMode"),
                ("notify_task_id", "notifyTaskId"),
            ] {
                if let Some(value) = optional_string(&args, arg_name) {
                    body.insert(body_name.to_string(), Value::String(value));
                }
            }
            if let Some(values) = allowed_tools {
                body.insert(
                    "allowedTools".to_string(),
                    Value::Array(values.into_iter().map(Value::String).collect()),
                );
            }
            if let Some(values) = blocker_task_ids {
                body.insert(
                    "blockerTaskIds".to_string(),
                    Value::Array(values.into_iter().map(Value::String).collect()),
                );
            }
            Ok(ToolRequest::PostJson {
                path: "/v1/tasks".to_string(),
                body: Value::Object(body),
            })
        }
        "kanna_send_task_input" => {
            let task_id = encode_path_segment(&required_string(&args, "task_id")?);
            let input = required_string(&args, "input")?;
            Ok(ToolRequest::PostJson {
                path: format!("/v1/tasks/{task_id}/input"),
                body: serde_json::json!({ "input": input }),
            })
        }
        "kanna_close_task" => {
            let task_id = encode_path_segment(&required_string(&args, "task_id")?);
            Ok(ToolRequest::PostJson {
                path: format!("/v1/tasks/{task_id}/actions/close"),
                body: serde_json::json!({}),
            })
        }
        "kanna_advance_stage" => {
            let task_id = encode_path_segment(&required_string(&args, "task_id")?);
            Ok(ToolRequest::PostJson {
                path: format!("/v1/tasks/{task_id}/actions/advance-stage"),
                body: serde_json::json!({}),
            })
        }
        "kanna_block_task" => {
            let task_id = encode_path_segment(&required_string(&args, "task_id")?);
            let blocker_task_ids = optional_string_array(&args, "blocker_task_ids")?
                .ok_or_else(|| "missing required argument: blocker_task_ids".to_string())?;
            Ok(ToolRequest::PostJson {
                path: format!("/v1/tasks/{task_id}/actions/block"),
                body: serde_json::json!({ "blockerTaskIds": blocker_task_ids }),
            })
        }
        "kanna_unblock_task" => {
            let task_id = encode_path_segment(&required_string(&args, "task_id")?);
            Ok(ToolRequest::PostJson {
                path: format!("/v1/tasks/{task_id}/actions/unblock"),
                body: serde_json::json!({}),
            })
        }
        "kanna_complete_stage" => {
            let task_id = encode_path_segment(&required_string(&args, "task_id")?);
            let status = required_string(&args, "status")?;
            if status != "success" && status != "failure" {
                return Err("status must be success or failure".to_string());
            }
            let mut body = serde_json::json!({
                "status": status,
                "summary": required_string(&args, "summary")?,
            });
            if let Some(metadata) = args.get("metadata").cloned() {
                body["metadata"] = metadata;
            }
            Ok(ToolRequest::PostJson {
                path: format!("/v1/tasks/{task_id}/actions/complete-stage"),
                body,
            })
        }
        "kanna_request_revision" => {
            let task_id = encode_path_segment(&required_string(&args, "task_id")?);
            let mut body = serde_json::json!({
                "targetStage": optional_string(&args, "target_stage").unwrap_or_else(|| "in progress".to_string()),
                "summary": required_string(&args, "summary")?,
                "prompt": required_string(&args, "prompt")?,
            });
            if let Some(metadata) = args.get("metadata").cloned() {
                body["metadata"] = metadata;
            }
            Ok(ToolRequest::PostJson {
                path: format!("/v1/tasks/{task_id}/actions/request-revision"),
                body,
            })
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn join_server_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

async fn get_json<T: DeserializeOwned>(base_url: &str, path: &str) -> Result<T, String> {
    let response = reqwest::Client::new()
        .get(join_server_url(base_url, path))
        .send()
        .await
        .map_err(|e| format!("GET {path} failed: {e}"))?;
    let status = response.status();
    let response = response
        .error_for_status()
        .map_err(|e| format!("GET {path} failed with status {status}: {e}"))?;
    response
        .json::<T>()
        .await
        .map_err(|e| format!("GET {path} returned invalid JSON: {e}"))
}

async fn get_text(base_url: &str, path: &str) -> Result<String, String> {
    let response = reqwest::Client::new()
        .get(join_server_url(base_url, path))
        .send()
        .await
        .map_err(|e| format!("GET {path} failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GET {path} failed with status {status}"));
    }
    response
        .text()
        .await
        .map_err(|e| format!("GET {path} returned invalid text: {e}"))
}

async fn wait_task(
    base_url: &str,
    task_id: &str,
    timeout_secs: u64,
    poll_secs: u64,
    until: WaitUntil,
) -> Result<Value, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let poll_interval = std::time::Duration::from_secs(poll_secs.max(1));
    let path = format!("/v1/tasks/{}", encode_path_segment(task_id));
    loop {
        let task: Value = get_json(base_url, &path).await?;
        if task_matches_wait_until(&task, until) {
            return Ok(task);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!("timed out waiting for task {task_id}"));
        }
        tokio::time::sleep(poll_interval).await;
    }
}

async fn post_json<T: DeserializeOwned>(
    base_url: &str,
    path: &str,
    body: &Value,
) -> Result<T, String> {
    let response = reqwest::Client::new()
        .post(join_server_url(base_url, path))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("POST {path} failed: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return serde_json::from_value(serde_json::json!({ "ok": true }))
            .map_err(|e| format!("failed to encode empty response: {e}"));
    }
    let response = response
        .error_for_status()
        .map_err(|e| format!("POST {path} failed with status {status}: {e}"))?;
    response
        .json::<T>()
        .await
        .map_err(|e| format!("POST {path} returned invalid JSON: {e}"))
}

async fn handle_mcp_tool_call(base_url: &str, name: &str, args: Value) -> Result<Value, String> {
    match build_tool_request(name, args)? {
        ToolRequest::Get(path) => get_json(base_url, &path).await,
        ToolRequest::GetText(path) => get_text(base_url, &path).await.map(Value::String),
        ToolRequest::PostJson { path, body } => post_json(base_url, &path, &body).await,
        ToolRequest::WaitTask {
            task_id,
            timeout_secs,
            poll_secs,
            until,
        } => wait_task(base_url, &task_id, timeout_secs, poll_secs, until).await,
    }
}

async fn handle_mcp_line(line: &str, base_url: &str) -> Result<Option<String>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let message: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("failed to parse MCP JSON-RPC message: {e}"))?;
    let response = handle_mcp_request(message, base_url).await;
    if response.is_null() {
        return Ok(None);
    }
    serde_json::to_string(&response)
        .map(Some)
        .map_err(|e| format!("failed to render MCP response: {e}"))
}

async fn serve_mcp(base_url: &str) -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("failed to read stdin: {e}"))?;
        if let Some(mut rendered) = handle_mcp_line(&line, base_url).await? {
            rendered.push('\n');
            stdout
                .write_all(rendered.as_bytes())
                .map_err(|e| format!("failed to write stdout: {e}"))?;
            stdout
                .flush()
                .map_err(|e| format!("failed to flush stdout: {e}"))?;
        }
    }
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Serve { server_url } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            if let Err(e) = serve_mcp(&base_url).await {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_explicit_server_url_before_env_or_default() {
        let env = [("KANNA_SERVER_BASE_URL", "http://127.0.0.1:9999")];

        assert_eq!(
            resolve_server_base_url(&env, Some("http://127.0.0.1:5555")),
            "http://127.0.0.1:5555"
        );
    }

    #[test]
    fn resolves_env_server_url_before_default() {
        let env = [("KANNA_SERVER_BASE_URL", "http://127.0.0.1:9999")];

        assert_eq!(resolve_server_base_url(&env, None), "http://127.0.0.1:9999");
    }

    #[test]
    fn falls_back_to_default_local_server_url() {
        let env: [(&str, &str); 0] = [];

        assert_eq!(resolve_server_base_url(&env, None), DEFAULT_SERVER_BASE_URL);
    }

    #[test]
    fn tool_list_contains_prefixed_kanna_tools() {
        let tools = mcp_tools();
        let names = tools
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "kanna_list_repos",
                "kanna_add_repo",
                "kanna_list_recent_tasks",
                "kanna_get_task",
                "kanna_wait_task",
                "kanna_task_logs",
                "kanna_search_tasks",
                "kanna_list_repo_tasks",
                "kanna_create_task",
                "kanna_send_task_input",
                "kanna_close_task",
                "kanna_advance_stage",
                "kanna_block_task",
                "kanna_unblock_task",
                "kanna_complete_stage",
                "kanna_request_revision",
            ]
        );
    }

    #[tokio::test]
    async fn initialize_advertises_kanna_mcp_server_info() {
        let response = handle_mcp_request(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize"
            }),
            "http://127.0.0.1:48120",
        )
        .await;

        assert_eq!(response["result"]["serverInfo"]["name"], "kanna-mcp");
        assert_eq!(response["result"]["capabilities"], json!({ "tools": {} }));
    }

    #[tokio::test]
    async fn missing_tool_name_returns_invalid_params() {
        let response = handle_mcp_request(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {}
            }),
            "http://127.0.0.1:48120",
        )
        .await;

        assert_eq!(response["error"]["code"], -32602);
        assert_eq!(response["error"]["message"], "missing tool name");
    }
}

#[cfg(test)]
mod route_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_expected_tool_requests() {
        assert_eq!(
            build_tool_request("kanna_list_repos", json!({})).unwrap(),
            ToolRequest::Get("/v1/repos".to_string())
        );
        assert_eq!(
            build_tool_request(
                "kanna_add_repo",
                json!({ "path": "/Users/me/project", "name": "Project" })
            )
            .unwrap(),
            ToolRequest::PostJson {
                path: "/v1/repos".to_string(),
                body: json!({
                    "path": "/Users/me/project",
                    "name": "Project"
                })
            }
        );
        assert_eq!(
            build_tool_request("kanna_list_recent_tasks", json!({})).unwrap(),
            ToolRequest::Get("/v1/tasks/recent".to_string())
        );
        assert_eq!(
            build_tool_request("kanna_get_task", json!({ "task_id": "task 1" })).unwrap(),
            ToolRequest::Get("/v1/tasks/task%201".to_string())
        );
        assert_eq!(
            build_tool_request(
                "kanna_wait_task",
                json!({ "task_id": "task 1", "timeout_secs": 5, "poll_secs": 1, "until": "closed" })
            )
            .unwrap(),
            ToolRequest::WaitTask {
                task_id: "task 1".to_string(),
                timeout_secs: 5,
                poll_secs: 1,
                until: WaitUntil::Closed,
            }
        );
        assert_eq!(
            build_tool_request(
                "kanna_task_logs",
                json!({ "task_id": "task 1", "tail": 25 })
            )
            .unwrap(),
            ToolRequest::GetText("/v1/tasks/task%201/logs?tail=25".to_string())
        );
        assert_eq!(
            build_tool_request("kanna_search_tasks", json!({ "query": "review me" })).unwrap(),
            ToolRequest::Get("/v1/tasks/search?query=review%20me".to_string())
        );
        assert_eq!(
            build_tool_request("kanna_list_repo_tasks", json!({ "repo_id": "repo-1" })).unwrap(),
            ToolRequest::Get("/v1/repos/repo-1/tasks".to_string())
        );
        assert_eq!(
            build_tool_request("kanna_close_task", json!({ "task_id": "task-1" })).unwrap(),
            ToolRequest::PostJson {
                path: "/v1/tasks/task-1/actions/close".to_string(),
                body: json!({})
            }
        );
        assert_eq!(
            build_tool_request(
                "kanna_create_task",
                json!({
                    "repo_id": "repo-1",
                    "prompt": "Blocked work",
                    "blocker_task_ids": ["blocker-1", "blocker-2"]
                })
            )
            .unwrap(),
            ToolRequest::PostJson {
                path: "/v1/tasks".to_string(),
                body: json!({
                    "repoId": "repo-1",
                    "prompt": "Blocked work",
                    "blockerTaskIds": ["blocker-1", "blocker-2"]
                })
            }
        );
        assert_eq!(
            build_tool_request(
                "kanna_block_task",
                json!({ "task_id": "task-1", "blocker_task_ids": ["blocker-1"] })
            )
            .unwrap(),
            ToolRequest::PostJson {
                path: "/v1/tasks/task-1/actions/block".to_string(),
                body: json!({ "blockerTaskIds": ["blocker-1"] })
            }
        );
        assert_eq!(
            build_tool_request("kanna_unblock_task", json!({ "task_id": "task-1" })).unwrap(),
            ToolRequest::PostJson {
                path: "/v1/tasks/task-1/actions/unblock".to_string(),
                body: json!({})
            }
        );
        assert_eq!(
            build_tool_request(
                "kanna_create_task",
                json!({
                    "repo_id": "repo-1",
                    "prompt": "Child",
                    "notify_task_id": "task-parent"
                })
            )
            .unwrap(),
            ToolRequest::PostJson {
                path: "/v1/tasks".to_string(),
                body: json!({
                    "repoId": "repo-1",
                    "prompt": "Child",
                    "notifyTaskId": "task-parent"
                })
            }
        );
    }

    #[test]
    fn validates_complete_stage_status() {
        assert_eq!(
            build_tool_request(
                "kanna_complete_stage",
                json!({ "task_id": "task-1", "status": "maybe", "summary": "done" })
            ),
            Err("status must be success or failure".to_string())
        );
    }

    #[test]
    fn rejects_missing_required_argument() {
        assert_eq!(
            build_tool_request("kanna_search_tasks", json!({})),
            Err("missing required argument: query".to_string())
        );
    }
}

#[cfg(test)]
mod stdio_tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn initialized_notification_produces_no_output_line() {
        let output = handle_mcp_line(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "http://127.0.0.1:48120",
        )
        .await
        .unwrap();

        assert_eq!(output, None);
    }

    #[tokio::test]
    async fn initialize_line_produces_json_response_line() {
        let output = handle_mcp_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"initialize"}"#,
            "http://127.0.0.1:48120",
        )
        .await
        .unwrap()
        .expect("response line");
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!(7));
        assert_eq!(parsed["result"]["serverInfo"]["name"], "kanna-mcp");
    }
}
