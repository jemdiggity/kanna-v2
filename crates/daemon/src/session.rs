use std::collections::HashMap;
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
/// How long the writer pauses after one logical message's submission boundary
/// before the next queued message may own the composer.
///
/// This is write pacing between two *delivered* messages, not a protection
/// against anything a human did: a CLI needs a processing turn after Enter
/// before it can take another line, and back-to-back deliveries that skip it
/// arrive merged. It is a fixed, short, unconditional pause that always
/// elapses — it never withholds a message, never inspects the terminal, and
/// never reports a delivery as anything but written.
pub const LOGICAL_INPUT_SUBMIT_DELAY_MS: u64 = 150;
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

/// The exact bytes one logical message puts on the PTY: the text, framed as a
/// paste when the terminal supports it, followed immediately by its submission
/// boundary.
///
/// A PTY is only a byte stream, and the daemon's writes are not the CLI's reads:
/// embedded line feeds are indistinguishable from independently typed input,
/// and a message too long for one write arrives as several input events even
/// without them. An interactive agent TUI then consumes the pieces as separate
/// editor actions and submits only a fragment. When the application has enabled
/// the mode, the explicit paste markers travel in-band with the bytes and are
/// therefore immune to however the queue splits them: every byte between them
/// is one editor operation, closed before the trailing Enter submits it.
/// Otherwise the bytes stay untouched; sending unsupported control markers
/// as literal composer text would be a worse corruption, and a session whose
/// terminal never advertised the mode cannot be protected from the split.
///
/// The Enter is part of this buffer rather than a separately fenced second
/// write. Withholding it until the terminal proved it had consumed the text is
/// what stranded messages at composers and wedged sessions, and the owner's
/// 2026-09-08 decision is that a message that occasionally collides with a
/// human's draft is far cheaper than one that silently never arrives.
fn logical_message_bytes(mut data: Vec<u8>, bracketed_paste_mode: bool) -> Vec<u8> {
    if data.is_empty() {
        return vec![b'\r'];
    }
    let has_newline = data.iter().any(|byte| matches!(byte, b'\r' | b'\n'));
    if !bracketed_paste_mode || (!has_newline && data.len() < PASTE_FRAMING_MIN_LEN) {
        data.push(b'\r');
        return data;
    }

    let mut framed = Vec::with_capacity(
        BRACKETED_PASTE_BEGIN.len() + data.len() + BRACKETED_PASTE_END.len() + 1,
    );
    framed.extend_from_slice(BRACKETED_PASTE_BEGIN);
    framed.append(&mut data);
    framed.extend_from_slice(BRACKETED_PASTE_END);
    framed.push(b'\r');
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingInputKind {
    Raw,
    /// One delivered message: its text and its submission boundary, in one
    /// buffer. There is no second, separately fenced write to withhold.
    Logical,
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
    /// Fires once every byte of this input has reached the PTY. Dropping it
    /// instead reports a writer that ended mid-write.
    written: Option<oneshot::Sender<()>>,
}

impl PendingInput {
    fn raw(data: Vec<u8>, written: Option<oneshot::Sender<()>>) -> Self {
        Self {
            data,
            kind: PendingInputKind::Raw,
            declared_draft: false,
            written,
        }
    }

    fn raw_draft(data: Vec<u8>, written: Option<oneshot::Sender<()>>) -> Self {
        Self {
            data,
            kind: PendingInputKind::Raw,
            declared_draft: true,
            written,
        }
    }

    /// One delivered message and its submission boundary, as a single write.
    ///
    /// The acknowledgement therefore means what a caller assumes it means:
    /// the whole message, Enter included, is on the PTY.
    pub(crate) fn logical(
        data: Vec<u8>,
        written: Option<oneshot::Sender<()>>,
        bracketed_paste_mode: bool,
    ) -> Self {
        Self {
            data: logical_message_bytes(data, bracketed_paste_mode),
            kind: PendingInputKind::Logical,
            declared_draft: false,
            written,
        }
    }

    /// Whether these bytes were declared a draft by their producer.
    pub fn is_declared_draft(&self) -> bool {
        self.declared_draft
    }

    /// Tell the caller this write reached the PTY. Dropping the sender
    /// instead reports a writer that ended mid-delivery.
    pub fn acknowledge_written(mut self) {
        if let Some(written) = self.written.take() {
            let _ = written.send(());
        }
    }
}

#[derive(Debug)]
pub enum InputQueueError {
    Closed,
    CoordinationUnavailable,
}

/// The composer-attestation ledger for one session.
///
/// Logical input is never withheld on any of this — a delivered message goes
/// straight to the writer. What the ledger still answers is the *other*
/// question, the one the codebase must keep answering: whether text rendered
/// on a `❯` line was typed by somebody or is the provider's own tab-to-accept
/// suggestion. Nothing may be read as an instruction unless it is `typed`, and
/// only a count of the keystrokes this daemon accepted can say so.
struct InputCoordinationState {
    raw_input_draft_active: bool,
    raw_input_draft_state_known: bool,
    /// What the daemon actually saw typed into this composer since the last
    /// producer-declared submission boundary.
    ///
    /// `Some(0)` is positive proof that nothing anybody wrote is sitting at
    /// that prompt, so any text rendered there is the CLI's own suggestion.
    /// `None` is the inherited case — a declared draft with no ledger behind
    /// it — so "cannot prove" never reads as "proved empty".
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
        }
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

    /// Whether attestation still has something to resolve from a frame: an
    /// inherited state nobody here counted, or a declared draft that has not
    /// crossed a submission boundary since.
    fn attestation_unresolved(&self) -> bool {
        !self.raw_input_draft_state_known || self.raw_input_draft_active
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
    /// Permanently fences an outgoing incarnation from publishing output or
    /// mutating id-keyed state after a same-id replacement is allowed.
    retired: AtomicBool,
}

impl SessionHandle {
    pub fn new(record: SessionRecord) -> Self {
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        let input_coordination = InputCoordinationState::from_record(&record);
        let bracketed_paste_mode = record.headless_terminal.bracketed_paste_mode();
        // Nothing this daemon accepts is ever retained, so this vector is only
        // ever non-empty when adopting from a predecessor that still held
        // messages behind a draft. They are submitted here rather than
        // dropped: an owner's message that survived a handoff must not be lost
        // to the upgrade that removed the hold.
        for pending in &record.pending_logical_inputs {
            if input_tx
                .send(PendingInput::logical(
                    pending.clone(),
                    None,
                    bracketed_paste_mode,
                ))
                .is_err()
            {
                unreachable!("new session input receiver must be open");
            }
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
    ) -> Result<oneshot::Receiver<()>, InputQueueError> {
        let (written_tx, written) = oneshot::channel();
        self.enqueue_raw_input_with_ack(data, kind, Some(written_tx))?;
        Ok(written)
    }

    /// Put one raw write on the wire with its declared meaning applied to the
    /// attestation ledger.
    fn enqueue_raw_input_with_ack(
        &self,
        data: Vec<u8>,
        kind: RawInputKind,
        written: Option<oneshot::Sender<()>>,
    ) -> Result<(), InputQueueError> {
        let mut state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        let routed = match kind {
            RawInputKind::Submission => {
                state.raw_input_draft_active = false;
                state.raw_input_draft_state_known = true;
                // The boundary empties the composer, so the ledger restarts
                // from proven-empty — including for a session that inherited
                // an uncounted draft, which is how such a session ever earns
                // an attestation at all.
                state.typed_draft_bytes = Some(0);
                PendingInput::raw(data, written)
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
                    PendingInput::raw(data, written)
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
                    PendingInput::raw_draft(data, written)
                }
            }
            RawInputKind::Control => PendingInput::raw(data, written),
        };
        self.input_tx
            .send(routed)
            .map_err(|_| InputQueueError::Closed)
    }

    /// Accept one logical message and put it on the PTY now.
    ///
    /// There is no condition under which this retains, defers, or refuses.
    /// Until 2026-09-08 a producer-declared draft parked the message at the
    /// composer and an unattested one refused it outright, and both failure
    /// modes stranded owner messages and wedged whole sessions: a delivery
    /// answered `delivery_uncertain` left text at a prompt nobody pressed
    /// Enter at, and ten seconds later the same session started refusing every
    /// later message until a human typed into that terminal. The owner's
    /// decision is that the collision is cheaper: if a human has an unsent
    /// line open, the delivered message lands after it and both go in.
    ///
    /// The returned receiver resolves when the message *and* its submission
    /// boundary have reached the PTY, because they are one write.
    pub fn enqueue_logical_input(
        &self,
        data: Vec<u8>,
    ) -> Result<oneshot::Receiver<()>, InputQueueError> {
        let (written_tx, written) = oneshot::channel();
        self.input_tx
            .send(PendingInput::logical(
                data,
                Some(written_tx),
                self.bracketed_paste_mode(),
            ))
            .map_err(|_| InputQueueError::Closed)?;
        Ok(written)
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

    /// Resolve composer attestation from the terminal itself.
    ///
    /// Attestation answers one question: is text on that `❯` line something a
    /// human typed, or the provider's own chrome? Nothing in the codebase may
    /// read composer text as an instruction unless it is `typed`, so a
    /// session that can only say `unknown` is a session whose composer is
    /// unreadable — the daemon never watched it being typed into, or a
    /// producer declared a draft and has declared no boundary since.
    ///
    /// A frame that positively renders the provider's own empty composer
    /// resolves both. It has to: Claude Code paints the last submitted line
    /// back as a faint tab-to-accept ghost, so a session that ever armed its
    /// ledger would otherwise never see a textually empty composer again and
    /// would report `typed` for the life of the session. That is the
    /// 2026-09-07 owner report — a composer attested `typed` whose text the
    /// owner could see was grey — and the ledger stays primary: the frame only
    /// ever clears it, never arms it. See [`ComposerState::SuggestionOnly`]
    /// for what has to be true at once before a frame is allowed to say that.
    ///
    /// **The frame must be newer than the draft.** A rendered frame is
    /// evidence about the moment it was rendered, and a declared byte that is
    /// still queued in the writer — or written but not yet echoed by the
    /// provider — leaves a composer that renders empty because the draft has
    /// not landed on it yet. Calling that `not-typed` would assert that a
    /// human's first typed character is provider chrome. So an *active*
    /// declared draft is cleared only when every declared write has completed
    /// and at least one output chunk has been mirrored since the last one did.
    /// The *inherited-unknown* state carries no such write to wait for and is
    /// unchanged: nothing here declared a draft, so the current frame is the
    /// only evidence there is.
    ///
    /// Nothing is written to the PTY, nothing on screen is discarded, and the
    /// transition stays one-way — towards "nobody typed here", never towards
    /// "a human did", which no frame may ever assert. Returns whether this
    /// call resolved it.
    pub async fn attest_empty_composer(
        &self,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if !self.attestation_unresolved() {
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
        Ok(true)
    }

    /// Output chunks mirrored into this session's headless terminal so far.
    ///
    pub fn bracketed_paste_mode(&self) -> bool {
        self.bracketed_paste_mode.load(Ordering::SeqCst)
    }

    /// Legacy-v2 handoff payloads cannot carry the composer attestation
    /// ledger. A v2 adopter may ignore the newer wire fields while still
    /// acknowledging adoption, so a session with a live declared draft — the
    /// ledger's one positive assertion, and the only thing that lets a reader
    /// tell a human's unsent line from the provider's own suggestion — keeps
    /// its current owner until that draft crosses a submission boundary.
    ///
    /// Nothing about *delivery* is at stake here any more: logical input is
    /// never retained, so there is no queue a v2 adopter could drop.
    pub fn input_coordination_requires_v3(&self) -> Result<bool, InputQueueError> {
        let state = self
            .input_coordination
            .lock()
            .map_err(|_| InputQueueError::CoordinationUnavailable)?;
        Ok(state.raw_input_draft_active)
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
        let previous = {
            let pty = self.pty.lock().await;
            (pty.cols(), pty.rows())
        };
        self.pty.lock().await.resize(cols, rows)?;
        let headless_result = self.state.lock().await.headless_terminal.resize(cols, rows);
        if let Err(error) = headless_result {
            // Do not leave the kernel PTY and the authoritative headless
            // interpreter on different grids. A failed resize is invisible
            // to consumers, and the caller can retry the unchanged proposal.
            if let Err(rollback_error) = self.pty.lock().await.resize(previous.0, previous.1) {
                return Err(format!(
                    "headless resize failed ({error}); PTY rollback failed ({rollback_error})"
                )
                .into());
            }
            return Err(error);
        }
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
            composer_text: self.composer_line().await,
            composer_attestation: self.composer_attestation(),
        }
    }

    /// The ledger's own count, for tests that pin what a write contributed.
    #[cfg(test)]
    pub fn typed_draft_bytes_for_test(&self) -> Option<u64> {
        self.input_coordination
            .lock()
            .expect("terminal input coordination lock")
            .typed_draft_bytes
    }

    /// What this daemon can prove about the text on this session's composer.
    ///
    /// A poisoned coordination lock answers `Unknown`, which is the honest
    /// verdict: nothing readable can say whether somebody typed there, and no
    /// reader may treat the text as an instruction without that proof.
    pub fn composer_attestation(&self) -> ComposerAttestation {
        self.input_coordination
            .lock()
            .map(|state| state.composer_attestation())
            .unwrap_or(ComposerAttestation::Unknown)
    }

    /// Whether attestation still has something a frame could resolve.
    fn attestation_unresolved(&self) -> bool {
        self.input_coordination
            .lock()
            .map(|state| state.attestation_unresolved())
            .unwrap_or(false)
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
        replay_headless_terminal_for_benchmark, BenchmarkStatusState, ComposerAttestation,
        PtyMasterAttribution, PtyOccupancySnapshot, RawInputKind, SessionHandle, SessionManager,
        SessionRecord, StreamControl,
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

    /// The owner directive of 2026-09-08, at the queue.
    ///
    /// A human with an unsent line at that terminal used to park every
    /// delivered message behind it, indefinitely, and the phone was told its
    /// message was "queued". The owner would rather have the collision: the
    /// message goes out now, lands after whatever is on the composer, and both
    /// are submitted.
    #[tokio::test]
    async fn a_message_sent_over_a_human_draft_is_written_immediately() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"human draft".to_vec(), RawInputKind::Draft)
            .expect("enqueue raw draft");
        let draft = input_rx.recv().await.expect("raw draft input");
        assert_eq!(draft.kind, super::PendingInputKind::Raw);
        assert!(draft.is_declared_draft());
        assert_eq!(handle.composer_attestation(), ComposerAttestation::Typed);

        let first = handle
            .enqueue_logical_input(b"manager one".to_vec())
            .expect("queue first logical input");
        let second = handle
            .enqueue_logical_input(b"manager two".to_vec())
            .expect("queue second logical input");

        let one = input_rx
            .recv()
            .await
            .expect("the first message goes out now");
        assert_eq!(one.kind, super::PendingInputKind::Logical);
        assert_eq!(one.data, b"manager one\r");
        let two = input_rx
            .recv()
            .await
            .expect("the second message goes out now, in order");
        assert_eq!(two.data, b"manager two\r");

        one.acknowledge_written();
        two.acknowledge_written();
        first.await.expect("first delivery acknowledged");
        second.await.expect("second delivery acknowledged");
        assert_eq!(
            handle.composer_attestation(),
            ComposerAttestation::Typed,
            "the delivery says nothing about what the human typed"
        );
        handle.kill().await.unwrap();
    }

    /// A newline inside a bracketed paste is composer content, not a
    /// submission: it must not clear the attestation ledger, because the
    /// human's line is still sitting there unsent.
    #[tokio::test]
    async fn embedded_newlines_in_bracketed_paste_are_not_submission_boundaries() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"human draft".to_vec(), RawInputKind::Draft)
            .expect("enqueue raw draft");
        let _draft = input_rx.recv().await.expect("raw draft input");

        let paste = b"\x1b[200~ continued\nsecond line\x1b[201~".to_vec();
        handle
            .enqueue_raw_input(paste.clone(), RawInputKind::Draft)
            .expect("enqueue multiline paste continuation");
        let continuation = input_rx.recv().await.expect("paste continuation");
        assert_eq!(continuation.kind, super::PendingInputKind::Raw);
        assert_eq!(continuation.data, paste);
        assert_eq!(
            handle.composer_attestation(),
            ComposerAttestation::Typed,
            "an embedded paste newline is not a producer-declared boundary"
        );

        handle
            .enqueue_raw_input(b"\r".to_vec(), RawInputKind::Submission)
            .expect("enqueue producer-declared submission boundary");
        let boundary = input_rx.recv().await.expect("boundary");
        assert_eq!(boundary.data, b"\r");
        assert_eq!(handle.composer_attestation(), ComposerAttestation::NotTyped);
        handle.kill().await.unwrap();
    }

    /// Control bytes are neither typing nor a submission, so they move the
    /// attestation ledger in neither direction.
    #[tokio::test]
    async fn terminal_control_does_not_create_or_clear_a_draft() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"human draft".to_vec(), RawInputKind::Draft)
            .expect("enqueue raw draft");
        assert_eq!(input_rx.recv().await.expect("draft").data, b"human draft");
        assert_eq!(handle.composer_attestation(), ComposerAttestation::Typed);

        let mouse_report = b"\x1b[<65;1;1M".to_vec();
        handle
            .enqueue_raw_input(mouse_report.clone(), RawInputKind::Control)
            .expect("enqueue terminal control");
        assert_eq!(input_rx.recv().await.expect("control").data, mouse_report);
        assert_eq!(
            handle.composer_attestation(),
            ComposerAttestation::Typed,
            "control input must not clear the real human draft"
        );
        handle.kill().await.unwrap();
    }

    /// The owner report of 2026-09-05, at the ledger.
    ///
    /// Opening a task's terminal on the desktop and pressing keys that leave
    /// nothing at the prompt used to arm the draft ledger, because the desktop
    /// declares every non-Enter keydown a draft — and a composer attested
    /// `typed` is one whose text a reader may act on. These bytes cannot put
    /// text anywhere, so they declare nothing.
    #[tokio::test]
    async fn keystrokes_that_cannot_type_declare_no_draft() {
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
        handle.kill().await.unwrap();
    }

    /// Cursor up and down look like navigation and are not: they recall a
    /// previous line *into* the composer, so the text on it really was put
    /// there by a person and attests `typed`.
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
        handle.kill().await.unwrap();
    }

    /// A logical message and its submission boundary are one write, so the
    /// acknowledgement means what its caller assumes: the whole thing, Enter
    /// included, is on the PTY.
    #[tokio::test]
    async fn logical_input_is_acknowledged_only_once_its_whole_write_lands() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        let mut written = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        assert!(
            written.try_recv().is_err(),
            "queueing alone must not report the message submitted"
        );

        let pending = input_rx.recv().await.expect("logical message");
        assert_eq!(pending.kind, super::PendingInputKind::Logical);
        assert_eq!(
            pending.data, b"owner reply\r",
            "the submission boundary travels with the text"
        );
        assert!(
            written.try_recv().is_err(),
            "reaching the writer must not report the message submitted"
        );

        pending.acknowledge_written();
        written
            .await
            .expect("acknowledgement once the whole write lands");
        handle.kill().await.unwrap();
    }

    /// The production failure sent a multiline commit-post prompt to Claude
    /// as undelimited terminal bytes. The TUI consumed that stream as a
    /// partial paste and submitted only the final `sult:` suffix. A logical
    /// message with embedded newlines must instead carry the terminal's paste
    /// boundaries, closed before the Enter that submits them.
    #[tokio::test]
    async fn multiline_logical_input_is_bracketed_before_its_terminating_enter() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");
        handle
            .mirror_output(b"\x1b[?2004h", false)
            .await
            .expect("terminal enables bracketed paste mode");
        assert!(handle.bracketed_paste_mode());

        let mut written = handle
            .enqueue_logical_input(
                b"commit instructions\n\nPrevious implementation result:".to_vec(),
            )
            .expect("accept multiline logical input");

        let pending = input_rx.recv().await.expect("logical message");
        assert_eq!(pending.kind, super::PendingInputKind::Logical);
        assert_eq!(
            pending.data,
            b"\x1b[200~commit instructions\n\nPrevious implementation result:\x1b[201~\r"
        );
        assert!(
            written.try_recv().is_err(),
            "reaching the writer must not report the message submitted"
        );

        pending.acknowledge_written();
        written
            .await
            .expect("acknowledgement once the whole write lands");
        handle.kill().await.unwrap();
    }

    #[test]
    fn multiline_logical_input_does_not_send_unadvertised_terminal_controls() {
        let message = b"first line\nsecond line".to_vec();
        let mut expected = message.clone();
        expected.push(b'\r');

        assert_eq!(super::logical_message_bytes(message, false), expected);
    }

    /// The fault the owner's 1,227-byte dictated message hit. A PTY master
    /// takes about a kilobyte per write, so a longer single-line message
    /// reaches the CLI as separate input events and an interactive TUI reads
    /// the first burst as a paste and the rest as typing — submitting only the
    /// tail. The paste markers travel in-band with the bytes, so however the
    /// queue splits them the CLI still sees one editor operation, closed
    /// before the Enter that follows it.
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

        assert_eq!(pending.kind, super::PendingInputKind::Logical);
        assert!(pending.data.starts_with(b"\x1b[200~"));
        assert!(pending.data.ends_with(b"\x1b[201~\r"));
        assert_eq!(
            &pending.data[6..pending.data.len() - 7],
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
        let mut expected = short.clone();
        expected.push(b'\r');

        assert_eq!(super::logical_message_bytes(short, true), expected);
    }

    #[test]
    fn a_long_message_is_not_framed_for_an_unadvertising_terminal() {
        let long = vec![b'x'; super::PASTE_FRAMING_MIN_LEN * 2];
        let mut expected = long.clone();
        expected.push(b'\r');

        assert_eq!(super::logical_message_bytes(long, false), expected);
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

        assert_eq!(pending.kind, super::PendingInputKind::Logical);
        assert_eq!(pending.data, b"/quit\r");
        handle.kill().await.unwrap();
    }

    /// The delivery the owner directive is about. A declared draft is a fact
    /// about the composer's *attestation*, and never a reason to hold a
    /// message back.
    #[tokio::test]
    async fn a_declared_draft_does_not_hold_the_message_back() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"half typed".to_vec(), RawInputKind::Draft)
            .expect("declare a raw draft");
        assert_eq!(input_rx.recv().await.expect("draft").data, b"half typed");

        let written = handle
            .enqueue_logical_input(b"owner reply".to_vec())
            .expect("accept logical input");
        let delivered = input_rx
            .recv()
            .await
            .expect("the message goes out over the draft");
        assert_eq!(delivered.data, b"owner reply\r");
        delivered.acknowledge_written();
        written.await.expect("the delivery is acknowledged");
        handle.kill().await.unwrap();
    }

    /// A producer can declare a draft but cannot un-declare one, so a
    /// history-recall key that found nothing to recall leaves the ledger
    /// armed over a composer that holds no line. The composer's own rendered
    /// emptiness is the evidence that resolves it, and it is the same evidence
    /// that resolves an inherited unknown state.
    #[tokio::test]
    async fn a_declared_draft_over_a_provably_empty_composer_attests_not_typed() {
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
        assert_eq!(handle.composer_attestation(), ComposerAttestation::Typed);

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
        assert_eq!(handle.composer_attestation(), ComposerAttestation::NotTyped);
        handle.kill().await.unwrap();
    }

    /// A frame older than the declared draft is not evidence about it: the
    /// keystroke has not reached the terminal yet, so the composer renders
    /// empty because the draft has not landed, not because there is none.
    #[tokio::test]
    async fn a_declared_draft_still_queued_for_the_pty_is_never_attested_away() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"h".to_vec(), RawInputKind::Draft)
            .expect("declare a raw draft");

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
        assert_eq!(handle.composer_attestation(), ComposerAttestation::Typed);
        assert_eq!(input_rx.recv().await.expect("draft").data, b"h");
        handle.kill().await.unwrap();
    }

    /// An empty declared draft must not be counted as a write to wait for.
    ///
    /// The writer drops an empty raw input without ever completing it, so a
    /// counted one leaves the completed total permanently short and every
    /// later attestation refuses — leaving the session reporting `typed`
    /// forever, which is exactly the state that lets provider chrome be read
    /// as a human's words. Any producer can send one; nothing on the way in
    /// rejects an empty payload.
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
        assert_eq!(handle.composer_attestation(), ComposerAttestation::NotTyped);
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
        assert_eq!(handle.composer_attestation(), ComposerAttestation::Typed);

        // One repaint after the write is the evidence that was missing.
        handle
            .mirror_output(b"\x1b[2J\x1b[H* Done.\r\n\xe2\x9d\xaf \r\n", false)
            .await
            .expect("render the composer after the draft landed");
        assert!(handle
            .attest_empty_composer()
            .await
            .expect("attest the refreshed composer"));
        assert_eq!(handle.composer_attestation(), ComposerAttestation::NotTyped);
        handle.kill().await.unwrap();
    }

    /// A frame that does not prove the composer empty never clears the ledger,
    /// so text a person really typed keeps attesting `typed` and nothing may
    /// read it as provider chrome.
    #[tokio::test]
    async fn a_composer_holding_text_is_never_attested_empty() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"half typed".to_vec(), RawInputKind::Draft)
            .expect("declare a raw draft");
        assert_eq!(input_rx.recv().await.expect("draft").data, b"half typed");

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
        assert_eq!(handle.composer_attestation(), ComposerAttestation::Typed);
        handle.kill().await.unwrap();
    }

    /// A current daemon hands over no retained messages, because it retains
    /// none: everything accepted has already gone to the writer.
    #[tokio::test]
    async fn a_handoff_snapshot_carries_no_retained_logical_input() {
        let handle = spawn_test_handle(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("accept logical input");
        assert_eq!(
            input_rx.recv().await.expect("logical message").data,
            b"manager message\r"
        );

        handle
            .handoff_parts()
            .await
            .expect("snapshot session")
            .expect("live session");
        handle.kill().await.unwrap();
    }

    /// A predecessor built before the hold was removed can still be holding an
    /// owner's message. Adopting it submits those messages rather than
    /// dropping somebody's words on the upgrade that removed the hold.
    #[tokio::test]
    async fn an_adopted_session_submits_the_messages_its_predecessor_held() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.pending_logical_inputs = vec![b"owner one".to_vec(), b"owner two".to_vec()];
        let handle = Arc::new(SessionHandle::new(record));
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        assert_eq!(
            input_rx.recv().await.expect("first held message").data,
            b"owner one\r"
        );
        assert_eq!(
            input_rx.recv().await.expect("second held message").data,
            b"owner two\r"
        );
        handle.kill().await.unwrap();
    }

    /// The refusal the owner directive removed. A session whose inherited
    /// draft state this daemon never observed used to answer every delivery
    /// with a 409 until a human typed into that terminal — the wedge that let
    /// an owner's answer to a consultation never arrive at all. It now
    /// delivers, and only its composer attestation stays honest about what it
    /// cannot prove.
    #[tokio::test]
    async fn an_unattested_session_still_delivers_logical_input() {
        let mut record = spawn_test_record(AgentProvider::Codex, SessionStatus::Idle).unwrap();
        record.raw_input_draft_state_known = false;
        let handle = Arc::new(SessionHandle::new(record));
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        assert_eq!(handle.composer_attestation(), ComposerAttestation::Unknown);
        let written = handle
            .enqueue_logical_input(b"manager message".to_vec())
            .expect("an unattested session still accepts logical input");
        let delivered = input_rx.recv().await.expect("logical delivery");
        assert_eq!(delivered.data, b"manager message\r");
        delivered.acknowledge_written();
        written.await.expect("the delivery is acknowledged");
        assert_eq!(
            handle.composer_attestation(),
            ComposerAttestation::Unknown,
            "delivering proves nothing about what was already on that composer"
        );
        handle.kill().await.unwrap();
    }

    /// An inherited session that nobody has typed into can still earn an
    /// attestation with no human and no bytes written: a frame that renders
    /// the provider's own empty composer proves nobody typed there.
    #[tokio::test]
    async fn inherited_unknown_draft_state_attests_from_a_provably_empty_composer() {
        let mut record = spawn_test_record(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        record.raw_input_draft_state_known = false;
        let handle = Arc::new(SessionHandle::new(record));
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        assert_eq!(handle.composer_attestation(), ComposerAttestation::Unknown);

        handle
            .mirror_output(b"\x1b[2J\x1b[H* Done.\r\n\xe2\x9d\xaf \r\n", false)
            .await
            .expect("render an idle composer");

        assert!(handle
            .attest_empty_composer()
            .await
            .expect("attest the rendered composer"));
        assert_eq!(handle.composer_attestation(), ComposerAttestation::NotTyped);
        assert!(
            input_rx.try_recv().is_err(),
            "attestation must write nothing of its own to the PTY"
        );
        handle.kill().await.unwrap();
    }

    /// Attestation resolves emptiness, never a draft. A composer holding text
    /// this daemon never saw typed stays `unknown` — nothing here can say who
    /// wrote it, so nothing may read it as an instruction.
    #[tokio::test]
    async fn an_inherited_composer_holding_text_stays_unknown() {
        let mut record = spawn_test_record(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        record.raw_input_draft_state_known = false;
        let handle = Arc::new(SessionHandle::new(record));
        let _input_rx = handle.take_input_rx().await.expect("input queue");

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
        assert_eq!(handle.composer_attestation(), ComposerAttestation::Unknown);
        handle.kill().await.unwrap();
    }

    /// A plain shell has no composer chrome to read, so the only thing that
    /// can resolve its attestation remains an explicit producer boundary.
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
        assert_eq!(handle.composer_attestation(), ComposerAttestation::Unknown);
        handle.kill().await.unwrap();
    }

    #[tokio::test]
    async fn a_spawned_session_starts_attested() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();

        assert_eq!(handle.composer_attestation(), ComposerAttestation::NotTyped);
        assert!(!handle
            .attest_empty_composer()
            .await
            .expect("attestation is a no-op for a session with nothing to resolve"));
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
    /// the first as the second would assert that a real unsent line the
    /// successor never saw typed is provider chrome.
    #[tokio::test]
    async fn an_uncounted_inherited_draft_attests_unknown_not_not_typed() {
        let mut record = spawn_test_record(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        record.raw_input_draft_active = true;
        record.typed_draft_bytes = None;
        let handle = Arc::new(SessionHandle::new(record));

        assert_eq!(handle.composer_attestation(), ComposerAttestation::Unknown);
        handle.kill().await.unwrap();
    }

    /// The 2026-09-07 owner report. The CLI paints its last submitted line
    /// back as a faint tab-to-accept ghost, so no frame will ever read that
    /// composer textually empty; only the ledger can say the text is chrome
    /// rather than somebody's words. Zero typed bytes is the proof the frame
    /// cannot give.
    #[tokio::test]
    async fn a_rendered_suggestion_over_an_untyped_composer_attests_not_typed() {
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

        assert_eq!(
            handle.composer_attestation(),
            ComposerAttestation::NotTyped,
            "nothing was typed, so the rendered line is the provider's own"
        );
        handle.kill().await.unwrap();
    }

    /// The other half of the same rule: once a human really has typed, the
    /// suggestion-shaped frame proves nothing and the composer keeps attesting
    /// `typed`.
    #[tokio::test]
    async fn a_genuinely_typed_draft_still_attests_typed_behind_a_suggestion_shaped_frame() {
        let handle = spawn_test_handle(AgentProvider::Claude, SessionStatus::Idle).unwrap();
        let mut input_rx = handle.take_input_rx().await.expect("input queue");

        handle
            .enqueue_raw_input(b"check again in a minute".to_vec(), RawInputKind::Draft)
            .expect("declare a real human draft");
        assert_eq!(handle.composer_attestation(), ComposerAttestation::Typed);
        handle
            .complete_declared_draft_write()
            .expect("the declared draft reaches the PTY");
        handle
            .mirror_output(CLAUDE_FRAME_WITH_SUGGESTION, false)
            .await
            .expect("render the typed line at the prompt");

        assert!(!handle
            .attest_empty_composer()
            .await
            .expect("read the rendered composer"));
        assert_eq!(
            handle.composer_attestation(),
            ComposerAttestation::Typed,
            "a counted draft is protected exactly as before"
        );
        assert_eq!(
            input_rx.recv().await.expect("draft").data,
            b"check again in a minute"
        );
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
