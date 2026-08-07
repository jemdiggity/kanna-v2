//! `kanna-server` owns the `kanna-task-transfer` sidecar.
//!
//! The sidecar's control plane is unauthenticated newline-JSON over stdio,
//! trusted purely because it is a private pipe. Whoever holds that pipe owns
//! transfers, so it belongs to the process that owns the DB rows, the task
//! lifecycle actions, and the daemon event stream — this one. The server
//! already terminated the inbound half of the same relay
//! (`task_transfer_tunnel`); this module closes the split by owning the
//! process too.
//!
//! Lifecycle matches what the desktop did before: spawn lazily on the first
//! control request or on inbound tunnel demand, and transparently respawn once
//! the previous child is observed dead.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex, Notify};

/// One sidecar stdout line may carry a whole transfer payload; anything past
/// this is a runaway writer, not a message.
const MAX_SIDECAR_STDOUT_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Retention for events the desktop has not yet picked up. Mirrors the bounds
/// the desktop lifecycle queue applied before the move, for the same reason:
/// an absent consumer must not let the sidecar grow memory without limit.
const MAX_TRANSFER_EVENT_ENTRIES: usize = 256;
const MAX_TRANSFER_EVENT_BYTES: usize = 8 * 1024 * 1024;

type PendingRequests = Arc<StdMutex<HashMap<String, oneshot::Sender<Value>>>>;

/// Sidecar events whose delivery changes state on the receiving side. These
/// are never evicted to make room: losing one loses a transfer step. Broadcast
/// events (pairing progress, terminal output) are advisory and evictable.
fn is_durable_transfer_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "incoming_transfer_request"
            | "task_pull_requested"
            | "outgoing_transfer_committed"
            | "outgoing_transfer_finalization_requested"
    )
}

fn transfer_event_type(value: &Value) -> Option<&str> {
    let event_type = value.get("type").and_then(Value::as_str)?;
    matches!(
        event_type,
        "pairing_started"
            | "pairing_requested"
            | "pairing_completed"
            | "incoming_transfer_request"
            | "task_pull_requested"
            | "outgoing_transfer_committed"
            | "outgoing_transfer_finalization_requested"
            | "terminal_event"
    )
    .then_some(event_type)
}

struct TransferEventEntry {
    seq: u64,
    durable: bool,
    bytes: usize,
    event: Value,
}

#[derive(Default)]
struct TransferEventLogInner {
    entries: VecDeque<TransferEventEntry>,
    bytes: usize,
    next_seq: u64,
    /// Highest sequence discarded to make room. A consumer whose cursor sits
    /// below this missed advisory events and is told so rather than silently
    /// skipping them.
    evicted_through_seq: u64,
}

/// Single-consumer log of sidecar events, read by the desktop process over
/// `GET /v1/transfers/sidecar/events`.
///
/// Single-consumer is the contract, not an accident: reading through a cursor
/// prunes everything at or below it, which is what keeps durable events from
/// accumulating forever when the sidecar is busy. One desktop process owns one
/// server, so there is exactly one reader.
pub struct TransferEventLog {
    /// Identifies this in-memory sequence space. Unlike `/v1/task-events`,
    /// whose cursor is a durable `task_event.seq`, these sequences restart at
    /// zero with every server process — and `kanna-server` restarts
    /// independently of the desktop that holds the cursor. Without this, a
    /// cursor carried across a restart would prune and discard the first N
    /// events of the fresh log, durable lifecycle events included, and report
    /// nothing missed.
    stream_id: String,
    inner: StdMutex<TransferEventLogInner>,
    appended: Notify,
    drained: Notify,
}

impl Default for TransferEventLog {
    fn default() -> Self {
        Self {
            stream_id: new_transfer_event_stream_id(),
            inner: StdMutex::new(TransferEventLogInner::default()),
            appended: Notify::new(),
            drained: Notify::new(),
        }
    }
}

/// Only has to distinguish one server process's log from the next one's, so
/// the pid plus a start timestamp is enough — this is not a secret and is
/// never used for authorization. The counter keeps two logs constructed inside
/// one clock tick distinct, which the timestamp alone does not guarantee.
fn new_transfer_event_stream_id() -> String {
    static NEXT_STREAM: AtomicU64 = AtomicU64::new(1);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!(
        "{}-{nanos}-{}",
        std::process::id(),
        NEXT_STREAM.fetch_add(1, Ordering::Relaxed)
    )
}

pub struct TransferEventBatch {
    pub events: Vec<Value>,
    pub cursor: u64,
    pub stream_id: String,
    pub has_more: bool,
    pub missed_events: bool,
}

impl TransferEventLog {
    fn lock(&self) -> std::sync::MutexGuard<'_, TransferEventLogInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Append one event, evicting advisory entries when the log is full.
    /// Returns `false` when only durable entries remain, so the caller applies
    /// backpressure to the sidecar reader instead of dropping a transfer step.
    fn try_append(&self, event: Value, durable: bool) -> bool {
        let bytes = serde_json::to_vec(&event).map(|raw| raw.len()).unwrap_or(0);
        let mut inner = self.lock();
        while inner.entries.len() >= MAX_TRANSFER_EVENT_ENTRIES
            || inner.bytes.saturating_add(bytes) > MAX_TRANSFER_EVENT_BYTES
        {
            let Some(index) = inner.entries.iter().position(|entry| !entry.durable) else {
                return false;
            };
            let Some(evicted) = inner.entries.remove(index) else {
                return false;
            };
            inner.bytes = inner.bytes.saturating_sub(evicted.bytes);
            inner.evicted_through_seq = inner.evicted_through_seq.max(evicted.seq);
        }
        inner.next_seq = inner.next_seq.saturating_add(1);
        let seq = inner.next_seq;
        inner.bytes = inner.bytes.saturating_add(bytes);
        inner.entries.push_back(TransferEventEntry {
            seq,
            durable,
            bytes,
            event,
        });
        drop(inner);
        self.appended.notify_waiters();
        true
    }

    async fn append(&self, event: Value, durable: bool) {
        loop {
            // Arm the wake-up before attempting the append: a drain landing
            // between the failed try and the await must not be missed.
            let mut drained = Box::pin(self.drained.notified());
            drained.as_mut().enable();
            if self.try_append(event.clone(), durable) {
                return;
            }
            drained.await;
        }
    }

    /// Read everything after `cursor` and prune through it. `None` starts from
    /// whatever is still retained.
    ///
    /// A cursor is discarded only when `stream_id` names a *different* log: that
    /// is positive proof it came from an earlier server process and addresses a
    /// sequence space that no longer exists, so applying it would prune
    /// positions it never referred to. The batch then says events were missed.
    ///
    /// An *absent* `stream_id` is not that proof, and must not be treated as it.
    /// A desktop from before the stream id existed sends `cursor` alone, and
    /// refusing every such poll would mean never pruning — the caller would be
    /// redelivered the same retained events forever while durable entries piled
    /// up to the cap, at which point appends backpressure the sidecar's stdout
    /// reader and the whole control plane wedges. That is a worse failure than
    /// the stale-cursor one, so a bare cursor keeps the original sequence
    /// semantics.
    pub fn read(
        &self,
        cursor: Option<u64>,
        stream_id: Option<&str>,
        limit: usize,
    ) -> TransferEventBatch {
        let mut inner = self.lock();
        let stale_cursor = cursor.is_some() && stream_id.is_some_and(|id| id != self.stream_id);
        let after_seq = if stale_cursor { 0 } else { cursor.unwrap_or(0) };
        let missed_events =
            stale_cursor || cursor.is_some_and(|seq| seq < inner.evicted_through_seq);
        while inner
            .entries
            .front()
            .is_some_and(|entry| entry.seq <= after_seq)
        {
            if let Some(entry) = inner.entries.pop_front() {
                inner.bytes = inner.bytes.saturating_sub(entry.bytes);
            }
        }
        let mut events = Vec::new();
        let mut batch_cursor = after_seq.max(
            inner
                .entries
                .front()
                .map(|entry| entry.seq.saturating_sub(1))
                .unwrap_or(inner.next_seq),
        );
        for entry in inner.entries.iter().take(limit) {
            events.push(json!({
                "seq": entry.seq,
                "durable": entry.durable,
                "event": entry.event,
            }));
            batch_cursor = entry.seq;
        }
        let has_more = inner.entries.len() > events.len();
        drop(inner);
        // Pruning freed capacity; a reader parked on a full log may proceed.
        self.drained.notify_waiters();
        TransferEventBatch {
            events,
            cursor: batch_cursor,
            stream_id: self.stream_id.clone(),
            has_more,
            missed_events,
        }
    }

    /// Block until events are available after `cursor` or the window elapses,
    /// returning whatever was read either way.
    ///
    /// The wake-up is armed *before* each read, as `/v1/task-events` does: an
    /// append landing between the read and the await has to wake this call. A
    /// lost wake-up here would not just delay the response, it would delay
    /// every pairing prompt and transfer request by a whole recheck interval.
    pub async fn wait_for_events(
        &self,
        cursor: Option<u64>,
        stream_id: Option<&str>,
        limit: usize,
        timeout: std::time::Duration,
    ) -> TransferEventBatch {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut cursor = cursor;
        let mut stream_id = stream_id.map(str::to_string);
        let mut missed_events = false;
        loop {
            let mut appended = Box::pin(self.appended.notified());
            appended.as_mut().enable();
            let mut batch = self.read(cursor, stream_id.as_deref(), limit);
            missed_events |= batch.missed_events;
            batch.missed_events = missed_events;
            let now = tokio::time::Instant::now();
            if !batch.events.is_empty() || now >= deadline {
                return batch;
            }
            // Advance the in-flight checkpoint so a recheck never rescans the
            // history this call already proved empty. The checkpoint belongs to
            // this log, so the recheck resumes it rather than being treated as
            // another caller's stale cursor.
            cursor = Some(batch.cursor);
            stream_id = Some(batch.stream_id);
            let _ = tokio::time::timeout((deadline - now).min(EVENT_WAIT_RECHECK), appended).await;
        }
    }
}

/// Backstop re-check while blocked. Appends wake the waiter immediately; this
/// only bounds latency if a notification is ever missed.
const EVENT_WAIT_RECHECK: std::time::Duration = std::time::Duration::from_secs(5);

/// Environment handed to the sidecar process.
///
/// Every value has exactly one owner. The listen port and the daemon/database
/// locations come from the server's own config — the same `transfer_port` the
/// inbound tunnel bridge dials, so the two can never disagree. Peer identity
/// and the transfer root are resolved by the desktop (it owns the Tauri app
/// data dir and the machine name) and handed to the server at spawn.
pub fn build_transfer_sidecar_env(
    config: &crate::config::Config,
) -> Result<Vec<(String, String)>, String> {
    let transfer_root = required_env("KANNA_TRANSFER_ROOT")?;
    let registry_dir = std::env::var("KANNA_TRANSFER_REGISTRY_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            PathBuf::from(&transfer_root)
                .join("registry")
                .to_string_lossy()
                .into_owned()
        });
    Ok(vec![
        (
            "KANNA_TRANSFER_PORT".to_string(),
            config.transfer_port.to_string(),
        ),
        ("KANNA_TRANSFER_ROOT".to_string(), transfer_root),
        ("KANNA_TRANSFER_REGISTRY_DIR".to_string(), registry_dir),
        (
            "KANNA_TRANSFER_PEER_ID".to_string(),
            required_env("KANNA_TRANSFER_PEER_ID")?,
        ),
        (
            "KANNA_TRANSFER_DISPLAY_NAME".to_string(),
            required_env("KANNA_TRANSFER_DISPLAY_NAME")?,
        ),
        ("KANNA_DAEMON_DIR".to_string(), config.daemon_dir.clone()),
        ("KANNA_DB_PATH".to_string(), config.db_path.clone()),
        ("KANNA_CLI_DB_PATH".to_string(), config.db_path.clone()),
        (
            "KANNA_MOBILE_SERVER_PORT".to_string(),
            config.lan_port.to_string(),
        ),
    ])
}

fn required_env(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "{name} is unset; the desktop resolves transfer identity and must pass it to \
                 kanna-server at spawn"
            )
        })
}

fn resolve_sidecar_binary() -> Result<PathBuf, String> {
    kanna_runtime_defaults::resolve_binary_from_candidates(
        "kanna-task-transfer",
        kanna_runtime_defaults::sidecar_candidates("kanna-task-transfer"),
        |_| Err("kanna-task-transfer sidecar binary not found".to_string()),
    )
    .map(PathBuf::from)
}

pub struct TransferSidecarClient {
    /// Held only so `kill_on_drop` fires: dropping the last handle to a dead
    /// client must also reap a sidecar that stopped answering but still holds
    /// the transfer listener the respawn needs to bind.
    _child: Child,
    stdin: Mutex<ChildStdin>,
    pending: PendingRequests,
    dead: Arc<AtomicBool>,
    request_counter: AtomicU64,
}

impl TransferSidecarClient {
    fn spawn(
        sidecar_path: &std::path::Path,
        env: Vec<(String, String)>,
        events: Arc<TransferEventLog>,
    ) -> Result<Self, String> {
        let mut child = Command::new(sidecar_path)
            .envs(env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            // A sidecar that stopped answering still holds the transfer
            // listener; leaving it running would make the respawn unable to
            // bind the port it was spawned to own.
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("failed to spawn transfer sidecar: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "transfer sidecar stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "transfer sidecar stdout unavailable".to_string())?;
        let pending: PendingRequests = Arc::new(StdMutex::new(HashMap::new()));
        let dead = Arc::new(AtomicBool::new(false));
        spawn_reader(stdout, Arc::clone(&pending), Arc::clone(&dead), events);

        Ok(Self {
            _child: child,
            stdin: Mutex::new(stdin),
            pending,
            dead,
            request_counter: AtomicU64::new(1),
        })
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
    }

    fn next_request_id(&self, prefix: &str) -> String {
        format!(
            "{}-{}",
            prefix,
            self.request_counter.fetch_add(1, Ordering::Relaxed)
        )
    }

    /// Send one control request and await its correlated response.
    pub async fn request(&self, kind: &str, mut request: Value) -> Result<Value, String> {
        if self.is_dead() {
            return Err("transfer sidecar client is not running".to_string());
        }
        let request_id = self.next_request_id(kind);
        {
            let object = request
                .as_object_mut()
                .ok_or_else(|| "transfer sidecar request must be an object".to_string())?;
            object.insert("type".to_string(), Value::String(kind.to_string()));
            object.insert("request_id".to_string(), Value::String(request_id.clone()));
        }

        let encoded = serde_json::to_vec(&request)
            .map_err(|error| format!("failed to encode transfer sidecar request: {error}"))?;
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(request_id.clone(), tx);
        let _registration = PendingRequestRegistration::new(&request_id, Arc::clone(&self.pending));

        {
            let mut stdin = self.stdin.lock().await;
            for (chunk, failure) in [
                (encoded.as_slice(), "write"),
                (b"\n".as_slice(), "terminate"),
            ] {
                if let Err(error) = stdin.write_all(chunk).await {
                    self.dead.store(true, Ordering::Relaxed);
                    return Err(format!(
                        "failed to {failure} transfer sidecar request {request_id}: {error}"
                    ));
                }
            }
            if let Err(error) = stdin.flush().await {
                self.dead.store(true, Ordering::Relaxed);
                return Err(format!(
                    "failed to flush transfer sidecar request {request_id}: {error}"
                ));
            }
        }

        let response = rx.await.map_err(|_| {
            self.dead.store(true, Ordering::Relaxed);
            format!("transfer sidecar response channel closed for {request_id}")
        })?;
        if response.get("type").and_then(Value::as_str) == Some("error") {
            return Err(response
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| "transfer sidecar returned an unknown error".to_string()));
        }
        Ok(response)
    }
}

struct PendingRequestRegistration {
    request_id: String,
    pending: PendingRequests,
}

impl PendingRequestRegistration {
    fn new(request_id: &str, pending: PendingRequests) -> Self {
        Self {
            request_id: request_id.to_string(),
            pending,
        }
    }
}

impl Drop for PendingRequestRegistration {
    fn drop(&mut self) {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.request_id);
    }
}

fn spawn_reader(
    stdout: ChildStdout,
    pending: PendingRequests,
    dead: Arc<AtomicBool>,
    events: Arc<TransferEventLog>,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::with_capacity(64 * 1024);
            let mut bounded = reader.take(MAX_SIDECAR_STDOUT_FRAME_BYTES.saturating_add(1) as u64);
            let read = bounded.read_line(&mut line).await;
            reader = bounded.into_inner();
            let line = match read {
                Ok(0) => break,
                Ok(read) if read > MAX_SIDECAR_STDOUT_FRAME_BYTES || !line.ends_with('\n') => {
                    log::error!(
                        "transfer sidecar stdout frame exceeded {MAX_SIDECAR_STDOUT_FRAME_BYTES} \
                         bytes or was unterminated"
                    );
                    break;
                }
                Ok(_) => {
                    line.pop();
                    if line.ends_with('\r') {
                        line.pop();
                    }
                    line
                }
                Err(error) => {
                    log::error!("failed reading transfer sidecar stdout: {error}");
                    break;
                }
            };

            if line.trim().is_empty() {
                continue;
            }

            let value = match serde_json::from_str::<Value>(&line) {
                Ok(value) => value,
                Err(error) => {
                    log::warn!("invalid JSON from transfer sidecar: {error}");
                    continue;
                }
            };

            if let Some(event_type) = transfer_event_type(&value) {
                let durable = is_durable_transfer_event(event_type);
                events.append(value, durable).await;
                continue;
            }

            if let Some(request_id) = value.get("request_id").and_then(Value::as_str) {
                let sender = pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(request_id);
                match sender {
                    Some(sender) => {
                        let _ = sender.send(value);
                    }
                    None => log::warn!(
                        "dropped transfer sidecar response for unknown request {request_id}"
                    ),
                }
                continue;
            }

            log::warn!("unhandled transfer sidecar message: {value}");
        }

        dead.store(true, Ordering::Relaxed);
        pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    });
}

/// Lazy owner of the sidecar process: spawned on first control use or inbound
/// tunnel demand, respawned transparently once the previous child is dead.
pub struct TransferSidecarSupervisor {
    config: crate::config::Config,
    client: Mutex<Option<Arc<TransferSidecarClient>>>,
    events: Arc<TransferEventLog>,
    /// Lets a router-level test stand a listener on the transfer port in place
    /// of a real sidecar without this supervisor trying to spawn one.
    #[cfg(test)]
    externally_owned: AtomicBool,
    /// Which binary to spawn. Production resolves the bundled sidecar; a test
    /// points this at a stub speaking the same stdio protocol, so respawn-on-
    /// death can be exercised against a process it is allowed to kill.
    #[cfg(test)]
    binary_override: Option<PathBuf>,
}

impl TransferSidecarSupervisor {
    pub fn new(config: crate::config::Config) -> Self {
        Self {
            config,
            client: Mutex::new(None),
            events: Arc::new(TransferEventLog::default()),
            #[cfg(test)]
            externally_owned: AtomicBool::new(false),
            #[cfg(test)]
            binary_override: None,
        }
    }

    #[cfg(test)]
    fn with_binary_for_test(config: crate::config::Config, binary: PathBuf) -> Self {
        Self {
            binary_override: Some(binary),
            ..Self::new(config)
        }
    }

    fn sidecar_binary(&self) -> Result<PathBuf, String> {
        #[cfg(test)]
        if let Some(binary) = &self.binary_override {
            return Ok(binary.clone());
        }
        resolve_sidecar_binary()
    }

    #[cfg(test)]
    pub(crate) fn assume_externally_owned_for_test(&self) {
        self.externally_owned.store(true, Ordering::Relaxed);
    }

    /// Inbound relay demand is a spawn trigger: the bridge dials the sidecar's
    /// loopback port, and a machine that has not initiated a transfer yet has
    /// nothing listening there.
    pub async fn ensure_running_for_inbound_tunnel(&self) -> Result<(), String> {
        #[cfg(test)]
        if self.externally_owned.load(Ordering::Relaxed) {
            return Ok(());
        }
        self.ensure_running().await.map(|_| ())
    }

    pub fn events(&self) -> Arc<TransferEventLog> {
        Arc::clone(&self.events)
    }

    pub async fn ensure_running(&self) -> Result<Arc<TransferSidecarClient>, String> {
        let mut guard = self.client.lock().await;
        if guard.as_ref().is_some_and(|client| client.is_dead()) {
            *guard = None;
        }
        if guard.is_none() {
            *guard = Some(Arc::new(TransferSidecarClient::spawn(
                &self.sidecar_binary()?,
                build_transfer_sidecar_env(&self.config)?,
                Arc::clone(&self.events),
            )?));
        }
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())
    }

    async fn retire_if_dead(&self, client: &Arc<TransferSidecarClient>) {
        if !client.is_dead() {
            return;
        }
        let mut guard = self.client.lock().await;
        if guard
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, client))
        {
            // Dropping the last handle kills a sidecar that stopped answering
            // but is still holding the transfer listener.
            *guard = None;
        }
    }

    /// Run one control operation, retiring the client if the call proved it
    /// dead so the next caller gets a fresh sidecar.
    pub async fn control(&self, operation: &str, params: Value) -> Result<Value, String> {
        let client = self.ensure_running().await?;
        let result = crate::transfer_control::dispatch(&client, operation, params).await;
        self.retire_if_dead(&client).await;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str) -> Value {
        json!({ "type": kind, "payload": "x" })
    }

    #[test]
    fn durable_events_are_the_four_state_mutating_kinds() {
        for kind in [
            "incoming_transfer_request",
            "task_pull_requested",
            "outgoing_transfer_committed",
            "outgoing_transfer_finalization_requested",
        ] {
            assert!(is_durable_transfer_event(kind), "{kind} must be durable");
            assert_eq!(transfer_event_type(&event(kind)), Some(kind));
        }
        for kind in ["pairing_started", "pairing_requested", "terminal_event"] {
            assert!(!is_durable_transfer_event(kind), "{kind} must be advisory");
            assert_eq!(transfer_event_type(&event(kind)), Some(kind));
        }
        assert_eq!(transfer_event_type(&json!({ "request_id": "r-1" })), None);
    }

    #[test]
    fn reading_through_a_cursor_prunes_delivered_events() {
        let log = TransferEventLog::default();
        assert!(log.try_append(event("pairing_started"), false));
        assert!(log.try_append(event("task_pull_requested"), true));

        let first = log.read(None, None, 10);
        assert_eq!(first.events.len(), 2);
        assert_eq!(first.cursor, 2);
        assert!(!first.missed_events);

        let second = log.read(Some(first.cursor), Some(&first.stream_id), 10);
        assert!(second.events.is_empty());
        assert_eq!(second.cursor, 2);
        assert_eq!(log.lock().entries.len(), 0);
    }

    /// The desktop outlives any one `kanna-server`, and these sequences restart
    /// at zero with each. A cursor carried across that restart addresses events
    /// it never saw, so honouring it would prune the new log's first entries —
    /// durable lifecycle events included — and report nothing missed.
    #[test]
    fn a_cursor_from_a_previous_server_incarnation_is_refused_not_applied() {
        let restarted = TransferEventLog::default();
        for _ in 0..3 {
            assert!(restarted.try_append(event("task_pull_requested"), true));
        }

        let batch = restarted.read(Some(2), Some("some-earlier-server"), 10);
        assert_eq!(
            batch.events.len(),
            3,
            "a stale cursor must not consume events from the new stream"
        );
        assert!(batch.missed_events);
        assert_ne!(batch.stream_id, "some-earlier-server");

        // Resuming with the id this log actually issued behaves normally again.
        let resumed = restarted.read(Some(batch.cursor), Some(&batch.stream_id), 10);
        assert!(resumed.events.is_empty());
        assert!(!resumed.missed_events);
    }

    /// Mixed-version contract: a desktop from before the stream id existed
    /// polls with `cursor` alone, forever. That has to keep acknowledging and
    /// pruning. If a bare cursor were treated as a stale-server cursor instead,
    /// every poll would redeliver the same retained events and prune nothing,
    /// so durable entries would climb to `MAX_TRANSFER_EVENT_ENTRIES` and then
    /// backpressure the sidecar's stdout reader — wedging control for everyone.
    #[test]
    fn a_pre_stream_id_client_polling_with_a_bare_cursor_still_acknowledges() {
        let log = TransferEventLog::default();
        let mut cursor = None;
        let mut delivered = Vec::new();

        for round in 0..(MAX_TRANSFER_EVENT_ENTRIES + 8) as u64 {
            assert!(
                log.try_append(
                    json!({ "type": "task_pull_requested", "round": round }),
                    true
                ),
                "round {round} must not hit the durable cap: a legacy cursor has to prune",
            );
            let batch = log.read(cursor, None, 10);
            assert!(!batch.missed_events, "round {round} reported a false gap");
            for entry in &batch.events {
                delivered.push(entry["event"]["round"].as_u64().expect("round"));
            }
            cursor = Some(batch.cursor);
        }

        // Every event exactly once, in order, with no redelivery.
        assert_eq!(
            delivered,
            (0..(MAX_TRANSFER_EVENT_ENTRIES + 8) as u64).collect::<Vec<_>>(),
        );
        // One more poll drains the final acknowledged entry, leaving nothing
        // retained — the log is not growing behind a legacy consumer.
        let drained = log.read(cursor, None, 10);
        assert!(drained.events.is_empty());
        assert!(!drained.missed_events);
        assert_eq!(log.lock().entries.len(), 0);
    }

    /// A bare cursor is honoured, but an eviction it sat below is still
    /// reported — the legacy `missedEvents` semantics are unchanged.
    #[test]
    fn a_bare_cursor_below_an_eviction_still_reports_missed_events() {
        let log = TransferEventLog::default();
        for _ in 0..MAX_TRANSFER_EVENT_ENTRIES + 2 {
            log.try_append(event("pairing_started"), false);
        }
        assert!(log.read(Some(1), None, 10).missed_events);
    }

    #[test]
    fn a_full_log_evicts_advisory_events_before_durable_ones() {
        let log = TransferEventLog::default();
        for _ in 0..MAX_TRANSFER_EVENT_ENTRIES {
            assert!(log.try_append(event("pairing_started"), false));
        }
        assert!(log.try_append(event("task_pull_requested"), true));

        let stream_id = log.stream_id.clone();
        let batch = log.read(Some(1), Some(&stream_id), MAX_TRANSFER_EVENT_ENTRIES + 1);
        assert!(
            batch.events.iter().any(|entry| entry["durable"] == true),
            "the durable event must survive eviction"
        );
    }

    #[test]
    fn a_full_log_of_durable_events_refuses_the_append() {
        let log = TransferEventLog::default();
        for _ in 0..MAX_TRANSFER_EVENT_ENTRIES {
            assert!(log.try_append(event("task_pull_requested"), true));
        }
        assert!(
            !log.try_append(event("task_pull_requested"), true),
            "durable events must apply backpressure instead of being dropped"
        );
    }

    #[test]
    fn a_cursor_below_an_eviction_reports_missed_events() {
        let log = TransferEventLog::default();
        for _ in 0..MAX_TRANSFER_EVENT_ENTRIES + 2 {
            log.try_append(event("pairing_started"), false);
        }
        let stream_id = log.stream_id.clone();
        assert!(log.read(Some(1), Some(&stream_id), 10).missed_events);
        // A cursor already past everything evicted did not miss anything.
        assert!(
            !log.read(
                Some(MAX_TRANSFER_EVENT_ENTRIES as u64),
                Some(&stream_id),
                10
            )
            .missed_events
        );
    }

    /// Two logs in the same process must not answer each other's cursors.
    #[test]
    fn each_log_gets_its_own_stream_id() {
        assert_ne!(
            TransferEventLog::default().stream_id,
            TransferEventLog::default().stream_id
        );
    }

    fn test_config(transfer_port: u16, lan_port: u16) -> crate::config::Config {
        crate::config::Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: "/tmp/kanna-transfer-sidecar-test.db".to_string(),
            kanna_cli_path: None,
            desktop_id: "desktop-test".to_string(),
            desktop_secret: None,
            desktop_name: "Kanna Test".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port,
            transfer_port,
            pairing_store_path: "/tmp/kanna-transfer-sidecar-pairings.json".to_string(),
        }
    }

    fn clear_identity_env() {
        for name in [
            "KANNA_TRANSFER_ROOT",
            "KANNA_TRANSFER_REGISTRY_DIR",
            "KANNA_TRANSFER_PEER_ID",
            "KANNA_TRANSFER_DISPLAY_NAME",
        ] {
            std::env::remove_var(name);
        }
    }

    /// The tunnel bridge dials `config.transfer_port`; the sidecar must be
    /// told to listen on exactly that port or an inbound cloud transfer hits a
    /// closed socket. Staging and production carry different ports, so the
    /// value has to travel rather than be re-derived.
    #[test]
    fn sidecar_env_takes_the_listen_port_from_the_server_config() {
        let _guard = crate::test_sidecar_guard();
        let root = std::env::temp_dir().join("kanna-transfer-env-test");
        clear_identity_env();
        std::env::set_var("KANNA_TRANSFER_ROOT", &root);
        std::env::set_var("KANNA_TRANSFER_PEER_ID", "peer-test");
        std::env::set_var("KANNA_TRANSFER_DISPLAY_NAME", "Test Machine");

        for (transfer_port, lan_port) in [
            (
                kanna_runtime_defaults::DEFAULT_TRANSFER_PORT,
                kanna_runtime_defaults::PRODUCTION_MOBILE_SERVER_PORT,
            ),
            (
                kanna_runtime_defaults::STAGING_TRANSFER_PORT,
                kanna_runtime_defaults::STAGING_MOBILE_SERVER_PORT,
            ),
        ] {
            let env: HashMap<String, String> =
                build_transfer_sidecar_env(&test_config(transfer_port, lan_port))
                    .expect("env")
                    .into_iter()
                    .collect();
            assert_eq!(
                env.get("KANNA_TRANSFER_PORT").map(String::as_str),
                Some(transfer_port.to_string().as_str())
            );
            assert_eq!(
                env.get("KANNA_MOBILE_SERVER_PORT").map(String::as_str),
                Some(lan_port.to_string().as_str())
            );
            assert_eq!(
                env.get("KANNA_TRANSFER_REGISTRY_DIR").map(String::as_str),
                Some(root.join("registry").to_string_lossy().as_ref())
            );
            assert_eq!(
                env.get("KANNA_TRANSFER_PEER_ID").map(String::as_str),
                Some("peer-test")
            );
        }

        clear_identity_env();
    }

    #[test]
    fn sidecar_env_refuses_to_spawn_without_desktop_resolved_identity() {
        let _guard = crate::test_sidecar_guard();
        clear_identity_env();
        let error = build_transfer_sidecar_env(&test_config(4455, 48120))
            .expect_err("identity is required");
        assert!(error.contains("KANNA_TRANSFER_ROOT"), "{error}");
    }

    /// Stands in for `kanna-task-transfer`: speaks the same newline-JSON stdio
    /// protocol, records each incarnation's pid so the test can kill exactly
    /// the process it spawned, and emits one event so the shared event log is
    /// exercised across a respawn too.
    fn write_stub_sidecar(root: &std::path::Path) -> PathBuf {
        std::fs::create_dir_all(root).expect("stub root");
        let stub = root.join("stub-sidecar.sh");
        std::fs::write(
            &stub,
            r#"#!/bin/sh
printf '%s\n' "$$" >> "$KANNA_TRANSFER_ROOT/pids"
printf '{"type":"pairing_started"}\n'
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  printf '{"request_id":"%s","peers":[]}\n' "$id"
done
"#,
        )
        .expect("write stub");
        std::fs::set_permissions(
            &stub,
            <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755),
        )
        .expect("chmod stub");
        stub
    }

    fn stub_sidecar_pids(root: &std::path::Path) -> Vec<i32> {
        std::fs::read_to_string(root.join("pids"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.trim().parse::<i32>().ok())
            .collect()
    }

    /// The sidecar dying must not wedge the control plane: the next call has to
    /// either succeed against a fresh child or fail out loud, never hang. This
    /// is the server-side half of the E2E expectation for a mid-flow crash.
    ///
    /// The env guard has to span the awaits rather than be dropped before them:
    /// the sidecar is spawned lazily *inside* `control`, and that spawn is what
    /// reads the identity environment this test sets.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_dead_sidecar_is_replaced_rather_than_left_wedged() {
        let _guard = crate::test_sidecar_guard();
        let root = std::env::temp_dir().join(format!(
            "kanna-transfer-respawn-{}-{}",
            std::process::id(),
            new_transfer_event_stream_id()
        ));
        clear_identity_env();
        std::env::set_var("KANNA_TRANSFER_ROOT", &root);
        std::env::set_var("KANNA_TRANSFER_PEER_ID", "peer-test");
        std::env::set_var("KANNA_TRANSFER_DISPLAY_NAME", "Test Machine");
        let stub = write_stub_sidecar(&root);
        let supervisor =
            TransferSidecarSupervisor::with_binary_for_test(test_config(4455, 48120), stub.clone());

        supervisor
            .control("list-peers", json!({}))
            .await
            .expect("the first control call spawns the sidecar and answers");
        let first = stub_sidecar_pids(&root);
        assert_eq!(first.len(), 1, "exactly one sidecar should have spawned");

        // Kill only the pid this test's stub reported — never a name match.
        assert_eq!(
            unsafe { libc::kill(first[0], libc::SIGKILL) },
            0,
            "the stub sidecar should still be alive to kill"
        );

        // Every attempt returns or errors; one of them has to succeed, and the
        // bound is what proves there is no silent hang.
        let mut recovered = false;
        let mut last_error = None;
        for _ in 0..40 {
            match tokio::time::timeout(
                std::time::Duration::from_secs(5),
                supervisor.control("list-peers", json!({})),
            )
            .await
            .expect("a control call must never hang after a sidecar crash")
            {
                Ok(_) => {
                    recovered = true;
                    break;
                }
                Err(error) => {
                    last_error = Some(error);
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
        assert!(recovered, "control never recovered: {last_error:?}");

        let after = stub_sidecar_pids(&root);
        assert_eq!(after.len(), 2, "the supervisor should respawn exactly once");
        assert_ne!(after[0], after[1], "the respawn must be a new process");

        // Both incarnations wrote into the one event log the desktop polls, so
        // a respawn does not silently reset the stream the cursor tracks.
        let batch = supervisor.events().read(None, None, 10);
        assert_eq!(batch.events.len(), 2);

        clear_identity_env();
        let _ = std::fs::remove_dir_all(&root);
    }
}
