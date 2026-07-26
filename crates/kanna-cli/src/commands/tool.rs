use std::env;
use std::process;

use kanna_tool_catalog::{
    load_catalog, resolve_request, Catalog, Method as CatalogMethod, ResolvedRequest, ResponseKind,
};
use serde_json::Value;

use crate::api::{
    get_json, get_text, patch_catalog_json, post_catalog_json, wait_catalog_task_via_api,
};
use crate::commands::print_json;
use crate::config::resolve_server_base_url_from_env;
use crate::ToolCommands;

pub(crate) fn load_tool_catalog_from_current_dir() -> Result<Catalog, String> {
    let cwd = env::current_dir().map_err(|e| format!("failed to read current directory: {e}"))?;
    let loaded = load_catalog(&cwd);
    if let Some(warning) = loaded.warning {
        eprintln!("Warning: {warning}");
    }
    Ok(loaded.catalog)
}

pub(crate) fn build_tool_call_args(
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

pub(crate) fn resolve_tool_request(
    catalog: &Catalog,
    name: &str,
    args: &Value,
    stage_run_id: Option<&str>,
) -> Result<ResolvedRequest, String> {
    let trusted_run_id = stage_run_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut validated_args = args.clone();
    if name == "kanna_complete_stage" && trusted_run_id.is_some() {
        if let Some(args) = validated_args.as_object_mut() {
            // Validate caller data against the loaded catalog without letting
            // an old override reject the current run_id parameter. The
            // process-owned value is injected after resolution.
            args.remove("run_id");
        }
    }
    let mut request = resolve_request(catalog, name, &validated_args)?;
    if name == "kanna_complete_stage" {
        if let Some(run_id) = trusted_run_id {
            let body = request
                .body
                .as_object_mut()
                .ok_or_else(|| "resolved tool request body must be a JSON object".to_string())?;
            body.insert("runId".to_string(), Value::String(run_id.to_string()));
        }
    }
    Ok(request)
}

pub(crate) async fn execute_catalog_request(
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
        (CatalogMethod::Patch, ResponseKind::Json) => {
            patch_catalog_json(base_url, &request.path, &request.body).await
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

pub(crate) async fn call_catalog_tool(
    base_url: &str,
    catalog: &Catalog,
    name: &str,
    args: &Value,
) -> Result<(ResponseKind, Value), String> {
    let stage_run_id = env::var("KANNA_STAGE_RUN_ID").ok();
    let request = resolve_tool_request(catalog, name, args, stage_run_id.as_deref())?;
    let kind = request.kind;
    let value = execute_catalog_request(base_url, request).await?;
    Ok((kind, value))
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
    }
}
