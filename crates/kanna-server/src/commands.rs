use crate::config::Config;
use crate::daemon_client::DaemonClient;
use crate::db::Db;
use crate::mobile_api::MobileApi;
use crate::session_replacements::SessionReplacements;
use crate::task_creator;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use serde_json::Value;

pub async fn handle_invoke(
    command: &str,
    args: &Value,
    db: &Db,
    daemon: &mut DaemonClient,
    config: &Config,
    replacements: &SessionReplacements,
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
                DaemonEvent::SessionList { sessions } => {
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
        "close_task" => {
            let task_id = args
                .get("task_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: task_id".to_string())?;
            let pipeline_item_id = db
                .resolve_pipeline_item_id(task_id)
                .map_err(|e| format!("db error: {}", e))?
                .ok_or_else(|| format!("task not found: {task_id}"))?;

            for session_id in [
                pipeline_item_id.to_string(),
                format!("shell-wt-{pipeline_item_id}"),
                format!("td-{pipeline_item_id}"),
            ] {
                task_creator::kill_session_replacing(daemon, replacements, &session_id).await?;
            }

            db.close_pipeline_item(&pipeline_item_id)
                .map_err(|e| format!("db error: {}", e))?;
            Ok(Value::Null)
        }
        "advance_stage" => {
            let task_id = args
                .get("task_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing required arg: task_id".to_string())?;
            let transition = {
                let db = Db::open(&config.db_path).map_err(|e| format!("db error: {}", e))?;
                task_creator::prepare_advance_stage_for_api(&db, config, task_id)?
            };
            match transition {
                task_creator::PreparedStageTransition::Run(prepared) => {
                    let advanced = task_creator::spawn_prepared_stage_run_for_api(
                        &config.db_path,
                        daemon,
                        replacements,
                        *prepared,
                    )
                    .await?;
                    serde_json::to_value(advanced).map_err(|e| format!("serialize error: {}", e))
                }
                task_creator::PreparedStageTransition::Post(prepared) => {
                    let dispatched = task_creator::dispatch_prepared_post_for_api(
                        &config.db_path,
                        daemon,
                        replacements,
                        *prepared,
                    )
                    .await?;
                    serde_json::to_value(dispatched).map_err(|e| format!("serialize error: {}", e))
                }
                task_creator::PreparedStageTransition::Close { task_id } => {
                    for session_id in [
                        task_id.to_string(),
                        format!("shell-wt-{task_id}"),
                        format!("td-{task_id}"),
                    ] {
                        task_creator::kill_session_replacing(daemon, replacements, &session_id)
                            .await?;
                    }
                    let db = Db::open(&config.db_path).map_err(|e| format!("db error: {}", e))?;
                    db.close_pipeline_item(&task_id)
                        .map_err(|e| format!("db error: {}", e))?;
                    Ok(serde_json::json!({ "task_id": task_id, "followTask": false }))
                }
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
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    fn daemon_socket_path_for_dir(daemon_dir: &str) -> std::path::PathBuf {
        kanna_runtime_defaults::socket_path(std::path::Path::new(daemon_dir))
    }

    fn test_config(unique: &str, db_path: String, daemon_dir: String) -> Config {
        Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir,
            db_path,
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            local_host: "127.0.0.1".to_string(),
            local_port: 0,
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: format!("/tmp/kanna-pairings-command-close-{unique}.json"),
        }
    }

    #[tokio::test]
    async fn close_task_invoke_resolves_branch_style_task_id_and_kills_canonical_sessions() {
        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("kanna-command-close-daemon-{unique}"));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);
        let daemon_listener = UnixListener::bind(&socket_path).unwrap();

        let db_path = Db::test_db_path(&format!("command-close-branch-{unique}"));
        let db = Db::open_for_tests(&db_path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "710917fb",
            "repo-1",
            "Close this branch-style task",
            Some("Close this branch-style task"),
            "in progress",
            "2026-05-11 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "710917fb",
            "task-710917fb",
            "default",
            None,
            "claude",
        )
        .unwrap();

        let daemon_db_path = db_path.clone();
        let daemon_server = tokio::spawn(async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let expected = ["710917fb", "shell-wt-710917fb", "td-710917fb"];

            for expected_session_id in expected {
                let item = Db::open(&daemon_db_path)
                    .expect("open db from daemon assertion")
                    .get_task_stage_source("710917fb")
                    .expect("read task before kill")
                    .expect("task exists before kill");
                assert_eq!(
                    item.stage.as_deref(),
                    Some("in progress"),
                    "close_task marked the DB row done before killing {expected_session_id}"
                );
                assert!(
                    item.closed_at.is_none(),
                    "close_task set closed_at before killing {expected_session_id}"
                );

                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
                match command {
                    DaemonCommand::Kill { session_id } => {
                        assert_eq!(session_id, expected_session_id)
                    }
                    other => panic!("expected kill command, got {:?}", other),
                }
                write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });

        let mut daemon = DaemonClient::connect(&daemon_dir.to_string_lossy())
            .await
            .expect("connect fake daemon");
        let config = test_config(
            &unique,
            db_path.clone(),
            daemon_dir.to_string_lossy().to_string(),
        );

        let result = handle_invoke(
            "close_task",
            &serde_json::json!({ "task_id": "task-710917fb" }),
            &db,
            &mut daemon,
            &config,
            &SessionReplacements::default(),
        )
        .await
        .expect("close task invoke");

        assert_eq!(result, Value::Null);
        daemon_server.await.unwrap();

        let item = db.get_task_stage_source("710917fb").unwrap().unwrap();
        assert_eq!(item.stage.as_deref(), Some("in progress"));
        assert!(item.closed_at.is_some());

        // Full app E2E for the original untitled-task close regression would need a
        // running Tauri desktop instance, seeded task/worktree state, and daemon
        // sidecars. This command-boundary test keeps the legacy relay command,
        // SQLite persistence, and daemon socket cleanup in scope without relying on
        // an installed desktop runtime.
        let _ = std::fs::remove_dir_all(daemon_dir);
        let _ = std::fs::remove_file(db_path);
    }
}
