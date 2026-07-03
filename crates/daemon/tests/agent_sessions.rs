//! Integration tests for daemon agent sessions (headless NDJSON children).
//!
//! These spawn a real daemon process and a fake agent script that emits
//! claude-shaped stream-json, then verify spawn / attach-replay / steering /
//! resume / permission flows through the real socket protocol.
//!
//! Run single-threaded like the other daemon tests:
//! `cargo test --test agent_sessions -- --test-threads=1`

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand};
use std::time::{Duration, Instant};

use kanna_agent_protocol::{AgentEvent, PermissionDecision, SessionEndReason};
use kanna_daemon::protocol::{AgentProvider, AgentSpawnParams, Command, Event, SeqAgentEvent};

// ---- Harness ----

fn compute_socket_path(dir: &Path) -> PathBuf {
    kanna_runtime_defaults::socket_path(dir)
}

fn temp_dir(prefix: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "kanna-agent-test-{prefix}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct DaemonHandle {
    child: Child,
    socket_path: PathBuf,
    dir: PathBuf,
}

impl DaemonHandle {
    fn start_in(dir: &Path) -> Self {
        let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_kanna-daemon"));
        let socket_path = compute_socket_path(dir);
        let pid_path = dir.join("daemon.pid");

        let child = StdCommand::new(&daemon_bin)
            .env("KANNA_DAEMON_DIR", dir.to_str().unwrap())
            .spawn()
            .expect("failed to start daemon");
        let expected_pid = child.id();

        for _ in 0..100 {
            if let Ok(pid_str) = std::fs::read_to_string(&pid_path) {
                if let Ok(pid) = pid_str.trim().parse::<u32>() {
                    if pid == expected_pid && UnixStream::connect(&socket_path).is_ok() {
                        break;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        DaemonHandle {
            child,
            socket_path,
            dir: dir.to_path_buf(),
        }
    }

    fn connect(&self) -> ClientConn {
        let stream = UnixStream::connect(&self.socket_path).expect("failed to connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        ClientConn {
            reader: BufReader::new(stream.try_clone().unwrap()),
            writer: stream,
        }
    }

    fn journal_path(&self, session_id: &str) -> PathBuf {
        self.dir
            .join("agent-journals")
            .join(format!("{session_id}.ndjson"))
    }
}

impl Drop for DaemonHandle {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct ClientConn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl ClientConn {
    fn send(&mut self, cmd: &Command) {
        let mut json = serde_json::to_string(cmd).unwrap();
        json.push('\n');
        self.writer.write_all(json.as_bytes()).unwrap();
        self.writer.flush().unwrap();
    }

    fn recv(&mut self) -> Event {
        let mut line = String::new();
        self.reader.read_line(&mut line).expect("read timed out");
        serde_json::from_str(line.trim())
            .unwrap_or_else(|e| panic!("failed to parse: {e} — {:?}", line.trim()))
    }

    /// Receive until `pred` matches an event; panics on timeout via the
    /// socket read timeout. Non-matching events are discarded.
    fn recv_until<F: Fn(&Event) -> bool>(&mut self, pred: F) -> Event {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            assert!(Instant::now() < deadline, "timed out waiting for event");
            let event = self.recv();
            if pred(&event) {
                return event;
            }
        }
    }

    /// Collect live agent events until one matches `stop` (inclusive).
    fn collect_agent_events_until<F: Fn(&AgentEvent) -> bool>(
        &mut self,
        stop: F,
    ) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            assert!(Instant::now() < deadline, "timed out collecting events");
            if let Event::AgentEvent { event, .. } = self.recv() {
                let done = stop(&event);
                events.push(event);
                if done {
                    return events;
                }
            }
        }
    }
}

fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn spawn_params(cwd: &Path, executable: &Path, prompt: &str) -> AgentSpawnParams {
    AgentSpawnParams {
        agent_provider: AgentProvider::Claude,
        prompt: prompt.to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        env: HashMap::new(),
        model: None,
        permission_mode: None,
        allowed_tools: Vec::new(),
        disallowed_tools: Vec::new(),
        max_turns: None,
        max_budget_usd: None,
        system_prompt: None,
        mcp_config_path: None,
        executable: Some(executable.to_string_lossy().to_string()),
    }
}

/// Fake agent: claude-shaped stream-json. First stdin line is the initial
/// prompt; each further line gets a steered response. Stays alive until EOF
/// (persistent turn model, like the real claude CLI).
const STEERABLE_AGENT: &str = r#"#!/bin/sh
read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-sess-1","model":"fake-model"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from fake"}]}}'
echo '{"type":"result","subtype":"success","duration_ms":5,"num_turns":1,"total_cost_usd":0.01,"usage":{},"session_id":"fake-sess-1"}'
while read -r line; do
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"steered"}]}}'
  echo '{"type":"result","subtype":"success","duration_ms":5,"num_turns":2,"total_cost_usd":0.02,"usage":{},"session_id":"fake-sess-1"}'
done
"#;

/// Fake agent that completes one turn and exits (forces the resume path).
const ONE_SHOT_AGENT: &str = r#"#!/bin/sh
read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-sess-resume","model":"fake-model"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"turn done"}]}}'
echo '{"type":"result","subtype":"success","duration_ms":5,"num_turns":1,"total_cost_usd":0.01,"usage":{},"session_id":"fake-sess-resume"}'
"#;

/// Fake agent for resume persistence. The initial run emits provider session id
/// `fake-sess-persisted`; a resume run only succeeds if the daemon passes that
/// id in the provider command line.
const RESUME_ID_ASSERTING_AGENT: &str = r#"#!/bin/sh
resume_id=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--resume" ]; then
    shift
    resume_id="${1:-}"
    break
  fi
  shift
done
if [ -n "$resume_id" ]; then
  if [ "$resume_id" != "fake-sess-persisted" ]; then
    echo "unexpected resume id: $resume_id" >&2
    exit 7
  fi
  echo '{"type":"system","subtype":"init","session_id":"fake-sess-persisted","model":"fake-model"}'
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"resumed with persisted id"}]}}'
  echo '{"type":"result","subtype":"success","duration_ms":5,"num_turns":2,"total_cost_usd":0.02,"usage":{},"session_id":"fake-sess-persisted"}'
  exit 0
fi
read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-sess-persisted","model":"fake-model"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"initial done"}]}}'
echo '{"type":"result","subtype":"success","duration_ms":5,"num_turns":1,"total_cost_usd":0.01,"usage":{},"session_id":"fake-sess-persisted"}'
"#;

/// Fake agent that raises two permission requests for the same tool.
const PERMISSION_AGENT: &str = r#"#!/bin/sh
read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-sess-perm","model":"fake-model"}'
echo '{"type":"control_request","request_id":"perm-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}'
read -r response1
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"first approved"}]}}'
echo '{"type":"control_request","request_id":"perm-2","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pwd"}}}'
read -r response2
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"second approved"}]}}'
echo '{"type":"result","subtype":"success","duration_ms":5,"num_turns":1,"total_cost_usd":0.01,"usage":{},"session_id":"fake-sess-perm"}'
while read -r line; do :; done
"#;

/// Fake claude agent that appends every stdin line it receives to `$STDIN_LOG`,
/// so tests can assert what the daemon wrote to the child (e.g. set_model).
const STDIN_LOGGING_AGENT: &str = r#"#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"fake-sess-model","model":"fake-model"}'
echo '{"type":"result","subtype":"success","duration_ms":1,"num_turns":1,"total_cost_usd":0,"usage":{},"session_id":"fake-sess-model"}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$STDIN_LOG"
done
"#;

/// Fake codex agent: starts a turn, then blocks until signaled. Codex has no
/// stdin protocol, so the daemon interrupts it with SIGINT (the path that used
/// to be misreported as a crash).
const CODEX_SLEEPER_AGENT: &str = r#"#!/bin/sh
echo '{"type":"thread.started","thread_id":"fake-thread"}'
echo '{"type":"turn.started"}'
sleep 30
"#;

fn is_session_ended(event: &AgentEvent) -> bool {
    matches!(event, AgentEvent::SessionEnded { .. })
}

fn is_turn_completed(event: &AgentEvent) -> bool {
    matches!(event, AgentEvent::TurnCompleted { .. })
}

// ---- Tests ----

#[test]
fn spawn_attach_replay_and_steer() {
    let dir = temp_dir("steer");
    let script = write_script(&dir, "fake-agent.sh", STEERABLE_AGENT);
    let daemon = DaemonHandle::start_in(&dir);

    let mut conn = daemon.connect();
    conn.send(&Command::SpawnAgent {
        session_id: "agent-1".to_string(),
        params: spawn_params(&dir, &script, "do the thing"),
    });
    conn.recv_until(|e| matches!(e, Event::SessionCreated { .. }));

    // Attach from 0: snapshot must contain at least the journaled prompt.
    conn.send(&Command::AttachAgent {
        session_id: "agent-1".to_string(),
        from_seq: 0,
    });
    let snapshot = conn.recv_until(|e| matches!(e, Event::AgentSnapshot { .. }));
    let (snapshot_events, next_seq) = match snapshot {
        Event::AgentSnapshot {
            events, next_seq, ..
        } => (events, next_seq),
        _ => unreachable!(),
    };
    assert!(
        matches!(&snapshot_events[0].event, AgentEvent::UserMessage { text } if text == "do the thing"),
        "seq 0 must be the journaled prompt, got {:?}",
        snapshot_events.first()
    );
    assert_eq!(snapshot_events[0].seq, 0);
    assert_eq!(next_seq, snapshot_events.len() as u64);

    // Live (or already-snapshotted) events: init → TurnStarted, text, result.
    let mut all: Vec<AgentEvent> = snapshot_events.into_iter().map(|e| e.event).collect();
    if !all.iter().any(is_turn_completed) {
        all.extend(conn.collect_agent_events_until(is_turn_completed));
    }
    assert!(all
        .iter()
        .any(|e| matches!(e, AgentEvent::TurnStarted { model: Some(m) } if m == "fake-model")));
    assert!(all
        .iter()
        .any(|e| matches!(e, AgentEvent::AssistantText { text, .. } if text == "hello from fake")));

    // Steering: mid-session input reaches the child's stdin.
    conn.send(&Command::AgentInput {
        session_id: "agent-1".to_string(),
        text: "steer me".to_string(),
    });
    let steered = conn.collect_agent_events_until(is_turn_completed);
    assert!(steered
        .iter()
        .any(|e| matches!(e, AgentEvent::UserMessage { text } if text == "steer me")));
    assert!(steered
        .iter()
        .any(|e| matches!(e, AgentEvent::AssistantText { text, .. } if text == "steered")));

    // A second client attaching with from_seq replays only the tail.
    let total_events = {
        let mut probe = daemon.connect();
        probe.send(&Command::AttachAgent {
            session_id: "agent-1".to_string(),
            from_seq: 0,
        });
        match probe.recv_until(|e| matches!(e, Event::AgentSnapshot { .. })) {
            Event::AgentSnapshot { next_seq, .. } => next_seq,
            _ => unreachable!(),
        }
    };
    let mut tail_conn = daemon.connect();
    tail_conn.send(&Command::AttachAgent {
        session_id: "agent-1".to_string(),
        from_seq: total_events - 1,
    });
    match tail_conn.recv_until(|e| matches!(e, Event::AgentSnapshot { .. })) {
        Event::AgentSnapshot { events, .. } => {
            assert_eq!(events.len(), 1, "tail attach must replay exactly one event");
            assert_eq!(events[0].seq, total_events - 1);
        }
        _ => unreachable!(),
    }

    // Journal persisted to disk under the daemon data dir.
    let journal = std::fs::read_to_string(daemon.journal_path("agent-1")).unwrap();
    let first: SeqAgentEvent = serde_json::from_str(journal.lines().next().unwrap()).unwrap();
    assert_eq!(first.seq, 0);
}

#[test]
fn input_after_exit_resumes_via_respawn() {
    let dir = temp_dir("resume");
    let script = write_script(&dir, "one-shot.sh", ONE_SHOT_AGENT);
    let daemon = DaemonHandle::start_in(&dir);

    let mut conn = daemon.connect();
    conn.send(&Command::SpawnAgent {
        session_id: "agent-r".to_string(),
        params: spawn_params(&dir, &script, "first prompt"),
    });
    conn.recv_until(|e| matches!(e, Event::SessionCreated { .. }));
    conn.send(&Command::AttachAgent {
        session_id: "agent-r".to_string(),
        from_seq: 0,
    });
    conn.recv_until(|e| matches!(e, Event::AgentSnapshot { .. }));

    // Wait for the one-shot child to finish its turn and exit.
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !seen.iter().any(is_turn_completed) {
        assert!(Instant::now() < deadline, "first turn never completed");
        if let Event::AgentEvent { event, .. } = conn.recv() {
            seen.push(event);
        }
    }
    // Give the daemon a moment to observe EOF and reap the child.
    std::thread::sleep(Duration::from_millis(500));

    // Input after exit must respawn (the fake ignores --resume args but the
    // daemon path is identical to the real one).
    conn.send(&Command::AgentInput {
        session_id: "agent-r".to_string(),
        text: "second prompt".to_string(),
    });
    let resumed = conn.collect_agent_events_until(is_turn_completed);
    assert!(resumed
        .iter()
        .any(|e| matches!(e, AgentEvent::UserMessage { text } if text == "second prompt")));
    assert!(resumed
        .iter()
        .any(|e| matches!(e, AgentEvent::AssistantText { text, .. } if text == "turn done")));
}

#[test]
fn input_after_handoff_uses_persisted_provider_session_id() {
    let dir = temp_dir("resume-persisted");
    let script = write_script(&dir, "resume-id-agent.sh", RESUME_ID_ASSERTING_AGENT);
    let old_daemon = DaemonHandle::start_in(&dir);

    let mut conn = old_daemon.connect();
    conn.send(&Command::SpawnAgent {
        session_id: "agent-rp".to_string(),
        params: spawn_params(&dir, &script, "first prompt"),
    });
    conn.recv_until(|e| matches!(e, Event::SessionCreated { .. }));
    conn.send(&Command::AttachAgent {
        session_id: "agent-rp".to_string(),
        from_seq: 0,
    });
    conn.recv_until(|e| matches!(e, Event::AgentSnapshot { .. }));
    conn.collect_agent_events_until(is_turn_completed);
    std::thread::sleep(Duration::from_millis(500));

    let new_daemon = DaemonHandle::start_in(&dir);
    drop(conn);
    drop(old_daemon);

    let mut conn2 = new_daemon.connect();
    conn2.send(&Command::AttachAgent {
        session_id: "agent-rp".to_string(),
        from_seq: 0,
    });
    conn2.recv_until(|e| matches!(e, Event::AgentSnapshot { .. }));
    conn2.send(&Command::AgentInput {
        session_id: "agent-rp".to_string(),
        text: "second prompt".to_string(),
    });
    let resumed = conn2.collect_agent_events_until(is_turn_completed);
    assert!(resumed.iter().any(|e| matches!(
        e,
        AgentEvent::AssistantText { text, .. } if text == "resumed with persisted id"
    )));
}

#[test]
fn permission_flow_with_allow_session_auto_approval() {
    let dir = temp_dir("perm");
    let script = write_script(&dir, "perm-agent.sh", PERMISSION_AGENT);
    let daemon = DaemonHandle::start_in(&dir);

    let mut conn = daemon.connect();
    conn.send(&Command::SpawnAgent {
        session_id: "agent-p".to_string(),
        params: spawn_params(&dir, &script, "needs permissions"),
    });
    conn.recv_until(|e| matches!(e, Event::SessionCreated { .. }));
    conn.send(&Command::AttachAgent {
        session_id: "agent-p".to_string(),
        from_seq: 0,
    });
    conn.recv_until(|e| matches!(e, Event::AgentSnapshot { .. }));

    // First permission request surfaces for a decision.
    let until_first_request = conn.collect_agent_events_until(
        |e| matches!(e, AgentEvent::PermissionRequest { request_id, .. } if request_id == "perm-1"),
    );
    assert!(until_first_request.iter().any(
        |e| matches!(e, AgentEvent::PermissionRequest { tool_name, .. } if tool_name == "Bash")
    ));

    // Answer with AllowSession: resolves perm-1 AND auto-approves perm-2.
    conn.send(&Command::AgentPermission {
        session_id: "agent-p".to_string(),
        request_id: "perm-1".to_string(),
        decision: PermissionDecision::AllowSession,
    });

    let rest = conn.collect_agent_events_until(is_turn_completed);
    assert!(rest.iter().any(|e| matches!(
        e,
        AgentEvent::PermissionResolved { request_id, .. } if request_id == "perm-1"
    )));
    assert!(
        rest.iter().any(|e| matches!(
            e,
            AgentEvent::PermissionResolved { request_id, decision: PermissionDecision::AllowSession } if request_id == "perm-2"
        )),
        "second request for the same tool must be auto-approved without a client decision; got {rest:?}"
    );
    assert!(rest
        .iter()
        .any(|e| matches!(e, AgentEvent::AssistantText { text, .. } if text == "second approved")));

    // Answering an already-resolved request is an error (first decision wins).
    conn.send(&Command::AgentPermission {
        session_id: "agent-p".to_string(),
        request_id: "perm-1".to_string(),
        decision: PermissionDecision::Allow,
    });
    conn.recv_until(|e| matches!(e, Event::Error { .. }));
}

#[test]
fn agent_session_survives_daemon_handoff() {
    let dir = temp_dir("handoff");
    let script = write_script(&dir, "fake-agent.sh", STEERABLE_AGENT);
    let old_daemon = DaemonHandle::start_in(&dir);

    let mut conn = old_daemon.connect();
    conn.send(&Command::SpawnAgent {
        session_id: "agent-h".to_string(),
        params: spawn_params(&dir, &script, "survive the swap"),
    });
    conn.recv_until(|e| matches!(e, Event::SessionCreated { .. }));
    conn.send(&Command::AttachAgent {
        session_id: "agent-h".to_string(),
        from_seq: 0,
    });
    conn.recv_until(|e| matches!(e, Event::AgentSnapshot { .. }));
    // Let the first turn land in the journal before swapping daemons.
    conn.collect_agent_events_until(is_turn_completed);

    // Start a new daemon in the same dir — it performs handoff; the old one exits.
    let new_daemon = DaemonHandle::start_in(&dir);
    drop(conn);
    drop(old_daemon); // kill() on the already-exited old daemon is harmless

    // The journal (including pre-handoff events) must replay from the new daemon.
    let mut conn2 = new_daemon.connect();
    conn2.send(&Command::AttachAgent {
        session_id: "agent-h".to_string(),
        from_seq: 0,
    });
    let snapshot = conn2.recv_until(|e| matches!(e, Event::AgentSnapshot { .. }));
    let events = match snapshot {
        Event::AgentSnapshot { events, .. } => events,
        _ => unreachable!(),
    };
    assert!(events.iter().any(|e| matches!(
        &e.event,
        AgentEvent::UserMessage { text } if text == "survive the swap"
    )));
    assert!(events.iter().any(|e| matches!(
        &e.event,
        AgentEvent::AssistantText { text, .. } if text == "hello from fake"
    )));

    // The child's pipes survived: steering still works through the new daemon.
    conn2.send(&Command::AgentInput {
        session_id: "agent-h".to_string(),
        text: "still alive?".to_string(),
    });
    let steered = conn2.collect_agent_events_until(is_turn_completed);
    assert!(steered
        .iter()
        .any(|e| matches!(e, AgentEvent::AssistantText { text, .. } if text == "steered")));
}

#[test]
fn interrupt_is_surfaced_as_interrupted_not_crashed() {
    let dir = temp_dir("interrupt");
    let script = write_script(&dir, "codex-sleeper.sh", CODEX_SLEEPER_AGENT);
    let daemon = DaemonHandle::start_in(&dir);

    let mut conn = daemon.connect();
    let mut params = spawn_params(&dir, &script, "do work");
    params.agent_provider = AgentProvider::Codex;
    conn.send(&Command::SpawnAgent {
        session_id: "agent-int".to_string(),
        params,
    });
    conn.recv_until(|e| matches!(e, Event::SessionCreated { .. }));

    // Attach and wait until the turn is actually running, so the interrupt
    // lands on a live child rather than racing the spawn.
    conn.send(&Command::AttachAgent {
        session_id: "agent-int".to_string(),
        from_seq: 0,
    });
    conn.collect_agent_events_until(|e| matches!(e, AgentEvent::TurnStarted { .. }));

    conn.send(&Command::AgentInterrupt {
        session_id: "agent-int".to_string(),
    });

    // The SIGINT-driven exit must be reported as an interruption, not a crash.
    let events = conn.collect_agent_events_until(is_session_ended);
    let ended = events.iter().rev().find(|e| is_session_ended(e)).unwrap();
    assert!(
        matches!(
            ended,
            AgentEvent::SessionEnded {
                reason: SessionEndReason::Interrupted,
                ..
            }
        ),
        "stopping the agent must read as interrupted, not crashed: {ended:?}"
    );
}

#[test]
fn set_model_writes_a_control_line_to_stdin() {
    let dir = temp_dir("setmodel");
    let stdin_log = dir.join("stdin.log");
    let script = write_script(&dir, "stdin-logger.sh", STDIN_LOGGING_AGENT);
    let daemon = DaemonHandle::start_in(&dir);

    let mut conn = daemon.connect();
    let mut params = spawn_params(&dir, &script, "go");
    params.env.insert(
        "STDIN_LOG".to_string(),
        stdin_log.to_string_lossy().to_string(),
    );
    conn.send(&Command::SpawnAgent {
        session_id: "agent-m".to_string(),
        params,
    });
    conn.recv_until(|e| matches!(e, Event::SessionCreated { .. }));

    conn.send(&Command::AgentSetModel {
        session_id: "agent-m".to_string(),
        model: "claude-haiku-4-5-20251001".to_string(),
    });
    conn.recv_until(|e| matches!(e, Event::Ok));

    // The set_model control line must reach the live child's stdin.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let log = std::fs::read_to_string(&stdin_log).unwrap_or_default();
        if log.contains("set_model") && log.contains("claude-haiku-4-5-20251001") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "set_model never reached stdin; log=\n{log}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn kill_removes_agent_session() {
    let dir = temp_dir("kill");
    let script = write_script(&dir, "fake-agent.sh", STEERABLE_AGENT);
    let daemon = DaemonHandle::start_in(&dir);

    let mut conn = daemon.connect();
    conn.send(&Command::SpawnAgent {
        session_id: "agent-k".to_string(),
        params: spawn_params(&dir, &script, "kill me"),
    });
    conn.recv_until(|e| matches!(e, Event::SessionCreated { .. }));

    conn.send(&Command::Kill {
        session_id: "agent-k".to_string(),
    });
    conn.recv_until(|e| matches!(e, Event::Ok));

    // Session is gone: attach now fails.
    conn.send(&Command::AttachAgent {
        session_id: "agent-k".to_string(),
        from_seq: 0,
    });
    conn.recv_until(|e| matches!(e, Event::Error { .. }));

    // Journal file is kept on disk until task cleanup, ending with the kill.
    let journal = std::fs::read_to_string(daemon.journal_path("agent-k")).unwrap();
    let last: SeqAgentEvent = serde_json::from_str(journal.lines().last().unwrap()).unwrap();
    assert!(matches!(last.event, AgentEvent::SessionEnded { .. }));
}
