use std::env;
use std::process;

use serde_json::Value;

use crate::api::complete_stage_via_api;
use crate::commands::parse_metadata_json;
use crate::config::resolve_server_base_url;
use crate::models::CompleteStageRequest;

pub(crate) fn build_complete_stage_request(
    run_id: Option<String>,
    completion_attempt_key: Option<String>,
    status: String,
    summary: String,
    metadata: Option<Value>,
) -> CompleteStageRequest {
    CompleteStageRequest {
        run_id,
        completion_attempt_key,
        status,
        summary,
        metadata,
    }
}

pub(crate) fn render_stage_complete_confirmation(
    task_id: &str,
    status: &str,
    response_task_id: &str,
) -> String {
    if response_task_id != task_id {
        return format!(
            "Stage completion recorded for task {task_id} (status: {status}); advanced to task {response_task_id}."
        );
    }

    format!("Stage completion recorded for task {task_id} (status: {status}).")
}

pub(crate) async fn run(
    task_id: String,
    status: String,
    summary: String,
    metadata: Option<String>,
    server_url: Option<&str>,
) {
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
    let base_url = resolve_server_base_url(&borrowed_pairs, server_url);
    let mut request =
        build_complete_stage_request(None, None, status.clone(), summary.clone(), metadata_value);
    bind_completion_request(&base_url, &task_id, &mut request)
        .await
        .unwrap_or_else(|error| {
            eprintln!("Error: {error}");
            process::exit(1);
        });
    let response = complete_stage_via_api(&base_url, &task_id, &request)
        .await
        .unwrap_or_else(|e| {
            eprintln!("Error: {e}");
            process::exit(1);
        });
    println!(
        "{}",
        render_stage_complete_confirmation(&task_id, &status, &response.task_id)
    );
}

async fn bind_completion_request(
    _base_url: &str,
    _task_id: &str,
    request: &mut CompleteStageRequest,
) -> Result<(), String> {
    let body = serde_json::to_value(&*request)
        .map_err(|error| format!("failed to encode completion request: {error}"))?;
    let attempt_key = kanna_tool_catalog::completion_attempt_key(&body)?;
    if let Some(path) = env::var_os(kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV) {
        let path = std::path::PathBuf::from(path);
        let context = kanna_tool_catalog::read_completion_context(&path)?;
        request.run_id = Some(
            context
                .run_for_attempt(&attempt_key)
                .unwrap_or(&context.run_id)
                .to_string(),
        );
    } else if let Ok(run_id) = env::var(kanna_tool_catalog::KANNA_STAGE_RUN_ID_ENV) {
        if !run_id.trim().is_empty() {
            request.run_id = Some(run_id);
        }
    }
    request.completion_attempt_key = Some(attempt_key);
    Ok(())
}
