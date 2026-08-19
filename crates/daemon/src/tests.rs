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
use crate::fanout::{session_fanout, EventLine, SessionFanouts, SubscriberKind};
use crate::handoff::{
    blank_snapshot, handoff_mode_for_version, legacy_fallback_after_error, parse_handoff_response,
    wait_for_handoff_release_with, HandoffMode, HandoffRequestError, OldDaemon,
};
use crate::output::{
    classify_output_gap, fanout_status_changed, format_status_observation_log,
    should_mirror_output_to_recovery, should_rebuild_recovery_session_on_live_terminal_transition,
    DaemonOutputGapCause, DAEMON_TERMINAL_PERF_STAGES,
};
use crate::paths::panic_log_path;

#[test]
fn process_executable_path_is_kernel_derived_for_live_processes() {
    let current = crate::proc_info::process_executable_path(std::process::id() as libc::pid_t)
        .expect("current process path");
    assert_eq!(
        std::fs::canonicalize(current).expect("canonical current process path"),
        std::fs::canonicalize(std::env::current_exe().expect("current executable"))
            .expect("canonical current executable")
    );

    let mut child = std::process::Command::new("/bin/cat")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .expect("cat spawn");
    let child_path =
        crate::proc_info::process_executable_path(child.id() as libc::pid_t).expect("cat path");
    assert_eq!(
        std::fs::canonicalize(child_path).expect("canonical child process path"),
        std::fs::canonicalize("/bin/cat").expect("canonical /bin/cat")
    );
    child.kill().expect("cat kill");
    child.wait().expect("cat reap");
}

#[test]
fn parse_handoff_response_accepts_v2_payload() {
    let line = serde_json::to_string(&Event::HandoffReady {
        sessions: vec![protocol::HandoffSession {
            session_id: "s1".to_string(),
            pid: 42,
            child_start: None,
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
            operator_input_only: false,
            input_policy_classified: false,
            raw_input_draft_active: false,
            raw_input_draft_state_known: true,
            pending_logical_inputs: Vec::new(),
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
fn blank_snapshot_uses_dimensions_for_snapshotless_handoff() {
    let snapshot = blank_snapshot(45, 120);
    assert_eq!(snapshot.rows, 45);
    assert_eq!(snapshot.cols, 120);
    assert_eq!(snapshot.cursor_row, 0);
    assert_eq!(snapshot.cursor_col, 0);
    assert!(snapshot.vt.is_empty());
}

#[test]
fn blank_snapshot_normalizes_zero_dimensions_for_snapshotless_handoff() {
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
async fn live_status_changes_follow_the_output_that_produced_them() {
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

    let output = Event::Output {
        session_id: "status-session".to_string(),
        data: b"working\n".to_vec(),
    };
    let output_line = EventLine::serialize(&output, 1, b"working\n".len()).unwrap();
    fanout.state.lock().await.enqueue(&output_line);

    let event = Event::StatusChanged {
        session_id: "status-session".to_string(),
        status: SessionStatus::Waiting,
        waiting_prompt_snippet: Some("Allow this command?".to_string()),
    };
    fanout_status_changed(&fanouts, "status-session", &event).await;

    let (client_read, _client_write) = client.into_split();
    let mut reader = BufReader::new(client_read);
    let mut output_json = String::new();
    tokio::time::timeout(Duration::from_secs(1), reader.read_line(&mut output_json))
        .await
        .expect("attached terminal should receive output")
        .expect("read output line");
    assert!(matches!(
        serde_json::from_str::<Event>(output_json.trim()).expect("parse output event"),
        Event::Output { ref session_id, ref data }
            if session_id == "status-session" && data == b"working\n"
    ));

    let mut status_json = String::new();
    tokio::time::timeout(Duration::from_secs(1), reader.read_line(&mut status_json))
        .await
        .expect("attached terminal should receive status")
        .expect("read status line");
    let received: Event = serde_json::from_str(status_json.trim()).expect("parse status event");
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
    let incarnation_guard_index = attach_body
        .find("registration_is_current(&sessions, &fanouts")
        .expect("attach cutover should revalidate the exact session and fanout incarnation");
    let register_index = attach_body
        .find("fanout_state.register(")
        .expect("attach cutover should register the subscriber");
    let unlock_index = register_index
        + attach_body[register_index..]
            .find("drop(fanout_state)")
            .expect("attach cutover should release the fanout lock explicitly");

    assert!(
        fanout_lock_index < snapshot_index
            && snapshot_index < incarnation_guard_index
            && incarnation_guard_index < register_index
            && snapshot_index < register_index
            && register_index < unlock_index,
        "the snapshot, exact-incarnation guard, and subscriber registration must happen under the \
         session fanout lock so the ingestion loop (which holds it across \
         mirror -> enqueue) cannot interleave a chunk between them",
    );
}

#[test]
fn live_terminal_transitions_do_not_rebuild_recovery_sessions() {
    assert!(!should_rebuild_recovery_session_on_live_terminal_transition());
}

#[tokio::test]
async fn concurrent_agent_kills_share_one_lifecycle_job_and_snapshot_batch() {
    let dir = std::env::temp_dir().join(format!(
        "kanna-agent-kill-batch-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).expect("create agent journal dir");

    let agents: kanna_daemon::agent::AgentSessions =
        Arc::new(Mutex::new(kanna_daemon::agent::AgentRegistry::default()));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(256);
    const SESSIONS: usize = 24;

    for index in 0..SESSIONS {
        let session_id = format!("batched-kill-{index}");
        let spec = kanna_agent_protocol::SpawnSpec {
            executable: "/bin/sleep".to_string(),
            args: vec!["300".to_string()],
            env: Vec::new(),
            initial_stdin: None,
        };
        let mut spawned = kanna_daemon::agent::spawn_agent_child(&spec, "/tmp", &HashMap::new())
            .expect("spawn agent child");
        let provider = protocol::AgentProvider::Claude;
        let adapter = kanna_daemon::agent::make_adapter(provider).expect("claude adapter");
        let turn_model = adapter.turn_model();
        let params = protocol::AgentSpawnParams {
            agent_provider: provider,
            prompt: "wait".to_string(),
            cwd: "/tmp".to_string(),
            env: HashMap::new(),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            max_turns: None,
            max_budget_usd: None,
            system_prompt: None,
            mcp_config_path: None,
            executable: Some("/bin/sleep".to_string()),
        };
        let record = kanna_daemon::agent::AgentSessionRecord {
            provider,
            params,
            adapter: Arc::new(std::sync::Mutex::new(adapter)),
            shared: Arc::new(Mutex::new(kanna_daemon::agent::AgentShared {
                journal: kanna_daemon::agent::AgentJournal::open(&dir, &session_id),
                writers: Vec::new(),
            })),
            child: Some(spawned.child),
            stdin: spawned.stdin,
            pid: spawned.pid,
            child_start: spawned.child_start,
            incarnation: kanna_daemon::agent::next_agent_incarnation(),
            spawning: false,
            reservation_is_initial: false,
            provider_session_id: None,
            status: protocol::SessionStatus::Busy,
            last_assistant_prompt: None,
            session_allowed_tools: std::collections::HashSet::new(),
            pending_permissions: std::collections::HashSet::new(),
            exited: false,
            exit_publication: kanna_daemon::agent::ExitPublication::new(),
            interrupt_requested: false,
            turn_model,
            created_at: Instant::now(),
            last_activity_at: Instant::now(),
            handoff_fds: spawned.handoff_fds.take(),
        };
        agents.lock().await.insert(session_id, record);
    }

    let gate_entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let gate_released = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let gate_entered = Arc::clone(&gate_entered);
        let gate_released = Arc::clone(&gate_released);
        kanna_daemon::reaper::run_teardown(Box::new(move || {
            gate_entered.store(true, std::sync::atomic::Ordering::Release);
            while !gate_released.load(std::sync::atomic::Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
        }))
        .await;
    }
    while !gate_entered.load(std::sync::atomic::Ordering::Acquire) {
        tokio::task::yield_now().await;
    }

    let (requests_before, batches_before, jobs_before) =
        kanna_daemon::agent::agent_teardown_stats();
    let ticks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let heartbeat = {
        let ticks = Arc::clone(&ticks);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(1)).await;
                ticks.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        })
    };

    let mut kills = Vec::new();
    for index in 0..SESSIONS {
        let agents = Arc::clone(&agents);
        let broadcast_tx = broadcast_tx.clone();
        kills.push(tokio::spawn(async move {
            crate::agent_runtime::kill_agent_session(
                &format!("batched-kill-{index}"),
                &agents,
                &broadcast_tx,
            )
            .await
        }));
    }

    let admission_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (requests, _, _) = kanna_daemon::agent::agent_teardown_stats();
        if requests - requests_before == SESSIONS as u64 {
            break;
        }
        if Instant::now() >= admission_deadline {
            gate_released.store(true, std::sync::atomic::Ordering::Release);
            panic!("all concurrent agent kills must reach batched lifecycle admission");
        }
        tokio::task::yield_now().await;
    }
    gate_released.store(true, std::sync::atomic::Ordering::Release);

    for kill in kills {
        assert_eq!(
            kill.await.expect("kill task"),
            crate::agent_runtime::AgentKillOutcome::Killed,
            "session should be killed"
        );
    }
    heartbeat.abort();

    assert!(
        ticks.load(std::sync::atomic::Ordering::Relaxed) > 0,
        "agent teardown must not pin the Tokio worker"
    );
    let (requests_after, batches_after, jobs_after) = kanna_daemon::agent::agent_teardown_stats();
    assert_eq!(requests_after - requests_before, SESSIONS as u64);
    assert_eq!(
        jobs_after - jobs_before,
        1,
        "one concurrent kill burst must admit one lifecycle job"
    );
    assert_eq!(
        batches_after - batches_before,
        1,
        "one concurrent kill burst must share one process snapshot batch"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn handoff_protocol_epochs_are_distinct() {
    assert_eq!(protocol::HANDOFF_PROTOCOL_VERSION, 3);
    assert_eq!(protocol::LEGACY_HANDOFF_PROTOCOL_VERSION, 2);
}

#[test]
fn supported_handoff_versions_map_to_explicit_modes() {
    assert_eq!(
        handoff_mode_for_version(protocol::HANDOFF_PROTOCOL_VERSION),
        Some(HandoffMode::TransactionalV3)
    );
    assert_eq!(
        handoff_mode_for_version(protocol::LEGACY_HANDOFF_PROTOCOL_VERSION),
        Some(HandoffMode::LegacyV2)
    );
    assert_eq!(handoff_mode_for_version(1), None);
}

#[test]
fn explicit_v3_mismatch_selects_one_legacy_v2_fallback() {
    let error = HandoffRequestError::VersionMismatch(
        "handoff version mismatch: expected 1 or 2, got 3".to_string(),
    );
    assert_eq!(
        legacy_fallback_after_error(&error),
        Some(HandoffMode::LegacyV2)
    );
}

#[test]
fn ambiguous_handoff_failure_never_selects_legacy() {
    assert_eq!(
        legacy_fallback_after_error(&HandoffRequestError::ResponseTimeout),
        None
    );
    assert_eq!(
        legacy_fallback_after_error(&HandoffRequestError::OldDaemonRefused(
            "handoff version mismatch: this is only unstructured text".to_string(),
        )),
        None
    );
}

// ---- Old-daemon shutdown hardening (handoff pid authentication) ----

pub(crate) fn temp_daemon_dir(prefix: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "kanna-daemon-test-{prefix}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn handoff_session(kind: protocol::SessionKind, agent_fd_count: u8) -> protocol::HandoffSession {
    protocol::HandoffSession {
        session_id: "s1".to_string(),
        pid: 42,
        child_start: None,
        cwd: "/tmp".to_string(),
        rows: 24,
        cols: 80,
        snapshot: None,
        agent_provider: None,
        status: SessionStatus::Idle,
        kind,
        provider_session_id: None,
        agent_fd_count,
        agent_spawn: None,
        operator_input_only: false,
        input_policy_classified: true,
        raw_input_draft_active: false,
        raw_input_draft_state_known: true,
        pending_logical_inputs: Vec::new(),
    }
}

#[test]
fn handoff_fd_counts_accept_only_protocol_shapes() {
    use crate::handoff::validate_handoff_fd_counts;

    for valid in [0u8, 2, 3] {
        assert!(
            validate_handoff_fd_counts(&[handoff_session(protocol::SessionKind::Agent, valid)])
                .is_ok(),
            "agent fd count {valid} is protocol-valid"
        );
    }
    for invalid in [1u8, 4, 200, 255] {
        assert!(
            validate_handoff_fd_counts(&[handoff_session(protocol::SessionKind::Agent, invalid)])
                .is_err(),
            "agent fd count {invalid} must be rejected"
        );
    }
    // PTY sessions ignore agent_fd_count entirely.
    assert!(
        validate_handoff_fd_counts(&[handoff_session(protocol::SessionKind::Pty, 200)]).is_ok()
    );
}

/// Hostile or stale pid files must never become signal targets: negative
/// values (broadcast after negation), 0/1, oversized values, garbage, and
/// reaped pids all resolve to "no old daemon".
#[tokio::test]
async fn attempt_handoff_rejects_hostile_and_stale_pid_files() {
    let dir = temp_daemon_dir("pidfile");
    let pid_path = dir.join("daemon.pid");
    let socket_path = dir.join("daemon.sock");

    for hostile in ["-1", "0", "1", "4294967295", "99999999999", "abc", ""] {
        std::fs::write(&pid_path, hostile).unwrap();
        let result = crate::handoff::attempt_handoff(&pid_path, &socket_path).await;
        assert!(
            result.old_daemon.is_none() && result.abort_start.is_none(),
            "pid file {hostile:?} must resolve to no old daemon"
        );
    }

    // A reaped pid (no such process) is not an old daemon either.
    let mut reaped = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    let reaped_pid = reaped.id();
    reaped.wait().unwrap();
    std::fs::write(&pid_path, reaped_pid.to_string()).unwrap();
    let result = crate::handoff::attempt_handoff(&pid_path, &socket_path).await;
    assert!(
        result.old_daemon.is_none() && result.abort_start.is_none(),
        "reaped pid must resolve to no old daemon"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// A pid file pointing at an unrelated live process (pid reuse) with no
/// serving socket: handoff aborts, and the old-daemon record stays
/// unauthenticated so the release wait can never SIGKILL it.
#[tokio::test]
async fn attempt_handoff_keeps_unverified_reused_pids_unauthenticated() {
    let dir = temp_daemon_dir("reused-pid");
    let pid_path = dir.join("daemon.pid");
    let socket_path = dir.join("daemon.sock");

    let mut victim = std::process::Command::new("/bin/sleep")
        .arg("300")
        .spawn()
        .unwrap();
    std::fs::write(&pid_path, victim.id().to_string()).unwrap();

    let result = crate::handoff::attempt_handoff(&pid_path, &socket_path).await;
    let old = result
        .old_daemon
        .expect("live pid-file process is reported as the old daemon");
    assert!(
        !old.authenticated,
        "a pid never confirmed against the socket peer must stay unauthenticated"
    );
    assert!(result.abort_start.is_some(), "handoff must abort");
    assert!(
        victim.try_wait().unwrap().is_none(),
        "the unrelated process must not be touched"
    );

    victim.kill().unwrap();
    victim.wait().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

/// Interleavings for the overstayer kill: unauthenticated, identity-
/// mismatched (reused pid), and reaped targets are never signaled; only an
/// authenticated identity-intact overstayer is killed.
#[tokio::test]
async fn old_daemon_release_only_kills_authenticated_identity_intact_overstayers() {
    use crate::handoff::OldDaemon;
    use crate::startup::wait_for_old_daemon_release_with;
    let short = Duration::from_millis(150);

    // Unauthenticated overstayer: waited out, never killed.
    let mut victim = std::process::Command::new("/bin/sleep")
        .arg("300")
        .spawn()
        .unwrap();
    let victim_pid = victim.id() as libc::pid_t;
    let victim_start = crate::proc_info::process_info(victim_pid).map(|info| info.start);
    wait_for_old_daemon_release_with(
        &OldDaemon {
            pid: victim_pid,
            start: victim_start,
            authenticated: false,
        },
        short,
        short,
    )
    .await;
    assert!(
        victim.try_wait().unwrap().is_none(),
        "unauthenticated overstayer must not be killed"
    );

    // Authenticated but identity-mismatched (reused pid): treated as exited,
    // never killed.
    if let Some(start) = victim_start {
        wait_for_old_daemon_release_with(
            &OldDaemon {
                pid: victim_pid,
                start: Some((start.0.wrapping_add(1), start.1)),
                authenticated: true,
            },
            short,
            short,
        )
        .await;
        assert!(
            victim.try_wait().unwrap().is_none(),
            "identity-mismatched overstayer must not be killed"
        );

        // Authenticated, identity intact: the overstayer is killed.
        wait_for_old_daemon_release_with(
            &OldDaemon {
                pid: victim_pid,
                start: Some(start),
                authenticated: true,
            },
            short,
            short,
        )
        .await;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if victim.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "authenticated identity-intact overstayer must be killed"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    } else {
        victim.kill().unwrap();
        victim.wait().unwrap();
    }
}

#[tokio::test]
async fn handoff_release_waits_for_the_dedicated_connection_to_close() {
    let (adopter, incumbent) = UnixStream::pair().expect("handoff stream pair");
    let (adopter_read, _adopter_write) = adopter.into_split();
    let mut reader = BufReader::new(adopter_read);
    let pid = std::process::id() as libc::pid_t;
    let start = crate::proc_info::process_info(pid).map(|info| info.start);

    let mut release = tokio::spawn(async move {
        wait_for_handoff_release_with(
            &mut reader,
            &OldDaemon {
                pid,
                start,
                authenticated: true,
            },
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .await
    });

    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut release)
            .await
            .is_err(),
        "the release barrier must not infer ownership release while the dedicated connection is open"
    );
    drop(incumbent);
    // Liveness: a barrier that missed the EOF never completes at all.
    tokio::time::timeout(Duration::from_secs(15), release)
        .await
        .expect("release barrier should observe connection EOF")
        .expect("release task should join")
        .expect("connection EOF should complete the release barrier");
}

// ---- Agent resume-spawn lifecycle ----

pub(crate) fn agent_record_fixture(
    dir: &Path,
    session_id: &str,
) -> kanna_daemon::agent::AgentSessionRecord {
    use kanna_daemon::agent::{make_adapter, AgentJournal, AgentSessionRecord, AgentShared};

    let adapter = make_adapter(protocol::AgentProvider::Claude).expect("claude adapter");
    let turn_model = adapter.turn_model();
    let journal = AgentJournal::open(dir, session_id);
    AgentSessionRecord {
        provider: protocol::AgentProvider::Claude,
        params: protocol::AgentSpawnParams {
            agent_provider: protocol::AgentProvider::Claude,
            prompt: "hi".to_string(),
            cwd: "/tmp".to_string(),
            env: std::collections::HashMap::new(),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: vec![],
            disallowed_tools: vec![],
            max_turns: None,
            max_budget_usd: None,
            system_prompt: None,
            mcp_config_path: None,
            executable: None,
        },
        adapter: Arc::new(std::sync::Mutex::new(adapter)),
        shared: Arc::new(Mutex::new(AgentShared {
            journal,
            writers: Vec::new(),
        })),
        child: None,
        stdin: None,
        pid: 0,
        child_start: None,
        incarnation: 2,
        spawning: false,
        reservation_is_initial: false,
        provider_session_id: Some("prov-1".to_string()),
        status: SessionStatus::Idle,
        last_assistant_prompt: None,
        session_allowed_tools: std::collections::HashSet::new(),
        pending_permissions: std::collections::HashSet::new(),
        exited: true,
        exit_publication: kanna_daemon::agent::ExitPublication::new(),
        interrupt_requested: false,
        turn_model,
        created_at: Instant::now(),
        last_activity_at: Instant::now(),
        handoff_fds: None,
    }
}

pub(crate) fn sleeper_spawned_child() -> kanna_daemon::agent::SpawnedAgentChild {
    kanna_daemon::agent::spawn_agent_child(
        &kanna_agent_protocol::SpawnSpec {
            executable: "/bin/sleep".to_string(),
            args: vec!["300".to_string()],
            env: Vec::new(),
            initial_stdin: None,
        },
        "/tmp",
        &std::collections::HashMap::new(),
    )
    .expect("sleeper spawn should succeed")
}

/// Close-during-spawn: the session is removed while its resume-spawn is in
/// flight; the installer must kill and clean up the orphan child instead of
/// leaking it forever.
#[tokio::test]
async fn install_respawned_child_kills_orphan_when_session_was_removed() {
    // The handoff seal is process-global, and both Kill and install now
    // consult it: a test that expects either to SUCCEED must not overlap a
    // test that arms the seal.
    let _seal_serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let spawned = sleeper_spawned_child();
    let orphan_pid = spawned.pid as libc::pid_t;

    let installed =
        crate::agent_runtime::install_respawned_child("gone", 2, spawned, &agents).await;
    assert!(installed.is_none(), "no session to install into");

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if unsafe { libc::kill(orphan_pid, 0) } != 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "orphan child {orphan_pid} must be killed, not leaked"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A reservation that survives to install wins the record; a stale
/// generation loses and its child is cleaned up.
#[tokio::test]
async fn install_respawned_child_installs_only_matching_generations() {
    let _serial = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("agent-install");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let mut record = agent_record_fixture(&dir, "sess");
    let reservation = kanna_daemon::agent::next_agent_incarnation();
    record.incarnation = reservation;
    record.spawning = true;
    agents.lock().await.insert("sess".to_string(), record);

    // Stale incarnation: child killed, record untouched.
    let stale = sleeper_spawned_child();
    let stale_pid = stale.pid as libc::pid_t;
    let installed = crate::agent_runtime::install_respawned_child(
        "sess",
        kanna_daemon::agent::next_agent_incarnation(),
        stale,
        &agents,
    )
    .await;
    assert!(installed.is_none());
    {
        let registry = agents.lock().await;
        let record = registry.get("sess").unwrap();
        assert!(
            record.spawning,
            "stale install must not clear the reservation"
        );
        assert_eq!(record.pid, 0, "stale install must not takeover the record");
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while unsafe { libc::kill(stale_pid, 0) } == 0 {
        assert!(Instant::now() < deadline, "stale child must be cleaned up");
        std::thread::sleep(Duration::from_millis(20));
    }

    // The reserving incarnation installs and clears the reservation.
    let winner = sleeper_spawned_child();
    let winner_pid = winner.pid;
    let winner_start = winner.child_start;
    let installed =
        crate::agent_runtime::install_respawned_child("sess", reservation, winner, &agents).await;
    assert!(installed.is_some(), "reserving incarnation must install");
    {
        let mut registry = agents.lock().await;
        let record = registry.get_mut(&"sess".to_string()).unwrap();
        assert!(!record.spawning);
        assert!(!record.exited);
        assert_eq!(record.pid, winner_pid);
        assert_eq!(record.child_start, winner_start);
        // Cleanup: kill + reap the installed child.
        let _ = kanna_daemon::agent::signal_agent_pid(
            record.pid,
            record.child_start,
            true,
            libc::SIGKILL,
        );
        if let Some(mut child) = record.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(fds) = record.handoff_fds.take() {
            fds.close();
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Concurrent resume attempts: the second input arriving while a respawn
/// reservation is held must be rejected instead of double-spawning.
#[tokio::test]
async fn agent_input_rejects_resume_while_reservation_is_held() {
    let dir = temp_daemon_dir("agent-reserve");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let mut record = agent_record_fixture(&dir, "sess");
    record.spawning = true; // a respawn is in flight
    agents.lock().await.insert("sess".to_string(), record);

    let (client, server) = UnixStream::pair().unwrap();
    let (_server_read, server_write) = server.into_split();
    let writer: kanna_daemon::agent::AgentClientWriter = Arc::new(Mutex::new(server_write));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(16);
    let daemon_lifecycle = crate::daemon_lifecycle::new_daemon_lifecycle();

    crate::agent_runtime::handle_agent_input(
        "sess".to_string(),
        "second message".to_string(),
        writer,
        broadcast_tx,
        agents.clone(),
        daemon_lifecycle,
    )
    .await;

    let (client_read, _client_write) = client.into_split();
    let mut lines = BufReader::new(client_read);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(5), lines.read_line(&mut line))
        .await
        .expect("reply should arrive")
        .expect("reply should parse");
    let event: Event = serde_json::from_str(line.trim()).expect("reply should be an event");
    match event {
        Event::Error { message, .. } => {
            assert!(
                message.contains("resume already in progress"),
                "unexpected rejection message: {message}"
            );
        }
        other => panic!("expected Error reply, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- Third review round: creation atomicity, ABA, seal, provenance ----

fn agent_client_writer() -> (
    kanna_daemon::agent::AgentClientWriter,
    BufReader<tokio::net::unix::OwnedReadHalf>,
) {
    let (client, server) = UnixStream::pair().unwrap();
    let (_server_read, server_write) = server.into_split();
    let (client_read, _client_write) = client.into_split();
    // Keep the client write half alive by leaking it into the reader tuple
    // owner; tests only read replies.
    std::mem::forget(_client_write);
    (
        Arc::new(Mutex::new(server_write)),
        BufReader::new(client_read),
    )
}

async fn read_reply(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>) -> Event {
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut line))
        .await
        .expect("reply should arrive")
        .expect("reply should read");
    serde_json::from_str(line.trim()).expect("reply should parse")
}

fn sleeper_spawn_params(session_id: &str) -> protocol::AgentSpawnParams {
    protocol::AgentSpawnParams {
        agent_provider: protocol::AgentProvider::Claude,
        prompt: format!("prompt for {session_id}"),
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        model: None,
        effort: None,
        permission_mode: None,
        allowed_tools: vec![],
        disallowed_tools: vec![],
        max_turns: None,
        max_budget_usd: None,
        system_prompt: None,
        mcp_config_path: None,
        executable: Some("/bin/sleep".to_string()),
    }
}

/// Concurrent SpawnAgent for the same id: the existence check and the
/// reservation are atomic, so exactly one create wins; the loser is rejected
/// before spawning anything.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_spawn_agent_creates_exactly_one_session() {
    let _serial = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("agent-create-race");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(64);
    let daemon_lifecycle = crate::daemon_lifecycle::new_daemon_lifecycle();

    let (writer_a, mut reader_a) = agent_client_writer();
    let (writer_b, mut reader_b) = agent_client_writer();
    let spawn = |writer| {
        crate::agent_runtime::handle_spawn_agent(
            "race-sess".to_string(),
            sleeper_spawn_params("race-sess"),
            writer,
            broadcast_tx.clone(),
            agents.clone(),
            dir.clone(),
            daemon_lifecycle.clone(),
        )
    };
    tokio::join!(spawn(writer_a), spawn(writer_b));

    let replies = [
        read_reply(&mut reader_a).await,
        read_reply(&mut reader_b).await,
    ];
    let created = replies
        .iter()
        .filter(|event| matches!(event, Event::SessionCreated { .. }))
        .count();
    let rejected = replies
        .iter()
        .filter(|event| {
            matches!(
                event,
                Event::Error {
                    code: Some(protocol::ErrorCode::SessionAlreadyExists),
                    ..
                }
            )
        })
        .count();
    assert_eq!(
        (created, rejected),
        (1, 1),
        "exactly one create must win: {replies:?}"
    );

    {
        let mut registry = agents.lock().await;
        assert_eq!(registry.len(), 1);
        let record = registry.get_mut("race-sess").unwrap();
        assert!(!record.spawning, "winner must have installed");
        let _ = kanna_daemon::agent::signal_agent_pid(
            record.pid,
            record.child_start,
            true,
            libc::SIGKILL,
        );
        if let Some(mut child) = record.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(fds) = record.handoff_fds.take() {
            fds.close();
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// The agent registry seal is a defensive pre-side-effect fence beneath the
/// daemon lifecycle lock. If it rejects SpawnAgent, the caller can safely
/// replay the unchanged command against the published successor.
#[tokio::test]
async fn sealed_spawn_agent_is_retryable_on_successor_without_reserving_the_id() {
    let _serial = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("sealed-agent-spawn");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(16);
    let daemon_lifecycle = crate::daemon_lifecycle::new_daemon_lifecycle();
    let (writer, mut reader) = agent_client_writer();
    let seal = crate::agent_runtime::AgentHandoffSealGuard::arm();

    crate::agent_runtime::handle_spawn_agent(
        "sealed-spawn".to_string(),
        sleeper_spawn_params("sealed-spawn"),
        writer,
        broadcast_tx,
        agents.clone(),
        dir.clone(),
        daemon_lifecycle,
    )
    .await;

    assert!(matches!(
        read_reply(&mut reader).await,
        Event::Error {
            code: Some(protocol::ErrorCode::RetryOnSuccessor),
            ..
        }
    ));
    assert!(
        !agents.lock().await.contains_key("sealed-spawn"),
        "a retryable refusal must occur before reserving or spawning"
    );

    drop(seal);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Create/kill interleaving at the exact race point: the session is killed
/// while its initial spawn is in flight (reservation present, install not
/// yet). The installer must clean up the spawned loser instead of resurrecting
/// the killed session or leaking the child.
#[tokio::test]
async fn kill_during_initial_spawn_cleans_up_the_loser() {
    // The handoff seal is process-global, and both Kill and install now
    // consult it: a test that expects either to SUCCEED must not overlap a
    // test that arms the seal.
    let _seal_serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("agent-create-kill");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(16);

    // Reservation exactly as handle_spawn_agent creates it.
    let mut reservation = agent_record_fixture(&dir, "cksess");
    let incarnation = kanna_daemon::agent::next_agent_incarnation();
    reservation.incarnation = incarnation;
    reservation.spawning = true;
    reservation.exited = true;
    agents
        .lock()
        .await
        .insert("cksess".to_string(), reservation);

    // Kill lands while the spawn is in flight.
    assert!(
        crate::agent_runtime::kill_agent_session("cksess", &agents, &broadcast_tx).await
            == crate::agent_runtime::AgentKillOutcome::Killed,
        "kill should remove the reservation"
    );
    assert!(agents.lock().await.is_empty());

    // The spawn resolves afterwards: its install must lose and clean up.
    let spawned = sleeper_spawned_child();
    let orphan_pid = spawned.pid as libc::pid_t;
    let installed =
        crate::agent_runtime::install_respawned_child("cksess", incarnation, spawned, &agents)
            .await;
    assert!(
        installed.is_none(),
        "killed session must not be resurrected"
    );
    assert!(agents.lock().await.is_empty());
    let deadline = Instant::now() + Duration::from_secs(5);
    while unsafe { libc::kill(orphan_pid, 0) } == 0 {
        assert!(Instant::now() < deadline, "loser child must be cleaned up");
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// ABA regression: the session is killed and recreated under the same id
/// while a respawn reservation from the FIRST life is still in flight. The
/// stale installer's incarnation token can never match the recreated record,
/// so the new session is untouched and the stale child is cleaned up.
#[tokio::test]
async fn stale_installer_from_previous_life_cannot_take_over_recreated_session() {
    // The handoff seal is process-global, and both Kill and install now
    // consult it: a test that expects either to SUCCEED must not overlap a
    // test that arms the seal.
    let _seal_serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("agent-aba");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(16);

    // Life 1 reserves a respawn...
    let mut first_life = agent_record_fixture(&dir, "aba");
    let stale_incarnation = kanna_daemon::agent::next_agent_incarnation();
    first_life.incarnation = stale_incarnation;
    first_life.spawning = true;
    agents.lock().await.insert("aba".to_string(), first_life);
    // ...is killed...
    assert_eq!(
        crate::agent_runtime::kill_agent_session("aba", &agents, &broadcast_tx).await,
        crate::agent_runtime::AgentKillOutcome::Killed
    );
    // ...and recreated under the same id with a fresh incarnation.
    let mut second_life = agent_record_fixture(&dir, "aba");
    second_life.incarnation = kanna_daemon::agent::next_agent_incarnation();
    let second_incarnation = second_life.incarnation;
    agents.lock().await.insert("aba".to_string(), second_life);

    let spawned = sleeper_spawned_child();
    let stale_pid = spawned.pid as libc::pid_t;
    let installed =
        crate::agent_runtime::install_respawned_child("aba", stale_incarnation, spawned, &agents)
            .await;
    assert!(installed.is_none(), "stale incarnation must lose");
    {
        let registry = agents.lock().await;
        let record = registry.get("aba").unwrap();
        assert_eq!(record.incarnation, second_incarnation);
        assert_eq!(record.pid, 0, "recreated session must be untouched");
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while unsafe { libc::kill(stale_pid, 0) } == 0 {
        assert!(Instant::now() < deadline, "stale child must be cleaned up");
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Handoff-during-respawn: once the registry is sealed for transfer, an
/// in-flight installer must treat its record as lost (child cleaned up, no
/// install into the exiting daemon); a failed handoff lifts the seal again.
#[tokio::test]
async fn sealed_registry_rejects_in_flight_installs_until_unsealed() {
    let _serial = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("agent-seal");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));

    let mut record = agent_record_fixture(&dir, "sealsess");
    let incarnation = kanna_daemon::agent::next_agent_incarnation();
    record.incarnation = incarnation;
    record.spawning = true;
    agents.lock().await.insert("sealsess".to_string(), record);

    {
        let seal = crate::agent_runtime::AgentHandoffSealGuard::arm();
        let spawned = sleeper_spawned_child();
        let sealed_pid = spawned.pid as libc::pid_t;
        let installed = crate::agent_runtime::install_respawned_child(
            "sealsess",
            incarnation,
            spawned,
            &agents,
        )
        .await;
        assert!(installed.is_none(), "sealed registry must reject installs");
        let deadline = Instant::now() + Duration::from_secs(5);
        while unsafe { libc::kill(sealed_pid, 0) } == 0 {
            assert!(Instant::now() < deadline, "sealed loser must be cleaned up");
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(seal); // failed handoff: seal lifts
    }

    let spawned = sleeper_spawned_child();
    let installed =
        crate::agent_runtime::install_respawned_child("sealsess", incarnation, spawned, &agents)
            .await;
    assert!(
        installed.is_some(),
        "after the seal lifts, the reservation installs normally"
    );
    {
        let mut registry = agents.lock().await;
        let record = registry.get_mut("sealsess").unwrap();
        let _ = kanna_daemon::agent::signal_agent_pid(
            record.pid,
            record.child_start,
            true,
            libc::SIGKILL,
        );
        if let Some(mut child) = record.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(fds) = record.handoff_fds.take() {
            fds.close();
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Forged agent handoff: metadata names an unrelated live process with its
/// CORRECT start time, but the transferred pipes are not that process's
/// pipes. Descriptor provenance must refuse signal authority; the victim
/// survives the session's kill.
#[tokio::test]
async fn forged_agent_handoff_cannot_target_unrelated_processes() {
    // The handoff seal is process-global, and both Kill and install now
    // consult it: a test that expects either to SUCCEED must not overlap a
    // test that arms the seal.
    let _seal_serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("agent-forged");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(16);

    let mut victim = std::process::Command::new("/bin/sleep")
        .arg("300")
        .spawn()
        .unwrap();
    let victim_start =
        crate::proc_info::process_info(victim.id() as libc::pid_t).map(|info| info.start);
    assert!(victim_start.is_some());

    // "Transferred" pipes fabricated by the attacker — not held by the victim.
    let mut stdout_pipe = [0 as std::os::unix::io::RawFd; 2];
    let mut stderr_pipe = [0 as std::os::unix::io::RawFd; 2];
    assert_eq!(unsafe { libc::pipe(stdout_pipe.as_mut_ptr()) }, 0);
    assert_eq!(unsafe { libc::pipe(stderr_pipe.as_mut_ptr()) }, 0);

    let info = protocol::HandoffSession {
        session_id: "forged".to_string(),
        pid: victim.id(),
        child_start: victim_start,
        cwd: "/tmp".to_string(),
        rows: 0,
        cols: 0,
        snapshot: None,
        agent_provider: Some(protocol::AgentProvider::Claude),
        status: SessionStatus::Busy,
        kind: protocol::SessionKind::Agent,
        provider_session_id: Some("prov-forged".to_string()),
        agent_fd_count: 2,
        agent_spawn: Some(sleeper_spawn_params("forged")),
        operator_input_only: false,
        input_policy_classified: true,
        raw_input_draft_active: false,
        raw_input_draft_state_known: true,
        pending_logical_inputs: Vec::new(),
    };
    crate::agent_runtime::adopt_agent_session(
        info,
        vec![stdout_pipe[0], stderr_pipe[0]],
        agents.clone(),
        broadcast_tx.clone(),
        dir.clone(),
        crate::daemon_lifecycle::new_daemon_lifecycle(),
    )
    .await;

    {
        let registry = agents.lock().await;
        let record = registry.get("forged").expect("session adopted");
        assert!(record.exited, "forged pid must be treated as exited");
        assert!(
            record.child_start.is_none(),
            "forged pid must stay non-signalable"
        );
    }
    assert_eq!(
        crate::agent_runtime::kill_agent_session("forged", &agents, &broadcast_tx).await,
        crate::agent_runtime::AgentKillOutcome::Killed
    );
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        victim.try_wait().unwrap().is_none(),
        "victim named by forged metadata must survive"
    );

    victim.kill().unwrap();
    victim.wait().unwrap();
    unsafe {
        libc::close(stdout_pipe[1]);
        libc::close(stderr_pipe[1]);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Old-v2 → new upgrade path: a live agent transferred WITHOUT identity
/// metadata is authenticated through pipe provenance and stays killable —
/// the legacy termination path the identity semantics must not break.
#[tokio::test]
async fn legacy_handoff_without_identity_keeps_live_agents_killable() {
    // The handoff seal is process-global, and both Kill and install now
    // consult it: a test that expects either to SUCCEED must not overlap a
    // test that arms the seal.
    let _seal_serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("agent-legacy");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(16);

    // A real agent-shaped child: setsid'd, pipes to us.
    let mut spawned = sleeper_spawned_child();
    use std::os::unix::io::AsRawFd;
    let stdout_dup = kanna_daemon::agent::dup_cloexec(spawned.stdout.as_raw_fd()).unwrap();
    let stderr_dup = kanna_daemon::agent::dup_cloexec(spawned.stderr.as_raw_fd()).unwrap();

    let info = protocol::HandoffSession {
        session_id: "legacy".to_string(),
        pid: spawned.pid,
        child_start: None, // old-v2 senders never transferred identity
        cwd: "/tmp".to_string(),
        rows: 0,
        cols: 0,
        snapshot: None,
        agent_provider: Some(protocol::AgentProvider::Claude),
        status: SessionStatus::Busy,
        kind: protocol::SessionKind::Agent,
        provider_session_id: Some("prov-legacy".to_string()),
        agent_fd_count: 2,
        agent_spawn: Some(sleeper_spawn_params("legacy")),
        operator_input_only: false,
        input_policy_classified: false,
        raw_input_draft_active: false,
        raw_input_draft_state_known: false,
        pending_logical_inputs: Vec::new(),
    };
    crate::agent_runtime::adopt_agent_session(
        info,
        vec![stdout_dup, stderr_dup],
        agents.clone(),
        broadcast_tx.clone(),
        dir.clone(),
        crate::daemon_lifecycle::new_daemon_lifecycle(),
    )
    .await;

    {
        let registry = agents.lock().await;
        let record = registry.get("legacy").expect("session adopted");
        assert!(!record.exited, "pipe-bound live agent must adopt as alive");
        assert!(
            record.child_start.is_some(),
            "provenance must authenticate the legacy pid for signaling"
        );
    }
    assert_eq!(
        crate::agent_runtime::kill_agent_session("legacy", &agents, &broadcast_tx).await,
        crate::agent_runtime::AgentKillOutcome::Killed
    );
    let status = spawned.child.wait().expect("legacy child reaped");
    assert!(!status.success(), "legacy live agent must have been killed");
    if let Some(fds) = spawned.handoff_fds.take() {
        fds.close();
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- Fourth review round ----

/// Stale-reader fault: a reader from an old session life must journal into
/// its OWN transcript and never resolve the replacement record's adapter or
/// touch its state after a kill+recreate of the same session id.
#[tokio::test]
async fn stale_reader_from_previous_life_cannot_touch_the_recreated_session() {
    // The handoff seal is process-global, and both Kill and install now
    // consult it: a test that expects either to SUCCEED must not overlap a
    // test that arms the seal.
    let _seal_serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    use kanna_agent_protocol::AgentEvent;

    let dir = temp_daemon_dir("reader-life");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(32);

    // Life 1, with a reader bound to it.
    let mut first = agent_record_fixture(&dir, "life");
    let first_incarnation = kanna_daemon::agent::next_agent_incarnation();
    first.incarnation = first_incarnation;
    first.status = SessionStatus::Busy;
    let stale_life = crate::agent_runtime::readers::ReaderLife::new(
        "life".to_string(),
        first_incarnation,
        first.adapter.clone(),
        first.shared.clone(),
    );
    agents.lock().await.insert("life".to_string(), first);

    // Life 1 is killed and the id recreated with its own adapter/journal.
    assert_eq!(
        crate::agent_runtime::kill_agent_session("life", &agents, &broadcast_tx).await,
        crate::agent_runtime::AgentKillOutcome::Killed
    );
    let mut second = agent_record_fixture(&dir, "life");
    second.incarnation = kanna_daemon::agent::next_agent_incarnation();
    second.status = SessionStatus::Idle;
    second.exited = false;
    let second_shared = second.shared.clone();
    let second_adapter_ptr = Arc::as_ptr(&second.adapter) as usize;
    agents.lock().await.insert("life".to_string(), second);

    // The stale reader must be pinned to life 1's adapter, not life 2's.
    assert_ne!(
        Arc::as_ptr(&stale_life.adapter) as usize,
        second_adapter_ptr,
        "the stale reader must not share the replacement's adapter"
    );

    // Its exit handling must not mark the live replacement exited...
    crate::agent_runtime::readers::handle_child_exit_for_test(&stale_life, &agents, &broadcast_tx)
        .await;
    {
        let registry = agents.lock().await;
        let record = registry.get("life").expect("replacement present");
        assert!(
            !record.exited,
            "a stale reader must not mark the replacement child exited"
        );
        assert_eq!(
            record.status,
            SessionStatus::Idle,
            "a stale reader must not change the replacement's status"
        );
    }

    // ...and its output must land in life 1's journal, not life 2's.
    crate::agent_runtime::readers::process_event_for_test(
        &stale_life,
        AgentEvent::AssistantText {
            text: "old life output".to_string(),
            truncated: false,
        },
        &agents,
        &broadcast_tx,
    )
    .await;
    // Note: both lives share the on-disk journal for this session id, so the
    // replacement legitimately replays life 1's *persisted history*. What must
    // not happen is the stale reader appending through the replacement's
    // handle — assert on the specific event instead of on emptiness.
    let has_stale_text = |entries: &[kanna_daemon::protocol::SeqAgentEvent]| {
        entries.iter().any(|entry| {
            matches!(&entry.event, AgentEvent::AssistantText { text, .. } if text == "old life output")
        })
    };
    let stale_events = stale_life.shared.lock().await.journal.events_from(0);
    assert!(
        has_stale_text(&stale_events),
        "old-life output belongs in the old life's journal"
    );
    let replacement_events = second_shared.lock().await.journal.events_from(0);
    assert!(
        !has_stale_text(&replacement_events),
        "old-life output must never be appended through the replacement's handle"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// AgentInput interleaving: a kill+recreate between planning and delivery
/// must neither write the old input to the replacement child's stdin nor mark
/// the replacement Busy for a turn it never received.
#[tokio::test]
async fn agent_input_planned_before_recreate_does_not_touch_the_replacement() {
    let dir = temp_daemon_dir("input-interleave");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(32);

    // A live persistent session whose stdin we can observe.
    let mut spawned = sleeper_spawned_child();
    let mut record = agent_record_fixture(&dir, "iv");
    let first_incarnation = kanna_daemon::agent::next_agent_incarnation();
    record.incarnation = first_incarnation;
    record.exited = false;
    record.pid = spawned.pid;
    record.child_start = spawned.child_start;
    record.stdin = spawned.stdin.take();
    record.turn_model = kanna_agent_protocol::TurnModel::Persistent;
    agents.lock().await.insert("iv".to_string(), record);

    // Recreate the id under a fresh incarnation, standing in for the state a
    // kill+create leaves behind while an input is mid-flight.
    let mut replacement = agent_record_fixture(&dir, "iv");
    replacement.incarnation = kanna_daemon::agent::next_agent_incarnation();
    replacement.status = SessionStatus::Idle;
    replacement.exited = false;
    agents.lock().await.insert("iv".to_string(), replacement);

    // Deliver with the STALE planning incarnation.
    crate::agent_runtime::deliver_planned_input_for_test(
        "iv",
        first_incarnation,
        "old input",
        &agents,
        &broadcast_tx,
    )
    .await;

    let registry = agents.lock().await;
    let record = registry.get("iv").expect("replacement present");
    assert_eq!(
        record.status,
        SessionStatus::Idle,
        "the replacement must not be marked Busy for an input it never received"
    );
    drop(registry);

    let _ = kanna_daemon::agent::signal_agent_pid(
        spawned.pid,
        spawned.child_start,
        true,
        libc::SIGKILL,
    );
    let _ = spawned.child.kill();
    let _ = spawned.child.wait();
    if let Some(fds) = spawned.handoff_fds.take() {
        fds.close();
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// A seal-rejected installer whose reservation was otherwise valid must roll
/// the reservation back, so an aborted handoff (failed fd-send or missing
/// ACK, both of which unseal) leaves the session able to resume.
#[tokio::test]
async fn seal_rejected_install_rolls_back_the_reservation() {
    let dir = temp_daemon_dir("seal-rollback");
    let _serial = crate::agent_runtime::seal_test_serializer().lock().await;
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));

    let mut record = agent_record_fixture(&dir, "rb");
    let incarnation = kanna_daemon::agent::next_agent_incarnation();
    record.incarnation = incarnation;
    record.spawning = true;
    agents.lock().await.insert("rb".to_string(), record);

    {
        let seal = crate::agent_runtime::AgentHandoffSealGuard::arm();
        let spawned = sleeper_spawned_child();
        let loser_pid = spawned.pid as libc::pid_t;
        assert!(
            crate::agent_runtime::install_respawned_child("rb", incarnation, spawned, &agents)
                .await
                .is_none(),
            "the seal must reject the install"
        );
        {
            let registry = agents.lock().await;
            let record = registry.get("rb").expect("record present");
            assert!(
                !record.spawning,
                "a seal-rejected reservation must be rolled back so resumes still work"
            );
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while unsafe { libc::kill(loser_pid, 0) } == 0 {
            assert!(Instant::now() < deadline, "seal loser must be cleaned up");
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(seal); // aborted handoff
    }

    // With the reservation rolled back, a fresh reservation + install works.
    let retry_incarnation = {
        let mut registry = agents.lock().await;
        let record = registry.get_mut("rb").expect("record present");
        record.spawning = true;
        record.incarnation = kanna_daemon::agent::next_agent_incarnation();
        record.incarnation
    };
    let spawned = sleeper_spawned_child();
    let installed =
        crate::agent_runtime::install_respawned_child("rb", retry_incarnation, spawned, &agents)
            .await;
    assert!(
        installed.is_some(),
        "after the aborted handoff the session must accept a resume again"
    );
    {
        let mut registry = agents.lock().await;
        let record = registry.get_mut("rb").unwrap();
        let _ = kanna_daemon::agent::signal_agent_pid(
            record.pid,
            record.child_start,
            true,
            libc::SIGKILL,
        );
        if let Some(mut child) = record.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(fds) = record.handoff_fds.take() {
            fds.close();
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// PTY lifecycle fence: while a handoff transfer is in flight the session
/// manager is sealed, so a post-snapshot Spawn cannot insert a session whose
/// master fd was never transferred (it would be silently lost), and a killed
/// session cannot be reinserted behind the snapshot. Aborting the handoff
/// lifts the seal.
#[tokio::test]
async fn sealed_session_manager_fences_post_snapshot_spawn_and_reinsertion() {
    use crate::session::{SessionHandle, SessionManager};

    let mut manager = SessionManager::new();
    let handle = Arc::new(SessionHandle::new(
        crate::session::test_support::spawn_sleeper_record().expect("record"),
    ));
    assert!(manager.insert_unless_sealed("before".to_string(), handle.clone()));

    let epoch = manager.seal_for_handoff();
    assert!(manager.is_sealed_for_handoff());
    assert_eq!(manager.handoff_epoch(), epoch);

    // Post-snapshot spawn is refused rather than stranded.
    assert!(
        !manager.insert_unless_sealed("after-snapshot".to_string(), handle.clone()),
        "a sealed manager must refuse post-snapshot spawns"
    );
    // A killed session must not reappear behind the transfer.
    manager.remove("before");
    assert!(
        !manager.insert_unless_sealed("before".to_string(), handle.clone()),
        "a sealed manager must refuse reinsertion of a killed session"
    );

    // Aborted handoff: the seal lifts and normal service resumes.
    manager.unseal_for_handoff();
    assert!(!manager.is_sealed_for_handoff());
    assert!(manager.insert_unless_sealed("after-abort".to_string(), handle.clone()));

    let _ = handle.kill().await;
}

// ---- Fifth review round ----

/// One journal (one sequence space) per session id. Two lives of the same id
/// — a stale reader still draining the previous child while the replacement
/// journals its own events — must not both allocate the same seq, which
/// corrupts the transcript.
#[tokio::test]
async fn concurrent_lives_of_one_session_id_share_one_sequence_space() {
    use kanna_agent_protocol::AgentEvent;

    let dir = temp_daemon_dir("journal-seq");
    let first = kanna_daemon::agent::shared_agent_state(&dir, "seq");
    let second = kanna_daemon::agent::shared_agent_state(&dir, "seq");
    assert!(
        Arc::ptr_eq(&first, &second),
        "both lives of a session id must share one journal handle"
    );

    for index in 0..6 {
        let handle = if index % 2 == 0 { &first } else { &second };
        handle.lock().await.journal.append(AgentEvent::Diagnostic {
            message: format!("event-{index}"),
        });
    }

    let entries = first.lock().await.journal.events_from(0);
    let seqs: Vec<u64> = entries.iter().map(|entry| entry.seq).collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(
        sorted.len(),
        seqs.len(),
        "sequence numbers must be unique across lives, got {seqs:?}"
    );
    assert_eq!(
        seqs,
        (0..seqs.len() as u64).collect::<Vec<_>>(),
        "sequence numbers must be dense and ordered, got {seqs:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A seal-rejected INITIAL reservation must be removed, not rolled back: a
/// pid=0 provider-less ghost would occupy the id and block both retry and
/// transfer.
#[tokio::test]
async fn seal_rejected_initial_reservation_is_removed_not_rolled_back() {
    let dir = temp_daemon_dir("ghost-removal");
    let _serial = crate::agent_runtime::seal_test_serializer().lock().await;
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));

    let mut record = agent_record_fixture(&dir, "ghost");
    let incarnation = kanna_daemon::agent::next_agent_incarnation();
    record.incarnation = incarnation;
    record.spawning = true;
    record.reservation_is_initial = true;
    record.pid = 0;
    record.provider_session_id = None;
    agents.lock().await.insert("ghost".to_string(), record);

    let seal = crate::agent_runtime::AgentHandoffSealGuard::arm();
    let spawned = sleeper_spawned_child();
    let loser = spawned.pid as libc::pid_t;
    assert!(
        crate::agent_runtime::install_respawned_child("ghost", incarnation, spawned, &agents)
            .await
            .is_none()
    );
    assert!(
        !agents.lock().await.contains_key("ghost"),
        "a seal-rejected initial reservation must be removed, leaving no ghost"
    );
    drop(seal);
    let deadline = Instant::now() + Duration::from_secs(5);
    while unsafe { libc::kill(loser, 0) } == 0 {
        assert!(Instant::now() < deadline, "loser child must be cleaned up");
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Teardown is single-flight per session: repeated/concurrent Kill calls must
/// not each enqueue a whole-table sweep on the lifecycle executor.
#[tokio::test]
async fn repeated_kill_is_single_flight_and_does_not_requeue_sweeps() {
    use crate::session::SessionHandle;

    let handle = Arc::new(SessionHandle::new(
        crate::session::test_support::spawn_sleeper_record().expect("record"),
    ));
    assert!(handle.claim_teardown(), "first claim wins");
    assert!(!handle.claim_teardown(), "second claim must be refused");

    // Both kills succeed; only the first can have run a sweep.
    let (first, second) = tokio::join!(handle.kill(), handle.kill());
    first.expect("kill ok");
    second.expect("repeat kill is a no-op");
}

/// Bulk teardown must complete every kill plan BEFORE handing reap tokens to
/// the reaper: reaping first frees the pid for reuse while the plan still
/// holds it as a signal target.
#[tokio::test]
async fn bulk_teardown_completes_plans_before_enqueueing_reaps() {
    use crate::session::{SessionHandle, SessionManager};

    let mut manager = SessionManager::new();
    let mut pids = Vec::new();
    for index in 0..3 {
        let record = crate::session::test_support::spawn_sleeper_record().expect("record");
        let handle = Arc::new(SessionHandle::new(record));
        pids.push(handle.pty.lock().await.pid() as libc::pid_t);
        assert!(manager.insert_unless_sealed(format!("bulk-{index}"), handle));
    }

    let handles = manager.kill_all_with_shared_scan().await;
    assert_eq!(handles.len(), 3);

    // Every child must be dead once the batch returns — the plans ran to
    // completion rather than racing an early reap.
    for pid in pids {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "session child {pid} should be killed by the batch"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

// ---- Sixth review round ----

/// A rejected duplicate SpawnAgent must not contaminate the winning session's
/// journal: the initiating UserMessage is appended only after the id is won.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rejected_duplicate_spawn_does_not_contaminate_the_winners_journal() {
    use kanna_agent_protocol::AgentEvent;

    let dir = temp_daemon_dir("spawn-journal");
    let _serial = crate::agent_runtime::seal_test_serializer().lock().await;
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(64);
    let daemon_lifecycle = crate::daemon_lifecycle::new_daemon_lifecycle();

    let (writer_a, mut reader_a) = agent_client_writer();
    let (writer_b, mut reader_b) = agent_client_writer();
    let spawn = |writer, prompt: &str| {
        let mut params = sleeper_spawn_params("dupe");
        params.prompt = prompt.to_string();
        crate::agent_runtime::handle_spawn_agent(
            "dupe".to_string(),
            params,
            writer,
            broadcast_tx.clone(),
            agents.clone(),
            dir.clone(),
            daemon_lifecycle.clone(),
        )
    };
    tokio::join!(spawn(writer_a, "prompt-a"), spawn(writer_b, "prompt-b"));
    let replies = [
        read_reply(&mut reader_a).await,
        read_reply(&mut reader_b).await,
    ];
    let created = replies
        .iter()
        .filter(|event| matches!(event, Event::SessionCreated { .. }))
        .count();
    assert_eq!(created, 1, "exactly one spawn wins: {replies:?}");

    // Exactly ONE initiating UserMessage — the loser's prompt never lands.
    let shared = kanna_daemon::agent::shared_agent_state(&dir, "dupe");
    let user_messages: Vec<String> = shared
        .lock()
        .await
        .journal
        .events_from(0)
        .into_iter()
        .filter_map(|entry| match entry.event {
            AgentEvent::UserMessage { text } => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(
        user_messages.len(),
        1,
        "a rejected duplicate spawn must not append its prompt: {user_messages:?}"
    );

    {
        let mut registry = agents.lock().await;
        if let Some(record) = registry.get_mut("dupe") {
            let _ = kanna_daemon::agent::signal_agent_pid(
                record.pid,
                record.child_start,
                true,
                libc::SIGKILL,
            );
            if let Some(mut child) = record.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            if let Some(fds) = record.handoff_fds.take() {
                fds.close();
            }
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Session churn must not monotonically retain shared journal state: the
/// registry holds Weak references, so once a session's record and readers are
/// gone its journal handle, event vector, and writer sockets are released.
/// Overlapping lives of one id still share a single sequencer.
#[tokio::test]
async fn session_churn_does_not_retain_shared_journal_state() {
    let dir = temp_daemon_dir("shared-churn");
    let baseline = kanna_daemon::agent::live_shared_agent_states();

    for index in 0..25 {
        let id = format!("churn-{index}");
        let handle = kanna_daemon::agent::shared_agent_state(&dir, &id);
        handle
            .lock()
            .await
            .journal
            .append(kanna_agent_protocol::AgentEvent::Diagnostic {
                message: "x".to_string(),
            });
        // Dropping the last strong reference must release the entry.
        drop(handle);
    }
    let after = kanna_daemon::agent::live_shared_agent_states();
    assert!(
        after <= baseline,
        "churned sessions must not retain shared state: baseline {baseline}, after {after}"
    );

    // Overlapping lives of ONE id still share one sequencer.
    let first = kanna_daemon::agent::shared_agent_state(&dir, "overlap");
    let second = kanna_daemon::agent::shared_agent_state(&dir, "overlap");
    assert!(
        Arc::ptr_eq(&first, &second),
        "overlapping lives must share one journal handle"
    );
    drop(second);
    drop(first);
    // And once both end, the entry is releasable again.
    let reopened = kanna_daemon::agent::shared_agent_state(&dir, "overlap");
    assert_eq!(Arc::strong_count(&reopened), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- Seventh review round ----

/// Killing an INITIAL SpawnAgent reservation must still emit exactly one
/// killed Exit. Such records carry `exited: true` and never announced a
/// SessionCreated, so the old `!exited` gate replied Ok while broadcasting
/// nothing — leaving a consume-once replacement entry unconsumed and any
/// consumer awaiting the Exit waiting forever.
#[tokio::test]
async fn killing_an_initial_reservation_emits_exactly_one_exit() {
    // The handoff seal is process-global, and both Kill and install now
    // consult it: a test that expects either to SUCCEED must not overlap a
    // test that arms the seal.
    let _seal_serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("reservation-exit");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, mut rx) = tokio::sync::broadcast::channel(32);

    let mut reservation = agent_record_fixture(&dir, "resv");
    reservation.incarnation = kanna_daemon::agent::next_agent_incarnation();
    reservation.spawning = true;
    reservation.reservation_is_initial = true;
    reservation.exited = true;
    reservation.pid = 0;
    agents.lock().await.insert("resv".to_string(), reservation);

    assert!(
        crate::agent_runtime::kill_agent_session("resv", &agents, &broadcast_tx).await
            == crate::agent_runtime::AgentKillOutcome::Killed,
        "removing a reservation is a successful kill"
    );

    let mut killed_exits = 0;
    while let Ok(line) = rx.try_recv() {
        if let Ok(Event::Exit {
            session_id, killed, ..
        }) = serde_json::from_str::<Event>(&line)
        {
            if session_id == "resv" {
                assert!(
                    killed,
                    "a cancelled reservation reports an orchestrated kill"
                );
                killed_exits += 1;
            }
        }
    }
    assert_eq!(
        killed_exits, 1,
        "exactly one Exit must be emitted per successful Kill"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A live agent session still emits exactly one Exit (no double-announce from
/// the new reservation-aware predicate).
#[tokio::test]
async fn killing_a_live_agent_session_still_emits_exactly_one_exit() {
    // The handoff seal is process-global, and both Kill and install now
    // consult it: a test that expects either to SUCCEED must not overlap a
    // test that arms the seal.
    let _seal_serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("live-exit");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, mut rx) = tokio::sync::broadcast::channel(32);

    let mut spawned = sleeper_spawned_child();
    let mut record = agent_record_fixture(&dir, "live");
    record.incarnation = kanna_daemon::agent::next_agent_incarnation();
    record.exited = false;
    record.reservation_is_initial = false;
    record.pid = spawned.pid;
    record.child_start = spawned.child_start;
    record.child = Some(spawned.child);
    record.handoff_fds = spawned.handoff_fds.take();
    agents.lock().await.insert("live".to_string(), record);

    assert_eq!(
        crate::agent_runtime::kill_agent_session("live", &agents, &broadcast_tx).await,
        crate::agent_runtime::AgentKillOutcome::Killed
    );
    let mut killed_exits = 0;
    while let Ok(line) = rx.try_recv() {
        if let Ok(Event::Exit { session_id, .. }) = serde_json::from_str::<Event>(&line) {
            if session_id == "live" {
                killed_exits += 1;
            }
        }
    }
    assert_eq!(killed_exits, 1, "a live kill must not double-announce");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- Tenth review round ----

/// Killing an IDLE PER-TURN session must still emit exactly one killed Exit.
/// A per-turn provider's child exits cleanly after every turn and the reader
/// deliberately publishes no Exit for that churn — but it did set
/// `exited: true`. Gating the Kill announcement on `exited` therefore emitted
/// NOTHING at all for the most common state a per-turn session sits in, so a
/// consumer awaiting the Exit (consume-once kill orchestration) waited forever.
#[tokio::test]
async fn killing_an_idle_per_turn_session_emits_exactly_one_exit() {
    // The handoff seal is process-global, and both Kill and install now
    // consult it: a test that expects either to SUCCEED must not overlap a
    // test that arms the seal.
    let _seal_serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("per-turn-idle-exit");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, mut rx) = tokio::sync::broadcast::channel(32);

    // Drive the REAL reader exit path so the test proves the reader's silence,
    // not just a hand-set flag. A per-turn child that exits 0 (no child handle
    // reaps as code 0's per-turn sibling: use an already-exited true(1)).
    let mut record = agent_record_fixture(&dir, "perturn");
    let incarnation = kanna_daemon::agent::next_agent_incarnation();
    record.incarnation = incarnation;
    record.turn_model = kanna_agent_protocol::TurnModel::PerTurn;
    record.exited = false;
    record.status = SessionStatus::Busy;
    record.child = Some(
        std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("spawn a child that exits 0"),
    );
    let life = crate::agent_runtime::readers::ReaderLife::new(
        "perturn".to_string(),
        incarnation,
        record.adapter.clone(),
        record.shared.clone(),
    );
    agents.lock().await.insert("perturn".to_string(), record);

    crate::agent_runtime::readers::handle_child_exit_for_test(&life, &agents, &broadcast_tx).await;
    {
        let registry = agents.lock().await;
        let record = registry.get("perturn").expect("session survives its turn");
        assert!(record.exited, "the per-turn child did exit");
        assert!(
            !record.exit_publication.is_published(),
            "per-turn turn churn must publish no terminal Exit"
        );
    }
    let turn_exits = drain_exits(&mut rx, "perturn");
    assert_eq!(
        turn_exits, 0,
        "a per-turn turn boundary is not a session event"
    );

    // Now close the task. This is the state the session normally sits in.
    assert_eq!(
        crate::agent_runtime::kill_agent_session("perturn", &agents, &broadcast_tx).await,
        crate::agent_runtime::AgentKillOutcome::Killed
    );
    assert_eq!(
        drain_exits(&mut rx, "perturn"),
        1,
        "killing an idle per-turn session must emit exactly one Exit"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The converse: a session that ALREADY published its Exit from the reader
/// (a persistent provider that exited on its own) must not have a second one
/// announced if it is killed afterwards.
#[tokio::test]
async fn killing_an_already_announced_session_does_not_double_announce() {
    // The handoff seal is process-global, and both Kill and install now
    // consult it: a test that expects either to SUCCEED must not overlap a
    // test that arms the seal.
    let _seal_serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("announced-exit");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, mut rx) = tokio::sync::broadcast::channel(32);

    let mut record = agent_record_fixture(&dir, "persistent");
    let incarnation = kanna_daemon::agent::next_agent_incarnation();
    record.incarnation = incarnation;
    record.turn_model = kanna_agent_protocol::TurnModel::Persistent;
    record.exited = false;
    record.child = Some(
        std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("spawn a child that exits 0"),
    );
    let life = crate::agent_runtime::readers::ReaderLife::new(
        "persistent".to_string(),
        incarnation,
        record.adapter.clone(),
        record.shared.clone(),
    );
    agents.lock().await.insert("persistent".to_string(), record);

    crate::agent_runtime::readers::handle_child_exit_for_test(&life, &agents, &broadcast_tx).await;
    assert_eq!(
        drain_exits(&mut rx, "persistent"),
        1,
        "a persistent provider's own exit is a session event"
    );
    assert!(
        agents
            .lock()
            .await
            .get("persistent")
            .expect("record retained")
            .exit_publication
            .is_published(),
        "the reader recorded that it published the Exit"
    );

    assert_eq!(
        crate::agent_runtime::kill_agent_session("persistent", &agents, &broadcast_tx).await,
        crate::agent_runtime::AgentKillOutcome::Killed
    );
    assert_eq!(
        drain_exits(&mut rx, "persistent"),
        0,
        "the death was already announced; Kill must not repeat it"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Fault injection: a PTY child that dies AFTER the handoff snapshot captured
/// its session must not have its Exit published by the outgoing daemon. The
/// snapshot already sent that session's master fd, so the successor owns the
/// death and publishes it — the old daemon publishing too would tear the
/// session down in every connected client and double the Exit.
///
/// The death is deferred, not dropped: an ABORTED handoff lifts the seal and
/// this daemon publishes normally, because it is still the only authority.
#[tokio::test]
async fn a_pty_exit_during_a_sealed_handoff_defers_to_the_transfer_outcome() {
    use crate::session::{SessionHandle, SessionManager, StreamControl};

    let stream_control = StreamControl::new();
    let handle = Arc::new(SessionHandle::new(
        crate::session::test_support::spawn_exiting_record(&stream_control).expect("record"),
    ));
    let io_fd = handle.try_clone_io_fd().await.expect("clone io fd");
    let input_rx = handle.take_input_rx().await.expect("input queue");

    let sessions = Arc::new(Mutex::new(SessionManager::new()));
    assert!(sessions
        .lock()
        .await
        .insert_unless_sealed("dying".to_string(), handle.clone()));
    let (broadcast_tx, mut rx) = tokio::sync::broadcast::channel(32);
    let fanouts: SessionFanouts = Arc::new(Mutex::new(HashMap::new()));
    let terminal_emulator_clients: TerminalEmulatorClients = Arc::new(Mutex::new(HashMap::new()));
    let session_sizes: SessionSizes = Arc::new(Mutex::new(HashMap::new()));
    let recovery_manager = kanna_daemon::recovery::RecoveryManager::start().await;
    let daemon_lifecycle = crate::daemon_lifecycle::new_daemon_lifecycle();

    // The snapshot has been taken and the fd sent; the transfer is in flight.
    let _epoch = sessions.lock().await.seal_for_handoff();

    let streamer = tokio::spawn(crate::output::stream_output(
        "dying".to_string(),
        io_fd,
        input_rx,
        stream_control.clone(),
        broadcast_tx.clone(),
        fanouts.clone(),
        terminal_emulator_clients.clone(),
        sessions.clone(),
        session_sizes.clone(),
        recovery_manager.clone(),
        daemon_lifecycle,
        handle.clone(),
    ));

    // The child exits immediately. Wait for the streamer to actually reach
    // the fence rather than sleeping and hoping.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if sessions.lock().await.seal_waiter_count() > 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the exit path must park on the handoff seal"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // And give it every chance to publish anyway if the fence did not hold.
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert_eq!(
        drain_exits(&mut rx, "dying"),
        0,
        "the outgoing daemon must not publish an Exit for a transferred session"
    );
    assert!(
        sessions.lock().await.contains("dying"),
        "the session belongs to the snapshot until the transfer resolves"
    );
    assert!(
        !stream_control.is_stopped(),
        "the stream is parked on the transfer, not torn down"
    );

    // The handoff aborts: this daemon keeps serving and owns the death again.
    sessions.lock().await.unseal_for_handoff();
    let _ = tokio::time::timeout(Duration::from_secs(5), streamer)
        .await
        .expect("the deferred exit must complete once the seal lifts");

    assert_eq!(
        drain_exits(&mut rx, "dying"),
        1,
        "an aborted handoff must publish exactly one Exit, not lose it"
    );
    assert!(
        !sessions.lock().await.contains("dying"),
        "normal exit cleanup resumes after the abort"
    );
}

/// Fault injection: a Kill that arrives AFTER the handoff snapshot has taken
/// the agent registry must be refused, not acknowledged. The successor daemon
/// adopts the session from that snapshot, so answering Ok here would report a
/// session dead to the client while it came back to life in the new daemon.
/// The PTY branch has always refused; the agent branch ran entirely outside
/// the seal.
#[tokio::test]
async fn a_kill_after_the_handoff_snapshot_is_refused_not_acknowledged() {
    let _serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    let dir = temp_daemon_dir("sealed-kill");
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, mut rx) = tokio::sync::broadcast::channel(32);

    let mut record = agent_record_fixture(&dir, "sealed");
    record.incarnation = kanna_daemon::agent::next_agent_incarnation();
    record.exited = false;
    agents.lock().await.insert("sealed".to_string(), record);

    // The snapshot is in flight: the seal is armed before it reads the
    // registry, so every later Kill must see it.
    let seal = crate::agent_runtime::AgentHandoffSealGuard::arm();
    assert_eq!(
        crate::agent_runtime::kill_agent_session("sealed", &agents, &broadcast_tx).await,
        crate::agent_runtime::AgentKillOutcome::HandoffInFlight,
        "a Kill racing a committed snapshot must be refused"
    );
    assert!(
        agents.lock().await.contains_key("sealed"),
        "a refused Kill must leave the session for the successor to adopt"
    );
    assert_eq!(
        drain_exits(&mut rx, "sealed"),
        0,
        "a refused Kill must not announce a death that did not happen"
    );

    // The handoff failed and this daemon keeps serving: the same Kill now
    // succeeds, so the refusal really is retryable rather than terminal.
    drop(seal);
    assert_eq!(
        crate::agent_runtime::kill_agent_session("sealed", &agents, &broadcast_tx).await,
        crate::agent_runtime::AgentKillOutcome::Killed
    );
    assert_eq!(drain_exits(&mut rx, "sealed"), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A Kill for an id that is not an agent session must report NotFound so the
/// dispatcher falls through to the PTY registry — the seal must not turn an
/// ordinary miss into a refusal.
#[tokio::test]
async fn a_kill_for_an_unknown_agent_session_reports_not_found() {
    // The handoff seal is process-global, and both Kill and install now
    // consult it: a test that expects either to SUCCEED must not overlap a
    // test that arms the seal.
    let _seal_serializer = crate::agent_runtime::seal_test_serializer().lock().await;
    let agents: kanna_daemon::agent::AgentSessions = Arc::new(Mutex::new(Default::default()));
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel(8);
    assert_eq!(
        crate::agent_runtime::kill_agent_session("nope", &agents, &broadcast_tx).await,
        crate::agent_runtime::AgentKillOutcome::NotFound
    );
}

/// Count the Exit events currently queued for one session id.
fn drain_exits(rx: &mut tokio::sync::broadcast::Receiver<String>, session: &str) -> usize {
    let mut seen = 0;
    while let Ok(line) = rx.try_recv() {
        if let Ok(Event::Exit { session_id, .. }) = serde_json::from_str::<Event>(&line) {
            if session_id == session {
                seen += 1;
            }
        }
    }
    seen
}

/// A same-id Spawn must not install while the outgoing incarnation's id-keyed
/// state is still being cleared: the teardown tombstone holds the id until the
/// Exit is published and every registry entry is gone, so the replacement
/// cannot have its own fanout/clients/sizes wiped by that cleanup.
#[tokio::test]
async fn teardown_tombstone_blocks_same_id_replacement_until_cleanup_completes() {
    use crate::session::{SessionHandle, SessionManager};

    let mut manager = SessionManager::new();
    let outgoing = Arc::new(SessionHandle::new(
        crate::session::test_support::spawn_sleeper_record().expect("record"),
    ));
    assert!(manager.insert_unless_sealed("swap".to_string(), outgoing.clone()));

    // Claim + tombstone, as the Kill handler does in one critical section.
    let taken = manager
        .get("swap")
        .and_then(|handle| manager.remove_if_same("swap", &handle));
    assert!(taken.is_some(), "claim takes the exact incarnation");
    assert!(manager.begin_teardown("swap"));
    assert!(manager.is_tearing_down("swap"));

    // A replacement must be refused while cleanup is in flight.
    let replacement = Arc::new(SessionHandle::new(
        crate::session::test_support::spawn_sleeper_record().expect("record"),
    ));
    assert!(
        !manager.insert_unless_sealed("swap".to_string(), replacement.clone()),
        "a same-id Spawn must not install into a half-cleaned slot"
    );

    // Once cleanup completes the id is usable again.
    manager.end_teardown("swap");
    assert!(manager.insert_unless_sealed("swap".to_string(), replacement.clone()));

    let _ = outgoing.kill().await;
    let _ = replacement.kill().await;
}
