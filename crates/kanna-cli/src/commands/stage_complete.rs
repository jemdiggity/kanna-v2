use std::env;
use std::process;

use serde_json::Value;

use crate::api::complete_stage_via_api;
use crate::commands::parse_metadata_json;
use crate::config::resolve_server_base_url;
use crate::models::CompleteStageRequest;

pub(crate) fn build_complete_stage_request(
    status: String,
    summary: String,
    metadata: Option<Value>,
    disposition: Option<String>,
) -> CompleteStageRequest {
    CompleteStageRequest {
        status,
        summary,
        metadata,
        disposition,
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
    disposition: Option<String>,
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
    if disposition
        .as_deref()
        .is_some_and(|value| !matches!(value, "needs_human_input" | "not_merge_candidate"))
    {
        eprintln!("Error: --disposition must be \"needs_human_input\" or \"not_merge_candidate\"");
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
    let request =
        build_complete_stage_request(status.clone(), summary.clone(), metadata_value, disposition);
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
