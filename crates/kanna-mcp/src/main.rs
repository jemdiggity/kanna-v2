use base64::Engine;
use clap::{Parser, Subcommand};
use kanna_tool_catalog::{
    clamp_wait_timeout_secs, encode_path_segment, load_catalog, resolve_request,
    runtime_info_snapshot, task_value_matches_wait_until, wait_match_is_database_fact,
    wait_resolved_result, wait_timeout_result, Catalog, Method, ResolvedRequest, ResponseKind,
    RuntimeAdapterIdentity, WaitUntil, DEFAULT_WAIT_TIMEOUT_SECS,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::env;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime};

const DEFAULT_SERVER_BASE_URL: &str = "http://127.0.0.1:48120";
const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
const MULTI_MACHINE_CURSOR_PREFIX: &str = "km1.";
const MAX_MULTI_MACHINE_CURSOR_LEN: usize = 64 * 1024;
const MULTI_MACHINE_WAIT_SESSION_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MultiMachineCursor {
    local_machine_id: String,
    task_ids_by_machine: BTreeMap<String, Vec<String>>,
    cursors_by_machine: BTreeMap<String, String>,
}

struct MachineWaitCompletion {
    machine_id: String,
    result: Result<Value, String>,
}

struct MultiMachineWaitSession {
    cursor: MultiMachineCursor,
    pending: tokio::task::JoinSet<MachineWaitCompletion>,
    pending_machines: HashSet<String>,
    last_touched: tokio::time::Instant,
}

#[derive(Default)]
struct MultiMachineWaitRegistry {
    sessions: HashMap<String, MultiMachineWaitSession>,
}

type SharedMultiMachineWaits = Arc<Mutex<MultiMachineWaitRegistry>>;

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

fn mcp_tools_list_value(catalog: &Catalog) -> Value {
    catalog.tools_list_value()
}

async fn handle_mcp_request(
    message: Value,
    base_url: &str,
    catalog: &SharedCatalog,
    multi_machine_waits: &SharedMultiMachineWaits,
) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return mcp_error(id, -32600, "missing method");
    };

    match method {
        "initialize" => mcp_response(
            id,
            serde_json::json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
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
                serde_json::json!({ "tools": mcp_tools_list_value(&catalog) }),
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
            match handle_mcp_tool_call(base_url, catalog, multi_machine_waits, name, args).await {
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

/// How long a stopped-looking `activity` sample has to survive before this
/// layer reports it.
///
/// The daemon classifies each rendered terminal frame on its own — no
/// hysteresis, no dwell, no memory of the previous frame (see
/// `claude_status_from_lines` in `crates/daemon/src/headless_terminal.rs`). Busy
/// hangs off the literal "esc to interrupt" marker being present in that one
/// frame, so a frame captured mid-redraw can drop it, fall through to the
/// trailing-prompt test, and classify a mid-turn agent as idle. That verdict
/// reaches this layer as a task whose `activity` flipped to a stopped-looking
/// value for a single detection window, and an orchestrator polling `activity`
/// to decide whether an agent stopped acts on it.
///
/// The daemon re-classifies at most every `STATUS_DETECTION_THROTTLE_MS` (500ms
/// in `crates/daemon/src/session.rs`), and flushes a quiet-session status on the
/// same interval, so a misread is corrected within one throttle window whether
/// or not the session is producing output. Waiting two windows means the confirm
/// read sees a *fresh* classification rather than the same frame's verdict read
/// twice.
const ACTIVITY_CONFIRM_DELAY: Duration = Duration::from_millis(1_000);

/// `activity` values an orchestrator can read as "this agent is no longer
/// working".
///
/// `unread` is not itself a liveness claim — it means output nobody has read
/// yet, and a busy agent can carry it — but both of these are what the daemon's
/// per-frame verdict turns `working` into when the busy marker goes missing, so
/// both are worth confirming. Confirming preserves the vocabulary: the confirm
/// read reports whatever it finds, and never rewrites one value into another.
fn activity_looks_stopped(task: &Value) -> bool {
    matches!(
        task.get("activity").and_then(Value::as_str),
        Some("idle" | "unread")
    )
}

fn task_is_closed(task: &Value) -> bool {
    task.get("closedAt").is_some_and(|value| !value.is_null())
}

/// A closed task is stopped as a matter of record rather than of frame
/// classification, so it never needs confirming.
fn task_looks_stopped(task: &Value) -> bool {
    !task_is_closed(task) && activity_looks_stopped(task)
}

/// Whether a response carries at least one task that reads as stopped.
///
/// Both shapes the catalog's GET routes produce are covered: the single task
/// detail behind `kanna_get_task`, and the `TaskSummary` arrays behind
/// `kanna_list_recent_tasks`, `kanna_search_tasks`, and
/// `kanna_list_repo_tasks`. A list is exactly as capable of carrying a
/// mid-redraw misread as a detail read is, and an orchestrator that lists its
/// children to see which ones are still going would act on it the same way.
fn response_looks_stopped(value: &Value) -> bool {
    match value {
        Value::Array(tasks) => tasks.iter().any(task_looks_stopped),
        _ => task_looks_stopped(value),
    }
}

/// Confirms a stopped-looking response by re-reading the same route once, after
/// the daemon has had time to classify a fresh frame, and returns the fresher
/// response.
///
/// The smoothing is deliberately one-sided. A response with nothing
/// stopped-looking in it is returned immediately: a busy sample is never the
/// misread this guards against, and delaying it would buy nothing.
///
/// Cost, when the confirmation does fire: `ACTIVITY_CONFIRM_DELAY` plus exactly
/// one extra `GET` of the same route — one re-read for the whole response, not
/// one per task, so a 200-task listing costs the same as a single detail read.
/// For `kanna_get_task` that is paid only when the task being asked about
/// already looked stopped. For the three list routes it is paid whenever *any*
/// task in the response looks stopped, which is the common case for a repo
/// listing, so those tools should be budgeted at roughly +1s per call.
///
/// A failed confirmation is not a confirmation. Rather than fall back to the
/// unconfirmed first sample — which would surface the exact false stop this
/// exists to suppress — the tool call fails, and the agent can call again.
async fn confirm_stopped_activity(
    base_url: &str,
    path: &str,
    value: Value,
    machine_id: Option<&str>,
) -> Result<Value, String> {
    if !response_looks_stopped(&value) {
        return Ok(value);
    }
    tokio::time::sleep(ACTIVITY_CONFIRM_DELAY).await;
    get_routed_json(base_url, path, machine_id)
        .await
        .map_err(|error| {
            format!(
            "a task read as stopped and the confirming re-read of {path} failed, so it was not \
             reported: {error}. kanna-mcp never reports a stop it could not confirm, because the \
             daemon's per-frame classifier can report a working agent as idle for one frame. \
             Call the tool again."
        )
        })
}

/// The wait predicate lives in `kanna-tool-catalog` so this adapter, the typed
/// `kanna-cli` wait, and the catalog-driven `kanna-cli` wait cannot drift apart
/// again. See `task_state_matches_wait_until` for why a terminal `stage_run`,
/// not `activity`, decides `Finished`.
fn task_matches_wait_until(task: &Value, until: WaitUntil) -> bool {
    task_value_matches_wait_until(task, until)
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
    // A 404 with no body is axum's "no such route", not the server's "no such
    // task" — the latter always carries a message. That distinction is the only
    // thing separating "this server is too old to serve this tool" from an
    // ordinary not-found, and an agent whose instructions mandate the tool has
    // to be able to tell them apart: silently reading a route-level 404 as an
    // empty answer is how a fan-out records "no children" for a server it could
    // not ask.
    if status == reqwest::StatusCode::NOT_FOUND && body.trim().is_empty() {
        return Err(format!(
            "{method} {path} returned 404 with no body, which means this server does not serve \
             that route at all — it is older than the tool catalog this client exposes. This is \
             NOT an empty result: do not record it as one. Call kanna_info and read agentApi for \
             the tools this server is missing."
        ));
    }
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

/// Runtime introspection must return connection metadata even when status is
/// unavailable, and must not echo an arbitrary HTTP error body. The shared
/// catalog sanitizer handles the successful JSON body.
async fn get_runtime_status(base_url: &str, path: &str) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .get(join_server_url(base_url, path))
        .send()
        .await
        .map_err(|error| {
            format!(
                "GET {path} failed to reach the configured server: {}",
                error.without_url()
            )
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "GET {path} failed with status {}",
            response.status()
        ));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("GET {path} returned invalid JSON: {}", error.without_url()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineInvokeResponse {
    status: u16,
    body: Option<Value>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineListResponse {
    current_machine_id: String,
    relay_available: bool,
    machines: Vec<MachineDescriptor>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct MachineDescriptor {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalMachineIdentity {
    desktop_id: String,
}

async fn resolve_remote_machine_id(
    base_url: &str,
    machine_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(machine_id) = machine_id else {
        return Ok(None);
    };
    let identity: LocalMachineIdentity = get_json(base_url, "/v1/status").await?;
    Ok((machine_id != identity.desktop_id).then(|| machine_id.to_string()))
}

fn method_name(method: Method) -> &'static str {
    match method {
        Method::Get => "GET",
        Method::Post => "POST",
        Method::Patch => "PATCH",
    }
}

async fn invoke_machine(
    base_url: &str,
    machine_id: &str,
    method: Method,
    path: &str,
    body: &Value,
) -> Result<Value, String> {
    let response = invoke_machine_response(base_url, machine_id, method, path, body).await?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "{} {} on machine {} failed with status {}: {}",
            method_name(method),
            path,
            machine_id,
            response.status,
            response.error.unwrap_or_else(|| response
                .body
                .as_ref()
                .map(Value::to_string)
                .unwrap_or_default())
        ));
    }
    Ok(response.body.unwrap_or(Value::Null))
}

async fn invoke_machine_response(
    base_url: &str,
    machine_id: &str,
    method: Method,
    path: &str,
    body: &Value,
) -> Result<MachineInvokeResponse, String> {
    let proxy_path = format!(
        "/v1/cloud/desktops/{}/invoke",
        encode_path_segment(machine_id)
    );
    let response: MachineInvokeResponse = post_json(
        base_url,
        &proxy_path,
        &serde_json::json!({
            "method": method_name(method),
            "path": path,
            "body": body,
        }),
    )
    .await?;
    Ok(response)
}

async fn get_routed_json(
    base_url: &str,
    path: &str,
    machine_id: Option<&str>,
) -> Result<Value, String> {
    match machine_id {
        Some(machine_id) => {
            invoke_machine(base_url, machine_id, Method::Get, path, &Value::Null).await
        }
        None => get_json(base_url, path).await,
    }
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
    machine_id: Option<&str>,
) -> Result<Value, String> {
    let timeout_secs = clamp_wait_timeout_secs(timeout_secs);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    let poll_interval = Duration::from_secs(poll_secs.max(1));
    let path = format!("/v1/tasks/{}", encode_path_segment(task_id));
    loop {
        let task = get_routed_json(base_url, &path, machine_id).await?;
        // A match resting on a database fact — the task is closed, or its latest
        // `stage_run` reached a terminal status — resolves immediately: there is
        // no per-frame verdict to misread, and making it depend on a confirming
        // re-read would let a transient GET failure fail a wait whose answer was
        // already recorded. A match read off `activity` alone is still confirmed
        // exactly like a task read before the caller is told its child stopped:
        // if the stop does not hold, the fresher sample keeps the wait running;
        // if it cannot be confirmed at all, the `?` fails the call rather than
        // resolving the wait on an unconfirmed stop.
        let task = if task_matches_wait_until(&task, until) {
            if wait_match_is_database_fact(&task) {
                return Ok(wait_resolved_result(task));
            }
            let task = confirm_stopped_activity(base_url, &path, task, machine_id).await?;
            if task_matches_wait_until(&task, until) {
                return Ok(wait_resolved_result(task));
            }
            task
        } else {
            task
        };
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

async fn patch_json<T: DeserializeOwned>(
    base_url: &str,
    path: &str,
    body: &Value,
) -> Result<T, String> {
    let response = reqwest::Client::new()
        .patch(join_server_url(base_url, path))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("PATCH {path} failed: {e}"))?;
    let response = require_success("PATCH", path, response).await?;
    response
        .json::<T>()
        .await
        .map_err(|e| format!("PATCH {path} returned invalid JSON: {e}"))
}

fn encode_multi_machine_cursor(cursor: &MultiMachineCursor) -> Result<String, String> {
    let bytes = serde_json::to_vec(cursor)
        .map_err(|error| format!("failed to encode multi-machine event cursor: {error}"))?;
    let encoded = format!(
        "{MULTI_MACHINE_CURSOR_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    );
    if encoded.len() > MAX_MULTI_MACHINE_CURSOR_LEN {
        return Err("multi-machine event cursor exceeds the 64 KiB safety limit".to_string());
    }
    Ok(encoded)
}

fn decode_multi_machine_cursor(value: &str) -> Result<Option<MultiMachineCursor>, String> {
    let Some(encoded) = value.strip_prefix(MULTI_MACHINE_CURSOR_PREFIX) else {
        return Ok(None);
    };
    if value.len() > MAX_MULTI_MACHINE_CURSOR_LEN {
        return Err("multi-machine event cursor is too large".to_string());
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "cursor is not a valid multi-machine event cursor".to_string())?;
    let cursor: MultiMachineCursor = serde_json::from_slice(&bytes)
        .map_err(|_| "cursor is not a valid multi-machine event cursor".to_string())?;
    if cursor.local_machine_id.trim().is_empty()
        || cursor.task_ids_by_machine.is_empty()
        || cursor
            .task_ids_by_machine
            .iter()
            .any(|(machine_id, task_ids)| machine_id.trim().is_empty() || task_ids.is_empty())
        || cursor
            .cursors_by_machine
            .keys()
            .any(|machine_id| !cursor.task_ids_by_machine.contains_key(machine_id))
        || cursor
            .task_ids_by_machine
            .values()
            .map(Vec::len)
            .sum::<usize>()
            != cursor_task_ids(&cursor).len()
    {
        return Err("cursor is not a valid multi-machine event cursor".to_string());
    }
    Ok(Some(cursor))
}

fn normalized_task_ids(args: &Value) -> Result<Vec<String>, String> {
    let values = args
        .get("task_ids")
        .and_then(Value::as_array)
        .ok_or_else(|| "task_ids must be an array of strings".to_string())?;
    let mut task_ids = BTreeSet::new();
    for value in values {
        let task_id = value
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "task_ids must contain only non-empty strings".to_string())?;
        task_ids.insert(task_id.to_string());
    }
    if task_ids.is_empty() {
        return Err("task_ids must contain at least one task id".to_string());
    }
    Ok(task_ids.into_iter().collect())
}

fn cursor_task_ids(cursor: &MultiMachineCursor) -> Vec<String> {
    cursor
        .task_ids_by_machine
        .values()
        .flatten()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

async fn probe_task_on_machine(
    base_url: &str,
    machine_id: &str,
    local_machine_id: &str,
    task_id: &str,
) -> Result<bool, String> {
    let path = format!("/v1/tasks/{}", encode_path_segment(task_id));
    if machine_id != local_machine_id {
        let response =
            invoke_machine_response(base_url, machine_id, Method::Get, &path, &Value::Null).await?;
        return match response.status {
            200..=299 => Ok(true),
            404 => Ok(false),
            status => Err(format!(
                "GET {path} on machine {machine_id} failed with status {status}: {}",
                response.error.unwrap_or_else(|| response
                    .body
                    .map(|body| body.to_string())
                    .unwrap_or_default())
            )),
        };
    }

    let response = reqwest::Client::new()
        .get(join_server_url(base_url, &path))
        .send()
        .await
        .map_err(|error| format!("GET {path} failed: {error}"))?;
    match response.status().as_u16() {
        200..=299 => Ok(true),
        404 => Ok(false),
        status => {
            let body = response
                .text()
                .await
                .unwrap_or_else(|error| format!("failed to read error body: {error}"));
            Err(format!("GET {path} failed with status {status}: {body}"))
        }
    }
}

async fn discover_task_owners(
    base_url: &str,
    task_ids: &[String],
    local_machine_id: &str,
) -> Result<MultiMachineCursor, String> {
    // Resolve and probe the local server without touching the relay. An
    // all-local fan-out should stay just as cheap and reliable as it was before
    // cross-machine fan-in existed; sibling discovery is needed only for ids
    // that the local database does not own.
    let mut task_ids_by_machine: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut missing = Vec::new();

    let mut local_probes = tokio::task::JoinSet::new();
    for task_id in task_ids {
        let base_url = base_url.to_string();
        let machine_id = local_machine_id.to_string();
        let task_id = task_id.clone();
        local_probes.spawn(async move {
            let result = probe_task_on_machine(&base_url, &machine_id, &machine_id, &task_id).await;
            (task_id, result)
        });
    }
    while let Some(probe) = local_probes.join_next().await {
        let (task_id, found) = probe.map_err(|error| format!("task probe failed: {error}"))?;
        if found? {
            task_ids_by_machine
                .entry(local_machine_id.to_string())
                .or_default()
                .push(task_id);
        } else {
            missing.push(task_id);
        }
    }

    if !missing.is_empty() {
        let machines: MachineListResponse = get_json(base_url, "/v1/cloud/desktops").await?;
        if machines.current_machine_id != local_machine_id {
            return Err(format!(
                "local machine identity changed during task discovery ({} became {})",
                local_machine_id, machines.current_machine_id
            ));
        }
        let remote_machine_ids = machines
            .machines
            .into_iter()
            .map(|machine| machine.id)
            .filter(|machine_id| machine_id != local_machine_id)
            .collect::<Vec<_>>();
        if remote_machine_ids.is_empty() {
            let relay_detail = if machines.relay_available {
                "no sibling machines are currently reachable".to_string()
            } else {
                machines
                    .error
                    .map(|error| format!("relay discovery is unavailable: {error}"))
                    .unwrap_or_else(|| "relay discovery is unavailable".to_string())
            };
            return Err(format!(
                "could not find task ids on the local machine and {relay_detail}: {}",
                missing.join(", ")
            ));
        }

        let mut remote_probes = tokio::task::JoinSet::new();
        for machine_id in &remote_machine_ids {
            let base_url = base_url.to_string();
            let local_machine_id = local_machine_id.to_string();
            let machine_id = machine_id.clone();
            let task_ids = missing.clone();
            remote_probes.spawn(async move {
                let mut results = Vec::new();
                for task_id in task_ids {
                    let result =
                        probe_task_on_machine(&base_url, &machine_id, &local_machine_id, &task_id)
                            .await;
                    results.push((task_id, result));
                }
                (machine_id, results)
            });
        }

        let mut owners: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut probe_errors = Vec::new();
        while let Some(probe) = remote_probes.join_next().await {
            let (machine_id, results) =
                probe.map_err(|error| format!("task probe failed: {error}"))?;
            for (task_id, found) in results {
                match found {
                    Ok(true) => owners.entry(task_id).or_default().push(machine_id.clone()),
                    Ok(false) => {}
                    Err(error) => probe_errors.push(error),
                }
            }
        }

        let unresolved = missing
            .iter()
            .filter(|task_id| !owners.contains_key(*task_id))
            .cloned()
            .collect::<Vec<_>>();
        if !unresolved.is_empty() {
            let errors = if probe_errors.is_empty() {
                String::new()
            } else {
                format!(" Machine probe errors: {}", probe_errors.join("; "))
            };
            return Err(format!(
                "could not find task ids on any currently reachable machine: {}.{errors}",
                unresolved.join(", ")
            ));
        }
        for (task_id, machine_owners) in owners {
            if machine_owners.len() != 1 {
                return Err(format!(
                    "task id {task_id} exists on multiple reachable machines: {}",
                    machine_owners.join(", ")
                ));
            }
            task_ids_by_machine
                .entry(machine_owners[0].clone())
                .or_default()
                .push(task_id);
        }
    }

    for grouped_ids in task_ids_by_machine.values_mut() {
        grouped_ids.sort();
    }
    Ok(MultiMachineCursor {
        local_machine_id: local_machine_id.to_string(),
        task_ids_by_machine,
        cursors_by_machine: BTreeMap::new(),
    })
}

fn spawn_machine_event_wait(
    session: &mut MultiMachineWaitSession,
    base_url: &str,
    catalog: &SharedCatalog,
    args: &Value,
    machine_id: &str,
    local_machine_id: &str,
    timeout_secs: u64,
) -> Result<(), String> {
    let task_ids = session
        .cursor
        .task_ids_by_machine
        .get(machine_id)
        .ok_or_else(|| format!("missing task scope for machine {machine_id}"))?;
    let mut machine_args = args
        .as_object()
        .cloned()
        .ok_or_else(|| "tool arguments must be a JSON object".to_string())?;
    machine_args.insert(
        "task_ids".to_string(),
        Value::Array(task_ids.iter().cloned().map(Value::String).collect()),
    );
    machine_args.insert("timeout_secs".to_string(), Value::from(timeout_secs));
    // The server now offers its own multi-machine feed for direct HTTP
    // watchers. Keep km1's already-issued per-machine native cursors native:
    // otherwise its local leg would recursively fan out and duplicate the
    // remote legs that kanna-mcp is deliberately retaining here.
    machine_args.insert("local_only".to_string(), Value::Bool(true));
    match session.cursor.cursors_by_machine.get(machine_id) {
        Some(cursor) => {
            machine_args.insert("cursor".to_string(), Value::String(cursor.clone()));
        }
        None => {
            machine_args.remove("cursor");
        }
    }
    let request = {
        let catalog = catalog
            .read()
            .map_err(|_| "catalog lock poisoned".to_string())?;
        resolve_request(&catalog, "kanna_wait_events", &Value::Object(machine_args))?
    };
    let base_url = base_url.to_string();
    let routed_machine_id = (machine_id != local_machine_id).then(|| machine_id.to_string());
    let completed_machine_id = machine_id.to_string();
    session.pending.spawn(async move {
        let result = get_routed_json(&base_url, &request.path, routed_machine_id.as_deref()).await;
        MachineWaitCompletion {
            machine_id: completed_machine_id,
            result,
        }
    });
    session.pending_machines.insert(machine_id.to_string());
    Ok(())
}

fn apply_machine_wait_completion(
    session: &mut MultiMachineWaitSession,
    completion: MachineWaitCompletion,
    events: &mut Vec<Value>,
    errors: &mut Vec<Value>,
    failed_machines: &mut HashSet<String>,
    completed_machines: &mut HashSet<String>,
    has_more: &mut bool,
) -> Result<(), String> {
    session.pending_machines.remove(&completion.machine_id);
    completed_machines.insert(completion.machine_id.clone());
    let response = match completion.result {
        Ok(response) => response,
        Err(error) => {
            failed_machines.insert(completion.machine_id.clone());
            errors.push(serde_json::json!({
                "machineId": completion.machine_id,
                "error": error,
            }));
            return Ok(());
        }
    };
    let cursor = response
        .get("cursor")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!(
                "machine {} returned a task-event response without a cursor",
                completion.machine_id
            )
        })?;
    session
        .cursor
        .cursors_by_machine
        .insert(completion.machine_id.clone(), cursor.to_string());
    *has_more |= response
        .get("hasMore")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let machine_events = response
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            format!(
                "machine {} returned a task-event response without an events array",
                completion.machine_id
            )
        })?;
    for event in machine_events {
        let mut event = event.as_object().cloned().ok_or_else(|| {
            format!(
                "machine {} returned an invalid event",
                completion.machine_id
            )
        })?;
        event.insert(
            "machineId".to_string(),
            Value::String(completion.machine_id.clone()),
        );
        events.push(Value::Object(event));
    }
    Ok(())
}

async fn wait_events_across_machines(
    base_url: &str,
    catalog: &SharedCatalog,
    registry: &SharedMultiMachineWaits,
    args: Value,
) -> Result<Value, String> {
    {
        let catalog = catalog
            .read()
            .map_err(|_| "catalog lock poisoned".to_string())?;
        resolve_request(&catalog, "kanna_wait_events", &args)?;
    }
    let task_ids = normalized_task_ids(&args)?;
    let supplied_cursor = args.get("cursor").and_then(Value::as_str);
    let decoded_cursor = match supplied_cursor {
        Some(cursor) => decode_multi_machine_cursor(cursor)?,
        None => None,
    };
    let identity: LocalMachineIdentity = get_json(base_url, "/v1/status").await?;
    let local_machine_id = identity.desktop_id;
    let mut cursor = match decoded_cursor {
        Some(cursor) => {
            if cursor.local_machine_id != local_machine_id {
                return Err(format!(
                    "multi-machine event cursor belongs to local machine {}, but this client is connected to {}",
                    cursor.local_machine_id, local_machine_id
                ));
            }
            if cursor_task_ids(&cursor) != task_ids {
                return Err("cursor belongs to a different task_ids scope".to_string());
            }
            cursor
        }
        None => discover_task_owners(base_url, &task_ids, &local_machine_id).await?,
    };
    if let Some(native_cursor) = supplied_cursor.filter(|_| {
        !args
            .get("cursor")
            .and_then(Value::as_str)
            .is_some_and(|cursor| cursor.starts_with(MULTI_MACHINE_CURSOR_PREFIX))
    }) {
        if cursor
            .task_ids_by_machine
            .contains_key(&cursor.local_machine_id)
        {
            cursor
                .cursors_by_machine
                .insert(cursor.local_machine_id.clone(), native_cursor.to_string());
        }
    }
    let input_cursor_key = encode_multi_machine_cursor(&cursor)?;
    let mut session = {
        let mut registry = registry
            .lock()
            .map_err(|_| "multi-machine wait registry lock poisoned".to_string())?;
        let now = tokio::time::Instant::now();
        registry.sessions.retain(|_, session| {
            now.duration_since(session.last_touched) <= MULTI_MACHINE_WAIT_SESSION_TTL
        });
        registry
            .sessions
            .remove(&input_cursor_key)
            .unwrap_or_else(|| MultiMachineWaitSession {
                cursor,
                pending: tokio::task::JoinSet::new(),
                pending_machines: HashSet::new(),
                last_touched: now,
            })
    };
    let inherited_pending = !session.pending_machines.is_empty();

    let timeout_secs = clamp_wait_timeout_secs(
        args.get("timeout_secs")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_WAIT_TIMEOUT_SECS),
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    let mut events = Vec::new();
    let mut errors = Vec::new();
    let mut failed_machines = HashSet::new();
    let mut completed_machines = HashSet::new();
    let mut has_more = false;

    loop {
        let remaining_secs = if timeout_secs == 0 {
            0
        } else {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            remaining
                .as_secs()
                .saturating_add(u64::from(remaining.subsec_nanos() > 0))
                .max(1)
        };
        let machines_to_start = session
            .cursor
            .task_ids_by_machine
            .keys()
            .filter(|machine_id| {
                !(session.pending_machines.contains(*machine_id)
                    || failed_machines.contains(*machine_id)
                    || timeout_secs == 0 && completed_machines.contains(*machine_id))
            })
            .cloned()
            .collect::<Vec<_>>();
        for machine_id in machines_to_start {
            spawn_machine_event_wait(
                &mut session,
                base_url,
                catalog,
                &args,
                &machine_id,
                &local_machine_id,
                remaining_secs,
            )?;
        }

        let joined = if timeout_secs == 0 && inherited_pending {
            session.pending.try_join_next()
        } else if timeout_secs == 0 {
            session.pending.join_next().await
        } else {
            tokio::time::timeout_at(deadline, session.pending.join_next())
                .await
                .unwrap_or_default()
        };
        let Some(joined) = joined else {
            break;
        };
        let completion = joined.map_err(|error| format!("machine wait task failed: {error}"))?;
        apply_machine_wait_completion(
            &mut session,
            completion,
            &mut events,
            &mut errors,
            &mut failed_machines,
            &mut completed_machines,
            &mut has_more,
        )?;

        if !events.is_empty() || has_more {
            break;
        }
        if (timeout_secs == 0 && session.pending_machines.is_empty())
            || (timeout_secs > 0 && tokio::time::Instant::now() >= deadline)
        {
            break;
        }
        if !errors.is_empty() && session.pending_machines.is_empty() {
            break;
        }
    }

    session.last_touched = tokio::time::Instant::now();
    let output_cursor = encode_multi_machine_cursor(&session.cursor)?;
    {
        let mut registry = registry
            .lock()
            .map_err(|_| "multi-machine wait registry lock poisoned".to_string())?;
        registry.sessions.insert(output_cursor.clone(), session);
    }
    let wait_outcome = if !events.is_empty() || has_more {
        "events"
    } else if !errors.is_empty() {
        "partial"
    } else {
        "timeout"
    };
    Ok(serde_json::json!({
        "waitOutcome": wait_outcome,
        "cursor": output_cursor,
        "events": events,
        "hasMore": has_more,
        "machineErrors": errors,
        "waitTimeoutSecs": timeout_secs,
        "waitHint": if wait_outcome == "events" {
            Value::Null
        } else {
            Value::String("Pass the aggregate cursor back unchanged to keep watching every machine; machine failures are retried on the next call without advancing that machine's cursor.".to_string())
        },
    }))
}

async fn handle_mcp_tool_call(
    base_url: &str,
    catalog: &SharedCatalog,
    multi_machine_waits: &SharedMultiMachineWaits,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    if name == "kanna_complete_stage" && args.get("machine_id").is_some() {
        return Err(
            "kanna_complete_stage cannot target another machine; an agent can only complete its own local stage"
                .to_string(),
        );
    }
    let declared_machine_id = {
        let catalog = catalog
            .read()
            .map_err(|_| "catalog lock poisoned".to_string())?;
        resolve_request(&catalog, name, &args)?.machine_id
    };
    let machine_id = resolve_remote_machine_id(base_url, declared_machine_id.as_deref()).await?;
    if name == "kanna_wait_events" && machine_id.is_none() && args.get("task_ids").is_some() {
        return wait_events_across_machines(base_url, catalog, multi_machine_waits, args).await;
    }
    let args = maybe_augment_create_task_args(base_url, name, args, machine_id.as_deref()).await?;
    let mut request = {
        let catalog = catalog
            .read()
            .map_err(|_| "catalog lock poisoned".to_string())?;
        resolve_request(&catalog, name, &args)?
    };
    if name == "kanna_complete_stage" {
        bind_request_to_spawned_run(base_url, &mut request).await?;
    }
    let task_id = env::var("KANNA_TASK_ID")
        .ok()
        .filter(|value| !value.trim().is_empty());
    // The tools this adapter actually advertises — including any override
    // catalog — are what a skew report has to be measured against.
    let client_tool_names = {
        let catalog = catalog
            .read()
            .map_err(|_| "catalog lock poisoned".to_string())?;
        catalog
            .tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect::<Vec<_>>()
    };
    let result = execute_resolved_request(
        base_url,
        request,
        RuntimeAdapterIdentity {
            name: "kanna-mcp",
            version: env!("CARGO_PKG_VERSION"),
            mcp_protocol_version: Some(MCP_PROTOCOL_VERSION),
            task_id: task_id.as_deref(),
        },
        machine_id.as_deref(),
        &client_tool_names,
    )
    .await;
    result
}

async fn bind_request_to_spawned_run(
    _base_url: &str,
    request: &mut ResolvedRequest,
) -> Result<(), String> {
    let attempt_key = kanna_tool_catalog::completion_attempt_key(&request.body)?;
    let context_path =
        env::var_os(kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV).map(std::path::PathBuf::from);
    let context = match context_path.as_ref() {
        Some(path) => Some(kanna_tool_catalog::read_completion_context(path)?),
        None => None,
    };
    let run_id = context
        .as_ref()
        .map(|context| {
            context
                .run_for_attempt(&attempt_key)
                .unwrap_or(&context.run_id)
                .to_string()
        })
        .or_else(|| env::var(kanna_tool_catalog::KANNA_STAGE_RUN_ID_ENV).ok());
    let Some(run_id) = run_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let body = request
        .body
        .as_object_mut()
        .ok_or_else(|| "complete-stage request body must be an object".to_string())?;
    body.insert("runId".to_string(), Value::String(run_id.to_string()));
    body.insert(
        "completionAttemptKey".to_string(),
        Value::String(attempt_key.clone()),
    );
    Ok(())
}

async fn maybe_augment_create_task_args(
    base_url: &str,
    name: &str,
    args: Value,
    machine_id: Option<&str>,
) -> Result<Value, String> {
    if name != "kanna_create_task" || args.get("repo_id").is_some() {
        return Ok(args);
    }

    if let Some(machine_id) = machine_id {
        return Err(format!(
            "repo_id is required when creating a task on machine {machine_id}; call kanna_list_repos with the same machine_id first"
        ));
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
    adapter: RuntimeAdapterIdentity<'_>,
    machine_id: Option<&str>,
    client_tool_names: &[String],
) -> Result<Value, String> {
    match (request.method, request.kind) {
        (Method::Get, ResponseKind::Json) => {
            let value = get_routed_json(base_url, &request.path, machine_id).await?;
            confirm_stopped_activity(base_url, &request.path, value, machine_id).await
        }
        (Method::Get, ResponseKind::Text) => match machine_id {
            Some(machine_id) => {
                invoke_machine(
                    base_url,
                    machine_id,
                    Method::Get,
                    &request.path,
                    &Value::Null,
                )
                .await
            }
            None => get_text(base_url, &request.path).await.map(Value::String),
        },
        (Method::Post | Method::Patch, ResponseKind::Json) => match machine_id {
            Some(machine_id) => {
                invoke_machine(
                    base_url,
                    machine_id,
                    request.method,
                    &request.path,
                    &request.body,
                )
                .await
            }
            None if request.method == Method::Post => {
                post_json(base_url, &request.path, &request.body).await
            }
            None => patch_json(base_url, &request.path, &request.body).await,
        },
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
                machine_id,
            )
            .await
        }
        (Method::Get, ResponseKind::RuntimeInfo) => {
            let (effective_url, status) = match machine_id {
                Some(machine_id) => (
                    format!("kanna+relay://{machine_id}"),
                    get_routed_json(base_url, &request.path, Some(machine_id)).await,
                ),
                None => (
                    base_url.to_string(),
                    get_runtime_status(base_url, &request.path).await,
                ),
            };
            let mut snapshot =
                runtime_info_snapshot(&effective_url, adapter, status, client_tool_names);
            if let Some(machine_id) = machine_id {
                snapshot["connection"]["routing"] = serde_json::json!({
                    "kind": "accountRelay",
                    "machineId": machine_id,
                    "viaBaseUrl": base_url,
                });
            }
            Ok(snapshot)
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
    multi_machine_waits: &SharedMultiMachineWaits,
) -> Result<Option<String>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let message: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("failed to parse MCP JSON-RPC message: {e}"))?;
    let response = handle_mcp_request(message, base_url, catalog, multi_machine_waits).await;
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
    let multi_machine_waits = Arc::new(Mutex::new(MultiMachineWaitRegistry::default()));
    let stdin = std::io::stdin();
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let _watcher = spawn_catalog_watcher(cwd.to_path_buf(), catalog.clone(), stdout.clone());
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("failed to read stdin: {e}"))?;
        if let Some(mut rendered) =
            handle_mcp_line(&line, base_url, &catalog, &multi_machine_waits).await?
        {
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
        let tools = mcp_tools_list_value(&kanna_tool_catalog::bundled_catalog());
        let names = tools
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "kanna_info",
                "kanna_list_machines",
                "kanna_list_repos",
                "kanna_add_repo",
                "kanna_list_recent_tasks",
                "kanna_get_task",
                "kanna_list_task_children",
                "kanna_wait_task",
                "kanna_wait_events",
                "kanna_notify_mobile",
                "kanna_set_task_notify",
                "kanna_set_task_workflow",
                "kanna_task_logs",
                "kanna_search_tasks",
                "kanna_list_repo_tasks",
                "kanna_list_agents",
                "kanna_create_task",
                "kanna_signal_agent",
                "kanna_signal_merge_handoff",
                "kanna_send_task_input",
                "kanna_close_task",
                "kanna_rename_task",
                "kanna_advance_stage",
                "kanna_rerun_stage",
                "kanna_resume_task",
                "kanna_block_task",
                "kanna_unblock_task",
                "kanna_set_task_parent",
                "kanna_is_dependent_tasks_exist",
                "kanna_complete_stage",
                "kanna_request_revision",
            ]
        );
    }

    #[test]
    fn wait_events_schema_documents_automatic_cross_machine_fan_in() {
        let tools = mcp_tools_list_value(&kanna_tool_catalog::bundled_catalog());
        let wait_events = tools
            .as_array()
            .expect("tools array")
            .iter()
            .find(|tool| tool["name"] == "kanna_wait_events")
            .expect("wait events tool");
        let description = wait_events["description"].as_str().expect("description");

        assert!(description.contains("different currently reachable machines"));
        assert!(description.contains("aggregate opaque cursor"));
        assert!(description.contains("tags every event with machineId"));
    }

    #[test]
    fn multi_machine_cursor_round_trips_ownership_and_native_cursors() {
        let cursor = MultiMachineCursor {
            local_machine_id: "desktop-local".to_string(),
            task_ids_by_machine: BTreeMap::from([
                ("desktop-local".to_string(), vec!["task-a".to_string()]),
                ("desktop-studio".to_string(), vec!["task-b".to_string()]),
            ]),
            cursors_by_machine: BTreeMap::from([
                ("desktop-local".to_string(), "17".to_string()),
                ("desktop-studio".to_string(), "p3.opaque".to_string()),
            ]),
        };

        let encoded = encode_multi_machine_cursor(&cursor).expect("encode cursor");
        assert!(encoded.starts_with(MULTI_MACHINE_CURSOR_PREFIX));
        assert_eq!(
            decode_multi_machine_cursor(&encoded).expect("decode cursor"),
            Some(cursor)
        );
    }

    #[tokio::test]
    async fn initialize_advertises_kanna_mcp_server_info() {
        let catalog = shared_bundled_catalog();
        let waits = Arc::new(Mutex::new(MultiMachineWaitRegistry::default()));
        let response = handle_mcp_request(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize"
            }),
            "http://127.0.0.1:48120",
            &catalog,
            &waits,
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
        let waits = Arc::new(Mutex::new(MultiMachineWaitRegistry::default()));
        let response = handle_mcp_request(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {}
            }),
            "http://127.0.0.1:48120",
            &catalog,
            &waits,
        )
        .await;

        assert_eq!(response["error"]["code"], -32602);
        assert_eq!(response["error"]["message"], "missing tool name");
    }

    #[tokio::test]
    async fn unknown_tool_returns_protocol_error_listing_available_tools() {
        let catalog = shared_bundled_catalog();
        let waits = Arc::new(Mutex::new(MultiMachineWaitRegistry::default()));
        let response = handle_mcp_request(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": { "name": "kanna_nonexistent", "arguments": {} }
            }),
            "http://127.0.0.1:48120",
            &catalog,
            &waits,
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
        let waits = Arc::new(Mutex::new(MultiMachineWaitRegistry::default()));
        let response = handle_mcp_request(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": { "name": "kanna_search_tasks", "arguments": {} }
            }),
            "http://127.0.0.1:48120",
            &catalog,
            &waits,
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
        assert_eq!(tools[0]["name"], json!("kanna_info"));
        assert_eq!(tools[1]["name"], json!("kanna_list_machines"));
        assert_eq!(tools[2]["name"], json!("kanna_custom_ping"));
        let output = String::from_utf8(stdout.lock().unwrap().clone()).unwrap();
        assert_eq!(
            output,
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}

/// The daemon's per-frame classifier has no hysteresis, so one mid-redraw frame
/// can report a working agent as idle. These tests drive the real stdio
/// JSON-RPC surface against a real HTTP server that scripts that sequence, so
/// the catalog routing, the confirmation read, and the tool-result envelope are
/// exercised together. `crates/kanna-mcp/tests/activity_debounce.rs` drives the
/// same sequence across real processes — daemon protocol fixture, real
/// `kanna-server`, real `kanna-mcp` — and `tests/stdio_http.rs` covers the three
/// task-list routes and the failed-confirmation path over real HTTP.
#[cfg(test)]
mod activity_debounce_tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn task_with_activity(activity: &str) -> Value {
        json!({
            "id": "child-1",
            "repoId": "repo-1",
            "title": "Specialty review",
            "stage": "review",
            "branch": "task-child-1",
            "activity": activity,
            "closedAt": null
        })
    }

    /// One scripted reply. `Serves` hands back a body; `Fails` is the
    /// confirmation read losing the server — the case where there is no second
    /// sample to confirm against.
    #[derive(Clone)]
    enum Reply {
        Serves(Value),
        Fails,
    }

    /// Serves `GET` from a script of replies, one per request, repeating the
    /// last one. That is how a flapping classifier reads to this layer:
    /// consecutive reads of the same route disagree.
    async fn spawn_scripted_task_server(script: Vec<Reply>) -> (String, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind scripted task server");
        let addr = listener.local_addr().expect("local addr");
        let reads = Arc::new(AtomicUsize::new(0));
        let served = reads.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buffer = vec![0u8; 4096];
                if socket.read(&mut buffer).await.is_err() {
                    continue;
                }
                let index = served.fetch_add(1, Ordering::SeqCst);
                let response = match script.get(index).or_else(|| script.last()) {
                    Some(Reply::Serves(body)) => {
                        let body = body.to_string();
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                    }
                    Some(Reply::Fails) | None => {
                        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 9\r\nConnection: close\r\n\r\nno daemon"
                            .to_string()
                    }
                };
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        (format!("http://{addr}"), reads)
    }

    fn serving(script: Vec<Value>) -> Vec<Reply> {
        script.into_iter().map(Reply::Serves).collect()
    }

    async fn call_tool_raw(
        base_url: &str,
        catalog: &SharedCatalog,
        name: &str,
        arguments: Value,
    ) -> Value {
        let line = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        })
        .to_string();
        let waits = Arc::new(Mutex::new(MultiMachineWaitRegistry::default()));
        let rendered = handle_mcp_line(&line, base_url, catalog, &waits)
            .await
            .expect("tool call handled")
            .expect("tool call response line");
        let parsed: Value = serde_json::from_str(&rendered).expect("json-rpc response");
        assert!(parsed.get("error").is_none(), "{parsed}");
        parsed
    }

    async fn call_tool(
        base_url: &str,
        catalog: &SharedCatalog,
        name: &str,
        arguments: Value,
    ) -> Value {
        let parsed = call_tool_raw(base_url, catalog, name, arguments).await;
        let text = parsed["result"]["content"][0]["text"]
            .as_str()
            .expect("tool result text")
            .to_string();
        assert!(
            parsed["result"]["isError"] != json!(true),
            "tool call should not be an error result: {text}"
        );
        serde_json::from_str(&text).expect("tool result json")
    }

    /// Returns the error text of a tool call that must have failed.
    async fn call_tool_expecting_error(
        base_url: &str,
        catalog: &SharedCatalog,
        name: &str,
        arguments: Value,
    ) -> String {
        let parsed = call_tool_raw(base_url, catalog, name, arguments).await;
        let text = parsed["result"]["content"][0]["text"]
            .as_str()
            .expect("tool result text")
            .to_string();
        assert_eq!(
            parsed["result"]["isError"],
            json!(true),
            "an unconfirmed stop must fail the call rather than be reported: {text}"
        );
        text
    }

    #[tokio::test(start_paused = true)]
    async fn a_single_stopped_looking_read_between_working_reads_is_not_reported_as_stopped() {
        let (base_url, reads) = spawn_scripted_task_server(serving(vec![
            task_with_activity("unread"),
            task_with_activity("working"),
        ]))
        .await;
        let catalog = shared_bundled_catalog();

        let task = call_tool(
            &base_url,
            &catalog,
            "kanna_get_task",
            json!({ "task_id": "child-1" }),
        )
        .await;

        assert_eq!(
            task["activity"],
            json!("working"),
            "one dropped busy marker must not surface as a stopped agent"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_that_holds_is_reported_within_the_confirmation_delay() {
        let (base_url, reads) =
            spawn_scripted_task_server(serving(vec![task_with_activity("unread")])).await;
        let catalog = shared_bundled_catalog();

        let started = tokio::time::Instant::now();
        let task = call_tool(
            &base_url,
            &catalog,
            "kanna_get_task",
            json!({ "task_id": "child-1" }),
        )
        .await;
        let elapsed = started.elapsed();

        assert_eq!(
            task["activity"],
            json!("unread"),
            "a confirmed stop keeps its own activity value; the debounce does not rewrite it"
        );
        assert!(
            elapsed >= ACTIVITY_CONFIRM_DELAY && elapsed < ACTIVITY_CONFIRM_DELAY * 3,
            "a genuine stop should surface one confirmation delay later, took {elapsed:?}"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_working_read_is_reported_immediately_and_costs_no_extra_request() {
        let (base_url, reads) =
            spawn_scripted_task_server(serving(vec![task_with_activity("working")])).await;
        let catalog = shared_bundled_catalog();

        let started = tokio::time::Instant::now();
        let task = call_tool(
            &base_url,
            &catalog,
            "kanna_get_task",
            json!({ "task_id": "child-1" }),
        )
        .await;
        let elapsed = started.elapsed();

        assert_eq!(task["activity"], json!("working"));
        assert!(
            elapsed < ACTIVITY_CONFIRM_DELAY,
            "reporting busy must stay prompt, took {elapsed:?}"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_closed_task_is_reported_without_a_confirmation_read() {
        let mut closed = task_with_activity("unread");
        closed["closedAt"] = json!("2026-08-02 10:00:00");
        let (base_url, reads) = spawn_scripted_task_server(serving(vec![closed])).await;
        let catalog = shared_bundled_catalog();

        let started = tokio::time::Instant::now();
        let task = call_tool(
            &base_url,
            &catalog,
            "kanna_get_task",
            json!({ "task_id": "child-1" }),
        )
        .await;

        assert_eq!(task["activity"], json!("unread"));
        assert!(started.elapsed() < ACTIVITY_CONFIRM_DELAY);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn waiting_on_a_task_does_not_resolve_on_a_single_stopped_looking_read() {
        let (base_url, _) = spawn_scripted_task_server(serving(vec![
            task_with_activity("unread"),
            task_with_activity("working"),
            task_with_activity("working"),
            task_with_activity("unread"),
        ]))
        .await;
        let catalog = shared_bundled_catalog();

        let result = call_tool(
            &base_url,
            &catalog,
            "kanna_wait_task",
            json!({ "task_id": "child-1", "timeout_secs": 30, "poll_secs": 1 }),
        )
        .await;

        assert_eq!(
            result["waitOutcome"],
            json!("resolved"),
            "the wait should still resolve once a stop holds: {result}"
        );
        assert_eq!(result["activity"], json!("unread"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_whose_confirmation_read_fails_is_not_reported_at_all() {
        let (base_url, reads) = spawn_scripted_task_server(vec![
            Reply::Serves(task_with_activity("unread")),
            Reply::Fails,
        ])
        .await;
        let catalog = shared_bundled_catalog();

        let error = call_tool_expecting_error(
            &base_url,
            &catalog,
            "kanna_get_task",
            json!({ "task_id": "child-1" }),
        )
        .await;

        assert!(
            !error.contains("\"activity\""),
            "the unconfirmed sample must not be handed back in the failure: {error}"
        );
        assert!(
            error.contains("could not confirm") || error.contains("confirming re-read"),
            "the failure should say the stop went unconfirmed: {error}"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn waiting_does_not_resolve_when_the_confirmation_read_fails() {
        let (base_url, _) = spawn_scripted_task_server(vec![
            Reply::Serves(task_with_activity("unread")),
            Reply::Fails,
        ])
        .await;
        let catalog = shared_bundled_catalog();

        let error = call_tool_expecting_error(
            &base_url,
            &catalog,
            "kanna_wait_task",
            json!({ "task_id": "child-1", "timeout_secs": 30, "poll_secs": 1 }),
        )
        .await;

        assert!(
            !error.contains("\"waitOutcome\": \"resolved\""),
            "an unconfirmed stop must not resolve the wait: {error}"
        );
    }

    fn task_list(activities: [&str; 2]) -> Value {
        Value::Array(
            activities
                .iter()
                .enumerate()
                .map(|(index, activity)| {
                    let mut task = task_with_activity(activity);
                    task["id"] = json!(format!("child-{}", index + 1));
                    task
                })
                .collect(),
        )
    }

    #[tokio::test(start_paused = true)]
    async fn a_transient_stop_in_a_task_list_is_replaced_by_the_fresh_working_sample() {
        let (base_url, reads) = spawn_scripted_task_server(serving(vec![
            task_list(["working", "unread"]),
            task_list(["working", "working"]),
        ]))
        .await;
        let catalog = shared_bundled_catalog();

        let tasks = call_tool(&base_url, &catalog, "kanna_list_recent_tasks", json!({})).await;

        assert_eq!(
            tasks[1]["activity"],
            json!("working"),
            "a listing must not leak a mid-redraw misread either: {tasks}"
        );
        assert_eq!(
            reads.load(Ordering::SeqCst),
            2,
            "one re-read confirms the whole list, however many tasks it holds"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_list_of_only_working_tasks_costs_no_extra_request() {
        let (base_url, reads) =
            spawn_scripted_task_server(serving(vec![task_list(["working", "working"])])).await;
        let catalog = shared_bundled_catalog();

        let started = tokio::time::Instant::now();
        let tasks = call_tool(&base_url, &catalog, "kanna_list_recent_tasks", json!({})).await;

        assert_eq!(tasks[0]["activity"], json!("working"));
        assert!(started.elapsed() < ACTIVITY_CONFIRM_DELAY);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_list_whose_confirmation_read_fails_is_not_reported_at_all() {
        let (base_url, _) = spawn_scripted_task_server(vec![
            Reply::Serves(task_list(["working", "unread"])),
            Reply::Fails,
        ])
        .await;
        let catalog = shared_bundled_catalog();

        let error =
            call_tool_expecting_error(&base_url, &catalog, "kanna_list_recent_tasks", json!({}))
                .await;

        assert!(
            !error.contains("\"activity\""),
            "the unconfirmed listing must not be handed back in the failure: {error}"
        );
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
        let waits = Arc::new(Mutex::new(MultiMachineWaitRegistry::default()));
        let line = handle_mcp_line(&wait_call_line(arguments), base_url, catalog, &waits)
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
        let waits = Arc::new(Mutex::new(MultiMachineWaitRegistry::default()));
        let output = handle_mcp_line(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "http://127.0.0.1:48120",
            &catalog,
            &waits,
        )
        .await
        .unwrap();

        assert_eq!(output, None);
    }

    #[tokio::test]
    async fn initialize_line_produces_json_response_line() {
        let catalog = shared_bundled_catalog();
        let waits = Arc::new(Mutex::new(MultiMachineWaitRegistry::default()));
        let output = handle_mcp_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"initialize"}"#,
            "http://127.0.0.1:48120",
            &catalog,
            &waits,
        )
        .await
        .unwrap()
        .expect("response line");
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!(7));
        assert_eq!(parsed["result"]["serverInfo"]["name"], "kanna-mcp");
    }
}
