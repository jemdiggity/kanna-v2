use std::io::{BufRead, BufReader, Read, Write as IoWrite};

use tokio::sync::broadcast;

use kanna_agent_protocol::{AgentEvent, PermissionDecision, SessionEndReason, TurnModel};
use kanna_daemon::agent::{event_status, AgentSessions};
use kanna_daemon::protocol::{Event, SessionStatus};

use super::{
    journal_and_fan_out, journal_without_fanout, log_info, publish_terminal_exit, set_status,
};
use crate::daemon_lifecycle::{DaemonLifecycle, DaemonLifecycleState};

#[derive(Default)]
struct ReaderCompletionState {
    stdout_code: Option<i32>,
    stderr_eof: bool,
    finalizer_chosen: bool,
}

#[derive(Clone, Default)]
struct ReaderCompletion {
    state: std::sync::Arc<std::sync::Mutex<ReaderCompletionState>>,
}

impl ReaderCompletion {
    fn new() -> Self {
        Self::default()
    }

    fn finish_stdout(&self, code: i32) -> Option<i32> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.stdout_code = Some(code);
        Self::take_ready(&mut state)
    }

    fn finish_stderr(&self) -> Option<i32> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.stderr_eof = true;
        Self::take_ready(&mut state)
    }

    fn take_ready(state: &mut ReaderCompletionState) -> Option<i32> {
        if state.finalizer_chosen || !state.stderr_eof {
            return None;
        }
        let code = state.stdout_code?;
        state.finalizer_chosen = true;
        Some(code)
    }
}

/// A daemon that is handing off or shutting down must not publish child exits:
/// the successor owns those sessions, and a late exit would retire a session
/// the newcomer has already adopted.
async fn daemon_is_running(daemon_lifecycle: &DaemonLifecycle) -> bool {
    *daemon_lifecycle.read().await == DaemonLifecycleState::Running
}

/// Everything a reader owns for the exact child life it was started for.
/// Readers never resolve these through the registry: a reader that outlives
/// a kill+recreate of the same session id would otherwise pick up the
/// replacement record's adapter and journal its old-life output into the new
/// session's transcript. `incarnation` gates every registry mutation.
#[derive(Clone)]
pub struct ReaderLife {
    pub session_id: String,
    pub incarnation: u64,
    pub adapter:
        std::sync::Arc<std::sync::Mutex<Box<dyn kanna_agent_protocol::ProviderAdapter + Send>>>,
    pub shared: std::sync::Arc<tokio::sync::Mutex<kanna_daemon::agent::AgentShared>>,
    completion: ReaderCompletion,
}

impl ReaderLife {
    pub fn new(
        session_id: String,
        incarnation: u64,
        adapter: std::sync::Arc<
            std::sync::Mutex<Box<dyn kanna_agent_protocol::ProviderAdapter + Send>>,
        >,
        shared: std::sync::Arc<tokio::sync::Mutex<kanna_daemon::agent::AgentShared>>,
    ) -> Self {
        Self {
            session_id,
            incarnation,
            adapter,
            shared,
            completion: ReaderCompletion::new(),
        }
    }
}

/// Spawn the stdout + stderr reader threads for a (re)spawned agent child.
/// The readers carry `life`: the adapter, journal, and incarnation of the
/// child they watch, so neither parsing nor journaling nor registry
/// mutation can ever touch a later life of the same session id.
pub fn start_agent_readers(
    life: ReaderLife,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    agents: AgentSessions,
    broadcast_tx: broadcast::Sender<String>,
    daemon_lifecycle: DaemonLifecycle,
) {
    {
        let life = life.clone();
        let agents = agents.clone();
        let broadcast_tx = broadcast_tx.clone();
        let daemon_lifecycle = daemon_lifecycle.clone();
        tokio::task::spawn_blocking(move || {
            run_agent_reader(
                life,
                Box::new(stdout),
                false,
                agents,
                broadcast_tx,
                daemon_lifecycle,
            );
        });
    }
    tokio::task::spawn_blocking(move || {
        run_agent_reader(
            life,
            Box::new(stderr),
            true,
            agents,
            broadcast_tx,
            daemon_lifecycle,
        );
    });
}

fn run_agent_reader(
    life: ReaderLife,
    reader: Box<dyn Read + Send>,
    is_stderr: bool,
    agents: AgentSessions,
    broadcast_tx: broadcast::Sender<String>,
    daemon_lifecycle: DaemonLifecycle,
) {
    let rt = tokio::runtime::Handle::current();
    let session_id = life.session_id.clone();
    let generation = life.incarnation;
    log_info(format_args!(
        "[agent] reader start session={} incarnation={} stderr={}",
        session_id, generation, is_stderr
    ));

    for line in BufReader::new(reader).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let events = if is_stderr {
            vec![AgentEvent::Diagnostic { message: line }]
        } else {
            // Parse through the reader's OWN adapter. Resolving it from the
            // registry would hand an old life's output to the replacement
            // session's adapter after a kill+recreate of the same id.
            let mut guard = match life.adapter.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.parse_line(&line)
        };

        for event in events {
            rt.block_on(process_event(&life, event, &agents, &broadcast_tx));
        }
    }

    log_info(format_args!(
        "[agent] reader eof session={} incarnation={} stderr={}",
        session_id, generation, is_stderr
    ));
    if !rt.block_on(daemon_is_running(&daemon_lifecycle)) {
        return;
    }
    let ready = if is_stderr {
        life.completion.finish_stderr()
    } else {
        rt.block_on(prepare_child_exit(&life, &agents))
            .and_then(|code| life.completion.finish_stdout(code))
    };
    if let Some(code) = ready {
        rt.block_on(publish_child_exit(&life, code, &agents, &broadcast_tx));
    }
}

async fn process_event(
    life: &ReaderLife,
    event: AgentEvent,
    agents: &AgentSessions,
    broadcast_tx: &broadcast::Sender<String>,
) {
    let session_id = life.session_id.as_str();
    let generation = life.incarnation;
    // Registry pass: capture provider session id, permission bookkeeping,
    // status derivation, auto-allow.
    let mut auto_resolve: Option<String> = None;
    let mut provider_session_to_persist: Option<String> = None;
    // One registry pass, and never an await while the guard is alive: journal
    // + fan-out write to client sockets, so awaiting under the global agents
    // mutex would let one slow client stall every registry operation in the
    // daemon. Not-our-life dispositions (session gone, or a newer child owns
    // the record) journal into this life's own transcript afterwards.
    let is_our_life = {
        let mut registry = agents.lock().await;
        match registry.get_mut(session_id) {
            None => false,
            Some(record) if record.incarnation != generation => false,
            Some(record) => {
                record.last_activity_at = std::time::Instant::now();
                true
            }
        }
    };
    if !is_our_life {
        journal_without_fanout(&life.shared, event).await;
        return;
    }

    let shared = {
        let mut registry = agents.lock().await;
        // Re-resolve after the brief gap above; a life change here is still
        // handled without awaiting under the guard.
        let record = match registry.get_mut(session_id) {
            Some(record) if record.incarnation == generation => record,
            _ => {
                drop(registry);
                journal_without_fanout(&life.shared, event).await;
                return;
            }
        };

        if let AgentEvent::AssistantText { text, .. } = &event {
            if let Some(prompt) = kanna_daemon::headless_terminal::bound_waiting_prompt(text) {
                record.last_assistant_prompt = Some(prompt);
            }
        }

        {
            let provider_session_id = match record.adapter.lock() {
                Ok(adapter) => adapter.provider_session_id(),
                Err(poisoned) => poisoned.into_inner().provider_session_id(),
            };
            if provider_session_id.is_some() {
                record.provider_session_id = provider_session_id.clone();
                provider_session_to_persist = provider_session_id;
            }
        }

        match &event {
            AgentEvent::PermissionRequest {
                request_id,
                tool_name,
                ..
            } => {
                if record.session_allowed_tools.contains(tool_name) {
                    // This life's own adapter (identical to the record's while
                    // the incarnation matches, but never registry-resolved).
                    let line = match life.adapter.lock() {
                        Ok(mut adapter) => adapter
                            .encode_permission_response(request_id, &PermissionDecision::Allow),
                        Err(poisoned) => poisoned
                            .into_inner()
                            .encode_permission_response(request_id, &PermissionDecision::Allow),
                    };
                    if let (Some(line), Some(stdin)) = (line, record.stdin.as_mut()) {
                        if writeln!(stdin, "{line}")
                            .and_then(|_| stdin.flush())
                            .is_ok()
                        {
                            auto_resolve = Some(request_id.clone());
                        }
                    }
                }
                if auto_resolve.is_none() {
                    record.pending_permissions.insert(request_id.clone());
                }
            }
            AgentEvent::PermissionResolved { request_id, .. } => {
                record.pending_permissions.remove(request_id);
            }
            _ => {}
        }

        if let Some(next) = event_status(&event) {
            // An auto-approved request never surfaces as Waiting.
            let next = if auto_resolve.is_some() {
                SessionStatus::Busy
            } else {
                next
            };
            set_status(
                record,
                broadcast_tx,
                session_id,
                next,
                record.last_assistant_prompt.clone(),
            );
        }

        life.shared.clone()
    };

    if let Some(provider_session_id) = provider_session_to_persist {
        let mut sh = shared.lock().await;
        sh.journal.set_provider_session_id(&provider_session_id);
    }

    journal_and_fan_out(session_id, &shared, event).await;
    if let Some(request_id) = auto_resolve {
        journal_and_fan_out(
            session_id,
            &shared,
            AgentEvent::PermissionResolved {
                request_id,
                decision: PermissionDecision::AllowSession,
            },
        )
        .await;
    }
}

/// Reap an exited-or-exiting child without holding any lock. Bounded: poll
/// for the natural exit first (stdin and the handoff stdin duplicate were
/// already closed, so a provider waiting for EOF can finish), then escalate
/// to an identity-verified group SIGKILL plus a direct kill, and finally —
/// if the child is stuck in the kernel — hand it to a detached blocking
/// reaper rather than wedging the reader thread. Returns the exit code
/// (`-1` when unknown).
fn reap_exited_child(
    mut child: std::process::Child,
    child_start: Option<kanna_daemon::proc_info::StartTime>,
) -> i32 {
    const NATURAL_EXIT_GRACE: std::time::Duration = std::time::Duration::from_secs(3);
    const POST_KILL_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

    let poll_until = |child: &mut std::process::Child, grace: std::time::Duration| {
        let deadline = std::time::Instant::now() + grace;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Some(status.code().unwrap_or(-1)),
                Ok(None) => {}
                Err(_) => return Some(-1),
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    };

    if let Some(code) = poll_until(&mut child, NATURAL_EXIT_GRACE) {
        return code;
    }
    // Lingering child: its stdout closed but the process stayed alive.
    // Identity-verified group kill (never a recycled pid), then direct kill
    // of our own child handle.
    log_info(format_args!(
        "[agent] child {} lingering after stdout EOF; killing its process group",
        child.id()
    ));
    // We hold the `Child` handle, so this is our own unreaped fork: its pid
    // cannot be recycled across delivery.
    let _ = kanna_daemon::agent::signal_agent_pid(child.id(), child_start, true, libc::SIGKILL);
    let _ = child.kill();
    if let Some(code) = poll_until(&mut child, POST_KILL_GRACE) {
        return code;
    }
    log_info(format_args!(
        "[agent] child {} unreapable after SIGKILL; handing it to the central reaper",
        child.id()
    ));
    // The central reaper retains ownership and retries until the child is
    // actually reaped — never a forever-detached per-child thread.
    if let Err(error) = kanna_daemon::reaper::try_reap_child(child, child_start) {
        tokio::spawn(kanna_daemon::reaper::reap(error.into_ownership()));
    }
    -1
}

/// Test-only entry point for the reader's exit handling.
#[cfg(test)]
pub(crate) async fn handle_child_exit_for_test(
    life: &ReaderLife,
    agents: &AgentSessions,
    broadcast_tx: &broadcast::Sender<String>,
) {
    let daemon_lifecycle = crate::daemon_lifecycle::new_daemon_lifecycle();
    if !daemon_is_running(&daemon_lifecycle).await {
        return;
    }
    if let Some(code) = prepare_child_exit(life, agents).await {
        publish_child_exit(life, code, agents, broadcast_tx).await;
    }
}

/// Test-only entry point for the reader's per-event handling.
#[cfg(test)]
pub(crate) async fn process_event_for_test(
    life: &ReaderLife,
    event: AgentEvent,
    agents: &AgentSessions,
    broadcast_tx: &broadcast::Sender<String>,
) {
    process_event(life, event, agents, broadcast_tx).await
}

async fn prepare_child_exit(life: &ReaderLife, agents: &AgentSessions) -> Option<i32> {
    let session_id = life.session_id.as_str();
    let generation = life.incarnation;
    // Phase 1 (under the lock): verify the incarnation and take everything
    // that must be released — the child handle, its stdin, and the handoff
    // duplicates (including the stdin dup, so a provider reading stdin to
    // EOF can actually exit). No blocking wait happens under the registry
    // lock.
    let (child, child_start, stdin, handoff_fds) = {
        let mut registry = agents.lock().await;
        match registry.get_mut(session_id) {
            None => None,
            Some(record) if record.incarnation != generation => {
                // The exited child belongs to a superseded incarnation; the
                // respawn installer already took responsibility for reaping
                // it. Touching the record would clobber the live child.
                log_info(format_args!(
                    "[agent] stale reader (incarnation={}) observed exit for session {} \
                     (record incarnation={}); ignoring",
                    generation, session_id, record.incarnation
                ));
                None
            }
            Some(record) => Some((
                record.child.take(),
                record.child_start,
                record.stdin.take(),
                record.handoff_fds.take(),
            )),
        }
    }?;

    // Phase 2 (off-lock): close stdin + handoff dups, then reap bounded.
    drop(stdin);
    if let Some(fds) = handoff_fds {
        fds.close();
    }
    // Blocking is acceptable here: production calls arrive on the dedicated
    // reader thread (spawn_blocking), never on a runtime worker.
    let code = match child {
        Some(child) => reap_exited_child(child, child_start),
        None => -1,
    };

    let mut registry = agents.lock().await;
    match registry.get_mut(session_id) {
        Some(record) if record.incarnation == generation => {
            record.exited = true;
            Some(code)
        }
        _ => None,
    }
}

async fn publish_child_exit(
    life: &ReaderLife,
    code: i32,
    agents: &AgentSessions,
    broadcast_tx: &broadcast::Sender<String>,
) {
    let session_id = life.session_id.as_str();
    let (reason, publication) = {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(session_id) else {
            return;
        };
        if record.incarnation != life.incarnation {
            return;
        }
        let interrupted = std::mem::replace(&mut record.interrupt_requested, false);
        set_status(record, broadcast_tx, session_id, SessionStatus::Idle, None);
        let per_turn = matches!(record.turn_model, TurnModel::PerTurn);
        let reason = if interrupted {
            Some(SessionEndReason::Interrupted)
        } else if per_turn && code == 0 {
            None
        } else if code == 0 {
            Some(SessionEndReason::Completed)
        } else {
            Some(SessionEndReason::Crashed)
        };
        let Some(reason) = reason else {
            return;
        };
        (reason, record.exit_publication.clone())
    };

    let _ = publish_terminal_exit(
        session_id,
        &life.shared,
        &publication,
        AgentEvent::SessionEnded {
            reason,
            exit_code: Some(code),
            message: None,
        },
        Event::Exit {
            session_id: session_id.to_string(),
            code,
            resume_session_id: None,
            killed: false,
        },
        broadcast_tx,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build the reader-owned life for a record already in the registry.
    async fn life_for(agents: &AgentSessions, session_id: &str, incarnation: u64) -> ReaderLife {
        let registry = agents.lock().await;
        let record = registry.get(session_id).expect("session present");
        ReaderLife::new(
            session_id.to_string(),
            incarnation,
            record.adapter.clone(),
            record.shared.clone(),
        )
    }

    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::io::AsyncBufReadExt;
    use tokio::sync::Mutex;

    #[test]
    fn stdout_eof_waits_until_stderr_has_drained() {
        let completion = ReaderCompletion::new();
        assert_eq!(completion.finish_stdout(7), None);
        assert_eq!(completion.finish_stderr(), Some(7));
    }

    #[tokio::test]
    async fn stale_life_journals_without_reaching_replacement_writers() {
        let dir = crate::tests::temp_daemon_dir("stale-fanout");
        let agents: AgentSessions = Arc::new(Mutex::new(Default::default()));
        let mut record = crate::tests::agent_record_fixture(&dir, "stale-fanout");
        record.incarnation = 2;

        let (client, daemon) = tokio::net::UnixStream::pair().expect("socket pair");
        let (client_read, _) = client.into_split();
        let (_, daemon_write) = daemon.into_split();
        record
            .shared
            .lock()
            .await
            .writers
            .push(Arc::new(Mutex::new(daemon_write)));
        agents
            .lock()
            .await
            .insert("stale-fanout".to_string(), record);

        let stale = life_for(&agents, "stale-fanout", 1).await;
        let (broadcast_tx, _) = broadcast::channel(8);
        process_event(
            &stale,
            AgentEvent::Diagnostic {
                message: "old-life".to_string(),
            },
            &agents,
            &broadcast_tx,
        )
        .await;

        let mut lines = tokio::io::BufReader::new(client_read).lines();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), lines.next_line())
                .await
                .is_err(),
            "stale output must not fan out through replacement writers"
        );
        assert!(stale.shared.lock().await.journal.events_from(0).iter().any(
            |entry| matches!(&entry.event, AgentEvent::Diagnostic { message } if message == "old-life")
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A reader that outlives a respawn must not clobber the newer child's
    /// state: exit bookkeeping from a superseded generation is ignored, while
    /// the owning generation's exit is applied.
    #[tokio::test]
    async fn stale_generation_exit_does_not_clobber_current_child() {
        let dir = crate::tests::temp_daemon_dir("reader-gen");
        let agents: AgentSessions = Arc::new(Mutex::new(Default::default()));
        let mut record = crate::tests::agent_record_fixture(&dir, "sess");
        record.incarnation = 2;
        record.exited = false;
        agents.lock().await.insert("sess".to_string(), record);
        let (broadcast_tx, _rx) = broadcast::channel(16);

        handle_child_exit_for_test(&life_for(&agents, "sess", 1).await, &agents, &broadcast_tx)
            .await;
        assert!(
            !agents.lock().await.get("sess").unwrap().exited,
            "a stale reader's exit must not mark the live child exited"
        );

        handle_child_exit_for_test(&life_for(&agents, "sess", 2).await, &agents, &broadcast_tx)
            .await;
        assert!(
            agents.lock().await.get("sess").unwrap().exited,
            "the owning generation's exit must be applied"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Status mutations from a stale generation's output are dropped while
    /// its events still reach the journal.
    #[tokio::test]
    async fn stale_generation_events_journal_without_mutating_status() {
        let dir = crate::tests::temp_daemon_dir("reader-gen-status");
        let agents: AgentSessions = Arc::new(Mutex::new(Default::default()));
        let mut record = crate::tests::agent_record_fixture(&dir, "sess");
        record.incarnation = 2;
        record.status = SessionStatus::Busy;
        agents.lock().await.insert("sess".to_string(), record);
        let (broadcast_tx, _rx) = broadcast::channel(16);

        // SessionEnded from the stale generation would normally flip status.
        process_event(
            &life_for(&agents, "sess", 1).await,
            AgentEvent::SessionEnded {
                reason: SessionEndReason::Completed,
                exit_code: Some(0),
                message: None,
            },
            &agents,
            &broadcast_tx,
        )
        .await;

        let registry = agents.lock().await;
        let record = registry.get("sess").unwrap();
        assert_eq!(
            record.status,
            SessionStatus::Busy,
            "stale generation must not mutate live status"
        );
        let journaled = {
            let shared = record.shared.clone();
            drop(registry);
            let sh = shared.lock().await;
            sh.journal.events_from(0)
        };
        assert!(
            journaled
                .iter()
                .any(|entry| matches!(entry.event, AgentEvent::SessionEnded { .. })),
            "stale generation output still belongs in the journal"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Lingering child: the provider closes stdout but stays alive (here,
    /// blocked on a `sleep` in its process group). Exit handling must not
    /// hold the registry mutex across the wait, must close stdin plus the
    /// handoff stdin duplicate so an EOF-waiting provider can finish, and
    /// must escalate to an identity-verified group kill so the child never
    /// lingers forever.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn lingering_child_is_reaped_without_holding_the_registry_lock() {
        let dir = crate::tests::temp_daemon_dir("reader-linger");
        let agents: AgentSessions = Arc::new(Mutex::new(Default::default()));
        let (broadcast_tx, _rx) = broadcast::channel(16);

        // Child closes stdout immediately, then lives on.
        let spawned = kanna_daemon::agent::spawn_agent_child(
            &kanna_agent_protocol::SpawnSpec {
                executable: "/bin/sh".to_string(),
                args: vec!["-c".to_string(), "exec 1>&-; sleep 300".to_string()],
                env: Vec::new(),
                initial_stdin: None,
            },
            "/tmp",
            &HashMap::new(),
        )
        .expect("lingering child spawn should succeed");
        let child_pid = spawned.pid as libc::pid_t;

        let mut record = crate::tests::agent_record_fixture(&dir, "linger");
        let incarnation = kanna_daemon::agent::next_agent_incarnation();
        record.incarnation = incarnation;
        record.exited = false;
        record.pid = spawned.pid;
        record.child_start = spawned.child_start;
        record.child = Some(spawned.child);
        record.stdin = spawned.stdin;
        record.handoff_fds = spawned.handoff_fds;
        agents.lock().await.insert("linger".to_string(), record);

        // The registry mutex must stay acquirable throughout the reap.
        let probe_agents = agents.clone();
        let lock_probe = tokio::spawn(async move {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
            let mut acquisitions = 0;
            while std::time::Instant::now() < deadline {
                {
                    let _guard = probe_agents.lock().await;
                    acquisitions += 1;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            acquisitions
        });

        handle_child_exit_for_test(
            &life_for(&agents, "linger", incarnation).await,
            &agents,
            &broadcast_tx,
        )
        .await;

        let acquisitions = lock_probe.await.expect("probe should not panic");
        assert!(
            acquisitions > 5,
            "registry lock must remain acquirable during the reap, got {acquisitions} acquisitions"
        );

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while unsafe { libc::kill(child_pid, 0) } == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "lingering child {child_pid} must be killed"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        {
            let registry = agents.lock().await;
            let record = registry.get("linger").expect("session still present");
            assert!(record.exited, "exit bookkeeping must be applied");
            assert!(record.child.is_none());
            assert!(record.stdin.is_none());
            assert!(record.handoff_fds.is_none());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
