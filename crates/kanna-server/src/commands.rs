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

pub(crate) fn resolve_legacy_terminal_session_id(
    db: &Db,
    caller_alias: &str,
) -> Result<String, String> {
    db.resolve_task_terminal_session_id(caller_alias)
        .map_err(|error| format!("db error: {error}"))
        .map(|resolved| resolved.unwrap_or_else(|| caller_alias.to_string()))
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
            let caller_alias = args
                .get("session_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: session_id".to_string())?;
            let session_id = resolve_legacy_terminal_session_id(db, caller_alias)?;
            let data = args
                .get("data")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: data".to_string())?;
            let event = daemon
                .send_command(&DaemonCommand::Input {
                    session_id,
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
            let caller_alias = args
                .get("session_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: session_id".to_string())?;
            let session_id = resolve_legacy_terminal_session_id(db, caller_alias)?;
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
                    session_id,
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

    #[tokio::test]
    async fn legacy_terminal_alias_resolves_the_current_run_session() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let unique = format!(
            "legacy-terminal-alias-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut commands = Vec::new();
            for _ in 0..2 {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                commands.push(
                    serde_json::from_str::<DaemonCommand>(line.trim())
                        .expect("parse daemon command"),
                );
                write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            commands
        });

        let db_path = Db::test_db_path(&unique);
        let db = Db::open_for_tests(&db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-legacy",
            "repo-1",
            "Legacy terminal alias",
            None,
            "in progress",
            "2026-07-26 00:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-legacy",
            "task-task-legacy-1",
            "default",
            None,
            "codex",
        )
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-legacy",
            task_id: "task-legacy",
            stage: "in progress",
            kind: "main",
            agent: None,
            agent_provider: Some("codex"),
            model: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("run-legacy-current"),
            provider_session_id: Some("provider-legacy"),
            cwd: Some("/tmp/task-legacy"),
            resumed_from_run_id: None,
        })
        .unwrap();
        let config = Config {
            relay_url: String::new(),
            device_token: String::new(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path,
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: None,
            desktop_name: "Test Desktop".to_string(),
            version: "test".to_string(),
            environment: "development".to_string(),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
        };
        let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();

        handle_invoke(
            "send_input",
            &serde_json::json!({
                "session_id": "task-legacy",
                "data": "hello"
            }),
            &db,
            &mut daemon,
            &config,
        )
        .await
        .unwrap();
        handle_invoke(
            "resize_session",
            &serde_json::json!({
                "session_id": "task-task-legacy-1",
                "cols": 100,
                "rows": 40
            }),
            &db,
            &mut daemon,
            &config,
        )
        .await
        .unwrap();

        let commands = server.await.unwrap();
        assert!(matches!(
            &commands[0],
            DaemonCommand::Input { session_id, .. } if session_id == "run-legacy-current"
        ));
        assert!(matches!(
            &commands[1],
            DaemonCommand::Resize { session_id, .. } if session_id == "run-legacy-current"
        ));

        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }
}
