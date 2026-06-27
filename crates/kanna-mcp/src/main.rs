use clap::{Parser, Subcommand};
use kanna_tool_catalog::{
    encode_path_segment, load_catalog, resolve_request, Catalog, Method, ResolvedRequest,
    ResponseKind, WaitUntil,
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
                Err(message) => mcp_error(id, mcp_tool_error_code(&message), message),
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

async fn handle_mcp_tool_call(
    base_url: &str,
    catalog: &SharedCatalog,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    let request = {
        let catalog = catalog
            .read()
            .map_err(|_| "catalog lock poisoned".to_string())?;
        resolve_request(&catalog, name, &args)?
    };
    execute_resolved_request(base_url, request).await
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
                "kanna_task_logs",
                "kanna_search_tasks",
                "kanna_list_repo_tasks",
                "kanna_create_task",
                "kanna_send_task_input",
                "kanna_close_task",
                "kanna_rename_task",
                "kanna_advance_stage",
                "kanna_block_task",
                "kanna_unblock_task",
                "kanna_set_task_parent",
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
