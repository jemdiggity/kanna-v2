//! Shutting the source agent down so its conversation can be shipped.
//!
//! The old mechanism was a single `SIGINT` to the source session followed by a
//! 1500 ms wait. It could not work, for a reason that only shows up after an
//! app upgrade: the daemon **refuses signals for adopted sessions** — sessions
//! it inherited through handoff, where it holds the master fd but never forked
//! the child, so the pid cannot be pinned across `kill(2)`
//! (`crates/daemon/src/pty.rs`). It fails closed by design. Every session older
//! than the running daemon is adopted, so after every upgrade no pre-existing
//! task could be finalized at all. On 2026-08-06 that is exactly what happened:
//! `[handoff] adopted session …` at 10:43, the signal refused at 13:43.
//!
//! Injected input has none of that constraint. `Command::Input` performs no
//! ownership check — it writes bytes to the master fd for any live session,
//! adopted or not — and it is the same path a person typing into the terminal
//! takes. So finalization *asks* the agent to stop instead of signalling it:
//!
//! 1. inject a wrap-up message through the ordinary two-step input helper;
//! 2. wait for the session to reach `Idle` — the composer-free state — off the
//!    daemon `StatusChanged` stream the server already consumes;
//! 3. inject the provider's quit command (`/exit`, `/quit` for Codex);
//! 4. wait for the daemon `Exit`.
//!
//! Only then are artifacts staged, which is also what fixes Codex: its rollout
//! under `~/.codex/sessions` is nameable long before the process exits but is
//! still growing at that point, so the old mid-session staging shipped a
//! truncated conversation (pinned by
//! `tests/cli-contract/tests/live/codex-rollout-timing.test.ts`).
//!
//! Step 2 is load-bearing rather than decorative: the quit command preempts an
//! agent that is mid-turn (pinned against OpenCode in
//! `opencode-injected-input.test.ts`), so quitting before the agent is idle
//! truncates the very wrap-up the transfer is trying to capture.
//!
//! **`Waiting` is not `Idle`.** It means the agent is parked on a permission
//! prompt, and this sequence deliberately never types into one: the prompt
//! would consume the quit command as an *answer*, and answering an approval
//! prompt on the operator's behalf is not something a transfer may do. A
//! session parked that way can wait forever, so it times out into the degraded
//! rung of the ladder instead.
//!
//! The ladder, each rung loud and recorded on the transfer:
//!
//! - injection failure, or the session never reaching `Idle`, degrades the
//!   finalization: artifacts are staged from the transcript as it stands and
//!   the payload carries `cleanlyFinalized: false` plus the reason. That rung
//!   only ships a conversation because Claude appends to its transcript while
//!   the session runs, which is pinned by
//!   `tests/cli-contract/tests/live/claude-transcript-append.test.ts`.
//! - destructive teardown stays the last resort and stays *after* staging: the
//!   source task's session is killed by `close_task_in_process` once the
//!   destination acknowledges the import (`push::outgoing_committed`), which is
//!   a SIGKILL sweep authenticated by the master fd and therefore works on
//!   adopted sessions. Finalization does not duplicate it — killing here would
//!   destroy a live agent for a transfer that may still fail.

use crate::db::{TaskEventKind, TransferWorkItem};
use crate::http_api::{try_submit_task_input, AppState, TaskInputError};
use kanna_agent_protocol::AgentProvider;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent, SessionStatus};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

/// The sequence spans minutes of waiting, so it opens a DB connection per step
/// rather than holding one across the waits — the same shape the engine's drain
/// loop uses, and the only one that keeps the future `Send` (`rusqlite`'s
/// connection is `Send` but not `Sync`, so a shared `&Db` cannot cross an
/// `await`).
fn open_db(state: &Arc<AppState>) -> Result<crate::db::Db, String> {
    state.transfer_work().open_db()
}

/// What the source agent is told before it is asked to quit.
///
/// It is written to be acted on by any provider's model: say what is happening,
/// bound the work, and forbid starting anything new. The reply it produces is
/// the last thing appended to the transcript the destination resumes from.
const WRAP_UP_MESSAGE: &str = "This task is being transferred to another machine right now. \
     Wrap up: finish the thought you are on, do not start any new work, and do not run any \
     further commands. Briefly state where you left off. Your conversation is being shipped \
     and will resume on the destination machine.";

/// How long the source agent gets to finish its turn after the wrap-up.
///
/// Generous on purpose. The old mechanism allowed 1500 ms, which was never a
/// wrap-up budget at all — it was how long it waited for a `SIGINT` to take. A
/// busy agent legitimately takes minutes to close out a turn, and the cost of
/// waiting is user-visible latency on a transfer, while the cost of not waiting
/// is a truncated conversation.
const WRAP_UP_TIMEOUT: Duration = Duration::from_secs(300);

/// How long a session that is *already* `Idle` may stay silent before the
/// wrap-up is treated as finished.
///
/// The daemon only publishes status *changes*, so an agent whose turn is too
/// short to be observed as `Busy` (detection is 500 ms-throttled) produces no
/// event at all — waiting for an `Idle` edge that will never come would burn
/// the whole wrap-up budget on the fastest possible case. Silence while idle is
/// therefore its own answer. Long enough that an agent still thinking about how
/// to start is not mistaken for one that has finished.
const IDLE_SETTLE: Duration = Duration::from_secs(20);

/// How long the agent gets to exit after the quit command.
///
/// This is a process teardown, not a turn: a provider that has not exited by
/// now is not going to.
const QUIT_EXIT_TIMEOUT: Duration = Duration::from_secs(60);

/// Claimed before the wrap-up is injected, so a work item resumed after a crash
/// does not type the message into the agent a second time.
const WRAP_UP_PHASE: &str = "finalization-wrap-up";
/// Claimed before the quit command is injected, for the same reason.
const QUIT_PHASE: &str = "finalization-quit";
/// Where the verdict is recorded, first-writer-wins.
///
/// Only the attempt that ran against a live agent can judge whether the
/// shutdown was clean. By the time a retry looks, the session is gone — which
/// is indistinguishable from "it exited cleanly" — so a retry that recomputed
/// the verdict would quietly upgrade a degraded finalization to a clean one.
const OUTCOME_PHASE: &str = "finalization-outcome";

/// What finalization achieved, and what the destination is told about it.
#[derive(Debug, Default)]
pub(super) struct SourceFinalization {
    /// `None` when the agent shut down cleanly; otherwise the reason the
    /// payload is marked `cleanlyFinalized: false`.
    pub degraded_reason: Option<String>,
    /// The source terminal as it looked before the agent was asked to quit.
    ///
    /// Captured mid-sequence rather than after it, because there is nothing
    /// left to photograph once the process has exited — and the destination
    /// replays this so the operator arrives at the terminal they left.
    pub recovery_snapshot: Option<crate::mobile_api::CreateTaskRecoverySnapshot>,
}

impl SourceFinalization {
    pub(super) fn cleanly_finalized(&self) -> bool {
        self.degraded_reason.is_none()
    }
}

/// Runs the shutdown sequence for one transfer's source session.
///
/// Never fails the transfer: every way this can go wrong degrades the
/// finalization instead, because a transfer that ships a slightly stale
/// conversation is recoverable and one that refuses to ship at all is not. The
/// payload-level refusals — a session that vanished, a promised artifact that
/// is not there — are the caller's, and they run after this.
pub(super) async fn finalize_source_session(
    state: &Arc<AppState>,
    work: &TransferWorkItem,
    task_id: &str,
    agent_type: Option<&str>,
    agent_provider: Option<&str>,
) -> SourceFinalization {
    // An `agent`-type session is headless: there is no TUI to type into and no
    // transcript being held open by a live process.
    if agent_type != Some("pty") {
        return SourceFinalization::default();
    }

    // The verdict from the attempt that ran against the live agent wins.
    if let Ok(Some(recorded)) = open_db(state).and_then(|db| {
        db.read_transfer_work_observation(&work.id, OUTCOME_PHASE)
            .map_err(|error| format!("db error: {error}"))
    }) {
        log::info!(
            "transfer finalization for {task_id} already reached a verdict on an earlier attempt: {}",
            recorded.as_deref().unwrap_or("clean"),
        );
        return SourceFinalization {
            degraded_reason: recorded,
            recovery_snapshot: None,
        };
    }

    let outcome = run_sequence(state, work, task_id, agent_provider).await;
    let recorded = open_db(state).and_then(|db| {
        db.record_transfer_work_observation(
            &work.id,
            OUTCOME_PHASE,
            outcome.degraded_reason.as_deref(),
        )
        .map_err(|error| format!("db error: {error}"))
    });
    if let Err(error) = recorded {
        log::error!("failed to record the finalization verdict for {task_id}: {error}");
    }
    outcome
}

async fn run_sequence(
    state: &Arc<AppState>,
    work: &TransferWorkItem,
    task_id: &str,
    agent_provider: Option<&str>,
) -> SourceFinalization {
    let provider = agent_provider
        .and_then(|provider| AgentProvider::from_str(provider).ok())
        // The task row is written by Kanna's own spawn path, so an unparsable
        // provider means the row is corrupt rather than that a new CLI shipped.
        // `/exit` is the majority command; guessing it beats not trying.
        .unwrap_or(AgentProvider::Claude);
    let quit_command = provider.quit_command();

    let mut observer = match SessionObserver::attach(&state.config().daemon_dir, task_id).await {
        Ok(observer) => observer,
        Err(error) => {
            return degraded(
                state,
                task_id,
                format!("the source agent session could not be observed: {error}"),
            )
        }
    };
    if !observer.present {
        // Nothing to wrap up: the conversation on disk is already whole, which
        // is the state this whole sequence exists to reach.
        record_phase(state, task_id, "already-exited", None);
        return SourceFinalization::default();
    }

    // 1. Wrap-up.
    match inject(state, work, task_id, WRAP_UP_PHASE, WRAP_UP_MESSAGE).await {
        Injected::Sent | Injected::AlreadySent => {
            record_phase(state, task_id, "wrap-up-sent", None);
        }
        Injected::SessionGone => {
            record_phase(state, task_id, "already-exited", None);
            return SourceFinalization::default();
        }
        Injected::Failed(reason) => {
            return degraded(
                state,
                task_id,
                format!("the source agent could not be asked to wrap up: {reason}"),
            );
        }
    }

    // 2. Idle.
    match observer.wait_for_idle(WRAP_UP_TIMEOUT, IDLE_SETTLE).await {
        IdleOutcome::Idle => record_phase(state, task_id, "idle", None),
        IdleOutcome::Exited => {
            // The agent ended its own session while wrapping up. That is the
            // destination state, reached without the quit command.
            record_phase(state, task_id, "exited", None);
            return SourceFinalization::default();
        }
        IdleOutcome::TimedOut(status) => {
            let detail = match status {
                // Typing the quit command now would answer the prompt, not quit
                // the agent. Refusing to is the whole point of keying on `Idle`.
                SessionStatus::Waiting => {
                    "it is parked on a permission prompt and was not answered on the operator's behalf"
                }
                _ => "it was still working",
            };
            return degraded(
                state,
                task_id,
                format!(
                    "the source agent did not finish its turn within {}s: {detail}",
                    WRAP_UP_TIMEOUT.as_secs(),
                ),
            );
        }
    }

    // 3. The terminal picture, while there is still a terminal.
    let recovery_snapshot = super::push::session_recovery_snapshot(state, task_id).await;

    // 4. Quit.
    match inject(state, work, task_id, QUIT_PHASE, quit_command).await {
        Injected::Sent | Injected::AlreadySent => {
            record_phase(state, task_id, "quit-sent", Some(quit_command));
        }
        Injected::SessionGone => {
            record_phase(state, task_id, "exited", None);
            return SourceFinalization {
                degraded_reason: None,
                recovery_snapshot,
            };
        }
        Injected::Failed(reason) => {
            let mut outcome = degraded(
                state,
                task_id,
                format!(
                    "the source agent could not be asked to quit with {quit_command}: {reason}"
                ),
            );
            outcome.recovery_snapshot = recovery_snapshot;
            return outcome;
        }
    }

    // 5. Exit.
    if observer.wait_for_exit(QUIT_EXIT_TIMEOUT).await {
        record_phase(state, task_id, "exited", None);
        SourceFinalization {
            degraded_reason: None,
            recovery_snapshot,
        }
    } else {
        let mut outcome = degraded(
            state,
            task_id,
            format!(
                "the source agent did not exit within {}s of {quit_command}",
                QUIT_EXIT_TIMEOUT.as_secs(),
            ),
        );
        outcome.recovery_snapshot = recovery_snapshot;
        outcome
    }
}

fn degraded(state: &Arc<AppState>, task_id: &str, reason: String) -> SourceFinalization {
    log::warn!("transfer finalization for {task_id} degraded: {reason}");
    record_phase(state, task_id, "degraded", Some(&reason));
    SourceFinalization {
        degraded_reason: Some(reason),
        recovery_snapshot: None,
    }
}

/// Publishes one step of the sequence onto the task event feed.
///
/// A wrap-up is minutes of latency the operator did not ask for, so the phase
/// has to be visible somewhere other than the server log. Best effort: a feed
/// write that fails must not fail a finalization that is otherwise working.
fn record_phase(state: &Arc<AppState>, task_id: &str, phase: &str, detail: Option<&str>) {
    log::info!("transfer finalization for {task_id}: {phase}");
    let payload = match detail {
        Some(detail) => serde_json::json!({ "phase": phase, "detail": detail }),
        None => serde_json::json!({ "phase": phase }),
    };
    let appended = open_db(state).and_then(|db| {
        db.append_task_event(task_id, TaskEventKind::TransferFinalizing, payload)
            .map_err(|error| format!("db error: {error}"))
    });
    if let Err(error) = appended {
        log::warn!("failed to record transfer finalization phase for {task_id}: {error}");
    }
}

enum Injected {
    Sent,
    /// An earlier attempt of this work item already typed it.
    AlreadySent,
    SessionGone,
    Failed(String),
}

/// Types one message into the session, at most once for the life of the work
/// item.
///
/// The claim is taken before the write and given back only when the write
/// definitely did not land. `TaskInputError::Uncertain` means the message bytes
/// reached the PTY but the Enter's response was lost, so the claim is kept: a
/// retry that re-typed a wrap-up (or a second `/exit`) would corrupt the
/// composer of an agent that already has the first one.
async fn inject(
    state: &Arc<AppState>,
    work: &TransferWorkItem,
    task_id: &str,
    phase: &str,
    message: &str,
) -> Injected {
    // Claimed before the write, so a crash between the two leaves the claim
    // held and the resumed item does not type it again.
    match open_db(state).and_then(|db| {
        db.claim_transfer_work_phase(&work.id, phase)
            .map_err(|error| format!("db error: {error}"))
    }) {
        Ok(true) => {}
        Ok(false) => return Injected::AlreadySent,
        Err(error) => return Injected::Failed(error),
    }
    let release = |reason: String| {
        let released = open_db(state).and_then(|db| {
            db.release_transfer_work_phase(&work.id, phase)
                .map_err(|error| format!("db error: {error}"))
        });
        if let Err(error) = released {
            log::error!("failed to release the {phase} claim for {task_id}: {error}");
        }
        Injected::Failed(reason)
    };

    let mut daemon =
        match crate::daemon_client::DaemonClient::connect(&state.config().daemon_dir).await {
            Ok(daemon) => daemon,
            Err(error) => return release(format!("daemon error: {error}")),
        };
    // The two-step helper every other Kanna input path uses: the text as one
    // write, then a lone CR after a pause so it registers as a discrete Enter
    // rather than a paste whose newline is folded into the buffer.
    match try_submit_task_input(&mut daemon, task_id, message).await {
        Ok(()) => Injected::Sent,
        Err(TaskInputError::SessionNotFound) => Injected::SessionGone,
        Err(TaskInputError::Uncertain(reason)) => {
            log::warn!("transfer finalization {phase} for {task_id} may have landed: {reason}");
            Injected::Sent
        }
        Err(TaskInputError::Other(reason)) => release(reason),
    }
}

enum IdleOutcome {
    Idle,
    Exited,
    /// Carries the status it gave up on, which decides how the ladder reports.
    TimedOut(SessionStatus),
}

/// A read-only view of one session's daemon event stream.
///
/// Subscribed rather than polled — the daemon already publishes what this needs
/// — and deliberately on its own connection: `send_command` reads a single line
/// and takes it as the response, so issuing commands on a subscribed connection
/// risks handing a pushed event back as a command result. Input goes out over
/// short-lived connections of its own.
struct SessionObserver {
    reader: crate::daemon_client::DaemonClientReader,
    session_id: String,
    status: SessionStatus,
    present: bool,
}

impl SessionObserver {
    async fn attach(daemon_dir: &str, session_id: &str) -> Result<Self, String> {
        let client = crate::daemon_client::DaemonClient::connect(daemon_dir)
            .await
            .map_err(|error| error.to_string())?;
        let (reader, mut writer) = client.into_split();
        // Subscribe *then* list, both written before either answer is read: a
        // status change between the snapshot and the stream would otherwise
        // fall in the gap and be lost.
        writer
            .send_one_way(&DaemonCommand::Subscribe)
            .await
            .map_err(|error| error.to_string())?;
        writer
            .send_one_way(&DaemonCommand::List)
            .await
            .map_err(|error| error.to_string())?;

        let mut observer = Self {
            reader,
            session_id: session_id.to_string(),
            status: SessionStatus::Idle,
            present: false,
        };
        // Everything ahead of the session list is either the Subscribe ack or a
        // pushed event; both are folded in before the list overwrites them.
        let mut listed = false;
        while !listed {
            match observer
                .reader
                .read_event()
                .await
                .map_err(|error| error.to_string())?
            {
                DaemonEvent::SessionList { sessions } => {
                    if let Some(session) = sessions
                        .iter()
                        .find(|session| session.session_id == observer.session_id)
                    {
                        observer.present = true;
                        observer.status = session.status;
                    }
                    listed = true;
                }
                DaemonEvent::Error { message, .. } => {
                    return Err(format!("daemon list error: {message}"))
                }
                other => observer.absorb(&other),
            }
        }
        Ok(observer)
    }

    /// Folds a pushed event into the observer's view of the session.
    fn absorb(&mut self, event: &DaemonEvent) {
        match event {
            DaemonEvent::StatusChanged {
                session_id, status, ..
            } if *session_id == self.session_id => {
                self.status = *status;
                self.present = true;
            }
            DaemonEvent::Exit { session_id, .. } if *session_id == self.session_id => {
                self.present = false;
            }
            _ => {}
        }
    }

    async fn wait_for_idle(&mut self, budget: Duration, settle: Duration) -> IdleOutcome {
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return IdleOutcome::TimedOut(self.status);
            }
            let slice = settle.min(deadline - now);
            match tokio::time::timeout(slice, self.reader.read_event()).await {
                Ok(Ok(event)) => {
                    self.absorb(&event);
                    match event {
                        DaemonEvent::StatusChanged {
                            ref session_id,
                            status: SessionStatus::Idle,
                            ..
                        } if *session_id == self.session_id => return IdleOutcome::Idle,
                        DaemonEvent::Exit { ref session_id, .. }
                            if *session_id == self.session_id =>
                        {
                            return IdleOutcome::Exited
                        }
                        _ => continue,
                    }
                }
                // The daemon connection dropped. Nothing further can be
                // observed, so report the last status seen rather than claiming
                // an idleness nobody witnessed.
                Ok(Err(_)) => return IdleOutcome::TimedOut(self.status),
                // Silence. Idle silence means the turn ended without ever being
                // observed as busy; any other silence is the agent still at it.
                Err(_) if self.status == SessionStatus::Idle => return IdleOutcome::Idle,
                Err(_) => continue,
            }
        }
    }

    async fn wait_for_exit(&mut self, budget: Duration) -> bool {
        let observe = async {
            loop {
                let Ok(event) = self.reader.read_event().await else {
                    return false;
                };
                self.absorb(&event);
                if matches!(
                    &event,
                    DaemonEvent::Exit { session_id, .. } if *session_id == self.session_id
                ) {
                    return true;
                }
            }
        };
        tokio::time::timeout(budget, observe).await.unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanna_daemon::protocol::{SessionInfo, SessionKind, SessionState};
    use std::sync::Mutex;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{UnixListener, UnixStream};

    const SESSION: &str = "task-finalize";

    /// What the fake daemon saw, in the order it saw it.
    ///
    /// The whole sequence is about ordering — a quit typed before the agent
    /// went idle truncates the wrap-up the transfer exists to capture — so the
    /// assertions are on this transcript, not on the return value.
    #[derive(Debug, Default)]
    struct DaemonLog {
        /// Every `Input` payload written to the session, in order. The helper
        /// sends text and CR separately, so a submitted message is two entries.
        inputs: Vec<String>,
        /// How many inputs had arrived when `Idle` was published.
        inputs_at_idle: Option<usize>,
    }

    /// A scripted daemon over a real Unix socket.
    ///
    /// It serves the observer's subscription and the short-lived connections
    /// each injection opens, which is the arrangement the production code
    /// deliberately uses (commands must not be issued on a subscribed
    /// connection, where a pushed event can be mistaken for a response).
    struct FakeDaemon {
        dir: String,
        log: Arc<Mutex<DaemonLog>>,
        events: tokio::sync::broadcast::Sender<DaemonEvent>,
        _accept: tokio::task::JoinHandle<()>,
    }

    impl FakeDaemon {
        fn start(label: &str, listed: Option<SessionStatus>) -> Self {
            let dir = format!("/tmp/kanna-finalize-{label}-{}", std::process::id());
            std::fs::create_dir_all(&dir).expect("daemon dir");
            let socket = kanna_runtime_defaults::socket_path(std::path::Path::new(&dir));
            let _ = std::fs::remove_file(&socket);
            let listener = UnixListener::bind(&socket).expect("bind fake daemon");
            let log = Arc::new(Mutex::new(DaemonLog::default()));
            let (events, _) = tokio::sync::broadcast::channel(64);

            let accept_log = Arc::clone(&log);
            let accept_events = events.clone();
            let accept = tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    tokio::spawn(serve(
                        stream,
                        Arc::clone(&accept_log),
                        accept_events.clone(),
                        listed,
                    ));
                }
            });

            Self {
                dir,
                log,
                events,
                _accept: accept,
            }
        }

        fn publish(&self, event: DaemonEvent) {
            if let DaemonEvent::StatusChanged {
                status: SessionStatus::Idle,
                ..
            } = event
            {
                let mut log = self.log.lock().expect("log");
                let seen = log.inputs.len();
                log.inputs_at_idle.get_or_insert(seen);
            }
            let _ = self.events.send(event);
        }

        fn status(&self, status: SessionStatus) {
            self.publish(DaemonEvent::StatusChanged {
                session_id: SESSION.to_string(),
                status,
                waiting_prompt_snippet: None,
            });
        }

        fn exit(&self) {
            self.publish(DaemonEvent::Exit {
                session_id: SESSION.to_string(),
                code: 0,
                resume_session_id: None,
                killed: false,
            });
        }

        fn inputs(&self) -> Vec<String> {
            self.log.lock().expect("log").inputs.clone()
        }

        fn inputs_at_idle(&self) -> Option<usize> {
            self.log.lock().expect("log").inputs_at_idle
        }

        /// Blocks until `count` input writes have arrived, so a test never
        /// races the injection it is about to react to.
        async fn wait_for_inputs(&self, count: usize) {
            for _ in 0..600 {
                if self.inputs().len() >= count {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!(
                "fake daemon never received {count} inputs: {:?}",
                self.inputs()
            );
        }
    }

    async fn serve(
        stream: UnixStream,
        log: Arc<Mutex<DaemonLog>>,
        events: tokio::sync::broadcast::Sender<DaemonEvent>,
        listed: Option<SessionStatus>,
    ) {
        let (read_half, write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let writer = Arc::new(tokio::sync::Mutex::new(write_half));
        let mut subscription: Option<tokio::task::JoinHandle<()>> = None;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Ok(command) = serde_json::from_str::<DaemonCommand>(line.trim()) else {
                break;
            };
            let response = match command {
                DaemonCommand::Subscribe => {
                    if subscription.is_none() {
                        let mut stream = events.subscribe();
                        let writer = Arc::clone(&writer);
                        subscription = Some(tokio::spawn(async move {
                            while let Ok(event) = stream.recv().await {
                                let line = serde_json::to_string(&event).expect("event");
                                let mut writer = writer.lock().await;
                                if writer.write_all(line.as_bytes()).await.is_err()
                                    || writer.write_all(b"\n").await.is_err()
                                {
                                    return;
                                }
                            }
                        }));
                    }
                    DaemonEvent::Ok
                }
                DaemonCommand::List => DaemonEvent::SessionList {
                    sessions: listed
                        .map(|status| SessionInfo {
                            session_id: SESSION.to_string(),
                            pid: 4242,
                            cwd: "/tmp".to_string(),
                            state: SessionState::Active,
                            idle_seconds: 0,
                            status,
                            kind: SessionKind::default(),
                        })
                        .into_iter()
                        .collect(),
                },
                DaemonCommand::Input { data, .. } => {
                    log.lock()
                        .expect("log")
                        .inputs
                        .push(String::from_utf8_lossy(&data).into_owned());
                    DaemonEvent::Ok
                }
                DaemonCommand::NegotiateProtectedInput { version } => {
                    DaemonEvent::ProtectedInputReady { version }
                }
                DaemonCommand::Snapshot { .. } => DaemonEvent::Error {
                    code: None,
                    message: "no snapshot in the fake daemon".to_string(),
                },
                _ => DaemonEvent::Ok,
            };
            let line = serde_json::to_string(&response).expect("response");
            let mut writer = writer.lock().await;
            if writer.write_all(line.as_bytes()).await.is_err()
                || writer.write_all(b"\n").await.is_err()
            {
                break;
            }
        }
    }

    fn work_item() -> TransferWorkItem {
        TransferWorkItem {
            id: "finalize:transfer-1".to_string(),
            kind: super::super::queue::KIND_FINALIZE.to_string(),
            transfer_id: Some("transfer-1".to_string()),
            payload_json: "{}".to_string(),
            attempts: 1,
        }
    }

    fn state_for(daemon: &FakeDaemon, label: &str) -> Arc<AppState> {
        crate::http_api::test_state_with_daemon_dir(label, label, &daemon.dir, |db| {
            db.insert_test_repo("repo-finalize", "Finalize Repo")
                .expect("repo");
            db.insert_test_pipeline_item(
                SESSION,
                "repo-finalize",
                "finalize me",
                None,
                "in progress",
                "2026-08-07 00:00:00",
            )
            .expect("task");
            // The phase claims and the verdict memo hang off this row.
            db.enqueue_transfer_work(&work_item().id, "finalize", None, "{}")
                .expect("queue the finalize work item");
        })
    }

    fn phases(state: &Arc<AppState>) -> Vec<String> {
        let db = open_db(state).expect("db");
        let head = db.latest_task_event_seq().expect("head");
        db.list_task_events(
            &crate::db::TaskEventScope::Tasks(vec![SESSION.into()]),
            0,
            head,
            64,
        )
        .expect("events")
        .into_iter()
        .filter(|event| event.event_type == "task.transfer_finalizing")
        .map(|event| {
            event.payload["phase"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .collect()
    }

    /// The regression test for the sequence's whole reason to exist.
    ///
    /// `/exit` preempts an agent that is mid-turn, so a quit sent while the
    /// session is `Busy` throws away the wrap-up the transfer is trying to
    /// capture. The wrap-up goes out, nothing else may be typed until the
    /// daemon reports `Idle`, and only then does the quit command follow.
    #[tokio::test]
    async fn the_quit_command_is_never_typed_while_the_agent_is_busy() {
        let daemon = FakeDaemon::start("busy-then-idle", Some(SessionStatus::Busy));
        let state = state_for(&daemon, "desktop-finalize-busy");

        let sequence = tokio::spawn({
            let state = Arc::clone(&state);
            async move {
                finalize_source_session(&state, &work_item(), SESSION, Some("pty"), Some("claude"))
                    .await
            }
        });

        // The wrap-up is a message plus a discrete CR: two writes.
        daemon.wait_for_inputs(2).await;
        // Still busy — a quit typed now would truncate the turn.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            daemon.inputs().len(),
            2,
            "something was typed at a busy agent: {:?}",
            daemon.inputs(),
        );

        daemon.status(SessionStatus::Idle);
        daemon.wait_for_inputs(4).await;
        daemon.exit();

        let outcome = sequence.await.expect("sequence");
        assert!(
            outcome.cleanly_finalized(),
            "a sequence that ran to completion reported degraded: {:?}",
            outcome.degraded_reason,
        );

        let inputs = daemon.inputs();
        assert!(
            inputs[0].contains("transferred to another machine"),
            "the first thing typed was not the wrap-up: {inputs:?}",
        );
        assert_eq!(inputs[1], "\r");
        assert_eq!(
            inputs[2], "/exit",
            "the quit command was not typed: {inputs:?}"
        );
        assert_eq!(inputs[3], "\r");
        assert_eq!(
            daemon.inputs_at_idle(),
            Some(2),
            "the quit was typed before the session was reported idle: {inputs:?}",
        );
        assert_eq!(
            phases(&state),
            vec!["wrap-up-sent", "idle", "quit-sent", "exited"],
            "the transfer's finalization was not observable step by step",
        );
    }

    /// Codex names its quit command differently, and finalization reads it off
    /// the provider registry rather than hard-coding one command.
    #[tokio::test]
    async fn the_quit_command_comes_from_the_task_s_provider() {
        let daemon = FakeDaemon::start("codex-quit", Some(SessionStatus::Busy));
        let state = state_for(&daemon, "desktop-finalize-codex");

        let sequence = tokio::spawn({
            let state = Arc::clone(&state);
            async move {
                finalize_source_session(&state, &work_item(), SESSION, Some("pty"), Some("codex"))
                    .await
            }
        });

        daemon.wait_for_inputs(2).await;
        daemon.status(SessionStatus::Idle);
        daemon.wait_for_inputs(4).await;
        daemon.exit();
        sequence.await.expect("sequence");

        assert_eq!(daemon.inputs()[2], "/quit");
    }

    /// A task whose agent already stopped has nothing to wrap up: the
    /// conversation on disk is already whole. Typing into a session that is not
    /// there would only produce a spurious failure — the old `SIGINT` path
    /// degraded exactly this case, because signalling a missing session errors.
    #[tokio::test]
    async fn a_session_that_has_already_exited_is_finalized_without_typing_into_it() {
        let daemon = FakeDaemon::start("already-gone", None);
        let state = state_for(&daemon, "desktop-finalize-gone");

        let outcome =
            finalize_source_session(&state, &work_item(), SESSION, Some("pty"), Some("claude"))
                .await;

        assert!(outcome.cleanly_finalized(), "{:?}", outcome.degraded_reason);
        assert!(daemon.inputs().is_empty(), "{:?}", daemon.inputs());
        assert_eq!(phases(&state), vec!["already-exited"]);
    }

    /// A headless session has no TUI to type into, so the sequence does not run
    /// at all — and must not degrade the transfer for not running.
    #[tokio::test]
    async fn a_headless_session_is_left_alone() {
        let daemon = FakeDaemon::start("headless", Some(SessionStatus::Busy));
        let state = state_for(&daemon, "desktop-finalize-headless");

        let outcome =
            finalize_source_session(&state, &work_item(), SESSION, Some("agent"), Some("claude"))
                .await;

        assert!(outcome.cleanly_finalized());
        assert!(daemon.inputs().is_empty());
    }

    /// The verdict is the first attempt's, not the retry's.
    ///
    /// A retry looks at a machine the first attempt already changed: the agent
    /// is gone, which reads identically to "it exited cleanly". Recomputing
    /// would quietly upgrade a degraded finalization to a clean one and tell
    /// the destination the conversation is whole when it is not.
    #[tokio::test]
    async fn a_retry_reports_the_verdict_the_live_attempt_reached() {
        let daemon = FakeDaemon::start("verdict-memo", None);
        let state = state_for(&daemon, "desktop-finalize-verdict");
        let work = work_item();
        open_db(&state)
            .expect("db")
            .record_transfer_work_observation(&work.id, OUTCOME_PHASE, Some("the agent hung"))
            .expect("attempt 1's verdict");

        let outcome =
            finalize_source_session(&state, &work, SESSION, Some("pty"), Some("claude")).await;

        assert_eq!(outcome.degraded_reason.as_deref(), Some("the agent hung"));
        assert!(
            daemon.inputs().is_empty(),
            "the retry typed at the agent again"
        );
    }

    async fn observer_for(daemon: &FakeDaemon) -> SessionObserver {
        SessionObserver::attach(&daemon.dir, SESSION)
            .await
            .expect("attach")
    }

    /// `Waiting` is a permission prompt, not idleness. Typing the quit command
    /// into one would answer it on the operator's behalf, so the sequence never
    /// treats it as the go-ahead.
    #[tokio::test]
    async fn a_session_parked_on_a_permission_prompt_never_reads_as_idle() {
        let daemon = FakeDaemon::start("waiting-prompt", Some(SessionStatus::Busy));
        let mut observer = observer_for(&daemon).await;
        daemon.status(SessionStatus::Waiting);

        let outcome = observer
            .wait_for_idle(Duration::from_millis(400), Duration::from_millis(50))
            .await;

        assert!(
            matches!(outcome, IdleOutcome::TimedOut(SessionStatus::Waiting)),
            "a permission prompt was mistaken for a finished turn",
        );
    }

    /// The daemon publishes status *changes*. An agent whose turn is over
    /// before the 500 ms-throttled detector ever calls it busy emits no event
    /// at all, so waiting for an `Idle` edge would burn the entire wrap-up
    /// budget on the fastest possible case. Silence *while idle* is the answer.
    #[tokio::test]
    async fn silence_from_an_idle_session_counts_as_a_finished_turn() {
        let daemon = FakeDaemon::start("idle-silence", Some(SessionStatus::Idle));
        let mut observer = observer_for(&daemon).await;

        let outcome = observer
            .wait_for_idle(Duration::from_secs(5), Duration::from_millis(50))
            .await;

        assert!(
            matches!(outcome, IdleOutcome::Idle),
            "idle silence was not read as idle"
        );
    }

    /// Silence from a session that is still working is not the same answer:
    /// it keeps waiting until the budget is spent, then degrades.
    #[tokio::test]
    async fn silence_from_a_busy_session_is_not_a_finished_turn() {
        let daemon = FakeDaemon::start("busy-silence", Some(SessionStatus::Busy));
        let mut observer = observer_for(&daemon).await;

        let outcome = observer
            .wait_for_idle(Duration::from_millis(250), Duration::from_millis(50))
            .await;

        assert!(matches!(
            outcome,
            IdleOutcome::TimedOut(SessionStatus::Busy)
        ));
    }
}
