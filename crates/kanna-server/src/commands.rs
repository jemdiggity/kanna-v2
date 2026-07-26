use crate::config::Config;
use crate::daemon_client::DaemonClient;
use crate::db::Db;
use crate::mobile_api::MobileApi;
use crate::task_creator;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use serde_json::Value;

pub(crate) struct LegacyTaskActionRequest {
    pub method: &'static str,
    pub path: String,
    pub body: Value,
}

pub(crate) fn legacy_task_action_request(
    command: &str,
    args: &Value,
) -> Result<Option<LegacyTaskActionRequest>, String> {
    let action = match command {
        "close_task" => "close",
        "advance_stage" => "advance-stage",
        _ => return Ok(None),
    };
    let task_id = args
        .get("task_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing required arg: task_id".to_string())?;
    Ok(Some(LegacyTaskActionRequest {
        method: "POST",
        path: format!(
            "/v1/tasks/{}/actions/{action}",
            kanna_tool_catalog::encode_path_segment(task_id)
        ),
        body: Value::Null,
    }))
}

pub async fn handle_invoke(
    command: &str,
    args: &Value,
    db: &Db,
    daemon: &mut DaemonClient,
    config: &Config,
) -> Result<Value, String> {
    let mobile_api = || {
        Db::open(&config.db_path)
            .map(|db| MobileApi::new(config.clone(), db))
            .map_err(|e| format!("db error: {}", e))
    };

    match command {
        "list_desktops" => {
            let api = mobile_api()?;
            serde_json::to_value(api.list_desktops()?)
                .map_err(|e| format!("serialize error: {}", e))
        }
        "list_repos" => {
            let repos = db.list_repos().map_err(|e| format!("db error: {}", e))?;
            serde_json::to_value(&repos).map_err(|e| format!("serialize error: {}", e))
        }
        "list_recent_tasks" => {
            let api = mobile_api()?;
            serde_json::to_value(api.list_recent_tasks()?)
                .map_err(|e| format!("serialize error: {}", e))
        }
        "search_tasks" => {
            let api = mobile_api()?;
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: query".to_string())?;
            serde_json::to_value(api.search_tasks(query)?)
                .map_err(|e| format!("serialize error: {}", e))
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
                DaemonEvent::SessionList { sessions, .. } => {
                    serde_json::to_value(&sessions).map_err(|e| format!("serialize error: {}", e))
                }
                DaemonEvent::Error { message, .. } => Err(format!("daemon error: {}", message)),
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
                DaemonEvent::Error { message, .. } => Err(format!("daemon error: {}", message)),
                other => Err(format!("unexpected daemon response: {:?}", other)),
            }
        }
        "resize_session" => {
            let session_id = args
                .get("session_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: session_id".to_string())?;
            let cols = args
                .get("cols")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| "missing required arg: cols".to_string())?;
            let rows = args
                .get("rows")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| "missing required arg: rows".to_string())?;
            let event = daemon
                .send_command(&DaemonCommand::Resize {
                    session_id: session_id.to_string(),
                    cols: cols.min(u16::MAX as u64) as u16,
                    rows: rows.min(u16::MAX as u64) as u16,
                })
                .await
                .map_err(|e| format!("daemon error: {}", e))?;
            match event {
                DaemonEvent::Ok => Ok(Value::Null),
                DaemonEvent::Error { message, .. } => Err(format!("daemon error: {}", message)),
                other => Err(format!("unexpected daemon response: {:?}", other)),
            }
        }
        "run_merge_agent" => {
            let task_id = args
                .get("task_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: task_id".to_string())?;
            let new_task_id = task_creator::run_merge_agent(db, daemon, config, task_id).await?;
            Ok(serde_json::json!({ "task_id": new_task_id }))
        }
        // Note: observe_session and unobserve_session are handled directly in main.rs
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_task_mutations_map_to_shared_http_actions() {
        let close =
            legacy_task_action_request("close_task", &serde_json::json!({ "task_id": "task/a" }))
                .unwrap()
                .unwrap();
        assert_eq!(close.method, "POST");
        assert_eq!(close.path, "/v1/tasks/task%2Fa/actions/close");
        assert_eq!(close.body, Value::Null);

        let advance = legacy_task_action_request(
            "advance_stage",
            &serde_json::json!({ "task_id": "task-1" }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(advance.path, "/v1/tasks/task-1/actions/advance-stage");
    }

    #[test]
    fn non_task_legacy_commands_stay_on_the_daemon_path() {
        assert!(legacy_task_action_request("list_sessions", &Value::Null)
            .unwrap()
            .is_none());
    }
}
