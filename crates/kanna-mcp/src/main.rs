use clap::{Parser, Subcommand};
use kanna_tool_catalog::{
    clamp_wait_timeout_secs, encode_path_segment, load_catalog, resolve_request,
    wait_resolved_result, wait_timeout_result, Catalog, Method, ResolvedRequest, ResponseKind,
    WaitUntil,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::env;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime};

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

/// Tool execution failures are returned as `isError` tool results rather than
/// JSON-RPC errors so the calling agent reliably sees the message in-band and
/// can self-correct. Only requests that never reached a tool (missing or
/// unknown tool name) stay protocol-level errors, per the MCP spec.
fn mcp_tool_error_result(id: Value, message: String) -> Value {
    mcp_response(
        id,
        serde_json::json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true
        }),
    )
}

type SharedCatalog = Arc<RwLock<Catalog>>;

async fn handle_mcp_request(message: Value, base_url: &str, catalog: &SharedCatalog) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return mcp_error(id, -32600, "missing method");
    };

    match method {
        "initialize" => mcp_response(
            id,
            serde_json::json!({
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": { "listChanged": true } },
                "serverInfo": {
                    "name": "kanna-mcp",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        ),
        "notifications/initialized" => Value::Null,
        "tools/list" => match catalog.read() {
            Ok(catalog) => mcp_response(
                id,
                serde_json::json!({ "tools": catalog.tools_list_value() }),
            ),
            Err(_) => mcp_error(id, -32603, "catalog lock poisoned"),
        },
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
            match handle_mcp_tool_call(base_url, catalog, name, args).await {
                Ok(value) => mcp_response(
                    id,
                    serde_json::json!({
                        "content": [{
                            "type": "text",
                            "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
                        }]
                    }),
                ),
                Err(message) if message.starts_with("unknown tool:") => {
                    mcp_error(id, -32602, message)
                }
                Err(message) => mcp_tool_error_result(id, message),
            }
        }
        _ => mcp_error(id, -32601, format!("unknown method: {method}")),
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

fn join_server_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

/// Surface the response body on HTTP errors — the server puts its actual
/// error message there, and a bare status code is undiagnosable for agents.
async fn require_success(
    method: &str,
    path: &str,
    response: reqwest::Response,
) -> Result<reqwest::Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response
        .text()
        .await
        .unwrap_or_else(|e| format!("failed to read error body: {e}"));
    Err(format!(
        "{method} {path} failed with status {status}: {body}"
    ))
}

async fn get_json<T: DeserializeOwned>(base_url: &str, path: &str) -> Result<T, String> {
    let response = reqwest::Client::new()
        .get(join_server_url(base_url, path))
        .send()
        .await
        .map_err(|e| format!("GET {path} failed: {e}"))?;
    let response = require_success("GET", path, response).await?;
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
    let response = require_success("GET", path, response).await?;
    response
        .text()
        .await
        .map_err(|e| format!("GET {path} returned invalid text: {e}"))
}

/// Waits are bounded by `clamp_wait_timeout_secs` and hand back the task's
/// latest detail when the window elapses, so the answer always reaches the
/// agent inside its client's tools/call budget instead of being killed there.
async fn wait_task(
    base_url: &str,
    task_id: &str,
    timeout_secs: u64,
    poll_secs: u64,
    until: WaitUntil,
) -> Result<Value, String> {
    let timeout_secs = clamp_wait_timeout_secs(timeout_secs);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    let poll_interval = Duration::from_secs(poll_secs.max(1));
    let path = format!("/v1/tasks/{}", encode_path_segment(task_id));
    loop {
        let task: Value = get_json(base_url, &path).await?;
        if task_matches_wait_until(&task, until) {
            return Ok(wait_resolved_result(task));
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(wait_timeout_result(task, task_id, timeout_secs));
        }
        // Never sleep past the deadline: the window is a promise to the client,
        // not a floor rounded up to the next poll.
        tokio::time::sleep(poll_interval.min(deadline - now)).await;
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
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return serde_json::from_value(serde_json::json!({ "ok": true }))
            .map_err(|e| format!("failed to encode empty response: {e}"));
    }
    let response = require_success("POST", path, response).await?;
    response
        .json::<T>()
        .await
        .map_err(|e| format!("POST {path} returned invalid JSON: {e}"))
}

async fn handle_mcp_tool_call(
    base_url: &str,
    catalog: &SharedCatalog,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    let args = maybe_augment_create_task_args(base_url, name, args).await?;
    let request = {
        let catalog = catalog
            .read()
            .map_err(|_| "catalog lock poisoned".to_string())?;
        resolve_request(&catalog, name, &args)?
    };
    execute_resolved_request(base_url, request).await
}

async fn maybe_augment_create_task_args(
    base_url: &str,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    if name != "kanna_create_task" || args.get("repo_id").is_some() {
        return Ok(args);
    }

    let task_id = env::var("KANNA_TASK_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "repo_id is required when KANNA_TASK_ID is not available".to_string())?;
    let path = format!("/v1/tasks/{}", encode_path_segment(&task_id));
    let current_task: Value = get_json(base_url, &path)
        .await
        .map_err(|e| format!("failed to infer repo_id from KANNA_TASK_ID={task_id}: {e}"))?;
    augment_create_task_args(args, Some(&current_task))
}

fn augment_create_task_args(args: Value, current_task: Option<&Value>) -> Result<Value, String> {
    if args.get("repo_id").is_some() {
        return Ok(args);
    }

    let repo_id = current_task
        .and_then(|task| task.get("repoId").or_else(|| task.get("repo_id")))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "repo_id is required when KANNA_TASK_ID is not available".to_string())?;
    let mut args_object = args
        .as_object()
        .cloned()
        .ok_or_else(|| "tool arguments must be a JSON object".to_string())?;
    args_object.insert("repo_id".to_string(), Value::String(repo_id.to_string()));
    Ok(Value::Object(args_object))
}

async fn execute_resolved_request(
    base_url: &str,
    request: ResolvedRequest,
) -> Result<Value, String> {
    match (request.method, request.kind) {
        (Method::Get, ResponseKind::Json) => get_json(base_url, &request.path).await,
        (Method::Get, ResponseKind::Text) => {
            get_text(base_url, &request.path).await.map(Value::String)
        }
        (Method::Post, ResponseKind::Json) => {
            post_json(base_url, &request.path, &request.body).await
        }
        (_, ResponseKind::Wait) => {
            let wait = request
                .wait
                .ok_or_else(|| "wait request missing wait spec".to_string())?;
            wait_task(
                base_url,
                &wait.task_id,
                wait.timeout_secs,
                wait.poll_secs,
                wait.until,
            )
            .await
        }
        _ => Err(format!(
            "unsupported tool request: {:?} {:?}",
            request.method, request.kind
        )),
    }
}

fn catalog_watch_path(cwd: &Path) -> PathBuf {
    env::var_os("KANNA_MCP_CATALOG")
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.join(".kanna/mcp-tools.json"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CatalogWatchState {
    exists: bool,
    modified: Option<SystemTime>,
}

fn catalog_watch_state(path: &Path) -> CatalogWatchState {
    match std::fs::metadata(path).and_then(|metadata| metadata.modified()) {
        Ok(modified) => CatalogWatchState {
            exists: true,
            modified: Some(modified),
        },
        Err(_) => CatalogWatchState {
            exists: false,
            modified: None,
        },
    }
}

fn render_tools_list_changed_notification() -> Result<String, String> {
    let mut rendered = serde_json::to_string(&serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/tools/list_changed"
    }))
    .map_err(|e| format!("failed to render catalog reload notification: {e}"))?;
    rendered.push('\n');
    Ok(rendered)
}

fn write_line<W: Write>(stdout: &Arc<Mutex<W>>, line: &str) -> Result<(), String> {
    let mut stdout = stdout
        .lock()
        .map_err(|_| "stdout lock poisoned".to_string())?;
    stdout
        .write_all(line.as_bytes())
        .map_err(|e| format!("failed to write stdout: {e}"))?;
    stdout
        .flush()
        .map_err(|e| format!("failed to flush stdout: {e}"))
}

fn poll_catalog_reload<W: Write>(
    cwd: &Path,
    watch_path: &Path,
    catalog: &SharedCatalog,
    stdout: &Arc<Mutex<W>>,
    state: &mut CatalogWatchState,
) -> Result<(), String> {
    let next_state = catalog_watch_state(watch_path);
    if *state == next_state {
        return Ok(());
    }
    *state = next_state;

    let loaded = load_catalog(cwd);
    if let Some(warning) = loaded.warning {
        eprintln!("Warning: {warning}");
    }
    {
        let mut catalog_guard = catalog
            .write()
            .map_err(|_| "catalog lock poisoned".to_string())?;
        *catalog_guard = loaded.catalog;
    }
    write_line(stdout, &render_tools_list_changed_notification()?)
}

fn spawn_catalog_watcher<W>(
    cwd: PathBuf,
    catalog: SharedCatalog,
    stdout: Arc<Mutex<W>>,
) -> std::thread::JoinHandle<()>
where
    W: Write + Send + 'static,
{
    let watch_path = catalog_watch_path(&cwd);
    std::thread::spawn(move || {
        let mut state = catalog_watch_state(&watch_path);
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if let Err(e) = poll_catalog_reload(&cwd, &watch_path, &catalog, &stdout, &mut state) {
                eprintln!("Warning: catalog reload failed: {e}");
            }
        }
    })
}

#[cfg(test)]
fn shared_bundled_catalog() -> SharedCatalog {
    Arc::new(RwLock::new(kanna_tool_catalog::bundled_catalog()))
}

async fn handle_mcp_line(
    line: &str,
    base_url: &str,
    catalog: &SharedCatalog,
) -> Result<Option<String>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let message: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("failed to parse MCP JSON-RPC message: {e}"))?;
    let response = handle_mcp_request(message, base_url, catalog).await;
    if response.is_null() {
        return Ok(None);
    }
    serde_json::to_string(&response)
        .map(Some)
        .map_err(|e| format!("failed to render MCP response: {e}"))
}

async fn serve_mcp(base_url: &str, cwd: &Path) -> Result<(), String> {
    let loaded = load_catalog(cwd);
    if let Some(warning) = loaded.warning {
        eprintln!("Warning: {warning}");
    }
    let catalog = Arc::new(RwLock::new(loaded.catalog));
    let stdin = std::io::stdin();
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let _watcher = spawn_catalog_watcher(cwd.to_path_buf(), catalog.clone(), stdout.clone());
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("failed to read stdin: {e}"))?;
        if let Some(mut rendered) = handle_mcp_line(&line, base_url, &catalog).await? {
            rendered.push('\n');
            write_line(&stdout, &rendered)?;
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
            let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            if let Err(e) = serve_mcp(&base_url, &cwd).await {
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
        let tools = kanna_tool_catalog::bundled_catalog().tools_list_value();
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
                "kanna_wait_events",
                "kanna_set_task_notify",
                "kanna_task_logs",
                "kanna_search_tasks",
                "kanna_list_repo_tasks",
                "kanna_list_agents",
                "kanna_create_task",
                "kanna_signal_agent",
                "kanna_send_task_input",
                "kanna_close_task",
                "kanna_rename_task",
                "kanna_advance_stage",
                "kanna_rerun_stage",
                "kanna_block_task",
                "kanna_unblock_task",
                "kanna_set_task_parent",
                "kanna_is_dependent_tasks_exist",
                "kanna_complete_stage",
                "kanna_request_revision",
            ]
        );
    }

    #[tokio::test]
    async fn initialize_advertises_kanna_mcp_server_info() {
        let catalog = shared_bundled_catalog();
        let response = handle_mcp_request(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize"
            }),
            "http://127.0.0.1:48120",
            &catalog,
        )
        .await;

        assert_eq!(response["result"]["serverInfo"]["name"], "kanna-mcp");
        assert_eq!(
            response["result"]["capabilities"],
            json!({ "tools": { "listChanged": true } })
        );
    }

    #[tokio::test]
    async fn missing_tool_name_returns_invalid_params() {
        let catalog = shared_bundled_catalog();
        let response = handle_mcp_request(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {}
            }),
            "http://127.0.0.1:48120",
            &catalog,
        )
        .await;

        assert_eq!(response["error"]["code"], -32602);
        assert_eq!(response["error"]["message"], "missing tool name");
    }

    #[tokio::test]
    async fn unknown_tool_returns_protocol_error_listing_available_tools() {
        let catalog = shared_bundled_catalog();
        let response = handle_mcp_request(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": { "name": "kanna_nonexistent", "arguments": {} }
            }),
            "http://127.0.0.1:48120",
            &catalog,
        )
        .await;

        assert_eq!(response["error"]["code"], -32602);
        let message = response["error"]["message"].as_str().expect("message");
        assert!(message.starts_with("unknown tool: kanna_nonexistent"));
        assert!(message.contains("kanna_list_repos"));
    }

    #[tokio::test]
    async fn tool_argument_errors_are_is_error_tool_results() {
        let catalog = shared_bundled_catalog();
        let response = handle_mcp_request(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": { "name": "kanna_search_tasks", "arguments": {} }
            }),
            "http://127.0.0.1:48120",
            &catalog,
        )
        .await;

        assert!(response.get("error").is_none());
        assert_eq!(response["result"]["isError"], json!(true));
        assert_eq!(
            response["result"]["content"][0]["text"],
            "missing required argument: query"
        );
    }

    #[test]
    fn create_task_args_can_infer_repo_id_from_current_task() {
        let args = json!({ "prompt": "Spin up a child task" });
        let current_task = json!({ "id": "task-1", "repoId": "repo-1" });

        let augmented = augment_create_task_args(args, Some(&current_task)).unwrap();

        assert_eq!(
            augmented,
            json!({ "prompt": "Spin up a child task", "repo_id": "repo-1" })
        );
    }

    #[test]
    fn explicit_create_task_repo_id_is_not_replaced() {
        let args = json!({ "repo_id": "repo-explicit", "prompt": "Spin up a child task" });
        let current_task = json!({ "id": "task-1", "repoId": "repo-current" });

        let augmented = augment_create_task_args(args.clone(), Some(&current_task)).unwrap();

        assert_eq!(augmented, args);
    }

    #[test]
    fn create_task_without_repo_id_requires_current_task_context() {
        let err = augment_create_task_args(json!({ "prompt": "Spin up a child task" }), None)
            .expect_err("missing current task should fail");

        assert_eq!(
            err,
            "repo_id is required when KANNA_TASK_ID is not available".to_string()
        );
    }

    #[test]
    fn catalog_reload_swaps_tools_and_emits_notification_line() {
        let root = env::temp_dir().join(format!("kanna-mcp-reload-test-{}", process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".kanna")).unwrap();
        let watch_path = root.join(".kanna/mcp-tools.json");
        let catalog = shared_bundled_catalog();
        let stdout = Arc::new(Mutex::new(Vec::<u8>::new()));
        let mut state = catalog_watch_state(&watch_path);

        std::fs::write(
            &watch_path,
            r#"{
              "tools": [{
                "name": "kanna_custom_ping",
                "description": "Custom ping",
                "method": "GET",
                "path": "/v1/ping",
                "response": "json",
                "params": []
              }]
            }"#,
        )
        .unwrap();

        poll_catalog_reload(&root, &watch_path, &catalog, &stdout, &mut state).unwrap();

        let tools = catalog.read().unwrap().tools_list_value();
        assert_eq!(tools[0]["name"], json!("kanna_custom_ping"));
        let output = String::from_utf8(stdout.lock().unwrap().clone()).unwrap();
        assert_eq!(
            output,
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}

/// Waiting crosses the agent → MCP client → kanna-mcp → desktop server
/// boundary, and the failure it is guarded against is client-side: a wait
/// longer than the client's tools/call budget is killed before it can answer,
/// and the agent loses the result. These tests drive the real stdio JSON-RPC
/// surface against a real HTTP server so the catalog defaults, the wait loop,
/// and the tool-result envelope are all exercised together.
#[cfg(test)]
mod wait_tests {
    use super::*;
    use kanna_tool_catalog::{CLIENT_TOOL_CALL_BUDGET_SECS, DEFAULT_WAIT_TIMEOUT_SECS};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn running_task() -> Value {
        json!({
            "id": "child-1",
            "repoId": "repo-1",
            "title": "Specialty review",
            "stage": "review",
            "branch": "task-child-1",
            "activity": "running",
            "closedAt": null
        })
    }

    fn finished_task() -> Value {
        let mut task = running_task();
        task["activity"] = json!("unread");
        task
    }

    /// Serves `GET /v1/tasks/{id}` from a mutable body, so a test can flip a
    /// child task from running to finished between waits the way the desktop
    /// server does.
    async fn spawn_task_detail_server(state: Arc<Mutex<Value>>) -> (String, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind task detail server");
        let addr = listener.local_addr().expect("local addr");
        let polls = Arc::new(AtomicUsize::new(0));
        let served = polls.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buffer = vec![0u8; 4096];
                if socket.read(&mut buffer).await.is_err() {
                    continue;
                }
                served.fetch_add(1, Ordering::SeqCst);
                let body = match state.lock() {
                    Ok(state) => state.to_string(),
                    Err(_) => return,
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        (format!("http://{addr}"), polls)
    }

    fn wait_call_line(arguments: Value) -> String {
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": "kanna_wait_task", "arguments": arguments }
        })
        .to_string()
    }

    async fn call_wait(base_url: &str, catalog: &SharedCatalog, arguments: Value) -> Value {
        let line = handle_mcp_line(&wait_call_line(arguments), base_url, catalog)
            .await
            .expect("wait call handled")
            .expect("wait call response line");
        let parsed: Value = serde_json::from_str(&line).expect("json-rpc response");
        assert!(parsed.get("error").is_none(), "{parsed}");
        let text = parsed["result"]["content"][0]["text"]
            .as_str()
            .expect("tool result text")
            .to_string();
        assert!(
            parsed["result"]["isError"] != json!(true),
            "wait should not be an error tool result: {text}"
        );
        serde_json::from_str(&text).expect("tool result json")
    }

    #[tokio::test(start_paused = true)]
    async fn default_wait_answers_inside_the_client_tool_call_budget() {
        let (base_url, polls) =
            spawn_task_detail_server(Arc::new(Mutex::new(running_task()))).await;
        let catalog = shared_bundled_catalog();

        let started = tokio::time::Instant::now();
        let result = call_wait(&base_url, &catalog, json!({ "task_id": "child-1" })).await;
        let waited = started.elapsed();

        assert!(
            waited.as_secs() <= CLIENT_TOOL_CALL_BUDGET_SECS,
            "a default wait ran {}s; MCP clients abort tools/call at {CLIENT_TOOL_CALL_BUDGET_SECS}s and the agent loses the result",
            waited.as_secs()
        );
        assert_eq!(result["waitOutcome"], json!("timeout"));
        assert_eq!(result["waitTimeoutSecs"], json!(DEFAULT_WAIT_TIMEOUT_SECS));
        assert_eq!(result["id"], json!("child-1"));
        assert!(
            polls.load(Ordering::SeqCst) >= 2,
            "the wait should keep polling the task while it waits"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_wait_resumes_on_the_next_call_without_losing_task_state() {
        let state = Arc::new(Mutex::new(running_task()));
        let (base_url, _) = spawn_task_detail_server(state.clone()).await;
        let catalog = shared_bundled_catalog();
        let arguments = json!({ "task_id": "child-1", "timeout_secs": 5, "poll_secs": 1 });

        let first = call_wait(&base_url, &catalog, arguments.clone()).await;

        assert_eq!(first["waitOutcome"], json!("timeout"));
        assert_eq!(first["waitTimeoutSecs"], json!(5));
        assert_eq!(first["stage"], json!("review"));
        assert_eq!(first["branch"], json!("task-child-1"));
        assert_eq!(first["activity"], json!("running"));
        assert!(first["waitHint"]
            .as_str()
            .is_some_and(|hint| hint.contains("call kanna_wait_task again")));

        *state.lock().expect("state lock") = finished_task();
        let second = call_wait(&base_url, &catalog, arguments).await;

        assert_eq!(second["waitOutcome"], json!("resolved"));
        assert_eq!(second["id"], json!("child-1"));
        assert_eq!(second["stage"], json!("review"));
        assert_eq!(second["activity"], json!("unread"));
        assert!(second["waitHint"].is_null());
    }

    #[tokio::test(start_paused = true)]
    async fn oversized_timeout_arguments_are_clamped_to_the_survivable_window() {
        let (base_url, _) = spawn_task_detail_server(Arc::new(Mutex::new(running_task()))).await;
        let catalog = shared_bundled_catalog();

        let started = tokio::time::Instant::now();
        let result = call_wait(
            &base_url,
            &catalog,
            json!({ "task_id": "child-1", "timeout_secs": 600, "poll_secs": 3 }),
        )
        .await;
        let waited = started.elapsed();

        assert_eq!(result["waitOutcome"], json!("timeout"));
        assert_eq!(result["waitTimeoutSecs"], json!(DEFAULT_WAIT_TIMEOUT_SECS));
        assert!(
            waited.as_secs() <= CLIENT_TOOL_CALL_BUDGET_SECS,
            "an agent asking for 600s must still get an answer inside its client's budget"
        );
    }
}

#[cfg(test)]
mod stdio_tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn initialized_notification_produces_no_output_line() {
        let catalog = shared_bundled_catalog();
        let output = handle_mcp_line(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "http://127.0.0.1:48120",
            &catalog,
        )
        .await
        .unwrap();

        assert_eq!(output, None);
    }

    #[tokio::test]
    async fn initialize_line_produces_json_response_line() {
        let catalog = shared_bundled_catalog();
        let output = handle_mcp_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"initialize"}"#,
            "http://127.0.0.1:48120",
            &catalog,
        )
        .await
        .unwrap()
        .expect("response line");
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!(7));
        assert_eq!(parsed["result"]["serverInfo"]["name"], "kanna-mcp");
    }
}
