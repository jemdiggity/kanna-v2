//! `POST /v1/tasks/{id}/raw-input` against a scripted daemon socket.
//!
//! These assert the exact bytes and the exact order that leave the server, the
//! composer class each write declares, and that no failure is ever reported as
//! a success or recorded as owner speech. The bytes themselves reaching a real
//! PTY is proven separately, against a real daemon and a real shell, in
//! `crates/daemon/tests/reconnect.rs`.

use super::*;
use kanna_daemon::protocol::{
    Command as DaemonCommand, ErrorCode, Event as DaemonEvent, RawInputClass, SessionInfo,
    SessionState, SessionStatus,
};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

fn raw_input_test_config(unique: &str, daemon_dir: &Path) -> Config {
    Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: Db::test_db_path(unique),
        kanna_cli_path: None,
        desktop_id: "desktop-raw-input".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
    }
}

fn live_session(task_id: &str, pid: u32) -> SessionInfo {
    SessionInfo {
        session_id: task_id.to_string(),
        pid,
        cwd: "/tmp".to_string(),
        state: SessionState::Active,
        idle_seconds: 0,
        status: SessionStatus::Waiting,
        kind: Default::default(),
        logical_input_blocked: false,
        pending_logical_input_count: None,
        composer_text: None,
        composer_attestation: Default::default(),
    }
}

fn seed_live_task(config: &Config, task_id: &str) {
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        task_id,
        "repo-1",
        "Raw input task",
        Some("Raw input task"),
        "in progress",
        "2026-09-05 04:00:00",
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-live",
        task_id,
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some(task_id),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    drop(db);
}

/// Read the `task.raw_input_delivered` payloads a task accumulated.
fn raw_input_events(config: &Config, task_id: &str) -> Vec<serde_json::Value> {
    let db = Db::open(&config.db_path).unwrap();
    let head = db.latest_task_event_seq().unwrap();
    db.list_task_events(
        &crate::db::TaskEventScope::Tasks(vec![task_id.to_string()]),
        0,
        head,
        100,
    )
    .unwrap()
    .into_iter()
    .filter(|event| event.event_type == "task.raw_input_delivered")
    .map(|event| event.payload)
    .collect()
}

fn cleanup(config: &Config, socket_path: &Path, daemon_dir: &Path) {
    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
    let _ = std::fs::remove_file(&config.db_path);
}

struct ScriptedDaemon {
    daemon_dir: PathBuf,
    socket_path: PathBuf,
    listener: UnixListener,
}

fn scripted_daemon(unique: &str) -> ScriptedDaemon {
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    std::fs::create_dir_all(&daemon_dir).unwrap();
    let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
    let listener = UnixListener::bind(&socket_path).unwrap();
    ScriptedDaemon {
        daemon_dir,
        socket_path,
        listener,
    }
}

/// The 2026-09-05 incident, driven through the supported surface: Down, then
/// Enter, at the exact bytes and in that order, each fenced to the PTY pid the
/// discovery `List` observed — and Enter carrying the submission class that
/// `InputIfSession` could not express.
#[tokio::test]
async fn named_keys_write_exact_bytes_in_order_fenced_to_the_observed_pid() {
    let unique = format!("raw-input-ordered-{}", unique_test_suffix());
    let daemon = scripted_daemon(&unique);
    let listener = daemon.listener;
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 3 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: vec![live_session("spike362c3351", 42133)],
                },
                DaemonCommand::RawInputIfSession { .. } => DaemonEvent::Ok,
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = raw_input_test_config(&unique, &daemon.daemon_dir);
    seed_live_task(&config, "spike362c3351");

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/spike362c3351/raw-input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "keys": ["down", "enter"], "source": "operator" })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({
            "status": "written",
            "taskId": "spike362c3351",
            "sessionPid": 42133,
            "writes": [
                { "index": 0, "key": "down", "bytes": "1b5b42", "class": "draft", "status": "written" },
                { "index": 1, "key": "enter", "bytes": "0d", "class": "submission", "status": "written" }
            ]
        })
    );

    let commands = daemon_server.await.unwrap();
    // Discovery first, then the two writes in the order they were named. The
    // server serializes the second only after the daemon has acknowledged the
    // first, which is what makes the ordering a property of the protocol
    // rather than of the socket's buffering.
    match commands.as_slice() {
        [DaemonCommand::List, DaemonCommand::RawInputIfSession {
            session_id: first_session,
            expected_pid: 42133,
            data: first,
            class: RawInputClass::Draft,
        }, DaemonCommand::RawInputIfSession {
            session_id: second_session,
            expected_pid: 42133,
            data: second,
            class: RawInputClass::Submission,
        }] => {
            assert_eq!(first_session, "spike362c3351");
            assert_eq!(second_session, "spike362c3351");
            // Exactly the bytes the manager sent by hand over the raw socket.
            assert_eq!(first, &vec![27, 91, 66]);
            assert_eq!(second, &vec![13]);
        }
        other => panic!("unexpected daemon command sequence: {other:?}"),
    }

    // Not owner speech: no instruction-history row, and the action announced
    // where actions are announced.
    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(db.count_task_inputs("spike362c3351").unwrap(), 0);
    drop(db);
    let events = raw_input_events(&config, "spike362c3351");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["status"], "written");
    assert_eq!(events[0]["source"], "operator");
    assert_eq!(events[0]["sessionPid"], 42133);
    assert_eq!(events[0]["runId"], "run-live");
    assert_eq!(events[0]["writes"][0]["bytes"], "1b5b42");
    assert_eq!(events[0]["writes"][1]["bytes"], "0d");
    assert_eq!(events[0]["writes"][1]["class"], "submission");

    cleanup(&config, &daemon.socket_path, &daemon.daemon_dir);
}

/// A bare Escape is one draft-class write of one byte, with nothing appended.
/// The route adds no CR of its own — that is the whole difference from
/// `POST /v1/tasks/{id}/input`.
#[tokio::test]
async fn escape_is_one_draft_write_and_no_newline_is_appended() {
    let unique = format!("raw-input-escape-{}", unique_test_suffix());
    let daemon = scripted_daemon(&unique);
    let listener = daemon.listener;
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 2 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: vec![live_session("task-escape", 7)],
                },
                DaemonCommand::RawInputIfSession { .. } => DaemonEvent::Ok,
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = raw_input_test_config(&unique, &daemon.daemon_dir);
    seed_live_task(&config, "task-escape");

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-escape/raw-input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "keys": ["escape"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    match daemon_server.await.unwrap().as_slice() {
        [DaemonCommand::List, DaemonCommand::RawInputIfSession {
            data,
            class: RawInputClass::Draft,
            ..
        }] => assert_eq!(data, &vec![0x1b]),
        other => panic!("unexpected daemon command sequence: {other:?}"),
    }

    cleanup(&config, &daemon.socket_path, &daemon.daemon_dir);
}

/// Explicit bytes go out verbatim, as one draft-class write, with nothing
/// added and nothing interpreted on the way.
#[tokio::test]
async fn explicit_bytes_are_written_verbatim_with_nothing_appended() {
    let unique = format!("raw-input-bytes-{}", unique_test_suffix());
    let daemon = scripted_daemon(&unique);
    let listener = daemon.listener;
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 2 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: vec![live_session("task-bytes", 9)],
                },
                DaemonCommand::RawInputIfSession { .. } => DaemonEvent::Ok,
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = raw_input_test_config(&unique, &daemon.daemon_dir);
    seed_live_task(&config, "task-bytes");

    // The SS3 application-cursor form of Down — precisely the case the named
    // vocabulary refuses to guess at, sent explicitly instead.
    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-bytes/raw-input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "bytes": "1b4f42" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    assert_eq!(body["writes"][0]["key"], serde_json::Value::Null);
    assert_eq!(body["writes"][0]["bytes"], "1b4f42");

    match daemon_server.await.unwrap().as_slice() {
        [DaemonCommand::List, DaemonCommand::RawInputIfSession {
            data,
            class: RawInputClass::Draft,
            ..
        }] => assert_eq!(data, &vec![0x1b, 0x4f, 0x42]),
        other => panic!("unexpected daemon command sequence: {other:?}"),
    }

    cleanup(&config, &daemon.socket_path, &daemon.daemon_dir);
}

/// A carriage return through `bytes` is refused before the daemon is contacted
/// at all.
///
/// Submission is a producer's declaration and the daemon's typed-byte ledger is
/// built on that: an undeclared CR would be counted as composer content while
/// the CLI it reached had already submitted the line, so every later delivered
/// message would be held behind a draft that no longer existed.
#[tokio::test]
async fn a_carriage_return_in_explicit_bytes_is_refused_without_touching_the_daemon() {
    let unique = format!("raw-input-cr-{}", unique_test_suffix());
    let daemon = scripted_daemon(&unique);
    let listener = daemon.listener;
    let daemon_server = tokio::spawn(async move {
        // Nothing may connect. If the handler contacts the daemon at all, this
        // accept resolves and the assertion below fails.
        let _ = listener.accept().await;
        true
    });

    let config = raw_input_test_config(&unique, &daemon.daemon_dir);
    seed_live_task(&config, "task-cr");

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-cr/raw-input")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({ "bytes": "0d" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    assert_eq!(body["reason"], "invalid_raw_input");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("keys: [\"enter\"]"),
        "{body}"
    );
    assert_eq!(body["retryable"], false);

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), daemon_server)
            .await
            .is_err(),
        "a rejected request must not reach the daemon"
    );
    assert!(raw_input_events(&config, "task-cr").is_empty());

    cleanup(&config, &daemon.socket_path, &daemon.daemon_dir);
}

/// The fence doing its job: the session the discovery observed has been
/// replaced, and the first key is refused rather than typed into whatever took
/// its place. Nothing was written, so this is a plain conflict — not the
/// uncertain verdict a part-way failure earns.
#[tokio::test]
async fn a_replaced_session_refuses_the_first_key_and_reports_nothing_written() {
    let unique = format!("raw-input-replaced-{}", unique_test_suffix());
    let daemon = scripted_daemon(&unique);
    let listener = daemon.listener;
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 2 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: vec![live_session("task-replaced", 42133)],
                },
                DaemonCommand::RawInputIfSession { .. } => DaemonEvent::Error {
                    code: Some(ErrorCode::SessionIncarnationMismatch),
                    message: "session incarnation changed for task-replaced: expected pid 42133, found 51002"
                        .to_string(),
                },
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = raw_input_test_config(&unique, &daemon.daemon_dir);
    seed_live_task(&config, "task-replaced");

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-replaced/raw-input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "keys": ["down", "enter"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    assert_eq!(body["ok"], false);
    assert_eq!(body["reason"], "no_live_agent_session");
    assert_eq!(body["retryable"], false);
    assert_eq!(body["writes"][0]["status"], "not_written");
    assert_eq!(body["writes"][1]["status"], "not_written");

    // The second key is never attempted: the sequence stops at the fence.
    assert_eq!(daemon_server.await.unwrap().len(), 2);

    let events = raw_input_events(&config, "task-replaced");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["status"], "no_live_agent_session");
    assert_eq!(events[0]["writes"][0]["status"], "not_written");

    cleanup(&config, &daemon.socket_path, &daemon.daemon_dir);
}

/// A burst that stops after its first key is uncertain, not failed: those
/// bytes are in somebody's terminal. The answer says which key landed and that
/// resending would type it twice.
#[tokio::test]
async fn a_sequence_that_stops_part_way_reports_which_keys_landed_and_is_never_retryable() {
    let unique = format!("raw-input-partial-{}", unique_test_suffix());
    let daemon = scripted_daemon(&unique);
    let listener = daemon.listener;
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 3 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match (&command, commands.len()) {
                (DaemonCommand::List, _) => DaemonEvent::SessionList {
                    sessions: vec![live_session("task-partial", 5150)],
                },
                (DaemonCommand::RawInputIfSession { .. }, 1) => DaemonEvent::Ok,
                (DaemonCommand::RawInputIfSession { .. }, _) => DaemonEvent::Error {
                    code: Some(ErrorCode::WriteFailed),
                    message: "input write failed for session: task-partial".to_string(),
                },
                (other, _) => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = raw_input_test_config(&unique, &daemon.daemon_dir);
    seed_live_task(&config, "task-partial");

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-partial/raw-input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "keys": ["down", "enter"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    assert_eq!(body["reason"], "delivery_uncertain");
    assert_eq!(body["retryable"], false);
    assert_eq!(body["sessionPid"], 5150);
    assert_eq!(body["writes"][0]["key"], "down");
    assert_eq!(body["writes"][0]["status"], "written");
    assert_eq!(body["writes"][1]["key"], "enter");
    assert_eq!(body["writes"][1]["status"], "uncertain");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("resending would type the keys twice"),
        "an uncertain answer must say not to retry: {body}"
    );

    assert_eq!(daemon_server.await.unwrap().len(), 3);

    // An audit trail that only holds the clean cases is wrong about exactly
    // the case somebody will need to reconstruct.
    let events = raw_input_events(&config, "task-partial");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["status"], "delivery_uncertain");
    assert_eq!(events[0]["writes"][0]["status"], "written");
    assert_eq!(events[0]["writes"][1]["status"], "uncertain");

    // Still not owner speech, even part-way through.
    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(db.count_task_inputs("task-partial").unwrap(), 0);
    drop(db);

    cleanup(&config, &daemon.socket_path, &daemon.daemon_dir);
}

/// A protected session accepts only kernel-authenticated operator input, and
/// the raw route does not become a way around that.
#[tokio::test]
async fn a_protected_session_refuses_raw_keys() {
    let unique = format!("raw-input-protected-{}", unique_test_suffix());
    let daemon = scripted_daemon(&unique);
    let listener = daemon.listener;
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 2 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: vec![live_session("task-protected", 11)],
                },
                DaemonCommand::RawInputIfSession { .. } => DaemonEvent::Error {
                    code: Some(ErrorCode::InputUnauthorized),
                    message: "session requires authenticated operator input: task-protected"
                        .to_string(),
                },
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = raw_input_test_config(&unique, &daemon.daemon_dir);
    seed_live_task(&config, "task-protected");

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-protected/raw-input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "keys": ["enter"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    assert_eq!(body["reason"], "session_operator_input_only");
    assert_eq!(body["writes"][0]["status"], "not_written");

    assert_eq!(daemon_server.await.unwrap().len(), 2);
    cleanup(&config, &daemon.socket_path, &daemon.daemon_dir);
}

/// No live PTY session means no terminal to type into, and the answer says so
/// without inventing an uncertain outcome.
#[tokio::test]
async fn no_live_session_writes_nothing() {
    let unique = format!("raw-input-no-session-{}", unique_test_suffix());
    let daemon = scripted_daemon(&unique);
    let listener = daemon.listener;
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.is_empty() {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList { sessions: vec![] },
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = raw_input_test_config(&unique, &daemon.daemon_dir);
    seed_live_task(&config, "task-no-session");

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-no-session/raw-input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "keys": ["enter"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    assert_eq!(body["reason"], "no_live_agent_session");
    assert_eq!(daemon_server.await.unwrap().len(), 1);
    assert!(raw_input_events(&config, "task-no-session").is_empty());

    cleanup(&config, &daemon.socket_path, &daemon.daemon_dir);
}

/// A daemon that predates the fenced raw-input contract cannot decode the
/// command and closes the connection without answering — indistinguishable, at
/// the socket, from one that died mid-write. So the capability is asked for
/// first, by a command with no session and no side effect, and its refusal is
/// reported as "nothing was written" rather than as an uncertain delivery.
#[tokio::test]
async fn an_older_daemon_refuses_before_anything_is_written() {
    let unique = format!("raw-input-old-daemon-{}", unique_test_suffix());
    let daemon = scripted_daemon(&unique);
    let listener = daemon.listener;
    let daemon_server = tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;

        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        // What an older daemon does with a variant it cannot deserialize: log
        // and drop the connection, with no reply of any kind.
        drop(write_half);
        line
    });

    let config = raw_input_test_config(&unique, &daemon.daemon_dir);
    seed_live_task(&config, "task-old-daemon");

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-old-daemon/raw-input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "keys": ["down", "enter"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    assert_eq!(body["reason"], "raw_input_unsupported");
    assert_eq!(body["retryable"], false);
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("no key was written"),
        "{body}"
    );

    // The very first thing on the wire is the side-effect-free negotiation —
    // not a discovery `List`, and certainly not a write.
    let first = daemon_server.await.unwrap();
    let first: serde_json::Value = serde_json::from_str(first.trim()).unwrap();
    assert_eq!(first["type"], "NegotiateRawInput");

    assert!(raw_input_events(&config, "task-old-daemon").is_empty());
    cleanup(&config, &daemon.socket_path, &daemon.daemon_dir);
}

/// A daemon that has committed a handoff no longer owns the session, and says
/// so before writing. That is the one failure worth repeating verbatim: nothing
/// reached a terminal, and the successor is coming — so it is the one answer
/// carrying `retryable: true`.
#[tokio::test]
async fn a_handing_off_daemon_reports_nothing_written_and_is_worth_repeating() {
    let unique = format!("raw-input-handoff-{}", unique_test_suffix());
    let daemon = scripted_daemon(&unique);
    let listener = daemon.listener;
    let daemon_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        while commands.len() < 2 {
            let command = read_test_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: vec![live_session("task-handoff", 3141)],
                },
                DaemonCommand::RawInputIfSession { .. } => DaemonEvent::Error {
                    code: Some(ErrorCode::RetryOnSuccessor),
                    message: "daemon handoff already committed; send input to the adopting daemon"
                        .to_string(),
                },
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });

    let config = raw_input_test_config(&unique, &daemon.daemon_dir);
    seed_live_task(&config, "task-handoff");

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-handoff/raw-input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "keys": ["down", "enter"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    assert_eq!(body["reason"], "daemon_handing_off");
    assert_eq!(body["retryable"], true);
    assert_eq!(body["writes"][0]["status"], "not_written");
    assert_eq!(body["writes"][1]["status"], "not_written");

    // The sequence stops at the first refusal rather than trying the rest.
    assert_eq!(daemon_server.await.unwrap().len(), 2);
    cleanup(&config, &daemon.socket_path, &daemon.daemon_dir);
}

/// The vocabulary is validated before the daemon is contacted, and the error
/// names what is accepted instead of failing at the terminal.
#[tokio::test]
async fn an_unknown_key_is_rejected_before_the_daemon_is_contacted() {
    let unique = format!("raw-input-unknown-key-{}", unique_test_suffix());
    let daemon = scripted_daemon(&unique);
    let listener = daemon.listener;
    let daemon_server = tokio::spawn(async move {
        let _ = listener.accept().await;
        true
    });

    let config = raw_input_test_config(&unique, &daemon.daemon_dir);
    seed_live_task(&config, "task-unknown-key");

    let response = super::router(Arc::new(super::AppState::new(config.clone())))
        .oneshot(
            Request::post("/v1/tasks/task-unknown-key/raw-input")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "keys": ["down", "arrow-up"] }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    assert_eq!(body["reason"], "invalid_raw_input");
    assert!(
        body["message"].as_str().unwrap().contains("accepted keys"),
        "{body}"
    );

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), daemon_server)
            .await
            .is_err(),
        "an unknown key must not reach the daemon"
    );
    cleanup(&config, &daemon.socket_path, &daemon.daemon_dir);
}
