use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kanna_daemon::protocol::{self, Event, SessionStatus};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::Mutex;

use crate::client::{
    cleanup_client_writer_registries, effective_terminal_size, SessionSizes,
    TerminalEmulatorClients,
};
use crate::fanout::{session_fanout, SessionFanouts, SubscriberKind};
use crate::handoff::{
    blank_snapshot, parse_handoff_response, should_try_compat_handoff_after_error, HandoffEventV1,
    HandoffRequestError, HandoffSessionV1,
};
use crate::output::{
    classify_output_gap, fanout_status_changed, format_status_observation_log,
    should_mirror_output_to_recovery, should_rebuild_recovery_session_on_live_terminal_transition,
    DaemonOutputGapCause, DAEMON_TERMINAL_PERF_STAGES,
};
use crate::paths::panic_log_path;

fn sample_snapshot() -> protocol::TerminalSnapshot {
    protocol::TerminalSnapshot {
        version: 1,
        rows: 24,
        cols: 80,
        cursor_row: 2,
        cursor_col: 3,
        cursor_visible: true,
        saved_at: 0,
        sequence: 0,
        status: protocol::SessionStatus::Idle,
        vt: "hello".to_string(),
    }
}

#[test]
fn parse_handoff_response_accepts_v2_payload() {
    let line = serde_json::to_string(&Event::HandoffReady {
        sessions: vec![protocol::HandoffSession {
            session_id: "s1".to_string(),
            pid: 42,
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
            snapshot: None,
            agent_provider: None,
            status: SessionStatus::Idle,
            kind: protocol::SessionKind::Pty,
            provider_session_id: None,
            agent_fd_count: 0,
            agent_spawn: None,
        }],
    })
    .unwrap();

    let sessions = parse_handoff_response(&line).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "s1");
    assert!(sessions[0].snapshot.is_none());
    assert_eq!(sessions[0].rows, 24);
    assert_eq!(sessions[0].cols, 80);
}

#[test]
fn parse_handoff_response_accepts_v1_payload() {
    let line = serde_json::to_string(&HandoffEventV1::HandoffReady {
        sessions: vec![HandoffSessionV1 {
            session_id: "s1".to_string(),
            pid: 42,
            cwd: "/tmp".to_string(),
            snapshot: sample_snapshot(),
        }],
    })
    .unwrap();

    let sessions = parse_handoff_response(&line).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "s1");
    assert_eq!(sessions[0].rows, 24);
    assert_eq!(sessions[0].cols, 80);
    assert_eq!(sessions[0].snapshot.as_ref().unwrap().vt, "hello");
}

#[test]
fn parse_handoff_response_accepts_v0_0_30_session_info_payload() {
    // Kanna 0.0.30 sent protocol::SessionInfo entries for handoff version 1.
    let line = serde_json::json!({
        "type": "HandoffReady",
        "sessions": [{
            "session_id": "s1",
            "pid": 42,
            "cwd": "/tmp",
            "state": "Active",
            "idle_seconds": 0
        }]
    })
    .to_string();

    let sessions = parse_handoff_response(&line).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "s1");
    assert_eq!(sessions[0].pid, 42);
    assert_eq!(sessions[0].cwd, "/tmp");
    assert_eq!(sessions[0].rows, 0);
    assert_eq!(sessions[0].cols, 0);
    assert!(sessions[0].snapshot.is_none());
}

#[test]
fn blank_snapshot_uses_dimensions_for_compat_handoff() {
    let snapshot = blank_snapshot(45, 120);
    assert_eq!(snapshot.rows, 45);
    assert_eq!(snapshot.cols, 120);
    assert_eq!(snapshot.cursor_row, 0);
    assert_eq!(snapshot.cursor_col, 0);
    assert!(snapshot.vt.is_empty());
}

#[test]
fn blank_snapshot_normalizes_zero_dimensions_for_compat_handoff() {
    let snapshot = blank_snapshot(0, 0);
    assert_eq!(snapshot.rows, 24);
    assert_eq!(snapshot.cols, 80);
    assert_eq!(snapshot.cursor_row, 0);
    assert_eq!(snapshot.cursor_col, 0);
    assert!(snapshot.vt.is_empty());
}

#[test]
fn format_status_observation_log_includes_session_source_status_and_lines() {
    let lines = vec!["Header".to_string(), "(Esc to cancel)".to_string()];

    let log_line = format_status_observation_log(
        "dbaa5b9d",
        "mirror_output",
        Some(protocol::AgentProvider::Copilot),
        Some(SessionStatus::Busy),
        &lines,
    );

    assert!(log_line.contains("session=dbaa5b9d"));
    assert!(log_line.contains("source=mirror_output"));
    assert!(log_line.contains("provider=copilot"));
    assert!(log_line.contains("detected=busy"));
    assert!(log_line.contains("Esc to cancel"));
}

#[test]
fn recovery_output_is_mirrored_even_with_live_terminal_client() {
    assert!(should_mirror_output_to_recovery(false));
    assert!(should_mirror_output_to_recovery(true));
}

#[test]
fn effective_terminal_size_uses_minimum_attached_client_dimensions() {
    let mut clients = HashMap::new();
    clients.insert(1, (220, 48));

    assert_eq!(effective_terminal_size(&clients, (80, 24)), (220, 48));

    clients.insert(2, (100, 30));

    assert_eq!(effective_terminal_size(&clients, (80, 24)), (100, 30));
}

#[tokio::test]
async fn connection_drop_cleanup_removes_attached_and_observer_writers() {
    let fanouts: SessionFanouts = Arc::new(Mutex::new(HashMap::new()));
    let terminal_emulator_clients: TerminalEmulatorClients = Arc::new(Mutex::new(HashMap::new()));
    let session_sizes: SessionSizes = Arc::new(Mutex::new(HashMap::new()));
    let mut writers_to_drop = Vec::new();

    for idx in 0..64 {
        let (_client, server) = UnixStream::pair().expect("should create UnixStream pair");
        let (_read_half, write_half) = server.into_split();
        let writer = Arc::new(Mutex::new(write_half));
        let writer_id = Arc::as_ptr(&writer) as usize;
        let session_id = format!("session-{}", idx % 4);

        let fanout = session_fanout(&fanouts, &session_id).await;
        let mut fanout_state = fanout.state.lock().await;
        fanout_state.register(&session_id, SubscriberKind::Attached, &writer, &[]);
        fanout_state.register(&session_id, SubscriberKind::Observer, &writer, &[]);
        drop(fanout_state);
        terminal_emulator_clients
            .lock()
            .await
            .entry(session_id.clone())
            .or_default()
            .insert(writer_id);
        session_sizes
            .lock()
            .await
            .entry(session_id.clone())
            .or_default()
            .insert(writer_id, (80, 24));

        writers_to_drop.push(writer);
    }

    for writer in &writers_to_drop {
        cleanup_client_writer_registries(
            writer,
            &fanouts,
            &terminal_emulator_clients,
            &session_sizes,
        )
        .await;
    }

    for fanout in fanouts.lock().await.values() {
        assert!(fanout.state.lock().await.is_empty());
    }
    assert!(terminal_emulator_clients.lock().await.is_empty());
    assert!(session_sizes.lock().await.is_empty());
}

#[tokio::test]
async fn connection_drop_cleanup_reports_remaining_effective_terminal_size() {
    let fanouts: SessionFanouts = Arc::new(Mutex::new(HashMap::new()));
    let terminal_emulator_clients: TerminalEmulatorClients = Arc::new(Mutex::new(HashMap::new()));
    let session_sizes: SessionSizes = Arc::new(Mutex::new(HashMap::new()));

    let (_large_client, large_server) = UnixStream::pair().expect("large stream pair");
    let (_large_read, large_write) = large_server.into_split();
    let large_writer = Arc::new(Mutex::new(large_write));
    let large_id = Arc::as_ptr(&large_writer) as usize;
    let (_small_client, small_server) = UnixStream::pair().expect("small stream pair");
    let (_small_read, small_write) = small_server.into_split();
    let small_writer = Arc::new(Mutex::new(small_write));
    let small_id = Arc::as_ptr(&small_writer) as usize;
    session_sizes.lock().await.insert(
        "session-resize".to_string(),
        HashMap::from([(large_id, (120, 43)), (small_id, (80, 24))]),
    );

    let remaining_sizes = cleanup_client_writer_registries(
        &small_writer,
        &fanouts,
        &terminal_emulator_clients,
        &session_sizes,
    )
    .await;

    assert_eq!(
        remaining_sizes,
        vec![("session-resize".to_string(), 120, 43)]
    );
}

#[tokio::test]
async fn live_status_changes_reach_attached_terminal_subscribers() {
    let fanouts: SessionFanouts = Arc::new(Mutex::new(HashMap::new()));
    let (client, server) = UnixStream::pair().expect("stream pair");
    let (_read_half, write_half) = server.into_split();
    let writer = Arc::new(Mutex::new(write_half));
    let fanout = session_fanout(&fanouts, "status-session").await;
    fanout
        .state
        .lock()
        .await
        .register("status-session", SubscriberKind::Attached, &writer, &[]);

    let event = Event::StatusChanged {
        session_id: "status-session".to_string(),
        status: SessionStatus::Waiting,
        waiting_prompt_snippet: Some("Allow this command?".to_string()),
    };
    fanout_status_changed(&fanouts, "status-session", &event).await;

    let (client_read, _client_write) = client.into_split();
    let mut reader = BufReader::new(client_read);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(1), reader.read_line(&mut line))
        .await
        .expect("attached terminal should receive status")
        .expect("read status line");
    let received: Event = serde_json::from_str(line.trim()).expect("parse status event");
    assert!(matches!(
        received,
        Event::StatusChanged {
            ref session_id,
            status: SessionStatus::Waiting,
            ..
        } if session_id == "status-session"
    ));
}

#[test]
fn panic_log_path_lives_under_daemon_dir() {
    assert_eq!(
        panic_log_path(Path::new("/tmp/kanna-daemon-test"), 42, 1234),
        PathBuf::from("/tmp/kanna-daemon-test/kanna-daemon-panic_42_1234.log")
    );
}

#[test]
fn output_gap_classifier_uses_monotonic_threshold_and_prior_blocker() {
    let started = Instant::now();

    assert_eq!(classify_output_gap(None, started, None), None);
    assert_eq!(
        classify_output_gap(Some(started), started + Duration::from_millis(1_900), None,),
        None
    );
    assert_eq!(
        classify_output_gap(
            Some(started + Duration::from_millis(1_900)),
            started + Duration::from_millis(4_000),
            Some("attached_writer"),
        ),
        Some((
            Duration::from_millis(2_100),
            DaemonOutputGapCause::PriorStage("attached_writer"),
        ))
    );
    assert_eq!(
        classify_output_gap(Some(started), started + Duration::from_millis(2_000), None,),
        Some((
            Duration::from_millis(2_000),
            DaemonOutputGapCause::PtySourceSilence,
        ))
    );
}

#[test]
fn daemon_terminal_perf_stage_names_cover_every_output_boundary() {
    assert_eq!(
        DAEMON_TERMINAL_PERF_STAGES,
        [
            "mirror_output",
            "detect_status",
            "attached_writer",
            "recovery_write",
            "observer_write",
            "snapshot_lock",
            "snapshot_serialize",
        ]
    );
}

#[test]
fn stream_output_prioritizes_live_delivery_before_recovery_persistence() {
    let source = include_str!("output.rs");
    let stream_body = source
        .split("fn stream_output(")
        .nth(1)
        .expect("stream_output function should exist");

    let live_delivery_index = stream_body
        .find("let evt = Event::Output")
        .expect("stream_output should emit live Output events");
    let headless_mirror_index = stream_body
        .find(".mirror_output(data")
        .expect("stream_output should mirror output into the headless terminal");
    let recovery_write_index = stream_body
        .find(".write_output(session_id")
        .expect("stream_output should persist output for recovery");

    assert!(
        headless_mirror_index < live_delivery_index,
        "headless mirroring must stay before live delivery so new attaches cannot snapshot stale terminal state",
    );
    assert!(
        live_delivery_index < recovery_write_index,
        "live terminal output should be emitted before recovery persistence so interactive echo is not delayed by bookkeeping",
    );
}

#[test]
fn output_ingestion_never_awaits_subscriber_socket_progress() {
    let source = include_str!("output.rs");
    let chunk_body = source
        .split("async fn handle_output_chunk(")
        .nth(1)
        .expect("handle_output_chunk function should exist");

    assert!(
        chunk_body.contains("state.enqueue(&line)"),
        "live delivery must go through the non-blocking fanout enqueue",
    );
    assert!(
        !chunk_body.contains("write_event"),
        "the ingestion loop must never write to a subscriber socket directly; \
         per-subscriber writer tasks own socket progress",
    );
}

#[test]
fn attach_cutover_holds_fanout_lock_across_snapshot_and_registration() {
    let source = include_str!("connection.rs");
    let attach_body = source
        .split("Command::AttachSnapshot {")
        .nth(1)
        .expect("AttachSnapshot handler should exist");

    let fanout_lock_index = attach_body
        .find("let mut fanout_state = fanout.state.lock().await")
        .expect("attach cutover should lock the session fanout");
    let snapshot_index = attach_body
        .find("session.snapshot(&session_id)")
        .expect("attach cutover should take the authoritative snapshot");
    let register_index = attach_body
        .find("fanout_state.register(")
        .expect("attach cutover should register the subscriber");
    let unlock_index = attach_body
        .find("drop(fanout_state)")
        .expect("attach cutover should release the fanout lock explicitly");

    assert!(
        fanout_lock_index < snapshot_index
            && snapshot_index < register_index
            && register_index < unlock_index,
        "the snapshot and subscriber registration must both happen under the \
         session fanout lock so the ingestion loop (which holds it across \
         mirror -> enqueue) cannot interleave a chunk between them",
    );
}

#[test]
fn live_terminal_transitions_do_not_rebuild_recovery_sessions() {
    assert!(!should_rebuild_recovery_session_on_live_terminal_transition());
}

#[test]
fn timeout_after_handoff_command_is_not_safe_for_compat_retry() {
    assert!(!should_try_compat_handoff_after_error(
        &HandoffRequestError::ResponseTimeout
    ));
}

#[test]
fn explicit_handoff_version_mismatch_is_safe_for_compat_retry() {
    assert!(should_try_compat_handoff_after_error(
        &HandoffRequestError::OldDaemonRefused(
            "handoff version mismatch: expected 1, got 2".to_string(),
        )
    ));
}
