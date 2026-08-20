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
//! Injected input has none of that constraint. `Command::SubmitInput` accepts a
//! logical message for any live session, adopted or not, and queues it behind
//! any raw terminal draft. So finalization *asks* the agent to stop instead of
//! signalling it:
//!
//! 1. inject a wrap-up message through the daemon-owned logical input queue;
//! 2. wait for the session to reach `Idle` — the composer-free state — and to
//!    stay there, off the daemon `StatusChanged` stream the server already
//!    consumes;
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
//! truncates the very wrap-up the transfer is trying to capture. And *reaching*
//! `Idle` is not the same as being finished — the daemon can publish it inside
//! its own gap between a logical message and CR, or between two turns of a
//! 500 ms-throttled detector — so the status has to hold for a settle window
//! before the quit goes out ([`IDLE_SETTLE`], [`IDLE_EDGE_SETTLE`]).
//!
//! **`Waiting` is not `Idle`, and nothing may be typed while it holds.** It
//! means the agent is parked on a permission prompt, which consumes the next
//! input as its *answer* — and the submission policy ends every message with a
//! discrete CR, which is exactly the keystroke that accepts the prompt's
//! highlighted option. Approving a pending tool call on the operator's behalf
//! is not something a transfer may do, and it would be silent: the agent would
//! resume, reach `Idle`, quit on cue, and ship `cleanlyFinalized: true` with
//! nothing anywhere saying a tool call had been approved.
//!
//! The quit gets that guarantee from step 2, which only lets it through on
//! `Idle`. The wrap-up has nothing in front of it, so it checks the status
//! `attach` read off the daemon itself. A session already parked when
//! finalization starts degrades on the spot rather than waiting: nobody is
//! going to answer that prompt — the operator is in the
//! middle of pushing the task away from this machine — so waiting out the
//! wrap-up budget would buy minutes of user-visible latency and reach the same
//! verdict. A session that parks *during* the wrap-up reaches the same rung
//! through the idle timeout. Pushing a task that is parked on a prompt is a
//! normal thing to do; it is often *why* someone pushes it, and the destination
//! resumes with the prompt still to answer.
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
///
/// This is not a free number. The destination is blocked on this finalization
/// over a peer request the whole time, so it has to be bounded by what that
/// request allows — `kanna_runtime_defaults::TRANSFER_FINALIZATION_REQUEST_TIMEOUT`,
/// held by [`the_shutdown_budget_fits_inside_the_peer_finalization_window`].
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

/// How long a session that was *seen going* `Idle` may stay silent before the
/// wrap-up is treated as finished.
///
/// Shorter than [`IDLE_SETTLE`] because an observed transition is real evidence
/// where silence is only the absence of it — but not zero, which is what taking
/// the edge as the answer amounted to. Two `Idle` edges mean nothing about the
/// wrap-up:
///
/// - the daemon writes a logical message and its Enter separately, with a
///   150 ms pause, and can publish `Idle` inside that gap — the session is idle
///   because the message has not been submitted yet;
/// - busy detection is 500 ms-throttled, so an agent that pauses between turns
///   can be published as `Idle` mid-work.
///
/// Either one let `/exit` preempt the very wrap-up the transfer exists to
/// capture, while the finalization still reported `cleanlyFinalized: true`. A
/// window of four detection intervals is long enough for a turn that has really
/// started to be published as `Busy` and reset it, and costs under 1% of
/// [`WRAP_UP_TIMEOUT`] when the agent genuinely was done.
const IDLE_EDGE_SETTLE: Duration = Duration::from_secs(2);

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

    // Nothing may be typed at a session parked on a permission prompt — the
    // wrap-up's trailing CR would accept the prompt's highlighted option and
    // approve a pending tool call in the operator's name. `attach` read the
    // live status off the daemon's session list, so this is known before a
    // single byte goes out.
    if observer.status == SessionStatus::Waiting {
        return degraded(
            state,
            task_id,
            "the source agent is parked on a permission prompt, so it was not asked to wrap up: \
             answering that prompt is the operator's to do, and any input sent now would answer it"
                .to_string(),
        );
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
    match observer
        .wait_for_idle(WRAP_UP_TIMEOUT, IDLE_SETTLE, IDLE_EDGE_SETTLE)
        .await
    {
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
/// `TaskInputError::HeldByRawDraft` keeps it for the same reason from the other
/// direction: the message is queued inside the daemon and *will* be typed when
/// the human at that terminal submits their own line, so it has not failed to
/// land — it has not landed *yet*. Releasing would let a later retry of this
/// work item queue a second wrap-up, or a second `/exit`, behind the first.
/// `InputBlocked` and `Other` do release: nothing was queued, so re-claiming
/// and retrying is both safe and the only way the message ever arrives.
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
    // The daemon-owned logical queue every other Kanna message path uses keeps
    // this message separate from raw drafts and synthesizes its discrete Enter.
    match try_submit_task_input(&mut daemon, task_id, message).await {
        Ok(()) => Injected::Sent,
        Err(TaskInputError::SessionNotFound) => Injected::SessionGone,
        Err(TaskInputError::Uncertain(reason)) => {
            log::warn!("transfer finalization {phase} for {task_id} may have landed: {reason}");
            Injected::Sent
        }
        Err(TaskInputError::HeldByRawDraft(reason)) => {
            log::warn!(
                "transfer finalization {phase} for {task_id} is queued behind an unsent human \
                 line and will be typed when that terminal submits: {reason}"
            );
            Injected::Failed(reason)
        }
        Err(TaskInputError::Other(reason) | TaskInputError::InputBlocked(reason)) => {
            release(reason)
        }
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
    /// Held for the observer's whole life, and never written to after the
    /// handshake.
    ///
    /// Dropping it is not free: `OwnedWriteHalf::drop` shuts the socket's write
    /// side down, the daemon's command loop reads EOF and breaks, and breaking
    /// aborts the subscription task feeding this reader
    /// (`crates/daemon/src/connection.rs`). The stream this observer exists to
    /// read would end milliseconds after it was opened, and every PTY
    /// finalization would degrade with "the agent did not finish its turn"
    /// before the agent had a chance to. `terminal_watcher` holds its whole
    /// `DaemonClient` for the life of its subscription for the same reason.
    _writer: crate::daemon_client::DaemonClientWriter,
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
            _writer: writer,
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
                other => {
                    observer.absorb(&other);
                }
            }
        }
        Ok(observer)
    }

    /// Folds a pushed event into the observer's view of the session, and
    /// reports whether the event was about this session at all.
    ///
    /// The daemon's `Subscribe` stream is machine-wide — every session's status
    /// changes and exits reach every subscriber — so "an event arrived" and
    /// "this session did something" are different facts, and the settle window
    /// below depends on the second one.
    fn absorb(&mut self, event: &DaemonEvent) -> bool {
        match event {
            DaemonEvent::StatusChanged {
                session_id, status, ..
            } if *session_id == self.session_id => {
                self.status = *status;
                self.present = true;
                true
            }
            DaemonEvent::Exit { session_id, .. } if *session_id == self.session_id => {
                self.present = false;
                true
            }
            _ => false,
        }
    }

    /// Waits for the session to be idle *and stay* idle.
    ///
    /// Two windows, because the two ways of learning that a turn is over carry
    /// different weight. A session that was already idle when the observer
    /// attached has only silence to go on and waits `settle` for it; a session
    /// seen transitioning to `Idle` has evidence and waits the shorter
    /// `edge_settle` — but it does wait, because an `Idle` published during the
    /// wrap-up's own injection, or between two turns of a throttled detector,
    /// says nothing about the wrap-up being finished. Either window is restarted
    /// by any further event about this session, so an agent that goes back to
    /// work is not reported idle.
    async fn wait_for_idle(
        &mut self,
        budget: Duration,
        settle: Duration,
        edge_settle: Duration,
    ) -> IdleOutcome {
        let start = tokio::time::Instant::now();
        let deadline = start + budget;
        // Silence is measured from the last event *about this session*, not
        // from the last event read. The subscription is machine-wide, so a
        // second agent on the box emits status changes continuously; timing the
        // window from reads would mean it never elapses there, and the "idle
        // silence is its own answer" fallback would never fire — a source whose
        // post-wrap-up turn was too short to be seen as busy would wait out the
        // whole budget and degrade a shutdown that was fine.
        let mut silent_since = start;
        // Set once this session has been *seen* going idle, which is what buys
        // the shorter window. Never unset: an agent that goes busy and idle
        // again has been seen twice over, and the window is measured from the
        // last event either way.
        let mut idle_edge_seen = false;
        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return IdleOutcome::TimedOut(self.status);
            }
            let settled_at = silent_since + if idle_edge_seen { edge_settle } else { settle };
            // Silence only means "finished" for a session that is already idle;
            // anything else is the agent still at it, and waits out the budget.
            let idle = self.status == SessionStatus::Idle;
            if idle && now >= settled_at {
                return IdleOutcome::Idle;
            }
            let wake = if idle {
                settled_at.min(deadline)
            } else {
                deadline
            };
            match tokio::time::timeout_at(wake, self.reader.read_event()).await {
                Ok(Ok(event)) => {
                    if self.absorb(&event) {
                        silent_since = tokio::time::Instant::now();
                    }
                    match event {
                        // An idle edge is not the answer on its own; it starts
                        // the shorter settle window, which the loop head reads.
                        DaemonEvent::StatusChanged {
                            ref session_id,
                            status: SessionStatus::Idle,
                            ..
                        } if *session_id == self.session_id => {
                            idle_edge_seen = true;
                            continue;
                        }
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
                // A window elapsed; the loop head decides which one it was.
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
    use kanna_daemon::protocol::{
        ErrorCode as DaemonErrorCode, SessionInfo, SessionKind, SessionState,
    };
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
            Self::start_refusing(label, listed, None)
        }

        /// A daemon that refuses every `SubmitInput` with one error code, so a
        /// test can pin what finalization does with each refusal.
        fn start_refusing(
            label: &str,
            listed: Option<SessionStatus>,
            submit_refusal: Option<DaemonErrorCode>,
        ) -> Self {
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
                        submit_refusal,
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
                ref session_id,
                status: SessionStatus::Idle,
                ..
            } = event
            {
                if session_id == SESSION {
                    let mut log = self.log.lock().expect("log");
                    let seen = log.inputs.len();
                    log.inputs_at_idle.get_or_insert(seen);
                }
            }
            let _ = self.events.send(event);
        }

        fn status(&self, status: SessionStatus) {
            self.status_of(SESSION, status);
        }

        /// The daemon publishes every session on the machine to every
        /// subscriber, so a test can put another task's traffic on the wire.
        fn status_of(&self, session_id: &str, status: SessionStatus) {
            self.publish(DaemonEvent::StatusChanged {
                session_id: session_id.to_string(),
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
        submit_refusal: Option<DaemonErrorCode>,
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
                            logical_input_blocked: false,
                            composer_text: None,
                            composer_attestation: Default::default(),
                        })
                        .into_iter()
                        .collect(),
                },
                DaemonCommand::SubmitInput { data, .. } => match submit_refusal {
                    Some(code) => DaemonEvent::Error {
                        code: Some(code),
                        message: "the fake daemon refused this submission".to_string(),
                    },
                    None => {
                        log.lock()
                            .expect("log")
                            .inputs
                            .push(String::from_utf8_lossy(&data).into_owned());
                        DaemonEvent::Ok
                    }
                },
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

        // Fidelity, not tidiness. The real daemon aborts its subscription task
        // the moment the command loop ends (`crates/daemon/src/connection.rs`),
        // so a client that lets its write half drop stops receiving events —
        // which is exactly how a subscriber that fails to hold its writer open
        // loses the stream. A fake that keeps publishing to a half-closed
        // connection hides that bug, and did.
        if let Some(task) = subscription {
            task.abort();
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

        daemon.wait_for_inputs(1).await;
        // Still busy — a quit typed now would truncate the turn.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            daemon.inputs().len(),
            1,
            "something was typed at a busy agent: {:?}",
            daemon.inputs(),
        );

        daemon.status(SessionStatus::Idle);
        daemon.wait_for_inputs(2).await;
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
        assert_eq!(
            inputs[1], "/exit",
            "the quit command was not typed: {inputs:?}"
        );
        assert_eq!(
            daemon.inputs_at_idle(),
            Some(1),
            "the quit was typed before the session was reported idle: {inputs:?}",
        );
        assert_eq!(
            phases(&state),
            vec!["wrap-up-sent", "idle", "quit-sent", "exited"],
            "the transfer's finalization was not observable step by step",
        );
    }

    /// A held wrap-up is queued inside the daemon and will be typed when the
    /// human at that terminal submits their own line. It has not failed to
    /// land — it has not landed yet — so the phase claim stays held.
    ///
    /// Releasing it let a retry of this work item queue a SECOND wrap-up (and
    /// a second `/exit`) behind the first, which is the duplicate the claim
    /// exists to prevent. Before `input_held_by_draft` existed a held message
    /// answered `Ok`, so this could not happen.
    #[tokio::test]
    async fn a_wrap_up_held_behind_an_unsent_human_line_keeps_its_phase_claim() {
        let daemon = FakeDaemon::start_refusing(
            "held-by-draft",
            Some(SessionStatus::Idle),
            Some(DaemonErrorCode::LogicalInputHeldByDraft),
        );
        let state = state_for(&daemon, "desktop-finalize-held");

        let outcome =
            finalize_source_session(&state, &work_item(), SESSION, Some("pty"), Some("claude"))
                .await;
        assert!(
            !outcome.cleanly_finalized(),
            "a held wrap-up must degrade finalization: {outcome:?}"
        );

        let db = open_db(&state).expect("db");
        assert!(
            !db.claim_transfer_work_phase(&work_item().id, WRAP_UP_PHASE)
                .expect("claim"),
            "the wrap-up claim was released, so a retry would queue a second wrap-up"
        );
    }

    /// The other refusal releases. `input_blocked` means the daemon queued
    /// nothing at all, so re-claiming on a retry is both safe and the only way
    /// the wrap-up ever gets typed.
    #[tokio::test]
    async fn a_wrap_up_refused_outright_releases_its_phase_claim_for_a_retry() {
        let daemon = FakeDaemon::start_refusing(
            "input-blocked",
            Some(SessionStatus::Idle),
            Some(DaemonErrorCode::InheritedDraftStateUnknown),
        );
        let state = state_for(&daemon, "desktop-finalize-blocked");

        let outcome =
            finalize_source_session(&state, &work_item(), SESSION, Some("pty"), Some("claude"))
                .await;
        assert!(
            !outcome.cleanly_finalized(),
            "a refused wrap-up must degrade finalization: {outcome:?}"
        );

        let db = open_db(&state).expect("db");
        assert!(
            db.claim_transfer_work_phase(&work_item().id, WRAP_UP_PHASE)
                .expect("claim"),
            "nothing was queued, so the claim must be available to a retry"
        );
    }

    /// The `Idle` the daemon publishes while it submits the wrap-up is not the
    /// end of the wrap-up.
    ///
    /// The daemon writes the accepted message, pauses so its CR registers as a
    /// discrete Enter, and only then writes that CR. The session is legitimately
    /// idle across that gap, so a transient `Idle` edge still cannot release the
    /// quit. The quit waits for the status to *hold*.
    #[tokio::test]
    async fn an_idle_published_while_the_wrap_up_is_submitted_does_not_release_the_quit() {
        let daemon = FakeDaemon::start("idle-mid-injection", Some(SessionStatus::Busy));
        let state = state_for(&daemon, "desktop-finalize-mid-injection");

        let sequence = tokio::spawn({
            let state = Arc::clone(&state);
            async move {
                finalize_source_session(&state, &work_item(), SESSION, Some("pty"), Some("claude"))
                    .await
            }
        });

        // Acceptance precedes the daemon-owned delayed Enter, so the session
        // can publish an idle edge after this command is acknowledged.
        daemon.wait_for_inputs(1).await;
        daemon.status(SessionStatus::Idle);

        // The Enter lands, the agent takes the message and starts the wrap-up.
        tokio::time::sleep(Duration::from_millis(200)).await;
        daemon.status(SessionStatus::Busy);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            daemon.inputs().len(),
            1,
            "the quit was released by an idle published mid-injection: {:?}",
            daemon.inputs(),
        );
        assert_eq!(
            daemon.inputs_at_idle(),
            Some(1),
            "the idle under test was not the one inside the injection",
        );

        // The real end of the turn.
        daemon.status(SessionStatus::Idle);
        daemon.wait_for_inputs(2).await;
        daemon.exit();

        let outcome = sequence.await.expect("sequence");
        assert!(
            outcome.cleanly_finalized(),
            "a sequence that ran to completion reported degraded: {:?}",
            outcome.degraded_reason,
        );
        assert_eq!(
            daemon.inputs()[1],
            "/exit",
            "the quit command was not what followed the wrap-up: {:?}",
            daemon.inputs(),
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

        daemon.wait_for_inputs(1).await;
        daemon.status(SessionStatus::Idle);
        daemon.wait_for_inputs(2).await;
        daemon.exit();
        sequence.await.expect("sequence");

        assert_eq!(daemon.inputs()[1], "/quit");
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
            .wait_for_idle(
                Duration::from_millis(400),
                Duration::from_millis(50),
                Duration::from_millis(20),
            )
            .await;

        assert!(
            matches!(outcome, IdleOutcome::TimedOut(SessionStatus::Waiting)),
            "a permission prompt was mistaken for a finished turn",
        );
    }

    /// …and reading it correctly is not enough on its own: a session already
    /// parked when finalization starts must be left completely alone.
    ///
    /// The submission policy ends every message with a discrete CR, which is
    /// the keystroke that accepts a permission prompt's highlighted option — so
    /// typing the *wrap-up* at a parked session approves whatever tool call it
    /// is holding, in the operator's name. Worse, it does so invisibly: the
    /// agent resumes, goes idle, quits on cue, and the payload ships
    /// `cleanlyFinalized: true` with nothing recording the approval. Pushing a
    /// task that is parked on a prompt is a normal thing to do, so this is the
    /// ordinary case, not an exotic one.
    #[tokio::test]
    async fn nothing_is_typed_at_a_session_already_parked_on_a_permission_prompt() {
        let daemon = FakeDaemon::start("waiting-at-start", Some(SessionStatus::Waiting));
        let state = state_for(&daemon, "desktop-finalize-waiting");

        let outcome =
            finalize_source_session(&state, &work_item(), SESSION, Some("pty"), Some("claude"))
                .await;

        assert!(
            daemon.inputs().is_empty(),
            "the transfer typed at a permission prompt: {:?}",
            daemon.inputs(),
        );
        let reason = outcome
            .degraded_reason
            .expect("a finalization that never asked the agent anything reported itself clean");
        assert!(
            reason.contains("permission prompt"),
            "the degradation does not say the prompt is why: {reason}",
        );
        assert_eq!(phases(&state), vec!["degraded"]);
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
            .wait_for_idle(
                Duration::from_secs(5),
                Duration::from_millis(50),
                Duration::from_millis(20),
            )
            .await;

        assert!(
            matches!(outcome, IdleOutcome::Idle),
            "idle silence was not read as idle"
        );
    }

    /// …and it is silence *from this session* that counts.
    ///
    /// The daemon writes every session's status changes to every subscriber, so
    /// a machine running a second agent puts a steady stream of unrelated
    /// events on this observer's connection. Timing the settle window from the
    /// last read rather than the last event about this session means it never
    /// elapses there: the fallback above stops firing, and a source whose
    /// post-wrap-up turn was too short to be seen as busy waits out the entire
    /// budget before degrading a shutdown that was fine.
    #[tokio::test]
    async fn another_session_s_traffic_does_not_hold_the_settle_window_open() {
        let daemon = FakeDaemon::start("idle-noise", Some(SessionStatus::Idle));
        let mut observer = observer_for(&daemon).await;

        // Faster than the settle window, so under the old rule every read reset
        // it and only the budget could end the wait.
        let noise = daemon.events.clone();
        let ticker = tokio::spawn(async move {
            loop {
                let _ = noise.send(DaemonEvent::StatusChanged {
                    session_id: "task-someone-else".to_string(),
                    status: SessionStatus::Busy,
                    waiting_prompt_snippet: None,
                });
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });

        let outcome = observer
            .wait_for_idle(
                Duration::from_secs(3),
                Duration::from_millis(400),
                Duration::from_millis(400),
            )
            .await;
        ticker.abort();

        assert!(
            matches!(outcome, IdleOutcome::Idle),
            "another session's events kept the settle window open, so this one \
             never read as idle",
        );
    }

    /// An `Idle` *edge* is evidence, not a verdict.
    ///
    /// Busy detection is 500 ms-throttled, so an agent that pauses between two
    /// stretches of its own work can be published as `Idle` mid-turn. Returning
    /// on the first edge typed `/exit` at an agent that was still going —
    /// truncating the very wrap-up the sequence exists to capture, and reporting
    /// the finalization clean. The edge starts the shorter settle window
    /// instead, and the return to `Busy` cancels it.
    #[tokio::test]
    async fn an_idle_edge_that_goes_back_to_busy_is_not_a_finished_turn() {
        let daemon = FakeDaemon::start("idle-blip", Some(SessionStatus::Busy));
        let mut observer = observer_for(&daemon).await;
        daemon.status(SessionStatus::Idle);
        daemon.status(SessionStatus::Busy);

        let outcome = observer
            .wait_for_idle(
                Duration::from_millis(400),
                // Long enough that only the edge window could end this wait, so
                // a pass cannot come from the already-idle fallback.
                Duration::from_secs(30),
                Duration::from_millis(100),
            )
            .await;

        assert!(
            matches!(outcome, IdleOutcome::TimedOut(SessionStatus::Busy)),
            "an idle blip inside a turn was read as a finished turn",
        );
    }

    /// Silence from a session that is still working is not the same answer:
    /// it keeps waiting until the budget is spent, then degrades.
    #[tokio::test]
    async fn silence_from_a_busy_session_is_not_a_finished_turn() {
        let daemon = FakeDaemon::start("busy-silence", Some(SessionStatus::Busy));
        let mut observer = observer_for(&daemon).await;

        let outcome = observer
            .wait_for_idle(
                Duration::from_millis(250),
                Duration::from_millis(50),
                Duration::from_millis(20),
            )
            .await;

        assert!(matches!(
            outcome,
            IdleOutcome::TimedOut(SessionStatus::Busy)
        ));
    }

    /// The destination waits out this whole sequence over a single peer
    /// request, so the sequence has to fit inside what that request allows.
    ///
    /// When it did not, a wrap-up longer than the sidecar's ordinary 15 s
    /// window surfaced on the destination as `PeerRequestTimeout` and spent one
    /// of `MAX_TRANSFER_WORK_ATTEMPTS` on an import that was going fine — the
    /// budget reserved for a locked OpenCode store or a dropped artifact fetch,
    /// not for waiting. The transfer still completed off the cached
    /// finalization result, so nothing failed loudly; the cost was invisible.
    ///
    /// The two ends of the request are enforced in crates that do not depend on
    /// each other (`kanna-server` reaches the sidecar over stdio), so the window
    /// is read from `kanna-runtime-defaults`, which both already depend on,
    /// rather than restated here. That makes this one assertion guard both
    /// directions: raising the budget past the window fails it, and so does
    /// shrinking the window under the budget — which a hand-copied window could
    /// not catch. The behaviour itself is pinned where both ends of the request
    /// exist, in `crates/task-transfer/tests/runtime.rs`.
    #[test]
    fn the_shutdown_budget_fits_inside_the_peer_finalization_window() {
        let window = kanna_runtime_defaults::TRANSFER_FINALIZATION_REQUEST_TIMEOUT;
        let shutdown = WRAP_UP_TIMEOUT + QUIT_EXIT_TIMEOUT;
        assert!(
            shutdown < window,
            "the shutdown budget ({}s) no longer fits inside the sidecar's finalization window \
             ({}s); raise TRANSFER_FINALIZATION_REQUEST_TIMEOUT in \
             crates/runtime-defaults/src/lib.rs first, or the destination will time out \
             mid-wrap-up and spend an import attempt on it",
            shutdown.as_secs(),
            window.as_secs(),
        );
        // Staging runs after the sequence and inside the same request: gzipping
        // a session archive and reading a rollout are not instant on a large
        // conversation, so the fit has to leave room rather than merely hold.
        assert!(
            window - shutdown >= Duration::from_secs(120),
            "no room left in the finalization window for staging the session artifacts",
        );
    }
}
