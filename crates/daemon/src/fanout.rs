//! Lag-aware terminal event fanout.
//!
//! Every attached writer and passive observer owns a mailbox (an unbounded
//! channel guarded by byte-budget accounting — the budget, not the channel,
//! bounds memory) drained by a dedicated writer task. The PTY ingestion loop only ever
//! enqueues without awaiting, so no subscriber's socket or WebSocket progress
//! can delay PTY reads, headless terminal mirroring, recovery persistence, or
//! healthy subscribers.
//!
//! A subscriber whose undelivered backlog exceeds its byte budget is marked
//! lagged: further output is dropped for it (bounded memory) while everyone
//! else streams on. Once its backlog fully drains, the writer wakes the
//! session reader to resync it in place with a fresh authoritative
//! headless-terminal snapshot — the same snapshot-first contract every
//! consumer already implements for attach and reattach — instead of
//! disconnecting it and forcing reconnect churn.
//!
//! Memory bound: a subscriber's queued bytes never exceed
//! `max(budget, one authoritative snapshot + initial status events)`.
//! Snapshot lines are deliberately exempt from the budget — an authoritative
//! snapshot larger than the budget must still be deliverable or resync would
//! deadlock — but they are only ever queued into an *empty* mailbox: at
//! registration (fresh mailbox) and at resync (which requires a fully
//! drained backlog). A subscriber slower than snapshot-sized bursts
//! therefore degrades to snapshot-paced delivery (lag -> drain -> fresh
//! snapshot) without the exemption ever accumulating.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kanna_daemon::protocol::Event;
use kanna_daemon::terminal_perf::{self, TerminalPerfContext, TerminalPerfEvent};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Mutex};

use crate::client::SessionWriter;

/// Undelivered serialized bytes of live output allowed per subscriber before
/// it is treated as lagging. Sized so ordinary bursts of fast terminal output
/// buffer through while a wedged consumer is bounded to a few MiB on top of
/// the kernel socket buffers. Authoritative snapshots are exempt but only
/// enter an empty mailbox; see the module docs for the exact bound.
pub(crate) const SUBSCRIBER_MAILBOX_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Test-only override so integration tests can trigger mailbox overflow
/// without flooding megabytes through debug-build JSON parsing.
fn mailbox_max_bytes() -> usize {
    static LIMIT: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *LIMIT.get_or_init(|| {
        std::env::var("KANNA_DAEMON_TEST_SUBSCRIBER_MAILBOX_MAX_BYTES")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(SUBSCRIBER_MAILBOX_MAX_BYTES)
    })
}

const LAG_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SubscriberKind {
    Attached,
    Observer,
}

impl SubscriberKind {
    fn write_stage(self) -> &'static str {
        match self {
            Self::Attached => "attached_writer",
            Self::Observer => "observer_write",
        }
    }
}

/// One pre-serialized NDJSON line (newline included), shared by every
/// subscriber mailbox so fanout serializes each event exactly once.
#[derive(Clone)]
pub(crate) struct EventLine {
    line: Arc<str>,
    chunk: u64,
    bytes: usize,
}

impl EventLine {
    pub(crate) fn serialize(event: &Event, chunk: u64, bytes: usize) -> Option<Self> {
        match serde_json::to_string(event) {
            Ok(mut json) => {
                json.push('\n');
                Some(Self {
                    line: Arc::from(json.as_str()),
                    chunk,
                    bytes,
                })
            }
            Err(error) => {
                log::error!("[fanout] failed to serialize event: {}", error);
                None
            }
        }
    }
}

pub(crate) struct Subscriber {
    writer_id: usize,
    kind: SubscriberKind,
    session_id: String,
    tx: mpsc::UnboundedSender<EventLine>,
    /// Serialized bytes enqueued but not yet written to the socket. Shared
    /// with the writer task, which subtracts after each completed write.
    pending_bytes: Arc<AtomicUsize>,
    /// Shared with the writer task so draining the retained backlog can wake
    /// the session recovery path without waiting for another PTY chunk.
    lagged: Arc<AtomicBool>,
    /// Set when this registration is replaced or removed. The writer task
    /// checks it under the socket writer lock before every write, so once a
    /// replacement registration has written anything (e.g. its fresh
    /// snapshot), no stale queued line from this registration can follow it.
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    lagged_since: Option<Instant>,
    writer: SessionWriter,
    writer_task: tokio::task::JoinHandle<()>,
}

impl Subscriber {
    /// Stop this registration's writer stream: any in-flight line completes
    /// (lines stay whole on the socket), everything still queued is
    /// discarded. Required when the same connection re-registers so the new
    /// registration's snapshot is the cutover boundary.
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn perf_context(&self, line: &EventLine, budget: usize) -> TerminalPerfContext {
        let mut context =
            TerminalPerfContext::new("daemon", self.session_id.clone(), self.kind.write_stage());
        context.chunk = line.chunk;
        context.bytes = line.bytes;
        context.queue_available =
            Some(budget.saturating_sub(self.pending_bytes.load(Ordering::Relaxed)));
        context.queue_capacity = Some(budget);
        context
    }

    fn enqueue(&self, item: EventLine) -> Result<(), ()> {
        self.pending_bytes
            .fetch_add(item.line.len(), Ordering::Relaxed);
        self.tx.send(item).map_err(|dropped| {
            self.pending_bytes
                .fetch_sub(dropped.0.line.len(), Ordering::Relaxed);
        })
    }

    /// Force-disconnect a subscriber that cannot be delivered a final event
    /// (session exit/kill with a still-full backlog). Aborting the writer
    /// task drops any in-flight write (releasing the shared socket writer
    /// lock), then the write half is shut down so the client observes EOF
    /// instead of waiting on a silent stream.
    pub(crate) fn disconnect(self) {
        self.writer_task.abort();
        let writer = self.writer;
        let session_id = self.session_id;
        tokio::spawn(async move {
            let shutdown = tokio::time::timeout(LAG_SHUTDOWN_TIMEOUT, async {
                let _ = writer.lock().await.shutdown().await;
            })
            .await;
            if shutdown.is_err() {
                log::warn!(
                    "[fanout] timed out shutting down disconnected subscriber socket session={}",
                    session_id
                );
            }
        });
    }
}

/// Per-session subscriber registry. The PTY ingestion loop holds this lock
/// across (mirror -> enqueue) and `AttachSnapshot` holds it across
/// (snapshot -> register), which makes the snapshot-to-live cutover atomic:
/// any chunk is either fully contained in the snapshot or fully enqueued
/// behind it. The lock is never held across a client-progress await.
pub(crate) struct FanoutState {
    /// Per-subscriber byte budget for live output; see the module docs for
    /// the exact bound and the snapshot exemption.
    budget: usize,
    recovery_notify: Arc<tokio::sync::Notify>,
    streaming: bool,
    attached: Vec<Subscriber>,
    observers: Vec<Subscriber>,
}

impl Default for FanoutState {
    fn default() -> Self {
        Self {
            budget: mailbox_max_bytes(),
            recovery_notify: Arc::new(tokio::sync::Notify::new()),
            streaming: false,
            attached: Vec::new(),
            observers: Vec::new(),
        }
    }
}

impl FanoutState {
    pub(crate) fn streaming(&self) -> bool {
        self.streaming
    }

    pub(crate) fn mark_streaming(&mut self) {
        self.streaming = true;
    }

    /// Register a subscriber, queueing its initial events (snapshot, current
    /// status) ahead of any live output. An existing registration for the
    /// same writer is replaced and its writer stream cancelled, so on a
    /// same-connection reattach the fresh snapshot is the cutover boundary:
    /// no output queued for the old registration can be delivered after it.
    pub(crate) fn register(
        &mut self,
        session_id: &str,
        kind: SubscriberKind,
        writer: &SessionWriter,
        initial_events: &[Event],
    ) {
        let writer_id = Arc::as_ptr(writer) as usize;
        cancel_and_remove(self.list_mut(kind), writer_id);

        let (tx, rx) = mpsc::unbounded_channel();
        let pending_bytes = Arc::new(AtomicUsize::new(0));
        let lagged = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer_task = spawn_writer_task(WriterTask {
            session_id: session_id.to_string(),
            kind,
            writer: writer.clone(),
            rx,
            pending_bytes: pending_bytes.clone(),
            lagged: lagged.clone(),
            recovery_notify: self.recovery_notify.clone(),
            cancelled: cancelled.clone(),
        });
        let subscriber = Subscriber {
            writer_id,
            kind,
            session_id: session_id.to_string(),
            tx,
            pending_bytes,
            lagged,
            cancelled,
            lagged_since: None,
            writer: writer.clone(),
            writer_task,
        };
        // Initial events (snapshot + status) enter a freshly created, empty
        // mailbox: this is one of the two places the snapshot exemption from
        // the byte budget applies (see the module docs), and it cannot
        // accumulate because nothing else is queued yet.
        for event in initial_events {
            if let Some(line) = EventLine::serialize(event, 0, 0) {
                let _ = subscriber.enqueue(line);
            }
        }
        self.list_mut(kind).push(subscriber);
    }

    /// Enqueue one event line to every subscriber without awaiting any of
    /// them. A subscriber whose undelivered backlog exceeds its byte budget
    /// transitions to lagged (returned for diagnostics) and stops receiving
    /// output until [`FanoutState::resync_drained`] resyncs it; subscribers
    /// whose writer task already ended are dropped. Returns the lag
    /// diagnostics to emit and whether any lagged subscriber has fully
    /// drained and is ready for a snapshot resync.
    pub(crate) fn enqueue(&mut self, line: &EventLine) -> EnqueueReport {
        let budget = self.budget;
        let mut report = EnqueueReport::default();
        for list in [&mut self.attached, &mut self.observers] {
            enqueue_to_list(list, line, budget, &mut report);
        }
        report
    }

    /// True when at least one lagged subscriber has fully drained its
    /// backlog and awaits a snapshot resync.
    pub(crate) fn has_drained_lagged(&self) -> bool {
        self.attached
            .iter()
            .chain(self.observers.iter())
            .any(|subscriber| {
                subscriber.lagged_since.is_some()
                    && subscriber.pending_bytes.load(Ordering::Relaxed) == 0
            })
    }

    /// Resync every lagged subscriber whose backlog has fully drained by
    /// queueing fresh authoritative recovery events, and return the recovery
    /// diagnostics to emit. Call with the snapshot and current status taken
    /// under the same fanout lock, after the current chunk was mirrored.
    pub(crate) fn resync_drained(&mut self, events: &[Event]) -> Vec<TerminalPerfEvent> {
        let budget = self.budget;
        let lines: Option<Vec<_>> = events
            .iter()
            .map(|event| EventLine::serialize(event, 0, 0))
            .collect();
        let Some(lines) = lines else {
            return Vec::new();
        };
        let Some(perf_line) = lines.first() else {
            return Vec::new();
        };
        let mut recovered = Vec::new();
        for list in [&mut self.attached, &mut self.observers] {
            for subscriber in list.iter_mut() {
                let Some(lagged_since) = subscriber.lagged_since else {
                    continue;
                };
                // The snapshot is exempt from the byte budget but only ever
                // enters an empty mailbox (see the module docs): a drained
                // backlog is the resync precondition, so queued bytes are
                // bounded by the snapshot itself.
                if subscriber.pending_bytes.load(Ordering::Relaxed) != 0 {
                    continue;
                }
                if lines
                    .iter()
                    .try_for_each(|line| subscriber.enqueue(line.clone()))
                    .is_err()
                {
                    continue;
                }
                subscriber.lagged_since = None;
                subscriber.lagged.store(false, Ordering::Release);
                recovered.push(TerminalPerfEvent {
                    context: subscriber.perf_context(perf_line, budget),
                    kind: terminal_perf::TerminalPerfEventKind::Recovered,
                    duration: lagged_since.elapsed(),
                });
            }
        }
        recovered
    }

    /// Deliver a final event (exit/kill). Subscribers that still cannot take
    /// it are disconnected so their client observes EOF instead of a silent
    /// stream.
    pub(crate) fn deliver_final(&mut self, event: &Event) {
        let Some(line) = EventLine::serialize(event, 0, 0) else {
            return;
        };
        for list in [&mut self.attached, &mut self.observers] {
            for subscriber in list.drain(..) {
                if subscriber.lagged_since.is_some() || subscriber.enqueue(line.clone()).is_err() {
                    subscriber.disconnect();
                }
            }
        }
    }

    /// Remove a subscriber registration. Its writer stream is cancelled:
    /// undelivered queued events are discarded so they cannot surface after
    /// a later re-registration's fresh snapshot on the same connection.
    pub(crate) fn remove(&mut self, kind: SubscriberKind, writer_id: usize) {
        cancel_and_remove(self.list_mut(kind), writer_id);
    }

    /// Remove every registration owned by a disconnected client connection.
    pub(crate) fn remove_writer_everywhere(&mut self, writer_id: usize) {
        cancel_and_remove(&mut self.attached, writer_id);
        cancel_and_remove(&mut self.observers, writer_id);
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.attached.is_empty() && self.observers.is_empty()
    }

    #[cfg(test)]
    fn with_budget_for_test(budget: usize) -> Self {
        Self {
            budget,
            ..Self::default()
        }
    }

    #[cfg(test)]
    fn with_budget_and_recovery_notify_for_test(
        budget: usize,
        recovery_notify: Arc<tokio::sync::Notify>,
    ) -> Self {
        Self {
            budget,
            recovery_notify,
            ..Self::default()
        }
    }

    #[cfg(test)]
    fn pending_bytes_for_test(&self, kind: SubscriberKind, writer_id: usize) -> usize {
        let list = match kind {
            SubscriberKind::Attached => &self.attached,
            SubscriberKind::Observer => &self.observers,
        };
        list.iter()
            .find(|subscriber| subscriber.writer_id == writer_id)
            .map(|subscriber| subscriber.pending_bytes.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    fn list_mut(&mut self, kind: SubscriberKind) -> &mut Vec<Subscriber> {
        match kind {
            SubscriberKind::Attached => &mut self.attached,
            SubscriberKind::Observer => &mut self.observers,
        }
    }
}

fn enqueue_to_list(
    list: &mut Vec<Subscriber>,
    line: &EventLine,
    budget: usize,
    report: &mut EnqueueReport,
) {
    let mut index = 0;
    while index < list.len() {
        let subscriber = &mut list[index];
        if subscriber.tx.is_closed() {
            list.remove(index);
            continue;
        }
        if subscriber.lagged_since.is_some() {
            if subscriber.pending_bytes.load(Ordering::Relaxed) == 0 {
                report.resync_ready = true;
            }
            index += 1;
            continue;
        }
        let pending = subscriber.pending_bytes.load(Ordering::Relaxed);
        if pending + line.line.len() > budget {
            subscriber.lagged_since = Some(Instant::now());
            subscriber.lagged.store(true, Ordering::Release);
            if subscriber.pending_bytes.load(Ordering::Acquire) == 0 {
                report.resync_ready = true;
            }
            report.newly_lagged.push(TerminalPerfEvent {
                context: subscriber.perf_context(line, budget),
                kind: terminal_perf::TerminalPerfEventKind::Lag,
                duration: Duration::ZERO,
            });
            index += 1;
            continue;
        }
        if subscriber.enqueue(line.clone()).is_err() {
            list.remove(index);
            continue;
        }
        index += 1;
    }
}

fn cancel_and_remove(list: &mut Vec<Subscriber>, writer_id: usize) {
    list.retain(|subscriber| {
        if subscriber.writer_id == writer_id {
            subscriber.cancel();
            false
        } else {
            true
        }
    });
}

#[derive(Default)]
pub(crate) struct EnqueueReport {
    /// Lag diagnostics for subscribers that overflowed on this chunk.
    pub(crate) newly_lagged: Vec<TerminalPerfEvent>,
    /// At least one lagged subscriber has fully drained its backlog and
    /// should be resynced with a fresh snapshot.
    pub(crate) resync_ready: bool,
}

pub(crate) struct SessionFanout {
    pub(crate) state: Mutex<FanoutState>,
    pub(crate) recovery_notify: Arc<tokio::sync::Notify>,
    pub(crate) recovery_retry_scheduled: AtomicBool,
}

impl SessionFanout {
    pub(crate) fn new() -> Self {
        let recovery_notify = Arc::new(tokio::sync::Notify::new());
        Self {
            state: Mutex::new(FanoutState {
                recovery_notify: recovery_notify.clone(),
                ..FanoutState::default()
            }),
            recovery_notify,
            recovery_retry_scheduled: AtomicBool::new(false),
        }
    }
}

/// session_id -> fanout. Entry presence alone does not imply the session's
/// PTY reader is running; `FanoutState::streaming` tracks that (observers may
/// register before an adopted session's first attach starts the reader).
pub(crate) type SessionFanouts = Arc<Mutex<HashMap<String, Arc<SessionFanout>>>>;

pub(crate) async fn session_fanout(
    fanouts: &SessionFanouts,
    session_id: &str,
) -> Arc<SessionFanout> {
    fanouts
        .lock()
        .await
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(SessionFanout::new()))
        .clone()
}

pub(crate) async fn existing_session_fanout(
    fanouts: &SessionFanouts,
    session_id: &str,
) -> Option<Arc<SessionFanout>> {
    fanouts.lock().await.get(session_id).cloned()
}

struct WriterTask {
    session_id: String,
    kind: SubscriberKind,
    writer: SessionWriter,
    rx: mpsc::UnboundedReceiver<EventLine>,
    pending_bytes: Arc<AtomicUsize>,
    lagged: Arc<AtomicBool>,
    recovery_notify: Arc<tokio::sync::Notify>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

fn spawn_writer_task(task: WriterTask) -> tokio::task::JoinHandle<()> {
    let WriterTask {
        session_id,
        kind,
        writer,
        mut rx,
        pending_bytes,
        lagged,
        recovery_notify,
        cancelled,
    } = task;
    tokio::spawn(async move {
        while let Some(item) = rx.recv().await {
            let mut context =
                TerminalPerfContext::new("daemon", session_id.clone(), kind.write_stage());
            context.chunk = item.chunk;
            context.bytes = item.bytes;
            let operation = terminal_perf::global_monitor().begin(context);
            let result = {
                let mut guard = writer.lock().await;
                // Checked under the shared socket writer lock: if a
                // replacement registration already wrote its snapshot, the
                // lock ordering guarantees this load observes the
                // cancellation, so no stale line can follow that snapshot.
                if cancelled.load(Ordering::Acquire) {
                    drop(guard);
                    operation.finish();
                    pending_bytes.fetch_sub(item.line.len(), Ordering::Relaxed);
                    return;
                }
                match guard.write_all(item.line.as_bytes()).await {
                    Ok(()) => guard.flush().await,
                    Err(error) => Err(error),
                }
            };
            operation.finish();
            let pending_before = pending_bytes.fetch_sub(item.line.len(), Ordering::AcqRel);
            if pending_before == item.line.len() && lagged.load(Ordering::Acquire) {
                recovery_notify.notify_one();
            }
            if result.is_err() {
                return;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanna_daemon::protocol::{SessionStatus, TerminalSnapshot};

    fn test_writer() -> (SessionWriter, tokio::net::UnixStream) {
        let (client, server) = tokio::net::UnixStream::pair().expect("unix stream pair");
        let (_server_read, server_write) = server.into_split();
        (Arc::new(Mutex::new(server_write)), client)
    }

    fn output_line(bytes: usize) -> EventLine {
        EventLine::serialize(
            &Event::Output {
                session_id: "sess-budget".to_string(),
                data: vec![b'x'; bytes],
            },
            1,
            bytes,
        )
        .expect("serialize output line")
    }

    fn snapshot_event(vt_bytes: usize) -> Event {
        Event::Snapshot {
            session_id: "sess-budget".to_string(),
            snapshot: TerminalSnapshot {
                version: 1,
                rows: 24,
                cols: 80,
                cursor_row: 0,
                cursor_col: 0,
                cursor_visible: true,
                saved_at: 0,
                sequence: 0,
                vt: "S".repeat(vt_bytes),
            },
            agent_provider: None,
        }
    }

    /// The documented memory bound: live output never queues past the
    /// budget (over-budget chunks mark the subscriber lagged and are
    /// dropped), while an authoritative snapshot larger than the budget is
    /// still deliverable — but only into an empty mailbox, so queued bytes
    /// never exceed max(budget, one snapshot). Runs on the current-thread
    /// runtime so the writer task cannot drain between assertions.
    #[tokio::test]
    async fn drained_lag_resync_queues_snapshot_and_current_status_pair() {
        let (writer, _client) = test_writer();
        let writer_id = Arc::as_ptr(&writer) as usize;
        let mut state = FanoutState::with_budget_for_test(64);
        state.register("sess-budget", SubscriberKind::Observer, &writer, &[]);

        // A chunk whose serialized line exceeds the budget is never queued:
        // the subscriber transitions to lagged with zero retained bytes.
        let big_chunk = output_line(256);
        assert!(big_chunk.line.len() > 64);
        let report = state.enqueue(&big_chunk);
        assert_eq!(report.newly_lagged.len(), 1);
        assert_eq!(
            state.pending_bytes_for_test(SubscriberKind::Observer, writer_id),
            0
        );

        // While lagged, further chunks are dropped without growing the queue.
        let report = state.enqueue(&big_chunk);
        assert!(report.newly_lagged.is_empty());
        assert!(report.resync_ready);
        assert_eq!(
            state.pending_bytes_for_test(SubscriberKind::Observer, writer_id),
            0
        );

        // Deterministic resync: the drained subscriber accepts an
        // authoritative snapshot plus current status. The pair may be larger
        // than the budget but enters only this empty recovery mailbox.
        let snapshot = snapshot_event(64 * 1024);
        let snapshot_line_len = EventLine::serialize(&snapshot, 0, 0)
            .expect("serialize snapshot")
            .line
            .len();
        let status = Event::StatusChanged {
            session_id: "sess-budget".to_string(),
            status: SessionStatus::Waiting,
            waiting_prompt_snippet: Some("Waiting after lag".to_string()),
        };
        let status_line_len = EventLine::serialize(&status, 0, 0)
            .expect("serialize status")
            .line
            .len();
        let recovered = state.resync_drained(&[snapshot, status]);
        assert_eq!(recovered.len(), 1);
        let pending = state.pending_bytes_for_test(SubscriberKind::Observer, writer_id);
        assert_eq!(pending, snapshot_line_len + status_line_len);
        assert!(
            pending > 64,
            "the exemption must apply to the recovery pair"
        );

        // The exemption cannot accumulate: with the snapshot still queued,
        // the next over-budget chunk lags again instead of queueing.
        let report = state.enqueue(&big_chunk);
        assert_eq!(report.newly_lagged.len(), 1);
        assert_eq!(
            state.pending_bytes_for_test(SubscriberKind::Observer, writer_id),
            snapshot_line_len + status_line_len
        );
    }

    /// Registration queues its initial snapshot + status into a freshly
    /// created empty mailbox — the other site of the snapshot exemption —
    /// and live output beyond the budget still lags instead of queueing.
    #[tokio::test]
    async fn registration_initial_snapshot_enters_only_the_fresh_mailbox() {
        let (writer, _client) = test_writer();
        let writer_id = Arc::as_ptr(&writer) as usize;
        let mut state = FanoutState::with_budget_for_test(64);

        let snapshot = snapshot_event(16 * 1024);
        let status = Event::StatusChanged {
            session_id: "sess-budget".to_string(),
            status: SessionStatus::Idle,
            waiting_prompt_snippet: None,
        };
        let expected: usize = [&snapshot, &status]
            .into_iter()
            .map(|event| {
                EventLine::serialize(event, 0, 0)
                    .expect("serialize initial event")
                    .line
                    .len()
            })
            .sum();

        state.register(
            "sess-budget",
            SubscriberKind::Attached,
            &writer,
            &[snapshot, status],
        );
        let pending = state.pending_bytes_for_test(SubscriberKind::Attached, writer_id);
        assert_eq!(pending, expected);
        assert!(pending > 64, "initial snapshot is exempt from the budget");

        let report = state.enqueue(&output_line(256));
        assert_eq!(report.newly_lagged.len(), 1);
        assert_eq!(
            state.pending_bytes_for_test(SubscriberKind::Attached, writer_id),
            expected,
            "over-budget live output must never queue on top of the snapshot"
        );
    }

    #[tokio::test]
    async fn lagged_writer_notifies_when_mailbox_drains() {
        let (writer, _client) = test_writer();
        let writer_guard = writer.lock().await;
        let recovery_notify = Arc::new(tokio::sync::Notify::new());
        let mut state =
            FanoutState::with_budget_and_recovery_notify_for_test(2_048, recovery_notify.clone());
        state.register("sess-budget", SubscriberKind::Attached, &writer, &[]);

        let retained = output_line(256);
        assert!(retained.line.len() < 2_048);
        assert!(state.enqueue(&retained).newly_lagged.is_empty());

        let overflow = output_line(2_048);
        assert_eq!(state.enqueue(&overflow).newly_lagged.len(), 1);
        assert!(!state.has_drained_lagged());

        drop(writer_guard);
        tokio::time::timeout(Duration::from_secs(1), recovery_notify.notified())
            .await
            .expect("lag recovery should be notified as soon as the retained mailbox drains");
        assert!(state.has_drained_lagged());
    }
}
