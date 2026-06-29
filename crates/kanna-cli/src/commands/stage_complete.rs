use std::env;
use std::process;

use rusqlite::Connection;
use serde_json::Value;

use crate::api::complete_stage_via_api;
use crate::commands::parse_metadata_json;
use crate::commands::socket::notify_socket;
use crate::config::{resolve_optional_server_base_url, resolve_stage_db_path_from_env};
use crate::models::CompleteStageRequest;

pub(crate) fn write_stage_result_to_db(
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

pub(crate) fn build_complete_stage_request(
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
    if let Some(base_url) = resolve_optional_server_base_url(&borrowed_pairs, server_url) {
        let request =
            build_complete_stage_request(status.clone(), summary.clone(), metadata_value.clone());
        let response = complete_stage_via_api(&base_url, &task_id, &request)
            .await
            .unwrap_or_else(|e| {
                eprintln!("Error: {e}");
                process::exit(1);
            });

        match env::var("KANNA_SOCKET_PATH") {
            Ok(socket_path) => {
                if let Err(e) = notify_socket(&socket_path, &task_id).await {
                    eprintln!("Warning: Socket notification failed: {e}");
                }
            }
            Err(_) => {
                eprintln!("Warning: KANNA_SOCKET_PATH not set, skipping socket notification");
            }
        }
        println!(
            "{}",
            render_stage_complete_confirmation(&task_id, &status, &response.task_id)
        );
        return;
    }

    // Build stage_result JSON
    let mut stage_result = serde_json::json!({ "status": status, "summary": summary });

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

    println!(
        "{}",
        render_stage_complete_confirmation(&task_id, &status, &task_id)
    );
}
