use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Weak,
};
use std::time::{Duration, Instant};

use crate::detection::{Classifier, CliVersion};
use crate::draft_bytes::draft_content_byte_count;
#[cfg(test)]
use crate::headless_terminal::ComposerState;
use crate::headless_terminal::HeadlessTerminal;
use crate::protocol::{
    AgentProvider, ComposerAttestation, SessionInfo, SessionState, SessionStatus,
};
use crate::pty::PtySession;
use kanna_daemon::terminal_perf::{self, TerminalPerfContext};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};

pub const STATUS_DETECTION_THROTTLE_MS: u64 = 500;
/// How long the terminal must stay quiet before a logical message's Enter may
/// follow it, and how long the writer pauses after an Enter before the next
/// message may own the composer.
///
/// This is a *settle window*, not a countdown from the write. A CLI repaints
/// while it consumes an input burst, so output that is still arriving is
/// positive evidence that the burst has not been consumed yet and the window
/// restarts. It was a fixed fence from the write until 2026-09-05, when a
/// 1,227-byte dictated message took a Claude session about 19 seconds of
/// repainting to drain: the Enter landed 150 ms in, was taken as part of the
/// burst rather than as a submission, and the owner's message sat unsent at the
/// composer for six minutes.
pub const LOGICAL_INPUT_SUBMIT_DELAY_MS: u64 = 150;
/// How long a draft swap waits for one provider repaint, and for one of its
/// own writes to reach the PTY.
///
/// Short on purpose. Everything it bounds is a keystroke's worth of work on an
/// idle composer, and a provider that has not answered in this long is one
/// whose composer nothing here can describe — which is the case the swap has
/// to abandon rather than write into.
const COMPOSER_SWAP_STEP_TIMEOUT_MS: u64 = 2_000;

fn composer_swap_step_timeout() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(milliseconds) = std::env::var("KANNA_DAEMON_TEST_COMPOSER_SWAP_STEP_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
    {
        return Duration::from_millis(milliseconds);
    }
    Duration::from_millis(COMPOSER_SWAP_STEP_TIMEOUT_MS)
}

/// The bound on waiting for that quiet window.
///
/// A terminal that never settles cannot be proven to have consumed anything, so
/// the Enter is withheld rather than written into a repaint and the delivery is
/// answered as unproven. Kept well under the server's 30-second daemon command
/// timeout so the caller hears that verdict instead of losing the round trip.
pub const LOGICAL_INPUT_CONSUMPTION_TIMEOUT_MS: u64 = 25_000;
const BRACKETED_PASTE_BEGIN: &[u8] = b"\x1b[200~";
const BRACKETED_PASTE_END: &[u8] = b"\x1b[201~";

/// A logical message at least this long is framed as a paste even when it
/// carries no embedded newline.
///
/// A PTY master's input queue accepts only about a kilobyte per write — 1022
/// bytes on macOS — so anything longer reaches the CLI as several separate
/// input events no matter how the daemon issues it. Measured on 2026-09-05
/// against Claude Code 2.1.261: a 1,191-byte single-line message was written as
/// 1022 + 169 bytes, the CLI read the first burst as a paste and the remainder
/// as typing, and only the 169-byte tail was submitted. The owner's 1,227-byte
/// dictated message failed the same way in production; their 927-byte re-send
/// fit one write and arrived.
///
/// The threshold sits far below that split boundary and far above any provider
/// slash command, which is the only thing the unframed path protects.
const PASTE_FRAMING_MIN_LEN: usize = 256;

/// Present a logical message to the terminal as one paste.
///
/// A PTY is only a byte stream, and the daemon's writes are not the CLI's reads:
/// embedded line feeds are indistinguishable from independently typed input,
/// and a message too long for one write arrives as several input events even
/// without them. An interactive agent TUI then consumes the pieces as separate
/// editor actions and submits only a fragment. When the application has enabled
/// the mode, the explicit paste markers travel in-band with the bytes and are
/// therefore immune to however the queue splits them: every byte between them
/// is one editor operation, closed before the separately fenced Enter submits
/// it. Otherwise the bytes stay untouched; sending unsupported control markers
/// as literal composer text would be a worse corruption, and a session whose
/// terminal never advertised the mode cannot be protected from the split.
fn frame_logical_message(mut data: Vec<u8>, bracketed_paste_mode: bool) -> Vec<u8> {
    if !bracketed_paste_mode {
        return data;
    }
    let has_newline = data.iter().any(|byte| matches!(byte, b'\r' | b'\n'));
    if !has_newline && data.len() < PASTE_FRAMING_MIN_LEN {
        return data;
    }

    let mut framed =
        Vec::with_capacity(BRACKETED_PASTE_BEGIN.len() + data.len() + BRACKETED_PASTE_END.len());
    framed.extend_from_slice(BRACKETED_PASTE_BEGIN);
    framed.append(&mut data);
    framed.extend_from_slice(BRACKETED_PASTE_END);
    framed
}

#[derive(Clone)]
pub struct StreamControl {
    stop_requested: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    quiesce_requested: Arc<AtomicBool>,
    quiesced: Arc<AtomicBool>,
    stopped_notify: Arc<Notify>,
    state_notify: Arc<Notify>,
}

impl Default for StreamControl {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamControl {
    pub fn new() -> Self {
        Self {
            stop_requested: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(AtomicBool::new(false)),
            quiesce_requested: Arc::new(AtomicBool::new(false)),
            quiesced: Arc::new(AtomicBool::new(false)),
            stopped_notify: Arc::new(Notify::new()),
            state_notify: Arc::new(Notify::new()),
        }
    }

    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
        self.state_notify.notify_one();
    }

    pub fn stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::SeqCst)
    }

    pub fn mark_stopped(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.quiesced.store(false, Ordering::SeqCst);
        self.stopped_notify.notify_waiters();
        self.state_notify.notify_waiters();
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub fn is_same_instance(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.stop_requested, &other.stop_requested)
            && Arc::ptr_eq(&self.stopped, &other.stopped)
    }

    pub fn request_quiesce(&self) {
        self.quiesce_requested.store(true, Ordering::SeqCst);
        self.state_notify.notify_one();
    }

    pub fn resume(&self) {
        self.quiesce_requested.store(false, Ordering::SeqCst);
        self.state_notify.notify_one();
    }

    pub fn quiesce_requested(&self) -> bool {
        self.quiesce_requested.load(Ordering::SeqCst)
    }

    pub fn mark_quiesced(&self) {
        self.quiesced.store(true, Ordering::SeqCst);
        self.state_notify.notify_waiters();
    }

    pub fn mark_resumed(&self) {
        self.quiesced.store(false, Ordering::SeqCst);
        self.state_notify.notify_waiters();
    }

    pub fn is_quiesced(&self) -> bool {
        self.quiesced.load(Ordering::SeqCst)
    }

    pub async fn wait_for_state_change(&self) {
        self.state_notify.notified().await;
    }

    pub async fn wait_until_stopped(&self) {
        loop {
            let notified = self.stopped_notify.notified();
            if self.is_stopped() {
                return;
            }
            notified.await;
        }
    }
}

pub struct SessionRecord {
    pub pty: PtySession,
    pub headless_terminal: HeadlessTerminal,
    pub stream_control: Option<StreamControl>,
    pub agent_provider: Option<AgentProvider>,
    /// The provider CLI release this session is running, when a probe has
    /// answered. `None` is a first-class answer, not a gap to be filled in
    /// later with a guess: it selects every rule measured for the provider,
    /// which is what an unversioned session classified from before rule
    /// selection existed.
    pub cli_version: Option<CliVersion>,
    pub status: SessionStatus,
    pub status_observed: bool,
    pub last_status_check_at: Option<Instant>,
    pub operator_input_only: bool,
    pub input_policy_classified: bool,
    pub raw_input_draft_active: bool,
    pub raw_input_draft_state_known: bool,
    /// Bytes seen typed into the composer since the last producer-declared
    /// submission boundary. `None` means no ledger came with the session — an
    /// inherited draft nobody here counted — and is deliberately not the same
    /// as `Some(0)`.
    pub typed_draft_bytes: Option<u64>,
    pub pending_logical_inputs: Vec<Vec<u8>>,
}

pub struct SessionRuntimeState {
    pub headless_terminal: HeadlessTerminal,
    /// This session's view of the detection rules: its provider, its CLI
    /// version, and the rule set those resolve to. Re-resolves itself when a
    /// hot-reloaded rule file changes.
    pub classifier: Classifier,
    /// The composer line and verdict already published to subscribers, so the
    /// status loop can emit on the edge instead of on every tick.
    published_composer: Option<(Option<String>, ComposerAttestation)>,
    pub stream_control: Option<StreamControl>,
    pub agent_provider: Option<AgentProvider>,
    pub status: SessionStatus,
    pub status_observed: bool,
    pub last_status_check_at: Option<Instant>,
    /// Latest PTY output mirrored into the terminal. Unlike PTY
    /// `last_active_at`, which tracks operator input, this is the boundary
    /// that tells the status loop a provider repaint has actually settled.
    last_output_at: Option<Instant>,
    pub operator_input_only: bool,
    pub input_policy_classified: bool,
}

/// How long the writer may wait for evidence that a CLI consumed a logical
/// message before giving up on proving its submission.
pub fn logical_input_consumption_timeout() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(milliseconds) = std::env::var("KANNA_DAEMON_TEST_LOGICAL_CONSUMPTION_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
    {
        return Duration::from_millis(milliseconds);
    }
    Duration::from_millis(LOGICAL_INPUT_CONSUMPTION_TIMEOUT_MS)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingInputKind {
    Raw,
    LogicalMessage,
    LogicalEnter,
}

/// What actually became of one write the daemon acknowledged.
///
/// Acceptance, arrival and submission are three different events, and a caller
/// that hears only "ok" cannot tell them apart. A logical message is two writes
/// — its text, then its Enter — and only the second one submits anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOutcome {
    /// Everything this write was for reached the PTY. For a logical message
    /// that includes its terminating Enter.
    Written,
    /// The message text reached the PTY, but the terminal never settled inside
    /// the bound, so no Enter was written and the text is parked at the
    /// composer. The caller must not retry it blindly.
    SubmissionUnproven,
    /// Nothing was written. An earlier logical message is parked unsubmitted at
    /// this composer, and writing here would concatenate onto it.
    NotWritten,
}

/// Meaning declared by the terminal input producer. Submission is never
/// inferred from PTY bytes: pasted newlines and control sequences may contain
/// the same bytes as an Enter key without ending the active composer draft.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawInputKind {
    Draft,
    Submission,
    Control,
}

pub struct PendingInput {
    pub data: Vec<u8>,
    pub kind: PendingInputKind,
    /// Set for bytes a producer declared a draft. The writer reports these
    /// back when their PTY write completes, so attestation can tell a frame
    /// that post-dates the draft from one that merely predates it.
    declared_draft: bool,
    written: Option<oneshot::Sender<WriteOutcome>>,
    #[cfg_attr(not(test), allow(dead_code))]
    logical_after_write: Vec<(Vec<u8>, Option<oneshot::Sender<WriteOutcome>>, bool)>,
    logical_released_from_draft: bool,
}

impl PendingInput {
    fn raw(data: Vec<u8>, written: Option<oneshot::Sender<WriteOutcome>>) -> Self {
        Self {
            data,
            kind: PendingInputKind::Raw,
            declared_draft: false,
            written,
            logical_after_write: Vec::new(),
            logical_released_from_draft: false,
        }
    }

    fn raw_draft(data: Vec<u8>, written: Option<oneshot::Sender<WriteOutcome>>) -> Self {
        Self {
            data,
            kind: PendingInputKind::Raw,
            declared_draft: true,
            written,
            logical_after_write: Vec::new(),
            logical_released_from_draft: false,
        }
    }

    fn raw_submission(
        data: Vec<u8>,
        written: Option<oneshot::Sender<WriteOutcome>>,
        logical_after_write: Vec<(Vec<u8>, Option<oneshot::Sender<WriteOutcome>>, bool)>,
    ) -> Self {
        Self {
            data,
            kind: PendingInputKind::Raw,
            declared_draft: false,
            written,
            logical_after_write,
            logical_released_from_draft: false,
        }
    }

    /// A logical message whose `written` acknowledgement fires only once the
    /// terminating Enter has been written — never after the message text
    /// alone. The two writes are one delivery, so a caller that hears "ok"
    /// after the first would be told a message was submitted while it was
    /// still sitting unsent at the composer.
    pub(crate) fn acknowledged_logical(
        data: Vec<u8>,
        written: Option<oneshot::Sender<WriteOutcome>>,
        released_from_draft: bool,
        bracketed_paste_mode: bool,
    ) -> Self {
        if data.is_empty() {
            Self {
                data: vec![b'\r'],
                kind: PendingInputKind::LogicalEnter,
                declared_draft: false,
                written,
                logical_after_write: Vec::new(),
                logical_released_from_draft: released_from_draft,
            }
        } else {
            Self {
                data: frame_logical_message(data, bracketed_paste_mode),
                kind: PendingInputKind::LogicalMessage,
                declared_draft: false,
                written,
                logical_after_write: Vec::new(),
                logical_released_from_draft: released_from_draft,
            }
        }
    }

    pub fn advance_logical_message_to_enter(&mut self) -> bool {
        if self.kind != PendingInputKind::LogicalMessage {
            return false;
        }
        self.data.clear();
        self.data.push(b'\r');
        self.kind = PendingInputKind::LogicalEnter;
        true
    }

    /// Whether these bytes were declared a draft by their producer.
    pub fn is_declared_draft(&self) -> bool {
        self.declared_draft
    }

    /// Tell the caller what became of this write. Exactly one outcome is ever
    /// reported for a given input; dropping the sender instead reports a
    /// writer that ended mid-delivery.
    pub fn resolve(mut self, outcome: WriteOutcome) {
        if let Some(written) = self.written.take() {
            let _ = written.send(outcome);
        }
    }

    pub fn acknowledge_written(self) {
        self.resolve(WriteOutcome::Written);
    }

    pub fn logical_released_from_draft(&self) -> bool {
        self.logical_released_from_draft
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn take_logical_after_write(
        &mut self,
    ) -> Vec<(Vec<u8>, Option<oneshot::Sender<WriteOutcome>>, bool)> {
        std::mem::take(&mut self.logical_after_write)
    }
}

#[derive(Debug)]
pub enum InputQueueError {
    Closed,
    CoordinationUnavailable,
    InheritedDraftStateUnknown,
}

/// One accepted logical message and what actually happened to it.
///
/// Acceptance and submission are not the same event, and answering a caller
/// as though they were is what let a delivery report success while the message
/// sat unsent at the composer. `written` resolves only once the message *and*
/// its terminating Enter have reached the PTY; `held_by_raw_draft` says the
/// message is not going anywhere until a human at that terminal submits their
/// own line, so nothing has been written and no acknowledgement is coming
/// within this call.
pub struct LogicalInputAccepted {
    pub written: oneshot::Receiver<WriteOutcome>,
    pub held_by_raw_draft: bool,
}

struct InputCoordinationState {
    raw_input_draft_active: bool,
    raw_input_draft_state_known: bool,
    /// What the daemon actually saw typed into this composer since the last
    /// producer-declared submission boundary.
    ///
    /// This is the whole of the attestation. `Some(0)` is positive proof that
    /// nothing anybody wrote is sitting at that prompt, so any text rendered
    /// there is the CLI's own suggestion and a delivered message can be
    /// written immediately. `None` is the inherited case — a declared draft
    /// with no ledger behind it — and holds exactly like a counted one, so
    /// "cannot prove" never reads as "proved empty".
    typed_draft_bytes: Option<u64>,
    /// Producer-declared draft writes accepted, and how many have finished
    /// reaching the PTY. Attestation may clear an *active* draft only when
    /// these agree: a declared byte still queued in the writer, or written but
    /// not yet echoed, leaves a frame that renders the composer empty because
    /// the draft has not landed on it yet — not because there is no draft.
    declared_draft_writes_enqueued: u64,
    declared_draft_writes_completed: u64,
    /// Mirrored output chunks observed when the last declared-draft write
    /// completed. A frame proves it post-dates the draft only if at least one
    /// chunk has been mirrored since that moment.
    mirrored_chunks_at_last_draft_write: u64,
    logical_inputs: VecDeque<QueuedLogicalInput>,
    /// The blocked value already published to subscribers. Every cause of a
    /// change — adoption, a human keystroke, composer attestation — lands in
    /// this struct, so one poller comparing against this field reports all of
    /// them and none of the writers needs a broadcast handle.
    published_input_blocked: bool,
    /// Ids handed out to queued logical messages so far.
    next_logical_input_id: u64,
    /// Set while this daemon has a human's draft lifted off the composer.
    ///
    /// Its presence is the whole interlock: exactly one swap runs at a time,
    /// and every raw write that arrives meanwhile is buffered here rather than
    /// landing on a composer that is mid-operation. A human who keeps typing
    /// through a swap loses nothing and sees nothing reordered — their
    /// keystrokes are replayed onto the restored draft, in order.
    draft_swap: Option<DraftSwap>,
}

/// One in-flight draft swap.
struct DraftSwap {
    buffered: Vec<BufferedRawInput>,
}

/// A raw write held back while a swap is in flight, with the acknowledgement
/// its producer is still waiting on. The ack fires when the bytes actually
/// reach the PTY, which is after the replay — the producer is told the truth
/// about when its keystroke landed, not a convenient earlier answer.
struct BufferedRawInput {
    data: Vec<u8>,
    kind: RawInputKind,
    written: Option<oneshot::Sender<WriteOutcome>>,
}

/// What a delivery attempted over a typed draft actually did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftSwapOutcome {
    /// No swap was tried. Either nothing was held, the composer is not one
    /// this daemon can lift text off, or another swap is already running. The
    /// message stays queued exactly as it was.
    NotAttempted,
    /// The draft was lifted, the queued messages were submitted, and the draft
    /// is back at the composer with any keystrokes typed mid-swap replayed
    /// after it.
    Restored,
    /// The messages were written but their submission could not be proven, so
    /// the message text is parked at the composer and the draft was **not**
    /// written back on top of it. The captured draft is logged verbatim.
    DeliveredUnproven,
    /// The messages were submitted, but the draft could not be written back.
    /// The delivery succeeded and is reported as such; the draft is logged
    /// verbatim, because it is gone from the composer.
    DeliveredWithoutRestore,
    /// A step could not be verified. Nothing was submitted and nothing was
    /// written back; the message stays queued behind the draft.
    Aborted,
}

/// What clears a provider's composer in one keystroke, given a cursor already
/// at the end of the draft.
///
/// Claude Code binds `Ctrl-U` to "delete from the cursor to the start of the
/// line", so it clears the whole draft only because a swap refuses to start
/// unless the cursor is after everything rendered — the same precondition that
/// makes the captured draft the whole line. Nothing else is measured, and this
/// file's rule is that unmeasured chrome matches nothing: another provider
/// falls back to queueing rather than to a guessed keybinding.
fn composer_clear_sequence(provider: Option<AgentProvider>) -> Option<&'static [u8]> {
    match provider {
        Some(AgentProvider::Claude) => Some(b"\x15"),
        _ => None,
    }
}

struct QueuedLogicalInput {
    /// Identifies this entry for the length of its stay in the queue.
    ///
    /// A draft swap hands one entry's acknowledgement to itself and must give
    /// it back if it abandons. "The last undispatched entry" is not that
    /// entry: a message queued while the swap ran is also undispatched, and
    /// handing it somebody else's acknowledgement answers the wrong caller.
    id: u64,
    data: Vec<u8>,
    dispatched: bool,
    released_from_draft: bool,
    /// Fires when this message's terminating Enter is written. It travels with
    /// the message rather than with the call that queued it, so a message
    /// released by a later boundary or by composer attestation acknowledges
    /// through the same channel as one dispatched immediately.
    written: Option<oneshot::Sender<WriteOutcome>>,
}

impl InputCoordinationState {
    fn from_record(record: &SessionRecord) -> Self {
        Self {
            raw_input_draft_active: record.raw_input_draft_active,
            raw_input_draft_state_known: record.raw_input_draft_state_known,
            typed_draft_bytes: record.typed_draft_bytes,
            declared_draft_writes_enqueued: 0,
            declared_draft_writes_completed: 0,
            mirrored_chunks_at_last_draft_write: 0,
            next_logical_input_id: record.pending_logical_inputs.len() as u64,
            draft_swap: None,
            published_input_blocked: !record.raw_input_draft_state_known,
            logical_inputs: record
                .pending_logical_inputs
                .iter()
                .cloned()
                .enumerate()
                .map(|(index, data)| QueuedLogicalInput {
                    id: index as u64,
                    data,
                    dispatched: false,
                    released_from_draft: true,
                    written: None,
                })
                .collect(),
        }
    }
}

impl InputCoordinationState {
    /// Whether a declared draft is actually holding logical input back.
    ///
    /// A producer declares a draft; only the ledger says whether anything was
    /// typed into it. Zero typed bytes means there is no unsent line to append
    /// to and nothing a delivered message could corrupt — the CLI throws its
    /// own suggestion away the moment real input arrives — so the message goes
    /// out instead of being parked behind a draft that does not exist.
    fn draft_holds_input(&self) -> bool {
        self.raw_input_draft_active && self.typed_draft_bytes != Some(0)
    }

    fn composer_attestation(&self) -> ComposerAttestation {
        if !self.raw_input_draft_state_known {
            return ComposerAttestation::Unknown;
        }
        match self.typed_draft_bytes {
            Some(0) => ComposerAttestation::NotTyped,
            Some(_) => ComposerAttestation::Typed,
            None => ComposerAttestation::Unknown,
        }
    }
}

pub struct MirrorResult {
    pub status: Option<SessionStatus>,
    pub replies: Vec<Vec<u8>>,
}

/// One live PTY master, attributed to the session that owns it, for the
/// exhaustion diagnostics logged when `openpty` reports `ENXIO`.
#[derive(Debug, Eq, PartialEq)]
pub struct PtyMasterAttribution {
    pub session_id: String,
    pub child_pid: u32,
    pub master_fd: std::os::fd::RawFd,
}

/// Every PTY master this daemon currently holds, in a stable order, so an
/// exhaustion log line names which sessions occupy the host pool.
#[derive(Debug, Eq, PartialEq)]
pub struct PtyOccupancySnapshot {
    sessions: Vec<PtyMasterAttribution>,
}

impl PtyOccupancySnapshot {
    pub fn new(mut sessions: Vec<PtyMasterAttribution>) -> Self {
        sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        Self { sessions }
    }
}

impl fmt::Display for PtyOccupancySnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "open_master_count={} sessions=[",
            self.sessions.len()
        )?;
        for (index, session) in self.sessions.iter().enumerate() {
            if index > 0 {
                formatter.write_str(", ")?;
            }
            write!(
                formatter,
                "{}(pid={},master_fd={})",
                session.session_id, session.child_pid, session.master_fd
            )?;
        }
        formatter.write_str("]")
    }
}

pub struct SessionHandle {
    pub(crate) pty: Mutex<PtySession>,
    /// Set by the first teardown to claim this session. Makes Kill
    /// single-flight per session so concurrent/retried Kill calls cannot
    /// enqueue unbounded whole-table sweep jobs.
    teardown_claimed: std::sync::atomic::AtomicBool,
    state: Mutex<SessionRuntimeState>,
    input_tx: mpsc::UnboundedSender<PendingInput>,
    input_rx: Mutex<Option<mpsc::UnboundedReceiver<PendingInput>>>,
    input_coordination: std::sync::Mutex<InputCoordinationState>,
    /// Output chunks mirrored into the headless terminal, counted so a reader
    /// of that terminal can tell how old the frame it just read is relative to
    /// a declared-draft write.
    mirrored_chunks: AtomicU64,
    /// The terminal application explicitly requested bracketed-paste input.
    /// Logical multiline framing must follow the live mode instead of sending
    /// control markers to a program that would treat them as literal text.
    bracketed_paste_mode: AtomicBool,
    /// Fires every time a chunk is mirrored into the headless terminal.
    ///
    /// A draft swap has to know that the provider has *repainted* before it
    /// reads the composer back, and waiting for that by re-reading on a timer
    /// would be a poll over evidence the mirror already has.
    mirrored: Arc<Notify>,
    /// Permanently fences an outgoing incarnation from publishing output or
    /// mutating id-keyed state after a same-id replacement is allowed.
    retired: AtomicBool,
}

/// Hand every accepted-but-undispatched logical message to the writer, once
/// the coordination state says nothing is holding them back. Shared by session
/// construction and by composer attestation so a message accepted before a
/// draft boundary can never be stranded by whichever path resolves it.
fn dispatch_accepted_logical_inputs(
    input_tx: &mpsc::UnboundedSender<PendingInput>,
    state: &mut InputCoordinationState,
    bracketed_paste_mode: bool,
) -> Result<(), InputQueueError> {
    if !state.raw_input_draft_state_known || state.draft_holds_input() {
        return Ok(());
    }
    for logical_input in &mut state.logical_inputs {
        if logical_input.dispatched {
            continue;
        }
        input_tx
            .send(PendingInput::acknowledged_logical(
                logical_input.data.clone(),
                logical_input.written.take(),
                logical_input.released_from_draft,
                bracketed_paste_mode,
            ))
            .map_err(|_| InputQueueError::Closed)?;
        logical_input.dispatched = true;
    }
    Ok(())
}

impl SessionHandle {
    pub fn new(record: SessionRecord) -> Self {
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        let mut input_coordination = InputCoordinationState::from_record(&record);
        let bracketed_paste_mode = record.headless_terminal.bracketed_paste_mode();
        if let Err(error) = dispatch_accepted_logical_inputs(
            &input_tx,
            &mut input_coordination,
            bracketed_paste_mode,
        ) {
            unreachable!("new session input receiver must be open: {error:?}");
        }
        Self {
            pty: Mutex::new(record.pty),
            teardown_claimed: std::sync::atomic::AtomicBool::new(false),
            state: Mutex::new(SessionRuntimeState {
                headless_terminal: record.headless_terminal,
                classifier: Classifier::with_version(record.agent_provider, record.cli_version),
                published_composer: None,
                stream_control: record.stream_control,
                agent_provider: record.agent_provider,
                status: record.status,
                status_observed: record.status_observed,
                last_status_check_at: record.last_status_check_at,
                last_output_at: None,
                operator_input_only: record.operator_input_only,
                input_policy_classified: record.input_policy_classified,
            }),
            input_tx,
            input_rx: Mutex::new(Some(input_rx)),
            input_coordination: std::sync::Mutex::new(input_coordination),
            mirrored_chunks: AtomicU64::new(0),
            bracketed_paste_mode: AtomicBool::new(bracketed_paste_mode),
            mirrored: Arc::new(Notify::new()),
            retired: AtomicBool::new(false),
        }
    }

    pub fn retire(&self) {
        self.retired.store(true, Ordering::SeqCst);
    }

    pub fn is_retired(&self) -> bool {
        self.retired.load(Ordering::SeqCst)
    }

    pub fn enqueue_terminal_reply(&self, data: Vec<u8>) -> Result<(), InputQueueError> {
        self.input_tx
            .send(PendingInput::raw(data, None))
            .map_err(|_| InputQueueError::Closed)
    }

    pub fn enqueue_raw_input(
        &self,
        data: Vec<u8>,
        kind: RawInputKind,
    ) -> Result<(), InputQueueError> {
        self.enqueue_raw_input_with_ack(data, kind, None)
    }

    pub fn enqueue_acknowledged_raw_input(
        &self,
        data: Vec<u8>,
        kind: RawInputKind,
    ) -> Result<oneshot::Receiver<WriteOutcome>, InputQueueError> {
        let (written_tx, written) = oneshot::channel();
        self.enqueue_raw_input_with_ack(data, kind, Some(written_tx))?;
        Ok(written)
    }

    fn enqueue_raw_input_with_ack(
        &self,
        data: Vec<u8>,
        kind: RawInputKind,
        written: Option<oneshot::Sender<WriteOutcome>>,
    ) -> Result<(), InputQueueError> {
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        // A swap owns the composer for the length of the swap. Writing a
        // keystroke into the middle of one would land it on a cleared line, or
        // between the delivered message and its Enter, so it waits here and is
        // replayed onto the restored draft in the order it was typed.
        if let Some(swap) = state.draft_swap.as_mut() {
            swap.buffered.push(BufferedRawInput {
                data,
                kind,
                written,
            });
            return Ok(());
        }
        self.route_raw_input(&mut state, data, kind, written)
    }

    /// Put one raw write on the wire with its declared meaning applied to the
    /// ledger. The swap machinery calls this directly, which is what lets it
    /// write while every other producer is buffered.
    fn route_raw_input(
        &self,
        state: &mut InputCoordinationState,
        data: Vec<u8>,
        kind: RawInputKind,
        written: Option<oneshot::Sender<WriteOutcome>>,
    ) -> Result<(), InputQueueError> {
        let mut routed = Vec::new();
        match kind {
            RawInputKind::Submission => {
                state.raw_input_draft_active = false;
                state.raw_input_draft_state_known = true;
                // The boundary empties the composer, so the ledger restarts
                // from proven-empty — including for a session that inherited
                // an uncounted draft, which is how such a session ever earns
                // an attestation at all.
                state.typed_draft_bytes = Some(0);
                let mut logical_after_write = Vec::new();
                for logical_input in &mut state.logical_inputs {
                    if !logical_input.dispatched {
                        logical_after_write.push((
                            logical_input.data.clone(),
                            logical_input.written.take(),
                            true,
                        ));
                        logical_input.dispatched = true;
                    }
                }
                routed.push(PendingInput::raw_submission(
                    data,
                    written,
                    logical_after_write,
                ));
            }
            RawInputKind::Draft => {
                // A producer declares that these bytes belong to a human's own
                // line; only their content decides whether one can exist. The
                // desktop declares every non-Enter keydown a draft, so an
                // arrow, an Escape, a PageUp or a click used to arm the ledger
                // and hold every later phone or manager delivery behind a line
                // nobody had typed. Bytes that cannot put text at the composer
                // declare nothing — see [`crate::draft_bytes`].
                let content_bytes = draft_content_byte_count(&data);
                if content_bytes == 0 {
                    routed.push(PendingInput::raw(data, written));
                } else {
                    state.raw_input_draft_active = true;
                    state.raw_input_draft_state_known = true;
                    // Content implies bytes, and bytes are written, so this
                    // enqueued count always has a completion coming. The
                    // writer drops an empty raw input without ever completing
                    // it, and an unmatched enqueue would wedge attestation
                    // shut for the life of the session.
                    state.declared_draft_writes_enqueued += 1;
                    // Content bytes, not the write's length: the escape
                    // sequence around them changed no composer text and must
                    // not read as though it had.
                    if let Some(typed) = state.typed_draft_bytes.as_mut() {
                        *typed = typed.saturating_add(content_bytes);
                    }
                    routed.push(PendingInput::raw_draft(data, written));
                }
            }
            RawInputKind::Control => routed.push(PendingInput::raw(data, written)),
        }
        for input in routed {
            self.input_tx
                .send(input)
                .map_err(|_| InputQueueError::Closed)?;
        }
        Ok(())
    }

    /// Accept one logical message. It is submitted atomically now when no raw
    /// draft exists, or retained until the next producer-declared submission
    /// boundary otherwise — and the caller is told which of the two happened.
    pub fn enqueue_logical_input(
        &self,
        data: Vec<u8>,
    ) -> Result<LogicalInputAccepted, InputQueueError> {
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        if !state.raw_input_draft_state_known {
            return Err(InputQueueError::InheritedDraftStateUnknown);
        }
        let (written_tx, written) = oneshot::channel();
        let released_from_draft = state.draft_holds_input();
        let id = state.next_logical_input_id;
        state.next_logical_input_id += 1;
        state.logical_inputs.push_back(QueuedLogicalInput {
            id,
            data: data.clone(),
            dispatched: false,
            released_from_draft,
            written: Some(written_tx),
        });
        if state.draft_holds_input() {
            return Ok(LogicalInputAccepted {
                written,
                held_by_raw_draft: true,
            });
        }
        let queued_ack = state
            .logical_inputs
            .back_mut()
            .and_then(|logical_input| logical_input.written.take());
        if self
            .input_tx
            .send(PendingInput::acknowledged_logical(
                data,
                queued_ack,
                false,
                self.bracketed_paste_mode(),
            ))
            .is_err()
        {
            state.logical_inputs.pop_back();
            return Err(InputQueueError::Closed);
        }
        if let Some(logical_input) = state.logical_inputs.back_mut() {
            logical_input.dispatched = true;
        }
        Ok(LogicalInputAccepted {
            written,
            held_by_raw_draft: false,
        })
    }

    /// Whether this session currently refuses logical input because the draft
    /// state it inherited is unknown.
    ///
    /// Reported as blocked when the coordination lock is unusable: that is the
    /// state a caller would actually meet, and a "deliverable" answer that
    /// every delivery then contradicts is worse than a pessimistic one.
    pub fn logical_input_blocked(&self) -> bool {
        self.input_coordination
            .lock()
            .map(|state| !state.raw_input_draft_state_known)
            .unwrap_or(true)
    }

    pub fn pending_logical_input_count(&self) -> usize {
        self.input_coordination
            .lock()
            .map(|state| state.logical_inputs.len())
            .unwrap_or(0)
    }

    /// Whether a logical message would be withheld from the PTY right now:
    /// either this daemon never saw whether a draft is at the prompt, or a
    /// producer declared one and has not declared a boundary since.
    fn logical_input_withheld(&self) -> bool {
        self.input_coordination
            .lock()
            .map(|state| !state.raw_input_draft_state_known || state.draft_holds_input())
            .unwrap_or(true)
    }

    /// Record that one producer-declared draft write finished reaching the
    /// PTY, and how much output had been mirrored at that moment.
    ///
    /// Called by the writer, which is the only place that knows a declared
    /// byte actually left the queue. Until this catches up with what was
    /// enqueued, no rendered frame can be evidence about that draft.
    pub fn complete_declared_draft_write(&self) -> Result<(), InputQueueError> {
        let mirrored_chunks = self.mirrored_chunks.load(Ordering::SeqCst);
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        state.declared_draft_writes_completed += 1;
        state.mirrored_chunks_at_last_draft_write = mirrored_chunks;
        Ok(())
    }

    /// Resolve draft state from the terminal itself.
    ///
    /// Two things withhold a logical message, and one piece of evidence
    /// answers both. A daemon that never watched a terminal being typed into
    /// cannot know whether a half-typed line is sitting at its prompt; and a
    /// producer that declared a draft cannot un-declare one, so a keystroke
    /// that put content there — a typed character, a history recall — holds
    /// every later message until a human presses Enter, even once they have
    /// deleted or abandoned what they wrote. Concatenating onto a real unsent
    /// line would submit a sentence nobody wrote, but a frame that positively
    /// renders the provider's own empty composer proves there is no such line:
    /// an empty composer holds no draft, so there is nothing to concatenate
    /// onto and nothing to protect. (Keystrokes that could never put content
    /// there declare no draft in the first place — see
    /// [`crate::draft_bytes`].)
    ///
    /// A frame that renders only the provider's own dim suggestion proves the
    /// same thing and is accepted the same way. It has to be: Claude Code
    /// paints the last submitted line back as a faint tab-to-accept ghost, so
    /// a session that ever armed its ledger would otherwise never see a
    /// textually empty composer again and would hold every later delivery for
    /// the life of the session. That is the 2026-09-07 owner report — a
    /// composer attested `typed` whose text the owner could see was grey — and
    /// the ledger stays primary: the frame only ever clears it, never arms
    /// it. See [`ComposerState::SuggestionOnly`] for what has to be true at
    /// once before a frame is allowed to say that.
    ///
    /// **The frame must be newer than the draft.** A rendered frame is
    /// evidence about the moment it was rendered, and a declared byte that is
    /// still queued in the writer — or written but not yet echoed by the
    /// provider — leaves a composer that renders empty because the draft has
    /// not landed on it yet. Clearing on that frame would write the queued
    /// message and its Enter behind the human's first typed character, which
    /// is the concatenated submission this guard exists to prevent. So an
    /// *active* declared draft is cleared only when every declared write has
    /// completed and at least one output chunk has been mirrored since the
    /// last one did. The *inherited-unknown* state carries no such write to
    /// wait for and is unchanged: nothing here declared a draft, so the
    /// current frame is the only evidence there is.
    ///
    /// Nothing is written to the PTY, nothing on screen is discarded, and the
    /// transition stays one-way — towards "no draft is here", never towards
    /// "a draft is present", and never into a submission this daemon inferred
    /// from bytes. Anything the frame does not prove empty stays withheld for
    /// a human. Returns whether this call resolved it.
    pub async fn attest_empty_composer(
        &self,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if !self.logical_input_withheld() {
            return Ok(false);
        }
        // Sampled before the frame is read, so the frame is at least this new.
        // A draft that lands between this and the read only raises the
        // enqueued count, which the check below then refuses on.
        let mirrored_chunks_before_read = self.mirrored_chunks.load(Ordering::SeqCst);
        let composer = {
            let mut state = self.state.lock().await;
            let SessionRuntimeState {
                headless_terminal,
                classifier,
                ..
            } = &mut *state;
            headless_terminal.composer_state(classifier)?
        };
        if !composer.proves_nothing_typed() {
            return Ok(false);
        }
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| "terminal input coordination lock was poisoned")?;
        if state.raw_input_draft_state_known {
            if !state.raw_input_draft_active {
                return Ok(false);
            }
            let every_declared_write_landed =
                state.declared_draft_writes_completed == state.declared_draft_writes_enqueued;
            let frame_post_dates_the_draft =
                mirrored_chunks_before_read > state.mirrored_chunks_at_last_draft_write;
            if !every_declared_write_landed || !frame_post_dates_the_draft {
                return Ok(false);
            }
        }
        state.raw_input_draft_state_known = true;
        state.raw_input_draft_active = false;
        // The frame proved the composer holds nothing, so the ledger restarts
        // from proven-empty too: an inherited session earns its first
        // attestation here, and a counted draft that left no line stops
        // reading as typed.
        state.typed_draft_bytes = Some(0);
        dispatch_accepted_logical_inputs(&self.input_tx, &mut state, self.bracketed_paste_mode())
            .map_err(|error| format!("{error:?}"))?;
        Ok(true)
    }

    /// Whether a draft swap is worth attempting for this session right now.
    ///
    /// A cheap synchronous screen so the idle tick can skip the whole
    /// machinery — and the terminal read it needs — on every session that has
    /// nothing queued.
    pub fn draft_swap_may_help(&self) -> bool {
        self.input_coordination
            .lock()
            .map(|state| {
                state.draft_swap.is_none()
                    && state.raw_input_draft_state_known
                    && state.draft_holds_input()
                    && matches!(state.typed_draft_bytes, Some(count) if count > 0)
                    && state.logical_inputs.iter().any(|input| !input.dispatched)
            })
            .unwrap_or(false)
    }

    /// Deliver a held logical message over a genuinely typed draft by lifting
    /// the draft off the composer and putting it back.
    ///
    /// Holding was the only safe answer while the daemon could not tell a
    /// human's unsent line from the CLI's own suggestion, and it is still the
    /// right answer for a composer this daemon cannot read. But when the frame
    /// *does* read as a plain composer with a typed line on it, "queued behind
    /// a human" is a message that may sit for hours for no reason: the draft
    /// can be captured, taken off, and put back.
    ///
    /// Every step is verified against the terminal, and the operation aborts
    /// rather than guess:
    ///
    /// - The composer must be a plain, idle, measured one, with the line's
    ///   cursor after everything rendered — so the captured bytes really are
    ///   the whole draft, and the provider's one-keystroke clear really clears
    ///   all of it.
    /// - The draft must not be the provider's own faint suggestion; that case
    ///   is not a draft at all and [`Self::attest_empty_composer`] resolves it
    ///   without writing anything.
    /// - After the clear, the composer must render empty (or as the provider's
    ///   own suggestion). A composer still holding the captured draft means
    ///   the clear did nothing, and the swap abandons without writing the
    ///   draft again — writing it twice is the corruption this exists to
    ///   avoid. Anything else is unrecognised, and is abandoned the same way.
    /// - The draft is written back only once the delivery is proven submitted.
    ///   An unproven submission leaves the message text parked at the composer;
    ///   restoring on top of that would concatenate the human's line onto a
    ///   sentence nobody wrote, so the draft is logged verbatim instead.
    ///
    /// The restored draft goes back through the ordinary declared-draft path,
    /// so the ledger counts it exactly as it counted the original and the
    /// composer attests `typed` again on the other side. Human keystrokes that
    /// arrive mid-swap are buffered and replayed onto the restored draft in
    /// order.
    pub async fn swap_draft_and_deliver(
        &self,
    ) -> Result<DraftSwapOutcome, Box<dyn std::error::Error + Send + Sync>> {
        if !self.draft_swap_may_help() {
            return Ok(DraftSwapOutcome::NotAttempted);
        }
        let Some(clear_sequence) = composer_clear_sequence(self.agent_provider().await) else {
            return Ok(DraftSwapOutcome::NotAttempted);
        };
        // Sampled before the frame is read, exactly as attestation samples it:
        // a declared byte still in flight leaves a frame that says nothing
        // about the draft it has not landed on yet.
        let mirrored_before_read = self.mirrored_chunks();
        let Some(draft) = self.capture_swappable_draft().await? else {
            return Ok(DraftSwapOutcome::NotAttempted);
        };

        // Claim the swap and take over the last queued message's
        // acknowledgement, so this call learns what became of the delivery
        // without the caller hearing "written" before the draft is back.
        let (settled_tx, settled) = oneshot::channel();
        let (intercepted_id, caller_ack) = {
            let mut state = self
                .input_coordination
                .lock()
                .map_err(|_| "terminal input coordination lock was poisoned")?;
            if state.draft_swap.is_some()
                || !state.raw_input_draft_state_known
                || !state.draft_holds_input()
                || state.declared_draft_writes_completed != state.declared_draft_writes_enqueued
                || mirrored_before_read <= state.mirrored_chunks_at_last_draft_write
            {
                return Ok(DraftSwapOutcome::NotAttempted);
            }
            let Some(last) = state
                .logical_inputs
                .iter_mut()
                .rev()
                .find(|input| !input.dispatched)
            else {
                return Ok(DraftSwapOutcome::NotAttempted);
            };
            let intercepted_id = last.id;
            let caller_ack = last.written.replace(settled_tx);
            state.draft_swap = Some(DraftSwap {
                buffered: Vec::new(),
            });
            (intercepted_id, caller_ack)
        };

        let outcome = self
            .run_draft_swap(clear_sequence, &draft, settled)
            .await
            .unwrap_or_else(|error| {
                log::error!(
                    "[input] draft swap failed mid-operation; the composer draft was \
                     {draft:?} and nothing was written back: {error}"
                );
                DraftSwapOutcome::Aborted
            });

        if outcome == DraftSwapOutcome::Aborted {
            // Nothing was submitted, so the message keeps its own
            // acknowledgement and stays queued behind the draft.
            if let Ok(mut state) = self.input_coordination.lock() {
                if let Some(input) = state
                    .logical_inputs
                    .iter_mut()
                    .find(|input| input.id == intercepted_id)
                {
                    input.written = caller_ack;
                }
            }
        } else if let Some(caller_ack) = caller_ack {
            // The delivery's own verdict, not the swap's: a draft that could
            // not be put back is a lost draft, not an unsubmitted message, and
            // telling the caller its text is parked at that composer would be
            // false.
            let _ = caller_ack.send(match outcome {
                DraftSwapOutcome::DeliveredUnproven => WriteOutcome::SubmissionUnproven,
                _ => WriteOutcome::Written,
            });
        }
        self.finish_draft_swap()
            .map_err(|error| format!("{error:?}"))?;
        Ok(outcome)
    }

    /// Clear, deliver, restore. Split out so that every exit — including an
    /// error — runs the buffer replay in [`Self::swap_draft_and_deliver`].
    async fn run_draft_swap(
        &self,
        clear_sequence: &'static [u8],
        draft: &str,
        settled: oneshot::Receiver<WriteOutcome>,
    ) -> Result<DraftSwapOutcome, Box<dyn std::error::Error + Send + Sync>> {
        let mirrored_before_clear = self.mirrored_chunks();
        if self
            .swap_write(clear_sequence.to_vec(), RawInputKind::Control)
            .await?
            != WriteOutcome::Written
        {
            return Ok(DraftSwapOutcome::Aborted);
        }
        if !self
            .cleared_composer_confirmed(mirrored_before_clear, draft)
            .await?
        {
            return Ok(DraftSwapOutcome::Aborted);
        }

        {
            let mut state = self
                .input_coordination
                .lock()
                .map_err(|_| "terminal input coordination lock was poisoned")?;
            // The composer was proven clear by the frame above, so the ledger
            // restarts from proven-empty for the length of the delivery.
            state.raw_input_draft_active = false;
            state.typed_draft_bytes = Some(0);
            dispatch_accepted_logical_inputs(
                &self.input_tx,
                &mut state,
                self.bracketed_paste_mode(),
            )
            .map_err(|error| format!("{error:?}"))?;
        }

        match settled.await {
            Ok(WriteOutcome::Written) => {}
            Ok(outcome) => {
                log::error!(
                    "[input] a delivery over a lifted draft ended {outcome:?}, so the \
                     composer holds text this daemon did not put there and the draft was \
                     not written back on top of it. The captured draft was {draft:?}"
                );
                return Ok(DraftSwapOutcome::DeliveredUnproven);
            }
            Err(_) => {
                log::error!(
                    "[input] the writer ended during a delivery over a lifted draft; the \
                     captured draft was {draft:?} and was not written back"
                );
                return Ok(DraftSwapOutcome::DeliveredUnproven);
            }
        }

        // Back through the ordinary declared-draft path: the ledger counts
        // these bytes exactly as it counted them when they were typed, so the
        // composer attests `typed` again and the next delivery meets the same
        // draft it would have met had nothing happened.
        if self
            .swap_write(draft.as_bytes().to_vec(), RawInputKind::Draft)
            .await?
            != WriteOutcome::Written
        {
            log::error!(
                "[input] the restore write of a lifted draft did not reach the PTY; the \
                 message was submitted and the captured draft was {draft:?}"
            );
            return Ok(DraftSwapOutcome::DeliveredWithoutRestore);
        }
        Ok(DraftSwapOutcome::Restored)
    }

    /// The draft a swap may lift off this frame's composer, or `None` when the
    /// frame is not one a swap may touch.
    async fn capture_swappable_draft(
        &self,
    ) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
        let mut state = self.state.lock().await;
        let SessionRuntimeState {
            headless_terminal,
            classifier,
            ..
        } = &mut *state;
        let Some(row) = headless_terminal.plain_composer_row(classifier)? else {
            return Ok(None);
        };
        // A faint line is the provider's own suggestion, not a draft; nothing
        // may be lifted off it and nothing needs to be.
        if row.all_faint || !row.cursor_at_end {
            return Ok(None);
        }
        let Some(draft) = row.before_cursor else {
            return Ok(None);
        };
        // Trailing blanks are indistinguishable from the blank remainder of the
        // row, so a draft that ends in whitespace cannot be captured whole and
        // is left alone. Everything that *is* captured is byte-exact.
        if draft.is_empty() || draft != row.text {
            return Ok(None);
        }
        Ok(Some(draft))
    }

    /// Whether the frame after the clear proves the composer is no longer
    /// holding the captured draft.
    async fn cleared_composer_confirmed(
        &self,
        mirrored_before_clear: u64,
        draft: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if !self
            .wait_for_repaint(mirrored_before_clear, composer_swap_step_timeout())
            .await
        {
            log::warn!(
                "[input] a composer did not repaint after a draft-swap clear, so nothing \
                 can say what is on it; the message stays queued"
            );
            return Ok(false);
        }
        let composer = {
            let mut state = self.state.lock().await;
            let SessionRuntimeState {
                headless_terminal,
                classifier,
                ..
            } = &mut *state;
            headless_terminal.composer_state(classifier)?
        };
        if composer.proves_nothing_typed() {
            return Ok(true);
        }
        let still_drafted = {
            let mut state = self.state.lock().await;
            let SessionRuntimeState {
                headless_terminal,
                classifier,
                ..
            } = &mut *state;
            headless_terminal
                .plain_composer_row(classifier)?
                .is_some_and(|row| row.text == draft)
        };
        if still_drafted {
            log::warn!(
                "[input] a draft-swap clear left the composer unchanged, so this provider \
                 does not clear the way it was measured to; the message stays queued and \
                 the draft is untouched"
            );
        } else {
            log::error!(
                "[input] a draft-swap clear left a composer this daemon cannot read, so \
                 the draft was not written back. The captured draft was {draft:?}"
            );
        }
        Ok(false)
    }

    /// One swap-owned write, bypassing the buffer the swap installed.
    async fn swap_write(
        &self,
        data: Vec<u8>,
        kind: RawInputKind,
    ) -> Result<WriteOutcome, Box<dyn std::error::Error + Send + Sync>> {
        let (written_tx, written) = oneshot::channel();
        {
            let mut state = self
                .input_coordination
                .lock()
                .map_err(|_| "terminal input coordination lock was poisoned")?;
            self.route_raw_input(&mut state, data, kind, Some(written_tx))
                .map_err(|error| format!("{error:?}"))?;
        }
        match tokio::time::timeout(composer_swap_step_timeout(), written).await {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(_)) => Ok(WriteOutcome::NotWritten),
            Err(_) => Ok(WriteOutcome::NotWritten),
        }
    }

    /// Wait until the provider has drawn at least one chunk since `since`.
    async fn wait_for_repaint(&self, since: u64, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.mirrored.notified();
            if self.mirrored_chunks() > since {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.mirrored_chunks() > since;
            }
        }
    }

    /// End the swap and replay everything a human typed while it ran.
    fn finish_draft_swap(&self) -> Result<(), InputQueueError> {
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        let Some(swap) = state.draft_swap.take() else {
            return Ok(());
        };
        for buffered in swap.buffered {
            self.route_raw_input(&mut state, buffered.data, buffered.kind, buffered.written)?;
        }
        Ok(())
    }

    /// The blocked-state change this session has not published yet, if any.
    ///
    /// Polled by the session's own status loop, which is the one task that
    /// runs for every session whether or not anything is attached to it.
    pub fn take_input_blocked_transition(&self) -> Result<Option<bool>, InputQueueError> {
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        let blocked = !state.raw_input_draft_state_known;
        if blocked == state.published_input_blocked {
            return Ok(None);
        }
        state.published_input_blocked = blocked;
        Ok(Some(blocked))
    }

    pub fn complete_logical_input(&self) -> Result<(), InputQueueError> {
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        state.logical_inputs.pop_front();
        Ok(())
    }

    /// Output chunks mirrored into this session's headless terminal so far.
    ///
    /// The writer reads it to tell a CLI that is still repainting an input
    /// burst from one that has finished with it. A frame is not needed for
    /// that question — only whether anything was drawn at all — so this stays
    /// a lock-free counter rather than a terminal read.
    pub fn mirrored_chunks(&self) -> u64 {
        self.mirrored_chunks.load(Ordering::SeqCst)
    }

    /// Record that a logical message's text reached the PTY but its submission
    /// could not be proven, so no Enter was written and the text is parked at
    /// the composer.
    ///
    /// The daemon put a line at that composer and cannot prove it left, so it
    /// no longer knows what is sitting there: attestation drops to `unknown`,
    /// which is exactly the state an inherited composer is in and holds every
    /// later logical message the same way. It is deliberately not `not-typed`
    /// — that asserts the composer is clear and would let the next delivery
    /// append to text still sitting on it — and deliberately not `typed`,
    /// because nobody typed it. It clears through the existing paths: a
    /// producer-declared submission boundary, or a frame that renders the
    /// provider's own empty composer.
    pub fn park_unproven_logical_input(&self) -> Result<(), InputQueueError> {
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        state.logical_inputs.pop_front();
        state.raw_input_draft_state_known = false;
        state.typed_draft_bytes = None;
        Ok(())
    }

    pub fn bracketed_paste_mode(&self) -> bool {
        self.bracketed_paste_mode.load(Ordering::SeqCst)
    }

    /// Legacy-v2 handoff payloads cannot preserve terminal draft coordination.
    /// A v2 adopter may ignore the newer wire fields while still acknowledging
    /// adoption, so the current daemon must retain ownership until inherited
    /// draft state is known, the raw draft is inactive, and the accepted
    /// logical-input queue is empty.
    pub fn input_coordination_requires_v3(&self) -> Result<bool, InputQueueError> {
        let state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        Ok(!state.raw_input_draft_state_known
            || state.draft_holds_input()
            || !state.logical_inputs.is_empty())
    }

    pub async fn try_clone_io_fd(&self) -> std::io::Result<std::os::fd::OwnedFd> {
        self.pty.lock().await.try_clone_io_fd()
    }

    pub async fn take_input_rx(&self) -> Option<mpsc::UnboundedReceiver<PendingInput>> {
        self.input_rx.lock().await.take()
    }

    pub async fn set_stream_control(&self, stream_control: StreamControl) {
        self.state.lock().await.stream_control = Some(stream_control);
    }

    pub async fn operator_input_only(&self) -> bool {
        self.state.lock().await.operator_input_only
    }

    pub async fn classify_input(&self, operator_input_only: bool) {
        let mut state = self.state.lock().await;
        state.operator_input_only = operator_input_only;
        state.input_policy_classified = true;
    }

    pub async fn stream_control(&self) -> Option<StreamControl> {
        self.state.lock().await.stream_control.clone()
    }

    pub async fn owns_stream_control(&self, stream_control: &StreamControl) -> bool {
        self.state
            .lock()
            .await
            .stream_control
            .as_ref()
            .is_some_and(|current| current.is_same_instance(stream_control))
    }

    pub async fn mirror_output(
        &self,
        data: &[u8],
        allow_terminal_replies: bool,
    ) -> Result<MirrorResult, Box<dyn std::error::Error + Send + Sync>> {
        self.mirror_output_at(
            data,
            allow_terminal_replies,
            Instant::now(),
            status_detection_throttle(),
        )
        .await
    }

    async fn mirror_output_at(
        &self,
        data: &[u8],
        allow_terminal_replies: bool,
        now: Instant,
        throttle: Duration,
    ) -> Result<MirrorResult, Box<dyn std::error::Error + Send + Sync>> {
        let mut state = self.state.lock().await;
        state.headless_terminal.write(data);
        state.last_output_at = Some(now);
        self.bracketed_paste_mode.store(
            state.headless_terminal.bracketed_paste_mode(),
            Ordering::SeqCst,
        );
        // Counted before the frame is read back, so a reader that samples this
        // first and then reads the terminal knows its frame includes at least
        // that many chunks.
        self.mirrored_chunks.fetch_add(1, Ordering::SeqCst);
        self.mirrored.notify_waiters();
        let replies = if allow_terminal_replies {
            state.headless_terminal.drain_pty_writes()
        } else {
            state.headless_terminal.drain_pty_writes();
            Vec::new()
        };
        let allow_idle = allows_output_triggered_idle(state.agent_provider);
        let status = detect_runtime_status_if_due(&mut state, now, throttle, allow_idle)?;
        Ok(MirrorResult { status, replies })
    }

    pub async fn refresh_quiet_status(
        &self,
        quiet_for: Duration,
    ) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
        self.refresh_quiet_status_at(quiet_for, Instant::now())
            .await
    }

    async fn refresh_quiet_status_at(
        &self,
        quiet_for: Duration,
        now: Instant,
    ) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
        let mut state = self.state.lock().await;
        if state
            .last_output_at
            .is_some_and(|last_output_at| now.saturating_duration_since(last_output_at) < quiet_for)
        {
            return Ok(None);
        }

        // This periodic settled-state read is the convergence boundary. TUI
        // chrome can produce output indefinitely, so output-triggered checks
        // must not be able to starve it by continually consuming the shared
        // throttle slot. Synchronized partial frames are still rejected by
        // the classifier itself.
        detect_runtime_status_if_due(&mut state, now, Duration::ZERO, true)
    }

    pub async fn debug_status_observation(
        &self,
    ) -> Result<StatusObservation, Box<dyn std::error::Error + Send + Sync>> {
        let mut state = self.state.lock().await;
        let agent_provider = state.agent_provider;
        let cli_version = state.classifier.version().map(ToString::to_string);
        let verdict = {
            let SessionRuntimeState {
                headless_terminal,
                classifier,
                ..
            } = &mut *state;
            headless_terminal.visible_verdict(classifier)?
        };
        Ok(StatusObservation {
            provider: agent_provider,
            cli_version,
            detected_status: verdict.as_ref().map(|verdict| verdict.status),
            matched_rule: verdict.map(|verdict| verdict.rule_id),
            lines: state.headless_terminal.debug_lines(8)?,
        })
    }

    pub async fn codex_resume_session_id(
        &self,
    ) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
        let mut state = self.state.lock().await;
        if state.agent_provider != Some(AgentProvider::Codex) {
            return Ok(None);
        }

        state.headless_terminal.codex_resume_session_id()
    }

    pub async fn update_status(&self, status: SessionStatus) -> bool {
        let mut state = self.state.lock().await;
        if state.status != status {
            state.status = status;
            true
        } else {
            false
        }
    }

    pub async fn waiting_prompt_snippet(
        &self,
    ) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
        let mut state = self.state.lock().await;
        let SessionRuntimeState {
            headless_terminal,
            classifier,
            ..
        } = &mut *state;
        headless_terminal.waiting_prompt_snippet(classifier)
    }

    pub async fn status(&self) -> SessionStatus {
        self.state.lock().await.status
    }

    pub async fn agent_provider(&self) -> Option<AgentProvider> {
        self.state.lock().await.agent_provider
    }

    /// Record what the CLI version probe answered.
    ///
    /// Arrives after the session is already classifying, and deliberately so:
    /// blocking a spawn on a subprocess would trade a detection improvement
    /// for a startup regression. Until it lands the session uses every rule
    /// measured for its provider.
    pub async fn set_cli_version(&self, version: Option<CliVersion>) {
        let mut state = self.state.lock().await;
        let provider = state.agent_provider;
        if state.classifier.set_version(version.clone()) {
            log::info!(
                "[detection] session provider={:?} is running CLI version {}",
                provider,
                version
                    .map(|version| version.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            );
        }
    }

    pub async fn snapshot(
        &self,
        session_id: &str,
    ) -> Result<crate::protocol::TerminalSnapshot, Box<dyn std::error::Error + Send + Sync>> {
        let lock_operation = terminal_perf::global_monitor().begin(TerminalPerfContext::new(
            "daemon",
            session_id,
            "snapshot_lock",
        ));
        let mut state = self.state.lock().await;
        lock_operation.finish();

        let serialize_operation = terminal_perf::global_monitor().begin(TerminalPerfContext::new(
            "daemon",
            session_id,
            "snapshot_serialize",
        ));
        let snapshot = state.headless_terminal.snapshot();
        serialize_operation.finish();
        snapshot
    }

    pub async fn rows_cols(&self) -> (u16, u16) {
        let pty = self.pty.lock().await;
        (pty.rows(), pty.cols())
    }

    pub async fn mark_active(&self) {
        self.pty.lock().await.last_active_at = Instant::now();
    }

    pub async fn resize(
        &self,
        cols: u16,
        rows: u16,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.pty.lock().await.resize(cols, rows)?;
        self.state
            .lock()
            .await
            .headless_terminal
            .resize(cols, rows)?;
        Ok(())
    }

    pub async fn signal(&self, sig: i32) -> std::io::Result<()> {
        self.pty.lock().await.signal(sig)
    }

    /// Claim teardown for this session. Returns true exactly once; later
    /// callers get false and must not enqueue another sweep.
    pub(crate) fn claim_teardown(&self) -> bool {
        self.teardown_claimed
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok()
    }

    pub async fn kill(&self) -> std::io::Result<()> {
        // Termination ownership is decided atomically under the PTY lock:
        // the kill strike and the one-shot reap token are taken in the same
        // critical section, so concurrent kills spawn exactly one reaper and
        // any later kill/signal on this session sees terminated ownership
        // instead of a pid that may have been recycled after the reap.
        // Single-flight: a repeated or concurrent Kill for this session must
        // not enqueue a second whole-table sweep. The first claimant owns
        // teardown; later callers observe the already-terminated session.
        if !self.claim_teardown() {
            return Ok(());
        }
        // Phase 1 under the lock: freeze the leader and consume the
        // one-shot reap token. No process-table scan or SIGKILL happens here.
        let (plan, reap) = {
            let mut pty = self.pty.lock().await;
            let plan = pty.begin_kill();
            (plan, pty.take_reap_token())
        };
        // Phase 2 off-lock, off the Tokio workers: the whole-process-table
        // sweep and every SIGKILL run on the bounded lifecycle executor.
        let result =
            kanna_daemon::reaper::run_teardown_and_wait::<std::io::Result<()>>(move || {
                plan.execute(None)
            })
            .await
            .unwrap_or_else(|| Err(std::io::Error::other("PTY teardown worker stopped")));
        // Only an owned, unreaped child may be waited on: waitpid on an
        // adopted or unproven pid would either fail or reap an unrelated
        // process-group child.
        if let Some((pid, start)) = reap {
            let ownership =
                kanna_daemon::reaper::ReapOwnership::Pid(kanna_daemon::reaper::ReapIdentity {
                    pid,
                    start,
                });
            if let Err(error) = kanna_daemon::reaper::try_reap(ownership) {
                kanna_daemon::reaper::reap(error.into_ownership()).await;
            }
        }
        result
    }

    pub async fn try_wait(&self) -> Option<i32> {
        self.pty.lock().await.try_wait()
    }

    pub async fn pty_master_attribution(&self, session_id: String) -> PtyMasterAttribution {
        let pty = self.pty.lock().await;
        PtyMasterAttribution {
            session_id,
            child_pid: pty.pid(),
            master_fd: pty.master_raw_fd(),
        }
    }

    pub async fn info(&self, session_id: String) -> SessionInfo {
        let mut pty = self.pty.lock().await;
        let state = match pty.try_wait() {
            Some(code) => SessionState::Exited(code),
            None => SessionState::Active,
        };
        let idle_seconds = pty.last_active_at.elapsed().as_secs();
        let pid = pty.pid();
        let cwd = pty.cwd.clone();
        drop(pty);
        let status = self.status().await;

        SessionInfo {
            session_id,
            pid,
            cwd,
            state,
            idle_seconds,
            status,
            kind: crate::protocol::SessionKind::Pty,
            logical_input_blocked: self.logical_input_blocked(),
            pending_logical_input_count: Some(self.pending_logical_input_count()),
            composer_text: self.composer_line().await,
            composer_attestation: self.composer_attestation(),
        }
    }

    /// What this daemon can prove about the text on this session's composer.
    ///
    /// A poisoned coordination lock answers `Unknown` for the same reason
    /// [`SessionHandle::logical_input_blocked`] answers "blocked": the
    /// pessimistic verdict is the one a caller can act on safely, and a
    /// confident answer that the delivery path then contradicts is worse.
    /// The ledger's own count, for tests that pin what a write contributed.
    #[cfg(test)]
    pub fn typed_draft_bytes_for_test(&self) -> Option<u64> {
        self.input_coordination
            .lock()
            .expect("terminal input coordination lock")
            .typed_draft_bytes
    }

    pub fn composer_attestation(&self) -> ComposerAttestation {
        self.input_coordination
            .lock()
            .map(|state| state.composer_attestation())
            .unwrap_or(ComposerAttestation::Unknown)
    }

    /// The text currently rendered on this session's composer line, when its
    /// frame draws a readable one.
    async fn composer_line(&self) -> Option<String> {
        let mut state = self.state.lock().await;
        let SessionRuntimeState {
            headless_terminal,
            classifier,
            ..
        } = &mut *state;
        match headless_terminal.composer_line(classifier) {
            Ok(text) => text,
            Err(error) => {
                log::warn!("[composer] failed to read composer line: {error}");
                None
            }
        }
    }

    /// The rendered composer verdict, for tests that pin the difference
    /// between what a frame can prove and what the ledger can.
    #[cfg(test)]
    pub(crate) async fn headless_composer_state_for_test(
        &self,
    ) -> Result<ComposerState, Box<dyn std::error::Error + Send + Sync>> {
        let mut state = self.state.lock().await;
        let SessionRuntimeState {
            headless_terminal,
            classifier,
            ..
        } = &mut *state;
        headless_terminal.composer_state(classifier)
    }

    /// The composer change this session has not published yet, if any.
    ///
    /// Edge-triggered like the blocked-input transition and polled from the
    /// same loop, because the composer moves on edges nothing else reports: a
    /// CLI suggestion appearing, a human starting to type, a submission
    /// boundary emptying the ledger.
    pub async fn take_composer_transition(&self) -> Option<(Option<String>, ComposerAttestation)> {
        let attestation = self.composer_attestation();
        let mut state = self.state.lock().await;
        let text = {
            let SessionRuntimeState {
                headless_terminal,
                classifier,
                ..
            } = &mut *state;
            headless_terminal.composer_line(classifier)
        };
        let text = match text {
            Ok(text) => text,
            Err(error) => {
                log::warn!("[composer] failed to read composer line: {error}");
                return None;
            }
        };
        // A frame with no readable composer has nothing to say about one, and
        // most sessions never draw one at all — a plain worktree shell has no
        // provider chrome to read. Reporting "still no composer" on every tick
        // would put a message on the wire for every session in the daemon
        // forever, so the transition is published only once a composer has
        // actually appeared, and once more when one that existed goes away.
        let had_composer = matches!(state.published_composer, Some((Some(_), _)));
        if text.is_none() && !had_composer {
            state.published_composer = Some((None, attestation));
            return None;
        }
        let current = (text, attestation);
        if state.published_composer.as_ref() == Some(&current) {
            return None;
        }
        state.published_composer = Some(current.clone());
        Some(current)
    }

    pub async fn handoff_parts(
        &self,
    ) -> Result<Option<SessionHandoffParts>, Box<dyn std::error::Error + Send + Sync>> {
        let pty = self.pty.lock().await;
        if !pty.is_alive() {
            return Ok(None);
        }
        let pid = pty.pid();
        let child_start = pty.child_identity();
        let cwd = pty.cwd.clone();
        let rows = pty.rows();
        let cols = pty.cols();
        let fd = pty.try_clone_handoff_fd()?;
        drop(pty);

        let mut state = self.state.lock().await;
        let snapshot = state.headless_terminal.snapshot().ok();
        let input_coordination = self
            .input_coordination
            .lock()
            .map_err(|_| "terminal input coordination lock was poisoned")?;
        Ok(Some(SessionHandoffParts {
            pid,
            child_start,
            cwd,
            rows,
            cols,
            snapshot,
            agent_provider: state.agent_provider,
            cli_version: state.classifier.version().cloned(),
            status: state.status,
            operator_input_only: state.operator_input_only,
            input_policy_classified: state.input_policy_classified,
            raw_input_draft_active: input_coordination.raw_input_draft_active,
            raw_input_draft_state_known: input_coordination.raw_input_draft_state_known,
            typed_draft_bytes: input_coordination.typed_draft_bytes,
            pending_logical_inputs: input_coordination
                .logical_inputs
                .iter()
                .map(|logical_input| logical_input.data.clone())
                .collect(),
            fd,
        }))
    }
}

pub struct SessionHandoffParts {
    pub pid: u32,
    /// Start-time identity of the child, so the adopting daemon can
    /// authenticate the pid against the live process table.
    pub child_start: Option<crate::proc_info::StartTime>,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub snapshot: Option<crate::protocol::TerminalSnapshot>,
    pub agent_provider: Option<AgentProvider>,
    pub cli_version: Option<CliVersion>,
    pub status: SessionStatus,
    pub operator_input_only: bool,
    pub input_policy_classified: bool,
    pub raw_input_draft_active: bool,
    pub raw_input_draft_state_known: bool,
    pub typed_draft_bytes: Option<u64>,
    pub pending_logical_inputs: Vec<Vec<u8>>,
    pub fd: std::os::fd::OwnedFd,
}

pub struct SessionManager {
    pub sessions: HashMap<String, Arc<SessionHandle>>,
    lifecycle_locks: HashMap<String, Weak<Mutex<()>>>,
    /// Ids whose outgoing incarnation is still being torn down. A same-id
    /// Spawn must not install while the old session's id-keyed state (fanout,
    /// terminal clients, sizes, recovery) is still being cleared, or that
    /// cleanup would clobber the replacement's state.
    teardown_tombstones: std::collections::HashSet<String>,
    /// Bumped on every handoff snapshot; adoption revalidates against it.
    handoff_epoch: u64,
    /// True between a handoff snapshot and its commit-or-abort. Published
    /// through a watch channel so a task that must not act while sealed can
    /// park until the transfer resolves, with no lost-wakeup race and no
    /// polling.
    sealed_for_handoff: tokio::sync::watch::Sender<bool>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

pub struct StatusObservation {
    pub provider: Option<AgentProvider>,
    /// The CLI release the rules were selected for, when a probe has answered.
    pub cli_version: Option<String>,
    pub detected_status: Option<SessionStatus>,
    /// Which rule produced `detected_status`. A frame that lands on the right
    /// status through the wrong rule means selection has drifted, and only the
    /// rule id can say so.
    pub matched_rule: Option<String>,
    pub lines: Vec<String>,
}

pub struct BenchmarkStatusState {
    pub status: SessionStatus,
    pub status_observed: bool,
    pub last_status_check_at: Option<Instant>,
}

impl BenchmarkStatusState {
    #[allow(dead_code)]
    pub fn new(status: SessionStatus) -> Self {
        Self {
            status,
            status_observed: false,
            last_status_check_at: None,
        }
    }
}

impl SessionManager {
    pub fn new() -> Self {
        SessionManager {
            sessions: HashMap::new(),
            lifecycle_locks: HashMap::new(),
            teardown_tombstones: std::collections::HashSet::new(),
            handoff_epoch: 0,
            sealed_for_handoff: tokio::sync::watch::Sender::new(false),
        }
    }

    /// Seal the manager for a handoff transfer and return the epoch the
    /// snapshot was taken at. While sealed, `insert` is refused: a PTY
    /// session spawned after the snapshot would be lost when this daemon
    /// exits (its master fd is never transferred), and a killed session must
    /// not be reinserted behind the transfer. The seal lifts if the handoff
    /// aborts and this daemon keeps serving.
    pub fn seal_for_handoff(&mut self) -> u64 {
        // `send_replace`, never `send`: `send` reports failure and skips the
        // update when no receiver exists, and receivers here are transient —
        // they only exist while a task is parked on the seal.
        self.sealed_for_handoff.send_replace(true);
        self.handoff_epoch += 1;
        self.handoff_epoch
    }

    pub fn unseal_for_handoff(&mut self) {
        // Wakes everyone parked in `seal_lifted` — the handoff aborted, so
        // this daemon keeps serving and owns its sessions again.
        self.sealed_for_handoff.send_replace(false);
    }

    pub fn is_sealed_for_handoff(&self) -> bool {
        *self.sealed_for_handoff.borrow()
    }

    /// How many tasks are currently parked waiting for the seal to lift.
    /// Test-only: lets a regression prove a task really reached the fence
    /// instead of sleeping and hoping.
    #[cfg(test)]
    pub fn seal_waiter_count(&self) -> usize {
        self.sealed_for_handoff.receiver_count()
    }

    /// Wait until no handoff transfer is in flight.
    ///
    /// Returns a future deliberately detached from the manager lock: callers
    /// take it while holding the lock and await it after releasing, and
    /// `watch` re-reads the current value on entry, so a seal that lifts in
    /// that gap resolves immediately instead of parking forever.
    ///
    /// A COMMITTED handoff never lifts the seal — this daemon exits instead —
    /// so a waiter on the commit path is dropped with the process, which is
    /// exactly the intent: the successor now owns that session.
    pub fn seal_lifted(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let mut rx = self.sealed_for_handoff.subscribe();
        async move {
            // An error means the manager is gone; the daemon is shutting down
            // and there is nothing left to reconcile.
            let _ = rx.wait_for(|sealed| !*sealed).await;
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn handoff_epoch(&self) -> u64 {
        self.handoff_epoch
    }

    /// Insert a session unless the manager is sealed for an in-flight
    /// handoff. Returns false when refused, so the caller can fail the Spawn
    /// loudly instead of silently stranding the child.
    #[must_use]
    pub fn insert_unless_sealed(
        &mut self,
        session_id: String,
        session: Arc<SessionHandle>,
    ) -> bool {
        if self.is_sealed_for_handoff() || self.teardown_tombstones.contains(&session_id) {
            return false;
        }
        if let Some(previous) = self.sessions.insert(session_id, session) {
            previous.retire();
        }
        true
    }

    /// Mark `session_id` as being torn down. Held until the outgoing
    /// incarnation's Exit is published and all of its id-keyed state is
    /// cleared, so a replacement can never install into a half-cleaned slot.
    /// Returns false if a teardown is already in flight for the id.
    #[must_use]
    pub fn begin_teardown(&mut self, session_id: &str) -> bool {
        self.teardown_tombstones.insert(session_id.to_string())
    }

    pub fn end_teardown(&mut self, session_id: &str) {
        self.teardown_tombstones.remove(session_id);
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_tearing_down(&self, session_id: &str) -> bool {
        self.teardown_tombstones.contains(session_id)
    }

    pub fn insert(&mut self, session_id: String, session: Arc<SessionHandle>) {
        if let Some(previous) = self.sessions.insert(session_id, session) {
            previous.retire();
        }
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<SessionHandle>> {
        self.sessions.get(session_id).cloned()
    }

    pub fn remove(&mut self, session_id: &str) -> Option<Arc<SessionHandle>> {
        let removed = self.sessions.remove(session_id);
        if let Some(session) = removed.as_ref() {
            session.retire();
        }
        removed
    }

    /// Remove `session_id` only if it still maps to `expected` — the exact
    /// incarnation the caller resolved. A same-id session installed in the
    /// meantime is left alone, so teardown of an old incarnation can never
    /// evict its replacement.
    pub fn remove_if_same(
        &mut self,
        session_id: &str,
        expected: &Arc<SessionHandle>,
    ) -> Option<Arc<SessionHandle>> {
        let matches = self
            .sessions
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, expected));
        if matches {
            let removed = self.sessions.remove(session_id);
            if let Some(session) = removed.as_ref() {
                session.retire();
            }
            removed
        } else {
            None
        }
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub fn handles(&self) -> Vec<(String, Arc<SessionHandle>)> {
        self.sessions
            .iter()
            .map(|(id, session)| (id.clone(), Arc::clone(session)))
            .collect()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_current(&self, session_id: &str, session: &Arc<SessionHandle>) -> bool {
        self.sessions
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
    }

    pub fn lifecycle_lock(&mut self, session_id: &str) -> Arc<Mutex<()>> {
        self.lifecycle_locks
            .retain(|_, lifecycle| lifecycle.strong_count() > 0);
        if let Some(lifecycle) = self.lifecycle_locks.get(session_id).and_then(Weak::upgrade) {
            return lifecycle;
        }

        let lifecycle = Arc::new(Mutex::new(()));
        self.lifecycle_locks
            .insert(session_id.to_string(), Arc::downgrade(&lifecycle));
        lifecycle
    }

    pub fn kill_all_handles(&mut self) -> Vec<(String, Arc<SessionHandle>)> {
        let handles = self.handles();
        for (_, session) in &handles {
            session.retire();
        }
        self.sessions.clear();
        handles
    }

    /// Kill every session with scan rounds batched across all of them (one
    /// process-table snapshot per round for the whole batch).
    ///
    /// Phase 1 (freeze + reap token) runs under each session's own lock; the
    /// sweep runs on the lifecycle executor.
    ///
    /// Ordering is load-bearing: every kill plan must COMPLETE before its
    /// reap token is handed to the reaper. Reaping first would let the child's
    /// pid be recycled while the plan still holds it as a signal target.
    pub async fn kill_all_with_shared_scan(&mut self) -> Vec<(String, Arc<SessionHandle>)> {
        let handles = self.kill_all_handles();
        let mut ids = Vec::with_capacity(handles.len());
        let mut plans = Vec::with_capacity(handles.len());
        let mut reap_pids = Vec::with_capacity(handles.len());
        for (id, handle) in &handles {
            if !handle.claim_teardown() {
                continue; // already being torn down (single-flight)
            }
            let (plan, pid) = {
                let mut pty = handle.pty.lock().await;
                let plan = pty.begin_kill();
                (plan, pty.take_reap_token())
            };
            ids.push(id.clone());
            plans.push(plan);
            reap_pids.push(pid);
        }
        if !plans.is_empty() {
            let batch_ids = ids.clone();
            let results = kanna_daemon::reaper::run_teardown_and_wait(move || {
                crate::pty::PtyKillPlan::execute_batch(plans)
            })
            .await;
            if let Some(results) = results {
                for (id, result) in batch_ids.iter().zip(results) {
                    if let Err(error) = result {
                        log::warn!("[kill-all] session {} teardown failed: {}", id, error);
                    }
                }
            }
            // Only now may the children be reaped.
            for (pid, start) in reap_pids.into_iter().flatten() {
                let ownership =
                    kanna_daemon::reaper::ReapOwnership::Pid(kanna_daemon::reaper::ReapIdentity {
                        pid,
                        start,
                    });
                if let Err(error) = kanna_daemon::reaper::try_reap(ownership) {
                    kanna_daemon::reaper::reap(error.into_ownership()).await;
                }
            }
        }
        handles
    }

    #[allow(dead_code)]
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;

    /// A live PTY session whose child exits on its own almost immediately,
    /// for tests that need to observe the natural-exit path.
    pub fn spawn_exiting_record(
        stream_control: &StreamControl,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>> {
        let pty = PtySession::spawn(
            "/bin/sh",
            &[String::from("-c"), String::from("exit 0")],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )?;
        Ok(SessionRecord {
            pty,
            headless_terminal: HeadlessTerminal::new(80, 24, 10_000)?,
            stream_control: Some(stream_control.clone()),
            agent_provider: None,
            cli_version: None,
            status: SessionStatus::Idle,
            status_observed: false,
            last_status_check_at: None,
            operator_input_only: false,
            input_policy_classified: true,
            raw_input_draft_active: false,
            raw_input_draft_state_known: true,
            typed_draft_bytes: Some(0),
            pending_logical_inputs: Vec::new(),
        })
    }

    /// A minimal live PTY session record for lifecycle tests.
    pub fn spawn_sleeper_record() -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>>
    {
        let pty = PtySession::spawn(
            "/bin/sh",
            &[String::from("-c"), String::from("sleep 30")],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )?;
        Ok(SessionRecord {
            pty,
            headless_terminal: HeadlessTerminal::new(80, 24, 10_000)?,
            stream_control: None,
            agent_provider: None,
            cli_version: None,
            status: SessionStatus::Idle,
            status_observed: false,
            last_status_check_at: None,
            operator_input_only: false,
            input_policy_classified: true,
            raw_input_draft_active: false,
            raw_input_draft_state_known: true,
            typed_draft_bytes: Some(0),
            pending_logical_inputs: Vec::new(),
        })
    }
}

/// Attribute every live PTY master to its session for exhaustion diagnostics.
pub async fn pty_occupancy_snapshot(sessions: &Arc<Mutex<SessionManager>>) -> PtyOccupancySnapshot {
    let handles = sessions.lock().await.handles();
    let mut attribution = Vec::with_capacity(handles.len());
    for (session_id, session) in handles {
        attribution.push(session.pty_master_attribution(session_id).await);
    }
    PtyOccupancySnapshot::new(attribution)
}

fn status_detection_throttle() -> Duration {
    Duration::from_millis(STATUS_DETECTION_THROTTLE_MS)
}

fn allows_output_triggered_idle(agent_provider: Option<AgentProvider>) -> bool {
    // Claude does not bracket its TUI repaints with DEC synchronized output,
    // so an intermediate chunk can briefly expose the parked composer while
    // the agent is still busy. Preserve every other provider's immediate idle
    // path; Claude must converge through the quiet refresh.
    agent_provider != Some(AgentProvider::Claude)
}

#[derive(Debug, Clone, Copy)]
struct StatusDetectionOptions {
    now: Instant,
    throttle: Duration,
    allow_idle: bool,
}

fn detect_headless_terminal_status_if_due(
    headless_terminal: &mut HeadlessTerminal,
    classifier: &mut Classifier,
    status: SessionStatus,
    status_observed: &mut bool,
    last_status_check_at: &mut Option<Instant>,
    options: StatusDetectionOptions,
) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
    // A synchronized TUI redraw is not observable provider state. In
    // particular, do not consume the throttle slot here: the chunk that ends
    // the frame must be eligible for classification immediately.
    if !headless_terminal.status_frame_complete() {
        return Ok(None);
    }

    if last_status_check_at.is_some_and(|last_check_at| {
        options.now.saturating_duration_since(last_check_at) < options.throttle
    }) {
        return Ok(None);
    }

    let visible_status = headless_terminal.visible_status(classifier)?;
    if let Some(next_status) = visible_status {
        // For a provider without atomic repaint frames, a partial redraw can
        // expose its parked composer between two busy frames. Positive
        // Busy/Waiting chrome is safe to publish from output, but Idle is only
        // trustworthy after the quiet refresh proves the repaint has settled.
        // Do not consume the throttle slot for a rejected partial frame: the
        // completed positive frame must remain eligible immediately.
        if next_status == SessionStatus::Idle && !options.allow_idle {
            return Ok(None);
        }
        *last_status_check_at = Some(options.now);
        *status_observed = true;
        return Ok(if status != next_status {
            Some(next_status)
        } else {
            None
        });
    }

    if !options.allow_idle {
        return Ok(None);
    }

    *last_status_check_at = Some(options.now);
    Ok(
        if *status_observed && matches!(status, SessionStatus::Busy | SessionStatus::Waiting) {
            Some(SessionStatus::Idle)
        } else {
            None
        },
    )
}

#[allow(dead_code)]
pub fn replay_headless_terminal_for_benchmark(
    headless_terminal: &mut HeadlessTerminal,
    classifier: &mut Classifier,
    state: &mut BenchmarkStatusState,
    benchmark_started_at: Instant,
    chunk_at_ms: u64,
    data: &[u8],
) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
    headless_terminal.write(data);
    headless_terminal.drain_pty_writes();

    let now = benchmark_started_at
        .checked_add(Duration::from_millis(chunk_at_ms))
        .unwrap_or(benchmark_started_at);

    detect_headless_terminal_status_if_due(
        headless_terminal,
        classifier,
        state.status,
        &mut state.status_observed,
        &mut state.last_status_check_at,
        StatusDetectionOptions {
            now,
            throttle: status_detection_throttle(),
            allow_idle: allows_output_triggered_idle(classifier.provider()),
        },
    )
}

fn detect_runtime_status_if_due(
    state: &mut SessionRuntimeState,
    now: Instant,
    throttle: Duration,
    allow_idle: bool,
) -> Result<Option<SessionStatus>, Box<dyn std::error::Error + Send + Sync>> {
    detect_headless_terminal_status_if_due(
        &mut state.headless_terminal,
        &mut state.classifier,
        state.status,
        &mut state.status_observed,
        &mut state.last_status_check_at,
        StatusDetectionOptions {
            now,
            throttle,
            allow_idle,
        },
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::{
        mpsc, replay_headless_terminal_for_benchmark, BenchmarkStatusState, ComposerAttestation,
        DraftSwapOutcome, LogicalInputAccepted, PendingInput, PtyMasterAttribution,
        PtyOccupancySnapshot, RawInputKind, SessionHandle, SessionManager, SessionRecord,
        StreamControl, WriteOutcome,
    };
    use crate::bench::transcript::{BenchmarkMode, BenchmarkProvider, TranscriptSpec};
    use crate::detection::Classifier;
    use crate::headless_terminal::{initial_session_status, ComposerState, HeadlessTerminal};
    use crate::protocol::{AgentProvider, SessionStatus};
    use crate::pty::PtySession;

    fn spawn_test_record(
        provider: AgentProvider,
        status: SessionStatus,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>> {
        let pty = PtySession::spawn(
            "/bin/sh",
            &[String::from("-c"), String::from("sleep 10")],
            "/tmp",
            &HashMap::new(),
            80,
            24,
        )?;

        Ok(SessionRecord {
            pty,
            headless_terminal: HeadlessTerminal::new(80, 24, 10_000)?,
            stream_control: None,
            agent_provider: Some(provider),
            cli_version: None,
            status,
            status_observed: false,
            last_status_check_at: None,
            operator_input_only: false,
            input_policy_classified: true,
            raw_input_draft_active: false,
            raw_input_draft_state_known: true,
            typed_draft_bytes: Some(0),
            pending_logical_inputs: Vec::new(),
        })
    }

    fn spawn_test_handle(
        provider: AgentProvider,
        status: SessionStatus,
    ) -> Result<Arc<SessionHandle>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Arc::new(SessionHandle::new(spawn_test_record(
            provider, status,
        )?)))
    }

    #[tokio::test]
    async fn kill_returns_and_releases_pty_lock_before_child_is_reaped() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();

        handle.kill().await.unwrap();

        // The pty mutex must be free as soon as kill returns; the old code
        // held it through a blocking reap of the child.
        assert!(handle.pty.try_lock().is_ok());
    }

    #[tokio::test]
    async fn acknowledged_input_completes_only_after_the_writer_accepts_it() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        let mut written = handle
            .enqueue_acknowledged_raw_input(b"merge request".to_vec(), RawInputKind::Draft)
            .expect("enqueue input");

        assert!(
            written.try_recv().is_err(),
            "enqueueing alone must not acknowledge the input"
        );
        let pending = input_rx.recv().await.expect("pending input");
        assert_eq!(pending.data, b"merge request");
        assert!(
            written.try_recv().is_err(),
            "dequeueing alone must not acknowledge the input"
        );

        pending.acknowledge_written();
        written.await.expect("PTY writer acknowledgement");
        handle.kill().await.unwrap();
    }

    /// The message bodies a raw submission released, without their
    /// acknowledgement channels — the channels are not comparable, and the
    /// order and content of the release is what these tests are about.
    fn released_logical_messages(boundary: &mut super::PendingInput) -> Vec<Vec<u8>> {
        boundary
            .take_logical_after_write()
            .into_iter()
            .map(|(data, _written, released_from_draft)| {
                assert!(released_from_draft);
                data
            })
            .collect()
    }

    #[tokio::test]
    async fn logical_input_waits_for_a_raw_draft_boundary_and_keeps_fifo_order() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"human draft".to_vec(), RawInputKind::Draft)
            .expect("enqueue raw draft");
        let draft = input_rx.recv().await.expect("raw draft input");
        assert_eq!(draft.kind, super::PendingInputKind::Raw);
        assert_eq!(draft.data, b"human draft");

        handle
            .enqueue_logical_input(b"manager one".to_vec())
            .expect("queue first logical input");
        handle
            .enqueue_logical_input(b"manager two".to_vec())
            .expect("queue second logical input");
        assert!(
            input_rx.try_recv().is_err(),
            "logical messages must stay out of the PTY writer while the draft is active"
        );

        handle
            .enqueue_raw_input(b"\r".to_vec(), RawInputKind::Submission)
            .expect("enqueue raw submission boundary");
        let mut boundary = input_rx.recv().await.expect("raw boundary");
        assert_eq!(boundary.kind, super::PendingInputKind::Raw);
        assert_eq!(boundary.data, b"\r");
        assert!(input_rx.try_recv().is_err());
        let mut released = boundary.take_logical_after_write().into_iter();
        let (first_data, _, first_released) = released.next().expect("first released message");
        let (second_data, _, second_released) = released.next().expect("second released message");
        let first =
            super::PendingInput::acknowledged_logical(first_data, None, first_released, false);
        let second =
            super::PendingInput::acknowledged_logical(second_data, None, second_released, false);
        assert_eq!(first.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(first.data, b"manager one");
        assert_eq!(second.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(second.data, b"manager two");

        handle
            .enqueue_raw_input(b"next draft".to_vec(), RawInputKind::Draft)
            .expect("enqueue next raw draft");
        let next_draft = input_rx.recv().await.expect("next raw draft");
        assert_eq!(next_draft.kind, super::PendingInputKind::Raw);
        assert_eq!(next_draft.data, b"next draft");

        handle
            .enqueue_logical_input(b"manager three".to_vec())
            .expect("queue behind the next draft");
        assert!(input_rx.try_recv().is_err());
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn embedded_newlines_in_bracketed_paste_are_not_submission_boundaries() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"human draft".to_vec(), RawInputKind::Draft)
            .expect("enqueue raw draft");
        let _draft = input_rx.recv().await.expect("raw draft input");
        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("queue logical input");

        let paste = b"\x1b[200~ continued\nsecond line\x1b[201~".to_vec();
        handle
            .enqueue_raw_input(paste.clone(), RawInputKind::Draft)
            .expect("enqueue multiline paste continuation");
        let continuation = input_rx.recv().await.expect("paste continuation");
        assert_eq!(continuation.kind, super::PendingInputKind::Raw);
        assert_eq!(continuation.data, paste);
        assert!(
            input_rx.try_recv().is_err(),
            "embedded paste newline must not release the logical message"
        );

        handle
            .enqueue_raw_input(b"\r".to_vec(), RawInputKind::Submission)
            .expect("enqueue producer-declared submission boundary");
        let mut boundary = input_rx.recv().await.expect("boundary");
        assert_eq!(boundary.data, b"\r");
        assert_eq!(
            released_logical_messages(&mut boundary),
            [b"manager message".to_vec()]
        );
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn terminal_control_does_not_create_or_clear_a_draft_or_strand_logical_input() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"human draft".to_vec(), RawInputKind::Draft)
            .expect("enqueue raw draft");
        assert_eq!(input_rx.recv().await.expect("draft").data, b"human draft");
        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("queue logical input");

        let mouse_report = b"\x1b[<65;1;1M".to_vec();
        handle
            .enqueue_raw_input(mouse_report.clone(), RawInputKind::Control)
            .expect("enqueue terminal control");
        assert_eq!(input_rx.recv().await.expect("control").data, mouse_report);
        assert!(
            input_rx.try_recv().is_err(),
            "control input must not clear the real human draft"
        );

        handle
            .enqueue_raw_input(b"\r".to_vec(), RawInputKind::Submission)
            .expect("enqueue submission boundary");
        let mut boundary = input_rx.recv().await.expect("boundary");
        assert_eq!(boundary.data, b"\r");
        assert_eq!(
            released_logical_messages(&mut boundary),
            [b"manager message".to_vec()]
        );
        handle.kill().await.unwrap();
    }

    /// The owner report of 2026-09-05, at the ledger.
    ///
    /// Opening a task's terminal on the desktop and pressing keys that leave
    /// nothing at the prompt used to arm the draft ledger, because the desktop
    /// declares every non-Enter keydown a draft. The phone was then told its
    /// message was "queued behind an unsent desktop terminal draft" while that
    /// composer was visibly empty. These bytes cannot put text anywhere, so
    /// they declare nothing and hold nothing.
    #[tokio::test]
    async fn keystrokes_that_cannot_type_declare_no_draft_and_hold_nothing() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        for keystroke in [
            b"\x1b[C".as_slice(),
            b"\x1b[D",
            b"\x1b[5~",
            b"\x1b[6~",
            b"\x1b[H",
            b"\x1b",
            b"\x1b[<64;24;5M",
            b"\x1b[I",
            b"\x7f",
            b"\x03",
            b"\x15",
        ] {
            handle
                .enqueue_raw_input(keystroke.to_vec(), RawInputKind::Draft)
                .expect("declare a draft for a keystroke that types nothing");
            let routed = input_rx.recv().await.expect("keystroke");
            assert_eq!(routed.data, keystroke);
            assert!(
                !routed.is_declared_draft(),
                "{keystroke:?} cannot put text at the composer, so it declares no draft"
            );
        }

        assert_eq!(handle.composer_attestation(), ComposerAttestation::NotTyped);

        let accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(
            !accepted.held_by_raw_draft,
            "nothing typed means nothing to append to"
        );
        let mut delivered = input_rx.recv().await.expect("the message goes out now");
        assert_eq!(delivered.data, b"owner reply");
        assert!(delivered.advance_logical_message_to_enter());
        delivered.acknowledge_written();
        accepted.written.await.expect("the message is acknowledged");
        handle.kill().await.unwrap();
    }

    /// Cursor up and down look like navigation and are not: they recall a
    /// previous line *into* the composer, which is exactly the unsent line a
    /// delivered message must never be appended to.
    #[tokio::test]
    async fn a_history_recall_key_still_declares_a_draft() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"\x1b[A".to_vec(), RawInputKind::Draft)
            .expect("declare a draft from cursor-up");
        assert!(input_rx
            .recv()
            .await
            .expect("cursor-up")
            .is_declared_draft());
        assert_eq!(handle.composer_attestation(), ComposerAttestation::Typed);

        let accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(
            accepted.held_by_raw_draft,
            "a recalled line is a line, and nothing may be appended to it"
        );
        assert!(input_rx.try_recv().is_err());
        handle.kill().await.unwrap();
    }

    /// The ledger measures what could reach the composer, not how many bytes a
    /// producer wrote: the navigation around a typed character changed no
    /// composer text and must not read as though it had.
    #[tokio::test]
    async fn the_ledger_counts_only_the_bytes_that_could_reach_the_composer() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"\x1b[Chi\x7f\x1b[D".to_vec(), RawInputKind::Draft)
            .expect("declare a mixed draft write");
        assert!(input_rx
            .recv()
            .await
            .expect("mixed write")
            .is_declared_draft());
        assert_eq!(handle.composer_attestation(), ComposerAttestation::Typed);
        assert_eq!(handle.typed_draft_bytes_for_test(), Some(2));

        let accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(accepted.held_by_raw_draft);
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn terminal_control_on_a_clear_composer_cannot_strand_the_next_logical_input() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        let mouse_report = b"\x1b[<65;1;1M".to_vec();
        handle
            .enqueue_raw_input(mouse_report.clone(), RawInputKind::Control)
            .expect("enqueue mobile terminal control");
        assert_eq!(input_rx.recv().await.expect("control").data, mouse_report);

        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("accept logical input after control");
        let logical = input_rx
            .try_recv()
            .expect("control input must not strand logical delivery behind a phantom draft");
        assert_eq!(logical.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(logical.data, b"manager message");
        handle.kill().await.unwrap();
    }

    /// A logical message is one delivery in two writes. Acknowledging the
    /// first would tell a caller its message was submitted while the text was
    /// still sitting unsent at the composer waiting for its Enter.
    #[tokio::test]
    async fn logical_input_is_acknowledged_only_after_its_terminating_enter() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        let mut accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(!accepted.held_by_raw_draft);
        assert!(
            accepted.written.try_recv().is_err(),
            "queueing alone must not report the message submitted"
        );

        let mut pending = input_rx.recv().await.expect("logical message");
        assert_eq!(pending.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(pending.data, b"owner reply");
        assert!(
            accepted.written.try_recv().is_err(),
            "reaching the writer must not report the message submitted"
        );

        assert!(pending.advance_logical_message_to_enter());
        assert_eq!(pending.kind, super::PendingInputKind::LogicalEnter);
        assert!(
            accepted.written.try_recv().is_err(),
            "writing the text alone must not report the message submitted"
        );

        pending.acknowledge_written();
        accepted
            .written
            .await
            .expect("acknowledgement once the Enter is written");
        handle.kill().await.unwrap();
    }

    /// The production failure sent a multiline commit-post prompt to Claude
    /// as undelimited terminal bytes. The TUI consumed that stream as a
    /// partial paste and submitted only the final `sult:` suffix. A logical
    /// message with embedded newlines must instead carry the terminal's paste
    /// boundaries in the same write, with Enter remaining a later write.
    #[tokio::test]
    async fn multiline_logical_input_is_bracketed_before_its_terminating_enter() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        handle
            .mirror_output(b"\x1b[?2004h", false)
            .await
            .expect("terminal enables bracketed paste mode");
        assert!(handle.bracketed_paste_mode());

        let mut accepted = handle
            .enqueue_logical_input(
                b"commit instructions\n\nPrevious implementation result:".to_vec(),
            )
            .expect("accept multiline logical input");
        assert!(!accepted.held_by_raw_draft);

        let mut pending = input_rx.recv().await.expect("logical message");
        assert_eq!(pending.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(
            pending.data,
            b"\x1b[200~commit instructions\n\nPrevious implementation result:\x1b[201~"
        );
        assert!(
            accepted.written.try_recv().is_err(),
            "closing the paste still must not acknowledge submission"
        );

        assert!(pending.advance_logical_message_to_enter());
        assert_eq!(pending.kind, super::PendingInputKind::LogicalEnter);
        assert_eq!(pending.data, b"\r");
        pending.acknowledge_written();
        accepted
            .written
            .await
            .expect("acknowledgement once the discrete Enter is written");
        handle.kill().await.unwrap();
    }

    #[test]
    fn multiline_logical_input_does_not_send_unadvertised_terminal_controls() {
        let message = b"first line\nsecond line".to_vec();

        assert_eq!(
            super::frame_logical_message(message.clone(), false),
            message
        );
    }

    /// The fault the owner's 1,227-byte dictated message hit. A PTY master
    /// takes about a kilobyte per write, so a longer single-line message
    /// reaches the CLI as separate input events and an interactive TUI reads
    /// the first burst as a paste and the rest as typing — submitting only the
    /// tail. The paste markers travel in-band with the bytes, so however the
    /// queue splits them the CLI still sees one editor operation.
    #[tokio::test]
    async fn a_long_single_line_message_is_framed_as_one_paste() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        handle
            .mirror_output(b"\x1b[?2004h", false)
            .await
            .expect("terminal enables bracketed paste mode");

        let dictated = vec![b'a'; super::PASTE_FRAMING_MIN_LEN];
        handle
            .enqueue_logical_input(dictated.clone())
            .expect("accept a long single-line logical input");
        let pending = input_rx.recv().await.expect("logical message");

        assert_eq!(pending.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(pending.data.first(), Some(&0x1b));
        assert!(pending.data.starts_with(b"\x1b[200~"));
        assert!(pending.data.ends_with(b"\x1b[201~"));
        assert_eq!(
            &pending.data[6..pending.data.len() - 6],
            dictated.as_slice(),
            "framing must not alter a single byte of the message"
        );
        handle.kill().await.unwrap();
    }

    /// The carve-out the framing rule protects, restated as a bound: a message
    /// short enough to be a provider slash command is still short enough to
    /// reach the CLI in one write, so it needs no markers and keeps its
    /// provider-native typing semantics.
    #[test]
    fn a_message_short_enough_to_arrive_whole_is_not_framed() {
        let short = vec![b'x'; super::PASTE_FRAMING_MIN_LEN - 1];

        assert_eq!(super::frame_logical_message(short.clone(), true), short);
    }

    /// A terminal that never advertised bracketed paste cannot be protected
    /// in-band, and inventing markers for it would send control bytes to a
    /// program that renders them as literal composer text.
    #[test]
    fn a_long_message_is_not_framed_for_an_unadvertising_terminal() {
        let long = vec![b'x'; super::PASTE_FRAMING_MIN_LEN * 2];

        assert_eq!(super::frame_logical_message(long.clone(), false), long);
    }

    /// A message the daemon wrote but could not prove submitted is still on
    /// that composer. The daemon therefore stops claiming to know what is
    /// there: attestation drops to `unknown`, which holds every later message
    /// exactly as an inherited composer does, so nothing can be appended to
    /// the parked text. It is deliberately not `not-typed` — that asserts the
    /// composer is clear — and not `typed`, because nobody typed it.
    #[tokio::test]
    async fn a_parked_message_leaves_the_composer_unknown_and_refuses_the_next_one() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let _input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_logical_input(b"the owner's message".to_vec())
            .expect("accept the first logical input");
        assert_eq!(
            handle.composer_attestation(),
            crate::protocol::ComposerAttestation::NotTyped,
            "an attested session starts from proven-empty"
        );

        handle
            .park_unproven_logical_input()
            .expect("park the unproven message");

        assert_eq!(
            handle.composer_attestation(),
            crate::protocol::ComposerAttestation::Unknown
        );
        assert!(handle.logical_input_blocked());
        assert!(matches!(
            handle.enqueue_logical_input(b"a later message".to_vec()),
            Err(super::InputQueueError::InheritedDraftStateUnknown)
        ));
        handle.kill().await.unwrap();
    }

    /// The park is not permanent. It clears through the paths that already
    /// end an unknown composer: the human at that terminal submitting, or a
    /// frame that renders the provider's own empty composer.
    #[tokio::test]
    async fn a_human_submission_boundary_clears_a_parked_message() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let _input_rx = handle.take_input_rx().await.expect("input queue");
        handle
            .enqueue_logical_input(b"the owner's message".to_vec())
            .expect("accept the first logical input");
        handle
            .park_unproven_logical_input()
            .expect("park the unproven message");
        assert!(handle.logical_input_blocked());

        handle
            .enqueue_raw_input(b"\r".to_vec(), RawInputKind::Submission)
            .expect("the human presses Enter at that terminal");

        assert!(!handle.logical_input_blocked());
        assert_eq!(
            handle.composer_attestation(),
            crate::protocol::ComposerAttestation::NotTyped
        );
        assert!(handle
            .enqueue_logical_input(b"a later message".to_vec())
            .is_ok());
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn single_line_logical_input_keeps_typing_semantics() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        handle
            .mirror_output(b"\x1b[?2004h", false)
            .await
            .expect("terminal enables bracketed paste mode");

        handle
            .enqueue_logical_input(b"/quit".to_vec())
            .expect("accept single-line logical input");
        let pending = input_rx.recv().await.expect("logical message");

        assert_eq!(pending.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(pending.data, b"/quit");
        handle.kill().await.unwrap();
    }

    /// The delivery the owner report is about: a message the daemon parks
    /// behind someone's unsent line has not been submitted, and saying so is
    /// the whole difference between a visible wait and a silent one.
    #[tokio::test]
    async fn a_declared_draft_reports_the_message_as_held_rather_than_submitted() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"half typed".to_vec(), RawInputKind::Draft)
            .expect("declare a raw draft");
        assert_eq!(input_rx.recv().await.expect("draft").data, b"half typed");

        let accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(
            accepted.held_by_raw_draft,
            "a message parked behind a draft must not be reported as submitted"
        );
        assert!(
            input_rx.try_recv().is_err(),
            "nothing may reach the PTY writer while a draft is open"
        );
        handle.kill().await.unwrap();
    }

    /// A producer can declare a draft but cannot un-declare one, so a
    /// history-recall key that found nothing to recall — leaving no unsent
    /// line — held every later delivery until a human pressed Enter at that
    /// terminal. The composer's own rendered emptiness is the evidence that
    /// ends it, and it is the same evidence that already resolves an inherited
    /// unknown state.
    #[tokio::test]
    async fn a_declared_draft_over_a_provably_empty_composer_releases_the_held_message() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        // Cursor-up: a keydown the desktop producer declares a draft, and one
        // that counts, because it can recall a line into the composer. Here
        // there was nothing to recall, so it left nothing at the prompt.
        handle
            .enqueue_raw_input(b"\x1b[A".to_vec(), RawInputKind::Draft)
            .expect("declare a draft from a navigation key");
        let draft = input_rx.recv().await.expect("draft");
        assert_eq!(draft.data, b"\x1b[A");
        assert!(draft.is_declared_draft());

        let accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(accepted.held_by_raw_draft);
        assert!(input_rx.try_recv().is_err());

        // The writer lands the declared byte, and the provider then repaints.
        // Only a frame from after both is evidence about this draft.
        handle
            .complete_declared_draft_write()
            .expect("the declared draft reaches the PTY");
        handle
            .mirror_output(b"\x1b[2J\x1b[H* Done.\r\n\xe2\x9d\xaf \r\n", false)
            .await
            .expect("render an idle empty composer");

        assert!(handle
            .attest_empty_composer()
            .await
            .expect("attest the rendered composer"));

        let mut released = input_rx.recv().await.expect("released logical message");
        assert_eq!(released.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(released.data, b"owner reply");
        assert!(released.advance_logical_message_to_enter());
        released.acknowledge_written();
        accepted
            .written
            .await
            .expect("the released message keeps its own acknowledgement");
        handle.kill().await.unwrap();
    }

    /// A frame can only be evidence about a draft it post-dates. While the
    /// declared byte is still queued in the writer, the composer renders empty
    /// because the keystroke has not landed on it yet — attesting on that
    /// frame would write the queued message behind the human's first typed
    /// character, which is the concatenated submission the guard exists to
    /// prevent.
    #[tokio::test]
    async fn a_declared_draft_still_queued_for_the_pty_is_never_attested_away() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"h".to_vec(), RawInputKind::Draft)
            .expect("declare a raw draft");
        let accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(accepted.held_by_raw_draft);

        // The frame is from before the keystroke reached the terminal: the
        // writer has not completed that write.
        handle
            .mirror_output(b"\x1b[2J\x1b[H* Done.\r\n\xe2\x9d\xaf \r\n", false)
            .await
            .expect("render a composer that predates the draft");

        assert!(
            !handle
                .attest_empty_composer()
                .await
                .expect("attest the rendered composer"),
            "a frame older than the declared draft is not evidence about it"
        );
        assert_eq!(input_rx.recv().await.expect("draft").data, b"h");
        assert!(
            input_rx.try_recv().is_err(),
            "the message must stay held while the draft is unaccounted for"
        );
        handle.kill().await.unwrap();
    }

    /// An empty declared draft must not be counted as a write to wait for.
    ///
    /// The writer drops an empty raw input without ever completing it, so a
    /// counted one leaves the completed total permanently short: every later
    /// attestation refuses, and the session sits refusing logical input until
    /// a human presses Enter at that terminal — the exact wedge this change
    /// exists to end, made unrecoverable. Any producer can send one; nothing
    /// on the way in rejects an empty payload.
    #[tokio::test]
    async fn an_empty_declared_draft_does_not_wedge_the_attestation_interlock() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(Vec::new(), RawInputKind::Draft)
            .expect("declare an empty draft");
        handle
            .enqueue_raw_input(b"\x1b[A".to_vec(), RawInputKind::Draft)
            .expect("declare a draft from a navigation key");

        let accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(accepted.held_by_raw_draft);

        assert!(input_rx.recv().await.expect("empty draft").data.is_empty());
        assert_eq!(input_rx.recv().await.expect("draft").data, b"\x1b[A");

        // Only the non-empty draft reaches the writer's completion path; the
        // empty one was dropped and acknowledged before it.
        handle
            .complete_declared_draft_write()
            .expect("the written draft reaches the PTY");
        handle
            .mirror_output(b"\x1b[2J\x1b[H* Done.\r\n\xe2\x9d\xaf \r\n", false)
            .await
            .expect("render an idle empty composer");

        assert!(
            handle
                .attest_empty_composer()
                .await
                .expect("attest the rendered composer"),
            "an empty declared draft must not leave the interlock waiting forever"
        );
        let mut released = input_rx.recv().await.expect("released logical message");
        assert_eq!(released.data, b"owner reply");
        assert!(released.advance_logical_message_to_enter());
        released.acknowledge_written();
        accepted
            .written
            .await
            .expect("the released message keeps its own acknowledgement");
        handle.kill().await.unwrap();
    }

    /// The declared byte has landed, but nothing has been rendered since. The
    /// provider has not echoed it yet, so the last frame still shows the
    /// composer as it was before the keystroke.
    #[tokio::test]
    async fn a_declared_draft_with_no_frame_rendered_since_is_never_attested_away() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"h".to_vec(), RawInputKind::Draft)
            .expect("declare a raw draft");
        assert_eq!(input_rx.recv().await.expect("draft").data, b"h");
        let accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(accepted.held_by_raw_draft);

        handle
            .mirror_output(b"\x1b[2J\x1b[H* Done.\r\n\xe2\x9d\xaf \r\n", false)
            .await
            .expect("render an idle empty composer");
        // The write completes *after* that frame, so the frame says nothing
        // about what the keystroke did to the composer.
        handle
            .complete_declared_draft_write()
            .expect("the declared draft reaches the PTY");

        assert!(
            !handle
                .attest_empty_composer()
                .await
                .expect("attest the rendered composer"),
            "no output has been mirrored since the draft landed"
        );
        assert!(
            input_rx.try_recv().is_err(),
            "the message must stay held until the provider repaints"
        );

        // One repaint after the write is the evidence that was missing.
        handle
            .mirror_output(b"\x1b[2J\x1b[H* Done.\r\n\xe2\x9d\xaf \r\n", false)
            .await
            .expect("render the composer after the draft landed");
        assert!(handle
            .attest_empty_composer()
            .await
            .expect("attest the refreshed composer"));
        assert_eq!(
            input_rx.recv().await.expect("released message").data,
            b"owner reply"
        );
        handle.kill().await.unwrap();
    }

    /// Draft isolation is unchanged where it matters: a frame that does not
    /// prove the composer empty keeps protecting whatever is typed there, so
    /// no logical message is ever appended to a real unsent line.
    #[tokio::test]
    async fn a_composer_holding_text_keeps_holding_the_message() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"half typed".to_vec(), RawInputKind::Draft)
            .expect("declare a raw draft");
        assert_eq!(input_rx.recv().await.expect("draft").data, b"half typed");
        let accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(accepted.held_by_raw_draft);

        handle
            .mirror_output(
                b"\x1b[2J\x1b[H* Done.\r\n\xe2\x9d\xaf half typed\r\n",
                false,
            )
            .await
            .expect("render a composer holding an unsent line");

        assert!(
            !handle
                .attest_empty_composer()
                .await
                .expect("attest the rendered composer"),
            "a composer holding text is never attested empty"
        );
        assert!(
            input_rx.try_recv().is_err(),
            "the message must stay out of a real unsent line"
        );
        handle.kill().await.unwrap();
    }

    /// A Claude frame whose composer holds `draft`, with the cursor after it.
    fn claude_draft_frame(draft: &str) -> Vec<u8> {
        format!(
            "\x1b[2J\x1b[H* Done.\r\n\u{276f}\u{a0}{draft}\r\n\x1b[2;{}H",
            3 + draft.chars().count()
        )
        .into_bytes()
    }

    /// The same frame with the line painted faint and the cursor left at the
    /// start of the composer: the CLI's own tab-to-accept suggestion.
    fn claude_suggestion_frame(suggestion: &str) -> Vec<u8> {
        format!(
            "\x1b[2J\x1b[H* Done.\r\n\x1b[0m\u{276f}\u{a0}\x1b[2m{suggestion}\r\n\x1b[0m\x1b[2;3H"
        )
        .into_bytes()
    }

    /// Put a session in the state a swap is for: a human's typed line at the
    /// composer, counted and landed, and a message queued behind it.
    async fn session_holding_a_typed_draft(
        draft: &str,
    ) -> (
        Arc<SessionHandle>,
        mpsc::UnboundedReceiver<PendingInput>,
        LogicalInputAccepted,
    ) {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        handle
            .enqueue_raw_input(draft.as_bytes().to_vec(), RawInputKind::Draft)
            .expect("declare a raw draft");
        let typed = input_rx.recv().await.expect("draft");
        assert!(typed.is_declared_draft());
        handle
            .complete_declared_draft_write()
            .expect("the draft reaches the PTY");
        handle
            .mirror_output(&claude_draft_frame(draft), false)
            .await
            .expect("render the composer holding the draft");
        let accepted = handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("accept logical input");
        assert!(accepted.held_by_raw_draft);
        assert!(input_rx.try_recv().is_err());
        (handle, input_rx, accepted)
    }

    /// The owner's ask: instead of parking a message behind a human's unsent
    /// line for as long as it takes them to come back, copy the line, take it
    /// off, send the message, and put the line back.
    #[tokio::test]
    async fn a_typed_draft_is_lifted_off_delivered_over_and_put_back() {
        let (handle, mut input_rx, accepted) = session_holding_a_typed_draft("half typed").await;

        let swapping = Arc::clone(&handle);
        let swap = tokio::spawn(async move { swapping.swap_draft_and_deliver().await });

        // The provider's own one-keystroke clear, as control input: it is not
        // a human's draft and must not touch the ledger.
        let clear = input_rx.recv().await.expect("composer clear");
        assert_eq!(clear.data, b"\x15");
        assert!(!clear.is_declared_draft());
        clear.acknowledge_written();
        handle
            .mirror_output(&claude_draft_frame(""), false)
            .await
            .expect("render the cleared composer");

        let mut message = input_rx.recv().await.expect("the released message");
        assert_eq!(message.data, b"manager message");
        assert!(message.advance_logical_message_to_enter());
        message.acknowledge_written();

        let restored = input_rx.recv().await.expect("the restored draft");
        assert_eq!(
            restored.data, b"half typed",
            "the draft must go back byte for byte"
        );
        assert!(
            restored.is_declared_draft(),
            "the restored draft is a draft again, so the ledger counts it again"
        );
        restored.acknowledge_written();

        assert_eq!(
            swap.await.expect("swap task").expect("swap"),
            DraftSwapOutcome::Restored
        );
        assert_eq!(
            accepted.written.await.expect("acknowledgement"),
            WriteOutcome::Written,
            "the caller hears nothing until the draft is back"
        );
        assert_eq!(
            handle.typed_draft_bytes_for_test(),
            Some("half typed".len() as u64),
            "the restored draft is attested typed, exactly as it was"
        );
        handle.kill().await.unwrap();
    }

    /// Multibyte and interior spacing survive the round trip, because the
    /// draft is captured from the cells and written back verbatim.
    #[tokio::test]
    async fn a_multibyte_draft_survives_the_swap_byte_for_byte() {
        let draft = "héllo  wörld";
        let (handle, mut input_rx, _accepted) = session_holding_a_typed_draft(draft).await;

        let swapping = Arc::clone(&handle);
        let swap = tokio::spawn(async move { swapping.swap_draft_and_deliver().await });

        input_rx
            .recv()
            .await
            .expect("composer clear")
            .acknowledge_written();
        handle
            .mirror_output(&claude_draft_frame(""), false)
            .await
            .expect("render the cleared composer");
        let mut message = input_rx.recv().await.expect("the released message");
        assert!(message.advance_logical_message_to_enter());
        message.acknowledge_written();

        let restored = input_rx.recv().await.expect("the restored draft");
        assert_eq!(restored.data, draft.as_bytes());
        restored.acknowledge_written();
        assert_eq!(
            swap.await.expect("swap task").expect("swap"),
            DraftSwapOutcome::Restored
        );
        handle.kill().await.unwrap();
    }

    /// A human who keeps typing through a swap loses nothing: their keystrokes
    /// are held while the composer is not theirs, and replayed onto the
    /// restored draft in the order they were typed.
    #[tokio::test]
    async fn keystrokes_typed_during_a_swap_are_replayed_after_the_restore() {
        let (handle, mut input_rx, _accepted) = session_holding_a_typed_draft("half").await;

        let swapping = Arc::clone(&handle);
        let swap = tokio::spawn(async move { swapping.swap_draft_and_deliver().await });

        input_rx
            .recv()
            .await
            .expect("composer clear")
            .acknowledge_written();
        // Mid-swap typing, while the composer belongs to the delivery.
        handle
            .enqueue_raw_input(b" typ".to_vec(), RawInputKind::Draft)
            .expect("a keystroke mid-swap");
        handle
            .enqueue_raw_input(b"ed".to_vec(), RawInputKind::Draft)
            .expect("another keystroke mid-swap");
        assert!(
            input_rx.try_recv().is_err(),
            "nothing a human types may land on a composer mid-swap"
        );

        handle
            .mirror_output(&claude_draft_frame(""), false)
            .await
            .expect("render the cleared composer");
        let mut message = input_rx.recv().await.expect("the released message");
        assert!(message.advance_logical_message_to_enter());
        message.acknowledge_written();

        let restored = input_rx.recv().await.expect("the restored draft");
        assert_eq!(restored.data, b"half");
        restored.acknowledge_written();

        assert_eq!(
            input_rx
                .recv()
                .await
                .expect("first replayed keystroke")
                .data,
            b" typ"
        );
        assert_eq!(
            input_rx
                .recv()
                .await
                .expect("second replayed keystroke")
                .data,
            b"ed"
        );
        assert_eq!(
            swap.await.expect("swap task").expect("swap"),
            DraftSwapOutcome::Restored
        );
        assert_eq!(
            handle.typed_draft_bytes_for_test(),
            Some("half typed".len() as u64)
        );
        handle.kill().await.unwrap();
    }

    /// If the clear does not clear, the draft is still on the composer.
    /// Writing it back would double it, so the swap abandons: nothing is
    /// submitted, nothing is written, and the message stays queued.
    #[tokio::test]
    async fn a_clear_that_does_nothing_abandons_the_swap_and_writes_nothing_back() {
        let (handle, mut input_rx, accepted) = session_holding_a_typed_draft("half typed").await;

        let swapping = Arc::clone(&handle);
        let swap = tokio::spawn(async move { swapping.swap_draft_and_deliver().await });

        input_rx
            .recv()
            .await
            .expect("composer clear")
            .acknowledge_written();
        // The provider ignored it: the same draft is still rendered.
        handle
            .mirror_output(&claude_draft_frame("half typed"), false)
            .await
            .expect("render the unchanged composer");

        assert_eq!(
            swap.await.expect("swap task").expect("swap"),
            DraftSwapOutcome::Aborted
        );
        assert!(
            input_rx.try_recv().is_err(),
            "an abandoned swap writes nothing at all"
        );
        assert_eq!(
            handle.pending_logical_input_count(),
            1,
            "the message stays queued behind the draft"
        );
        assert_eq!(
            handle.typed_draft_bytes_for_test(),
            Some("half typed".len() as u64),
            "the ledger is exactly where it was"
        );
        drop(accepted);
        handle.kill().await.unwrap();
    }

    /// The provider's own faint suggestion is not a draft, so there is nothing
    /// to lift: attestation resolves that case without writing a byte, and a
    /// swap must never take a suggestion off the screen and type it back.
    #[tokio::test]
    async fn the_providers_own_faint_suggestion_is_never_swapped() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        handle
            .enqueue_raw_input(b"commit this".to_vec(), RawInputKind::Draft)
            .expect("declare a raw draft");
        input_rx.recv().await.expect("draft");
        handle
            .complete_declared_draft_write()
            .expect("the draft reaches the PTY");
        handle
            .mirror_output(&claude_suggestion_frame("commit this"), false)
            .await
            .expect("render the CLI's own suggestion");
        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("accept logical input");

        assert_eq!(
            handle.swap_draft_and_deliver().await.expect("swap"),
            DraftSwapOutcome::NotAttempted
        );
        assert!(input_rx.try_recv().is_err());

        // The frame proves nothing is typed, so the ordinary attestation path
        // releases the message with nothing written to the terminal.
        assert!(handle
            .attest_empty_composer()
            .await
            .expect("attest the rendered composer"));
        assert_eq!(
            input_rx.recv().await.expect("released message").data,
            b"manager message"
        );
        handle.kill().await.unwrap();
    }

    /// A composer this daemon cannot read is still a composer it will not
    /// touch. Codex draws one, but nothing here has measured what clears it.
    #[tokio::test]
    async fn an_unmeasured_provider_is_never_swapped() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        handle
            .enqueue_raw_input(b"half typed".to_vec(), RawInputKind::Draft)
            .expect("declare a raw draft");
        input_rx.recv().await.expect("draft");
        handle
            .complete_declared_draft_write()
            .expect("the draft reaches the PTY");
        handle
            .mirror_output(
                b"\x1b[2J\x1b[H* Done.\r\n\xe2\x80\xba half typed\r\n\x1b[2;13H",
                false,
            )
            .await
            .expect("render a Codex composer holding a draft");
        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("accept logical input");

        assert_eq!(
            handle.swap_draft_and_deliver().await.expect("swap"),
            DraftSwapOutcome::NotAttempted
        );
        assert!(input_rx.try_recv().is_err());
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn accepted_logical_input_remains_in_the_handoff_snapshot_until_written() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();

        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("accept logical input");
        let parts = handle
            .handoff_parts()
            .await
            .expect("snapshot session")
            .expect("live session");
        assert_eq!(parts.pending_logical_inputs, [b"manager message".to_vec()]);

        handle.complete_logical_input().expect("complete input");
        let parts = handle
            .handoff_parts()
            .await
            .expect("snapshot session")
            .expect("live session");
        assert!(parts.pending_logical_inputs.is_empty());
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn legacy_unknown_draft_state_refuses_logical_input_until_explicit_boundary() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.raw_input_draft_state_known = false;
        let handle = Arc::new(SessionHandle::new(record));
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        assert!(matches!(
            handle.enqueue_logical_input(b"manager message".to_vec()),
            Err(super::InputQueueError::InheritedDraftStateUnknown)
        ));
        assert!(input_rx.try_recv().is_err());

        handle
            .enqueue_raw_input(b"\r".to_vec(), RawInputKind::Submission)
            .expect("explicit producer boundary");
        assert_eq!(input_rx.recv().await.expect("boundary").data, b"\r");
        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("logical retry after boundary");
        assert_eq!(
            input_rx.recv().await.expect("logical retry").data,
            b"manager message"
        );
        handle.kill().await.unwrap();
    }

    /// The wedge this exists to end: an inherited session that nobody has
    /// typed into refuses every automated delivery, and before composer
    /// attestation the only documented unblock was a human pressing Enter in
    /// that agent's terminal. A frame that renders the provider's own empty
    /// composer resolves it with no human and no bytes written.
    #[tokio::test]
    async fn inherited_unknown_draft_state_unblocks_from_a_provably_empty_composer() {
        let mut record = spawn_test_record(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        record.raw_input_draft_state_known = false;
        let handle = Arc::new(SessionHandle::new(record));
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        assert!(handle.logical_input_blocked());
        assert!(matches!(
            handle.enqueue_logical_input(b"manager message".to_vec()),
            Err(super::InputQueueError::InheritedDraftStateUnknown)
        ));

        handle
            .mirror_output(b"\x1b[2J\x1b[H* Done.\r\n\xe2\x9d\xaf \r\n", false)
            .await
            .expect("render an idle composer");

        assert!(handle
            .attest_empty_composer()
            .await
            .expect("attest the rendered composer"));
        assert!(!handle.logical_input_blocked());
        assert_eq!(
            handle.take_input_blocked_transition().expect("transition"),
            Some(false)
        );

        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("accept logical input after attestation");
        let delivered = input_rx.recv().await.expect("logical delivery");
        assert_eq!(delivered.kind, super::PendingInputKind::LogicalMessage);
        assert_eq!(delivered.data, b"manager message");
        assert!(
            input_rx.try_recv().is_err(),
            "attestation must write nothing of its own to the PTY"
        );
        handle.kill().await.unwrap();
    }

    /// Attestation resolves emptiness, never a draft. A composer holding text
    /// this daemon never saw typed stays refused — that text belongs to
    /// whoever wrote it, and nothing here may submit it or discard it.
    #[tokio::test]
    async fn inherited_composer_holding_text_stays_refused_and_is_never_submitted() {
        let mut record = spawn_test_record(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        record.raw_input_draft_state_known = false;
        let handle = Arc::new(SessionHandle::new(record));
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .mirror_output(
                b"\x1b[2J\x1b[H* Done.\r\n\xe2\x9d\xaf half typed thought\r\n",
                false,
            )
            .await
            .expect("render a drafted composer");

        assert!(!handle
            .attest_empty_composer()
            .await
            .expect("read the rendered composer"));
        assert!(handle.logical_input_blocked());
        assert!(matches!(
            handle.enqueue_logical_input(b"manager message".to_vec()),
            Err(super::InputQueueError::InheritedDraftStateUnknown)
        ));
        assert!(
            input_rx.try_recv().is_err(),
            "a refused delivery must leave the inherited draft untouched"
        );
        assert_eq!(
            handle.take_input_blocked_transition().expect("transition"),
            None,
            "a session that adopted blocked has already published that state"
        );
        handle.kill().await.unwrap();
    }

    /// A plain shell has no composer chrome to read, so the only thing that
    /// can resolve its draft state remains an explicit producer boundary.
    #[tokio::test]
    async fn inherited_session_without_a_provider_is_never_attested() {
        let mut record = spawn_test_record(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        record.agent_provider = None;
        record.raw_input_draft_state_known = false;
        let handle = Arc::new(SessionHandle::new(record));

        handle
            .mirror_output(b"\x1b[2J\x1b[H\xe2\x9d\xaf \r\n", false)
            .await
            .expect("render a prompt-shaped line");

        assert!(!handle
            .attest_empty_composer()
            .await
            .expect("read the rendered frame"));
        assert!(handle.logical_input_blocked());
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn a_spawned_session_never_reports_blocked_input() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();

        assert!(!handle.logical_input_blocked());
        assert_eq!(
            handle.take_input_blocked_transition().expect("transition"),
            None
        );
        assert!(!handle
            .attest_empty_composer()
            .await
            .expect("attestation is a no-op for a known session"));
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn legacy_handoff_input_stays_fenced_until_one_way_classification() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.operator_input_only = true;
        record.input_policy_classified = false;
        let handle = SessionHandle::new(record);

        assert!(handle.operator_input_only().await);
        handle.classify_input(false).await;
        assert!(!handle.operator_input_only().await);
        handle.classify_input(true).await;
        assert!(handle.operator_input_only().await);
        handle.classify_input(false).await;
        assert!(!handle.operator_input_only().await);
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_kills_are_single_flight_and_block_later_signals() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();

        // Both kills succeed, but termination ownership is taken exactly
        // once: the reap token is consumed under the PTY lock, so only one
        // background reaper can exist and a pid recycled after the reap can
        // never be targeted through this session.
        let (first, second) = tokio::join!(handle.kill(), handle.kill());
        first.expect("first kill should succeed");
        second.expect("second kill should be a safe no-op");

        assert!(
            handle.pty.lock().await.take_reap_token().is_none(),
            "the reap token must have been consumed exactly once"
        );
        assert!(
            handle.signal(libc::SIGTERM).await.is_err(),
            "signals after termination must be refused"
        );
    }

    #[tokio::test]
    async fn session_manager_distinguishes_same_id_handle_incarnations() {
        let old = spawn_test_handle(AgentProvider::Codex, SessionStatus::Busy).unwrap();
        let replacement = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut manager = SessionManager::new();

        manager.insert("task-same-id".to_string(), Arc::clone(&old));
        assert!(manager.is_current("task-same-id", &old));

        manager.insert("task-same-id".to_string(), Arc::clone(&replacement));
        assert!(!manager.is_current("task-same-id", &old));
        assert!(manager.is_current("task-same-id", &replacement));
        assert!(
            old.is_retired(),
            "replacing a session id must fence the old reader incarnation"
        );
        assert!(!replacement.is_retired());

        old.kill().await.unwrap();
        replacement.kill().await.unwrap();
    }

    #[tokio::test]
    async fn stream_control_waits_for_stop_acknowledgement() {
        let control = StreamControl::new();
        let reader_control = control.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            reader_control.mark_stopped();
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(100), control.wait_until_stopped())
                .await
                .is_ok(),
            "reader stop acknowledgement should wake the kill path"
        );
    }

    #[tokio::test]
    async fn copilot_startup_busy_does_not_quiet_idle_before_provider_ui_is_visible() {
        let handle = spawn_test_handle(AgentProvider::Copilot, SessionStatus::Busy).unwrap();
        handle.pty.lock().await.last_active_at = Instant::now() - Duration::from_millis(500);

        let status = handle
            .refresh_quiet_status(Duration::from_millis(150))
            .await
            .unwrap();

        assert_eq!(status, None);

        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn quiet_refresh_returns_idle_after_busy_footer_disappears() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Busy).unwrap();
        record.status_observed = true;
        record.headless_terminal.write("Header\r\nDone".as_bytes());
        record.pty.last_active_at = Instant::now() - Duration::from_millis(500);
        let handle = Arc::new(SessionHandle::new(record));

        let status = handle
            .refresh_quiet_status(Duration::from_millis(150))
            .await
            .unwrap();

        assert_eq!(status, Some(SessionStatus::Idle));

        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn debug_status_observation_reports_detected_status_and_lines() {
        let mut record = spawn_test_record(AgentProvider::Copilot, SessionStatus::Idle).unwrap();
        record
            .headless_terminal
            .write("Header\r\n(Esc to cancel)".as_bytes());
        let handle = Arc::new(SessionHandle::new(record));

        let observation = handle.debug_status_observation().await.unwrap();

        assert_eq!(observation.detected_status, Some(SessionStatus::Busy));
        assert_eq!(observation.provider, Some(AgentProvider::Copilot));
        assert!(observation
            .lines
            .iter()
            .any(|line| line.contains("Esc to cancel")));

        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn throttles_status_detection_per_session() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.pty.last_active_at = Instant::now() - Duration::from_secs(2);
        let handle = Arc::new(SessionHandle::new(record));

        let started_at = Instant::now();
        let throttle = Duration::from_millis(500);

        let first_status = handle
            .mirror_output_at(
                "Header\r\n• Working (0s • esc to interrupt)\r\n› Run /review".as_bytes(),
                false,
                started_at,
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(first_status.status, Some(SessionStatus::Busy));
        assert!(handle.update_status(SessionStatus::Busy).await);

        let throttled_status = handle
            .mirror_output_at(
                "\x1b[2J\x1b[HHeader\r\nDone\r\n›".as_bytes(),
                false,
                started_at + Duration::from_millis(100),
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(throttled_status.status, None);

        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn quiet_refresh_bypasses_output_detection_throttle() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.pty.last_active_at = Instant::now() - Duration::from_secs(2);
        let handle = Arc::new(SessionHandle::new(record));

        let started_at = Instant::now();
        let throttle = Duration::from_millis(500);

        let first_status = handle
            .mirror_output_at(
                "Header\r\n• Working (0s • esc to interrupt)\r\n› Run /review".as_bytes(),
                false,
                started_at,
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(first_status.status, Some(SessionStatus::Busy));
        assert!(handle.update_status(SessionStatus::Busy).await);

        let throttled_status = handle
            .mirror_output_at(
                "\x1b[2J\x1b[HHeader\r\nDone\r\n›".as_bytes(),
                false,
                started_at + Duration::from_millis(100),
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(throttled_status.status, None);

        let early_refresh = handle
            .refresh_quiet_status_at(
                Duration::from_millis(500),
                started_at + Duration::from_millis(300),
            )
            .await
            .unwrap();
        assert_eq!(early_refresh, None, "the repaint has not settled yet");

        let refreshed_status = handle
            .refresh_quiet_status_at(
                Duration::from_millis(500),
                started_at + Duration::from_millis(600),
            )
            .await
            .unwrap();
        assert_eq!(refreshed_status, Some(SessionStatus::Idle));

        handle.kill().await.unwrap();
    }

    /// Codex v0.140's real PTY capture brackets every spinner/status redraw
    /// with DEC synchronized output (see
    /// `tests/tui-fidelity/fixtures/codex-pwd-tool.ansi`). The owner-reported
    /// stuck sessions were sampled after the bracket opened, consuming the
    /// throttle slot on temporary `esc to interrupt` chrome; the completed
    /// idle composer then arrived too soon to be classified.
    #[tokio::test]
    async fn synchronized_codex_idle_repaint_cannot_publish_a_busy_flap() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.status_observed = true;
        record.headless_terminal.write(
            concat!(
                "\x1b[2J\x1b[H• Finished the requested work.\r\n",
                "› Improve documentation in @filename\r\n",
                "gpt-5.5 high · /tmp/kanna-codex-fixture-root\r\n",
            )
            .as_bytes(),
        );
        record.pty.last_active_at = Instant::now() - Duration::from_secs(2);
        let handle = Arc::new(SessionHandle::new(record));
        let started_at = Instant::now();
        let throttle = Duration::from_millis(500);

        // Exact structural shape from the capture: title-spinner repaint,
        // synchronized frame start, then a temporary working footer. This is
        // paint in progress, not an observable agent-state transition.
        let partial = handle
            .mirror_output_at(
                concat!(
                    "\x1b]0;⠹ kanna-codex-fixture-root\x07",
                    "\x1b[?2026h\x1b[2J\x1b[H",
                    "• Working (43s • esc to interrupt)\r\n",
                )
                .as_bytes(),
                false,
                started_at + Duration::from_millis(600),
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(partial.status, None);

        let completed = handle
            .mirror_output_at(
                concat!(
                    "\x1b[2J\x1b[H",
                    "• Finished the requested work.\r\n",
                    "› Improve documentation in @filename\r\n",
                    "gpt-5.5 high · /tmp/kanna-codex-fixture-root",
                    "\x1b[?2026l",
                )
                .as_bytes(),
                false,
                started_at + Duration::from_millis(610),
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(completed.status, None);
        assert_eq!(handle.status().await, SessionStatus::Idle);

        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn settled_status_refresh_cannot_be_starved_by_chrome_checks() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Busy).unwrap();
        record.status_observed = true;
        record
            .headless_terminal
            .write("• Working (43s • esc to interrupt)\r\n".as_bytes());
        record.pty.last_active_at = Instant::now() - Duration::from_secs(2);
        let handle = Arc::new(SessionHandle::new(record));
        let started_at = Instant::now();
        let throttle = Duration::from_millis(500);

        // A cosmetic output check immediately before the settled idle frame
        // consumes the ordinary output throttle slot.
        let chrome = handle
            .mirror_output_at(
                "\x1b]0;⠹ kanna-codex-fixture-root\x07".as_bytes(),
                false,
                started_at + Duration::from_millis(600),
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(chrome.status, None);
        let idle = handle
            .mirror_output_at(
                "\x1b[2J\x1b[HDone\r\n› Improve documentation in @filename".as_bytes(),
                false,
                started_at + Duration::from_millis(610),
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(idle.status, None, "ordinary output detection is throttled");

        // The periodic convergence read is independent of that throttle, but
        // it waits for a quiet interval so an unbracketed repaint cannot make
        // a partial frame observable as Idle.
        let repainting = handle
            .refresh_quiet_status_at(
                Duration::from_millis(500),
                started_at + Duration::from_millis(620),
            )
            .await
            .unwrap();
        assert_eq!(repainting, None);
        let settled = handle
            .refresh_quiet_status_at(
                Duration::from_millis(500),
                started_at + Duration::from_millis(1110),
            )
            .await
            .unwrap();
        assert_eq!(settled, Some(SessionStatus::Idle));

        handle.kill().await.unwrap();
    }

    /// Claude's live TUI does not use DEC synchronized output. During the
    /// owner's 2026-09-03 reproduction it repeatedly cleared the busy footer
    /// and exposed the parked composer before painting the next `Forming…`
    /// frame. Those intermediate frames used to publish Idle on the 500 ms
    /// status cadence, forcing the server and desktop to process a false state
    /// edge while terminal output was already competing with typing.
    /// The first reported incident, driven through the publication path rather
    /// than the matcher: a Claude session latched at `idle` that starts
    /// working must publish `Busy` off its own output, with no attach, no
    /// selection and nobody clicking it. 2.1.263 draws no `esc to interrupt`,
    /// so before the working footer became a signal this frame published
    /// nothing and the session stayed `idle` through the whole turn.
    #[tokio::test]
    async fn captured_claude_working_frame_publishes_busy_while_unattached() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/claude/working-footer-2.1.263-171x65.json"
        ))
        .unwrap();
        let fixture: serde_json::Value = serde_json::from_str(&raw).unwrap();

        let mut record = spawn_test_record(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        record.status_observed = true;
        let handle = Arc::new(SessionHandle::new(record));

        let published = handle
            .mirror_output_at(
                fixture["serialized"].as_str().unwrap().as_bytes(),
                false,
                Instant::now(),
                Duration::from_millis(0),
            )
            .await
            .unwrap();

        assert_eq!(
            published.status,
            Some(SessionStatus::Busy),
            "the frame must publish a Busy transition off output alone"
        );
        // `emit_status_changed` is what commits a published transition in
        // production; committing it here proves the session leaves `idle`.
        assert!(handle.update_status(published.status.unwrap()).await);
        assert_eq!(handle.status().await, SessionStatus::Busy);
    }

    #[tokio::test]
    async fn unbracketed_claude_repaint_cannot_publish_idle_until_output_settles() {
        let mut record = spawn_test_record(AgentProvider::Claude, SessionStatus::Busy).unwrap();
        record.status_observed = true;
        record
            .headless_terminal
            .write("✻ Forming… (1m 7s · ↓ 3.0k tokens)\r\nesc to interrupt".as_bytes());
        let handle = Arc::new(SessionHandle::new(record));
        let started_at = Instant::now();
        let throttle = Duration::from_millis(500);

        for (partial_at, complete_at) in [(600, 610), (1200, 1210)] {
            let partial = handle
                .mirror_output_at(
                    "\x1b[2J\x1b[HDone\r\n❯ ".as_bytes(),
                    false,
                    started_at + Duration::from_millis(partial_at),
                    throttle,
                )
                .await
                .unwrap();
            assert_eq!(
                partial.status, None,
                "a partial Claude repaint must not publish Idle"
            );

            let complete = handle
                .mirror_output_at(
                    "\x1b[2J\x1b[H✻ Forming… (1m 7s · ↓ 3.0k tokens)\r\nesc to interrupt"
                        .as_bytes(),
                    false,
                    started_at + Duration::from_millis(complete_at),
                    throttle,
                )
                .await
                .unwrap();
            assert_eq!(complete.status, None, "the session remains Busy");
        }

        let final_idle_frame = handle
            .mirror_output_at(
                "\x1b[2J\x1b[HDone\r\n❯ ".as_bytes(),
                false,
                started_at + Duration::from_millis(1800),
                throttle,
            )
            .await
            .unwrap();
        assert_eq!(
            final_idle_frame.status, None,
            "even a completed Idle frame converges at the settled boundary"
        );

        let still_repainting = handle
            .refresh_quiet_status_at(
                Duration::from_millis(500),
                started_at + Duration::from_millis(2299),
            )
            .await
            .unwrap();
        assert_eq!(still_repainting, None);

        let settled = handle
            .refresh_quiet_status_at(
                Duration::from_millis(500),
                started_at + Duration::from_millis(2300),
            )
            .await
            .unwrap();
        assert_eq!(settled, Some(SessionStatus::Idle));

        handle.kill().await.unwrap();
    }

    #[test]
    fn benchmark_replay_updates_status_without_real_pty_io() {
        let transcript =
            TranscriptSpec::new(BenchmarkProvider::Codex, BenchmarkMode::Steady).build();
        let mut headless_terminal = HeadlessTerminal::new(120, 40, 10_000).unwrap();
        let started_at = Instant::now();
        let mut state =
            BenchmarkStatusState::new(initial_session_status(Some(AgentProvider::Codex)));

        for chunk in &transcript.chunks {
            let changed = replay_headless_terminal_for_benchmark(
                &mut headless_terminal,
                &mut Classifier::new(Some(AgentProvider::Codex)),
                &mut state,
                started_at,
                chunk.at_ms,
                &chunk.bytes,
            )
            .unwrap();

            if let Some(next) = changed {
                state.status = next;
            }
        }

        assert!(matches!(
            state.status,
            SessionStatus::Busy | SessionStatus::Idle
        ));
        assert!(state.status_observed);
    }

    /// The Claude composer as the CLI actually paints its tab-to-accept
    /// suggestion: the prompt glyph, a non-breaking space, and dim placeholder
    /// text. Read off the 2026-08-20 handoff payload for task d846edb7, whose
    /// suggestion "check again in a minute" is what a task manager read as an
    /// owner directive.
    const CLAUDE_FRAME_WITH_SUGGESTION: &[u8] =
        "\x1b[2J\x1b[H* Done.\r\n\u{276F}\u{a0}check again in a minute\r\n".as_bytes();

    /// Verdict one of three: a session this daemon spawned and nobody has
    /// typed into is attested not-typed, whatever the CLI paints on the
    /// composer line.
    #[tokio::test]
    async fn an_untouched_session_attests_not_typed_however_its_composer_renders() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        assert_eq!(
            handle.composer_attestation(),
            crate::protocol::ComposerAttestation::NotTyped
        );

        handle
            .mirror_output(CLAUDE_FRAME_WITH_SUGGESTION, false)
            .await
            .expect("render the CLI's own suggestion at the prompt");

        assert_eq!(
            handle.composer_attestation(),
            crate::protocol::ComposerAttestation::NotTyped,
            "rendered text cannot make an untyped composer typed"
        );
        let (text, attestation) = handle
            .take_composer_transition()
            .await
            .expect("the composer changed");
        assert_eq!(text.as_deref(), Some("check again in a minute"));
        assert_eq!(
            attestation,
            crate::protocol::ComposerAttestation::NotTyped,
            "the label is what tells a reader this text is the CLI's, not a human's"
        );
        assert!(
            handle.take_composer_transition().await.is_none(),
            "an unchanged composer publishes nothing"
        );
        handle.kill().await.unwrap();
    }

    /// Verdict two: keystrokes reached the composer, so whatever is rendered
    /// there may be a human's unsent line and is labelled as one.
    #[tokio::test]
    async fn a_typed_composer_attests_typed_until_its_next_boundary() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"half typed".to_vec(), RawInputKind::Draft)
            .expect("declare a raw draft");
        assert_eq!(
            handle.composer_attestation(),
            crate::protocol::ComposerAttestation::Typed
        );

        handle
            .enqueue_raw_input(b"\r".to_vec(), RawInputKind::Submission)
            .expect("submit the line");
        assert_eq!(
            handle.composer_attestation(),
            crate::protocol::ComposerAttestation::NotTyped,
            "a submission empties the composer, so the ledger restarts proven-empty"
        );
        assert_eq!(input_rx.recv().await.expect("draft").data, b"half typed");
        assert_eq!(input_rx.recv().await.expect("boundary").data, b"\r");
        handle.kill().await.unwrap();
    }

    /// Verdict three: a session inherited from before attestation. The daemon
    /// never watched what was typed, so it says so rather than guessing.
    #[tokio::test]
    async fn an_inherited_session_attests_unknown() {
        let mut record = spawn_test_record(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        record.raw_input_draft_state_known = false;
        record.typed_draft_bytes = None;
        let handle = Arc::new(SessionHandle::new(record));

        assert_eq!(
            handle.composer_attestation(),
            crate::protocol::ComposerAttestation::Unknown
        );
        handle.kill().await.unwrap();
    }

    /// A declared draft that is inherited without its ledger is not
    /// proven-empty. `None` and `Some(0)` are different answers, and reading
    /// the first as the second would release a message onto a real unsent
    /// line the successor never saw typed.
    #[tokio::test]
    async fn an_uncounted_inherited_draft_holds_like_a_counted_one() {
        let mut record = spawn_test_record(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        record.raw_input_draft_active = true;
        record.typed_draft_bytes = None;
        let handle = Arc::new(SessionHandle::new(record));
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        assert_eq!(
            handle.composer_attestation(),
            crate::protocol::ComposerAttestation::Unknown
        );
        let accepted = handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("accept logical input");
        assert!(accepted.held_by_raw_draft);
        assert!(input_rx.try_recv().is_err());
        handle.kill().await.unwrap();
    }

    /// The refusal this whole change exists to end. The CLI paints a
    /// suggestion at the prompt, so no frame will ever read the composer
    /// empty; before the ledger that made the hold permanent, and the message
    /// it answered with — "a human has an unsent line at that terminal" — was
    /// false. Zero typed bytes is the proof the frame cannot give.
    #[tokio::test]
    async fn a_rendered_suggestion_over_an_untyped_composer_never_holds_a_message() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        // A producer declares a draft for a keystroke that leaves nothing
        // behind, and the CLI is rendering its suggestion.
        handle
            .enqueue_raw_input(Vec::new(), RawInputKind::Draft)
            .expect("declare a draft that writes no bytes");
        assert_eq!(input_rx.recv().await.expect("draft").data, b"");
        handle
            .mirror_output(CLAUDE_FRAME_WITH_SUGGESTION, false)
            .await
            .expect("render the CLI's own suggestion at the prompt");
        assert_eq!(
            handle
                .headless_composer_state_for_test()
                .await
                .expect("read the rendered composer"),
            ComposerState::Unknown,
            "the frame cannot tell the suggestion from a draft — only the ledger can"
        );

        let accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(
            !accepted.held_by_raw_draft,
            "nothing was typed, so there is no unsent line to append to"
        );
        let delivered = input_rx.try_recv().expect("the message reaches the writer");
        assert_eq!(delivered.data, b"owner reply");
        handle.kill().await.unwrap();
    }

    /// The other half of the same rule: once a human really has typed, the
    /// suggestion-shaped frame proves nothing and the message stays queued.
    #[tokio::test]
    async fn a_genuinely_typed_draft_still_holds_behind_a_suggestion_shaped_frame() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"check again in a minute".to_vec(), RawInputKind::Draft)
            .expect("declare a real human draft");
        assert_eq!(
            handle.composer_attestation(),
            crate::protocol::ComposerAttestation::Typed
        );
        handle
            .complete_declared_draft_write()
            .expect("the declared draft reaches the PTY");
        handle
            .mirror_output(CLAUDE_FRAME_WITH_SUGGESTION, false)
            .await
            .expect("render the typed line at the prompt");

        let accepted = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(
            accepted.held_by_raw_draft,
            "a counted draft is protected exactly as before"
        );
        assert_eq!(
            input_rx.recv().await.expect("draft").data,
            b"check again in a minute"
        );
        assert!(input_rx.try_recv().is_err());
        handle.kill().await.unwrap();
    }

    #[test]
    fn pty_exhaustion_occupancy_is_sorted_and_attributed() {
        let snapshot = PtyOccupancySnapshot::new(vec![
            PtyMasterAttribution {
                session_id: "zeta".to_string(),
                child_pid: 42,
                master_fd: 12,
            },
            PtyMasterAttribution {
                session_id: "alpha".to_string(),
                child_pid: 7,
                master_fd: 9,
            },
        ]);

        assert_eq!(
            snapshot.to_string(),
            "open_master_count=2 sessions=[alpha(pid=7,master_fd=9), zeta(pid=42,master_fd=12)]"
        );
    }
}
