use super::*;

#[tokio::test]
async fn run_merge_agent_route_uses_merge_agent_runner() {
    let app = super::test_router_with_merge_agent_runner(
        "desktop-1",
        "Studio Mac",
        Arc::new(|task_id| {
            Ok(TaskActionResponse {
                task_id: format!("merge-{task_id}"),
                follow_task: None,
            })
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/run-merge-agent")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: TaskActionResponse = from_slice(&body).unwrap();
    assert_eq!(created.task_id, "merge-task-1");
}

#[test]
fn task_input_message_strips_trailing_terminators() {
    // The Enter is synthesized separately, so the message carries no
    // terminator regardless of what the caller appended.
    assert_eq!(super::task_input_message("continue"), "continue");
    assert_eq!(super::task_input_message("continue\n"), "continue");
    assert_eq!(super::task_input_message("continue\r"), "continue");
    assert_eq!(super::task_input_message("continue\r\n\n"), "continue");
    assert_eq!(super::task_input_message(""), "");
    // Internal newlines are preserved (only trailing ones are stripped).
    assert_eq!(super::task_input_message("a\nb\n"), "a\nb");
}

#[tokio::test]
async fn send_task_input_route_uses_input_sender() {
    let app = super::test_router_with_task_input_sender(
        "desktop-1",
        "Studio Mac",
        Arc::new(|task_id, input| {
            assert_eq!(task_id, "task-1");
            assert_eq!(input, "continue");
            Ok(())
        }),
    );

    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "input": "continue"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn submit_task_input_sends_text_then_enter_as_discrete_inputs() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "kanna-submit-input-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let daemon_dir = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut inputs = Vec::new();
        for _ in 0..2 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            match command {
                DaemonCommand::Input { session_id, data } => {
                    assert_eq!(session_id, "task-target");
                    inputs.push(data);
                }
                other => panic!("expected Input command, got {other:?}"),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }
        inputs
    });

    let mut daemon = crate::daemon_client::DaemonClient::connect(&daemon_dir.to_string_lossy())
        .await
        .unwrap();
    super::submit_task_input(&mut daemon, "task-target", "hello\n")
        .await
        .unwrap();
    let inputs = server.await.unwrap();

    assert_eq!(inputs, vec![b"hello".to_vec(), vec![b'\r']]);

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
}

#[tokio::test]
async fn terminal_state_notification_sends_once_to_notify_target() {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let unique = format!(
        "kanna-notify-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut inputs = Vec::new();
        for _ in 0..2 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            match command {
                DaemonCommand::Input { session_id, data } => {
                    assert_eq!(session_id, "task-parent");
                    inputs.push(data);
                }
                other => panic!("expected Input command, got {other:?}"),
            }
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
        }
        inputs
    });

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
        firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(&unique),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-child",
        "repo-1",
        "Child prompt first line\nsecond line",
        Some("Child Display"),
        "in progress",
        "2026-04-18 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_notify_task("task-child", "task-parent")
        .unwrap();
    drop(db);

    super::handle_task_terminal_state(&config, "task-child", true)
        .await
        .unwrap();
    let inputs = server.await.unwrap();
    assert_eq!(
        inputs,
        vec![
            b"TASK task-child DONE [success]: Child Display".to_vec(),
            vec![b'\r']
        ]
    );

    super::handle_task_terminal_state(&config, "task-child", true)
        .await
        .unwrap();
    let db = Db::open(&config.db_path).unwrap();
    let task = db.get_pipeline_item("task-child").unwrap().unwrap();
    assert_eq!(task.activity.as_deref(), Some("unread"));
    assert!(task.notified_at.is_some());

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
}
