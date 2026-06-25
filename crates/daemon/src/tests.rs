use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use kanna_daemon::protocol::{self, Event, SessionStatus};
use tokio::net::UnixStream;
use tokio::sync::Mutex;

use crate::client::{
    cleanup_client_writer_registries, effective_terminal_size, SessionObservers, SessionSizes,
    SessionWriters, TerminalEmulatorClients,
};
use crate::handoff::{
    blank_snapshot, parse_handoff_response, should_try_compat_handoff_after_error, HandoffEventV1,
    HandoffRequestError, HandoffSessionV1,
};
use crate::output::{
    format_status_observation_log, should_mirror_output_to_recovery,
    should_rebuild_recovery_session_on_live_terminal_transition,
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
    let session_writers: SessionWriters = Arc::new(Mutex::new(HashMap::new()));
    let terminal_emulator_clients: TerminalEmulatorClients = Arc::new(Mutex::new(HashMap::new()));
    let session_sizes: SessionSizes = Arc::new(Mutex::new(HashMap::new()));
    let session_observers: SessionObservers = Arc::new(Mutex::new(HashMap::new()));
    let mut writers_to_drop = Vec::new();

    for idx in 0..64 {
        let (_client, server) = UnixStream::pair().expect("should create UnixStream pair");
        let (_read_half, write_half) = server.into_split();
        let writer = Arc::new(Mutex::new(write_half));
        let writer_id = Arc::as_ptr(&writer) as usize;
        let session_id = format!("session-{}", idx % 4);

        session_writers
            .lock()
            .await
            .entry(session_id.clone())
            .or_default()
            .push(writer.clone());
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
        session_observers
            .lock()
            .await
            .entry(session_id)
            .or_default()
            .push(writer.clone());

        writers_to_drop.push(writer);
    }

    let attached_count: usize = session_writers.lock().await.values().map(Vec::len).sum();
    let observer_count: usize = session_observers.lock().await.values().map(Vec::len).sum();
    assert_eq!(attached_count, 64);
    assert_eq!(observer_count, 64);

    for writer in &writers_to_drop {
        cleanup_client_writer_registries(
            writer,
            &session_writers,
            &terminal_emulator_clients,
            &session_sizes,
            &session_observers,
        )
        .await;
    }

    let attached_count: usize = session_writers.lock().await.values().map(Vec::len).sum();
    assert_eq!(attached_count, 0);
    assert!(terminal_emulator_clients.lock().await.is_empty());
    assert!(session_sizes.lock().await.is_empty());
    assert!(session_observers.lock().await.is_empty());
}

#[test]
fn panic_log_path_lives_under_daemon_dir() {
    assert_eq!(
        panic_log_path(Path::new("/tmp/kanna-daemon-test"), 42, 1234),
        PathBuf::from("/tmp/kanna-daemon-test/kanna-daemon-panic_42_1234.log")
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
        .find(".mirror_output(&session_id")
        .expect("stream_output should mirror output into the headless terminal");
    let recovery_write_index = stream_body
        .find(".write_output(&session_id")
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
fn attach_cutover_locks_session_writer_registry_before_client_writer() {
    let source = include_str!("client.rs");
    let cutover_body = source
        .split("async fn finish_attach_cutover(")
        .nth(1)
        .expect("finish_attach_cutover function should exist");

    let registry_lock_index = cutover_body
        .find("let mut writers = session_writers.lock().await")
        .expect("attach cutover should lock the session writer registry");
    let writer_lock_index = cutover_body
        .find("let mut writer_guard = writer.lock().await")
        .expect("attach cutover should lock the client writer");
    let write_initial_event_index = cutover_body
        .find("write_event(&mut *writer_guard, initial_event)")
        .expect("attach cutover should write the initial snapshot while holding the writer");

    assert!(
        registry_lock_index < writer_lock_index,
        "attach cutover must not hold a client writer while waiting for the session writer registry; stream_output takes those locks in registry -> writer order",
    );
    assert!(
        writer_lock_index < write_initial_event_index,
        "attach cutover must hold the client writer until the initial snapshot is written so live output cannot precede the Snapshot response",
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
