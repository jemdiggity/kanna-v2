use crate::daemon_client::DaemonClient;
use crate::db::Db;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use serde_json::Value;

pub async fn handle_invoke(
    command: &str,
    args: &Value,
    db: &Db,
    daemon: &mut DaemonClient,
) -> Result<Value, String> {
    match command {
        "list_repos" => {
            let repos = db.list_repos().map_err(|e| format!("db error: {}", e))?;
            serde_json::to_value(&repos).map_err(|e| format!("serialize error: {}", e))
        }
        "list_pipeline_items" => {
            let repo_id = args
                .get("repo_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: repo_id".to_string())?;
            let items = db
                .list_pipeline_items(repo_id)
                .map_err(|e| format!("db error: {}", e))?;
            serde_json::to_value(&items).map_err(|e| format!("serialize error: {}", e))
        }
        "get_pipeline_item" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: id".to_string())?;
            let item = db
                .get_pipeline_item(id)
                .map_err(|e| format!("db error: {}", e))?;
            serde_json::to_value(&item).map_err(|e| format!("serialize error: {}", e))
        }
        "list_sessions" => {
            let event = daemon
                .send_command(&DaemonCommand::List)
                .await
                .map_err(|e| format!("daemon error: {}", e))?;
            match event {
                DaemonEvent::SessionList { sessions } => {
                    serde_json::to_value(&sessions)
                        .map_err(|e| format!("serialize error: {}", e))
                }
                DaemonEvent::Error { message } => Err(format!("daemon error: {}", message)),
                other => Err(format!("unexpected daemon response: {:?}", other)),
            }
        }
        "send_input" => {
            let session_id = args
                .get("session_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: session_id".to_string())?;
            let data = args
                .get("data")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: data".to_string())?;
            let event = daemon
                .send_command(&DaemonCommand::Input {
                    session_id: session_id.to_string(),
                    data: data.as_bytes().to_vec(),
                })
                .await
                .map_err(|e| format!("daemon error: {}", e))?;
            match event {
                DaemonEvent::Ok => Ok(Value::Null),
                DaemonEvent::Error { message } => Err(format!("daemon error: {}", message)),
                other => Err(format!("unexpected daemon response: {:?}", other)),
            }
        }
        // Note: attach_session and detach_session are handled directly in main.rs
        // because they require long-lived daemon connections for streaming.
        "db_select" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: query".to_string())?;
            let bind_values = args
                .get("bind_values")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            db.select_raw(query, &bind_values)
                .map_err(|e| format!("db error: {}", e))
        }
        _ => Err(format!("unknown command: {}", command)),
    }
}
