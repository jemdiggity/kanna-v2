use std::path::PathBuf;

use tauri::{Emitter, Manager};
use tokio::io::AsyncBufReadExt;

use crate::{daemon_data_dir, WorkflowSocketState};

/// Compute the kanna.sock path for workflow completion notifications.
/// Uses a hashed /tmp path to stay under macOS SUN_LEN (104 bytes).
/// The legacy `pipeline` directory remains part of the cross-version socket
/// contract; only the product-facing command and symbols use workflow.
fn workflow_socket_path() -> PathBuf {
    let dir = daemon_data_dir().join("pipeline");
    kanna_runtime_defaults::socket_path(&dir)
}

/// Spawn a Unix socket listener at kanna.sock that accepts stage-complete
/// notifications from kanna-cli. Each connection sends a single JSON line;
/// we parse it and emit a Tauri event so the frontend can react.
pub(crate) fn spawn_workflow_listener(app: &tauri::AppHandle) {
    let socket_path = workflow_socket_path();

    // Store the path in managed state so the frontend can retrieve it
    let state: tauri::State<'_, WorkflowSocketState> = app.state();
    {
        let path_str = socket_path.to_string_lossy().to_string();
        let state_inner = state.inner().clone();
        tauri::async_runtime::block_on(async {
            *state_inner.lock().await = Some(path_str);
        });
    }

    // Remove stale socket file if it exists
    if socket_path.exists() {
        if let Err(e) = std::fs::remove_file(&socket_path) {
            eprintln!(
                "[workflow-listener] failed to remove stale socket {:?}: {}",
                socket_path, e
            );
        }
    }

    // Ensure the parent directory exists
    if let Some(parent) = socket_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!(
                "[workflow-listener] failed to create directory {:?}: {}",
                parent, e
            );
            return;
        }
    }

    let app_handle = app.clone();
    let path = socket_path.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[workflow-listener] failed to bind {:?}: {}", path, e);
                return;
            }
        };

        eprintln!("[workflow-listener] listening on {:?}", path);

        loop {
            let (stream, _) = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) => {
                    eprintln!("[workflow-listener] accept error: {}", e);
                    continue;
                }
            };

            let reader = tokio::io::BufReader::new(stream);
            let mut lines = reader.lines();

            match lines.next_line().await {
                Ok(Some(line)) => {
                    let parsed: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("[workflow-listener] invalid JSON: {} — {:?}", e, line);
                            continue;
                        }
                    };

                    let msg_type = parsed.get("type").and_then(|t| t.as_str());
                    let task_id = parsed.get("task_id").and_then(|t| t.as_str());

                    if msg_type == Some("stage_complete") {
                        if let Some(tid) = task_id {
                            eprintln!("[workflow-listener] stage_complete for task {}", tid);
                            let _ = app_handle.emit(
                                "workflow_stage_complete",
                                serde_json::json!({ "task_id": tid }),
                            );
                            let _ = app_handle.emit(
                                "pipeline_stage_complete",
                                serde_json::json!({ "task_id": tid }),
                            );
                        } else {
                            eprintln!("[workflow-listener] stage_complete missing task_id");
                        }
                    }
                }
                Ok(None) => {
                    // Connection closed without sending data
                }
                Err(e) => {
                    eprintln!("[workflow-listener] read error: {}", e);
                }
            }
            // Connection is dropped/closed here automatically
        }
    });
}
