use std::env;
use std::process;

use kanna_tool_catalog::{
    args_with_self_exclusion, clamp_wait_timeout_secs, encode_path_segment, load_catalog,
    repo_context_task_id, resolve_request, resolve_request_with_repo_context,
    runtime_info_snapshot, wait_resolved_result, wait_timeout_result, Catalog,
    Method as CatalogMethod, ResolvedRequest, ResponseKind, RuntimeAdapterIdentity,
};
use serde::Deserialize;
use serde_json::Value;

use crate::api::{
    catalog_task_matches_wait_until, get_json, get_text, patch_catalog_json, post_catalog_json,
    wait_catalog_task_via_api,
};
use crate::commands::print_json;
use crate::config::resolve_server_base_url_from_env;
use crate::{MachineCommands, ToolCommands};

pub(crate) fn load_tool_catalog_from_current_dir() -> Result<Catalog, String> {
    let cwd = env::current_dir().map_err(|e| format!("failed to read current directory: {e}"))?;
    let loaded = load_catalog(&cwd);
    if let Some(warning) = loaded.warning {
        eprintln!("Warning: {warning}");
    }
    Ok(loaded.catalog)
}

pub(crate) fn build_tool_call_args(
    catalog: &Catalog,
    tool_name: &str,
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
        // The catalog declares the type; the text is never allowed to guess
        // it. An argument the tool does not declare stays a string so
        // `resolve_request` reports it as an unknown argument, which is the
        // real problem, rather than as a parse failure.
        let value = match catalog.find_param(tool_name, key) {
            Some(param) => param.parse_cli_value(raw_value)?,
            None => Value::String(raw_value.to_string()),
        };
        args_object.insert(key.to_string(), value);
    }

    Ok(args)
}

pub(crate) async fn execute_catalog_request(
    base_url: &str,
    request: ResolvedRequest,
    adapter: RuntimeAdapterIdentity<'_>,
    machine_id: Option<&str>,
    client_tool_names: &[String],
) -> Result<Value, String> {
    match (request.method, request.kind) {
        (_, ResponseKind::Guide) => request
            .local_response
            .ok_or_else(|| "guide request missing local response".to_string()),
        (CatalogMethod::Get, ResponseKind::Json) => {
            get_routed_json(base_url, &request.path, machine_id).await
        }
        (CatalogMethod::Get, ResponseKind::Text) => match machine_id {
            Some(machine_id) => {
                invoke_machine(
                    base_url,
                    machine_id,
                    CatalogMethod::Get,
                    &request.path,
                    &Value::Null,
                )
                .await
            }
            None => get_text(base_url, &request.path).await.map(Value::String),
        },
        (CatalogMethod::Post | CatalogMethod::Patch, ResponseKind::Json) => match machine_id {
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
            None if request.method == CatalogMethod::Post => {
                post_catalog_json(base_url, &request.path, &request.body).await
            }
            None => patch_catalog_json(base_url, &request.path, &request.body).await,
        },
        (_, ResponseKind::Wait) => {
            let wait = request
                .wait
                .ok_or_else(|| "wait request missing wait spec".to_string())?;
            match machine_id {
                Some(machine_id) => {
                    wait_catalog_task_routed(
                        base_url,
                        &wait.task_id,
                        wait.timeout_secs,
                        wait.poll_secs,
                        wait.until,
                        Some(machine_id),
                    )
                    .await
                }
                None => {
                    wait_catalog_task_via_api(
                        base_url,
                        &wait.task_id,
                        wait.timeout_secs,
                        wait.poll_secs,
                        wait.until,
                    )
                    .await
                }
            }
        }
        (CatalogMethod::Get, ResponseKind::RuntimeInfo) => {
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
            "unsupported catalog request: {:?} {:?}",
            request.method, request.kind
        )),
    }
}

pub(crate) async fn call_catalog_tool(
    base_url: &str,
    catalog: &Catalog,
    name: &str,
    args: &Value,
) -> Result<(ResponseKind, Value), String> {
    let task_id = env::var("KANNA_TASK_ID")
        .ok()
        .filter(|value| !value.trim().is_empty());
    call_catalog_tool_with_task_id(base_url, catalog, name, args, task_id.as_deref()).await
}

pub(crate) async fn call_catalog_tool_with_task_id(
    base_url: &str,
    catalog: &Catalog,
    name: &str,
    args: &Value,
    task_id: Option<&str>,
) -> Result<(ResponseKind, Value), String> {
    if name == "kanna_complete_stage" && args.get("machine_id").is_some() {
        return Err(
            "kanna_complete_stage cannot target another machine; an agent can only complete its own local stage"
                .to_string(),
        );
    }
    let preliminary_request = resolve_request(catalog, name, args)?;
    let requested_machine_id = preliminary_request.machine_id.as_deref();
    let machine_id = resolve_remote_machine_id(base_url, requested_machine_id).await?;
    let repo_task_id = repo_context_task_id(name, args, task_id, machine_id.as_deref())?;
    let current_task = match repo_task_id {
        Some(repo_task_id) => {
            let path = format!("/v1/tasks/{}", encode_path_segment(&repo_task_id));
            Some(get_json(base_url, &path).await.map_err(|error| {
                format!("failed to infer repo_id from KANNA_TASK_ID={repo_task_id}: {error}")
            })?)
        }
        None => None,
    };
    let args = args_with_self_exclusion(name, args, task_id)?;
    let mut request =
        resolve_request_with_repo_context(catalog, name, &args, current_task.as_ref())?;
    request.machine_id = None;
    if name == "kanna_complete_stage" {
        bind_request_to_spawned_run(base_url, &mut request).await?;
    } else if name == "kanna_request_revision" {
        bind_revision_request_to_spawned_run(&mut request)?;
    }
    let kind = request.kind;
    // The tools this client advertises — including any override catalog — are
    // what a skew report has to be measured against.
    let client_tool_names = catalog
        .tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    let value = execute_catalog_request(
        base_url,
        request,
        RuntimeAdapterIdentity {
            name: "kanna-cli",
            version: env!("CARGO_PKG_VERSION"),
            mcp_protocol_version: None,
            task_id,
        },
        machine_id.as_deref(),
        &client_tool_names,
    )
    .await?;
    Ok((kind, value))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalMachineIdentity {
    desktop_id: String,
}

#[derive(Deserialize)]
struct MachineInvokeResponse {
    status: u16,
    body: Option<Value>,
    error: Option<String>,
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

fn method_name(method: CatalogMethod) -> &'static str {
    match method {
        CatalogMethod::Get => "GET",
        CatalogMethod::Post => "POST",
        CatalogMethod::Patch => "PATCH",
    }
}

async fn invoke_machine(
    base_url: &str,
    machine_id: &str,
    method: CatalogMethod,
    path: &str,
    body: &Value,
) -> Result<Value, String> {
    let proxy_path = format!(
        "/v1/cloud/desktops/{}/invoke",
        crate::api::encode_path_segment(machine_id)
    );
    let response = post_catalog_json(
        base_url,
        &proxy_path,
        &serde_json::json!({
            "method": method_name(method),
            "path": path,
            "body": body,
        }),
    )
    .await?;
    let response: MachineInvokeResponse = serde_json::from_value(response)
        .map_err(|error| format!("invalid machine invoke response: {error}"))?;
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

async fn get_routed_json(
    base_url: &str,
    path: &str,
    machine_id: Option<&str>,
) -> Result<Value, String> {
    match machine_id {
        Some(machine_id) => {
            invoke_machine(base_url, machine_id, CatalogMethod::Get, path, &Value::Null).await
        }
        None => get_json(base_url, path).await,
    }
}

async fn wait_catalog_task_routed(
    base_url: &str,
    task_id: &str,
    timeout_secs: u64,
    poll_secs: u64,
    until: kanna_tool_catalog::WaitUntil,
    machine_id: Option<&str>,
) -> Result<Value, String> {
    let timeout_secs = clamp_wait_timeout_secs(timeout_secs);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let poll_interval = std::time::Duration::from_secs(poll_secs.max(1));
    let path = crate::api::task_agent_get_path(task_id);
    loop {
        let task = get_routed_json(base_url, &path, machine_id).await?;
        if catalog_task_matches_wait_until(&task, until) {
            return Ok(wait_resolved_result(task));
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(wait_timeout_result(task, task_id, timeout_secs));
        }
        tokio::time::sleep(poll_interval.min(deadline - now)).await;
    }
}

fn bind_revision_request_to_spawned_run(request: &mut ResolvedRequest) -> Result<(), String> {
    let run_id = match env::var_os(kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV) {
        Some(path) => {
            Some(kanna_tool_catalog::read_completion_context(std::path::Path::new(&path))?.run_id)
        }
        None => env::var(kanna_tool_catalog::KANNA_STAGE_RUN_ID_ENV).ok(),
    };
    let Some(run_id) = run_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let body = request
        .body
        .as_object_mut()
        .ok_or_else(|| "request-revision request body must be an object".to_string())?;
    body.insert("runId".to_string(), Value::String(run_id));
    Ok(())
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
    let body = request
        .body
        .as_object_mut()
        .ok_or_else(|| "complete-stage request body must be an object".to_string())?;
    if let Some(run_id) = run_id.filter(|value| !value.trim().is_empty()) {
        body.insert("runId".to_string(), Value::String(run_id));
    }
    body.insert(
        "completionAttemptKey".to_string(),
        Value::String(attempt_key.clone()),
    );
    Ok(())
}

async fn get_runtime_status(base_url: &str, path: &str) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .get(crate::api::join_server_url(base_url, path))
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

pub(crate) async fn run(command: ToolCommands) {
    match command {
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
            machine_id,
            server_url,
        } => {
            // The catalog is loaded first: it is what types `--arg` values.
            let catalog = load_tool_catalog_from_current_dir().unwrap_or_else(|e| {
                eprintln!("Error: {e}");
                process::exit(1);
            });
            let mut args = build_tool_call_args(&catalog, &name, &json, &arg).unwrap_or_else(|e| {
                eprintln!("Error: {e}");
                process::exit(1);
            });
            if let Some(machine_id) = machine_id {
                args.as_object_mut()
                    .expect("tool arguments were validated as an object")
                    .insert("machine_id".to_string(), Value::String(machine_id));
            }
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
    }
}

pub(crate) async fn run_machine(command: MachineCommands) {
    let (name, args, server_url) = match command {
        MachineCommands::List { server_url } => {
            ("kanna_list_machines", serde_json::json!({}), server_url)
        }
        MachineCommands::TransferPeers {
            machine_id,
            server_url,
        } => {
            let mut args = serde_json::json!({});
            if let (Some(object), Some(machine_id)) = (args.as_object_mut(), machine_id) {
                object.insert("machine_id".to_string(), Value::String(machine_id));
            }
            ("kanna_list_transfer_peers", args, server_url)
        }
    };
    let catalog = load_tool_catalog_from_current_dir().unwrap_or_else(|error| {
        eprintln!("Error: {error}");
        process::exit(1);
    });
    let base_url = resolve_server_base_url_from_env(server_url.as_deref());
    let (_, machines) = call_catalog_tool(&base_url, &catalog, name, &args)
        .await
        .unwrap_or_else(|error| {
            eprintln!("Error: {error}");
            process::exit(1);
        });
    if let Err(error) = print_json(&machines) {
        eprintln!("Error: {error}");
        process::exit(1);
    }
}
