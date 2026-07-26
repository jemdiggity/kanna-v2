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
use kanna_daemon::protocol::{
    AgentProvider, AgentSpawnParams, Command, Event, SeqAgentEvent, SessionState, SessionStatus,
};

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
        Self::start_in_with_env(dir, &[])
    }

    fn start_in_with_env(dir: &Path, env_pairs: &[(&str, &str)]) -> Self {
        let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_kanna-daemon"));
        let socket_path = compute_socket_path(dir);
        let pid_path = dir.join("daemon.pid");

        let mut command = StdCommand::new(&daemon_bin);
        command.env("KANNA_DAEMON_DIR", dir.to_str().unwrap());
        command.envs(env_pairs.iter().copied());
        let child = command.spawn().expect("failed to start daemon");
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

    /// Attach to an agent and collect replayed plus live events until one
    /// matches `stop` (inclusive).
    fn attach_and_collect_agent_events_until<F: Fn(&AgentEvent) -> bool>(
        &mut self,
        session_id: &str,
        from_seq: u64,
        stop: F,
    ) -> Vec<AgentEvent> {
        self.send(&Command::AttachAgent {
            session_id: session_id.to_string(),
            from_seq,
        });

        let snapshot = self.recv_until(|event| {
            matches!(
                event,
                Event::AgentSnapshot {
                    session_id: snapshot_session_id,
                    ..
                } if snapshot_session_id == session_id
            )
        });
        let mut events = match snapshot {
            Event::AgentSnapshot { events, .. } => events
                .into_iter()
                .map(|sequenced| sequenced.event)
                .collect::<Vec<_>>(),
            _ => unreachable!(),
        };

        if let Some(stop_index) = events.iter().position(&stop) {
            events.truncate(stop_index + 1);
            return events;
        }

        events.extend(self.collect_agent_events_until(stop));
        events
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
        resume_session_id: None,
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

/// Closes its pipes after initialization but keeps the process alive. EOF
/// handling must release stdin and reap it without holding the global agent
/// session registry.
const STDOUT_CLOSING_LINGERER: &str = r#"#!/bin/sh
read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-sess-linger","model":"fake-model"}'
exec 1>&-
exec 0<&-
sleep 300
"#;

#[test]
fn lingering_child_after_stdout_eof_is_reaped_without_wedging_the_registry() {
    let dir = temp_dir("linger");
    let script = write_script(&dir, "lingering-agent.sh", STDOUT_CLOSING_LINGERER);
    let daemon = DaemonHandle::start_in(&dir);

    let mut conn = daemon.connect();
    conn.send(&Command::SpawnAgent {
        session_id: "agent-linger".to_string(),
        params: spawn_params(&dir, &script, "linger now"),
    });
    conn.recv_until(|event| matches!(event, Event::SessionCreated { .. }));

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(
            Instant::now() < deadline,
            "lingering child was never reaped; registry likely wedged"
        );
        let mut list_conn = daemon.connect();
        list_conn.send(&Command::List);
        let event = list_conn.recv_until(|event| matches!(event, Event::SessionList { .. }));
        let Event::SessionList { sessions, .. } = event else {
            unreachable!()
        };
        let session = sessions
            .iter()
            .find(|info| info.session_id == "agent-linger")
            .expect("agent session missing from List");
        if matches!(session.state, SessionState::Exited(_)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

const COUNTED_ONE_SHOT_AGENT: &str = r#"#!/bin/sh
printf '%s\n' "$$" >> "$SPAWN_LOG"
read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-sess-counted","model":"fake-model"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"counted turn done"}]}}'
echo '{"type":"result","subtype":"success","duration_ms":5,"num_turns":1,"total_cost_usd":0.01,"usage":{},"session_id":"fake-sess-counted"}'
"#;

const COUNTED_CODEX_ONE_SHOT_AGENT: &str = r#"#!/bin/sh
printf '%s\n' "$$" >> "$SPAWN_LOG"
echo '{"type":"thread.started","thread_id":"fake-thread-counted"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"counted turn done"}}'
echo '{"type":"turn.completed","usage":{}}'
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

/// Fake persistent agent that accepts stdin but emits no provider events.
/// This keeps the first post-attach fan-out deterministic for stall tests.
const QUIET_STDIN_AGENT: &str = r#"#!/bin/sh
read -r first
while IFS= read -r line; do :; done
"#;

/// Fake codex agent: starts a turn, then blocks until signaled. Codex has no
/// stdin protocol, so the daemon interrupts it with SIGINT (the path that used
/// to be misreported as a crash). Keep the blocker in shell builtins because
/// `/bin/sh` can defer traps while waiting for an external foreground process.
const CODEX_SLEEPER_AGENT: &str = r#"#!/bin/sh
trap 'exit 130' INT TERM
echo '{"type":"thread.started","thread_id":"fake-thread"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"interim answer"}}'
while :; do :; done
"#;

const CODEX_ONE_SHOT_AGENT: &str = r#"#!/bin/sh
echo '{"type":"thread.started","thread_id":"fake-thread-idle"}'
echo '{"type":"turn.started"}'
echo '{"type":"turn.completed","usage":{}}'
"#;

/// Fake persistent agent that emits an interim answer, then crashes before a
/// successful turn-completed event can make that answer publishable.
const CRASHING_AGENT: &str = r#"#!/bin/sh
read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-sess-crash","model":"fake-model"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"interim answer"}]}}'
exit 7
"#;

/// Fake persistent agent that remains busy after an interim answer so the
/// orchestrated-kill path can be asserted independently from normal completion.
const BUSY_ASSISTANT_AGENT: &str = r#"#!/bin/sh
read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-sess-kill","model":"fake-model"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"interim answer"}]}}'
sleep 30
"#;

/// Fake opencode agent: reports the `--dir` value it was given. Real
/// `opencode run` uses this flag to choose the project directory for headless
/// tool execution, so process cwd alone is not enough.
const OPENCODE_DIR_REPORTER_AGENT: &str = r#"#!/bin/sh
dir_arg=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--dir" ]; then
    shift
    dir_arg="${1:-}"
    break
  fi
  shift
done
if [ -z "$dir_arg" ]; then
  dir_arg="missing:$(pwd)"
fi
printf '{"type":"step_start","sessionID":"fake-opencode","timestamp":1,"part":{"type":"step-start","id":"step-1","messageID":"msg-1"}}\n'
printf '{"type":"text","sessionID":"fake-opencode","timestamp":2,"part":{"type":"text","text":"dir=%s"}}\n' "$dir_arg"
printf '{"type":"step_finish","sessionID":"fake-opencode","timestamp":3,"part":{"type":"step-finish","id":"step-1","messageID":"msg-1"}}\n'
"#;

fn is_session_ended(event: &AgentEvent) -> bool {
    matches!(event, AgentEvent::SessionEnded { .. })
}

fn is_turn_completed(event: &AgentEvent) -> bool {
    matches!(event, AgentEvent::TurnCompleted { .. })
}

// ---- Tests ----

#[test]
fn idle_per_turn_kill_emits_before_reused_session_successor_exit() {
    for (label, provider, script_body) in [
        ("codex", AgentProvider::Codex, CODEX_ONE_SHOT_AGENT),
        (
            "opencode",
            AgentProvider::Opencode,
            OPENCODE_DIR_REPORTER_AGENT,
        ),
    ] {
        let dir = temp_dir(&format!("idle-kill-{label}"));
        let script = write_script(&dir, &format!("{label}-one-shot.sh"), script_body);
        let successor = write_script(&dir, "successor.sh", ONE_SHOT_AGENT);
        let daemon = DaemonHandle::start_in(&dir);
        let session_id = format!("agent-idle-{label}");

        let mut subscriber = daemon.connect();
        subscriber.send(&Command::Subscribe);
        assert!(matches!(subscriber.recv(), Event::Ok));

        let mut control = daemon.connect();
        let mut params = spawn_params(&dir, &script, "finish one turn");
        params.agent_provider = provider;
        params.env.insert(
            "KANNA_STAGE_RUN_ID".to_string(),
            format!("run-{label}-source"),
        );
        control.send(&Command::SpawnAgent {
            session_id: session_id.clone(),
            params,
        });
        control.recv_until(|event| matches!(event, Event::SessionCreated { .. }));
        subscriber.recv_until(|event| {
            matches!(
                event,
                Event::StatusChanged {
                    session_id: id,
                    status: SessionStatus::Idle,
                    ..
                } if id == &session_id
            )
        });

        control.send(&Command::Kill {
            session_id: session_id.clone(),
            expected_run_id: Some(format!("run-{label}-source")),
        });
        assert!(matches!(control.recv(), Event::Ok));
        let killed = subscriber.recv_until(|event| {
            matches!(
                event,
                Event::Exit {
                    session_id: id,
                    killed: true,
                    ..
                } if id == &session_id
            )
        });
        assert!(matches!(
            killed,
            Event::Exit {
                run_id: Some(ref run_id),
                ..
            } if run_id == &format!("run-{label}-source")
        ));

        let mut successor_params = spawn_params(&dir, &successor, "successor turn");
        successor_params.env.insert(
            "KANNA_STAGE_RUN_ID".to_string(),
            format!("run-{label}-successor"),
        );
        control.send(&Command::SpawnAgent {
            session_id: session_id.clone(),
            params: successor_params,
        });
        control.recv_until(|event| matches!(event, Event::SessionCreated { .. }));
        let successor_exit = subscriber.recv_until(|event| {
            matches!(
                event,
                Event::Exit {
                    session_id: id,
                    killed: false,
                    ..
                } if id == &session_id
            )
        });
        assert!(matches!(
            successor_exit,
            Event::Exit {
                run_id: Some(ref run_id),
                ..
            } if run_id == &format!("run-{label}-successor")
        ));
    }
}

#[test]
fn idle_status_broadcast_carries_latest_assistant_text() {
    let dir = temp_dir("waiting-prompt-status");
    let script = write_script(&dir, "fake-agent.sh", STEERABLE_AGENT);
    let daemon = DaemonHandle::start_in(&dir);

    let mut subscriber = daemon.connect();
    subscriber.send(&Command::Subscribe);
    assert!(matches!(subscriber.recv(), Event::Ok));

    let mut control = daemon.connect();
    control.send(&Command::SpawnAgent {
        session_id: "agent-waiting-prompt".to_string(),
        params: spawn_params(&dir, &script, "do the thing"),
    });
    control.recv_until(|event| matches!(event, Event::SessionCreated { .. }));

    let status = subscriber.recv_until(|event| {
        matches!(
            event,
            Event::StatusChanged {
                session_id,
                status: SessionStatus::Idle,
                ..
            } if session_id == "agent-waiting-prompt"
        )
    });
    assert!(matches!(
        status,
        Event::StatusChanged {
            waiting_prompt_snippet: Some(prompt),
            ..
        } if prompt == "hello from fake"
    ));
}

#[test]
fn headless_session_broadcasts_discovered_provider_session_id() {
    let dir = temp_dir("provider-session-broadcast");
    let script = write_script(&dir, "fake-agent.sh", STEERABLE_AGENT);
    let daemon = DaemonHandle::start_in(&dir);

    let mut subscriber = daemon.connect();
    subscriber.send(&Command::SubscribeEvents {
        version: kanna_daemon::protocol::CURRENT_EVENT_STREAM_VERSION,
    });
    assert!(matches!(subscriber.recv(), Event::Ok));

    let mut control = daemon.connect();
    control.send(&Command::SpawnAgent {
        session_id: "agent-provider-session".to_string(),
        params: spawn_params(&dir, &script, "do the thing"),
    });
    control.recv_until(|event| matches!(event, Event::SessionCreated { .. }));

    let event = subscriber.recv_until(|event| {
        matches!(
            event,
            Event::ProviderSessionChanged { session_id, .. }
                if session_id == "agent-provider-session"
        )
    });
    assert!(matches!(
        event,
        Event::ProviderSessionChanged {
            provider_session_id,
            ..
        } if provider_session_id == "fake-sess-1"
    ));
}

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
fn input_arriving_while_eof_is_reaping_reaches_one_successor_and_is_journaled_once() {
    let dir = temp_dir("input-during-reap");
    let script = write_script(
        &dir,
        "counted-codex-one-shot.sh",
        COUNTED_CODEX_ONE_SHOT_AGENT,
    );
    let spawn_log = dir.join("spawn.log");
    let reap_barrier = dir.join("child-reaping-barrier");
    let exit_state_barrier = dir.join("child-exit-state-barrier");
    let input_plan_barrier = dir.join("agent-input-plan-barrier");
    let daemon = DaemonHandle::start_in(&dir);

    let mut conn = daemon.connect();
    conn.reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    let mut params = spawn_params(&dir, &script, "first prompt");
    params.agent_provider = AgentProvider::Codex;
    params.env.insert(
        "SPAWN_LOG".to_string(),
        spawn_log.to_string_lossy().into_owned(),
    );
    params.env.insert(
        "KANNA_TEST_CHILD_REAPING_BARRIER".to_string(),
        reap_barrier.to_string_lossy().into_owned(),
    );
    params.env.insert(
        "KANNA_TEST_CHILD_EXIT_STATE_BARRIER".to_string(),
        exit_state_barrier.to_string_lossy().into_owned(),
    );
    params.env.insert(
        "KANNA_TEST_AGENT_INPUT_PLAN_BARRIER".to_string(),
        input_plan_barrier.to_string_lossy().into_owned(),
    );
    conn.send(&Command::SpawnAgent {
        session_id: "agent-reaping".to_string(),
        params,
    });
    conn.recv_until(|event| matches!(event, Event::SessionCreated { .. }));
    conn.send(&Command::AttachAgent {
        session_id: "agent-reaping".to_string(),
        from_seq: 0,
    });
    conn.recv_until(|event| matches!(event, Event::AgentSnapshot { .. }));
    conn.collect_agent_events_until(is_turn_completed);

    let barrier_deadline = Instant::now() + Duration::from_secs(5);
    while !exit_state_barrier.join("before-reaping").exists() {
        assert!(
            Instant::now() < barrier_deadline,
            "EOF handler did not pause before publishing reaping state"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    conn.send(&Command::AgentInput {
        session_id: "agent-reaping".to_string(),
        text: "revision during reap".to_string(),
    });
    while !input_plan_barrier.join("captured").exists() {
        assert!(
            Instant::now() < barrier_deadline,
            "input did not pause before deriving its delivery plan"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    // Let input planning win the registry race while the per-turn child is
    // still live. It must wait for exited=true rather than reserving a
    // successor that cannot pass the install guard.
    std::fs::write(input_plan_barrier.join("release"), b"").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        std::fs::read_to_string(&spawn_log).unwrap().lines().count(),
        1,
        "input must not respawn before EOF publishes the old child as exited"
    );

    std::fs::write(exit_state_barrier.join("release"), b"").unwrap();
    while !reap_barrier.join("reaping").exists() {
        assert!(
            Instant::now() < barrier_deadline,
            "EOF reaping barrier was never reached"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        std::fs::read_to_string(&spawn_log).unwrap().lines().count(),
        1,
        "input must wait for the exiting child to finish reaping"
    );
    std::fs::write(reap_barrier.join("release"), b"").unwrap();

    let mut saw_ok = false;
    let mut saw_turn_completed = false;
    while !saw_ok || !saw_turn_completed {
        match conn.recv() {
            Event::Ok => saw_ok = true,
            Event::AgentEvent { event, .. } if is_turn_completed(&event) => {
                saw_turn_completed = true;
            }
            _ => {}
        }
    }

    let journal = std::fs::read_to_string(daemon.journal_path("agent-reaping")).unwrap();
    let accepted_inputs = journal
        .lines()
        .map(|line| serde_json::from_str::<SeqAgentEvent>(line).unwrap())
        .filter(|entry| {
            matches!(
                &entry.event,
                AgentEvent::UserMessage { text } if text == "revision during reap"
            )
        })
        .count();
    assert_eq!(accepted_inputs, 1, "accepted input must be journaled once");
    assert_eq!(
        std::fs::read_to_string(spawn_log).unwrap().lines().count(),
        2,
        "initial child plus exactly one successor should run"
    );
}

#[test]
fn concurrent_per_turn_inputs_install_only_one_respawn_child() {
    let dir = temp_dir("concurrent-respawn");
    let script = write_script(&dir, "counted-one-shot.sh", COUNTED_ONE_SHOT_AGENT);
    let spawn_log = dir.join("spawn.log");
    let barrier = dir.join("respawn-install-barrier");
    let daemon = DaemonHandle::start_in(&dir);

    let mut first = daemon.connect();
    first
        .reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    let mut params = spawn_params(&dir, &script, "first prompt");
    params.env.insert(
        "SPAWN_LOG".to_string(),
        spawn_log.to_string_lossy().into_owned(),
    );
    params.env.insert(
        "KANNA_TEST_RESPAWN_INSTALL_BARRIER".to_string(),
        barrier.to_string_lossy().into_owned(),
    );
    first.send(&Command::SpawnAgent {
        session_id: "agent-concurrent".to_string(),
        params,
    });
    first.recv_until(|event| matches!(event, Event::SessionCreated { .. }));
    first.send(&Command::AttachAgent {
        session_id: "agent-concurrent".to_string(),
        from_seq: 0,
    });
    first.recv_until(|event| matches!(event, Event::AgentSnapshot { .. }));
    first.collect_agent_events_until(is_turn_completed);
    std::thread::sleep(Duration::from_millis(250));

    first.send(&Command::AgentInput {
        session_id: "agent-concurrent".to_string(),
        text: "winner prompt".to_string(),
    });
    let barrier_deadline = Instant::now() + Duration::from_secs(5);
    while !barrier.join("spawned").exists() {
        assert!(
            Instant::now() < barrier_deadline,
            "respawn install barrier was never reached"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    let mut second = daemon.connect();
    second
        .reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    second.send(&Command::AgentInput {
        session_id: "agent-concurrent".to_string(),
        text: "losing prompt".to_string(),
    });
    assert!(matches!(
        second.recv_until(|event| matches!(event, Event::Error { .. })),
        Event::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::WriteFailed),
            ..
        }
    ));

    std::fs::write(barrier.join("release"), b"").unwrap();
    // Reader output may beat the command reply once the install barrier is
    // released, so retain both signals instead of discarding agent events
    // while waiting for Ok.
    let mut saw_ok = false;
    let mut saw_turn_completed = false;
    while !saw_ok || !saw_turn_completed {
        match first.recv() {
            Event::Ok => saw_ok = true,
            Event::AgentEvent { event, .. } if is_turn_completed(&event) => {
                saw_turn_completed = true;
            }
            _ => {}
        }
    }

    let journal = std::fs::read_to_string(daemon.journal_path("agent-concurrent")).unwrap();
    assert!(journal.contains("winner prompt"), "{journal}");
    assert!(!journal.contains("losing prompt"), "{journal}");
    let child_count = std::fs::read_to_string(spawn_log).unwrap().lines().count();
    assert_eq!(
        child_count, 2,
        "initial child plus exactly one respawn child should run"
    );
}

#[test]
fn persistent_input_captured_before_kill_cannot_reach_or_journal_successor() {
    let dir = temp_dir("persistent-input-generation");
    let script = write_script(&dir, "stdin-logger.sh", STDIN_LOGGING_AGENT);
    let old_stdin_log = dir.join("old-stdin.log");
    let successor_stdin_log = dir.join("successor-stdin.log");
    let barrier = dir.join("persistent-input-barrier");
    let daemon = DaemonHandle::start_in_with_env(
        &dir,
        &[(
            "KANNA_TEST_PERSISTENT_INPUT_BARRIER",
            barrier.to_str().unwrap(),
        )],
    );

    let mut owner = daemon.connect();
    let mut old_params = spawn_params(&dir, &script, "old initial prompt");
    old_params.env.insert(
        "STDIN_LOG".to_string(),
        old_stdin_log.to_string_lossy().into_owned(),
    );
    old_params
        .env
        .insert("KANNA_STAGE_RUN_ID".to_string(), "run-old".to_string());
    owner.send(&Command::SpawnAgent {
        session_id: "agent-reused".to_string(),
        params: old_params,
    });
    owner.recv_until(|event| matches!(event, Event::SessionCreated { .. }));

    let mut delayed_input = daemon.connect();
    delayed_input.send(&Command::AgentInput {
        session_id: "agent-reused".to_string(),
        text: "must stay with old run".to_string(),
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !barrier.join("captured").exists() {
        assert!(
            Instant::now() < deadline,
            "persistent input never reached the capture barrier"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    owner.send(&Command::Kill {
        session_id: "agent-reused".to_string(),
        expected_run_id: Some("run-old".to_string()),
    });
    owner.recv_until(|event| matches!(event, Event::Ok));

    let mut successor_params = spawn_params(&dir, &script, "successor initial prompt");
    successor_params.env.insert(
        "STDIN_LOG".to_string(),
        successor_stdin_log.to_string_lossy().into_owned(),
    );
    successor_params.env.insert(
        "KANNA_STAGE_RUN_ID".to_string(),
        "run-successor".to_string(),
    );
    owner.send(&Command::SpawnAgent {
        session_id: "agent-reused".to_string(),
        params: successor_params,
    });
    owner.recv_until(|event| matches!(event, Event::SessionCreated { .. }));

    std::fs::write(barrier.join("release"), b"").unwrap();
    assert!(matches!(
        delayed_input.recv_until(|event| matches!(event, Event::Error { .. } | Event::Ok)),
        Event::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::WriteFailed),
            ..
        }
    ));

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let successor_input = std::fs::read_to_string(&successor_stdin_log).unwrap_or_default();
        if successor_input.contains("successor initial prompt") {
            assert!(
                !successor_input.contains("must stay with old run"),
                "old-provider-encoded input reached successor stdin: {successor_input}"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "successor did not receive its initial prompt"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    let journal = std::fs::read_to_string(daemon.journal_path("agent-reused")).unwrap();
    assert!(
        !journal.contains("must stay with old run"),
        "stale input was journaled after replacement: {journal}"
    );
}

#[test]
fn stalled_agent_client_does_not_block_unrelated_agent_operations() {
    let dir = temp_dir("stalled-agent-client");
    let script = write_script(&dir, "quiet-stdin-agent.sh", QUIET_STDIN_AGENT);
    let barrier = dir.join("agent-writer-barrier");
    let daemon = DaemonHandle::start_in_with_env(
        &dir,
        &[("KANNA_TEST_AGENT_WRITER_BARRIER", barrier.to_str().unwrap())],
    );

    let mut stalled = daemon.connect();
    stalled.send(&Command::SpawnAgent {
        session_id: "agent-stalled".to_string(),
        params: spawn_params(&dir, &script, "stalled initial prompt"),
    });
    stalled.recv_until(|event| matches!(event, Event::SessionCreated { .. }));
    stalled.send(&Command::AttachAgent {
        session_id: "agent-stalled".to_string(),
        from_seq: 0,
    });
    stalled.recv_until(|event| matches!(event, Event::AgentSnapshot { .. }));

    let mut independent = daemon.connect();
    independent.send(&Command::SpawnAgent {
        session_id: "agent-independent".to_string(),
        params: spawn_params(&dir, &script, "independent initial prompt"),
    });
    independent.recv_until(|event| matches!(event, Event::SessionCreated { .. }));

    stalled.send(&Command::AgentInput {
        session_id: "agent-stalled".to_string(),
        text: "block this client writer".to_string(),
    });
    let barrier_deadline = Instant::now() + Duration::from_secs(5);
    while !barrier.join("blocked").exists() {
        assert!(
            Instant::now() < barrier_deadline,
            "agent client writer never reached the stall barrier"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    independent
        .reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_millis(750)))
        .unwrap();
    independent.send(&Command::AgentSetModel {
        session_id: "agent-independent".to_string(),
        model: "independent-model".to_string(),
    });
    assert!(
        matches!(independent.recv(), Event::Ok),
        "an unrelated agent operation waited behind the stalled client"
    );

    std::fs::write(barrier.join("release"), b"").unwrap();
}

#[test]
fn fast_agent_exit_is_broadcast_after_session_created() {
    let dir = temp_dir("fast-exit-created-order");
    let script = write_script(&dir, "one-shot.sh", ONE_SHOT_AGENT);
    let barrier = dir.join("session-created-barrier");
    let daemon = DaemonHandle::start_in(&dir);

    let mut subscriber = daemon.connect();
    subscriber.send(&Command::Subscribe);
    assert!(matches!(subscriber.recv(), Event::Ok));

    let mut control = daemon.connect();
    let mut params = spawn_params(&dir, &script, "fast prompt");
    params.env.insert(
        "KANNA_TEST_SESSION_CREATED_BARRIER".to_string(),
        barrier.to_string_lossy().into_owned(),
    );
    control.send(&Command::SpawnAgent {
        session_id: "agent-fast-exit".to_string(),
        params,
    });

    let barrier_deadline = Instant::now() + Duration::from_secs(5);
    while !barrier.join("reached").exists() {
        assert!(
            Instant::now() < barrier_deadline,
            "SessionCreated ordering barrier was never reached"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    std::fs::write(barrier.join("release"), b"").unwrap();
    control.recv_until(|event| matches!(event, Event::SessionCreated { .. }));

    let mut saw_created = false;
    loop {
        match subscriber.recv() {
            Event::SessionCreated { session_id, .. } if session_id == "agent-fast-exit" => {
                saw_created = true;
            }
            Event::Exit { session_id, .. } if session_id == "agent-fast-exit" => {
                assert!(
                    saw_created,
                    "fast child Exit must not precede SessionCreated"
                );
                break;
            }
            _ => {}
        }
    }
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

    let handoff_started = Instant::now();
    let new_daemon = DaemonHandle::start_in(&dir);
    assert!(
        handoff_started.elapsed() < Duration::from_secs(3),
        "successful handoff readiness must not wait for the five-second pid fallback"
    );
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
fn adopted_legacy_unowned_session_downgrades_ownership_capability() {
    let dir = temp_dir("legacy-handoff-ownership");
    let old_daemon =
        DaemonHandle::start_in_with_env(&dir, &[("KANNA_TEST_HANDOFF_OMIT_RUN_ID", "1")]);
    let mut old = old_daemon.connect();
    old.send(&Command::Spawn {
        session_id: "legacy-owned-session".to_string(),
        executable: "/bin/sh".to_string(),
        args: vec!["-c".to_string(), "sleep 30".to_string()],
        cwd: dir.to_string_lossy().into_owned(),
        env: HashMap::from([("KANNA_STAGE_RUN_ID".to_string(), "legacy-run".to_string())]),
        cols: 80,
        rows: 24,
        agent_provider: Some(AgentProvider::Claude),
        terminal_prelude: None,
    });
    old.recv_until(|event| matches!(event, Event::SessionCreated { .. }));

    let new_daemon = DaemonHandle::start_in(&dir);
    drop(old);
    drop(old_daemon);
    let mut current = new_daemon.connect();
    current.send(&Command::List);
    match current.recv_until(|event| matches!(event, Event::SessionList { .. })) {
        Event::SessionList {
            sessions,
            capabilities: Some(capabilities),
            ..
        } => {
            assert!(
                !capabilities.immutable_run_ownership,
                "a daemon with an adopted unowned session must negotiate legacy kill semantics"
            );
            assert_eq!(
                sessions
                    .iter()
                    .find(|session| session.session_id == "legacy-owned-session")
                    .and_then(|session| session.run_id.as_deref()),
                None,
                "the list response must identify the target as an ownershipless legacy session"
            );
        }
        other => panic!("expected SessionList capabilities, got {other:?}"),
    }
    current.send(&Command::Kill {
        session_id: "legacy-owned-session".to_string(),
        expected_run_id: Some("legacy-run".to_string()),
    });
    assert!(matches!(
        current.recv_until(|event| matches!(event, Event::Error { .. })),
        Event::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionOwnershipMismatch),
            ..
        }
    ));
    current.send(&Command::Kill {
        session_id: "legacy-owned-session".to_string(),
        expected_run_id: None,
    });
    assert!(matches!(
        current.recv_until(|event| matches!(event, Event::Ok)),
        Event::Ok
    ));
}

#[test]
fn ownershipless_repo_shell_does_not_downgrade_task_ownership_capability() {
    let dir = temp_dir("repo-shell-ownership");
    let daemon = DaemonHandle::start_in(&dir);
    let mut conn = daemon.connect();
    conn.send(&Command::Spawn {
        session_id: "shell-repo-test".to_string(),
        executable: "/bin/sh".to_string(),
        args: vec!["-c".to_string(), "sleep 30".to_string()],
        cwd: dir.to_string_lossy().into_owned(),
        env: HashMap::new(),
        cols: 80,
        rows: 24,
        agent_provider: None,
        terminal_prelude: None,
    });
    conn.recv_until(|event| matches!(event, Event::SessionCreated { .. }));

    conn.send(&Command::List);
    match conn.recv_until(|event| matches!(event, Event::SessionList { .. })) {
        Event::SessionList {
            capabilities: Some(capabilities),
            ..
        } => assert!(
            capabilities.immutable_run_ownership,
            "an ownershipless repo shell must not disable task run ownership"
        ),
        other => panic!("expected SessionList capabilities, got {other:?}"),
    }
}

#[test]
fn spawn_agent_with_resume_session_id_uses_resume_spawn() {
    let dir = temp_dir("spawn-resume-id");
    let script = write_script(&dir, "resume-id-agent.sh", RESUME_ID_ASSERTING_AGENT);
    let daemon = DaemonHandle::start_in(&dir);
    let mut params = spawn_params(&dir, &script, "revision feedback");
    params.resume_session_id = Some("fake-sess-persisted".to_string());

    let mut conn = daemon.connect();
    conn.send(&Command::SpawnAgent {
        session_id: "agent-resume-spawn".to_string(),
        params,
    });
    conn.recv_until(|event| matches!(event, Event::SessionCreated { .. }));
    conn.send(&Command::AttachAgent {
        session_id: "agent-resume-spawn".to_string(),
        from_seq: 0,
    });
    conn.recv_until(|event| matches!(event, Event::AgentSnapshot { .. }));
    let events = conn.collect_agent_events_until(is_turn_completed);

    assert!(events.iter().any(|event| matches!(
        event,
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

    let mut subscriber = daemon.connect();
    subscriber.send(&Command::Subscribe);
    assert!(matches!(subscriber.recv(), Event::Ok));

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
    conn.attach_and_collect_agent_events_until(
        "agent-int",
        0,
        |e| matches!(e, AgentEvent::AssistantText { text, .. } if text == "interim answer"),
    );

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

    let idle = subscriber.recv_until(|event| {
        matches!(
            event,
            Event::StatusChanged {
                session_id,
                status: SessionStatus::Idle,
                ..
            } if session_id == "agent-int"
        )
    });
    assert!(matches!(
        idle,
        Event::StatusChanged {
            waiting_prompt_snippet: None,
            ..
        }
    ));
}

/// Fake agent shaped like the `codex exec` child from the 2026-07-24
/// staging outage: it closes its own stdout (and stdin) right after init
/// but keeps running. The daemon's EOF handling must reap it WITHOUT
/// wedging the global agent registry — the old code blocked in
/// `child.wait()` inside the registry lock, hanging List/Kill and silently
/// stranding every stage transition.
const STDOUT_CLOSING_LINGERER: &str = r#"#!/bin/sh
read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-sess-linger","model":"fake-model"}'
exec 1>&-
exec 0<&-
sleep 300
"#;

#[test]
fn lingering_child_after_stdout_eof_is_reaped_without_wedging_the_registry() {
    let dir = temp_dir("linger");
    let script = write_script(&dir, "lingering-agent.sh", STDOUT_CLOSING_LINGERER);
    let daemon = DaemonHandle::start_in(&dir);

    let mut conn = daemon.connect();
    conn.send(&Command::SpawnAgent {
        session_id: "agent-linger".to_string(),
        params: spawn_params(&dir, &script, "linger now"),
    });
    conn.recv_until(|event| matches!(event, Event::SessionCreated { .. }));

    // From the moment the script closes stdout until the reaper finishes
    // (short grace, then process-group SIGKILL), the registry must stay
    // responsive: every List probe answers within the socket read timeout,
    // and the session eventually reports as exited once the child is
    // reaped. With the old wait-inside-the-lock code the first probe after
    // EOF hangs forever and this test fails on the read timeout.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(
            Instant::now() < deadline,
            "lingering child was never reaped; registry likely wedged"
        );
        let mut list_conn = daemon.connect();
        list_conn.send(&Command::List);
        let event = list_conn.recv_until(|event| matches!(event, Event::SessionList { .. }));
        let Event::SessionList { sessions } = event else {
            unreachable!()
        };
        let session = sessions
            .iter()
            .find(|info| info.session_id == "agent-linger")
            .expect("agent session missing from List");
        if matches!(session.state, SessionState::Exited(_)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn crash_does_not_publish_interim_assistant_text_as_a_waiting_prompt() {
    let dir = temp_dir("crash-waiting-prompt");
    let script = write_script(&dir, "crashing-agent.sh", CRASHING_AGENT);
    let daemon = DaemonHandle::start_in(&dir);

    let mut subscriber = daemon.connect();
    subscriber.send(&Command::Subscribe);
    assert!(matches!(subscriber.recv(), Event::Ok));

    let mut control = daemon.connect();
    control.send(&Command::SpawnAgent {
        session_id: "agent-crash".to_string(),
        params: spawn_params(&dir, &script, "crash now"),
    });
    control.recv_until(|event| matches!(event, Event::SessionCreated { .. }));

    let idle = subscriber.recv_until(|event| {
        matches!(
            event,
            Event::StatusChanged {
                session_id,
                status: SessionStatus::Idle,
                ..
            } if session_id == "agent-crash"
        )
    });
    assert!(matches!(
        idle,
        Event::StatusChanged {
            waiting_prompt_snippet: None,
            ..
        }
    ));
}

#[test]
fn opencode_headless_spawn_passes_task_cwd_as_project_dir() {
    let dir = temp_dir("opencode-cwd");
    let task_cwd = dir.join("task-cwd");
    std::fs::create_dir_all(&task_cwd).unwrap();
    let script = write_script(
        &dir,
        "opencode-dir-reporter.sh",
        OPENCODE_DIR_REPORTER_AGENT,
    );
    let daemon = DaemonHandle::start_in(&dir);

    let mut conn = daemon.connect();
    let mut params = spawn_params(&task_cwd, &script, "where am I?");
    params.agent_provider = AgentProvider::Opencode;
    conn.send(&Command::SpawnAgent {
        session_id: "agent-oc-cwd".to_string(),
        params,
    });
    conn.recv_until(|e| matches!(e, Event::SessionCreated { .. }));
    conn.send(&Command::AttachAgent {
        session_id: "agent-oc-cwd".to_string(),
        from_seq: 0,
    });
    conn.recv_until(|e| matches!(e, Event::AgentSnapshot { .. }));

    let events = conn.collect_agent_events_until(is_turn_completed);
    let expected = format!("dir={}", task_cwd.display());
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::AssistantText { text, .. } if text == &expected)),
        "opencode should receive the task cwd through --dir; expected {expected}, got {events:?}"
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
    let script = write_script(&dir, "fake-agent.sh", BUSY_ASSISTANT_AGENT);
    let daemon = DaemonHandle::start_in(&dir);

    let mut subscriber = daemon.connect();
    subscriber.send(&Command::Subscribe);
    assert!(matches!(subscriber.recv(), Event::Ok));

    let mut conn = daemon.connect();
    conn.send(&Command::SpawnAgent {
        session_id: "agent-k".to_string(),
        params: spawn_params(&dir, &script, "kill me"),
    });
    conn.recv_until(|e| matches!(e, Event::SessionCreated { .. }));
    conn.send(&Command::AttachAgent {
        session_id: "agent-k".to_string(),
        from_seq: 0,
    });
    conn.collect_agent_events_until(
        |e| matches!(e, AgentEvent::AssistantText { text, .. } if text == "interim answer"),
    );

    conn.send(&Command::Kill {
        session_id: "agent-k".to_string(),
    });
    conn.recv_until(|e| matches!(e, Event::Ok));

    let idle = subscriber.recv_until(|event| {
        matches!(
            event,
            Event::StatusChanged {
                session_id,
                status: SessionStatus::Idle,
                ..
            } if session_id == "agent-k"
        )
    });
    assert!(matches!(
        idle,
        Event::StatusChanged {
            waiting_prompt_snippet: None,
            ..
        }
    ));

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

/// Fake agent whose resume run announces its own pid to `$RESUME_PID_FILE`
/// and then blocks. Lets tests kill the session while a resumed child is
/// running and assert the child's whole process group actually dies.
const SLOW_RESUME_AGENT: &str = r#"#!/bin/sh
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
  echo "$$" > "$RESUME_PID_FILE"
  echo '{"type":"system","subtype":"init","session_id":"fake-sess-slow","model":"fake-model"}'
  sleep 300
  exit 0
fi
read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-sess-slow","model":"fake-model"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"initial done"}]}}'
echo '{"type":"result","subtype":"success","duration_ms":5,"num_turns":1,"total_cost_usd":0.01,"usage":{},"session_id":"fake-sess-slow"}'
"#;

/// Kill during a resumed turn must terminate the resumed child's process
/// group through its verified identity (the identity is re-captured on every
/// respawn) instead of leaking the child.
#[test]
fn kill_during_resumed_turn_terminates_the_resumed_child() {
    let dir = temp_dir("kill-resumed");
    let script = write_script(&dir, "slow-resume-agent.sh", SLOW_RESUME_AGENT);
    let pid_file = dir.join("resume.pid");
    let daemon = DaemonHandle::start_in(&dir);

    let mut conn = daemon.connect();
    let mut params = spawn_params(&dir, &script, "first prompt");
    params.env.insert(
        "RESUME_PID_FILE".to_string(),
        pid_file.to_string_lossy().to_string(),
    );
    conn.send(&Command::SpawnAgent {
        session_id: "agent-slow".to_string(),
        params,
    });
    conn.recv_until(|e| matches!(e, Event::SessionCreated { .. }));
    conn.send(&Command::AttachAgent {
        session_id: "agent-slow".to_string(),
        from_seq: 0,
    });
    conn.recv_until(|e| matches!(e, Event::AgentSnapshot { .. }));
    conn.collect_agent_events_until(is_turn_completed);
    // Let the daemon observe EOF so the next input takes the resume path.
    std::thread::sleep(Duration::from_millis(500));

    conn.send(&Command::AgentInput {
        session_id: "agent-slow".to_string(),
        text: "resume prompt".to_string(),
    });

    // The resumed child announces itself, proving the respawn is live.
    let resumed_pid: i32 = {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(contents) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = contents.trim().parse() {
                    break pid;
                }
            }
            assert!(Instant::now() < deadline, "resumed child never started");
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    assert_eq!(unsafe { libc::kill(resumed_pid, 0) }, 0);

    conn.send(&Command::Kill {
        session_id: "agent-slow".to_string(),
    });
    conn.recv_until(|e| matches!(e, Event::Ok));

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if unsafe { libc::kill(resumed_pid, 0) } != 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "resumed child {resumed_pid} must die with the killed session"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
