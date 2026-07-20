//! Lag-aware terminal event fanout.
//!
//! Every attached writer and passive observer owns a byte-bounded mailbox
//! drained by a dedicated writer task. The PTY ingestion loop only ever
//! enqueues without awaiting, so no subscriber's socket or WebSocket progress
//! can delay PTY reads, headless terminal mirroring, recovery persistence, or
//! healthy subscribers.
//!
//! A subscriber whose undelivered backlog exceeds its byte budget is marked
//! lagged: further output is dropped for it (bounded memory) while everyone
//! else streams on. Once its backlog fully drains, the next chunk resyncs it
//! in place with a fresh authoritative headless-terminal snapshot — the same
//! snapshot-first contract every consumer already implements for attach and
//! reattach — instead of disconnecting it and forcing reconnect churn.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kanna_daemon::protocol::Event;
use kanna_daemon::terminal_perf::{self, TerminalPerfContext, TerminalPerfEvent};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Mutex};

use crate::client::SessionWriter;

/// Undelivered serialized bytes allowed per subscriber before it is treated
/// as lagging. Sized so ordinary bursts of fast terminal output buffer
/// through while a wedged consumer is bounded to a few MiB on top of the
/// kernel socket buffers.
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
    lagged_since: Option<Instant>,
    writer: SessionWriter,
    writer_task: tokio::task::JoinHandle<()>,
}

impl Subscriber {
    fn perf_context(&self, line: &EventLine) -> TerminalPerfContext {
        let mut context =
            TerminalPerfContext::new("daemon", self.session_id.clone(), self.kind.write_stage());
        context.chunk = line.chunk;
        context.bytes = line.bytes;
        context.queue_available =
            Some(mailbox_max_bytes().saturating_sub(self.pending_bytes.load(Ordering::Relaxed)));
        context.queue_capacity = Some(mailbox_max_bytes());
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
#[derive(Default)]
pub(crate) struct FanoutState {
    streaming: bool,
    attached: Vec<Subscriber>,
    observers: Vec<Subscriber>,
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
    /// same writer is replaced.
    pub(crate) fn register(
        &mut self,
        session_id: &str,
        kind: SubscriberKind,
        writer: &SessionWriter,
        initial_events: &[Event],
    ) {
        let writer_id = Arc::as_ptr(writer) as usize;
        self.list_mut(kind)
            .retain(|subscriber| subscriber.writer_id != writer_id);

        let (tx, rx) = mpsc::unbounded_channel();
        let pending_bytes = Arc::new(AtomicUsize::new(0));
        let writer_task = spawn_writer_task(
            session_id.to_string(),
            kind,
            writer.clone(),
            rx,
            pending_bytes.clone(),
        );
        let subscriber = Subscriber {
            writer_id,
            kind,
            session_id: session_id.to_string(),
            tx,
            pending_bytes,
            lagged_since: None,
            writer: writer.clone(),
            writer_task,
        };
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
        let mut report = EnqueueReport::default();
        for list in [&mut self.attached, &mut self.observers] {
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
                if pending + line.line.len() > mailbox_max_bytes() {
                    subscriber.lagged_since = Some(Instant::now());
                    report.newly_lagged.push(TerminalPerfEvent {
                        context: subscriber.perf_context(line),
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
    /// queueing a fresh authoritative snapshot, and return the recovery
    /// diagnostics to emit. Call with the snapshot taken under the same
    /// fanout lock, after the current chunk was mirrored.
    pub(crate) fn resync_drained(&mut self, snapshot_event: &Event) -> Vec<TerminalPerfEvent> {
        let Some(line) = EventLine::serialize(snapshot_event, 0, 0) else {
            return Vec::new();
        };
        let mut recovered = Vec::new();
        for list in [&mut self.attached, &mut self.observers] {
            for subscriber in list.iter_mut() {
                let Some(lagged_since) = subscriber.lagged_since else {
                    continue;
                };
                if subscriber.pending_bytes.load(Ordering::Relaxed) != 0 {
                    continue;
                }
                if subscriber.enqueue(line.clone()).is_err() {
                    continue;
                }
                subscriber.lagged_since = None;
                recovered.push(TerminalPerfEvent {
                    context: subscriber.perf_context(&line),
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

    /// Remove a subscriber registration; its writer task drains any queued
    /// events and then finishes.
    pub(crate) fn remove(&mut self, kind: SubscriberKind, writer_id: usize) {
        self.list_mut(kind)
            .retain(|subscriber| subscriber.writer_id != writer_id);
    }

    /// Remove every registration owned by a disconnected client connection.
    pub(crate) fn remove_writer_everywhere(&mut self, writer_id: usize) {
        self.attached
            .retain(|subscriber| subscriber.writer_id != writer_id);
        self.observers
            .retain(|subscriber| subscriber.writer_id != writer_id);
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.attached.is_empty() && self.observers.is_empty()
    }

    fn list_mut(&mut self, kind: SubscriberKind) -> &mut Vec<Subscriber> {
        match kind {
            SubscriberKind::Attached => &mut self.attached,
            SubscriberKind::Observer => &mut self.observers,
        }
    }
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
}

impl SessionFanout {
    fn new() -> Self {
        Self {
            state: Mutex::new(FanoutState::default()),
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

fn spawn_writer_task(
    session_id: String,
    kind: SubscriberKind,
    writer: SessionWriter,
    mut rx: mpsc::UnboundedReceiver<EventLine>,
    pending_bytes: Arc<AtomicUsize>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(item) = rx.recv().await {
            let mut context =
                TerminalPerfContext::new("daemon", session_id.clone(), kind.write_stage());
            context.chunk = item.chunk;
            context.bytes = item.bytes;
            let operation = terminal_perf::global_monitor().begin(context);
            let result = {
                let mut guard = writer.lock().await;
                match guard.write_all(item.line.as_bytes()).await {
                    Ok(()) => guard.flush().await,
                    Err(error) => Err(error),
                }
            };
            operation.finish();
            pending_bytes.fetch_sub(item.line.len(), Ordering::Relaxed);
            if result.is_err() {
                return;
            }
        }
    })
}
