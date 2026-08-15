//! Kanna Stream Protocol (KSP) endpoint: one multiplexed WebSocket per
//! client carrying agent streams, terminal streams, and task-API requests as
//! task-addressed JSON frames. The same handler serves localhost (the local
//! desktop app), LAN clients, and — via the relay tunnel — cloud clients.
//!
//! Frame schema: `crates/kanna-agent-protocol/src/frames.rs` (TS mirrors in
//! `packages/agent-protocol`).

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(test)]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message as WsMessage, WebSocket};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, watch, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use kanna_agent_protocol::{
    ClientFrame, CompanionEvent, FrameAgentEvent, KspCapability, PermissionDecision, ServerFrame,
    StreamKind,
};
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent, SessionStatus};
use kanna_daemon::terminal_perf::{self, TerminalPerfContext, TerminalPerfMonitor};

use crate::daemon_client::DaemonClient;
use crate::db::Db;
use crate::http_api::{dispatch_authenticated_http_invoke, AppState};

mod auth;

use auth::verify_firebase_id_token;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    AllowEmpty,
    LegacyReadOnlyOrPaired,
    AlreadyAuthenticated,
    RequirePairedDevice,
    #[allow(dead_code)]
    RequireCredential,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairedDeviceCredential {
    device_id: String,
    device_secret: String,
}

const MAX_RELAY_COMPANION_ATTACHMENTS: usize = 16;
const MAX_RELAY_COMPANION_RETAINED_BYTES: usize = 64 * 1024 * 1024;
const MAX_RELAY_COMPANION_PENDING_BYTES: usize = 64 * 1024 * 1024;
const MAX_ORDINARY_FRAMES_BEFORE_COMPANION: usize = 32;
const COMPANION_SNAPSHOT_CHUNK_DATA_BYTES: usize = 96 * 1024;
const MAX_LEGACY_COMPANION_TASKS_PER_CONNECTION: usize = 64;

#[cfg(test)]
struct CompanionAckTestGate {
    event_id: String,
    blocked: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[cfg(test)]
struct CompanionAckTestGateGuard(Arc<CompanionAckTestGate>);

#[cfg(test)]
static COMPANION_ACK_TEST_GATES: OnceLock<Mutex<HashMap<String, Arc<CompanionAckTestGate>>>> =
    OnceLock::new();

#[cfg(test)]
struct CompanionAdmissionDemandTestGate {
    scan_key: String,
    blocked: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[cfg(test)]
struct CompanionAdmissionDemandTestGateGuard(Arc<CompanionAdmissionDemandTestGate>);

#[cfg(test)]
static COMPANION_ADMISSION_DEMAND_TEST_GATE: OnceLock<
    Mutex<Option<Arc<CompanionAdmissionDemandTestGate>>>,
> = OnceLock::new();

#[cfg(test)]
struct CompanionAppendTestGate {
    event_id: String,
    blocked: tokio::sync::Notify,
    released: std::sync::Mutex<bool>,
    release: std::sync::Condvar,
}

#[cfg(test)]
struct CompanionAppendTestGateGuard(Arc<CompanionAppendTestGate>);

#[cfg(test)]
static COMPANION_APPEND_TEST_GATES: OnceLock<Mutex<HashMap<String, Arc<CompanionAppendTestGate>>>> =
    OnceLock::new();

#[cfg(test)]
struct CompanionSerializeTestGate {
    blocked: tokio::sync::Notify,
    released: std::sync::Mutex<bool>,
    release: std::sync::Condvar,
}

#[cfg(test)]
struct CompanionSerializeTestGateGuard {
    gate: Arc<CompanionSerializeTestGate>,
    task_ids: Vec<String>,
}

#[cfg(test)]
static COMPANION_SERIALIZE_TEST_GATES: OnceLock<
    Mutex<HashMap<String, Arc<CompanionSerializeTestGate>>>,
> = OnceLock::new();

#[cfg(test)]
static COMPANION_CHANGED_SCAN_COUNTS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();

#[cfg(test)]
type TerminalInputSendTestHook = Box<dyn FnOnce() + Send>;

#[cfg(test)]
static TERMINAL_INPUT_SEND_TEST_HOOKS: OnceLock<Mutex<HashMap<String, TerminalInputSendTestHook>>> =
    OnceLock::new();

#[cfg(test)]
fn install_terminal_input_send_test_hook(task_id: &str, hook: impl FnOnce() + Send + 'static) {
    TERMINAL_INPUT_SEND_TEST_HOOKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(task_id.to_string(), Box::new(hook));
}

#[cfg(test)]
fn run_terminal_input_send_test_hook(task_id: &str) {
    let hook = TERMINAL_INPUT_SEND_TEST_HOOKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(task_id);
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(test)]
fn companion_scan_test_key(db_path: &str, task_id: &str) -> String {
    serde_json::to_string(&(db_path, task_id)).expect("companion scan test key must serialize")
}

#[cfg(test)]
fn record_changed_companion_scan(db_path: &str, task_id: &str) {
    let mut counts = COMPANION_CHANGED_SCAN_COUNTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *counts
        .entry(companion_scan_test_key(db_path, task_id))
        .or_default() += 1;
}

#[cfg(test)]
fn changed_companion_scan_count(db_path: &str, task_id: &str) -> usize {
    COMPANION_CHANGED_SCAN_COUNTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&companion_scan_test_key(db_path, task_id))
        .copied()
        .unwrap_or(0)
}

#[cfg(test)]
fn install_companion_ack_test_gate(event_id: &str) -> CompanionAckTestGateGuard {
    let gate = Arc::new(CompanionAckTestGate {
        event_id: event_id.to_owned(),
        blocked: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    COMPANION_ACK_TEST_GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(event_id.to_owned(), Arc::clone(&gate));
    CompanionAckTestGateGuard(gate)
}

#[cfg(test)]
impl CompanionAckTestGateGuard {
    async fn wait_until_blocked(&self) {
        self.0.blocked.notified().await;
    }

    fn release(&self) {
        self.0.release.notify_one();
    }
}

#[cfg(test)]
impl Drop for CompanionAckTestGateGuard {
    fn drop(&mut self) {
        self.0.release.notify_one();
        let mut installed = COMPANION_ACK_TEST_GATES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if installed
            .get(&self.0.event_id)
            .is_some_and(|gate| Arc::ptr_eq(gate, &self.0))
        {
            installed.remove(&self.0.event_id);
        }
    }
}

#[cfg(test)]
async fn wait_for_companion_ack_test_gate(event_id: &str) {
    let gate = COMPANION_ACK_TEST_GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(event_id)
        .cloned();
    if let Some(gate) = gate {
        gate.blocked.notify_one();
        gate.release.notified().await;
    }
}

#[cfg(test)]
fn install_companion_admission_demand_test_gate(
    db_path: &str,
    task_id: &str,
) -> CompanionAdmissionDemandTestGateGuard {
    let gate = Arc::new(CompanionAdmissionDemandTestGate {
        scan_key: companion_scan_test_key(db_path, task_id),
        blocked: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    *COMPANION_ADMISSION_DEMAND_TEST_GATE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&gate));
    CompanionAdmissionDemandTestGateGuard(gate)
}

#[cfg(test)]
impl CompanionAdmissionDemandTestGateGuard {
    async fn wait_until_blocked(&self) {
        self.0.blocked.notified().await;
    }

    fn release(&self) {
        self.0.release.notify_one();
    }
}

#[cfg(test)]
impl Drop for CompanionAdmissionDemandTestGateGuard {
    fn drop(&mut self) {
        self.release();
        let mut installed = COMPANION_ADMISSION_DEMAND_TEST_GATE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if installed
            .as_ref()
            .is_some_and(|gate| Arc::ptr_eq(gate, &self.0))
        {
            *installed = None;
        }
    }
}

#[cfg(test)]
async fn wait_for_companion_admission_demand_test_gate(db_path: &str, task_id: &str) {
    let scan_key = companion_scan_test_key(db_path, task_id);
    let gate = COMPANION_ADMISSION_DEMAND_TEST_GATE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .filter(|gate| gate.scan_key == scan_key)
        .cloned();
    if let Some(gate) = gate {
        gate.blocked.notify_one();
        gate.release.notified().await;
    }
}

#[cfg(test)]
fn install_companion_append_test_gate(event_id: &str) -> CompanionAppendTestGateGuard {
    let gate = Arc::new(CompanionAppendTestGate {
        event_id: event_id.to_owned(),
        blocked: tokio::sync::Notify::new(),
        released: std::sync::Mutex::new(false),
        release: std::sync::Condvar::new(),
    });
    COMPANION_APPEND_TEST_GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(event_id.to_owned(), Arc::clone(&gate));
    CompanionAppendTestGateGuard(gate)
}

#[cfg(test)]
impl CompanionAppendTestGateGuard {
    async fn wait_until_blocked(&self) {
        self.0.blocked.notified().await;
    }

    fn release(&self) {
        *self
            .0
            .released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        self.0.release.notify_all();
    }
}

#[cfg(test)]
impl Drop for CompanionAppendTestGateGuard {
    fn drop(&mut self) {
        self.release();
        let mut installed = COMPANION_APPEND_TEST_GATES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if installed
            .get(&self.0.event_id)
            .is_some_and(|gate| Arc::ptr_eq(gate, &self.0))
        {
            installed.remove(&self.0.event_id);
        }
    }
}

#[cfg(test)]
fn wait_for_companion_append_test_gate(event_id: &str) {
    let gate = COMPANION_APPEND_TEST_GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(event_id)
        .cloned();
    if let Some(gate) = gate {
        gate.blocked.notify_one();
        let mut released = gate
            .released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !*released {
            released = gate
                .release
                .wait(released)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

#[cfg(test)]
fn install_companion_serialize_test_gate(task_ids: &[&str]) -> CompanionSerializeTestGateGuard {
    let gate = Arc::new(CompanionSerializeTestGate {
        blocked: tokio::sync::Notify::new(),
        released: std::sync::Mutex::new(false),
        release: std::sync::Condvar::new(),
    });
    let task_ids = task_ids
        .iter()
        .map(|task_id| (*task_id).to_owned())
        .collect::<Vec<_>>();
    let mut installed = COMPANION_SERIALIZE_TEST_GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for task_id in &task_ids {
        assert!(
            installed
                .insert(task_id.clone(), Arc::clone(&gate))
                .is_none(),
            "companion serialize test gate already installed for {task_id}"
        );
    }
    drop(installed);
    CompanionSerializeTestGateGuard { gate, task_ids }
}

#[cfg(test)]
impl CompanionSerializeTestGateGuard {
    async fn wait_until_blocked(&self) {
        self.gate.blocked.notified().await;
    }

    fn release(&self) {
        *self
            .gate
            .released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        self.gate.release.notify_all();
    }
}

#[cfg(test)]
impl Drop for CompanionSerializeTestGateGuard {
    fn drop(&mut self) {
        self.release();
        let mut installed = COMPANION_SERIALIZE_TEST_GATES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for task_id in &self.task_ids {
            if installed
                .get(task_id)
                .is_some_and(|gate| Arc::ptr_eq(gate, &self.gate))
            {
                installed.remove(task_id);
            }
        }
    }
}

#[cfg(test)]
fn wait_for_companion_serialize_test_gate(task_id: &str) {
    let gate = COMPANION_SERIALIZE_TEST_GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(task_id)
        .cloned();
    if let Some(gate) = gate {
        gate.blocked.notify_one();
        let mut released = gate
            .released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !*released {
            released = gate
                .release
                .wait(released)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

#[derive(Clone)]
pub(super) struct CompanionResources {
    scans: Arc<Mutex<HashMap<String, Weak<CompanionScanSource>>>>,
    materialization_budget: Arc<kanna_visual_companion::CompanionMaterializationBudget>,
    attachment_slots: Arc<Semaphore>,
    retained_bytes: Arc<AtomicUsize>,
    retained_available: Arc<Notify>,
    pending_bytes: Arc<AtomicUsize>,
}

impl Default for CompanionResources {
    fn default() -> Self {
        Self {
            scans: Arc::new(Mutex::new(HashMap::new())),
            materialization_budget: Arc::new(
                kanna_visual_companion::CompanionMaterializationBudget::new(2, 64 * 1024 * 1024),
            ),
            attachment_slots: Arc::new(Semaphore::new(MAX_RELAY_COMPANION_ATTACHMENTS)),
            retained_bytes: Arc::new(AtomicUsize::new(0)),
            retained_available: Arc::new(Notify::new()),
            pending_bytes: Arc::new(AtomicUsize::new(0)),
        }
    }
}

struct CompanionScanSource {
    frames: watch::Sender<Option<Arc<RetainedCompanionFrame>>>,
    cancel: watch::Sender<bool>,
    asset_demand: watch::Sender<usize>,
}

impl Drop for CompanionScanSource {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}

struct CompanionScanSubscription {
    _source: Arc<CompanionScanSource>,
    frames: watch::Receiver<Option<Arc<RetainedCompanionFrame>>>,
    requested_assets: bool,
}

impl Drop for CompanionScanSubscription {
    fn drop(&mut self) {
        if self.requested_assets {
            self._source.asset_demand.send_if_modified(|demand| {
                debug_assert!(*demand > 0);
                *demand = demand.saturating_sub(1);
                *demand == 0
            });
        }
    }
}

struct RetainedCompanionFrame {
    frame: Arc<ServerFrame>,
    snapshot_includes_assets: Option<bool>,
    retained_bytes: usize,
    total_retained_bytes: Arc<AtomicUsize>,
    retained_available: Option<Arc<Notify>>,
}

impl RetainedCompanionFrame {
    #[cfg(test)]
    fn try_new(frame: ServerFrame, total_retained_bytes: &Arc<AtomicUsize>) -> Option<Arc<Self>> {
        Self::try_new_with_wakeup(frame, None, total_retained_bytes, None)
    }

    fn try_new_with_wakeup(
        frame: ServerFrame,
        snapshot_includes_assets: Option<bool>,
        total_retained_bytes: &Arc<AtomicUsize>,
        retained_available: Option<Arc<Notify>>,
    ) -> Option<Arc<Self>> {
        let retained_bytes = companion_frame_retained_bytes(&frame);
        reserve_relay_bytes(
            total_retained_bytes,
            retained_bytes,
            MAX_RELAY_COMPANION_RETAINED_BYTES,
        )
        .then(|| {
            Arc::new(Self {
                frame: Arc::new(frame),
                snapshot_includes_assets,
                retained_bytes,
                total_retained_bytes: Arc::clone(total_retained_bytes),
                retained_available,
            })
        })
    }

    fn is_compatible_with(&self, include_assets: bool) -> bool {
        !include_assets || self.snapshot_includes_assets != Some(false)
    }
}

impl Drop for RetainedCompanionFrame {
    fn drop(&mut self) {
        self.total_retained_bytes
            .fetch_sub(self.retained_bytes, Ordering::AcqRel);
        if let Some(retained_available) = &self.retained_available {
            retained_available.notify_waiters();
        }
    }
}

impl CompanionResources {
    fn subscribe(
        &self,
        db_path: String,
        task_id: String,
        include_assets: bool,
    ) -> CompanionScanSubscription {
        let key = serde_json::to_string(&(&db_path, &task_id))
            .expect("companion scan key serialization cannot fail");
        let mut scans = self
            .scans
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        scans.retain(|_, source| source.strong_count() > 0);
        if let Some(source) = scans.get(&key).and_then(Weak::upgrade) {
            if include_assets {
                source.asset_demand.send_if_modified(|demand| {
                    let wake_scanner = *demand == 0;
                    *demand = demand.saturating_add(1);
                    wake_scanner
                });
            }
            return CompanionScanSubscription {
                frames: source.frames.subscribe(),
                _source: source,
                requested_assets: include_assets,
            };
        }
        let (frames, receiver) = watch::channel(None);
        let (cancel, cancel_receiver) = watch::channel(false);
        let (asset_demand, asset_demand_receiver) = watch::channel(usize::from(include_assets));
        let source = Arc::new(CompanionScanSource {
            frames,
            cancel,
            asset_demand,
        });
        scans.insert(key, Arc::downgrade(&source));
        spawn_companion_scan_source(
            db_path,
            task_id,
            source.frames.clone(),
            cancel_receiver,
            asset_demand_receiver,
            Arc::clone(&self.materialization_budget),
            Arc::clone(&self.retained_bytes),
            Arc::clone(&self.retained_available),
        );
        CompanionScanSubscription {
            _source: source,
            frames: receiver,
            requested_assets: include_assets,
        }
    }

    fn try_attachment(&self) -> Option<OwnedSemaphorePermit> {
        Arc::clone(&self.attachment_slots).try_acquire_owned().ok()
    }
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn terminal_frame_context(
    frame: &ServerFrame,
    session_id: Option<&str>,
    stage: &'static str,
    queue: Option<(usize, usize)>,
) -> Option<TerminalPerfContext> {
    let (task_id, encoded_bytes) = match frame {
        ServerFrame::TermSnapshot {
            task_id, data_b64, ..
        }
        | ServerFrame::TermOutput { task_id, data_b64 } => (task_id, data_b64.len()),
        _ => return None,
    };
    let mut context =
        TerminalPerfContext::new("ksp", session_id.unwrap_or(task_id.as_str()), stage);
    context.task_id = Some(task_id.clone());
    context.bytes = encoded_bytes;
    if let Some((available, capacity)) = queue {
        context.queue_available = Some(available);
        context.queue_capacity = Some(capacity);
    }
    Some(context)
}

async fn monitored_terminal_future<T, F>(
    context: Option<TerminalPerfContext>,
    monitor: TerminalPerfMonitor,
    future: F,
) -> T
where
    F: Future<Output = T>,
{
    let operation = context.map(|context| monitor.begin(context));
    let result = future.await;
    if let Some(operation) = operation {
        operation.finish();
    }
    result
}

async fn send_terminal_frame(
    frame_tx: mpsc::Sender<ServerFrame>,
    frame: ServerFrame,
    session_id: String,
    monitor: TerminalPerfMonitor,
) -> Result<(), mpsc::error::SendError<ServerFrame>> {
    let context = terminal_frame_context(
        &frame,
        Some(&session_id),
        "outbound_queue",
        Some((frame_tx.capacity(), frame_tx.max_capacity())),
    );
    monitored_terminal_future(context, monitor, frame_tx.send(frame)).await
}

/// Length-aware constant-time byte comparison. Returns false for differing
/// lengths without leaking which byte differs via early exit. Avoids a crate
/// dependency for this single credential check.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn status_str(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Busy => "busy",
        SessionStatus::Waiting => "waiting",
        SessionStatus::Idle => "idle",
    }
}

#[cfg(test)]
fn auth_ok_frame() -> ServerFrame {
    auth_ok_frame_for(true)
}

fn auth_ok_frame_for(companion_access: bool) -> ServerFrame {
    let mut stream_kinds = vec![StreamKind::Agent, StreamKind::Terminal];
    if companion_access {
        stream_kinds.push(StreamKind::Companion);
    }
    ServerFrame::AuthOk {
        stream_kinds,
        capabilities: vec![
            KspCapability::CompanionAttachmentEpoch,
            KspCapability::CompanionEventEpoch,
        ],
    }
}

#[derive(Clone)]
struct CompanionFrameSender {
    state: Arc<Mutex<CompanionFrameState>>,
    notify_tx: mpsc::Sender<()>,
    generation_epoch: watch::Sender<u64>,
    pending_bytes: Arc<AtomicUsize>,
}

impl CompanionFrameSender {
    #[cfg(test)]
    fn attachment(
        &self,
        task_id: String,
        include_assets: bool,
        accept_snapshot_chunks: bool,
    ) -> CompanionAttachmentSender {
        self.attachment_with_epoch(task_id, include_assets, accept_snapshot_chunks, None)
    }

    fn attachment_with_epoch(
        &self,
        task_id: String,
        include_assets: bool,
        accept_snapshot_chunks: bool,
        attachment_epoch: Option<u64>,
    ) -> CompanionAttachmentSender {
        let generation = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .invalidate(&task_id);
        self.generation_epoch
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        CompanionAttachmentSender {
            task_id,
            generation,
            state: self.state.clone(),
            notify_tx: self.notify_tx.clone(),
            pending_bytes: Arc::clone(&self.pending_bytes),
            include_assets,
            accept_snapshot_chunks,
            attachment_epoch,
        }
    }

    fn invalidate(&self, task_id: &str) {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .invalidate(task_id);
        self.generation_epoch
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
    }
}

#[derive(Default)]
struct CompanionFrameState {
    pending: HashMap<String, PendingCompanionFrame>,
    ready: VecDeque<String>,
    generations: HashMap<String, u64>,
}

struct PendingCompanionFrame {
    frame: Arc<ServerFrame>,
    task_id: String,
    generation: u64,
    attachment_epoch: Option<u64>,
    accept_snapshot_chunks: bool,
    retained_bytes: usize,
    total_retained_bytes: Arc<AtomicUsize>,
}

impl Drop for PendingCompanionFrame {
    fn drop(&mut self) {
        self.total_retained_bytes
            .fetch_sub(self.retained_bytes, Ordering::AcqRel);
    }
}

impl CompanionFrameState {
    fn invalidate(&mut self, task_id: &str) -> u64 {
        let generation = {
            let current = self.generations.entry(task_id.to_string()).or_default();
            *current = current.wrapping_add(1);
            if *current == 0 {
                *current = 1;
            }
            *current
        };
        self.pending.remove(task_id);
        self.ready.retain(|queued_task| queued_task != task_id);
        generation
    }
}

#[derive(Clone)]
struct CompanionAttachmentSender {
    task_id: String,
    generation: u64,
    state: Arc<Mutex<CompanionFrameState>>,
    notify_tx: mpsc::Sender<()>,
    pending_bytes: Arc<AtomicUsize>,
    include_assets: bool,
    accept_snapshot_chunks: bool,
    attachment_epoch: Option<u64>,
}

impl CompanionAttachmentSender {
    #[cfg(test)]
    fn publish(&self, frame: ServerFrame) -> bool {
        if self.notify_tx.is_closed() {
            return false;
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.generations.get(&self.task_id) != Some(&self.generation) {
            return false;
        }
        let was_pending = state.pending.remove(&self.task_id).is_some();
        let mut frame = companion_frame_for_attachment(&Arc::new(frame), self.include_assets);
        let mut retained_bytes = companion_frame_retained_bytes(&frame);
        if !reserve_relay_pending_bytes(&self.pending_bytes, retained_bytes) {
            frame = Arc::new(ServerFrame::CompanionError {
                task_id: self.task_id.clone(),
                code: "companion_resource_limit".into(),
                message: "Visual companion relay resources are busy. Reopen the companion.".into(),
                attachment_epoch: self.attachment_epoch,
            });
            retained_bytes = companion_frame_retained_bytes(&frame);
            if !reserve_relay_pending_bytes(&self.pending_bytes, retained_bytes) {
                return false;
            }
        }
        if !was_pending {
            state.ready.push_back(self.task_id.clone());
        }
        let replaced = state.pending.insert(
            self.task_id.clone(),
            PendingCompanionFrame {
                frame,
                task_id: self.task_id.clone(),
                generation: self.generation,
                attachment_epoch: self.attachment_epoch,
                accept_snapshot_chunks: self.accept_snapshot_chunks,
                retained_bytes,
                total_retained_bytes: Arc::clone(&self.pending_bytes),
            },
        );
        drop(replaced);
        drop(state);

        match self.notify_tx.try_send(()) {
            Ok(()) | Err(mpsc::error::TrySendError::Full(())) => true,
            Err(mpsc::error::TrySendError::Closed(())) => false,
        }
    }

    fn publish_shared(&self, frame: &Arc<ServerFrame>) -> bool {
        if self.notify_tx.is_closed() {
            return false;
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.generations.get(&self.task_id) != Some(&self.generation) {
            return false;
        }
        let was_pending = state.pending.remove(&self.task_id).is_some();
        let frame = companion_frame_for_attachment(frame, self.include_assets);
        let retained_bytes = companion_frame_retained_bytes(&frame);
        let (frame, retained_bytes) =
            if reserve_relay_pending_bytes(&self.pending_bytes, retained_bytes) {
                (frame, retained_bytes)
            } else {
                let error = Arc::new(ServerFrame::CompanionError {
                    task_id: self.task_id.clone(),
                    code: "companion_resource_limit".into(),
                    message: "Visual companion relay resources are busy. Reopen the companion."
                        .into(),
                    attachment_epoch: self.attachment_epoch,
                });
                let bytes = companion_frame_retained_bytes(&error);
                if !reserve_relay_pending_bytes(&self.pending_bytes, bytes) {
                    return false;
                }
                (error, bytes)
            };
        if !was_pending {
            state.ready.push_back(self.task_id.clone());
        }
        let replaced = state.pending.insert(
            self.task_id.clone(),
            PendingCompanionFrame {
                frame,
                task_id: self.task_id.clone(),
                generation: self.generation,
                attachment_epoch: self.attachment_epoch,
                accept_snapshot_chunks: self.accept_snapshot_chunks,
                retained_bytes,
                total_retained_bytes: Arc::clone(&self.pending_bytes),
            },
        );
        drop(replaced);
        drop(state);
        match self.notify_tx.try_send(()) {
            Ok(()) | Err(TrySendError::Full(())) => true,
            Err(TrySendError::Closed(())) => false,
        }
    }
}

fn companion_frame_for_attachment(
    frame: &Arc<ServerFrame>,
    include_assets: bool,
) -> Arc<ServerFrame> {
    if include_assets {
        return Arc::clone(frame);
    }
    Arc::new(match frame.as_ref() {
        ServerFrame::CompanionSnapshot {
            task_id,
            session_id,
            revision,
            document_kind,
            html,
            source_origin,
            attachment_epoch,
            ..
        } => ServerFrame::CompanionSnapshot {
            task_id: task_id.clone(),
            session_id: session_id.clone(),
            revision: revision.clone(),
            document_kind: *document_kind,
            html: html.clone(),
            source_origin: source_origin.clone(),
            assets: Vec::new(),
            attachment_epoch: *attachment_epoch,
        },
        other => other.clone(),
    })
}

fn stamp_companion_attachment_epoch(frame: &mut ServerFrame, attachment_epoch: Option<u64>) {
    match frame {
        ServerFrame::CompanionSnapshot {
            attachment_epoch: frame_epoch,
            ..
        }
        | ServerFrame::CompanionSnapshotChunk {
            attachment_epoch: frame_epoch,
            ..
        }
        | ServerFrame::CompanionUnavailable {
            attachment_epoch: frame_epoch,
            ..
        }
        | ServerFrame::CompanionError {
            attachment_epoch: frame_epoch,
            ..
        } => *frame_epoch = attachment_epoch,
        _ => {}
    }
}

fn companion_frame_retained_bytes(frame: &ServerFrame) -> usize {
    match frame {
        ServerFrame::CompanionSnapshot {
            task_id,
            session_id,
            revision,
            html,
            source_origin,
            assets,
            ..
        } => {
            task_id.len()
                + session_id.len()
                + revision.len()
                + html.len()
                + source_origin.as_deref().map_or(0, str::len)
                + assets
                    .iter()
                    .map(|asset| {
                        asset.name.len()
                            + asset.content_type.len()
                            + asset.digest.len()
                            + asset.data_b64.len()
                    })
                    .sum::<usize>()
                + 1024
        }
        _ => 1024,
    }
}

fn reserve_relay_pending_bytes(total: &AtomicUsize, bytes: usize) -> bool {
    reserve_relay_bytes(total, bytes, MAX_RELAY_COMPANION_PENDING_BYTES)
}

fn reserve_relay_bytes(total: &AtomicUsize, bytes: usize, limit: usize) -> bool {
    let mut current = total.load(Ordering::Acquire);
    loop {
        let next = current.saturating_add(bytes);
        if next > limit {
            return false;
        }
        match total.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return true,
            Err(observed) => current = observed,
        }
    }
}

struct OutboundFrameReceiver {
    frame_rx: mpsc::Receiver<ServerFrame>,
    companion_state: Arc<Mutex<CompanionFrameState>>,
    companion_notify_rx: mpsc::Receiver<()>,
    frame_closed: bool,
    companion_closed: bool,
    ordinary_burst: usize,
    active_companion: Option<ActiveCompanionChunks>,
    delivering_companion: Option<PendingCompanionFrame>,
    current_companion_delivery: Option<(String, u64)>,
    generation_epoch: watch::Receiver<u64>,
    preparing_companion:
        Option<tokio::task::JoinHandle<Result<PreparedCompanion, serde_json::Error>>>,
}

struct CompanionDeliveryFence {
    state: Arc<Mutex<CompanionFrameState>>,
    task_id: String,
    generation: u64,
    generation_epoch: watch::Receiver<u64>,
}

impl CompanionDeliveryFence {
    fn is_current(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .generations
            .get(&self.task_id)
            == Some(&self.generation)
    }
}

enum PreparedCompanion {
    Chunks(ActiveCompanionChunks),
    Frame {
        frame: ServerFrame,
        delivery: PendingCompanionFrame,
    },
}

struct ActiveCompanionChunks {
    task_id: String,
    transfer_id: String,
    attachment_epoch: Option<u64>,
    serialized: String,
    offset: usize,
    index: u32,
    count: u32,
    delivery: PendingCompanionFrame,
}

impl ActiveCompanionChunks {
    fn new(delivery: PendingCompanionFrame) -> Result<Self, serde_json::Error> {
        #[cfg(test)]
        let delivery_task_id = delivery.task_id.clone();
        let mut frame = delivery.frame.as_ref().clone();
        stamp_companion_attachment_epoch(&mut frame, delivery.attachment_epoch);
        let ServerFrame::CompanionSnapshot {
            ref task_id,
            ref session_id,
            ref revision,
            ..
        } = &frame
        else {
            unreachable!("only companion snapshots are chunked");
        };
        let task_id = task_id.clone();
        let transfer_id = format!("{session_id}:{revision}");
        #[cfg(test)]
        wait_for_companion_serialize_test_gate(&delivery_task_id);
        let serialized = serde_json::to_string(&frame)?;
        let mut count = 0_u32;
        let mut offset = 0;
        while offset < serialized.len() {
            offset = companion_chunk_end(&serialized, offset);
            count = count.saturating_add(1);
        }
        Ok(Self {
            task_id,
            transfer_id,
            attachment_epoch: delivery.attachment_epoch,
            serialized,
            offset: 0,
            index: 0,
            count,
            delivery,
        })
    }

    fn next(&mut self) -> Option<ServerFrame> {
        if self.offset >= self.serialized.len() {
            return None;
        }
        let end = companion_chunk_end(&self.serialized, self.offset);
        let data = self.serialized[self.offset..end].to_owned();
        let index = self.index;
        self.offset = end;
        self.index = self.index.saturating_add(1);
        Some(ServerFrame::CompanionSnapshotChunk {
            task_id: self.task_id.clone(),
            transfer_id: self.transfer_id.clone(),
            index,
            count: self.count,
            data,
            attachment_epoch: self.attachment_epoch,
        })
    }
}

fn companion_chunk_end(serialized: &str, offset: usize) -> usize {
    let mut end = (offset + COMPANION_SNAPSHOT_CHUNK_DATA_BYTES).min(serialized.len());
    while end > offset && !serialized.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn outbound_frame_channel(
    capacity: usize,
) -> (
    mpsc::Sender<ServerFrame>,
    CompanionFrameSender,
    OutboundFrameReceiver,
) {
    outbound_frame_channel_with_budget(capacity, Arc::new(AtomicUsize::new(0)))
}

fn outbound_frame_channel_with_budget(
    capacity: usize,
    pending_bytes: Arc<AtomicUsize>,
) -> (
    mpsc::Sender<ServerFrame>,
    CompanionFrameSender,
    OutboundFrameReceiver,
) {
    let (frame_tx, frame_rx) = mpsc::channel(capacity);
    let (notify_tx, companion_notify_rx) = mpsc::channel(1);
    let (generation_epoch, generation_epoch_rx) = watch::channel(0_u64);
    let companion_state = Arc::new(Mutex::new(CompanionFrameState::default()));
    (
        frame_tx,
        CompanionFrameSender {
            state: companion_state.clone(),
            notify_tx,
            generation_epoch,
            pending_bytes,
        },
        OutboundFrameReceiver {
            frame_rx,
            companion_state,
            companion_notify_rx,
            frame_closed: false,
            companion_closed: false,
            ordinary_burst: 0,
            active_companion: None,
            delivering_companion: None,
            current_companion_delivery: None,
            generation_epoch: generation_epoch_rx,
            preparing_companion: None,
        },
    )
}

impl OutboundFrameReceiver {
    fn take_companion(&self) -> Option<PendingCompanionFrame> {
        let mut state = self
            .companion_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while let Some(task_id) = state.ready.pop_front() {
            if let Some(pending) = state.pending.remove(&task_id) {
                return Some(pending);
            }
        }
        None
    }

    async fn recv(&mut self) -> Option<ServerFrame> {
        // The previous returned frame has been serialized and delivered before
        // the writer polls again, so its aggregate admission charge can retire.
        self.delivering_companion = None;
        self.current_companion_delivery = None;
        loop {
            if !self.frame_closed && self.ordinary_burst < MAX_ORDINARY_FRAMES_BEFORE_COMPANION {
                match self.frame_rx.try_recv() {
                    Ok(frame) => {
                        self.ordinary_burst += 1;
                        return Some(frame);
                    }
                    Err(mpsc::error::TryRecvError::Disconnected) => self.frame_closed = true,
                    Err(mpsc::error::TryRecvError::Empty) => {}
                }
            }
            if let Some((task_id, generation)) = self
                .active_companion
                .as_ref()
                .map(|active| (active.delivery.task_id.clone(), active.delivery.generation))
            {
                if !self.generation_is_current(&task_id, generation) {
                    self.active_companion = None;
                    continue;
                }
            }
            if let Some(active) = self.active_companion.as_mut() {
                if let Some(frame) = active.next() {
                    self.current_companion_delivery =
                        Some((active.delivery.task_id.clone(), active.delivery.generation));
                    self.ordinary_burst = 0;
                    return Some(frame);
                }
                self.active_companion = None;
            }
            if self
                .preparing_companion
                .as_ref()
                .is_some_and(tokio::task::JoinHandle::is_finished)
            {
                let prepared = self
                    .preparing_companion
                    .take()
                    .expect("finished companion preparation is present")
                    .await;
                if let Ok(Ok(prepared)) = prepared {
                    match prepared {
                        PreparedCompanion::Chunks(active)
                            if self.generation_is_current(
                                &active.delivery.task_id,
                                active.delivery.generation,
                            ) =>
                        {
                            self.active_companion = Some(active);
                        }
                        PreparedCompanion::Frame { frame, delivery }
                            if self
                                .generation_is_current(&delivery.task_id, delivery.generation) =>
                        {
                            self.current_companion_delivery =
                                Some((delivery.task_id.clone(), delivery.generation));
                            self.delivering_companion = Some(delivery);
                            self.ordinary_burst = 0;
                            return Some(frame);
                        }
                        _ => {}
                    }
                }
                continue;
            }
            if self.preparing_companion.is_none() {
                if let Some(delivery) = self.take_companion() {
                    self.preparing_companion = Some(tokio::task::spawn_blocking(move || {
                        if delivery.accept_snapshot_chunks
                            && matches!(
                                delivery.frame.as_ref(),
                                ServerFrame::CompanionSnapshot { .. }
                            )
                        {
                            ActiveCompanionChunks::new(delivery).map(PreparedCompanion::Chunks)
                        } else {
                            let mut frame = delivery.frame.as_ref().clone();
                            stamp_companion_attachment_epoch(&mut frame, delivery.attachment_epoch);
                            Ok(PreparedCompanion::Frame { frame, delivery })
                        }
                    }));
                    continue;
                }
            }
            if !self.frame_closed
                && (self.preparing_companion.is_none()
                    || self.ordinary_burst < MAX_ORDINARY_FRAMES_BEFORE_COMPANION)
            {
                match self.frame_rx.try_recv() {
                    Ok(frame) => {
                        self.ordinary_burst = self.ordinary_burst.saturating_add(1);
                        return Some(frame);
                    }
                    Err(mpsc::error::TryRecvError::Disconnected) => self.frame_closed = true,
                    Err(mpsc::error::TryRecvError::Empty) => {}
                }
            }
            if self.frame_closed && self.companion_closed {
                return None;
            }

            if self.preparing_companion.is_some() {
                let preparing = self
                    .preparing_companion
                    .as_mut()
                    .expect("companion preparation is present");
                tokio::select! {
                    biased;
                    frame = self.frame_rx.recv(), if !self.frame_closed
                        && self.ordinary_burst < MAX_ORDINARY_FRAMES_BEFORE_COMPANION => {
                        match frame {
                            Some(frame) => {
                                self.ordinary_burst =
                                    self.ordinary_burst.saturating_add(1);
                                return Some(frame);
                            }
                            None => self.frame_closed = true,
                        }
                    }
                    prepared = preparing => {
                        self.preparing_companion = None;
                        if let Ok(Ok(prepared)) = prepared {
                            match prepared {
                                PreparedCompanion::Chunks(active)
                                    if self.generation_is_current(
                                        &active.delivery.task_id,
                                        active.delivery.generation,
                                    ) =>
                                {
                                    self.active_companion = Some(active);
                                }
                                PreparedCompanion::Frame { frame, delivery }
                                    if self.generation_is_current(
                                        &delivery.task_id,
                                        delivery.generation,
                                    ) =>
                                {
                                    self.current_companion_delivery =
                                        Some((delivery.task_id.clone(), delivery.generation));
                                    self.delivering_companion = Some(delivery);
                                    self.ordinary_burst = 0;
                                    return Some(frame);
                                }
                                _ => {}
                            }
                        }
                    }
                    notification = self.companion_notify_rx.recv(), if !self.companion_closed => {
                        if notification.is_none() {
                            self.companion_closed = true;
                        }
                    }
                }
                continue;
            }

            tokio::select! {
                biased;
                frame = self.frame_rx.recv(), if !self.frame_closed => {
                    match frame {
                        Some(frame) => {
                            self.ordinary_burst = self.ordinary_burst.saturating_add(1);
                            return Some(frame);
                        }
                        None => self.frame_closed = true,
                    }
                }
                notification = self.companion_notify_rx.recv(), if !self.companion_closed => {
                    if notification.is_none() {
                        self.companion_closed = true;
                    }
                }
            }
        }
    }

    fn generation_is_current(&self, task_id: &str, generation: u64) -> bool {
        self.companion_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .generations
            .get(task_id)
            == Some(&generation)
    }

    fn companion_delivery_fence(&self) -> Option<CompanionDeliveryFence> {
        let (task_id, generation) = self.current_companion_delivery.as_ref()?;
        Some(CompanionDeliveryFence {
            state: Arc::clone(&self.companion_state),
            task_id: task_id.clone(),
            generation: *generation,
            generation_epoch: self.generation_epoch.clone(),
        })
    }
}

async fn await_fenced_companion_send<F, E>(
    send: F,
    mut fence: CompanionDeliveryFence,
) -> Result<Result<(), E>, ()>
where
    F: Future<Output = Result<(), E>>,
{
    if !fence.is_current() {
        return Err(());
    }
    tokio::pin!(send);
    loop {
        tokio::select! {
            result = &mut send => return Ok(result),
            changed = fence.generation_epoch.changed() => {
                if changed.is_err() || !fence.is_current() {
                    return Err(());
                }
            }
        }
    }
}

pub async fn handle_stream(
    socket: WebSocket,
    state: Arc<AppState>,
    auth_mode: AuthMode,
    companion_access: bool,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (incoming_tx, incoming_rx) = mpsc::channel::<String>(256);
    let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel_with_budget(
        256,
        Arc::clone(&state.companion_resources.pending_bytes),
    );

    let reader_task = tokio::spawn(async move {
        while let Some(Ok(message)) = ws_rx.next().await {
            match message {
                WsMessage::Text(text) => {
                    if incoming_tx.send(text.to_string()).await.is_err() {
                        return;
                    }
                }
                WsMessage::Close(_) => return,
                _ => {}
            }
        }
    });
    let writer_task = tokio::spawn(async move {
        while let Some(frame) = outbound_rx.recv().await {
            let delivery_fence = outbound_rx.companion_delivery_fence();
            let serialize_context = terminal_frame_context(&frame, None, "frame_serialize", None);
            let send_context = terminal_frame_context(&frame, None, "websocket_send", None);
            let Ok(Ok(json)) = monitored_terminal_future(
                serialize_context,
                terminal_perf::global_monitor().clone(),
                tokio::task::spawn_blocking(move || serde_json::to_string(&frame)),
            )
            .await
            else {
                continue;
            };
            if delivery_fence
                .as_ref()
                .is_some_and(|fence| !fence.is_current())
            {
                continue;
            }
            let send = monitored_terminal_future(
                send_context,
                terminal_perf::global_monitor().clone(),
                ws_tx.send(WsMessage::Text(json.into())),
            );
            if let Some(fence) = delivery_fence {
                match await_fenced_companion_send(send, fence).await {
                    Ok(Ok(())) => {}
                    // A real transport failure ends the connection.
                    Ok(Err(_)) => return,
                    // The attachment epoch moved on while this companion frame
                    // was blocked on backpressure: the frame is stale, not the
                    // socket. Keep writing — clients fence by epoch, so a
                    // half-buffered stale frame flushed later is harmless,
                    // while returning here would leave the reader half of the
                    // connection alive with no writer and no close frame.
                    Err(()) => continue,
                }
            } else if send.await.is_err() {
                return;
            }
        }
    });

    handle_stream_channels(
        incoming_rx,
        frame_tx,
        companion_tx,
        state,
        auth_mode,
        companion_access,
    )
    .await;
    reader_task.abort();
    let _ = writer_task.await;
}

pub async fn handle_tungstenite_stream(
    socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    state: Arc<AppState>,
    auth_mode: AuthMode,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (incoming_tx, incoming_rx) = mpsc::channel::<String>(256);
    let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(256);

    let reader_task = tokio::spawn(async move {
        while let Some(Ok(message)) = ws_rx.next().await {
            match message {
                TungsteniteMessage::Text(text) => {
                    if incoming_tx.send(text.to_string()).await.is_err() {
                        return;
                    }
                }
                TungsteniteMessage::Close(_) => return,
                _ => {}
            }
        }
    });
    let writer_task = tokio::spawn(async move {
        while let Some(frame) = outbound_rx.recv().await {
            let delivery_fence = outbound_rx.companion_delivery_fence();
            let serialize_context = terminal_frame_context(&frame, None, "frame_serialize", None);
            let send_context = terminal_frame_context(&frame, None, "websocket_send", None);
            let Ok(Ok(json)) = monitored_terminal_future(
                serialize_context,
                terminal_perf::global_monitor().clone(),
                tokio::task::spawn_blocking(move || serde_json::to_string(&frame)),
            )
            .await
            else {
                continue;
            };
            if delivery_fence
                .as_ref()
                .is_some_and(|fence| !fence.is_current())
            {
                continue;
            }
            let send = monitored_terminal_future(
                send_context,
                terminal_perf::global_monitor().clone(),
                ws_tx.send(TungsteniteMessage::Text(json.into())),
            );
            if let Some(fence) = delivery_fence {
                match await_fenced_companion_send(send, fence).await {
                    Ok(Ok(())) => {}
                    // A real transport failure ends the connection.
                    Ok(Err(_)) => return,
                    // The attachment epoch moved on while this companion frame
                    // was blocked on backpressure: the frame is stale, not the
                    // socket. Keep writing — clients fence by epoch, so a
                    // half-buffered stale frame flushed later is harmless,
                    // while returning here would leave the reader half of the
                    // connection alive with no writer and no close frame.
                    Err(()) => continue,
                }
            } else if send.await.is_err() {
                return;
            }
        }
    });

    handle_stream_channels(incoming_rx, frame_tx, companion_tx, state, auth_mode, true).await;
    reader_task.abort();
    let _ = writer_task.await;
}

async fn handle_stream_channels(
    mut incoming_rx: mpsc::Receiver<String>,
    frame_tx: mpsc::Sender<ServerFrame>,
    companion_tx: CompanionFrameSender,
    state: Arc<AppState>,
    auth_mode: AuthMode,
    companion_access: bool,
) {
    let mut state_change_rx = state.subscribe_state_changes();
    let state_change_tx = frame_tx.clone();
    let state_change_task = tokio::spawn(async move {
        loop {
            match state_change_rx.recv().await {
                Ok(frame) => {
                    if state_change_tx.send(frame).await.is_err() {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    });
    let mut conn = StreamConn {
        state,
        frame_tx,
        companion_tx,
        attachments: HashMap::new(),
        terminal_controls: HashMap::new(),
        terminal_inputs: HashMap::new(),
        agent_commands: None,
        requests: None,
        companion_events: None,
        authed: false,
        supports_companion_event_epoch: false,
        legacy_companion_tasks_on_connection: HashSet::new(),
        auth_mode,
        companion_access,
    };

    while let Some(message) = incoming_rx.recv().await {
        if is_relay_tunnel_control_message(&message) {
            continue;
        }
        match serde_json::from_str::<ClientFrame>(&message) {
            Ok(frame) => {
                if !conn.handle(frame).await {
                    break;
                }
            }
            Err(error) => {
                conn.error(None, "bad_frame", format!("unparseable frame: {error}"))
                    .await;
            }
        }
    }

    // Abort attachment tasks, then drop our senders so the socket writer
    // drains queued ordinary frames and latest companion values before exit.
    conn.shutdown().await;
    drop(conn);
    state_change_task.abort();
}

fn is_relay_tunnel_control_message(message: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(message)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(|kind| kind.as_str())
                .map(str::to_string)
        })
        .is_some_and(|kind| kind == "tunnel_ready")
}

struct StreamConn {
    state: Arc<AppState>,
    frame_tx: mpsc::Sender<ServerFrame>,
    companion_tx: CompanionFrameSender,
    attachments: HashMap<(String, StreamKind), StreamAttachment>,
    terminal_controls: HashMap<String, TerminalControlHandle>,
    terminal_inputs: HashMap<String, TerminalInputHandle>,
    agent_commands: Option<AgentCommandWorker>,
    requests: Option<RequestWorker>,
    companion_events: Option<CompanionEventWorker>,
    authed: bool,
    supports_companion_event_epoch: bool,
    legacy_companion_tasks_on_connection: HashSet<String>,
    auth_mode: AuthMode,
    companion_access: bool,
}

struct StreamAttachment {
    task: JoinHandle<()>,
    attachment_epoch: Option<u64>,
    accepts_legacy_companion_events: bool,
}

const TERMINAL_CONTROL_QUEUE_CAPACITY: usize = 256;
const TERMINAL_INPUT_QUEUE_CAPACITY: usize = 64;
const MAX_TERMINAL_INPUT_ROUTES: usize = 64;
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const TERMINAL_INPUT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const TERMINAL_INPUT_RETIRE_TIMEOUT: Duration = Duration::from_millis(100);
const AGENT_COMMAND_QUEUE_CAPACITY: usize = 256;
const REQUEST_QUEUE_CAPACITY: usize = 32;
const MAX_REQUEST_CONCURRENCY: usize = 4;
const COMPANION_EVENT_QUEUE_CAPACITY: usize = 64;
const COMPANION_EVENT_WINDOW: Duration = Duration::from_secs(10);
const MAX_COMPANION_EVENTS_PER_WINDOW: usize = 30;
const MAX_COMPANION_RATE_LIMIT_KEYS: usize = 64;

enum AgentControlCommand {
    Input(String),
    Permission {
        request_id: String,
        decision: PermissionDecision,
    },
    Interrupt,
    SetModel(String),
}

impl AgentControlCommand {
    fn into_daemon_command(self, session_id: String) -> DaemonCommand {
        match self {
            Self::Input(text) => DaemonCommand::AgentInput { session_id, text },
            Self::Permission {
                request_id,
                decision,
            } => DaemonCommand::AgentPermission {
                session_id,
                request_id,
                decision,
            },
            Self::Interrupt => DaemonCommand::AgentInterrupt { session_id },
            Self::SetModel(model) => DaemonCommand::AgentSetModel { session_id, model },
        }
    }
}

struct TaskAgentCommand {
    task_id: String,
    command: AgentControlCommand,
}

struct AgentCommandWorker {
    tx: mpsc::Sender<TaskAgentCommand>,
    task: JoinHandle<()>,
}

struct KspRequest {
    id: u64,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
}

struct RequestWorker {
    tx: mpsc::Sender<KspRequest>,
    task: JoinHandle<()>,
}

struct CompanionEventRequest {
    task_id: String,
    session_id: String,
    revision: String,
    attachment_epoch: Option<u64>,
    event: CompanionEvent,
}

struct CompanionEventWorker {
    tx: mpsc::Sender<CompanionEventRequest>,
    task: JoinHandle<()>,
}

pub(crate) fn request_concurrency() -> usize {
    std::thread::available_parallelism()
        .map(|parallelism| {
            parallelism
                .get()
                .saturating_sub(1)
                .clamp(1, MAX_REQUEST_CONCURRENCY)
        })
        .unwrap_or(1)
}

enum TerminalControlCommand {
    #[cfg(test)]
    Input(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
    },
}

impl TerminalControlCommand {
    fn into_daemon_command(self, session_id: String) -> DaemonCommand {
        match self {
            #[cfg(test)]
            Self::Input(data) => DaemonCommand::InputNoReply { session_id, data },
            Self::Resize { cols, rows } => DaemonCommand::ResizeNoReply {
                session_id,
                cols,
                rows,
            },
        }
    }
}

struct TerminalControlHandle {
    session_id: Option<String>,
    tx: mpsc::Sender<TerminalControlCommand>,
    cancel_tx: watch::Sender<bool>,
    task: JoinHandle<()>,
}

struct TerminalInputHandle {
    session_id: Option<String>,
    tx: mpsc::Sender<TerminalInputRequest>,
    cancel_tx: watch::Sender<bool>,
    pending: Arc<Mutex<TerminalInputPending>>,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct TerminalInputPending {
    queued: usize,
    in_flight: usize,
    retiring: bool,
}

struct TerminalInputRequest {
    data: Vec<u8>,
    admission: crate::task_input_queue::TaskInputAdmission,
}

async fn terminal_control_cancelled(cancel_rx: &mut watch::Receiver<bool>) {
    if *cancel_rx.borrow() {
        return;
    }
    let _ = cancel_rx.changed().await;
}

async fn terminal_control_retry_delay(
    attempt: usize,
    cancel_rx: &mut watch::Receiver<bool>,
) -> bool {
    tokio::select! {
        biased;
        _ = terminal_control_cancelled(cancel_rx) => false,
        _ = daemon_stream_retry_delay(attempt) => true,
    }
}

async fn send_task_error(
    frame_tx: &mpsc::Sender<ServerFrame>,
    task_id: &str,
    code: &str,
    message: String,
) {
    let _ = frame_tx
        .send(ServerFrame::Error {
            task_id: Some(task_id.to_string()),
            code: code.to_string(),
            message,
        })
        .await;
}

fn try_send_task_error(
    frame_tx: &mpsc::Sender<ServerFrame>,
    task_id: &str,
    code: &str,
    message: String,
) {
    let _ = frame_tx.try_send(ServerFrame::Error {
        task_id: Some(task_id.to_string()),
        code: code.to_string(),
        message,
    });
}

async fn resolve_task_session_id(db_path: String, task_id: String) -> Result<String, String> {
    let lookup_task_id = task_id.clone();
    tokio::task::spawn_blocking(move || {
        Db::open(db_path.as_str())
            .and_then(|db| db.resolve_task_terminal_session_id(&lookup_task_id))
            .map_err(|error| format!("db error: {error}"))?
            .ok_or_else(|| format!("no session for task {lookup_task_id}"))
    })
    .await
    .map_err(|error| format!("session lookup worker failed: {error}"))?
}

fn direct_terminal_session_id(task_id: &str) -> Option<String> {
    task_id.starts_with("shell-").then(|| task_id.to_string())
}

async fn run_terminal_input(
    state: Arc<AppState>,
    task_id: String,
    initial_session_id: Option<String>,
    mut input_rx: mpsc::Receiver<TerminalInputRequest>,
    mut cancel_rx: watch::Receiver<bool>,
    pending: Arc<Mutex<TerminalInputPending>>,
    frame_tx: mpsc::Sender<ServerFrame>,
) {
    let session_id = match initial_session_id {
        Some(session_id) => session_id,
        None => match tokio::select! {
            biased;
            _ = terminal_control_cancelled(&mut cancel_rx) => return,
            resolved = resolve_task_session_id(
                state.config().db_path.clone(),
                task_id.clone(),
            ) => resolved,
        } {
            Ok(session_id) => session_id,
            Err(message) => {
                let dropped = {
                    let mut pending = pending
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    pending.retiring = true;
                    let dropped = pending.queued + pending.in_flight;
                    pending.queued = 0;
                    pending.in_flight = 0;
                    dropped
                };
                try_send_task_error(
                    &frame_tx,
                    &task_id,
                    "no_session",
                    format!("{message}; rejected {dropped} queued terminal input frame(s)"),
                );
                return;
            }
        },
    };

    loop {
        let request = tokio::select! {
            biased;
            _ = terminal_control_cancelled(&mut cancel_rx) => return,
            request = tokio::time::timeout(TERMINAL_INPUT_IDLE_TIMEOUT, input_rx.recv()) => {
                match request {
                    Ok(Some(request)) => request,
                    Ok(None) => {
                        pending
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .retiring = true;
                        return;
                    }
                    Err(_) => {
                        let mut pending = pending
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        if pending.queued == 0 {
                            pending.retiring = true;
                            return;
                        }
                        continue;
                    }
                }
            }
        };
        {
            let mut pending = pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if pending.retiring {
                return;
            }
            pending.queued = pending.queued.saturating_sub(1);
            pending.in_flight = pending.in_flight.saturating_add(1);
        }
        let result = tokio::select! {
            biased;
            _ = terminal_control_cancelled(&mut cancel_rx) => return,
            result = state.task_input.send_operator_bytes_at_admission(
                &task_id,
                &session_id,
                request.data,
                request.admission,
            ) => result,
        };
        {
            let mut pending = pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !pending.retiring {
                pending.in_flight = pending.in_flight.saturating_sub(1);
            }
        }
        if let Err(error) = result {
            let message = match error {
                crate::task_input_queue::TaskInputError::SessionNotFound => {
                    format!("session not found: {session_id}")
                }
                crate::task_input_queue::TaskInputError::Other(message)
                | crate::task_input_queue::TaskInputError::Uncertain(message) => message,
            };
            try_send_task_error(&frame_tx, &task_id, "daemon", message);
        }
    }
}

async fn run_terminal_control(
    state: Arc<AppState>,
    task_id: String,
    initial_session_id: Option<String>,
    mut command_rx: mpsc::Receiver<TerminalControlCommand>,
    mut cancel_rx: watch::Receiver<bool>,
    frame_tx: mpsc::Sender<ServerFrame>,
) {
    let session_id = match initial_session_id {
        Some(session_id) => session_id,
        None => {
            let resolved = tokio::select! {
                biased;
                _ = terminal_control_cancelled(&mut cancel_rx) => return,
                resolved = resolve_task_session_id(
                    state.config().db_path.clone(),
                    task_id.clone(),
                ) => resolved,
            };
            match resolved {
                Ok(session_id) => session_id,
                Err(message) => {
                    tokio::select! {
                        biased;
                        _ = terminal_control_cancelled(&mut cancel_rx) => return,
                        _ = send_task_error(&frame_tx, &task_id, "no_session", message) => {}
                    }
                    return;
                }
            }
        }
    };
    let daemon_dir = state.config().daemon_dir.clone();
    let mut retry_attempt = 0usize;
    // Do not open an otherwise idle control socket merely because a terminal
    // attached for output. Keep the first command pending across definite
    // connect failures; after the first connection, reconnect proactively so
    // handoff recovery is ready before the next keypress.
    let mut pending_command = Some(tokio::select! {
        biased;
        _ = terminal_control_cancelled(&mut cancel_rx) => return,
        command = command_rx.recv() => {
            let Some(command) = command else {
                return;
            };
            command
        }
    });

    loop {
        let connected = tokio::select! {
            biased;
            _ = terminal_control_cancelled(&mut cancel_rx) => return,
            connected = async {
                DaemonClient::connect(&daemon_dir)
                    .await
                    .map_err(|error| error.to_string())
            } => connected,
        };
        let client = match connected {
            Ok(client) => client,
            Err(error) => {
                log::warn!(
                    "[ksp] terminal control failed to connect (session={session_id}, attempt={retry_attempt}): {error}"
                );
                if !terminal_control_retry_delay(retry_attempt, &mut cancel_rx).await {
                    return;
                }
                retry_attempt += 1;
                continue;
            }
        };
        let (mut daemon_reader, mut daemon_writer) = client.into_split();
        retry_attempt = 0;

        if let Some(command) = pending_command.take() {
            let daemon_command = command.into_daemon_command(session_id.clone());
            let write_result = tokio::select! {
                biased;
                _ = terminal_control_cancelled(&mut cancel_rx) => return,
                result = async {
                    daemon_writer
                        .send_one_way(&daemon_command)
                        .await
                        .map_err(|error| error.to_string())
                } => result,
            };
            if let Err(error) = write_result {
                let message = format!(
                    "terminal command write was ambiguous and will not be retried: {error}"
                );
                log::warn!("[ksp] {message} (session={session_id})");
                tokio::select! {
                    biased;
                    _ = terminal_control_cancelled(&mut cancel_rx) => return,
                    _ = send_task_error(&frame_tx, &task_id, "daemon", message) => {}
                }
                if !terminal_control_retry_delay(retry_attempt, &mut cancel_rx).await {
                    return;
                }
                retry_attempt += 1;
                continue;
            }
        }

        loop {
            tokio::select! {
                biased;
                _ = terminal_control_cancelled(&mut cancel_rx) => return,
                event = async {
                    daemon_reader
                        .read_event()
                        .await
                        .map_err(|error| error.to_string())
                } => {
                    match event {
                        Ok(DaemonEvent::Error { message, .. }) => {
                            tokio::select! {
                                biased;
                                _ = terminal_control_cancelled(&mut cancel_rx) => return,
                                _ = send_task_error(&frame_tx, &task_id, "daemon", message) => {}
                            }
                        }
                        Ok(DaemonEvent::ShuttingDown) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
                command = command_rx.recv() => {
                    let Some(command) = command else {
                        return;
                    };
                    let daemon_command = command.into_daemon_command(session_id.clone());
                    let write_result = tokio::select! {
                        biased;
                        _ = terminal_control_cancelled(&mut cancel_rx) => return,
                        result = async {
                            daemon_writer
                                .send_one_way(&daemon_command)
                                .await
                                .map_err(|error| error.to_string())
                        } => result,
                    };
                    if let Err(error) = write_result {
                        let message = format!(
                            "terminal command write was ambiguous and will not be retried: {error}"
                        );
                        log::warn!("[ksp] {message} (session={session_id})");
                        tokio::select! {
                            biased;
                            _ = terminal_control_cancelled(&mut cancel_rx) => return,
                            _ = send_task_error(&frame_tx, &task_id, "daemon", message) => {}
                        }
                        break;
                    }
                }
            }
        }

        if !terminal_control_retry_delay(retry_attempt, &mut cancel_rx).await {
            return;
        }
        retry_attempt += 1;
    }
}

async fn run_agent_commands(
    state: Arc<AppState>,
    mut command_rx: mpsc::Receiver<TaskAgentCommand>,
    frame_tx: mpsc::Sender<ServerFrame>,
) {
    while let Some(TaskAgentCommand { task_id, command }) = command_rx.recv().await {
        let session_id =
            match resolve_task_session_id(state.config().db_path.clone(), task_id.clone()).await {
                Ok(session_id) => session_id,
                Err(message) => {
                    send_task_error(&frame_tx, &task_id, "no_session", message).await;
                    continue;
                }
            };
        let daemon_command = command.into_daemon_command(session_id);
        let result = async {
            let mut client = DaemonClient::connect(&state.config().daemon_dir)
                .await
                .map_err(|error| format!("daemon error: {error}"))?;
            client
                .send_command_retrying_successor(&daemon_command)
                .await
                .map_err(|error| format!("daemon error: {error}"))
        }
        .await;
        match result {
            Ok(DaemonEvent::Ok) => {}
            Ok(DaemonEvent::Error { message, .. }) => {
                send_task_error(&frame_tx, &task_id, "daemon", message).await;
            }
            Ok(other) => {
                send_task_error(
                    &frame_tx,
                    &task_id,
                    "daemon",
                    format!("unexpected daemon reply: {other:?}"),
                )
                .await;
            }
            Err(message) => {
                send_task_error(&frame_tx, &task_id, "daemon", message).await;
            }
        }
    }
}

async fn dispatch_ksp_request(
    state: Arc<AppState>,
    frame_tx: mpsc::Sender<ServerFrame>,
    request: KspRequest,
) {
    let KspRequest {
        id,
        method,
        path,
        body,
    } = request;
    let runtime = tokio::runtime::Handle::current();
    let result = tokio::task::spawn_blocking(move || {
        runtime.block_on(dispatch_authenticated_http_invoke(
            state,
            &method,
            &path,
            body.unwrap_or(serde_json::Value::Null),
        ))
    })
    .await;
    let (status, body) = match result {
        Ok(result) => {
            let body = match result.error {
                Some(error) => Some(serde_json::json!({ "error": error })),
                None => result.body,
            };
            (result.status, body)
        }
        Err(error) => (
            500,
            Some(serde_json::json!({
                "error": format!("KSP request worker failed: {error}")
            })),
        ),
    };
    let _ = frame_tx
        .send(ServerFrame::Response { id, status, body })
        .await;
}

async fn run_request_worker(
    state: Arc<AppState>,
    frame_tx: mpsc::Sender<ServerFrame>,
    mut request_rx: mpsc::Receiver<KspRequest>,
) {
    let concurrency = request_concurrency();
    let mut active = tokio::task::JoinSet::new();

    loop {
        if active.len() >= concurrency {
            let _ = active.join_next().await;
            continue;
        }

        tokio::select! {
            request = request_rx.recv() => {
                let Some(request) = request else {
                    break;
                };
                active.spawn(dispatch_ksp_request(
                    state.clone(),
                    frame_tx.clone(),
                    request,
                ));
            }
            completed = active.join_next(), if !active.is_empty() => {
                let _ = completed;
            }
        }
    }
}

async fn send_companion_event_result(
    frame_tx: &mpsc::Sender<ServerFrame>,
    task_id: String,
    session_id: String,
    revision: String,
    attachment_epoch: Option<u64>,
    event_id: String,
    result: Result<(), kanna_visual_companion::CompanionError>,
) {
    let (accepted, code, message) = match result {
        Ok(()) => (true, None, None),
        Err(kanna_visual_companion::CompanionError::StaleRevision) => (
            false,
            Some("companion_stale_revision".into()),
            Some("The visual companion changed before the selection arrived.".into()),
        ),
        Err(kanna_visual_companion::CompanionError::InvalidEvent) => (
            false,
            Some("companion_invalid_event".into()),
            Some("The visual companion selection was invalid.".into()),
        ),
        Err(_) => (
            false,
            Some("companion_event_failed".into()),
            Some("The visual companion selection could not be recorded.".into()),
        ),
    };
    let _ = frame_tx
        .send(ServerFrame::CompanionEventResult {
            task_id,
            session_id: Some(session_id),
            revision: Some(revision),
            event_id,
            accepted,
            code,
            message,
            attachment_epoch,
        })
        .await;
}

async fn run_companion_event_worker(
    db_path: String,
    frame_tx: mpsc::Sender<ServerFrame>,
    mut request_rx: mpsc::Receiver<CompanionEventRequest>,
) {
    let mut recent_by_source: HashMap<(String, String), VecDeque<Instant>> = HashMap::new();
    while let Some(request) = request_rx.recv().await {
        let CompanionEventRequest {
            task_id,
            session_id,
            revision,
            attachment_epoch,
            event,
        } = request;
        let event_id = event.event_id.clone();
        let key = (task_id.clone(), session_id.clone());
        let now = Instant::now();
        for recent in recent_by_source.values_mut() {
            while recent
                .front()
                .is_some_and(|timestamp| now.duration_since(*timestamp) >= COMPANION_EVENT_WINDOW)
            {
                recent.pop_front();
            }
        }
        recent_by_source.retain(|_, recent| !recent.is_empty());
        let rate_limited = recent_by_source
            .get(&key)
            .is_some_and(|recent| recent.len() >= MAX_COMPANION_EVENTS_PER_WINDOW)
            || (!recent_by_source.contains_key(&key)
                && recent_by_source.len() >= MAX_COMPANION_RATE_LIMIT_KEYS);
        if rate_limited {
            let _ = frame_tx
                .send(ServerFrame::CompanionEventResult {
                    task_id,
                    session_id: Some(session_id),
                    revision: Some(revision),
                    event_id,
                    accepted: false,
                    code: Some("companion_rate_limited".into()),
                    message: Some("Too many visual companion selections were sent.".into()),
                    attachment_epoch,
                })
                .await;
            continue;
        }

        let append_db_path = db_path.clone();
        let append_task_id = task_id.clone();
        let append_session_id = session_id.clone();
        let append_revision = revision.clone();
        let append_event = event;
        let append_result = tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            wait_for_companion_append_test_gate(&append_event.event_id);
            crate::visual_companion::append_event(
                &append_db_path,
                &append_task_id,
                &append_session_id,
                &append_revision,
                &append_event,
            )
        })
        .await
        .unwrap_or_else(|_| {
            Err(kanna_visual_companion::CompanionError::Internal(
                "visual companion event worker failed".into(),
            ))
        });
        if append_result.is_ok() {
            recent_by_source
                .entry(key)
                .or_default()
                .push_back(Instant::now());
            #[cfg(test)]
            wait_for_companion_ack_test_gate(&event_id).await;
        }
        send_companion_event_result(
            &frame_tx,
            task_id,
            session_id,
            revision,
            attachment_epoch,
            event_id,
            append_result,
        )
        .await;
    }
}

impl StreamConn {
    async fn send(&self, frame: ServerFrame) {
        let _ = self.frame_tx.send(frame).await;
    }

    async fn error(&self, task_id: Option<String>, code: &str, message: String) {
        self.send(ServerFrame::Error {
            task_id,
            code: code.to_string(),
            message,
        })
        .await;
    }

    async fn shutdown(&mut self) {
        for ((task_id, kind), attachment) in self.attachments.drain() {
            attachment.task.abort();
            let _ = attachment.task.await;
            if kind == StreamKind::Companion {
                self.companion_tx.invalidate(&task_id);
            }
        }
        let controls = self
            .terminal_controls
            .drain()
            .map(|(_, control)| control)
            .collect::<Vec<_>>();
        for control in &controls {
            let _ = control.cancel_tx.send(true);
        }
        for control in controls {
            let _ = control.task.await;
        }
        let inputs = self.terminal_inputs.drain().collect::<Vec<_>>();
        for (task_id, input) in inputs {
            self.retire_terminal_input(&task_id, input).await;
        }
        if let Some(worker) = self.agent_commands.take() {
            worker.task.abort();
        }
        if let Some(worker) = self.requests.take() {
            worker.task.abort();
        }
        if let Some(worker) = self.companion_events.take() {
            worker.task.abort();
        }
    }

    async fn retire_terminal_input(&self, task_id: &str, input: TerminalInputHandle) {
        let (queued, in_flight) = {
            let mut pending = input
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            pending.retiring = true;
            let snapshot = (pending.queued, pending.in_flight);
            pending.queued = 0;
            pending.in_flight = 0;
            snapshot
        };
        if queued > 0 || in_flight > 0 {
            let _ = tokio::time::timeout(
                TERMINAL_INPUT_RETIRE_TIMEOUT,
                send_task_error(
                    &self.frame_tx,
                    task_id,
                    "terminal_input_canceled",
                    format!(
                        "canceled {queued} queued terminal input frame(s); {in_flight} in-flight frame(s) may have been delivered"
                    ),
                ),
            )
            .await;
        }
        let _ = input.cancel_tx.send(true);
        let mut task = input.task;
        if tokio::time::timeout(TERMINAL_INPUT_RETIRE_TIMEOUT, &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }

    fn prune_finished_terminal_inputs(&mut self) {
        let finished = self
            .terminal_inputs
            .iter()
            .filter(|(_, input)| input.task.is_finished())
            .map(|(task_id, _)| task_id.clone())
            .collect::<Vec<_>>();
        for task_id in finished {
            self.terminal_inputs.remove(&task_id);
        }
    }

    async fn retire_terminal_control(control: TerminalControlHandle) {
        let _ = control.cancel_tx.send(true);
        let _ = control.task.await;
    }

    fn create_terminal_input(
        &self,
        task_id: String,
        session_id: Option<String>,
    ) -> TerminalInputHandle {
        let (tx, input_rx) = mpsc::channel(TERMINAL_INPUT_QUEUE_CAPACITY);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let pending = Arc::new(Mutex::new(TerminalInputPending::default()));
        let task = tokio::spawn(run_terminal_input(
            self.state.clone(),
            task_id,
            session_id.clone(),
            input_rx,
            cancel_rx,
            Arc::clone(&pending),
            self.frame_tx.clone(),
        ));
        TerminalInputHandle {
            session_id,
            tx,
            cancel_tx,
            pending,
            task,
        }
    }

    async fn replace_terminal_input_route(&mut self, task_id: &str, session_id: String) {
        let route_matches = self
            .terminal_inputs
            .get(task_id)
            .is_some_and(|input| input.session_id.as_deref() == Some(session_id.as_str()));
        if route_matches {
            return;
        }
        if let Some(existing) = self.terminal_inputs.remove(task_id) {
            self.retire_terminal_input(task_id, existing).await;
        }
        let input = self.create_terminal_input(task_id.to_string(), Some(session_id));
        self.terminal_inputs.insert(task_id.to_string(), input);
    }

    fn enqueue_terminal_input(&mut self, task_id: String, data: Vec<u8>) {
        enum EnqueueAttempt {
            Sent,
            Retiring,
            Full,
            Closed,
        }

        if data.len() > MAX_TERMINAL_INPUT_BYTES {
            try_send_task_error(
                &self.frame_tx,
                &task_id,
                "terminal_input_too_large",
                format!("terminal input frame exceeds the {MAX_TERMINAL_INPUT_BYTES}-byte limit"),
            );
            return;
        }
        self.prune_finished_terminal_inputs();
        let admission_session_id = self
            .terminal_inputs
            .get(&task_id)
            .and_then(|input| input.session_id.clone())
            .or_else(|| direct_terminal_session_id(&task_id));
        let admission = self
            .state
            .task_input
            .capture_operator_admission(admission_session_id.as_deref());
        for attempt in 0..2 {
            if !self.terminal_inputs.contains_key(&task_id) {
                if self.terminal_inputs.len() >= MAX_TERMINAL_INPUT_ROUTES {
                    try_send_task_error(
                        &self.frame_tx,
                        &task_id,
                        "terminal_input_resource_limit",
                        format!(
                            "this connection already owns {MAX_TERMINAL_INPUT_ROUTES} terminal input routes"
                        ),
                    );
                    return;
                }
                let session_id = direct_terminal_session_id(&task_id);
                let input = self.create_terminal_input(task_id.clone(), session_id);
                self.terminal_inputs.insert(task_id.clone(), input);
            }

            let input = self
                .terminal_inputs
                .get(&task_id)
                .expect("terminal input inserted");
            let send_result = {
                let mut pending = input
                    .pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if pending.retiring {
                    EnqueueAttempt::Retiring
                } else {
                    match input.tx.try_send(TerminalInputRequest {
                        data: data.clone(),
                        admission: admission.clone(),
                    }) {
                        Ok(()) => {
                            pending.queued = pending.queued.saturating_add(1);
                            EnqueueAttempt::Sent
                        }
                        Err(TrySendError::Full(_)) => EnqueueAttempt::Full,
                        Err(TrySendError::Closed(_)) => {
                            pending.retiring = true;
                            EnqueueAttempt::Closed
                        }
                    }
                }
            };
            #[cfg(test)]
            run_terminal_input_send_test_hook(&task_id);
            match send_result {
                EnqueueAttempt::Sent => return,
                EnqueueAttempt::Retiring => {
                    if let Some(input) = self.terminal_inputs.remove(&task_id) {
                        input.task.abort();
                    }
                    if attempt == 1 {
                        try_send_task_error(
                            &self.frame_tx,
                            &task_id,
                            "terminal_input_unavailable",
                            "terminal input worker retired before accepting input".to_string(),
                        );
                        return;
                    }
                    continue;
                }
                EnqueueAttempt::Full => {
                    try_send_task_error(
                        &self.frame_tx,
                        &task_id,
                        "terminal_input_busy",
                        "terminal input queue is full".to_string(),
                    );
                    return;
                }
                EnqueueAttempt::Closed => {
                    if let Some(input) = self.terminal_inputs.remove(&task_id) {
                        input.task.abort();
                    }
                    if attempt == 1 {
                        try_send_task_error(
                            &self.frame_tx,
                            &task_id,
                            "terminal_input_unavailable",
                            "terminal input channel closed".to_string(),
                        );
                        return;
                    }
                }
            }
        }
    }

    fn create_terminal_control(
        &self,
        task_id: String,
        session_id: Option<String>,
    ) -> TerminalControlHandle {
        let (tx, command_rx) = mpsc::channel(TERMINAL_CONTROL_QUEUE_CAPACITY);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let task = tokio::spawn(run_terminal_control(
            self.state.clone(),
            task_id,
            session_id.clone(),
            command_rx,
            cancel_rx,
            self.frame_tx.clone(),
        ));
        TerminalControlHandle {
            session_id,
            tx,
            cancel_tx,
            task,
        }
    }

    async fn replace_terminal_control_route(&mut self, task_id: &str, session_id: String) {
        let route_matches = self
            .terminal_controls
            .get(task_id)
            .is_some_and(|control| control.session_id.as_deref() == Some(session_id.as_str()));
        if route_matches {
            return;
        }
        if let Some(existing) = self.terminal_controls.remove(task_id) {
            Self::retire_terminal_control(existing).await;
        }
        let control = self.create_terminal_control(task_id.to_string(), Some(session_id));
        self.terminal_controls.insert(task_id.to_string(), control);
    }

    fn enqueue_terminal_control(&mut self, task_id: String, command: TerminalControlCommand) {
        if !self.terminal_controls.contains_key(&task_id) {
            let session_id = task_id.starts_with("shell-").then(|| task_id.to_string());
            let control = self.create_terminal_control(task_id.clone(), session_id);
            self.terminal_controls.insert(task_id.clone(), control);
        }

        let send_result = self
            .terminal_controls
            .get(&task_id)
            .expect("terminal control inserted")
            .tx
            .try_send(command);
        match send_result {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                let frame_tx = self.frame_tx.clone();
                tokio::spawn(async move {
                    send_task_error(
                        &frame_tx,
                        &task_id,
                        "terminal_busy",
                        "terminal input queue is full".to_string(),
                    )
                    .await;
                });
            }
            Err(TrySendError::Closed(_)) => {
                if let Some(control) = self.terminal_controls.remove(&task_id) {
                    let _ = control.cancel_tx.send(true);
                    control.task.abort();
                }
                let frame_tx = self.frame_tx.clone();
                tokio::spawn(async move {
                    send_task_error(
                        &frame_tx,
                        &task_id,
                        "daemon",
                        "terminal control channel closed".to_string(),
                    )
                    .await;
                });
            }
        }
    }

    fn enqueue_agent_command(&mut self, task_id: String, command: AgentControlCommand) {
        if self.agent_commands.is_none() {
            let (tx, command_rx) = mpsc::channel(AGENT_COMMAND_QUEUE_CAPACITY);
            let task = tokio::spawn(run_agent_commands(
                self.state.clone(),
                command_rx,
                self.frame_tx.clone(),
            ));
            self.agent_commands = Some(AgentCommandWorker { tx, task });
        }

        let send_result = self
            .agent_commands
            .as_ref()
            .expect("agent command worker initialized")
            .tx
            .try_send(TaskAgentCommand {
                task_id: task_id.clone(),
                command,
            });
        match send_result {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                let frame_tx = self.frame_tx.clone();
                tokio::spawn(async move {
                    send_task_error(
                        &frame_tx,
                        &task_id,
                        "agent_busy",
                        "agent command queue is full".to_string(),
                    )
                    .await;
                });
            }
            Err(TrySendError::Closed(_)) => {
                if let Some(worker) = self.agent_commands.take() {
                    worker.task.abort();
                }
                let frame_tx = self.frame_tx.clone();
                tokio::spawn(async move {
                    send_task_error(
                        &frame_tx,
                        &task_id,
                        "daemon",
                        "agent command channel closed".to_string(),
                    )
                    .await;
                });
            }
        }
    }

    fn enqueue_request(&mut self, request: KspRequest) {
        if self.requests.is_none() {
            let (tx, request_rx) = mpsc::channel(REQUEST_QUEUE_CAPACITY);
            let task = tokio::spawn(run_request_worker(
                self.state.clone(),
                self.frame_tx.clone(),
                request_rx,
            ));
            self.requests = Some(RequestWorker { tx, task });
        }

        let send_result = self
            .requests
            .as_ref()
            .expect("request worker initialized")
            .tx
            .try_send(request);
        match send_result {
            Ok(()) => {}
            Err(TrySendError::Full(request)) => {
                let _ = self.frame_tx.try_send(ServerFrame::Response {
                    id: request.id,
                    status: 503,
                    body: Some(serde_json::json!({
                        "error": "KSP request queue is full"
                    })),
                });
            }
            Err(TrySendError::Closed(request)) => {
                if let Some(worker) = self.requests.take() {
                    worker.task.abort();
                }
                let _ = self.frame_tx.try_send(ServerFrame::Response {
                    id: request.id,
                    status: 500,
                    body: Some(serde_json::json!({
                        "error": "KSP request worker is unavailable"
                    })),
                });
            }
        }
    }

    async fn enqueue_companion_event(
        &mut self,
        task_id: String,
        session_id: String,
        revision: String,
        attachment_epoch: Option<u64>,
        mut event: CompanionEvent,
    ) {
        let event_id = event.event_id.clone();
        if event.session_id.is_empty() && event.revision.is_empty() {
            event.session_id = session_id.clone();
            event.revision = revision.clone();
        }
        if event.session_id != session_id || event.revision != revision {
            self.send(ServerFrame::CompanionEventResult {
                task_id,
                session_id: Some(session_id),
                revision: Some(revision),
                event_id,
                accepted: false,
                code: Some("stale_revision".into()),
                message: Some("Refresh the visual companion and try again.".into()),
                attachment_epoch,
            })
            .await;
            return;
        }

        if self.companion_events.is_none() {
            let (tx, request_rx) = mpsc::channel(COMPANION_EVENT_QUEUE_CAPACITY);
            let task = tokio::spawn(run_companion_event_worker(
                self.state.config().db_path.clone(),
                self.frame_tx.clone(),
                request_rx,
            ));
            self.companion_events = Some(CompanionEventWorker { tx, task });
        }
        let request = CompanionEventRequest {
            task_id,
            session_id,
            revision,
            attachment_epoch,
            event,
        };
        let send_result = self
            .companion_events
            .as_ref()
            .expect("companion event worker initialized")
            .tx
            .try_send(request);
        match send_result {
            Ok(()) => {}
            Err(TrySendError::Full(request)) => {
                self.send(ServerFrame::CompanionEventResult {
                    task_id: request.task_id,
                    session_id: Some(request.session_id),
                    revision: Some(request.revision),
                    event_id,
                    accepted: false,
                    code: Some("companion_event_busy".into()),
                    message: Some("Visual companion selections are still being recorded.".into()),
                    attachment_epoch: request.attachment_epoch,
                })
                .await;
            }
            Err(TrySendError::Closed(request)) => {
                if let Some(worker) = self.companion_events.take() {
                    worker.task.abort();
                }
                self.send(ServerFrame::CompanionEventResult {
                    task_id: request.task_id,
                    session_id: Some(request.session_id),
                    revision: Some(request.revision),
                    event_id,
                    accepted: false,
                    code: Some("companion_event_failed".into()),
                    message: Some("The visual companion selection could not be recorded.".into()),
                    attachment_epoch: request.attachment_epoch,
                })
                .await;
            }
        }
    }

    /// Returns false when the connection should close.
    async fn handle(&mut self, frame: ClientFrame) -> bool {
        if !self.authed {
            return match frame {
                ClientFrame::Auth {
                    credential,
                    capabilities,
                } => self.handle_auth(credential, capabilities).await,
                _ => {
                    self.error(None, "unauthenticated", "first frame must be auth".into())
                        .await;
                    false
                }
            };
        }

        if self.auth_mode == AuthMode::LegacyReadOnlyOrPaired
            && !matches!(
                &frame,
                ClientFrame::Auth { .. } | ClientFrame::Attach { .. } | ClientFrame::Detach { .. }
            )
        {
            let task_id = match &frame {
                ClientFrame::AgentInput { task_id, .. }
                | ClientFrame::AgentPermission { task_id, .. }
                | ClientFrame::AgentInterrupt { task_id }
                | ClientFrame::AgentSetModel { task_id, .. }
                | ClientFrame::TermInput { task_id, .. }
                | ClientFrame::TermResize { task_id, .. }
                | ClientFrame::CompanionEvent { task_id, .. } => Some(task_id.clone()),
                ClientFrame::Request { .. }
                | ClientFrame::Auth { .. }
                | ClientFrame::Attach { .. }
                | ClientFrame::Detach { .. } => None,
            };
            self.error(
                task_id,
                "unauthorized",
                "legacy empty-auth stream is read-only; update or re-pair Kanna Mobile".into(),
            )
            .await;
            return true;
        }

        match frame {
            ClientFrame::Auth { .. } => {
                self.send(auth_ok_frame_for(self.companion_access)).await;
            }
            ClientFrame::Attach {
                task_id,
                kind,
                from_seq,
                include_assets,
                accept_snapshot_chunks,
                attachment_epoch,
            } => {
                if kind == StreamKind::Companion && !self.companion_access {
                    self.error(
                        None,
                        "unauthorized",
                        "paired-device authentication is required for visual companion access"
                            .into(),
                    )
                    .await;
                    return true;
                }
                if kind == StreamKind::Companion
                    && !self.supports_companion_event_epoch
                    && (self.legacy_companion_tasks_on_connection.contains(&task_id)
                        || self.legacy_companion_tasks_on_connection.len()
                            >= MAX_LEGACY_COMPANION_TASKS_PER_CONNECTION)
                {
                    self.error(
                        Some(task_id),
                        "companion_attach_rejected",
                        "this connection has exhausted its companion attachments; \
                         reconnect or update Kanna Mobile"
                            .into(),
                    )
                    .await;
                    return false;
                }
                let legacy_companion_task_id = (kind == StreamKind::Companion
                    && !self.supports_companion_event_epoch)
                    .then(|| task_id.clone());
                self.attach(
                    task_id,
                    kind,
                    from_seq,
                    // Assets are opt-in: a client that does not name the field
                    // is a pre-asset client that can neither chunk nor read
                    // them, and an unchunked assetful snapshot can be tens of
                    // megabytes in one text frame.
                    include_assets.unwrap_or(false),
                    accept_snapshot_chunks.unwrap_or(false),
                    attachment_epoch,
                )
                .await;
                if let Some(task_id) = legacy_companion_task_id {
                    if self
                        .attachments
                        .contains_key(&(task_id.clone(), StreamKind::Companion))
                    {
                        self.legacy_companion_tasks_on_connection
                            .insert(task_id.clone());
                        if self.legacy_companion_tasks_on_connection.len()
                            >= MAX_LEGACY_COMPANION_TASKS_PER_CONNECTION
                        {
                            self.error(
                                Some(task_id),
                                "companion_attach_rejected",
                                "this connection has exhausted its companion attachments; \
                                 reconnect or update Kanna Mobile"
                                    .into(),
                            )
                            .await;
                            return false;
                        }
                    }
                }
            }
            ClientFrame::Detach {
                task_id,
                kind,
                attachment_epoch,
            } => {
                let key = (task_id.clone(), kind);
                let detach_is_current = kind != StreamKind::Companion
                    || attachment_epoch.is_none()
                    || self
                        .attachments
                        .get(&key)
                        .is_some_and(|current| current.attachment_epoch == attachment_epoch);
                if !detach_is_current {
                    return true;
                }
                if let Some(attachment) = self.attachments.remove(&key) {
                    attachment.task.abort();
                    let _ = attachment.task.await;
                }
                if kind == StreamKind::Terminal {
                    if let Some(control) = self.terminal_controls.remove(&task_id) {
                        Self::retire_terminal_control(control).await;
                    }
                    if let Some(input) = self.terminal_inputs.remove(&task_id) {
                        self.retire_terminal_input(&task_id, input).await;
                    }
                }
                if kind == StreamKind::Companion {
                    self.companion_tx.invalidate(&task_id);
                    // A detached legacy companion no longer holds one of this
                    // connection's bounded legacy slots, so the client's next
                    // modal-open re-attach must succeed instead of ending the
                    // whole multiplexed socket.
                    self.legacy_companion_tasks_on_connection.remove(&task_id);
                }
            }
            ClientFrame::AgentInput { task_id, text } => {
                self.enqueue_agent_command(task_id, AgentControlCommand::Input(text));
            }
            ClientFrame::AgentPermission {
                task_id,
                request_id,
                decision,
            } => {
                self.enqueue_agent_command(
                    task_id,
                    AgentControlCommand::Permission {
                        request_id,
                        decision,
                    },
                );
            }
            ClientFrame::AgentInterrupt { task_id } => {
                self.enqueue_agent_command(task_id, AgentControlCommand::Interrupt);
            }
            ClientFrame::AgentSetModel { task_id, model } => {
                self.enqueue_agent_command(task_id, AgentControlCommand::SetModel(model));
            }
            ClientFrame::TermInput { task_id, data_b64 } => {
                let data = match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
                    Ok(data) => data,
                    Err(error) => {
                        self.error(Some(task_id), "bad_frame", format!("bad base64: {error}"))
                            .await;
                        return true;
                    }
                };
                self.enqueue_terminal_input(task_id, data);
            }
            ClientFrame::TermResize {
                task_id,
                cols,
                rows,
            } => self
                .enqueue_terminal_control(task_id, TerminalControlCommand::Resize { cols, rows }),
            ClientFrame::CompanionEvent {
                task_id,
                session_id,
                revision,
                attachment_epoch,
                event,
            } => {
                if !self.companion_access {
                    self.error(
                        None,
                        "unauthorized",
                        "paired-device authentication is required for visual companion access"
                            .into(),
                    )
                    .await;
                    return true;
                }
                let current_attachment = self
                    .attachments
                    .get(&(task_id.clone(), StreamKind::Companion));
                let event_matches_attachment = current_attachment.is_some_and(|current| {
                    attachment_epoch.map_or(current.accepts_legacy_companion_events, |epoch| {
                        current.attachment_epoch == Some(epoch)
                    })
                });
                if !event_matches_attachment {
                    self.send(ServerFrame::CompanionEventResult {
                        task_id,
                        session_id: Some(session_id),
                        revision: Some(revision),
                        event_id: event.event_id,
                        accepted: false,
                        code: Some("companion_stale_attachment".into()),
                        message: Some(
                            "Reopen or refresh the visual companion and try again.".into(),
                        ),
                        attachment_epoch,
                    })
                    .await;
                    return true;
                }
                self.enqueue_companion_event(
                    task_id,
                    session_id,
                    revision,
                    attachment_epoch,
                    event,
                )
                .await;
            }
            ClientFrame::Request {
                id,
                method,
                path,
                body,
            } => {
                self.enqueue_request(KspRequest {
                    id,
                    method,
                    path,
                    body,
                });
            }
        }
        true
    }

    async fn handle_auth(
        &mut self,
        credential: Option<String>,
        capabilities: Vec<KspCapability>,
    ) -> bool {
        let valid = match self.auth_mode {
            AuthMode::AllowEmpty | AuthMode::AlreadyAuthenticated => true,
            AuthMode::LegacyReadOnlyOrPaired => match credential.as_deref() {
                Some(value) => self.paired_device_credential_matches(value),
                None => true,
            },
            AuthMode::RequirePairedDevice => match credential.as_deref() {
                Some(value) => self.paired_device_credential_matches(value),
                None => false,
            },
            AuthMode::RequireCredential => match credential.as_deref() {
                Some(value) => self.credential_matches(value).await,
                None => false,
            },
        };

        if !valid {
            self.error(None, "unauthorized", "invalid stream credential".into())
                .await;
            return false;
        }

        self.authed = true;
        if self.auth_mode == AuthMode::LegacyReadOnlyOrPaired && credential.is_some() {
            self.auth_mode = AuthMode::AlreadyAuthenticated;
        }
        // An in-band paired-device credential proves the same pairing-store
        // secret as the upgrade-time device headers or stream cookie, so it
        // carries the same companion authority.
        if credential.is_some()
            && matches!(
                self.auth_mode,
                AuthMode::AlreadyAuthenticated | AuthMode::RequirePairedDevice
            )
        {
            self.companion_access = true;
        }
        self.supports_companion_event_epoch =
            capabilities.contains(&KspCapability::CompanionEventEpoch);
        self.send(auth_ok_frame_for(self.companion_access)).await;
        true
    }

    fn paired_device_credential_matches(&self, credential: &str) -> bool {
        let Ok(credential) = serde_json::from_str::<PairedDeviceCredential>(credential) else {
            return false;
        };
        let config = self.state.config();
        crate::pairing::PairingStore::load(Path::new(&config.pairing_store_path)).is_ok_and(
            |store| {
                store.verify_device_secret(
                    &config.desktop_id,
                    &credential.device_id,
                    &credential.device_secret,
                )
            },
        )
    }

    async fn credential_matches(&self, credential: &str) -> bool {
        // A non-empty credential is a precondition, not a pass: the secret
        // comparison is the actual gate. Compared in constant time so a
        // remote (tunnel) caller cannot use response timing as an oracle.
        if credential.is_empty() {
            return false;
        }
        let config = self.state.config();
        let secret_ok = config
            .desktop_secret
            .as_deref()
            .is_some_and(|secret| constant_time_eq(secret.as_bytes(), credential.as_bytes()));
        let token_ok = !config.device_token.is_empty()
            && constant_time_eq(config.device_token.as_bytes(), credential.as_bytes());
        if secret_ok || token_ok {
            return true;
        }

        match verify_firebase_id_token(config, credential).await {
            Ok(valid) => valid,
            Err(error) => {
                log::warn!("failed to verify KSP Firebase credential: {error}");
                false
            }
        }
    }

    async fn attach(
        &mut self,
        task_id: String,
        kind: StreamKind,
        from_seq: u64,
        include_assets: bool,
        accept_snapshot_chunks: bool,
        attachment_epoch: Option<u64>,
    ) {
        // Replace any existing attachment for this (task, kind).
        if let Some(existing) = self.attachments.remove(&(task_id.clone(), kind)) {
            existing.task.abort();
            let _ = existing.task.await;
        }
        if kind == StreamKind::Companion {
            let Some(attachment_slot) = self.state.companion_resources.try_attachment() else {
                self.send(ServerFrame::CompanionError {
                    task_id,
                    code: "companion_resource_limit".into(),
                    message: "Too many visual companion attachments are active.".into(),
                    attachment_epoch,
                })
                .await;
                return;
            };
            let key = (task_id.clone(), kind);
            let companion_tx = self.companion_tx.attachment_with_epoch(
                task_id.clone(),
                include_assets,
                accept_snapshot_chunks,
                attachment_epoch,
            );
            // A peer that did not explicitly negotiate event epochs may send
            // epoch-less events only in its single lifecycle on this
            // connection. Admission forces a reconnect before another.
            let accepts_legacy_companion_events = !self.supports_companion_event_epoch;
            let subscription = self.state.companion_resources.subscribe(
                self.state.config().db_path.clone(),
                task_id.clone(),
                include_assets,
            );
            let task = tokio::spawn(stream_companion(
                companion_tx,
                subscription,
                attachment_slot,
            ));
            self.attachments.insert(
                key,
                StreamAttachment {
                    task,
                    attachment_epoch,
                    accepts_legacy_companion_events,
                },
            );
            return;
        }

        let session_id = match (kind, direct_terminal_session_id(&task_id)) {
            (StreamKind::Terminal, Some(session_id)) => Ok(session_id),
            _ => {
                resolve_task_session_id(self.state.config().db_path.clone(), task_id.clone()).await
            }
        };
        let session_id = match session_id {
            Ok(session_id) => session_id,
            Err(message) => {
                self.error(Some(task_id), "no_session", message).await;
                return;
            }
        };

        if kind == StreamKind::Terminal {
            self.replace_terminal_control_route(&task_id, session_id.clone())
                .await;
            self.replace_terminal_input_route(&task_id, session_id.clone())
                .await;
        }

        // Replace any existing attachment for this (task, kind).
        if let Some(existing) = self.attachments.remove(&(task_id.clone(), kind)) {
            existing.task.abort();
            let _ = existing.task.await;
        }

        let frame_tx = self.frame_tx.clone();
        let daemon_dir = self.state.config().daemon_dir.clone();
        let key = (task_id.clone(), kind);
        let task = match kind {
            StreamKind::Agent => tokio::spawn(stream_agent(
                daemon_dir, task_id, session_id, from_seq, frame_tx,
            )),
            StreamKind::Terminal => {
                let lease = self.state.terminal_attachments().attach(session_id.clone());
                let state = Arc::clone(&self.state);
                tokio::spawn(async move {
                    let _lease = lease;
                    stream_terminal(state, daemon_dir, task_id, session_id, frame_tx).await;
                })
            }
            StreamKind::Companion => unreachable!("companion attach handled above"),
        };
        self.attachments.insert(
            key,
            StreamAttachment {
                task,
                attachment_epoch: None,
                accepts_legacy_companion_events: false,
            },
        );
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PublishedCompanionState {
    Never,
    Unavailable,
    Snapshot {
        session_id: String,
        revision: String,
        source_origin: Option<String>,
        include_assets: bool,
    },
    SourceError,
}

fn companion_source_error(
    error: &kanna_visual_companion::CompanionError,
) -> (&'static str, &'static str) {
    use kanna_visual_companion::CompanionError;

    match error {
        CompanionError::TooLarge => (
            "companion_too_large",
            "The visual companion is too large. Ask the agent to simplify the screen.",
        ),
        CompanionError::UnsupportedContent => (
            "companion_invalid_document",
            "The visual companion is not valid UTF-8 HTML. Ask the agent to recreate the screen.",
        ),
        CompanionError::TaskNotFound
        | CompanionError::WorkspaceUnavailable
        | CompanionError::StaleRevision
        | CompanionError::InvalidEvent
        | CompanionError::Internal(_) => (
            "companion_source_failed",
            "The visual companion could not be read.",
        ),
    }
}

async fn stream_companion(
    companion_tx: CompanionAttachmentSender,
    mut subscription: CompanionScanSubscription,
    _attachment_slot: OwnedSemaphorePermit,
) {
    let requested_assets = subscription.requested_assets;
    if subscription.frames.borrow().is_some() {
        subscription.frames.mark_changed();
    }
    loop {
        if subscription.frames.changed().await.is_err() {
            return;
        }
        let frame = subscription.frames.borrow_and_update().clone();
        if let Some(frame) = frame {
            if !frame.is_compatible_with(requested_assets) {
                continue;
            }
            if !companion_tx.publish_shared(&frame.frame) {
                return;
            }
        }
    }
}

fn spawn_companion_scan_source(
    db_path: String,
    task_id: String,
    frames: watch::Sender<Option<Arc<RetainedCompanionFrame>>>,
    mut cancel: watch::Receiver<bool>,
    mut asset_demand: watch::Receiver<usize>,
    materialization_budget: Arc<kanna_visual_companion::CompanionMaterializationBudget>,
    retained_bytes: Arc<AtomicUsize>,
    retained_available: Arc<Notify>,
) {
    tokio::spawn(async move {
        let mut published = PublishedCompanionState::Never;
        let scan_budget = Arc::clone(&materialization_budget);
        let mut scanner = crate::visual_companion::CompanionScanner::with_materialization_budget(
            materialization_budget,
        );
        loop {
            let include_assets = *asset_demand.borrow_and_update() > 0;
            let scan_db_path = db_path.clone();
            let scan_task_id = task_id.clone();
            let scan_result = tokio::task::spawn_blocking(move || {
                let result = scanner.scan_with_assets(&scan_db_path, &scan_task_id, include_assets);
                (scanner, result)
            })
            .await;
            let result = match scan_result {
                Ok((returned_scanner, result)) => {
                    scanner = returned_scanner;
                    result
                }
                Err(_) => {
                    scanner =
                        crate::visual_companion::CompanionScanner::with_materialization_budget(
                            Arc::clone(&scan_budget),
                        );
                    Err(kanna_visual_companion::CompanionError::Internal(
                        "visual companion scan worker failed".into(),
                    ))
                }
            };
            let mode_changed = {
                let current_demand = asset_demand.borrow_and_update();
                (*current_demand > 0) != include_assets
            };
            if mode_changed {
                scanner.invalidate();
                continue;
            }
            #[cfg(test)]
            if matches!(
                result,
                Ok(kanna_visual_companion::CompanionScan::Changed(_))
            ) {
                record_changed_companion_scan(&db_path, &task_id);
            }
            if matches!(result, Ok(kanna_visual_companion::CompanionScan::Unchanged)) {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                    changed = asset_demand.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                    changed = cancel.changed() => {
                        if changed.is_err() || *cancel.borrow() {
                            return;
                        }
                    }
                }
                continue;
            }
            let mut admission_wakeup = None;
            let admission_failed = {
                let current_demand = asset_demand.borrow_and_update();
                if (*current_demand > 0) != include_assets {
                    None
                } else {
                    let (next_state, frame) =
                        companion_frame_for_scan(&task_id, result, include_assets);
                    if next_state != published {
                        let snapshot_includes_assets = match &next_state {
                            PublishedCompanionState::Snapshot { include_assets, .. } => {
                                Some(*include_assets)
                            }
                            _ => None,
                        };
                        drop(frames.send_replace(None));
                        let mut wakeup = Box::pin(retained_available.notified());
                        wakeup.as_mut().enable();
                        if let Some(frame) = RetainedCompanionFrame::try_new_with_wakeup(
                            frame,
                            snapshot_includes_assets,
                            &retained_bytes,
                            Some(Arc::clone(&retained_available)),
                        ) {
                            frames.send_replace(Some(frame));
                            published = next_state;
                            Some(false)
                        } else {
                            let error = ServerFrame::CompanionError {
                                task_id: task_id.clone(),
                                code: "companion_resource_limit".into(),
                                message:
                                    "Visual companion relay resources are busy. Reopen the companion."
                                        .into(),
                                attachment_epoch: None,
                            };
                            if let Some(error) = RetainedCompanionFrame::try_new_with_wakeup(
                                error,
                                None,
                                &retained_bytes,
                                Some(Arc::clone(&retained_available)),
                            ) {
                                frames.send_replace(Some(error));
                            }
                            published = PublishedCompanionState::Never;
                            admission_wakeup = Some(wakeup);
                            Some(true)
                        }
                    } else {
                        Some(false)
                    }
                }
            };
            let Some(admission_failed) = admission_failed else {
                scanner.invalidate();
                continue;
            };
            if admission_failed {
                let mut admission_wakeup =
                    admission_wakeup.expect("failed admission registers a capacity waiter");
                tokio::select! {
                    _ = admission_wakeup.as_mut() => {
                        scanner.invalidate();
                    }
                    changed = asset_demand.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        scanner.invalidate();
                        #[cfg(test)]
                        wait_for_companion_admission_demand_test_gate(&db_path, &task_id).await;
                    }
                    changed = cancel.changed() => {
                        if changed.is_err() || *cancel.borrow() {
                            return;
                        }
                    }
                }
                continue;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                changed = asset_demand.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        return;
                    }
                }
            }
        }
    });
}

fn companion_frame_for_scan(
    task_id: &str,
    result: Result<kanna_visual_companion::CompanionScan, kanna_visual_companion::CompanionError>,
    include_assets: bool,
) -> (PublishedCompanionState, ServerFrame) {
    match result {
        Ok(kanna_visual_companion::CompanionScan::Unchanged) => {
            unreachable!("unchanged companion scans are filtered before frame construction")
        }
        Ok(kanna_visual_companion::CompanionScan::Changed(Some(document))) => {
            let kanna_visual_companion::CompanionBundle {
                session_id,
                revision,
                document_kind,
                html,
                source_origin,
                assets,
            } = document;
            (
                PublishedCompanionState::Snapshot {
                    session_id: session_id.clone(),
                    revision: revision.clone(),
                    source_origin: source_origin.clone(),
                    include_assets,
                },
                ServerFrame::CompanionSnapshot {
                    task_id: task_id.into(),
                    session_id,
                    revision,
                    document_kind,
                    html,
                    source_origin,
                    assets,
                    attachment_epoch: None,
                },
            )
        }
        Ok(kanna_visual_companion::CompanionScan::Changed(None)) => (
            PublishedCompanionState::Unavailable,
            ServerFrame::CompanionUnavailable {
                task_id: task_id.into(),
                attachment_epoch: None,
            },
        ),
        Err(error) => {
            let (code, message) = companion_source_error(&error);
            (
                PublishedCompanionState::SourceError,
                ServerFrame::CompanionError {
                    task_id: task_id.into(),
                    code: code.into(),
                    message: message.into(),
                    attachment_epoch: None,
                },
            )
        }
    }
}

/// Reconnect backoff for a daemon connection lost mid-stream (daemon
/// restart/handoff). The last entry repeats, mirroring the desktop event
/// bridge's reconnect policy: sessions survive daemon restarts, so the
/// attachment stays alive and transparently re-attaches rather than leaving
/// the client silently frozen on a dead stream.
const DAEMON_STREAM_RETRY_DELAYS_MS: [u64; 5] = [250, 500, 1000, 2000, 5000];

async fn daemon_stream_retry_delay(attempt: usize) {
    let delay = DAEMON_STREAM_RETRY_DELAYS_MS[attempt.min(DAEMON_STREAM_RETRY_DELAYS_MS.len() - 1)];
    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
}

/// How a single attach-and-forward run over one daemon connection ended.
enum StreamRunEnd {
    /// The stream is definitively over (client gone, session exited, or a
    /// fatal daemon reply was forwarded to the client). Stop the attachment.
    Done,
    /// The daemon connection dropped mid-stream (restart/handoff/crash).
    /// The session may still be alive in the replacement daemon; re-attach.
    DaemonLost,
}

/// Per-attachment forwarding task: its own daemon connection attaches to the
/// agent session, relays the snapshot, then streams live events. If the
/// daemon connection is lost after a successful attach, re-attaches with
/// backoff from the last forwarded seq so clients resume seamlessly.
async fn stream_agent(
    daemon_dir: String,
    task_id: String,
    session_id: String,
    from_seq: u64,
    frame_tx: mpsc::Sender<ServerFrame>,
) {
    let mut next_from_seq = from_seq;
    let mut attached_once = false;
    let mut retry_attempt = 0usize;
    loop {
        match stream_agent_once(
            &daemon_dir,
            &task_id,
            &session_id,
            &mut next_from_seq,
            &mut attached_once,
            &frame_tx,
        )
        .await
        {
            StreamRunEnd::Done => return,
            StreamRunEnd::DaemonLost => {
                log::warn!(
                    "[ksp] agent stream lost daemon connection (session={session_id}, attempt={retry_attempt}); re-attaching"
                );
                daemon_stream_retry_delay(retry_attempt).await;
                retry_attempt += 1;
            }
        }
    }
}

async fn stream_agent_once(
    daemon_dir: &str,
    task_id: &str,
    session_id: &str,
    next_from_seq: &mut u64,
    attached_once: &mut bool,
    frame_tx: &mpsc::Sender<ServerFrame>,
) -> StreamRunEnd {
    let send_error = |message: String| {
        let frame_tx = frame_tx.clone();
        let task_id = task_id.to_string();
        async move {
            let code = if message.contains("session not found") {
                "session_not_found"
            } else {
                "daemon"
            };
            let _ = frame_tx
                .send(ServerFrame::Error {
                    task_id: Some(task_id),
                    code: code.to_string(),
                    message,
                })
                .await;
        }
    };
    // Before the first successful attach, transport failures are surfaced to
    // the client (it has never seen this stream, so an error beats silence).
    // After that, they mean the daemon went away mid-stream: re-attach.
    let transport_failure = |attached_once: bool| {
        if attached_once {
            StreamRunEnd::DaemonLost
        } else {
            StreamRunEnd::Done
        }
    };

    let connected = DaemonClient::connect(daemon_dir)
        .await
        .map_err(|error| error.to_string());
    let mut client = match connected {
        Ok(client) => client,
        Err(error) => {
            if !*attached_once {
                send_error(format!("daemon error: {error}")).await;
            }
            return transport_failure(*attached_once);
        }
    };

    let reply = client
        .send_command(&DaemonCommand::AttachAgent {
            session_id: session_id.to_string(),
            from_seq: *next_from_seq,
        })
        .await
        .map_err(|error| error.to_string());
    match reply {
        Ok(DaemonEvent::AgentSnapshot {
            next_seq, events, ..
        }) => {
            let events = events
                .into_iter()
                .map(|entry| FrameAgentEvent {
                    seq: entry.seq,
                    event: entry.event,
                })
                .collect();
            *next_from_seq = next_seq;
            *attached_once = true;
            if frame_tx
                .send(ServerFrame::AgentSnapshot {
                    task_id: task_id.to_string(),
                    next_seq,
                    events,
                })
                .await
                .is_err()
            {
                return StreamRunEnd::Done;
            }
        }
        Ok(DaemonEvent::Error { message, .. }) => {
            send_error(message).await;
            return StreamRunEnd::Done;
        }
        Ok(other) => {
            send_error(format!("unexpected attach reply: {other:?}")).await;
            return StreamRunEnd::Done;
        }
        Err(error) => {
            if !*attached_once {
                send_error(format!("daemon error: {error}")).await;
            }
            return transport_failure(*attached_once);
        }
    }

    loop {
        match client.read_event().await.map_err(|error| error.to_string()) {
            Ok(DaemonEvent::AgentEvent {
                session_id: event_session,
                seq,
                event,
            }) if event_session == session_id => {
                *next_from_seq = seq + 1;
                if frame_tx
                    .send(ServerFrame::AgentEvent {
                        task_id: task_id.to_string(),
                        seq,
                        event,
                    })
                    .await
                    .is_err()
                {
                    return StreamRunEnd::Done;
                }
            }
            Ok(DaemonEvent::StatusChanged {
                session_id: event_session,
                status,
                ..
            }) if event_session == session_id => {
                if frame_tx
                    .send(ServerFrame::StatusChanged {
                        task_id: task_id.to_string(),
                        status: status_str(status).to_string(),
                    })
                    .await
                    .is_err()
                {
                    return StreamRunEnd::Done;
                }
            }
            Ok(DaemonEvent::Exit {
                session_id: event_session,
                code,
                ..
            }) if event_session == session_id => {
                if frame_tx
                    .send(ServerFrame::SessionExit {
                        task_id: task_id.to_string(),
                        code,
                    })
                    .await
                    .is_err()
                {
                    return StreamRunEnd::Done;
                }
                // The session may resume (provider respawn); keep streaming.
            }
            Ok(DaemonEvent::ShuttingDown) | Err(_) => {
                return StreamRunEnd::DaemonLost;
            }
            Ok(_) => {}
        }
    }
}

/// Terminal stream: daemon AttachSnapshot returns the authoritative headless
/// terminal snapshot first, then the same connection receives live Output.
/// If the daemon connection is lost after a successful attach (daemon
/// restart/handoff), re-attaches with backoff; the fresh snapshot resyncs the
/// client instead of leaving it frozen on a dead stream.
async fn stream_terminal(
    state: Arc<AppState>,
    daemon_dir: String,
    task_id: String,
    session_id: String,
    frame_tx: mpsc::Sender<ServerFrame>,
) {
    let mut attached_once = false;
    let mut retry_attempt = 0usize;
    loop {
        match stream_terminal_once(
            &state,
            &daemon_dir,
            &task_id,
            &session_id,
            &mut attached_once,
            &frame_tx,
        )
        .await
        {
            StreamRunEnd::Done => return,
            StreamRunEnd::DaemonLost => {
                log::warn!(
                    "[ksp] terminal stream lost daemon connection (session={session_id}, attempt={retry_attempt}); re-attaching"
                );
                daemon_stream_retry_delay(retry_attempt).await;
                retry_attempt += 1;
            }
        }
    }
}

async fn stream_terminal_once(
    state: &AppState,
    daemon_dir: &str,
    task_id: &str,
    session_id: &str,
    attached_once: &mut bool,
    frame_tx: &mpsc::Sender<ServerFrame>,
) -> StreamRunEnd {
    let send_error = |code: &'static str, message: String| {
        let frame_tx = frame_tx.clone();
        let task_id = task_id.to_string();
        async move {
            let _ = frame_tx
                .send(ServerFrame::Error {
                    task_id: Some(task_id),
                    code: code.to_string(),
                    message,
                })
                .await;
        }
    };
    // Before the first successful attach, transport failures are surfaced to
    // the client (it has never seen this stream, so an error beats silence).
    // After that, they mean the daemon went away mid-stream: re-attach.
    let transport_failure = |attached_once: bool| {
        if attached_once {
            StreamRunEnd::DaemonLost
        } else {
            StreamRunEnd::Done
        }
    };

    let connected = DaemonClient::connect(daemon_dir)
        .await
        .map_err(|error| error.to_string());
    let mut client = match connected {
        Ok(client) => client,
        Err(error) => {
            if !*attached_once {
                send_error("daemon", format!("daemon error: {error}")).await;
            }
            return transport_failure(*attached_once);
        }
    };
    let attach_reply = client
        .send_command(&DaemonCommand::AttachSnapshot {
            session_id: session_id.to_string(),
            emulate_terminal: true,
        })
        .await
        .map_err(|error| error.to_string());
    match attach_reply {
        Ok(DaemonEvent::Snapshot {
            snapshot,
            agent_provider,
            ..
        }) => {
            *attached_once = true;
            let frame = ServerFrame::TermSnapshot {
                task_id: task_id.to_string(),
                cols: snapshot.cols,
                rows: snapshot.rows,
                data_b64: b64(snapshot.vt.as_bytes()),
                agent_provider,
            };
            if send_terminal_frame(
                frame_tx.clone(),
                frame,
                session_id.to_string(),
                terminal_perf::global_monitor().clone(),
            )
            .await
            .is_err()
            {
                return StreamRunEnd::Done;
            }
        }
        Ok(DaemonEvent::Error { code, message }) => {
            let code = match code {
                Some(kanna_daemon::protocol::ErrorCode::HandoffLost) => {
                    let reason = format!(
                        "session lost during daemon handoff; use kanna_resume_task to recover: \
                         {message}"
                    );
                    match crate::http_api::mark_task_session_interrupted(
                        &state.config().db_path,
                        task_id,
                        "failed",
                        &reason,
                    ) {
                        Ok(Some(_)) => {
                            state.publish_state_changed(
                                kanna_agent_protocol::StateChangeScope::Tasks,
                            );
                        }
                        Ok(None) => {}
                        Err(error) => {
                            log::warn!(
                                "[ksp] failed to record handoff-lost task {task_id}: {error}"
                            );
                        }
                    }
                    "handoff_lost"
                }
                Some(kanna_daemon::protocol::ErrorCode::SessionNotFound) => "session_not_found",
                _ if message.contains("session not found") => "session_not_found",
                _ => "daemon",
            };
            send_error(code, message).await;
            return StreamRunEnd::Done;
        }
        Ok(other) => {
            send_error("daemon", format!("unexpected attach reply: {other:?}")).await;
            return StreamRunEnd::Done;
        }
        Err(error) => {
            if !*attached_once {
                send_error("daemon", format!("daemon error: {error}")).await;
            }
            return transport_failure(*attached_once);
        }
    }

    loop {
        match client.read_event().await.map_err(|error| error.to_string()) {
            Ok(DaemonEvent::Output {
                session_id: event_session,
                data,
            }) if event_session == session_id => {
                if send_terminal_frame(
                    frame_tx.clone(),
                    ServerFrame::TermOutput {
                        task_id: task_id.to_string(),
                        data_b64: b64(&data),
                    },
                    session_id.to_string(),
                    terminal_perf::global_monitor().clone(),
                )
                .await
                .is_err()
                {
                    return StreamRunEnd::Done;
                }
            }
            // A mid-stream snapshot is the daemon resynchronizing this
            // subscriber after it lagged behind live output; forward it so
            // the client rehydrates exactly like on reattach.
            Ok(DaemonEvent::Snapshot {
                session_id: event_session,
                snapshot,
                agent_provider,
            }) if event_session == session_id => {
                let frame = ServerFrame::TermSnapshot {
                    task_id: task_id.to_string(),
                    cols: snapshot.cols,
                    rows: snapshot.rows,
                    data_b64: b64(snapshot.vt.as_bytes()),
                    agent_provider,
                };
                if send_terminal_frame(
                    frame_tx.clone(),
                    frame,
                    session_id.to_string(),
                    terminal_perf::global_monitor().clone(),
                )
                .await
                .is_err()
                {
                    return StreamRunEnd::Done;
                }
            }
            Ok(DaemonEvent::StatusChanged {
                session_id: event_session,
                status,
                ..
            }) if event_session == session_id => {
                if frame_tx
                    .send(ServerFrame::StatusChanged {
                        task_id: task_id.to_string(),
                        status: status_str(status).to_string(),
                    })
                    .await
                    .is_err()
                {
                    return StreamRunEnd::Done;
                }
            }
            Ok(DaemonEvent::Exit {
                session_id: event_session,
                code,
                ..
            }) if event_session == session_id => {
                let _ = frame_tx
                    .send(ServerFrame::SessionExit {
                        task_id: task_id.to_string(),
                        code,
                    })
                    .await;
                return StreamRunEnd::Done;
            }
            Ok(DaemonEvent::ShuttingDown) | Err(_) => return StreamRunEnd::DaemonLost,
            Ok(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanna_agent_protocol::{CompanionAsset, CompanionDocumentKind, CompanionEvent};
    use kanna_daemon::terminal_perf::{format_event, TerminalPerfMonitor};
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::HeaderValue;
    use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

    const TEST_DEVICE_ID: &str = "ksp-test-device";
    const TEST_DEVICE_SECRET: &str = "ksp-test-secret";

    fn test_config(desktop_id: &str, desktop_name: &str) -> crate::config::Config {
        crate::config::Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
            firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: crate::db::Db::test_db_path(desktop_id),
            kanna_cli_path: None,
            desktop_id: desktop_id.to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: desktop_name.to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            pairing_store_path: format!("/tmp/kanna-pairings-{desktop_id}.json"),
        }
    }

    async fn serve_test_router() -> String {
        let router = crate::http_api::test_router("ksp-test", "KSP Test");
        serve_router(router).await
    }

    async fn serve_router(router: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        format!("ws://{addr}/v1/stream")
    }

    fn perf_test_monitor() -> TerminalPerfMonitor {
        TerminalPerfMonitor::with_thresholds(Duration::from_millis(20), Duration::from_secs(1))
    }

    #[tokio::test]
    async fn full_terminal_frame_queue_reports_outbound_queue_stall() {
        let monitor = perf_test_monitor();
        let (frame_tx, mut frame_rx) = mpsc::channel(1);
        frame_tx.send(auth_ok_frame()).await.unwrap();
        let frame = ServerFrame::TermOutput {
            task_id: "task-queue".to_string(),
            data_b64: "VE9QX1NFQ1JFVF9QQVlMT0FE".to_string(),
        };

        let send = tokio::spawn(send_terminal_frame(
            frame_tx,
            frame,
            "session-queue".to_string(),
            monitor.clone(),
        ));
        tokio::time::sleep(Duration::from_millis(30)).await;

        let events = monitor.poll();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].context.stage, "outbound_queue");
        assert_eq!(events[0].context.task_id.as_deref(), Some("task-queue"));
        assert_eq!(events[0].context.queue_available, Some(0));
        assert_eq!(events[0].context.queue_capacity, Some(1));
        assert!(!format_event(&events[0], 0).contains("VE9QX1NFQ1JFVF9QQVlMT0FE"));

        let _ = frame_rx.recv().await;
        send.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn held_websocket_sink_reports_websocket_send_not_queue_stall() {
        let monitor = perf_test_monitor();
        let frame = ServerFrame::TermOutput {
            task_id: "task-socket".to_string(),
            data_b64: "cGF5bG9hZA==".to_string(),
        };
        let context =
            terminal_frame_context(&frame, Some("session-socket"), "websocket_send", None);

        let held = tokio::spawn(monitored_terminal_future(
            context,
            monitor.clone(),
            std::future::pending::<()>(),
        ));
        tokio::time::sleep(Duration::from_millis(30)).await;

        let events = monitor.poll();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].context.stage, "websocket_send");
        assert_ne!(events[0].context.stage, "outbound_queue");
        held.abort();
    }

    #[tokio::test]
    async fn fast_terminal_frame_emits_no_perf_record() {
        let monitor = perf_test_monitor();
        let (frame_tx, mut frame_rx) = mpsc::channel(1);
        let receive = tokio::spawn(async move { frame_rx.recv().await });

        send_terminal_frame(
            frame_tx,
            ServerFrame::TermOutput {
                task_id: "task-fast".to_string(),
                data_b64: "ZmFzdA==".to_string(),
            },
            "session-fast".to_string(),
            monitor.clone(),
        )
        .await
        .unwrap();
        receive.await.unwrap();

        assert!(monitor.poll().is_empty());
        assert_eq!(monitor.active_count(), 0);
    }

    fn daemon_socket_path_for_dir(daemon_dir: &str) -> PathBuf {
        kanna_runtime_defaults::socket_path(std::path::Path::new(daemon_dir))
    }

    async fn spawn_fake_daemon_once(daemon_dir: String) -> tokio::task::JoinHandle<DaemonCommand> {
        spawn_fake_daemon_once_with_response(daemon_dir, DaemonEvent::Ok).await
    }

    async fn spawn_fake_daemon_once_with_response(
        daemon_dir: String,
        response: DaemonEvent,
    ) -> tokio::task::JoinHandle<DaemonCommand> {
        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept daemon connection");
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("read daemon command");
            let command: DaemonCommand =
                serde_json::from_str(line.trim()).expect("parse daemon command");
            let response = serde_json::to_string(&response).expect("serialize daemon response");
            write_half
                .write_all(format!("{response}\n").as_bytes())
                .await
                .expect("write daemon response");
            command
        })
    }

    async fn spawn_fake_control_daemon(
        daemon_dir: String,
        command_count: usize,
    ) -> (
        tokio::task::JoinHandle<usize>,
        mpsc::Receiver<DaemonCommand>,
    ) {
        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind fake control daemon socket");
        let (command_tx, command_rx) = mpsc::channel(command_count);

        let task = tokio::spawn(async move {
            let accepted_connections = Arc::new(AtomicUsize::new(0));
            let received_commands = Arc::new(AtomicUsize::new(0));
            let completed = Arc::new(tokio::sync::Notify::new());
            let accepted_for_loop = Arc::clone(&accepted_connections);
            let received_for_loop = Arc::clone(&received_commands);
            let completed_for_loop = Arc::clone(&completed);
            let acceptor = tokio::spawn(async move {
                let mut handlers = tokio::task::JoinSet::new();
                loop {
                    let (stream, _) = listener
                        .accept()
                        .await
                        .expect("accept fake control daemon connection");
                    accepted_for_loop.fetch_add(1, Ordering::Relaxed);
                    let command_tx = command_tx.clone();
                    let received = Arc::clone(&received_for_loop);
                    let completed = Arc::clone(&completed_for_loop);
                    handlers.spawn(async move {
                        let (read_half, mut write_half) = stream.into_split();
                        let mut reader = BufReader::new(read_half);
                        loop {
                            let mut line = String::new();
                            let read = reader
                                .read_line(&mut line)
                                .await
                                .expect("read fake control daemon command");
                            if read == 0 {
                                return;
                            }
                            let command: DaemonCommand = serde_json::from_str(line.trim())
                                .expect("parse fake control daemon command");
                            if matches!(command, DaemonCommand::List) {
                                let sessions = [
                                    "shell-request-hol",
                                    "shell-companion-event-hol",
                                    "shell-request-saturation",
                                    "shell-agent-hol",
                                    "shell-at-most-once",
                                    "shell-no-ack",
                                    "merge-ksp-session",
                                ]
                                .into_iter()
                                .map(|session_id| kanna_daemon::protocol::SessionInfo {
                                    session_id: session_id.to_string(),
                                    pid: 4242,
                                    cwd: "/tmp".to_string(),
                                    state: kanna_daemon::protocol::SessionState::Active,
                                    idle_seconds: 0,
                                    status: SessionStatus::Idle,
                                    kind: kanna_daemon::protocol::SessionKind::Pty,
                                })
                                .collect();
                                write_half
                                    .write_all(
                                        format!(
                                            "{}\n",
                                            serde_json::to_string(&DaemonEvent::SessionList {
                                                sessions,
                                            })
                                            .unwrap()
                                        )
                                        .as_bytes(),
                                    )
                                    .await
                                    .expect("write fake session list");
                                continue;
                            }
                            let (published, expects_reply) = match command {
                                DaemonCommand::InputIfSession {
                                    session_id, data, ..
                                } => (DaemonCommand::InputNoReply { session_id, data }, true),
                                command => {
                                    let expects_reply = !matches!(
                                        &command,
                                        DaemonCommand::InputNoReply { .. }
                                            | DaemonCommand::ResizeNoReply { .. }
                                    );
                                    (command, expects_reply)
                                }
                            };
                            command_tx
                                .send(published)
                                .await
                                .expect("publish fake control daemon command");
                            if expects_reply {
                                write_half
                                    .write_all(
                                        format!(
                                            "{}\n",
                                            serde_json::to_string(&DaemonEvent::Ok).unwrap()
                                        )
                                        .as_bytes(),
                                    )
                                    .await
                                    .expect("write fake control daemon response");
                            }
                            if received.fetch_add(1, Ordering::Relaxed) + 1 == command_count {
                                completed.notify_waiters();
                            }
                        }
                    });
                }
            });
            while received_commands.load(Ordering::Relaxed) < command_count {
                completed.notified().await;
            }
            acceptor.abort();
            accepted_connections.load(Ordering::Relaxed)
        });

        (task, command_rx)
    }

    async fn spawn_fake_control_daemon_with_disconnect(
        daemon_dir: String,
        command_count: usize,
    ) -> (
        tokio::task::JoinHandle<usize>,
        mpsc::Receiver<DaemonCommand>,
    ) {
        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind reconnect daemon socket");
        let (command_tx, command_rx) = mpsc::channel(command_count);

        let task = tokio::spawn(async move {
            for accepted in 1..=command_count {
                let (stream, _) = listener
                    .accept()
                    .await
                    .expect("accept reconnect daemon connection");
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .await
                    .expect("read reconnect daemon command");
                let command: DaemonCommand =
                    serde_json::from_str(line.trim()).expect("parse reconnect daemon command");
                let expects_reply = !matches!(
                    &command,
                    DaemonCommand::InputNoReply { .. } | DaemonCommand::ResizeNoReply { .. }
                );
                command_tx
                    .send(command)
                    .await
                    .expect("publish reconnect daemon command");
                if expects_reply {
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                .as_bytes(),
                        )
                        .await
                        .expect("write reconnect daemon response");
                }
                if accepted == command_count {
                    return accepted;
                }
                // Drop both halves so the persistent KSP control worker must
                // reconnect before its next command.
            }
            command_count
        });

        (task, command_rx)
    }

    async fn spawn_fake_control_daemon_close_after_first_command(
        daemon_dir: String,
    ) -> (tokio::task::JoinHandle<()>, mpsc::Receiver<DaemonCommand>) {
        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind close-after-input daemon");
        let (command_tx, command_rx) = mpsc::channel(2);

        let task = tokio::spawn(async move {
            let (list_stream, _) = listener.accept().await.expect("accept list connection");
            let (list_read, mut list_write) = list_stream.into_split();
            let mut list_reader = BufReader::new(list_read);
            let mut line = String::new();
            list_reader.read_line(&mut line).await.expect("read list");
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::List
            ));
            let sessions = ["shell-at-most-once", "shell-no-ack"]
                .into_iter()
                .map(|session_id| kanna_daemon::protocol::SessionInfo {
                    session_id: session_id.to_string(),
                    pid: 4242,
                    cwd: "/tmp".to_string(),
                    state: kanna_daemon::protocol::SessionState::Active,
                    idle_seconds: 0,
                    status: SessionStatus::Idle,
                    kind: kanna_daemon::protocol::SessionKind::Pty,
                })
                .collect();
            list_write
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&DaemonEvent::SessionList { sessions }).unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .expect("write session list");

            let (input_stream, _) = listener.accept().await.expect("accept input connection");
            let mut reader = BufReader::new(input_stream);
            line.clear();
            reader
                .read_line(&mut line)
                .await
                .expect("read terminal input");
            let command =
                serde_json::from_str::<DaemonCommand>(line.trim()).expect("parse terminal input");
            let command = match command {
                DaemonCommand::InputIfSession {
                    session_id, data, ..
                } => DaemonCommand::InputNoReply { session_id, data },
                command => command,
            };
            command_tx
                .send(command)
                .await
                .expect("publish terminal input");
            // Close after consuming input, before the success acknowledgement.
            // Keep the observer channel alive long enough to prove no replay.
            tokio::time::sleep(Duration::from_secs(2)).await;
        });

        (task, command_rx)
    }

    async fn spawn_fake_control_daemon_across_connections(
        daemon_dir: String,
    ) -> (tokio::task::JoinHandle<()>, mpsc::Receiver<DaemonCommand>) {
        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind multi-control daemon");
        let (command_tx, command_rx) = mpsc::channel(8);

        let task = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.expect("accept control connection");
                let command_tx = command_tx.clone();
                handlers.spawn(async move {
                    let mut reader = BufReader::new(stream);
                    loop {
                        let mut line = String::new();
                        let read = reader
                            .read_line(&mut line)
                            .await
                            .expect("read terminal command");
                        if read == 0 {
                            return;
                        }
                        let command =
                            serde_json::from_str(line.trim()).expect("parse terminal command");
                        if command_tx.send(command).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });

        (task, command_rx)
    }

    fn assert_command(actual: Option<DaemonCommand>, expected: DaemonCommand) {
        let actual = actual.expect("expected daemon command");
        assert_eq!(
            serde_json::to_value(actual).expect("serialize actual daemon command"),
            serde_json::to_value(expected).expect("serialize expected daemon command"),
        );
    }

    async fn ws_connect(
        url: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let mut request = url.into_client_request().expect("build websocket request");
        request.headers_mut().insert(
            "x-kanna-device-id",
            HeaderValue::from_static(TEST_DEVICE_ID),
        );
        request.headers_mut().insert(
            "x-kanna-device-secret",
            HeaderValue::from_static(TEST_DEVICE_SECRET),
        );
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .expect("ws connect");
        socket
    }

    async fn ws_connect_unpaired(
        url: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let (socket, _) = tokio_tungstenite::connect_async(url)
            .await
            .expect("ws connect");
        socket
    }

    async fn ws_connect_with_cookie(
        url: &str,
        cookie: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let mut request = url.into_client_request().expect("build websocket request");
        request.headers_mut().insert(
            "cookie",
            HeaderValue::from_str(cookie).expect("valid compatibility cookie"),
        );
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .expect("cookie-authenticated ws connect");
        socket
    }

    async fn send_frame(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        frame: &ClientFrame,
    ) {
        let json = serde_json::to_string(frame).expect("serialize frame");
        socket
            .send(TungsteniteMessage::Text(json.into()))
            .await
            .expect("send frame");
    }

    fn client_auth_frame() -> ClientFrame {
        ClientFrame::Auth {
            credential: None,
            capabilities: vec![KspCapability::CompanionEventEpoch],
        }
    }

    fn legacy_client_auth_frame() -> ClientFrame {
        ClientFrame::Auth {
            credential: None,
            capabilities: Vec::new(),
        }
    }

    fn companion_lifecycle_test_conn(
        test_name: &str,
        supports_companion_event_epoch: bool,
    ) -> (StreamConn, OutboundFrameReceiver) {
        let state = Arc::new(AppState::new(test_config(test_name, "Companion Lifecycle")));
        let (frame_tx, companion_tx, outbound_rx) = outbound_frame_channel(256);
        (
            StreamConn {
                state,
                frame_tx,
                companion_tx,
                attachments: HashMap::new(),
                terminal_controls: HashMap::new(),
                terminal_inputs: HashMap::new(),
                agent_commands: None,
                requests: None,
                companion_events: None,
                authed: true,
                supports_companion_event_epoch,
                legacy_companion_tasks_on_connection: HashSet::new(),
                auth_mode: AuthMode::AllowEmpty,
                companion_access: true,
            },
            outbound_rx,
        )
    }

    fn companion_attach_frame(task_id: String, attachment_epoch: u64) -> ClientFrame {
        ClientFrame::Attach {
            task_id,
            kind: StreamKind::Companion,
            from_seq: 0,
            include_assets: None,
            accept_snapshot_chunks: Some(false),
            attachment_epoch: Some(attachment_epoch),
        }
    }

    #[tokio::test]
    async fn epoch_capable_companion_attaches_do_not_retain_lifecycle_history() {
        let (mut conn, _outbound_rx) =
            companion_lifecycle_test_conn("modern-lifecycle-history", true);

        for index in 0..3 {
            let task_id = format!("modern-task-{index}");
            assert!(
                conn.handle(companion_attach_frame(task_id.clone(), index))
                    .await
            );
            assert!(
                conn.handle(ClientFrame::Detach {
                    task_id,
                    kind: StreamKind::Companion,
                    attachment_epoch: Some(index),
                })
                .await
            );
        }

        assert!(
            conn.legacy_companion_tasks_on_connection.is_empty(),
            "epoch-capable peers must not retain task lifecycle history"
        );
        conn.shutdown().await;
    }

    #[tokio::test]
    async fn legacy_companion_duplicate_attach_retires_with_an_error_frame() {
        let (mut conn, mut outbound_rx) =
            companion_lifecycle_test_conn("legacy-duplicate-attach", false);

        assert!(
            conn.handle(companion_attach_frame("legacy-task".into(), 0))
                .await
        );
        // Replacing a still-attached legacy companion on the same connection
        // is connection-fatal — legacy events carry no epoch to fence a
        // second concurrent lifecycle — but the retire must be announced
        // rather than silently ending terminal and agent streams too.
        assert!(
            !conn
                .handle(companion_attach_frame("legacy-task".into(), 1))
                .await,
            "duplicate legacy attach without detach must retire the connection"
        );
        let mut saw_rejection = false;
        while let Ok(Some(frame)) =
            tokio::time::timeout(Duration::from_millis(500), outbound_rx.recv()).await
        {
            if let ServerFrame::Error { code, .. } = &frame {
                if code == "companion_attach_rejected" {
                    saw_rejection = true;
                    break;
                }
            }
        }
        assert!(
            saw_rejection,
            "retiring the connection must be announced with an error frame"
        );
        conn.shutdown().await;
    }

    #[tokio::test]
    async fn legacy_companion_reattach_after_detach_succeeds() {
        let (mut conn, _outbound_rx) =
            companion_lifecycle_test_conn("legacy-reattach-after-detach", false);

        // A legacy client re-sends attach on every companion modal reopen;
        // a detached task must not keep holding one of its bounded slots.
        for epoch in 0..3_u64 {
            assert!(
                conn.handle(companion_attach_frame("legacy-task".into(), epoch))
                    .await,
                "re-attach after detach must keep the connection open (epoch {epoch})"
            );
            assert_eq!(conn.legacy_companion_tasks_on_connection.len(), 1);
            assert!(
                conn.handle(ClientFrame::Detach {
                    task_id: "legacy-task".into(),
                    kind: StreamKind::Companion,
                    attachment_epoch: Some(epoch),
                })
                .await
            );
            assert!(
                conn.legacy_companion_tasks_on_connection.is_empty(),
                "detach must release the task's legacy attachment slot"
            );
        }
        conn.shutdown().await;
    }

    async fn recv_frame(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> ServerFrame {
        loop {
            let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
                .await
                .expect("timed out waiting for frame")
                .expect("socket closed")
                .expect("socket error");
            if let TungsteniteMessage::Text(text) = message {
                let frame: ServerFrame = serde_json::from_str(&text).expect("parse server frame");
                let ServerFrame::CompanionSnapshotChunk {
                    task_id,
                    transfer_id,
                    index,
                    count,
                    data,
                    ..
                } = frame
                else {
                    return frame;
                };
                assert_eq!(index, 0, "chunked snapshot started after index zero");
                let mut serialized = data;
                for expected_index in 1..count {
                    let message =
                        tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
                            .await
                            .expect("timed out waiting for companion chunk")
                            .expect("socket closed during companion chunks")
                            .expect("socket error during companion chunks");
                    let TungsteniteMessage::Text(text) = message else {
                        panic!("non-text message interrupted companion chunks");
                    };
                    match serde_json::from_str::<ServerFrame>(&text).expect("parse companion chunk")
                    {
                        ServerFrame::CompanionSnapshotChunk {
                            task_id: next_task_id,
                            transfer_id: next_transfer_id,
                            index,
                            count: next_count,
                            data,
                            ..
                        } => {
                            assert_eq!(next_task_id, task_id);
                            assert_eq!(next_transfer_id, transfer_id);
                            assert_eq!(next_count, count);
                            assert_eq!(index, expected_index);
                            serialized.push_str(&data);
                        }
                        other => panic!("frame interrupted companion chunks: {other:?}"),
                    }
                }
                return serde_json::from_str(&serialized).expect("parse reassembled snapshot");
            }
        }
    }

    async fn recv_frame_with_timeout(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        timeout: Duration,
    ) -> Option<ServerFrame> {
        let message = tokio::time::timeout(timeout, socket.next())
            .await
            .ok()??
            .ok()?;
        match message {
            TungsteniteMessage::Text(text) => serde_json::from_str(&text).ok(),
            _ => None,
        }
    }

    async fn recv_reassembled_outbound(
        receiver: &mut OutboundFrameReceiver,
    ) -> Option<ServerFrame> {
        let first = receiver.recv().await?;
        let ServerFrame::CompanionSnapshotChunk {
            task_id,
            transfer_id,
            index,
            count,
            data,
            ..
        } = first
        else {
            return Some(first);
        };
        assert_eq!(index, 0);
        let mut serialized = data;
        for expected_index in 1..count {
            match receiver.recv().await {
                Some(ServerFrame::CompanionSnapshotChunk {
                    task_id: next_task_id,
                    transfer_id: next_transfer_id,
                    index,
                    count: next_count,
                    data,
                    ..
                }) => {
                    assert_eq!(next_task_id, task_id);
                    assert_eq!(next_transfer_id, transfer_id);
                    assert_eq!(next_count, count);
                    assert_eq!(index, expected_index);
                    serialized.push_str(&data);
                }
                other => panic!("frame interrupted companion chunks: {other:?}"),
            }
        }
        Some(serde_json::from_str(&serialized).expect("parse reassembled outbound snapshot"))
    }

    struct KspCompanionFixture {
        config: crate::config::Config,
        db_path: PathBuf,
        worktree: PathBuf,
        temp_dir: tempfile::TempDir,
    }

    impl KspCompanionFixture {
        fn new(label: &str) -> Self {
            let temp_dir = tempfile::tempdir().expect("create KSP companion fixture");
            let db_path = temp_dir.path().join("kanna.sqlite");
            let worktree = temp_dir.path().join("worktree");
            std::fs::create_dir_all(&worktree).unwrap();
            let unique = format!(
                "ksp-companion-{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let mut config = test_config(&unique, "KSP Companion");
            config.db_path = db_path.to_string_lossy().to_string();
            config.pairing_store_path = temp_dir
                .path()
                .join("pairings.json")
                .to_string_lossy()
                .to_string();
            let mut pairing_store = crate::pairing::PairingStore::default();
            pairing_store.add_trusted_device(
                &config.desktop_id,
                TEST_DEVICE_ID,
                "KSP Test Device",
                &crate::pairing::hash_device_secret(TEST_DEVICE_SECRET),
            );
            pairing_store
                .save(std::path::Path::new(&config.pairing_store_path))
                .expect("save KSP test pairing");
            let db = Db::open_for_tests(&config.db_path).unwrap();
            db.insert_test_repo_with_path("repo-1", temp_dir.path().to_str().unwrap(), "Repo One")
                .unwrap();
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "Visual companion",
                None,
                "in progress",
                "2026-07-17T00:00:00Z",
            )
            .unwrap();
            db.upsert_worktree("wt-task-1", "task-1", worktree.to_str().unwrap(), "task-1")
                .unwrap();
            Self {
                config,
                db_path,
                worktree,
                temp_dir,
            }
        }

        fn write(&self, relative: &str, bytes: &[u8]) {
            let target = self.worktree.join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(target, bytes).unwrap();
        }

        fn activate(&self, session_id: &str, file_name: &str, html: &[u8]) {
            self.write(
                &format!(".superpowers/brainstorm/{session_id}/state/server-info"),
                b"{}",
            );
            self.write(
                &format!(".superpowers/brainstorm/{session_id}/content/{file_name}"),
                html,
            );
        }

        fn server_info(&self, session_id: &str, bytes: &[u8]) {
            self.write(
                &format!(".superpowers/brainstorm/{session_id}/state/server-info"),
                bytes,
            );
        }

        fn content(&self, session_id: &str, file_name: &str, bytes: &[u8]) {
            self.write(
                &format!(".superpowers/brainstorm/{session_id}/content/{file_name}"),
                bytes,
            );
        }

        fn add_task(&self, task_id: &str) -> PathBuf {
            let worktree = self.temp_dir.path().join(format!("worktree-{task_id}"));
            std::fs::create_dir_all(&worktree).unwrap();
            let db = Db::open(self.db_path.to_str().unwrap()).unwrap();
            db.insert_test_pipeline_item(
                task_id,
                "repo-1",
                "Visual companion",
                None,
                "in progress",
                "2026-07-17T00:00:00Z",
            )
            .unwrap();
            db.upsert_worktree(
                &format!("wt-{task_id}"),
                task_id,
                worktree.to_str().unwrap(),
                task_id,
            )
            .unwrap();
            worktree
        }

        fn activate_maximum_bundle(worktree: &std::path::Path, session_id: &str) {
            let session = worktree.join(".superpowers/brainstorm").join(session_id);
            std::fs::create_dir_all(session.join("state")).unwrap();
            std::fs::create_dir_all(session.join("content")).unwrap();
            std::fs::write(session.join("state/server-info"), b"{}").unwrap();
            std::fs::write(
                session.join("content/screen.html"),
                vec![b'x'; kanna_visual_companion::MAX_COMPANION_HTML_BYTES as usize],
            )
            .unwrap();
            let asset = vec![0_u8; kanna_visual_companion::MAX_COMPANION_ASSET_BYTES as usize];
            for index in 0..4 {
                std::fs::write(
                    session.join("content").join(format!("asset-{index}.png")),
                    &asset,
                )
                .unwrap();
            }
        }

        async fn serve(&self) -> String {
            serve_router(crate::http_api::router(Arc::new(AppState::new(
                self.config.clone(),
            ))))
            .await
        }

        fn event(event_id: &str) -> CompanionEvent {
            CompanionEvent {
                session_id: "session-1".into(),
                revision: "revision-1".into(),
                event_id: event_id.into(),
                event_type: "click".into(),
                choice: "a".into(),
                text: "Option A".into(),
                element_id: None,
                timestamp: 1_784_268_000_000,
            }
        }
    }

    #[tokio::test]
    async fn companion_outbound_coalesces_backpressured_revisions_without_starving_terminal() {
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(256);
        let companion_attachment = companion_tx.attachment("task-1".into(), true, true);
        let snapshot = |revision: &str| ServerFrame::CompanionSnapshot {
            task_id: "task-1".into(),
            session_id: "session-1".into(),
            revision: revision.into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: format!("<p>{revision}</p>"),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        };

        for revision in ["revision-1", "revision-2", "revision-3"] {
            assert!(companion_attachment.publish(snapshot(revision)));
        }
        frame_tx
            .send(ServerFrame::TermOutput {
                task_id: "task-1".into(),
                data_b64: b64(b"responsive"),
            })
            .await
            .unwrap();

        assert!(matches!(
            recv_reassembled_outbound(&mut outbound_rx).await,
            Some(ServerFrame::TermOutput { .. })
        ));
        match recv_reassembled_outbound(&mut outbound_rx).await {
            Some(ServerFrame::CompanionSnapshot { revision, .. }) => {
                assert_eq!(revision, "revision-3")
            }
            other => panic!("expected newest companion snapshot, got {other:?}"),
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(25), outbound_rx.recv())
                .await
                .is_err(),
            "intermediate companion snapshots must be discarded"
        );
    }

    #[tokio::test]
    async fn legacy_companion_attachment_preserves_unchunked_snapshot() {
        let (_frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let companion_attachment = companion_tx.attachment("task-legacy".into(), true, false);
        let expected = ServerFrame::CompanionSnapshot {
            task_id: "task-legacy".into(),
            session_id: "session-legacy".into(),
            revision: "revision-legacy".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "<h1>Legacy</h1>".into(),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        };
        assert!(companion_attachment.publish(expected.clone()));

        assert_eq!(outbound_rx.recv().await, Some(expected));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn maximum_companion_serialization_does_not_delay_terminal_output() {
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(1);
        let companion_attachment = companion_tx.attachment("task-max-serialize".into(), true, true);
        let asset_bytes = kanna_visual_companion::MAX_COMPANION_ASSET_TOTAL_BYTES as usize
            / kanna_visual_companion::MAX_COMPANION_ASSET_COUNT;
        let asset_data_b64 = b64(&vec![b'x'; asset_bytes]);
        assert!(
            companion_attachment.publish(ServerFrame::CompanionSnapshot {
                task_id: "task-max-serialize".into(),
                session_id: "session-max".into(),
                revision: "revision-max".into(),
                document_kind: CompanionDocumentKind::FullDocument,
                html: "x".repeat(kanna_visual_companion::MAX_COMPANION_HTML_BYTES as usize),
                source_origin: None,
                assets: (0..kanna_visual_companion::MAX_COMPANION_ASSET_COUNT)
                    .map(|index| CompanionAsset {
                        name: format!("{index}.bin"),
                        content_type: "application/octet-stream".into(),
                        digest: "d".repeat(64),
                        data_b64: asset_data_b64.clone(),
                    })
                    .collect(),
                attachment_epoch: None,
            })
        );
        let gate = install_companion_serialize_test_gate(&["task-max-serialize"]);
        let receiver = tokio::spawn(async move {
            let frame = outbound_rx.recv().await;
            (frame, outbound_rx)
        });
        gate.wait_until_blocked().await;

        frame_tx
            .send(ServerFrame::TermOutput {
                task_id: "task-max-serialize".into(),
                data_b64: b64(b"responsive"),
            })
            .await
            .unwrap();
        let (frame, _outbound_rx) = tokio::time::timeout(Duration::from_millis(100), receiver)
            .await
            .expect("terminal output waited for maximum companion serialization")
            .unwrap();
        assert!(matches!(frame, Some(ServerFrame::TermOutput { .. })));
        gate.release();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_companion_serialization_is_discarded_after_reattach() {
        let (_frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let old = companion_tx.attachment("task-fenced".into(), true, true);
        assert!(old.publish(ServerFrame::CompanionSnapshot {
            task_id: "task-fenced".into(),
            session_id: "session-old".into(),
            revision: "revision-old".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "<p>old</p>".into(),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        }));
        let gate = install_companion_serialize_test_gate(&["task-fenced"]);
        let receiver = tokio::spawn(async move {
            let frame = recv_reassembled_outbound(&mut outbound_rx).await;
            (frame, outbound_rx)
        });
        gate.wait_until_blocked().await;

        let current = companion_tx.attachment("task-fenced".into(), true, true);
        assert!(current.publish(ServerFrame::CompanionSnapshot {
            task_id: "task-fenced".into(),
            session_id: "session-current".into(),
            revision: "revision-current".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "<p>current</p>".into(),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        }));
        gate.release();
        let (frame, _outbound_rx) = receiver.await.unwrap();
        assert!(matches!(
            frame,
            Some(ServerFrame::CompanionSnapshot { revision, .. })
                if revision == "revision-current"
        ));
    }

    #[tokio::test]
    async fn blocked_companion_delivery_is_cancelled_after_reattach() {
        let (_frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let old = companion_tx.attachment("task-fenced-send".into(), true, false);
        assert!(old.publish(ServerFrame::CompanionSnapshot {
            task_id: "task-fenced-send".into(),
            session_id: "session-old".into(),
            revision: "revision-old".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "<p>old</p>".into(),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        }));
        assert!(matches!(
            outbound_rx.recv().await,
            Some(ServerFrame::CompanionSnapshot { revision, .. })
                if revision == "revision-old"
        ));
        let fence = outbound_rx
            .companion_delivery_fence()
            .expect("companion delivery must carry its attachment generation");
        let blocked_send = tokio::spawn(await_fenced_companion_send(
            std::future::pending::<Result<(), ()>>(),
            fence,
        ));
        tokio::task::yield_now().await;

        let _current = companion_tx.attachment("task-fenced-send".into(), true, false);

        assert_eq!(
            tokio::time::timeout(Duration::from_millis(100), blocked_send)
                .await
                .expect("blocked stale delivery ignored attachment replacement")
                .unwrap(),
            Err(())
        );
    }

    #[tokio::test]
    async fn completed_old_companion_delivery_keeps_its_wire_epoch_after_reattach() {
        let (_frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let old =
            companion_tx.attachment_with_epoch("task-completed-send".into(), true, false, Some(1));
        assert!(old.publish(ServerFrame::CompanionSnapshot {
            task_id: "task-completed-send".into(),
            session_id: "session-old".into(),
            revision: "revision-old".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "<p>old</p>".into(),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        }));
        let completed_old_delivery = outbound_rx
            .recv()
            .await
            .expect("old delivery must complete before replacement");
        let old_delivery_fence = outbound_rx
            .companion_delivery_fence()
            .expect("old delivery must carry its attachment generation");
        assert_eq!(
            await_fenced_companion_send(std::future::ready(Ok::<(), ()>(())), old_delivery_fence,)
                .await,
            Ok(Ok(())),
            "the old wire send completes before the replacement is processed"
        );

        let current =
            companion_tx.attachment_with_epoch("task-completed-send".into(), true, false, Some(2));
        assert!(current.publish(ServerFrame::CompanionSnapshot {
            task_id: "task-completed-send".into(),
            session_id: "session-current".into(),
            revision: "revision-current".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "<p>current</p>".into(),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        }));

        assert!(matches!(
            completed_old_delivery,
            ServerFrame::CompanionSnapshot {
                revision,
                attachment_epoch: Some(1),
                ..
            } if revision == "revision-old"
        ));
        assert!(matches!(
            outbound_rx.recv().await,
            Some(ServerFrame::CompanionSnapshot {
                revision,
                attachment_epoch: Some(2),
                ..
            }) if revision == "revision-current"
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn maximum_bundle_fanout_shares_source_and_stays_charged_during_delivery() {
        let shared_pending = Arc::new(AtomicUsize::new(0));
        let (_frame_a, tx_a, mut rx_a) =
            outbound_frame_channel_with_budget(8, Arc::clone(&shared_pending));
        let (_frame_b, tx_b, mut rx_b) =
            outbound_frame_channel_with_budget(8, Arc::clone(&shared_pending));
        let sender_a = tx_a.attachment("task-fanout-a".into(), true, true);
        let sender_b = tx_b.attachment("task-fanout-b".into(), true, true);
        let asset_bytes = kanna_visual_companion::MAX_COMPANION_ASSET_TOTAL_BYTES as usize
            / kanna_visual_companion::MAX_COMPANION_ASSET_COUNT;
        let asset_data_b64 = b64(&vec![b'x'; asset_bytes]);
        let maximum = Arc::new(ServerFrame::CompanionSnapshot {
            task_id: "task-source".into(),
            session_id: "session-max".into(),
            revision: "revision-max".into(),
            document_kind: CompanionDocumentKind::FullDocument,
            html: "x".repeat(kanna_visual_companion::MAX_COMPANION_HTML_BYTES as usize),
            source_origin: None,
            assets: (0..kanna_visual_companion::MAX_COMPANION_ASSET_COUNT)
                .map(|index| CompanionAsset {
                    name: format!("{index}.bin"),
                    content_type: "application/octet-stream".into(),
                    digest: "d".repeat(64),
                    data_b64: asset_data_b64.clone(),
                })
                .collect(),
            attachment_epoch: None,
        });
        let retained = companion_frame_retained_bytes(maximum.as_ref());
        let strong_before = Arc::strong_count(&maximum);
        assert!(sender_a.publish_shared(&maximum));
        assert!(sender_b.publish_shared(&maximum));
        assert_eq!(Arc::strong_count(&maximum), strong_before + 2);
        assert_eq!(shared_pending.load(Ordering::Acquire), retained * 2);

        let gate = install_companion_serialize_test_gate(&["task-fanout-a", "task-fanout-b"]);
        let delivery_a = tokio::spawn(async move { recv_reassembled_outbound(&mut rx_a).await });
        let delivery_b = tokio::spawn(async move { recv_reassembled_outbound(&mut rx_b).await });
        gate.wait_until_blocked().await;
        gate.wait_until_blocked().await;
        assert_eq!(
            shared_pending.load(Ordering::Acquire),
            retained * 2,
            "active serialization released aggregate admission early"
        );
        gate.release();
        assert!(matches!(
            delivery_a.await.unwrap(),
            Some(ServerFrame::CompanionSnapshot { .. })
        ));
        assert!(matches!(
            delivery_b.await.unwrap(),
            Some(ServerFrame::CompanionSnapshot { .. })
        ));
        assert_eq!(shared_pending.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn maximum_companion_bundle_uses_bounded_frames_and_yields_to_terminal_output() {
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let companion_attachment = companion_tx.attachment("task-max".into(), true, true);
        let asset_bytes = kanna_visual_companion::MAX_COMPANION_ASSET_TOTAL_BYTES as usize
            / kanna_visual_companion::MAX_COMPANION_ASSET_COUNT;
        let asset_data_b64 = b64(&vec![b'x'; asset_bytes]);
        assert!(
            companion_attachment.publish(ServerFrame::CompanionSnapshot {
                task_id: "task-max".into(),
                session_id: "session-max".into(),
                revision: "revision-max".into(),
                document_kind: CompanionDocumentKind::FullDocument,
                html: "x".repeat(kanna_visual_companion::MAX_COMPANION_HTML_BYTES as usize),
                source_origin: None,
                assets: (0..kanna_visual_companion::MAX_COMPANION_ASSET_COUNT)
                    .map(|index| CompanionAsset {
                        name: format!("{index}.bin"),
                        content_type: "application/octet-stream".into(),
                        digest: "d".repeat(64),
                        data_b64: asset_data_b64.clone(),
                    })
                    .collect(),
                attachment_epoch: None,
            })
        );

        let first = outbound_rx.recv().await.expect("first companion chunk");
        let first_wire = serde_json::to_vec(&first).unwrap();
        assert!(
            first_wire.len() <= 256 * 1024,
            "first companion wire frame monopolizes the writer at {} bytes",
            first_wire.len()
        );
        frame_tx
            .send(ServerFrame::TermOutput {
                task_id: "task-max".into(),
                data_b64: b64(b"responsive"),
            })
            .await
            .unwrap();
        assert!(matches!(
            outbound_rx.recv().await,
            Some(ServerFrame::TermOutput { .. })
        ));
    }

    #[tokio::test]
    async fn asset_free_attachment_coalesces_maximum_legal_bundle_churn() {
        let shared_pending = Arc::new(AtomicUsize::new(0));
        let (frame_tx, companion_tx, mut outbound_rx) =
            outbound_frame_channel_with_budget(8, Arc::clone(&shared_pending));
        let companion_attachment = companion_tx.attachment("task-mobile".into(), false, true);
        let maximum_bundle = |revision: usize| {
            let asset_bytes = kanna_visual_companion::MAX_COMPANION_ASSET_TOTAL_BYTES as usize
                / kanna_visual_companion::MAX_COMPANION_ASSET_COUNT;
            let asset_data_b64 = b64(&vec![b'x'; asset_bytes]);
            Arc::new(ServerFrame::CompanionSnapshot {
                task_id: "task-mobile".into(),
                session_id: "session-mobile".into(),
                revision: format!("revision-{revision}"),
                document_kind: CompanionDocumentKind::FullDocument,
                html: "x".repeat(kanna_visual_companion::MAX_COMPANION_HTML_BYTES as usize),
                source_origin: None,
                assets: (0..kanna_visual_companion::MAX_COMPANION_ASSET_COUNT)
                    .map(|index| CompanionAsset {
                        name: format!("{index}.bin"),
                        content_type: "application/octet-stream".into(),
                        digest: "d".repeat(64),
                        data_b64: asset_data_b64.clone(),
                    })
                    .collect(),
                attachment_epoch: None,
            })
        };

        for revision in 1..=4 {
            let frame = maximum_bundle(revision);
            assert!(companion_attachment.publish_shared(&frame));
            assert!(
                shared_pending.load(Ordering::Acquire)
                    <= kanna_visual_companion::MAX_COMPANION_HTML_BYTES as usize + 4096,
                "asset-free attachment retained embedded asset bytes"
            );
        }

        match recv_reassembled_outbound(&mut outbound_rx).await {
            Some(ServerFrame::CompanionSnapshot {
                revision,
                html,
                assets,
                ..
            }) => {
                assert_eq!(revision, "revision-4");
                assert_eq!(
                    html.len(),
                    kanna_visual_companion::MAX_COMPANION_HTML_BYTES as usize
                );
                assert!(assets.is_empty());
            }
            other => panic!("expected newest asset-free companion snapshot, got {other:?}"),
        }
        assert!(
            shared_pending.load(Ordering::Acquire) > 0,
            "the final chunk must remain charged until the writer confirms delivery"
        );
        frame_tx
            .send(ServerFrame::TermOutput {
                task_id: "task-mobile".into(),
                data_b64: b64(b"delivery acknowledged"),
            })
            .await
            .unwrap();
        assert!(matches!(
            outbound_rx.recv().await,
            Some(ServerFrame::TermOutput { .. })
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(25), outbound_rx.recv())
                .await
                .is_err(),
            "intermediate maximum bundles must be discarded"
        );
        assert_eq!(shared_pending.load(Ordering::Acquire), 0);
    }

    #[test]
    fn companion_frame_filter_shares_asset_snapshots_only_when_assets_are_requested() {
        let source = Arc::new(ServerFrame::CompanionSnapshot {
            task_id: "task-filter".into(),
            session_id: "session-filter".into(),
            revision: "revision-filter".into(),
            document_kind: CompanionDocumentKind::FullDocument,
            html: "<p>filtered</p>".into(),
            source_origin: Some("http://localhost:1420".into()),
            assets: vec![CompanionAsset {
                name: "large.bin".into(),
                content_type: "application/octet-stream".into(),
                digest: "d".repeat(64),
                data_b64: "x".repeat(1024 * 1024),
            }],
            attachment_epoch: Some(7),
        });

        let with_assets = companion_frame_for_attachment(&source, true);
        assert!(Arc::ptr_eq(&source, &with_assets));

        let without_assets = companion_frame_for_attachment(&source, false);
        assert!(!Arc::ptr_eq(&source, &without_assets));
        assert!(matches!(
            without_assets.as_ref(),
            ServerFrame::CompanionSnapshot {
                task_id,
                session_id,
                revision,
                html,
                source_origin: Some(source_origin),
                assets,
                attachment_epoch: Some(7),
                ..
            } if task_id == "task-filter"
                && session_id == "session-filter"
                && revision == "revision-filter"
                && html == "<p>filtered</p>"
                && source_origin == "http://localhost:1420"
                && assets.is_empty()
        ));
        assert!(matches!(
            source.as_ref(),
            ServerFrame::CompanionSnapshot { assets, .. } if assets.len() == 1
        ));
    }

    #[tokio::test]
    async fn companion_outbound_progresses_during_sustained_ordinary_saturation() {
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(256);
        let companion_attachment = companion_tx.attachment("task-companion".into(), true, true);
        assert!(
            companion_attachment.publish(ServerFrame::CompanionSnapshot {
                task_id: "task-companion".into(),
                session_id: "session-companion".into(),
                revision: "revision-1".into(),
                document_kind: CompanionDocumentKind::Fragment,
                html: "<p>companion</p>".into(),
                source_origin: None,
                assets: Vec::new(),
                attachment_epoch: None,
            })
        );
        for index in 0..256 {
            frame_tx
                .try_send(ServerFrame::TermOutput {
                    task_id: "task-terminal".into(),
                    data_b64: b64(format!("ordinary-{index}").as_bytes()),
                })
                .expect("ordinary saturation frame should fit");
        }

        let mut ordinary_before_companion = 0;
        loop {
            match recv_reassembled_outbound(&mut outbound_rx).await {
                Some(ServerFrame::TermOutput { .. }) => ordinary_before_companion += 1,
                Some(ServerFrame::CompanionSnapshot { revision, .. }) => {
                    assert_eq!(revision, "revision-1");
                    break;
                }
                other => panic!("unexpected outbound frame: {other:?}"),
            }
        }
        assert!(
            ordinary_before_companion <= 32,
            "companion progress was delayed behind {ordinary_before_companion} ordinary frames"
        );
    }

    #[tokio::test]
    async fn companion_outbound_serves_each_pending_task_before_repeated_updates() {
        let (_frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(256);
        let task_a_tx = companion_tx.attachment("task-a".into(), true, true);
        let task_b_tx = companion_tx.attachment("task-b".into(), true, true);
        let snapshot = |task_id: &str, revision: &str| ServerFrame::CompanionSnapshot {
            task_id: task_id.into(),
            session_id: format!("session-{task_id}"),
            revision: revision.into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: format!("<p>{task_id}-{revision}</p>"),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        };

        assert!(task_a_tx.publish(snapshot("task-a", "revision-a1")));
        assert!(task_b_tx.publish(snapshot("task-b", "revision-b1")));

        let first_task = match recv_reassembled_outbound(&mut outbound_rx).await {
            Some(ServerFrame::CompanionSnapshot { task_id, .. }) => task_id,
            other => panic!("expected first companion snapshot, got {other:?}"),
        };
        let other_task = if first_task == "task-a" {
            "task-b"
        } else {
            "task-a"
        };
        let noisy_tx = if first_task == "task-a" {
            &task_a_tx
        } else {
            &task_b_tx
        };
        assert!(noisy_tx.publish(snapshot(&first_task, "revision-2")));
        assert!(noisy_tx.publish(snapshot(&first_task, "revision-3")));

        match recv_reassembled_outbound(&mut outbound_rx).await {
            Some(ServerFrame::CompanionSnapshot { task_id, .. }) => {
                assert_eq!(task_id, other_task, "a noisy task must not starve its peer")
            }
            other => panic!("expected peer companion snapshot, got {other:?}"),
        }
        match recv_reassembled_outbound(&mut outbound_rx).await {
            Some(ServerFrame::CompanionSnapshot {
                task_id, revision, ..
            }) => {
                assert_eq!(task_id, first_task);
                assert_eq!(revision, "revision-3");
            }
            other => panic!("expected coalesced repeated update, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn relay_companion_resources_share_scans_slots_and_pending_byte_admission() {
        let resources = CompanionResources::default();
        let first_scan = resources.subscribe("/missing/db".into(), "task-shared".into(), true);
        let second_scan = resources.subscribe("/missing/db".into(), "task-shared".into(), true);
        assert!(Arc::ptr_eq(&first_scan._source, &second_scan._source));

        let slots = (0..MAX_RELAY_COMPANION_ATTACHMENTS)
            .map(|_| resources.try_attachment().expect("attachment admitted"))
            .collect::<Vec<_>>();
        assert!(resources.try_attachment().is_none());
        drop(slots);
        assert!(resources.try_attachment().is_some());

        let shared_pending = Arc::new(AtomicUsize::new(0));
        let (first_tx, first_companion, mut first_rx) =
            outbound_frame_channel_with_budget(8, Arc::clone(&shared_pending));
        let (second_tx, second_companion, mut second_rx) =
            outbound_frame_channel_with_budget(8, Arc::clone(&shared_pending));
        let large_snapshot = |task_id: &str| ServerFrame::CompanionSnapshot {
            task_id: task_id.into(),
            session_id: "session".into(),
            revision: "revision".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "x".repeat(40 * 1024 * 1024),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        };
        let shared_retained = Arc::new(AtomicUsize::new(0));
        let retained =
            RetainedCompanionFrame::try_new(large_snapshot("task-retained-a"), &shared_retained)
                .expect("first retained source admitted");
        assert!(
            RetainedCompanionFrame::try_new(large_snapshot("task-retained-b"), &shared_retained,)
                .is_none(),
            "aggregate source retention must reject a second oversized frame"
        );
        drop(retained);
        assert_eq!(shared_retained.load(Ordering::Acquire), 0);

        assert!(first_companion
            .attachment("task-a".into(), true, true)
            .publish(large_snapshot("task-a")));
        assert!(second_companion
            .attachment("task-b".into(), true, true)
            .publish(large_snapshot("task-b")));
        assert!(shared_pending.load(Ordering::Acquire) <= MAX_RELAY_COMPANION_PENDING_BYTES);
        assert!(matches!(
            recv_reassembled_outbound(&mut first_rx).await,
            Some(ServerFrame::CompanionSnapshot { .. })
        ));
        assert!(matches!(
            recv_reassembled_outbound(&mut second_rx).await,
            Some(ServerFrame::CompanionError { .. })
        ));
        assert!(
            shared_pending.load(Ordering::Acquire) > 0,
            "prepared frames must remain charged through their writer delivery"
        );
        first_tx
            .send(ServerFrame::TermOutput {
                task_id: "task-a".into(),
                data_b64: b64(b"first delivery acknowledged"),
            })
            .await
            .unwrap();
        second_tx
            .send(ServerFrame::TermOutput {
                task_id: "task-b".into(),
                data_b64: b64(b"second delivery acknowledged"),
            })
            .await
            .unwrap();
        assert!(matches!(
            first_rx.recv().await,
            Some(ServerFrame::TermOutput { .. })
        ));
        assert!(matches!(
            second_rx.recv().await,
            Some(ServerFrame::TermOutput { .. })
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(25), first_rx.recv())
                .await
                .is_err(),
            "first attachment should have no companion frame after delivery"
        );
        assert_eq!(shared_pending.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn assetless_maximum_companion_bundles_do_not_exhaust_shared_retention() {
        let fixture = KspCompanionFixture::new("assetless-maximum-retention");
        let second_worktree = fixture.add_task("task-2");
        let third_worktree = fixture.add_task("task-3");
        KspCompanionFixture::activate_maximum_bundle(&fixture.worktree, "session-1");
        KspCompanionFixture::activate_maximum_bundle(&second_worktree, "session-2");
        KspCompanionFixture::activate_maximum_bundle(&third_worktree, "session-3");

        let resources = CompanionResources::default();
        let db_path = fixture.db_path.to_string_lossy().to_string();
        let mut subscriptions = Vec::new();
        for task_id in ["task-1", "task-2", "task-3"] {
            let mut subscription = resources.subscribe(db_path.clone(), task_id.to_string(), false);
            tokio::time::timeout(Duration::from_secs(10), subscription.frames.changed())
                .await
                .expect("assetless source should finish its initial maximum-bundle scan")
                .expect("assetless source should remain open");
            {
                let retained = subscription.frames.borrow_and_update();
                match retained.as_deref().map(|frame| frame.frame.as_ref()) {
                    Some(ServerFrame::CompanionSnapshot { assets, .. }) => {
                        assert!(assets.is_empty(), "{task_id} retained unrequested assets")
                    }
                    Some(ServerFrame::CompanionError { code, .. })
                        if code == "companion_resource_limit" =>
                    {
                        panic!("{task_id} exhausted shared retention")
                    }
                    other => panic!("unexpected assetless maximum-bundle result: {other:?}"),
                }
            }
            subscriptions.push(subscription);
        }

        assert!(
            resources.retained_bytes.load(Ordering::Acquire) < MAX_RELAY_COMPANION_RETAINED_BYTES,
            "assetless maximum bundles exhausted shared retention"
        );
    }

    #[tokio::test]
    async fn mixed_companion_asset_demand_upgrades_and_downgrades_shared_source() {
        let fixture = KspCompanionFixture::new("mixed-asset-demand");
        KspCompanionFixture::activate_maximum_bundle(&fixture.worktree, "session-1");

        let resources = CompanionResources::default();
        let db_path = fixture.db_path.to_string_lossy().to_string();
        let mut assetless = resources.subscribe(db_path.clone(), "task-1".into(), false);
        tokio::time::timeout(Duration::from_secs(10), assetless.frames.changed())
            .await
            .expect("assetless source should finish its initial scan")
            .expect("assetless source should remain open");
        {
            let retained = assetless.frames.borrow_and_update();
            match retained.as_deref().map(|frame| frame.frame.as_ref()) {
                Some(ServerFrame::CompanionSnapshot { assets, .. }) => {
                    assert!(assets.is_empty())
                }
                other => panic!("unexpected initial assetless result: {other:?}"),
            }
        }

        let mut assetful = resources.subscribe(db_path, "task-1".into(), true);
        assert!(Arc::ptr_eq(&assetless._source, &assetful._source));
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                assetful
                    .frames
                    .changed()
                    .await
                    .expect("assetful source should remain open");
                let retained = assetful.frames.borrow_and_update();
                match retained.as_deref().map(|frame| frame.frame.as_ref()) {
                    Some(ServerFrame::CompanionSnapshot { assets, .. }) => {
                        assert_eq!(
                            assets.len(),
                            4,
                            "assetful observer received a stale assetless snapshot"
                        );
                        return;
                    }
                    None => {}
                    other => panic!("unexpected upgraded companion result: {other:?}"),
                }
            }
        })
        .await
        .expect("shared source should rematerialize with assets");

        drop(assetful);
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                assetless
                    .frames
                    .changed()
                    .await
                    .expect("assetless source should remain open");
                let is_assetless = {
                    let retained = assetless.frames.borrow_and_update();
                    match retained.as_deref().map(|frame| frame.frame.as_ref()) {
                        Some(ServerFrame::CompanionSnapshot { assets, .. }) => assets.is_empty(),
                        None => false,
                        other => panic!("unexpected downgraded companion result: {other:?}"),
                    }
                };
                if is_assetless {
                    return;
                }
            }
        })
        .await
        .expect("shared source should replace full retention after asset demand ends");
        assert!(
            resources.retained_bytes.load(Ordering::Acquire)
                <= kanna_visual_companion::MAX_COMPANION_ASSETLESS_MATERIALIZED_BYTES,
            "full companion assets remained retained after asset demand ended"
        );
    }

    #[tokio::test]
    async fn companion_unavailable_remains_publishable_during_asset_demand_upgrade() {
        let fixture = KspCompanionFixture::new("unavailable-demand-upgrade");
        let resources = CompanionResources::default();
        let db_path = fixture.db_path.to_string_lossy().to_string();
        let mut assetless = resources.subscribe(db_path.clone(), "task-1".into(), false);
        tokio::time::timeout(Duration::from_secs(10), assetless.frames.changed())
            .await
            .expect("assetless unavailable scan should finish")
            .expect("assetless unavailable source should remain open");
        assert!(matches!(
            assetless
                .frames
                .borrow_and_update()
                .as_deref()
                .map(|frame| frame.frame.as_ref()),
            Some(ServerFrame::CompanionUnavailable { .. })
        ));

        let mut assetful = resources.subscribe(db_path, "task-1".into(), true);
        assert!(Arc::ptr_eq(&assetless._source, &assetful._source));
        if assetful.frames.borrow().is_some() {
            assetful.frames.mark_changed();
        }
        tokio::time::timeout(Duration::from_secs(2), assetful.frames.changed())
            .await
            .expect("assetful observer should promptly receive retained unavailability")
            .expect("assetful unavailable source should remain open");
        assert!(matches!(
            assetful
                .frames
                .borrow_and_update()
                .as_deref()
                .map(|frame| frame.frame.as_ref()),
            Some(ServerFrame::CompanionUnavailable { .. })
        ));
    }

    #[tokio::test]
    async fn companion_source_error_remains_publishable_during_asset_demand_upgrade() {
        let fixture = KspCompanionFixture::new("error-demand-upgrade");
        fixture.activate("session-1", "screen.html", &[0xff]);
        let resources = CompanionResources::default();
        let db_path = fixture.db_path.to_string_lossy().to_string();
        let mut assetless = resources.subscribe(db_path.clone(), "task-1".into(), false);
        tokio::time::timeout(Duration::from_secs(10), assetless.frames.changed())
            .await
            .expect("assetless source-error scan should finish")
            .expect("assetless source-error source should remain open");
        assert!(matches!(
            assetless
                .frames
                .borrow_and_update()
                .as_deref()
                .map(|frame| frame.frame.as_ref()),
            Some(ServerFrame::CompanionError {
                code,
                ..
            }) if code == "companion_invalid_document"
        ));

        let mut assetful = resources.subscribe(db_path, "task-1".into(), true);
        assert!(Arc::ptr_eq(&assetless._source, &assetful._source));
        if assetful.frames.borrow().is_some() {
            assetful.frames.mark_changed();
        }
        tokio::time::timeout(Duration::from_secs(2), assetful.frames.changed())
            .await
            .expect("assetful observer should promptly receive retained source error")
            .expect("assetful source-error source should remain open");
        assert!(matches!(
            assetful
                .frames
                .borrow_and_update()
                .as_deref()
                .map(|frame| frame.frame.as_ref()),
            Some(ServerFrame::CompanionError {
                code,
                ..
            }) if code == "companion_invalid_document"
        ));
    }

    #[tokio::test]
    async fn companion_demand_round_trips_do_not_clear_compatible_retained_frames() {
        let fixture = KspCompanionFixture::new("demand-round-trip");
        KspCompanionFixture::activate_maximum_bundle(&fixture.worktree, "session-1");
        let resources = CompanionResources::default();
        let db_path = fixture.db_path.to_string_lossy().to_string();
        let mut assetless = resources.subscribe(db_path.clone(), "task-1".into(), false);
        tokio::time::timeout(Duration::from_secs(10), assetless.frames.changed())
            .await
            .expect("initial assetless scan should finish")
            .expect("assetless source should remain open");
        {
            let retained = assetless.frames.borrow_and_update();
            assert!(matches!(
                retained.as_deref().map(|frame| frame.frame.as_ref()),
                Some(ServerFrame::CompanionSnapshot { assets, .. }) if assets.is_empty()
            ));
        }

        let transient_assetful = resources.subscribe(db_path.clone(), "task-1".into(), true);
        drop(transient_assetful);
        assert!(matches!(
            assetless
                .frames
                .borrow()
                .as_deref()
                .map(|frame| frame.frame.as_ref()),
            Some(ServerFrame::CompanionSnapshot { assets, .. }) if assets.is_empty()
        ));

        let mut assetful = resources.subscribe(db_path.clone(), "task-1".into(), true);
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                assetful
                    .frames
                    .changed()
                    .await
                    .expect("assetful source should remain open");
                let retained = assetful.frames.borrow_and_update();
                if matches!(
                    retained.as_deref().map(|frame| frame.frame.as_ref()),
                    Some(ServerFrame::CompanionSnapshot { assets, .. }) if assets.len() == 4
                ) {
                    return;
                }
            }
        })
        .await
        .expect("assetful demand should materialize the full bundle");
        drop(assetful);

        let replacement_assetful = resources.subscribe(db_path, "task-1".into(), true);
        assert!(matches!(
            replacement_assetful
                .frames
                .borrow()
                .as_deref()
                .map(|frame| frame.frame.as_ref()),
            Some(ServerFrame::CompanionSnapshot { assets, .. }) if assets.len() == 4
        ));
    }

    #[tokio::test]
    async fn assetful_companion_stream_skips_retained_assetless_snapshot_during_upgrade() {
        let fixture = KspCompanionFixture::new("stream-demand-upgrade");
        KspCompanionFixture::activate_maximum_bundle(&fixture.worktree, "session-1");
        let resources = CompanionResources::default();
        let db_path = fixture.db_path.to_string_lossy().to_string();
        let mut assetless = resources.subscribe(db_path.clone(), "task-1".into(), false);
        tokio::time::timeout(Duration::from_secs(10), assetless.frames.changed())
            .await
            .expect("initial assetless scan should finish")
            .expect("assetless source should remain open");
        assetless.frames.borrow_and_update();

        let (_frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(256);
        let assetful = resources.subscribe(db_path, "task-1".into(), true);
        let attachment = companion_tx.attachment("task-1".into(), true, true);
        let attachment_slot = resources
            .try_attachment()
            .expect("assetful stream attachment should be admitted");
        let stream = tokio::spawn(stream_companion(attachment, assetful, attachment_slot));

        let frame = tokio::time::timeout(
            Duration::from_secs(10),
            recv_reassembled_outbound(&mut outbound_rx),
        )
        .await
        .expect("assetful stream should receive upgraded snapshot")
        .expect("assetful stream should remain open");
        match frame {
            ServerFrame::CompanionSnapshot { assets, .. } => assert_eq!(
                assets.len(),
                4,
                "assetful stream published retained assetless snapshot during upgrade"
            ),
            other => panic!("unexpected assetful stream frame: {other:?}"),
        }
        stream.abort();
    }

    #[tokio::test]
    async fn retained_admission_rejection_does_not_rematerialize_unchanged_multi_source_bundles() {
        let fixture = KspCompanionFixture::new("retained-admission-retry");
        let second_worktree = fixture.add_task("task-2");
        let third_worktree = fixture.add_task("task-3");
        KspCompanionFixture::activate_maximum_bundle(&fixture.worktree, "session-1");
        KspCompanionFixture::activate_maximum_bundle(&second_worktree, "session-2");
        KspCompanionFixture::activate_maximum_bundle(&third_worktree, "session-3");

        let resources = CompanionResources::default();
        let db_path = fixture.db_path.to_string_lossy().to_string();
        let mut subscriptions = Vec::new();
        let mut snapshots = 0;
        let mut resource_errors = 0;
        let task_ids = ["task-1", "task-2", "task-3"];
        let mut rejected_index = None;
        for (index, task_id) in task_ids.into_iter().enumerate() {
            let mut subscription = resources.subscribe(db_path.clone(), task_id.to_string(), true);
            tokio::time::timeout(Duration::from_secs(10), subscription.frames.changed())
                .await
                .expect("companion source should finish its initial maximum-bundle scan")
                .expect("companion source should remain open");
            match subscription
                .frames
                .borrow_and_update()
                .as_deref()
                .map(|frame| frame.frame.as_ref())
            {
                Some(ServerFrame::CompanionSnapshot { .. }) => snapshots += 1,
                Some(ServerFrame::CompanionError { code, .. })
                    if code == "companion_resource_limit" =>
                {
                    resource_errors += 1;
                    rejected_index = Some(index);
                }
                other => panic!("unexpected retained-admission result: {other:?}"),
            }
            subscriptions.push(subscription);
        }
        assert_eq!(snapshots, 2);
        assert_eq!(resource_errors, 1);

        tokio::time::sleep(Duration::from_secs(3)).await;
        for task_id in task_ids {
            assert_eq!(
                changed_companion_scan_count(&db_path, task_id),
                1,
                "unchanged bundle for {task_id} was materialized more than once"
            );
        }

        let rejected_index = rejected_index.expect("one source should lose retained admission");
        let rejected_task_id = task_ids[rejected_index];
        let mut rejected = subscriptions.remove(rejected_index);
        drop(subscriptions.pop());
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                rejected
                    .frames
                    .changed()
                    .await
                    .expect("rejected companion source should remain open");
                if matches!(
                    rejected
                        .frames
                        .borrow_and_update()
                        .as_deref()
                        .map(|frame| frame.frame.as_ref()),
                    Some(ServerFrame::CompanionSnapshot { .. })
                ) {
                    return;
                }
            }
        })
        .await
        .expect("rejected source should retry when retained capacity is released");
        assert_eq!(
            changed_companion_scan_count(&db_path, rejected_task_id),
            2,
            "admission wakeup should trigger exactly one materialization retry"
        );
    }

    #[tokio::test]
    async fn rejected_companion_admission_retries_after_coalesced_asset_demand_churn() {
        let fixture = KspCompanionFixture::new("admission-demand-churn");
        let second_worktree = fixture.add_task("task-2");
        let third_worktree = fixture.add_task("task-3");
        KspCompanionFixture::activate_maximum_bundle(&fixture.worktree, "session-1");
        KspCompanionFixture::activate_maximum_bundle(&second_worktree, "session-2");
        KspCompanionFixture::activate_maximum_bundle(&third_worktree, "session-3");

        let resources = CompanionResources::default();
        let db_path = fixture.db_path.to_string_lossy().to_string();
        let mut first = resources.subscribe(db_path.clone(), "task-1".into(), true);
        tokio::time::timeout(Duration::from_secs(10), first.frames.changed())
            .await
            .expect("first maximum bundle should finish scanning")
            .expect("first maximum source should remain open");
        assert!(matches!(
            first
                .frames
                .borrow_and_update()
                .as_deref()
                .map(|frame| frame.frame.as_ref()),
            Some(ServerFrame::CompanionSnapshot { assets, .. }) if assets.len() == 4
        ));

        let mut second = resources.subscribe(db_path.clone(), "task-2".into(), true);
        tokio::time::timeout(Duration::from_secs(10), second.frames.changed())
            .await
            .expect("second maximum bundle should finish scanning")
            .expect("second maximum source should remain open");
        assert!(matches!(
            second
                .frames
                .borrow_and_update()
                .as_deref()
                .map(|frame| frame.frame.as_ref()),
            Some(ServerFrame::CompanionSnapshot { assets, .. }) if assets.len() == 4
        ));

        let mut third_assetless = resources.subscribe(db_path.clone(), "task-3".into(), false);
        tokio::time::timeout(Duration::from_secs(10), third_assetless.frames.changed())
            .await
            .expect("third assetless bundle should finish scanning")
            .expect("third source should remain open");
        assert!(matches!(
            third_assetless
                .frames
                .borrow_and_update()
                .as_deref()
                .map(|frame| frame.frame.as_ref()),
            Some(ServerFrame::CompanionSnapshot { assets, .. }) if assets.is_empty()
        ));

        let gate = install_companion_admission_demand_test_gate(&db_path, "task-3");
        let mut rejected = resources.subscribe(db_path.clone(), "task-3".into(), true);
        tokio::time::timeout(Duration::from_secs(10), rejected.frames.changed())
            .await
            .expect("third assetful scan should reach retained admission")
            .expect("rejected third source should remain open");
        assert!(matches!(
            rejected
                .frames
                .borrow_and_update()
                .as_deref()
                .map(|frame| frame.frame.as_ref()),
            Some(ServerFrame::CompanionError { code, .. })
                if code == "companion_resource_limit"
        ));

        drop(rejected);
        let mut replacement = resources.subscribe(db_path, "task-3".into(), true);
        tokio::time::timeout(Duration::from_secs(10), gate.wait_until_blocked())
            .await
            .expect("rejected source should observe coalesced asset-demand churn");

        drop(second);
        gate.release();

        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                replacement
                    .frames
                    .changed()
                    .await
                    .expect("replacement assetful source should remain open");
                if matches!(
                    replacement
                        .frames
                        .borrow_and_update()
                        .as_deref()
                        .map(|frame| frame.frame.as_ref()),
                    Some(ServerFrame::CompanionSnapshot { assets, .. }) if assets.len() == 4
                ) {
                    return;
                }
            }
        })
        .await
        .expect("rejected source should retry after capacity release despite demand churn");
    }

    #[tokio::test]
    async fn companion_outbound_rejects_a_publisher_invalidated_by_reattach() {
        let (_frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(256);
        let snapshot = |revision: &str| ServerFrame::CompanionSnapshot {
            task_id: "task-1".into(),
            session_id: "session-1".into(),
            revision: revision.into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: format!("<p>{revision}</p>"),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        };

        let old_attachment = companion_tx.attachment("task-1".into(), true, true);
        assert!(old_attachment.publish(snapshot("revision-1")));
        assert!(matches!(
            recv_reassembled_outbound(&mut outbound_rx).await,
            Some(ServerFrame::CompanionSnapshot { revision, .. }) if revision == "revision-1"
        ));

        let current_attachment = companion_tx.attachment("task-1".into(), true, true);
        assert!(
            !old_attachment.publish(snapshot("stale-revision")),
            "a publisher resumed after re-attach must be rejected"
        );
        assert!(current_attachment.publish(snapshot("current-revision")));
        assert!(matches!(
            recv_reassembled_outbound(&mut outbound_rx).await,
            Some(ServerFrame::CompanionSnapshot { revision, .. }) if revision == "current-revision"
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(25), outbound_rx.recv())
                .await
                .is_err(),
            "the invalidated attachment must not repopulate the pending slot"
        );
    }

    #[tokio::test]
    async fn companion_attach_streams_latest_transitions_and_detaches() {
        let fixture = KspCompanionFixture::new("attach");
        fixture.activate("123-456", "first.html", b"<h2>First</h2>");
        fixture.server_info("123-456", br#"{"url":"http://localhost:52341"}"#);
        fixture.content("123-456", "layout.png", b"PNG");
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: Some(true),
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;

        let first_revision = match recv_frame(&mut socket).await {
            ServerFrame::CompanionSnapshot {
                task_id,
                session_id,
                revision,
                document_kind,
                html,
                source_origin,
                assets,
                ..
            } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(session_id, "123-456");
                assert_eq!(document_kind, CompanionDocumentKind::Fragment);
                assert_eq!(html, "<h2>First</h2>");
                assert_eq!(source_origin.as_deref(), Some("http://localhost:52341"));
                assert_eq!(assets.len(), 1);
                assert_eq!(assets[0].name, "layout.png");
                assert_eq!(assets[0].content_type, "image/png");
                assert_eq!(
                    assets[0].digest,
                    "796120837694d3f3f29259cfeb25091698c2a0aa87873658d840b4993ee889b3"
                );
                assert_eq!(assets[0].data_b64, "UE5H");
                revision
            }
            other => panic!("expected companion snapshot, got {other:?}"),
        };

        std::thread::sleep(Duration::from_millis(15));
        fixture.activate("123-456", "second.html", b"<h2>Second</h2>");
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionSnapshot { revision, html, .. } => {
                assert_ne!(revision, first_revision);
                assert_eq!(html, "<h2>Second</h2>");
            }
            other => panic!("expected updated companion snapshot, got {other:?}"),
        }
        assert_eq!(
            recv_frame_with_timeout(&mut socket, Duration::from_millis(650)).await,
            None,
            "unchanged content must not produce duplicate snapshots"
        );

        let replacement = fixture.temp_dir.path().join("replacement");
        std::fs::create_dir_all(&replacement).unwrap();
        Db::open(fixture.db_path.to_str().unwrap())
            .unwrap()
            .upsert_worktree(
                "wt-task-1",
                "task-1",
                replacement.to_str().unwrap(),
                "replacement",
            )
            .unwrap();
        assert_eq!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionUnavailable {
                task_id: "task-1".into(),
                attachment_epoch: None,
            }
        );

        send_frame(
            &mut socket,
            &ClientFrame::Detach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                attachment_epoch: None,
            },
        )
        .await;
        Db::open(fixture.db_path.to_str().unwrap())
            .unwrap()
            .upsert_worktree(
                "wt-task-1",
                "task-1",
                fixture.worktree.to_str().unwrap(),
                "task-1",
            )
            .unwrap();
        assert_eq!(
            recv_frame_with_timeout(&mut socket, Duration::from_millis(650)).await,
            None,
            "detached companions must stop sending updates"
        );
    }

    #[tokio::test]
    async fn fenced_companion_send_cancelled_by_epoch_bump_keeps_the_connection_alive() {
        let fixture = KspCompanionFixture::new("epoch-bump-blocked-send");
        fixture.activate("123-456", "first.html", b"<h2>Blocked</h2>");
        fixture.server_info("123-456", br#"{"url":"http://localhost:52341"}"#);
        // One maximum-size asset makes the epoch-1 snapshot far larger than
        // loopback socket buffering, so its send parks on TCP backpressure
        // while the client is not reading.
        fixture.content(
            "123-456",
            "large.png",
            &vec![0_u8; kanna_visual_companion::MAX_COMPANION_ASSET_BYTES as usize],
        );
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: Some(true),
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(1),
            },
        )
        .await;
        // Let the writer start (and block on) the oversized epoch-1 send.
        tokio::time::sleep(Duration::from_millis(300)).await;

        // Detach + re-attach bumps the attachment epoch, cancelling the
        // parked fenced send. The connection must survive that cancellation.
        send_frame(
            &mut socket,
            &ClientFrame::Detach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                attachment_epoch: Some(1),
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: Some(false),
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(2),
            },
        )
        .await;

        // Resume reading. Any partially buffered epoch-1 frame is harmless —
        // the client fences by epoch — but the epoch-2 snapshot has to arrive,
        // proving the writer kept the socket alive.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            assert!(
                tokio::time::Instant::now() < deadline,
                "epoch-2 snapshot never arrived after the fenced send was cancelled"
            );
            match recv_frame_with_timeout(&mut socket, Duration::from_secs(20)).await {
                Some(ServerFrame::CompanionSnapshot {
                    attachment_epoch: Some(2),
                    ..
                }) => break,
                Some(_) => continue,
                None => panic!("connection went silent after the fenced send was cancelled"),
            }
        }

        // Request traffic must also still flow on the same connection.
        send_frame(
            &mut socket,
            &ClientFrame::Request {
                id: 9,
                method: "GET".into(),
                path: "/v1/tasks".into(),
                body: None,
            },
        )
        .await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            assert!(
                tokio::time::Instant::now() < deadline,
                "request went unanswered after the fenced send was cancelled"
            );
            match recv_frame_with_timeout(&mut socket, Duration::from_secs(10)).await {
                Some(ServerFrame::Response { id: 9, .. }) => break,
                Some(_) => continue,
                None => panic!("connection went silent before answering the request"),
            }
        }
    }

    #[tokio::test]
    async fn legacy_attach_without_asset_opt_in_gets_an_assetless_snapshot() {
        let fixture = KspCompanionFixture::new("legacy-assetless-default");
        KspCompanionFixture::activate_maximum_bundle(&fixture.worktree, "123-456");
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &legacy_client_auth_frame()).await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::AuthOk { .. }
        ));
        // A pre-asset client names neither include_assets nor
        // accept_snapshot_chunks; it must never be handed the maximum
        // assetful bundle in one unchunked frame.
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionSnapshot { html, assets, .. } => {
                assert_eq!(
                    html.len(),
                    kanna_visual_companion::MAX_COMPANION_HTML_BYTES as usize
                );
                assert!(
                    assets.is_empty(),
                    "a client that did not opt into assets must not receive them"
                );
            }
            other => panic!("expected an assetless companion snapshot, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn auth_with_unknown_capability_still_authenticates() {
        let state = Arc::new(crate::http_api::AppState::new(test_config(
            "ksp-unknown-capability",
            "KSP Unknown Capability",
        )));
        let (incoming_tx, incoming_rx) = mpsc::channel(8);
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let task = tokio::spawn(handle_stream_channels(
            incoming_rx,
            frame_tx,
            companion_tx,
            state,
            AuthMode::AllowEmpty,
            true,
        ));

        // A future client may advertise capabilities this build has never
        // heard of; one unknown string must not fail the whole Auth frame.
        incoming_tx
            .send(
                serde_json::json!({
                    "type": "auth",
                    "capabilities": ["companion_event_epoch", "capability_from_the_future"],
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert_eq!(outbound_rx.recv().await, Some(auth_ok_frame()));
        drop(incoming_tx);
        let _ = task.await;
    }

    #[tokio::test]
    async fn companion_attachment_epochs_fence_outputs_and_stale_detach() {
        let fixture = KspCompanionFixture::new("attachment-epochs");
        fixture.activate("session-epoch", "first.html", b"<h2>First</h2>");
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());

        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(1),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(1),
                ..
            }
        ));

        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(true),
                attachment_epoch: Some(2),
            },
        )
        .await;
        let replacement_chunk = recv_frame_with_timeout(&mut socket, Duration::from_secs(5))
            .await
            .expect("replacement attachment snapshot");
        let ServerFrame::CompanionSnapshotChunk {
            count,
            data,
            attachment_epoch,
            ..
        } = replacement_chunk
        else {
            panic!("expected replacement companion chunk");
        };
        assert_eq!(attachment_epoch, Some(2));
        assert_eq!(count, 1);
        assert!(matches!(
            serde_json::from_str::<ServerFrame>(&data).unwrap(),
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(2),
                ..
            }
        ));

        send_frame(
            &mut socket,
            &ClientFrame::Detach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                attachment_epoch: Some(1),
            },
        )
        .await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(
            recv_frame(&mut socket).await,
            auth_ok_frame(),
            "AuthOk is the processing barrier for the stale detach"
        );
        fixture.activate("session-epoch", "second.html", b"<h2>Second</h2>");
        assert!(matches!(
            recv_frame_with_timeout(&mut socket, Duration::from_secs(5)).await,
            Some(ServerFrame::CompanionSnapshotChunk {
                attachment_epoch: Some(2),
                ..
            })
        ));
    }

    #[tokio::test]
    async fn default_lan_bind_cannot_serve_companion_document_without_pairing() {
        let mut fixture = KspCompanionFixture::new("default-lan-unpaired");
        fixture.config.lan_host = "0.0.0.0".into();
        fixture.activate("123-456", "secret.html", b"<h2>Secret companion</h2>");
        fixture.content("123-456", "secret.png", b"SECRET");
        let url = fixture.serve().await;
        let mut socket = ws_connect_unpaired(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: Some(false),
                accept_snapshot_chunks: Some(true),
                attachment_epoch: None,
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::Error { code, message, .. }
                if code == "unauthorized" && message.contains("paired-device")
        ));
    }

    #[tokio::test]
    async fn previous_mobile_rest_auth_cookie_preserves_new_server_companion_access() {
        let mut fixture = KspCompanionFixture::new("previous-mobile-cookie");
        fixture.config.desktop_secret = None;
        fixture.activate("123-456", "screen.html", b"<h2>Companion</h2>");
        let url = fixture.serve().await;
        let status_url = url
            .replacen("ws://", "http://", 1)
            .replace("/v1/stream", "/v1/status");
        let response = reqwest::Client::new()
            .get(status_url)
            .header("x-kanna-device-id", TEST_DEVICE_ID)
            .header("x-kanna-device-secret", TEST_DEVICE_SECRET)
            .send()
            .await
            .expect("previous mobile paired REST request");
        assert!(response.status().is_success());
        let set_cookie = response
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .expect("paired REST response must bootstrap stream compatibility")
            .to_str()
            .expect("compatibility cookie text");
        let cookie = set_cookie
            .split(';')
            .next()
            .expect("compatibility cookie pair");

        let mut socket = ws_connect_with_cookie(&url, cookie).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());
    }

    #[tokio::test]
    async fn companion_origin_only_changes_publish_same_revision() {
        let fixture = KspCompanionFixture::new("origin-only");
        fixture.activate("123-456", "screen.html", b"<h2>Screen</h2>");
        fixture.server_info("123-456", br#"{"url":"http://localhost:52341"}"#);
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;

        let initial_revision = match recv_frame(&mut socket).await {
            ServerFrame::CompanionSnapshot {
                revision,
                source_origin,
                ..
            } => {
                assert_eq!(source_origin.as_deref(), Some("http://localhost:52341"));
                revision
            }
            other => panic!("expected initial companion snapshot, got {other:?}"),
        };

        std::thread::sleep(Duration::from_millis(15));
        fixture.server_info("123-456", br#"{"url":"http://localhost:52342"}"#);
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionSnapshot {
                revision,
                source_origin,
                ..
            } => {
                assert_eq!(revision, initial_revision);
                assert_eq!(source_origin.as_deref(), Some("http://localhost:52342"));
            }
            other => panic!("expected changed-origin companion snapshot, got {other:?}"),
        }

        std::thread::sleep(Duration::from_millis(15));
        fixture.server_info("123-456", b"{}");
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionSnapshot {
                revision,
                source_origin,
                ..
            } => {
                assert_eq!(revision, initial_revision);
                assert_eq!(source_origin, None);
            }
            other => panic!("expected removed-origin companion snapshot, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn companion_attach_reports_unavailable_and_invalid_source_specifically() {
        let fixture = KspCompanionFixture::new("unavailable");
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;
        assert_eq!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionUnavailable {
                task_id: "task-1".into(),
                attachment_epoch: None,
            }
        );

        fixture.activate("invalid", "layout.html", &[0xff, 0xfe]);
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionError {
                task_id,
                code,
                message,
                ..
            } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(code, "companion_invalid_document");
                assert_eq!(
                    message,
                    "The visual companion is not valid UTF-8 HTML. Ask the agent to recreate the screen."
                );
            }
            other => panic!("expected task-scoped companion error, got {other:?}"),
        }

        fixture.activate("invalid", "layout.html", b"<h2>Recovered</h2>");
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionSnapshot { html, .. } => {
                assert_eq!(html, "<h2>Recovered</h2>");
            }
            other => panic!("expected recovered companion snapshot, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn companion_attach_reports_oversized_source_specifically() {
        let fixture = KspCompanionFixture::new("oversized");
        fixture.activate(
            "large",
            "layout.html",
            &vec![b'x'; kanna_visual_companion::MAX_COMPANION_HTML_BYTES as usize + 1],
        );
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;

        assert_eq!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionError {
                task_id: "task-1".into(),
                code: "companion_too_large".into(),
                message: "The visual companion is too large. Ask the agent to simplify the screen."
                    .into(),
                attachment_epoch: None,
            }
        );
    }

    #[test]
    fn companion_source_errors_keep_internal_details_private() {
        for error in [
            kanna_visual_companion::CompanionError::WorkspaceUnavailable,
            kanna_visual_companion::CompanionError::Internal(
                "failed to read /private/worktree/secret.html".into(),
            ),
        ] {
            assert_eq!(
                companion_source_error(&error),
                (
                    "companion_source_failed",
                    "The visual companion could not be read."
                )
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_companion_event_append_result_keeps_submitted_attachment_epoch() {
        let fixture = KspCompanionFixture::new("event-epoch-blocked-append");
        fixture.activate(
            "session-1",
            "layout.html",
            b"<button data-choice='a'>A</button>",
        );
        let document =
            crate::visual_companion::current_bundle(fixture.db_path.to_str().unwrap(), "task-1")
                .unwrap()
                .unwrap();
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());

        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(1),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(1),
                ..
            }
        ));

        let append_gate = install_companion_append_test_gate("epoch-blocked-append");
        let mut event = KspCompanionFixture::event("epoch-blocked-append");
        event.session_id = document.session_id.clone();
        event.revision = document.revision.clone();
        send_frame(
            &mut socket,
            &ClientFrame::CompanionEvent {
                task_id: "task-1".into(),
                session_id: document.session_id.clone(),
                revision: document.revision.clone(),
                attachment_epoch: Some(1),
                event,
            },
        )
        .await;
        tokio::time::timeout(Duration::from_secs(1), append_gate.wait_until_blocked())
            .await
            .expect("companion append did not reach the blocked worker");

        send_frame(
            &mut socket,
            &ClientFrame::Detach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                attachment_epoch: Some(1),
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(2),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(2),
                ..
            }
        ));

        append_gate.release();
        drop(append_gate);
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionEventResult {
                event_id,
                attachment_epoch: Some(1),
                ..
            } if event_id == "epoch-blocked-append"
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_companion_event_ack_result_keeps_submitted_attachment_epoch() {
        let fixture = KspCompanionFixture::new("event-epoch-blocked-ack");
        fixture.activate(
            "session-1",
            "layout.html",
            b"<button data-choice='a'>A</button>",
        );
        let document =
            crate::visual_companion::current_bundle(fixture.db_path.to_str().unwrap(), "task-1")
                .unwrap()
                .unwrap();
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());

        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(1),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(1),
                ..
            }
        ));

        let ack_gate = install_companion_ack_test_gate("epoch-blocked-ack");
        let mut event = KspCompanionFixture::event("epoch-blocked-ack");
        event.session_id = document.session_id.clone();
        event.revision = document.revision.clone();
        send_frame(
            &mut socket,
            &ClientFrame::CompanionEvent {
                task_id: "task-1".into(),
                session_id: document.session_id.clone(),
                revision: document.revision.clone(),
                attachment_epoch: Some(1),
                event,
            },
        )
        .await;
        tokio::time::timeout(Duration::from_secs(1), ack_gate.wait_until_blocked())
            .await
            .expect("companion acknowledgement did not reach the blocked worker");

        send_frame(
            &mut socket,
            &ClientFrame::Detach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                attachment_epoch: Some(1),
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(2),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(2),
                ..
            }
        ));

        ack_gate.release();
        drop(ack_gate);
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionEventResult {
                event_id,
                attachment_epoch: Some(1),
                ..
            } if event_id == "epoch-blocked-ack"
        ));
    }

    #[tokio::test]
    async fn companion_event_accepts_legacy_epoch_omission_but_rejects_mismatches() {
        let fixture = KspCompanionFixture::new("event-stale-attachment");
        fixture.activate(
            "session-1",
            "layout.html",
            b"<button data-choice='a'>A</button>",
        );
        let document =
            crate::visual_companion::current_bundle(fixture.db_path.to_str().unwrap(), "task-1")
                .unwrap()
                .unwrap();
        let events_path = fixture
            .worktree
            .join(".superpowers/brainstorm")
            .join(&document.session_id)
            .join("state/events");
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &legacy_client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());

        let event_frame = |event_id: &str, attachment_epoch| {
            let mut event = KspCompanionFixture::event(event_id);
            event.session_id = document.session_id.clone();
            event.revision = document.revision.clone();
            ClientFrame::CompanionEvent {
                task_id: "task-1".into(),
                session_id: document.session_id.clone(),
                revision: document.revision.clone(),
                attachment_epoch,
                event,
            }
        };

        send_frame(&mut socket, &event_frame("missing-attachment", Some(1))).await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionEventResult {
                event_id,
                accepted: false,
                code: Some(code),
                message: Some(message),
                attachment_epoch: Some(1),
                ..
            } if event_id == "missing-attachment"
                && code == "companion_stale_attachment"
                && message.contains("Reopen or refresh")
        ));

        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(1),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(1),
                ..
            }
        ));

        send_frame(&mut socket, &event_frame("stale-attachment", Some(2))).await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionEventResult {
                event_id,
                accepted: false,
                code: Some(code),
                attachment_epoch: Some(2),
                ..
            } if event_id == "stale-attachment" && code == "companion_stale_attachment"
        ));
        send_frame(&mut socket, &event_frame("legacy-on-modern", None)).await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionEventResult {
                event_id,
                accepted: true,
                code: None,
                attachment_epoch: None,
                ..
            } if event_id == "legacy-on-modern"
        ));
        assert_eq!(
            std::fs::read_to_string(&events_path)
                .map(|events| events.lines().count())
                .unwrap_or(0),
            1,
            "the legacy event must append while stale attachment events remain fenced"
        );

        send_frame(
            &mut socket,
            &ClientFrame::Detach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                attachment_epoch: Some(1),
            },
        )
        .await;
        // A legacy client re-sends attach on every companion modal reopen; a
        // detach-then-attach lifecycle must continue on the same connection.
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(2),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(2),
                ..
            }
        ));
        send_frame(&mut socket, &event_frame("legacy-after-replacement", None)).await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionEventResult {
                event_id,
                accepted: true,
                attachment_epoch: None,
                ..
            } if event_id == "legacy-after-replacement"
        ));
        assert_eq!(
            std::fs::read_to_string(&events_path)
                .map(|events| events.lines().count())
                .unwrap_or(0),
            2,
            "an un-epoched event on the re-attached lifecycle must append"
        );
    }

    #[tokio::test]
    async fn legacy_companion_direct_replacement_recovers_on_a_fresh_connection() {
        let fixture = KspCompanionFixture::new("legacy-event-reconnect");
        fixture.activate(
            "session-1",
            "layout.html",
            b"<button data-choice='a'>A</button>",
        );
        let document =
            crate::visual_companion::current_bundle(fixture.db_path.to_str().unwrap(), "task-1")
                .unwrap()
                .unwrap();
        let events_path = fixture
            .worktree
            .join(".superpowers/brainstorm")
            .join(&document.session_id)
            .join("state/events");
        let url = fixture.serve().await;
        let attach = |attachment_epoch| ClientFrame::Attach {
            task_id: "task-1".into(),
            kind: StreamKind::Companion,
            from_seq: 0,
            include_assets: None,
            accept_snapshot_chunks: Some(false),
            attachment_epoch: Some(attachment_epoch),
        };

        let mut first = ws_connect(&url).await;
        send_frame(&mut first, &legacy_client_auth_frame()).await;
        assert_eq!(recv_frame(&mut first).await, auth_ok_frame());
        send_frame(&mut first, &attach(1)).await;
        assert!(matches!(
            recv_frame(&mut first).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(1),
                ..
            }
        ));

        send_frame(&mut first, &attach(2)).await;
        let mut stale_event = KspCompanionFixture::event("legacy-stale-replacement");
        stale_event.session_id = document.session_id.clone();
        stale_event.revision = document.revision.clone();
        send_frame(
            &mut first,
            &ClientFrame::CompanionEvent {
                task_id: "task-1".into(),
                session_id: document.session_id.clone(),
                revision: document.revision.clone(),
                attachment_epoch: None,
                event: stale_event,
            },
        )
        .await;
        match recv_frame_with_timeout(&mut first, Duration::from_secs(5)).await {
            Some(ServerFrame::Error { code, .. }) => {
                assert_eq!(
                    code, "companion_attach_rejected",
                    "direct replacement must be announced before the retire"
                );
            }
            other => panic!(
                "direct replacement from a legacy client must retire the connection \
                 with an error frame, got {other:?}"
            ),
        }
        assert!(
            recv_frame_with_timeout(&mut first, Duration::from_secs(1))
                .await
                .is_none(),
            "direct replacement from a legacy client must retire the connection"
        );
        assert_eq!(
            std::fs::read_to_string(&events_path)
                .map(|events| events.lines().count())
                .unwrap_or(0),
            0,
            "a stale legacy event queued behind direct replacement must not append"
        );

        let mut retry = ws_connect(&url).await;
        send_frame(&mut retry, &legacy_client_auth_frame()).await;
        assert_eq!(recv_frame(&mut retry).await, auth_ok_frame());
        send_frame(&mut retry, &attach(2)).await;
        assert!(matches!(
            recv_frame(&mut retry).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(2),
                ..
            }
        ));

        let mut event = KspCompanionFixture::event("legacy-after-reconnect");
        event.session_id = document.session_id.clone();
        event.revision = document.revision.clone();
        send_frame(
            &mut retry,
            &ClientFrame::CompanionEvent {
                task_id: "task-1".into(),
                session_id: document.session_id,
                revision: document.revision,
                attachment_epoch: None,
                event,
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut retry).await,
            ServerFrame::CompanionEventResult {
                event_id,
                accepted: true,
                attachment_epoch: None,
                ..
            } if event_id == "legacy-after-reconnect"
        ));
        assert_eq!(
            std::fs::read_to_string(&events_path)
                .map(|events| events.lines().count())
                .unwrap_or(0),
            1,
            "the fresh connection must accept its first legacy lifecycle"
        );
    }

    #[tokio::test]
    async fn companion_events_acknowledge_append_validation_and_connection_rate_limit() {
        let fixture = KspCompanionFixture::new("events");
        fixture.activate(
            "123-456",
            "layout.html",
            b"<button data-choice='a'>A</button>",
        );
        let document =
            crate::visual_companion::current_bundle(fixture.db_path.to_str().unwrap(), "task-1")
                .unwrap()
                .unwrap();
        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(1),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(1),
                ..
            }
        ));

        let send_event = |mut event: CompanionEvent, session_id: String, revision: String| {
            event.session_id = session_id.clone();
            event.revision = revision.clone();
            ClientFrame::CompanionEvent {
                task_id: "task-1".into(),
                session_id,
                revision,
                attachment_epoch: Some(1),
                event,
            }
        };
        send_frame(
            &mut socket,
            &send_event(
                KspCompanionFixture::event("accepted"),
                document.session_id.clone(),
                document.revision.clone(),
            ),
        )
        .await;
        assert_eq!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionEventResult {
                task_id: "task-1".into(),
                session_id: Some(document.session_id.clone()),
                revision: Some(document.revision.clone()),
                event_id: "accepted".into(),
                accepted: true,
                code: None,
                message: None,
                attachment_epoch: Some(1),
            }
        );

        send_frame(
            &mut socket,
            &send_event(
                KspCompanionFixture::event("stale"),
                document.session_id.clone(),
                "old-revision".into(),
            ),
        )
        .await;
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionEventResult {
                event_id,
                accepted,
                code,
                attachment_epoch,
                ..
            } => {
                assert_eq!(event_id, "stale");
                assert!(!accepted);
                assert_eq!(code.as_deref(), Some("companion_stale_revision"));
                assert_eq!(attachment_epoch, Some(1));
            }
            other => panic!("expected stale event result, got {other:?}"),
        }

        let mut invalid = KspCompanionFixture::event("invalid");
        invalid.choice.clear();
        send_frame(
            &mut socket,
            &send_event(
                invalid,
                document.session_id.clone(),
                document.revision.clone(),
            ),
        )
        .await;
        match recv_frame(&mut socket).await {
            ServerFrame::CompanionEventResult {
                code,
                attachment_epoch,
                ..
            } => {
                assert_eq!(code.as_deref(), Some("companion_invalid_event"));
                assert_eq!(attachment_epoch, Some(1));
            }
            other => panic!("expected invalid event result, got {other:?}"),
        }

        let mut rate_socket = ws_connect(&url).await;
        send_frame(&mut rate_socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut rate_socket).await, auth_ok_frame());
        send_frame(
            &mut rate_socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(1),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut rate_socket).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(1),
                ..
            }
        ));
        for index in 0..30 {
            let event_id = format!("rate-{index}");
            send_frame(
                &mut rate_socket,
                &send_event(
                    KspCompanionFixture::event(&event_id),
                    document.session_id.clone(),
                    document.revision.clone(),
                ),
            )
            .await;
            match recv_frame(&mut rate_socket).await {
                ServerFrame::CompanionEventResult {
                    accepted,
                    attachment_epoch,
                    ..
                } => {
                    assert!(accepted);
                    assert_eq!(attachment_epoch, Some(1));
                }
                other => panic!("expected accepted rate event, got {other:?}"),
            }
        }
        send_frame(
            &mut rate_socket,
            &send_event(
                KspCompanionFixture::event("rate-limited"),
                document.session_id,
                document.revision,
            ),
        )
        .await;
        match recv_frame(&mut rate_socket).await {
            ServerFrame::CompanionEventResult {
                accepted,
                code,
                attachment_epoch,
                ..
            } => {
                assert!(!accepted);
                assert_eq!(code.as_deref(), Some("companion_rate_limited"));
                assert_eq!(attachment_epoch, Some(1));
            }
            other => panic!("expected rate-limited result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn companion_event_retry_after_lost_ack_is_durably_idempotent() {
        let fixture = KspCompanionFixture::new("event-lost-ack");
        fixture.activate(
            "123-456",
            "layout.html",
            b"<button data-choice='a'>A</button>",
        );
        let document =
            crate::visual_companion::current_bundle(fixture.db_path.to_str().unwrap(), "task-1")
                .unwrap()
                .unwrap();
        let events_path = fixture
            .worktree
            .join(".superpowers/brainstorm")
            .join(&document.session_id)
            .join("state/events");
        let mut event = KspCompanionFixture::event("lost-ack");
        event.session_id = document.session_id.clone();
        event.revision = document.revision.clone();
        let frame = ClientFrame::CompanionEvent {
            task_id: "task-1".into(),
            session_id: document.session_id.clone(),
            revision: document.revision.clone(),
            attachment_epoch: Some(1),
            event: event.clone(),
        };
        let url = fixture.serve().await;
        let ack_gate = install_companion_ack_test_gate("lost-ack");

        let mut first = ws_connect(&url).await;
        send_frame(&mut first, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut first).await, auth_ok_frame());
        send_frame(
            &mut first,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(1),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut first).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(1),
                ..
            }
        ));
        send_frame(&mut first, &frame).await;
        tokio::time::timeout(Duration::from_secs(1), ack_gate.wait_until_blocked())
            .await
            .expect("server must block after append and before acknowledgement");
        assert_eq!(
            std::fs::read_to_string(&events_path)
                .expect("first send must append before transport drop")
                .lines()
                .count(),
            1
        );
        drop(first);
        ack_gate.release();
        drop(ack_gate);

        let mut retry = ws_connect(&url).await;
        send_frame(&mut retry, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut retry).await, auth_ok_frame());
        send_frame(
            &mut retry,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(2),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut retry).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(2),
                ..
            }
        ));
        send_frame(
            &mut retry,
            &ClientFrame::CompanionEvent {
                task_id: "task-1".into(),
                session_id: document.session_id.clone(),
                revision: document.revision.clone(),
                attachment_epoch: Some(2),
                event: event.clone(),
            },
        )
        .await;
        assert_eq!(
            recv_frame(&mut retry).await,
            ServerFrame::CompanionEventResult {
                task_id: "task-1".into(),
                session_id: Some(document.session_id),
                revision: Some(document.revision),
                event_id: event.event_id,
                accepted: true,
                code: None,
                message: None,
                attachment_epoch: Some(2),
            }
        );
        let contents = std::fs::read_to_string(events_path).unwrap();
        assert_eq!(contents.lines().count(), 1);
    }

    fn companion_event_conn_with_worker(
        test_name: &str,
        worker: CompanionEventWorker,
    ) -> (StreamConn, OutboundFrameReceiver) {
        let state = Arc::new(AppState::new(test_config(test_name, "Companion Event")));
        let (frame_tx, companion_tx, outbound_rx) = outbound_frame_channel(8);
        (
            StreamConn {
                state,
                frame_tx,
                companion_tx,
                attachments: HashMap::new(),
                terminal_controls: HashMap::new(),
                terminal_inputs: HashMap::new(),
                agent_commands: None,
                requests: None,
                companion_events: Some(worker),
                authed: true,
                supports_companion_event_epoch: false,
                legacy_companion_tasks_on_connection: HashSet::new(),
                auth_mode: AuthMode::AllowEmpty,
                companion_access: true,
            },
            outbound_rx,
        )
    }

    #[tokio::test]
    async fn companion_event_queue_full_result_keeps_submitted_attachment_epoch() {
        let (tx, request_rx) = mpsc::channel(1);
        tx.try_send(CompanionEventRequest {
            task_id: "task-queued".into(),
            session_id: "session-queued".into(),
            revision: "revision-queued".into(),
            attachment_epoch: None,
            event: KspCompanionFixture::event("already-queued"),
        })
        .unwrap();
        let task = tokio::spawn(async move {
            let _request_rx = request_rx;
            std::future::pending::<()>().await;
        });
        let (mut conn, mut outbound_rx) = companion_event_conn_with_worker(
            "event-queue-full-epoch",
            CompanionEventWorker { tx, task },
        );

        conn.enqueue_companion_event(
            "task-1".into(),
            "session-1".into(),
            "revision-1".into(),
            Some(7),
            KspCompanionFixture::event("queue-full"),
        )
        .await;

        assert!(matches!(
            outbound_rx.recv().await,
            Some(ServerFrame::CompanionEventResult {
                event_id,
                accepted: false,
                code: Some(code),
                attachment_epoch: Some(7),
                ..
            }) if event_id == "queue-full" && code == "companion_event_busy"
        ));
        conn.shutdown().await;
    }

    #[tokio::test]
    async fn companion_event_worker_closed_result_keeps_submitted_attachment_epoch() {
        let (tx, request_rx) = mpsc::channel(1);
        drop(request_rx);
        let task = tokio::spawn(std::future::pending::<()>());
        let (mut conn, mut outbound_rx) = companion_event_conn_with_worker(
            "event-worker-closed-epoch",
            CompanionEventWorker { tx, task },
        );

        conn.enqueue_companion_event(
            "task-1".into(),
            "session-1".into(),
            "revision-1".into(),
            Some(9),
            KspCompanionFixture::event("worker-closed"),
        )
        .await;

        assert!(matches!(
            outbound_rx.recv().await,
            Some(ServerFrame::CompanionEventResult {
                event_id,
                accepted: false,
                code: Some(code),
                attachment_epoch: Some(9),
                ..
            }) if event_id == "worker-closed" && code == "companion_event_failed"
        ));
        conn.shutdown().await;
    }

    #[tokio::test]
    async fn invalid_companion_identities_do_not_allocate_rate_limiter_keys() {
        let fixture = KspCompanionFixture::new("invalid-rate-limit-identities");
        fixture.activate(
            "active-session",
            "layout.html",
            b"<button data-choice='a'>A</button>",
        );
        let state = Arc::new(AppState::new(fixture.config.clone()));
        let document =
            crate::visual_companion::current_bundle(fixture.db_path.to_str().unwrap(), "task-1")
                .unwrap()
                .unwrap();
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(256);
        let mut conn = StreamConn {
            state,
            frame_tx,
            companion_tx,
            attachments: HashMap::new(),
            terminal_controls: HashMap::new(),
            terminal_inputs: HashMap::new(),
            agent_commands: None,
            requests: None,
            companion_events: None,
            authed: true,
            supports_companion_event_epoch: false,
            legacy_companion_tasks_on_connection: HashSet::new(),
            auth_mode: AuthMode::AllowEmpty,
            companion_access: true,
        };

        for index in 0..128 {
            let session_id = format!("invalid-session-{index}");
            let revision = "invalid-revision".to_string();
            let mut event = KspCompanionFixture::event(&format!("invalid-{index}"));
            event.session_id = session_id.clone();
            event.revision = revision.clone();
            conn.enqueue_companion_event("task-1".into(), session_id, revision, None, event)
                .await;
            assert!(matches!(
                outbound_rx.recv().await,
                Some(ServerFrame::CompanionEventResult {
                    accepted: false,
                    ..
                })
            ));
        }
        let mut valid = KspCompanionFixture::event("valid-after-invalid-identities");
        valid.session_id = document.session_id.clone();
        valid.revision = document.revision.clone();
        conn.enqueue_companion_event(
            "task-1".into(),
            document.session_id,
            document.revision,
            None,
            valid,
        )
        .await;
        assert!(matches!(
            outbound_rx.recv().await,
            Some(ServerFrame::CompanionEventResult { accepted: true, .. })
        ));
        conn.shutdown().await;
    }

    #[tokio::test]
    async fn maximum_companion_scan_does_not_block_terminal_output_for_a_poll_interval() {
        let mut fixture = KspCompanionFixture::new("terminal-responsive");
        let mut html = vec![b'x'; kanna_visual_companion::MAX_COMPANION_HTML_BYTES as usize];
        html[..11].copy_from_slice(b"<h2>Busy</h");
        fixture.activate("123-456", "layout.html", &html);

        let daemon_dir = fixture.temp_dir.path().join("daemon");
        std::fs::create_dir_all(&daemon_dir).unwrap();
        fixture.config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        let socket_path = daemon_socket_path_for_dir(&fixture.config.daemon_dir);
        let daemon_listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
        let daemon = tokio::spawn(async move {
            let (stream, _) = daemon_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: DaemonCommand = serde_json::from_str(line.trim()).unwrap();
            assert!(matches!(command, DaemonCommand::AttachSnapshot { .. }));
            let snapshot = DaemonEvent::Snapshot {
                session_id: "daemon-terminal-1".into(),
                snapshot: kanna_daemon::protocol::TerminalSnapshot {
                    version: 1,
                    rows: 24,
                    cols: 80,
                    cursor_row: 0,
                    cursor_col: 0,
                    cursor_visible: true,
                    saved_at: 0,
                    sequence: 0,
                    vt: String::new(),
                },
                agent_provider: None,
            };
            let output = DaemonEvent::Output {
                session_id: "daemon-terminal-1".into(),
                data: b"responsive".to_vec(),
            };
            for event in [snapshot, output] {
                write_half
                    .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
                    .await
                    .unwrap();
            }
        });
        Db::open(fixture.db_path.to_str().unwrap())
            .unwrap()
            .insert_test_terminal_session(
                "terminal-1",
                "repo-1",
                "task-1",
                "agent",
                "daemon-terminal-1",
            )
            .unwrap();

        let url = fixture.serve().await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Terminal,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;

        let deadline = tokio::time::Instant::now() + Duration::from_millis(490);
        let mut saw_output = false;
        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let Some(frame) = recv_frame_with_timeout(&mut socket, remaining).await else {
                break;
            };
            if matches!(frame, ServerFrame::TermOutput { .. }) {
                saw_output = true;
                break;
            }
        }
        assert!(
            saw_output,
            "terminal output waited for a full companion polling interval"
        );
        daemon.await.unwrap();
        let _ = std::fs::remove_file(socket_path);
    }

    #[tokio::test]
    async fn auth_handshake_then_request_dispatch() {
        let url = serve_test_router().await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));

        // Request frames route into the same task API the REST endpoints use.
        send_frame(
            &mut socket,
            &ClientFrame::Request {
                id: 7,
                method: "GET".into(),
                path: "/v1/status".into(),
                body: None,
            },
        )
        .await;
        match recv_frame(&mut socket).await {
            ServerFrame::Response { id, status, body } => {
                assert_eq!(id, 7);
                assert_eq!(status, 200);
                let body = body.expect("status body");
                assert_eq!(body["desktopId"], "ksp-test");
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn request_dispatch_marks_tasks_read_with_revision_and_legacy_null_bodies() {
        let unique = format!(
            "ksp-mark-read-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let mut config = test_config(&unique, "KSP Mark Read");
        config.db_path = Db::test_db_path(&unique);
        let db = Db::open_for_tests(&config.db_path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One")
            .expect("insert repo");
        for task_id in ["task-revision", "task-legacy"] {
            db.insert_test_pipeline_item(
                task_id,
                "repo-1",
                "task prompt",
                Some("Task"),
                "in progress",
                "2026-07-25 01:00:00",
            )
            .expect("insert task");
            db.update_pipeline_item_activity(task_id, "unread")
                .expect("mark task unread");
        }
        let state = Arc::new(AppState::new(config.clone()));
        let (frame_tx, mut frame_rx) = mpsc::channel(2);

        dispatch_ksp_request(
            Arc::clone(&state),
            frame_tx.clone(),
            KspRequest {
                id: 41,
                method: "POST".into(),
                path: "/v1/tasks/task-revision/actions/mark-read".into(),
                body: Some(serde_json::json!({
                    "expectedActivityRevision": 1,
                })),
            },
        )
        .await;
        dispatch_ksp_request(
            state,
            frame_tx,
            KspRequest {
                id: 42,
                method: "POST".into(),
                path: "/v1/tasks/task-legacy/actions/mark-read".into(),
                body: None,
            },
        )
        .await;

        for (expected_id, expected_task_id) in [(41, "task-revision"), (42, "task-legacy")] {
            match frame_rx.recv().await.expect("mark-read response") {
                ServerFrame::Response { id, status, body } => {
                    assert_eq!(id, expected_id);
                    assert_eq!(status, 200);
                    assert_eq!(
                        body,
                        Some(serde_json::json!({
                            "taskId": expected_task_id,
                            "activity": "idle",
                        }))
                    );
                }
                other => panic!("expected Response, got {other:?}"),
            }
        }

        for task_id in ["task-revision", "task-legacy"] {
            let item = db
                .get_pipeline_item(task_id)
                .expect("read task")
                .expect("task exists");
            assert_eq!(item.activity.as_deref(), Some("idle"));
            assert_eq!(item.activity_revision, 2);
        }
    }

    #[tokio::test]
    async fn ksp_request_cannot_create_pairing_session() {
        let url = serve_test_router().await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));

        send_frame(
            &mut socket,
            &ClientFrame::Request {
                id: 8,
                method: "POST".into(),
                path: "/v1/pairing/sessions".into(),
                body: None,
            },
        )
        .await;

        match recv_frame(&mut socket).await {
            ServerFrame::Response { id, status, body } => {
                assert_eq!(id, 8);
                assert_eq!(status, 403);
                assert!(!body.is_some_and(|body| body.get("pairingPayload").is_some()));
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn frames_before_auth_are_rejected() {
        let url = serve_test_router().await;
        let mut socket = ws_connect(&url).await;

        send_frame(
            &mut socket,
            &ClientFrame::AgentInterrupt {
                task_id: "t1".into(),
            },
        )
        .await;
        match recv_frame(&mut socket).await {
            ServerFrame::Error { code, .. } => assert_eq!(code, "unauthenticated"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn attach_unknown_task_reports_no_session() {
        let url = serve_test_router().await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));

        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "missing-task".into(),
                kind: StreamKind::Agent,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;
        match recv_frame(&mut socket).await {
            ServerFrame::Error { code, task_id, .. } => {
                assert_eq!(code, "no_session");
                assert_eq!(task_id.as_deref(), Some("missing-task"));
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn shell_terminal_ids_resolve_directly_to_daemon_sessions() {
        assert_eq!(
            direct_terminal_session_id("shell-wt-task-1"),
            Some("shell-wt-task-1".to_string()),
        );
        assert_eq!(
            direct_terminal_session_id("shell-repo-repo-1"),
            Some("shell-repo-repo-1".to_string()),
        );
        assert_eq!(direct_terminal_session_id("task-1"), None);
    }

    #[tokio::test]
    async fn terminal_control_reuses_one_connection_and_preserves_resize_order() {
        let unique = format!(
            "ksp-terminal-control-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-control", "KSP Terminal Control");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) = spawn_fake_control_daemon(config.daemon_dir.clone(), 3).await;
        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));

        send_frame(
            &mut socket,
            &ClientFrame::TermResize {
                task_id: "shell-control-test".into(),
                cols: 101,
                rows: 31,
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::TermResize {
                task_id: "shell-control-test".into(),
                cols: 137,
                rows: 43,
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::TermResize {
                task_id: "shell-control-test".into(),
                cols: 151,
                rows: 51,
            },
        )
        .await;

        assert_command(
            commands.recv().await,
            DaemonCommand::ResizeNoReply {
                session_id: "shell-control-test".into(),
                cols: 101,
                rows: 31,
            },
        );
        assert_command(
            commands.recv().await,
            DaemonCommand::ResizeNoReply {
                session_id: "shell-control-test".into(),
                cols: 137,
                rows: 43,
            },
        );
        assert_command(
            commands.recv().await,
            DaemonCommand::ResizeNoReply {
                session_id: "shell-control-test".into(),
                cols: 151,
                rows: 51,
            },
        );
        assert_eq!(daemon.await.expect("fake control daemon failed"), 1);

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn terminal_altitude_paste_and_queued_inputs_are_distinct_fifo_submissions() {
        use axum::body::Body;
        use axum::http::Request;
        use std::sync::{Arc as StdArc, Mutex};
        use tower::ServiceExt;

        let unique = format!(
            "ksp-atomic-input-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();
        let writes = StdArc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let recorded = StdArc::clone(&writes);
        let fake_daemon = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let recorded = StdArc::clone(&recorded);
                tokio::spawn(async move {
                    let (read_half, mut write_half) = stream.into_split();
                    let mut reader = BufReader::new(read_half);
                    loop {
                        let mut line = String::new();
                        let Ok(read) = reader.read_line(&mut line).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        let command = serde_json::from_str::<DaemonCommand>(line.trim()).unwrap();
                        let event = match command {
                            DaemonCommand::List => DaemonEvent::SessionList {
                                sessions: vec![kanna_daemon::protocol::SessionInfo {
                                    session_id: "task-target".to_string(),
                                    pid: 5151,
                                    cwd: "/tmp".to_string(),
                                    state: kanna_daemon::protocol::SessionState::Active,
                                    idle_seconds: 0,
                                    status: SessionStatus::Idle,
                                    kind: kanna_daemon::protocol::SessionKind::Pty,
                                }],
                            },
                            DaemonCommand::InputIfSession {
                                session_id,
                                expected_pid,
                                data,
                            } => {
                                assert_eq!(session_id, "task-target");
                                assert_eq!(expected_pid, 5151);
                                recorded.lock().unwrap().push(data);
                                DaemonEvent::Ok
                            }
                            other => panic!("unexpected daemon command: {other:?}"),
                        };
                        write_half
                            .write_all(
                                format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                });
            }
        });

        let mut config = test_config(&unique, "Atomic Input");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo").unwrap();
        db.insert_test_pipeline_item(
            "task-target",
            "repo-1",
            "Target",
            None,
            "in progress",
            "2026-08-15T00:00:00Z",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-target",
            "task-target",
            "default",
            None,
            "codex",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-child",
            "repo-1",
            "Child",
            Some("Child"),
            "in progress",
            "2026-08-15T00:00:01Z",
        )
        .unwrap();
        db.update_test_pipeline_item_notify_task("task-child", "task-target")
            .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-child",
            task_id: "task-child",
            stage: "in progress",
            kind: "main",
            agent: Some("implement"),
            agent_provider: Some("codex"),
            model: None,
            effort: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-child"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
        drop(db);

        let state = Arc::new(AppState::new(config.clone()));
        let app = crate::http_api::router(Arc::clone(&state));
        let url = serve_router(app.clone()).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));

        let altitude_paste = b"\x1b[13;2u\x1b[200~paste\nbody\x1b[201~";
        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "task-target".into(),
                data_b64: b64(altitude_paste),
            },
        )
        .await;
        state.task_input.wait_for_admissions(1).await;

        let mobile = tokio::spawn({
            let app = app.clone();
            async move {
                app.oneshot(
                    Request::post("/v1/tasks/task-target/input")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::json!({
                                "input": "mobile reply",
                                "source": "human"
                            })
                            .to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        });
        state.task_input.wait_for_admissions(2).await;

        let api = tokio::spawn({
            let app = app.clone();
            async move {
                app.oneshot(
                    Request::post("/v1/tasks/task-target/input")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::json!({ "input": "api steer" }).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        });
        state.task_input.wait_for_admissions(3).await;

        let completion = tokio::spawn({
            let state = Arc::clone(&state);
            async move { crate::http_api::handle_task_terminal_state(&state, "task-child", 0).await }
        });
        state.task_input.wait_for_admissions(4).await;

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "task-target".into(),
                data_b64: b64(b"\r"),
            },
        )
        .await;

        assert_eq!(
            mobile.await.unwrap().status(),
            axum::http::StatusCode::NO_CONTENT
        );
        assert_eq!(
            api.await.unwrap().status(),
            axum::http::StatusCode::NO_CONTENT
        );
        completion.await.unwrap().unwrap();

        for _ in 0..100 {
            if writes.lock().unwrap().len() == 8 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            *writes.lock().unwrap(),
            vec![
                altitude_paste.to_vec(),
                vec![b'\r'],
                b"mobile reply".to_vec(),
                vec![b'\r'],
                b"api steer".to_vec(),
                vec![b'\r'],
                b"TASK task-child DONE [success]: Child".to_vec(),
                vec![b'\r'],
            ]
        );
        let db = Db::open(&config.db_path).unwrap();
        let events = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let events = db.list_recent_input_events("task-target", 10).unwrap();
                if events.len() >= 4 {
                    break events;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("four durable task.input events were not recorded");
        assert_eq!(
            events
                .iter()
                .map(|event| event.payload["source"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["human", "human", "api", "completion_notification"]
        );
        assert_eq!(events[0].payload["boundary"], "terminal-enter");
        assert_eq!(events[1].payload["text"], "mobile reply");
        assert_eq!(events[2].payload["text"], "api steer");
        assert_eq!(
            events[3].payload["text"],
            "TASK task-child DONE [success]: Child"
        );

        fake_daemon.abort();
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
        let _ = std::fs::remove_file(config.db_path);
    }

    #[tokio::test]
    async fn terminal_input_consumed_before_socket_close_is_not_replayed() {
        let unique = format!(
            "ksp-terminal-at-most-once-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-at-most-once", "KSP At Most Once");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) =
            spawn_fake_control_daemon_close_after_first_command(config.daemon_dir.clone()).await;
        let url = serve_router(crate::http_api::router(Arc::new(AppState::new(config)))).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-at-most-once".into(),
                data_b64: b64(b"run-once\n"),
            },
        )
        .await;

        let first = commands.recv().await.expect("daemon did not consume input");
        assert_eq!(
            serde_json::to_value(first).unwrap()["data"],
            serde_json::json!([114, 117, 110, 45, 111, 110, 99, 101, 10])
        );
        let replay =
            tokio::time::timeout(std::time::Duration::from_millis(700), commands.recv()).await;
        assert!(replay.is_err(), "ambiguous terminal input was replayed");

        daemon.abort();
        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn missing_input_ack_poison_fences_later_terminal_input() {
        let unique = format!(
            "ksp-terminal-no-ack-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-no-ack", "KSP No ACK");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) =
            spawn_fake_control_daemon_close_after_first_command(config.daemon_dir.clone()).await;
        let url = serve_router(crate::http_api::router(Arc::new(AppState::new(config)))).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-no-ack".into(),
                data_b64: b64(b"first"),
            },
        )
        .await;
        assert_command(
            commands.recv().await,
            DaemonCommand::InputNoReply {
                session_id: "shell-no-ack".into(),
                data: b"first".to_vec(),
            },
        );

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-no-ack".into(),
                data_b64: b64(b"second"),
            },
        )
        .await;
        let later = tokio::time::timeout(Duration::from_millis(500), commands.recv()).await;
        assert!(
            later.is_err(),
            "poisoned queue submitted later terminal input"
        );

        daemon.abort();
        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_input_bypasses_blocked_ksp_request() {
        let unique = format!(
            "ksp-terminal-request-hol-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-request-hol", "KSP Request HOL");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) = spawn_fake_control_daemon(config.daemon_dir.clone(), 2).await;
        let router = crate::http_api::router(Arc::new(AppState::new(config.clone())));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-request-hol".into(),
                data_b64: b64(b"warm"),
            },
        )
        .await;
        assert_command(
            commands.recv().await,
            DaemonCommand::InputNoReply {
                session_id: "shell-request-hol".into(),
                data: b"warm".to_vec(),
            },
        );

        let lock = rusqlite::Connection::open(&config.db_path).expect("open lock connection");
        lock.execute_batch("BEGIN IMMEDIATE; UPDATE settings SET value = value;")
            .expect("hold sqlite write lock");
        send_frame(
            &mut socket,
            &ClientFrame::Request {
                id: 71,
                method: "PUT".into(),
                path: "/v1/settings/terminalLatencyTest".into(),
                body: Some(serde_json::json!({ "value": "busy" })),
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-request-hol".into(),
                data_b64: b64(b"responsive"),
            },
        )
        .await;

        let command_while_locked =
            tokio::time::timeout(std::time::Duration::from_millis(300), commands.recv()).await;
        lock.execute_batch("ROLLBACK")
            .expect("release sqlite write lock");

        assert_command(
            command_while_locked.expect("terminal input was blocked behind KSP request"),
            DaemonCommand::InputNoReply {
                session_id: "shell-request-hol".into(),
                data: b"responsive".to_vec(),
            },
        );
        assert_eq!(daemon.await.expect("fake control daemon failed"), 2);

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_terminal_input_does_not_block_ksp_requests_or_resize() {
        let unique = format!(
            "ksp-input-opposite-hol-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-input-opposite-hol", "KSP Input Opposite HOL");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let socket_path = daemon_socket_path_for_dir(&config.daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind input HOL daemon socket");
        let (command_tx, mut command_rx) = mpsc::channel(4);
        let release_input = Arc::new(tokio::sync::Notify::new());
        let input_blocked = Arc::new(tokio::sync::Notify::new());
        let daemon_release = Arc::clone(&release_input);
        let daemon_blocked = Arc::clone(&input_blocked);
        let daemon = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.expect("accept daemon connection");
                let command_tx = command_tx.clone();
                let release_input = Arc::clone(&daemon_release);
                let input_blocked = Arc::clone(&daemon_blocked);
                handlers.spawn(async move {
                    let (read_half, mut write_half) = stream.into_split();
                    let mut reader = BufReader::new(read_half);
                    loop {
                        let mut line = String::new();
                        let read = reader
                            .read_line(&mut line)
                            .await
                            .expect("read daemon command");
                        if read == 0 {
                            return;
                        }
                        let command: DaemonCommand =
                            serde_json::from_str(line.trim()).expect("parse daemon command");
                        match command {
                            DaemonCommand::List => {
                                let event = DaemonEvent::SessionList {
                                    sessions: vec![kanna_daemon::protocol::SessionInfo {
                                        session_id: "shell-input-opposite-hol".into(),
                                        pid: 4242,
                                        cwd: "/tmp".into(),
                                        state: kanna_daemon::protocol::SessionState::Active,
                                        idle_seconds: 0,
                                        status: SessionStatus::Idle,
                                        kind: kanna_daemon::protocol::SessionKind::Pty,
                                    }],
                                };
                                write_half
                                    .write_all(
                                        format!("{}\n", serde_json::to_string(&event).unwrap())
                                            .as_bytes(),
                                    )
                                    .await
                                    .expect("write daemon session list");
                            }
                            DaemonCommand::InputIfSession { .. } => {
                                command_tx
                                    .send(command)
                                    .await
                                    .expect("publish blocked terminal input");
                                input_blocked.notify_one();
                                release_input.notified().await;
                                write_half
                                    .write_all(
                                        format!(
                                            "{}\n",
                                            serde_json::to_string(&DaemonEvent::Ok).unwrap()
                                        )
                                        .as_bytes(),
                                    )
                                    .await
                                    .expect("ack terminal input");
                            }
                            DaemonCommand::ResizeNoReply { .. } => {
                                command_tx
                                    .send(command)
                                    .await
                                    .expect("publish terminal resize");
                            }
                            other => panic!("unexpected daemon command: {other:?}"),
                        }
                    }
                });
            }
        });

        let url = serve_router(crate::http_api::router(Arc::new(AppState::new(config)))).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-input-opposite-hol".into(),
                data_b64: b64(b"blocked"),
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::Request {
                id: 72,
                method: "GET".into(),
                path: "/v1/status".into(),
                body: None,
            },
        )
        .await;
        send_frame(
            &mut socket,
            &ClientFrame::TermResize {
                task_id: "shell-input-opposite-hol".into(),
                cols: 132,
                rows: 44,
            },
        )
        .await;

        tokio::time::timeout(Duration::from_secs(1), input_blocked.notified())
            .await
            .expect("terminal input did not reach daemon");

        let response = tokio::time::timeout(Duration::from_millis(300), recv_frame(&mut socket));
        let resize = tokio::time::timeout(Duration::from_millis(300), async {
            loop {
                match command_rx.recv().await {
                    Some(command @ DaemonCommand::ResizeNoReply { .. }) => return Some(command),
                    Some(DaemonCommand::InputIfSession { data, .. }) => {
                        assert_eq!(data, b"blocked");
                    }
                    Some(other) => panic!("unexpected observed daemon command: {other:?}"),
                    None => return None,
                }
            }
        });
        let (response, resize) = tokio::join!(response, resize);
        release_input.notify_waiters();

        assert!(matches!(
            response.expect("KSP request waited behind terminal input"),
            ServerFrame::Response {
                id: 72,
                status: 200,
                ..
            }
        ));
        assert_command(
            resize.expect("terminal resize waited behind terminal input"),
            DaemonCommand::ResizeNoReply {
                session_id: "shell-input-opposite-hol".into(),
                cols: 132,
                rows: 44,
            },
        );

        daemon.abort();
        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_input_admitted_before_replacement_never_reaches_the_new_pid() {
        let unique = format!(
            "ksp-input-route-fence-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-input-route-fence", "KSP Input Route Fence");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let socket_path = daemon_socket_path_for_dir(&config.daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind route fence daemon socket");
        let current_pid = Arc::new(AtomicUsize::new(1111));
        let first_blocked = Arc::new(tokio::sync::Notify::new());
        let release_first = Arc::new(tokio::sync::Notify::new());
        let (stale_tx, mut stale_rx) = mpsc::channel(1);
        let daemon_pid = Arc::clone(&current_pid);
        let daemon_blocked = Arc::clone(&first_blocked);
        let daemon_release = Arc::clone(&release_first);
        let daemon = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.expect("accept daemon connection");
                let current_pid = Arc::clone(&daemon_pid);
                let first_blocked = Arc::clone(&daemon_blocked);
                let release_first = Arc::clone(&daemon_release);
                let stale_tx = stale_tx.clone();
                tokio::spawn(async move {
                    let (read_half, mut write_half) = stream.into_split();
                    let mut reader = BufReader::new(read_half);
                    let mut line = String::new();
                    reader
                        .read_line(&mut line)
                        .await
                        .expect("read route fence daemon command");
                    let command: DaemonCommand =
                        serde_json::from_str(line.trim()).expect("parse daemon command");
                    match command {
                        DaemonCommand::List => {
                            let event = DaemonEvent::SessionList {
                                sessions: vec![kanna_daemon::protocol::SessionInfo {
                                    session_id: "shell-input-route-fence".into(),
                                    pid: current_pid.load(Ordering::SeqCst) as u32,
                                    cwd: "/tmp".into(),
                                    state: kanna_daemon::protocol::SessionState::Active,
                                    idle_seconds: 0,
                                    status: SessionStatus::Idle,
                                    kind: kanna_daemon::protocol::SessionKind::Pty,
                                }],
                            };
                            write_half
                                .write_all(
                                    format!("{}\n", serde_json::to_string(&event).unwrap())
                                        .as_bytes(),
                                )
                                .await
                                .expect("write session list");
                        }
                        DaemonCommand::InputIfSession {
                            expected_pid, data, ..
                        } if data == b"first" => {
                            assert_eq!(expected_pid, 1111);
                            first_blocked.notify_one();
                            release_first.notified().await;
                            let _ = write_half
                                .write_all(
                                    format!(
                                        "{}\n",
                                        serde_json::to_string(&DaemonEvent::Ok).unwrap()
                                    )
                                    .as_bytes(),
                                )
                                .await;
                        }
                        DaemonCommand::InputIfSession {
                            expected_pid, data, ..
                        } => {
                            stale_tx
                                .send((expected_pid, data))
                                .await
                                .expect("publish stale input delivery");
                        }
                        other => panic!("unexpected route fence command: {other:?}"),
                    }
                });
            }
        });

        let state = Arc::new(AppState::new(config));
        let (frame_tx, companion_tx, _outbound_rx) = outbound_frame_channel(8);
        let mut conn = StreamConn {
            state: Arc::clone(&state),
            frame_tx,
            companion_tx,
            attachments: HashMap::new(),
            terminal_controls: HashMap::new(),
            terminal_inputs: HashMap::new(),
            agent_commands: None,
            requests: None,
            companion_events: None,
            authed: true,
            supports_companion_event_epoch: false,
            legacy_companion_tasks_on_connection: HashSet::new(),
            auth_mode: AuthMode::AllowEmpty,
            companion_access: true,
        };

        assert!(
            conn.handle(ClientFrame::TermInput {
                task_id: "shell-input-route-fence".into(),
                data_b64: b64(b"first"),
            })
            .await
        );
        tokio::time::timeout(Duration::from_secs(1), first_blocked.notified())
            .await
            .expect("first input did not block at the old PID");
        assert!(
            conn.handle(ClientFrame::TermInput {
                task_id: "shell-input-route-fence".into(),
                data_b64: b64(b"stale"),
            })
            .await
        );

        current_pid.store(2222, Ordering::SeqCst);
        state
            .task_input
            .begin_session_replacement("shell-input-route-fence");
        state
            .task_input
            .finish_session_replacement("shell-input-route-fence");
        release_first.notify_waiters();

        let stale = tokio::time::timeout(Duration::from_millis(500), stale_rx.recv()).await;
        assert!(
            stale.is_err(),
            "input accepted before replacement reached the replacement PID: {stale:?}"
        );

        conn.shutdown().await;
        daemon.abort();
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_input_bypasses_a_blocked_companion_event_append() {
        let mut fixture = KspCompanionFixture::new("companion-event-hol");
        fixture.activate(
            "session-1",
            "layout.html",
            b"<button data-choice='a'>A</button>",
        );
        let document =
            crate::visual_companion::current_bundle(fixture.db_path.to_str().unwrap(), "task-1")
                .unwrap()
                .unwrap();
        let daemon_dir = fixture.temp_dir.path().join("daemon");
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        fixture.config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        let (daemon, mut commands) =
            spawn_fake_control_daemon(fixture.config.daemon_dir.clone(), 1).await;
        let url = serve_router(crate::http_api::router(Arc::new(AppState::new(
            fixture.config.clone(),
        ))))
        .await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame());
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Companion,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: Some(false),
                attachment_epoch: Some(1),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::CompanionSnapshot {
                attachment_epoch: Some(1),
                ..
            }
        ));

        let append_gate = install_companion_append_test_gate("blocked-append");
        let mut event = KspCompanionFixture::event("blocked-append");
        event.session_id = document.session_id.clone();
        event.revision = document.revision.clone();
        send_frame(
            &mut socket,
            &ClientFrame::CompanionEvent {
                task_id: "task-1".into(),
                session_id: document.session_id,
                revision: document.revision,
                attachment_epoch: Some(1),
                event,
            },
        )
        .await;
        tokio::time::timeout(Duration::from_secs(1), append_gate.wait_until_blocked())
            .await
            .expect("companion append did not reach the blocked worker");

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-companion-event-hol".into(),
                data_b64: b64(b"responsive"),
            },
        )
        .await;
        let command_while_append_blocked =
            tokio::time::timeout(Duration::from_millis(300), commands.recv()).await;
        append_gate.release();
        drop(append_gate);

        assert_command(
            command_while_append_blocked
                .expect("terminal input waited for companion event persistence"),
            DaemonCommand::InputNoReply {
                session_id: "shell-companion-event-hol".into(),
                data: b"responsive".to_vec(),
            },
        );
        daemon.await.expect("fake control daemon failed");
        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bounded_request_saturation_keeps_terminal_input_responsive() {
        let unique = format!(
            "ksp-request-saturation-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-request-saturation", "KSP Request Saturation");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) = spawn_fake_control_daemon(config.daemon_dir.clone(), 1).await;
        let url = serve_router(crate::http_api::router(Arc::new(AppState::new(
            config.clone(),
        ))))
        .await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));

        let lock = rusqlite::Connection::open(&config.db_path).expect("open lock connection");
        lock.execute_batch("BEGIN IMMEDIATE; UPDATE settings SET value = value;")
            .expect("hold sqlite write lock");
        for offset in 0..40u64 {
            send_frame(
                &mut socket,
                &ClientFrame::Request {
                    id: 10_000 + offset,
                    method: "PUT".into(),
                    path: format!("/v1/settings/requestSaturation{offset}"),
                    body: Some(serde_json::json!({ "value": "busy" })),
                },
            )
            .await;
        }
        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-request-saturation".into(),
                data_b64: b64(b"responsive"),
            },
        )
        .await;

        let terminal_command =
            tokio::time::timeout(std::time::Duration::from_millis(300), commands.recv()).await;
        let overflow_response = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            recv_frame(&mut socket),
        )
        .await;
        lock.execute_batch("ROLLBACK")
            .expect("release sqlite write lock");

        assert_command(
            terminal_command.expect("request saturation delayed terminal input"),
            DaemonCommand::InputNoReply {
                session_id: "shell-request-saturation".into(),
                data: b"responsive".to_vec(),
            },
        );
        match overflow_response.expect("unbounded request dispatcher accepted every request") {
            ServerFrame::Response { id, status, .. } => {
                assert!((10_000..10_040).contains(&id));
                assert_eq!(status, 503);
            }
            other => panic!("expected saturated request response, got {other:?}"),
        }

        daemon.await.expect("saturation daemon failed");
        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_input_bypasses_agent_command_waiting_for_daemon_reply() {
        let unique = format!(
            "ksp-terminal-agent-hol-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-agent-hol", "KSP Agent HOL");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let db = Db::open_for_tests(&config.db_path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One")
            .expect("insert repo");
        db.insert_test_pipeline_item(
            "task-agent-hol",
            "repo-1",
            "Agent command HOL",
            None,
            "in progress",
            "2026-07-17T00:00:00Z",
        )
        .expect("insert task");
        db.insert_test_terminal_session(
            "terminal-agent-hol",
            "repo-1",
            "task-agent-hol",
            "agent",
            "daemon-agent-hol",
        )
        .expect("insert terminal session");
        drop(db);

        let socket_path = daemon_socket_path_for_dir(&config.daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind agent HOL daemon socket");
        let (command_tx, mut command_rx) = mpsc::channel(2);
        let release_agent = Arc::new(tokio::sync::Notify::new());
        let daemon_release = release_agent.clone();
        let daemon = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            for _ in 0..3 {
                let (stream, _) = listener.accept().await.expect("accept daemon connection");
                let command_tx = command_tx.clone();
                let release_agent = daemon_release.clone();
                handlers.spawn(async move {
                    let (read_half, mut write_half) = stream.into_split();
                    let mut reader = BufReader::new(read_half);
                    let mut line = String::new();
                    reader
                        .read_line(&mut line)
                        .await
                        .expect("read daemon command");
                    let command: DaemonCommand =
                        serde_json::from_str(line.trim()).expect("parse daemon command");
                    if matches!(command, DaemonCommand::List) {
                        let event = DaemonEvent::SessionList {
                            sessions: vec![kanna_daemon::protocol::SessionInfo {
                                session_id: "shell-agent-hol".to_string(),
                                pid: 4242,
                                cwd: "/tmp".to_string(),
                                state: kanna_daemon::protocol::SessionState::Active,
                                idle_seconds: 0,
                                status: SessionStatus::Idle,
                                kind: kanna_daemon::protocol::SessionKind::Pty,
                            }],
                        };
                        write_half
                            .write_all(
                                format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes(),
                            )
                            .await
                            .expect("write daemon session list");
                        return;
                    }
                    let command = match command {
                        DaemonCommand::InputIfSession {
                            session_id, data, ..
                        } => DaemonCommand::InputNoReply { session_id, data },
                        command => command,
                    };
                    let hold_reply = matches!(command, DaemonCommand::AgentInterrupt { .. });
                    command_tx
                        .send(command)
                        .await
                        .expect("publish daemon command");
                    if hold_reply {
                        release_agent.notified().await;
                    }
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                                .as_bytes(),
                        )
                        .await
                        .expect("write daemon response");
                });
            }
            while handlers.join_next().await.is_some() {}
        });

        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));
        send_frame(
            &mut socket,
            &ClientFrame::AgentInterrupt {
                task_id: "task-agent-hol".into(),
            },
        )
        .await;
        assert_command(
            command_rx.recv().await,
            DaemonCommand::AgentInterrupt {
                session_id: "daemon-agent-hol".into(),
            },
        );

        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "shell-agent-hol".into(),
                data_b64: b64(b"responsive"),
            },
        )
        .await;
        let input_while_agent_waited =
            tokio::time::timeout(std::time::Duration::from_millis(300), command_rx.recv()).await;
        release_agent.notify_waiters();

        assert_command(
            input_while_agent_waited.expect("terminal input waited for agent command reply"),
            DaemonCommand::InputNoReply {
                session_id: "shell-agent-hol".into(),
                data: b"responsive".to_vec(),
            },
        );
        daemon.await.expect("agent HOL daemon failed");

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn terminal_resize_control_reconnects_after_daemon_socket_replacement() {
        let unique = format!(
            "ksp-terminal-control-reconnect-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config(
            "ksp-terminal-control-reconnect",
            "KSP Terminal Control Reconnect",
        );
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) =
            spawn_fake_control_daemon_with_disconnect(config.daemon_dir.clone(), 2).await;
        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;
        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));

        send_frame(
            &mut socket,
            &ClientFrame::TermResize {
                task_id: "shell-control-reconnect".into(),
                cols: 100,
                rows: 30,
            },
        )
        .await;
        assert_command(
            commands.recv().await,
            DaemonCommand::ResizeNoReply {
                session_id: "shell-control-reconnect".into(),
                cols: 100,
                rows: 30,
            },
        );
        // The first fake connection closes after consuming the command. Wait
        // beyond the first reconnect delay, matching a real handoff where the
        // replacement daemon is ready before the next keypress arrives.
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        send_frame(
            &mut socket,
            &ClientFrame::TermResize {
                task_id: "shell-control-reconnect".into(),
                cols: 120,
                rows: 40,
            },
        )
        .await;
        assert_command(
            tokio::time::timeout(std::time::Duration::from_secs(2), commands.recv())
                .await
                .expect("control worker did not reconnect"),
            DaemonCommand::ResizeNoReply {
                session_id: "shell-control-reconnect".into(),
                cols: 120,
                rows: 40,
            },
        );
        assert_eq!(daemon.await.expect("reconnect daemon failed"), 2);

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn terminal_route_replacement_updates_control_and_input_workers() {
        let unique = format!(
            "ksp-terminal-route-replacement-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config(
            "ksp-terminal-route-replacement",
            "KSP Terminal Route Replacement",
        );
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let (daemon, mut commands) = spawn_fake_control_daemon(config.daemon_dir.clone(), 2).await;
        let state = Arc::new(AppState::new(config));
        let (frame_tx, companion_tx, _outbound_rx) = outbound_frame_channel(8);
        let mut conn = StreamConn {
            state,
            frame_tx,
            companion_tx,
            attachments: HashMap::new(),
            terminal_controls: HashMap::new(),
            terminal_inputs: HashMap::new(),
            agent_commands: None,
            requests: None,
            companion_events: None,
            authed: true,
            supports_companion_event_epoch: false,
            legacy_companion_tasks_on_connection: HashSet::new(),
            auth_mode: AuthMode::AllowEmpty,
            companion_access: true,
        };

        conn.replace_terminal_control_route("task-route", "daemon-session-old".into())
            .await;
        conn.replace_terminal_input_route("task-route", "daemon-session-old".into())
            .await;
        conn.enqueue_terminal_control(
            "task-route".into(),
            TerminalControlCommand::Input(b"old".to_vec()),
        );
        assert_command(
            commands.recv().await,
            DaemonCommand::InputNoReply {
                session_id: "daemon-session-old".into(),
                data: b"old".to_vec(),
            },
        );

        conn.replace_terminal_control_route("task-route", "daemon-session-new".into())
            .await;
        conn.replace_terminal_input_route("task-route", "daemon-session-new".into())
            .await;
        assert_eq!(
            conn.terminal_inputs
                .get("task-route")
                .and_then(|input| input.session_id.as_deref()),
            Some("daemon-session-new")
        );
        conn.enqueue_terminal_control(
            "task-route".into(),
            TerminalControlCommand::Input(b"new".to_vec()),
        );
        assert_command(
            commands.recv().await,
            DaemonCommand::InputNoReply {
                session_id: "daemon-session-new".into(),
                data: b"new".to_vec(),
            },
        );
        assert_eq!(daemon.await.expect("route daemon failed"), 2);
        conn.shutdown().await;

        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    fn terminal_input_conn_with_worker(
        test_name: &str,
        task_id: &str,
        worker: TerminalInputHandle,
    ) -> (StreamConn, OutboundFrameReceiver) {
        let state = Arc::new(AppState::new(test_config(
            test_name,
            "Terminal Input Queue",
        )));
        let (frame_tx, companion_tx, outbound_rx) = outbound_frame_channel(8);
        (
            StreamConn {
                state,
                frame_tx,
                companion_tx,
                attachments: HashMap::new(),
                terminal_controls: HashMap::new(),
                terminal_inputs: HashMap::from([(task_id.to_string(), worker)]),
                agent_commands: None,
                requests: None,
                companion_events: None,
                authed: true,
                supports_companion_event_epoch: false,
                legacy_companion_tasks_on_connection: HashSet::new(),
                auth_mode: AuthMode::AllowEmpty,
                companion_access: true,
            },
            outbound_rx,
        )
    }

    #[tokio::test]
    async fn full_terminal_input_queue_reports_a_typed_error() {
        let (tx, input_rx) = mpsc::channel(1);
        let coordinator = crate::task_input_queue::TaskInputCoordinator::new(
            "/unused".into(),
            Db::test_db_path("terminal-input-full-admission"),
        );
        tx.try_send(TerminalInputRequest {
            data: b"already queued".to_vec(),
            admission: coordinator.capture_operator_admission(None),
        })
        .unwrap();
        let task = tokio::spawn(async move {
            let _input_rx = input_rx;
            std::future::pending::<()>().await;
        });
        let (cancel_tx, _cancel_rx) = watch::channel(false);
        let (mut conn, mut outbound_rx) = terminal_input_conn_with_worker(
            "terminal-input-full",
            "task-input-full",
            TerminalInputHandle {
                session_id: Some("session-input-full".into()),
                tx,
                cancel_tx,
                pending: Arc::new(Mutex::new(TerminalInputPending {
                    queued: 1,
                    ..TerminalInputPending::default()
                })),
                task,
            },
        );

        assert!(
            conn.handle(ClientFrame::TermInput {
                task_id: "task-input-full".into(),
                data_b64: b64(b"overflow"),
            })
            .await
        );
        assert!(matches!(
            tokio::time::timeout(Duration::from_millis(300), outbound_rx.recv())
                .await
                .expect("full terminal input queue did not report an error"),
            Some(ServerFrame::Error {
                task_id: Some(task_id),
                code,
                ..
            }) if task_id == "task-input-full" && code == "terminal_input_busy"
        ));
        conn.shutdown().await;
    }

    #[tokio::test]
    async fn closed_terminal_input_queue_is_replaced_before_retry() {
        let (tx, input_rx) = mpsc::channel(1);
        drop(input_rx);
        let task = tokio::spawn(std::future::pending::<()>());
        let (cancel_tx, _cancel_rx) = watch::channel(false);
        let stale_pending = Arc::new(Mutex::new(TerminalInputPending::default()));
        let (mut conn, mut outbound_rx) = terminal_input_conn_with_worker(
            "terminal-input-closed",
            "task-input-closed",
            TerminalInputHandle {
                session_id: Some("session-input-closed".into()),
                tx,
                cancel_tx,
                pending: Arc::clone(&stale_pending),
                task,
            },
        );

        assert!(
            conn.handle(ClientFrame::TermInput {
                task_id: "task-input-closed".into(),
                data_b64: b64(b"closed"),
            })
            .await
        );
        assert!(matches!(
            tokio::time::timeout(Duration::from_millis(300), outbound_rx.recv())
                .await
                .expect("closed terminal input queue did not report an error"),
            Some(ServerFrame::Error {
                task_id: Some(task_id),
                code,
                ..
            }) if task_id == "task-input-closed" && code == "no_session"
        ));
        let replacement = conn
            .terminal_inputs
            .get("task-input-closed")
            .expect("closed worker was replaced");
        assert!(!Arc::ptr_eq(&replacement.pending, &stale_pending));
        assert!(
            replacement
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .retiring
        );
        conn.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn closed_worker_retry_preserves_admission_captured_before_replacement() {
        let (tx, input_rx) = mpsc::channel(1);
        drop(input_rx);
        let task = tokio::spawn(std::future::pending::<()>());
        let (cancel_tx, _cancel_rx) = watch::channel(false);
        let pending = Arc::new(Mutex::new(TerminalInputPending::default()));
        let (conn, _outbound_rx) = terminal_input_conn_with_worker(
            "terminal-input-closed-replacement",
            "shell-input-closed-replacement",
            TerminalInputHandle {
                session_id: Some("shell-input-closed-replacement".into()),
                tx,
                cancel_tx,
                pending: Arc::clone(&pending),
                task,
            },
        );
        let state = Arc::clone(&conn.state);
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_thread = std::thread::spawn(move || {
            let _guard = pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            locked_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        locked_rx.recv().unwrap();

        let enqueue = tokio::spawn(async move {
            let mut conn = conn;
            assert!(
                conn.handle(ClientFrame::TermInput {
                    task_id: "shell-input-closed-replacement".into(),
                    data_b64: b64(b"pre-replacement"),
                })
                .await
            );
            conn
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while state.task_input.operator_admission_capture_count() < 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("input frame did not capture its original admission");

        state
            .task_input
            .begin_session_replacement("shell-input-closed-replacement");
        state
            .task_input
            .finish_session_replacement("shell-input-closed-replacement");
        release_tx.send(()).unwrap();
        let mut conn = enqueue.await.unwrap();
        lock_thread.join().unwrap();

        assert_eq!(
            state.task_input.operator_admission_capture_count(),
            1,
            "worker refresh retargeted the frame by recapturing admission"
        );
        conn.shutdown().await;
    }

    #[tokio::test]
    async fn cancellation_between_reservation_and_send_cannot_also_deliver_on_retry() {
        let (tx, input_rx) = mpsc::channel(1);
        let input_rx = Arc::new(Mutex::new(Some(input_rx)));
        let task = tokio::spawn(std::future::pending::<()>());
        let (cancel_tx, _cancel_rx) = watch::channel(false);
        let pending = Arc::new(Mutex::new(TerminalInputPending::default()));
        let canceled = Arc::new(AtomicUsize::new(0));
        let callback_pending = Arc::clone(&pending);
        let callback_input_rx = Arc::clone(&input_rx);
        let callback_canceled = Arc::clone(&canceled);
        install_terminal_input_send_test_hook("shell-input-reservation-race", move || {
            let mut pending = callback_pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            callback_canceled.store(pending.queued, Ordering::Release);
            pending.retiring = true;
            pending.queued = 0;
            callback_input_rx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
        });
        let (mut conn, _outbound_rx) = terminal_input_conn_with_worker(
            "terminal-input-reservation-race",
            "shell-input-reservation-race",
            TerminalInputHandle {
                session_id: Some("shell-input-reservation-race".into()),
                tx,
                cancel_tx,
                pending,
                task,
            },
        );

        assert!(
            conn.handle(ClientFrame::TermInput {
                task_id: "shell-input-reservation-race".into(),
                data_b64: b64(b"single-delivery"),
            })
            .await
        );
        let accepted = {
            let pending = conn
                .terminal_inputs
                .get("shell-input-reservation-race")
                .expect("terminal input worker")
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            pending.queued + pending.in_flight
        };
        assert!(
            canceled.load(Ordering::Acquire) == 0 || accepted == 0,
            "the same frame was counted as canceled and accepted by the retry"
        );
        conn.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_input_replaces_self_retired_worker_before_accepting_frame() {
        let (tx, input_rx) = mpsc::channel(1);
        let task = tokio::spawn(async move {
            let _input_rx = input_rx;
            std::future::pending::<()>().await;
        });
        let stale_abort = task.abort_handle();
        let (cancel_tx, _cancel_rx) = watch::channel(false);
        let stale_pending = Arc::new(Mutex::new(TerminalInputPending {
            queued: 0,
            in_flight: 0,
            retiring: true,
        }));
        let (mut conn, _outbound_rx) = terminal_input_conn_with_worker(
            "terminal-input-self-retired",
            "shell-input-self-retired",
            TerminalInputHandle {
                session_id: Some("shell-input-self-retired".into()),
                tx,
                cancel_tx,
                pending: Arc::clone(&stale_pending),
                task,
            },
        );

        assert!(
            conn.handle(ClientFrame::TermInput {
                task_id: "shell-input-self-retired".into(),
                data_b64: b64(b"accepted-by-replacement"),
            })
            .await
        );
        let replacement_pending = Arc::clone(
            &conn
                .terminal_inputs
                .get("shell-input-self-retired")
                .expect("replacement worker")
                .pending,
        );
        assert!(!Arc::ptr_eq(&replacement_pending, &stale_pending));
        let (retiring, accepted) = {
            let pending = replacement_pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (pending.retiring, pending.queued + pending.in_flight)
        };
        assert!(!retiring);
        assert_eq!(accepted, 1);
        tokio::task::yield_now().await;
        assert!(stale_abort.is_finished());
        conn.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn idle_terminal_input_worker_marks_itself_retiring_before_exit() {
        let state = Arc::new(AppState::new(test_config(
            "terminal-input-idle-retirement",
            "Terminal Input Idle Retirement",
        )));
        let (_tx, input_rx) = mpsc::channel(1);
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        let pending = Arc::new(Mutex::new(TerminalInputPending::default()));
        let (frame_tx, _companion_tx, _outbound_rx) = outbound_frame_channel(1);
        let task = tokio::spawn(run_terminal_input(
            state,
            "shell-input-idle-retirement".into(),
            Some("shell-input-idle-retirement".into()),
            input_rx,
            cancel_rx,
            Arc::clone(&pending),
            frame_tx,
        ));

        tokio::task::yield_now().await;
        tokio::time::advance(TERMINAL_INPUT_IDLE_TIMEOUT).await;
        task.await.expect("idle worker exits cleanly");
        assert!(
            pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .retiring
        );
    }

    #[tokio::test]
    async fn oversized_terminal_input_is_rejected_before_worker_allocation() {
        let state = Arc::new(AppState::new(test_config(
            "terminal-input-too-large",
            "Terminal Input Too Large",
        )));
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let mut conn = StreamConn {
            state,
            frame_tx,
            companion_tx,
            attachments: HashMap::new(),
            terminal_controls: HashMap::new(),
            terminal_inputs: HashMap::new(),
            agent_commands: None,
            requests: None,
            companion_events: None,
            authed: true,
            supports_companion_event_epoch: false,
            legacy_companion_tasks_on_connection: HashSet::new(),
            auth_mode: AuthMode::AllowEmpty,
            companion_access: true,
        };

        assert!(
            conn.handle(ClientFrame::TermInput {
                task_id: "shell-too-large".into(),
                data_b64: b64(&vec![b'x'; 64 * 1024 + 1]),
            })
            .await
        );
        assert!(conn.terminal_inputs.is_empty());
        assert!(matches!(
            outbound_rx.recv().await,
            Some(ServerFrame::Error {
                task_id: Some(task_id),
                code,
                ..
            }) if task_id == "shell-too-large" && code == "terminal_input_too_large"
        ));
        conn.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_input_routes_are_bounded_per_connection() {
        let state = Arc::new(AppState::new(test_config(
            "terminal-input-route-limit",
            "Terminal Input Route Limit",
        )));
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(1);
        let mut conn = StreamConn {
            state,
            frame_tx,
            companion_tx,
            attachments: HashMap::new(),
            terminal_controls: HashMap::new(),
            terminal_inputs: HashMap::new(),
            agent_commands: None,
            requests: None,
            companion_events: None,
            authed: true,
            supports_companion_event_epoch: false,
            legacy_companion_tasks_on_connection: HashSet::new(),
            auth_mode: AuthMode::AllowEmpty,
            companion_access: true,
        };

        for index in 0..MAX_TERMINAL_INPUT_ROUTES {
            let task_id = format!("shell-route-limit-{index}");
            let input = conn.create_terminal_input(task_id.clone(), Some(task_id.clone()));
            conn.terminal_inputs.insert(task_id, input);
        }

        assert!(
            conn.handle(ClientFrame::TermInput {
                task_id: "shell-route-limit-overflow".into(),
                data_b64: b64(b"rejected"),
            })
            .await
        );
        assert_eq!(conn.terminal_inputs.len(), MAX_TERMINAL_INPUT_ROUTES);
        assert!(!conn
            .terminal_inputs
            .contains_key("shell-route-limit-overflow"));
        assert!(matches!(
            outbound_rx.recv().await,
            Some(ServerFrame::Error {
                task_id: Some(task_id),
                code,
                ..
            }) if task_id == "shell-route-limit-overflow"
                && code == "terminal_input_resource_limit"
        ));

        conn.frame_tx
            .try_send(ServerFrame::Error {
                task_id: None,
                code: "saturated".into(),
                message: "hold outbound capacity".into(),
            })
            .expect("saturate outbound queue");
        for index in 0..(MAX_TERMINAL_INPUT_ROUTES * 2) {
            assert!(
                conn.handle(ClientFrame::TermInput {
                    task_id: format!("shell-route-limit-saturated-{index}"),
                    data_b64: b64(b"rejected"),
                })
                .await
            );
        }
        tokio::task::yield_now().await;
        assert_eq!(conn.terminal_inputs.len(), MAX_TERMINAL_INPUT_ROUTES);
        assert_eq!(outbound_rx.frame_rx.len(), 1);
        conn.shutdown().await;
    }

    #[derive(Clone, Copy)]
    enum TerminalInputRetirement {
        Detach,
        Replace,
        Shutdown,
    }

    async fn assert_blocked_and_queued_input_are_canceled(action: TerminalInputRetirement) {
        let coordinator = crate::task_input_queue::TaskInputCoordinator::new(
            "/unused".into(),
            Db::test_db_path("terminal-input-lifecycle-cancel"),
        );
        let (tx, mut input_rx) = mpsc::channel(2);
        for data in [b"blocked".as_slice(), b"queued".as_slice()] {
            tx.try_send(TerminalInputRequest {
                data: data.to_vec(),
                admission: coordinator.capture_operator_admission(Some("session-lifecycle-cancel")),
            })
            .unwrap();
        }
        let first_blocked = Arc::new(tokio::sync::Notify::new());
        let task_blocked = Arc::clone(&first_blocked);
        let task = tokio::spawn(async move {
            let _blocked = input_rx.recv().await.expect("receive blocked input");
            task_blocked.notify_one();
            let _input_rx = input_rx;
            std::future::pending::<()>().await;
        });
        let (cancel_tx, _cancel_rx) = watch::channel(false);
        let (mut conn, mut outbound_rx) = terminal_input_conn_with_worker(
            "terminal-input-lifecycle-cancel",
            "task-lifecycle-cancel",
            TerminalInputHandle {
                session_id: Some("session-lifecycle-cancel".into()),
                tx,
                cancel_tx,
                pending: Arc::new(Mutex::new(TerminalInputPending {
                    queued: 1,
                    in_flight: 1,
                    retiring: false,
                })),
                task,
            },
        );
        tokio::time::timeout(Duration::from_millis(300), first_blocked.notified())
            .await
            .expect("first accepted input did not block");

        match action {
            TerminalInputRetirement::Detach => {
                tokio::time::timeout(
                    Duration::from_millis(300),
                    conn.handle(ClientFrame::Detach {
                        task_id: "task-lifecycle-cancel".into(),
                        kind: StreamKind::Terminal,
                        attachment_epoch: None,
                    }),
                )
                .await
                .expect("terminal detach hung behind blocked input");
            }
            TerminalInputRetirement::Replace => {
                tokio::time::timeout(
                    Duration::from_millis(300),
                    conn.replace_terminal_input_route(
                        "task-lifecycle-cancel",
                        "session-lifecycle-replacement".into(),
                    ),
                )
                .await
                .expect("terminal route replacement hung behind blocked input");
            }
            TerminalInputRetirement::Shutdown => {
                tokio::time::timeout(Duration::from_millis(300), conn.shutdown())
                    .await
                    .expect("socket shutdown hung behind blocked input");
            }
        }
        assert!(matches!(
            tokio::time::timeout(Duration::from_millis(300), outbound_rx.recv())
                .await
                .expect("retirement silently dropped accepted terminal input"),
            Some(ServerFrame::Error {
                task_id: Some(task_id),
                code,
                message,
            }) if task_id == "task-lifecycle-cancel"
                && code == "terminal_input_canceled"
                && message.contains("canceled 1 queued")
                && message.contains("1 in-flight")
        ));
        if !matches!(action, TerminalInputRetirement::Shutdown) {
            conn.shutdown().await;
        }
    }

    #[tokio::test]
    async fn terminal_detach_cancels_blocked_and_queued_input_without_hanging() {
        assert_blocked_and_queued_input_are_canceled(TerminalInputRetirement::Detach).await;
    }

    #[tokio::test]
    async fn terminal_route_replacement_cancels_blocked_and_queued_input_without_hanging() {
        assert_blocked_and_queued_input_are_canceled(TerminalInputRetirement::Replace).await;
    }

    #[tokio::test]
    async fn socket_shutdown_cancels_blocked_and_queued_input_without_hanging() {
        assert_blocked_and_queued_input_are_canceled(TerminalInputRetirement::Shutdown).await;
    }

    #[tokio::test]
    async fn route_replacement_cancels_old_worker_during_reconnect_backoff() {
        let unique = format!(
            "ksp-terminal-cancel-backoff-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-terminal-cancel-backoff", "KSP Cancel Backoff");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");
        let _db = Db::open_for_tests(&config.db_path).expect("open test db");

        let state = Arc::new(AppState::new(config.clone()));
        let (frame_tx, companion_tx, _outbound_rx) = outbound_frame_channel(8);
        let mut conn = StreamConn {
            state,
            frame_tx,
            companion_tx,
            attachments: HashMap::new(),
            terminal_controls: HashMap::new(),
            terminal_inputs: HashMap::new(),
            agent_commands: None,
            requests: None,
            companion_events: None,
            authed: true,
            supports_companion_event_epoch: false,
            legacy_companion_tasks_on_connection: HashSet::new(),
            auth_mode: AuthMode::AllowEmpty,
            companion_access: true,
        };

        conn.replace_terminal_control_route("task-route", "daemon-session-old".into())
            .await;
        conn.enqueue_terminal_control(
            "task-route".into(),
            TerminalControlCommand::Input(b"stale".to_vec()),
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        conn.replace_terminal_control_route("task-route", "daemon-session-new".into())
            .await;
        conn.enqueue_terminal_control(
            "task-route".into(),
            TerminalControlCommand::Input(b"fresh".to_vec()),
        );
        let (daemon, mut commands) =
            spawn_fake_control_daemon_across_connections(config.daemon_dir.clone()).await;

        let first = tokio::time::timeout(std::time::Duration::from_secs(2), commands.recv())
            .await
            .expect("replacement worker did not reconnect")
            .expect("fake daemon closed before replacement input");
        let first = serde_json::to_value(first).unwrap();
        assert_eq!(first["session_id"], "daemon-session-new");
        assert_eq!(first["data"], serde_json::json!([102, 114, 101, 115, 104]));

        let stale =
            tokio::time::timeout(std::time::Duration::from_millis(700), commands.recv()).await;
        assert!(stale.is_err(), "cancelled worker delivered stale input");

        daemon.abort();
        conn.shutdown().await;
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn terminal_detach_retires_control_and_input_workers() {
        let state = Arc::new(AppState::new(test_config(
            "ksp-terminal-detach-control",
            "KSP Terminal Detach Control",
        )));
        let (frame_tx, companion_tx, _outbound_rx) = outbound_frame_channel(8);
        let mut conn = StreamConn {
            state,
            frame_tx,
            companion_tx,
            attachments: HashMap::new(),
            terminal_controls: HashMap::new(),
            terminal_inputs: HashMap::new(),
            agent_commands: None,
            requests: None,
            companion_events: None,
            authed: true,
            supports_companion_event_epoch: false,
            legacy_companion_tasks_on_connection: HashSet::new(),
            auth_mode: AuthMode::AllowEmpty,
            companion_access: true,
        };
        conn.replace_terminal_control_route("task-detach", "daemon-session-detach".into())
            .await;
        conn.replace_terminal_input_route("task-detach", "daemon-session-detach".into())
            .await;
        assert!(conn.terminal_controls.contains_key("task-detach"));
        assert!(conn.terminal_inputs.contains_key("task-detach"));

        assert!(
            conn.handle(ClientFrame::Detach {
                task_id: "task-detach".into(),
                kind: StreamKind::Terminal,
                attachment_epoch: None,
            })
            .await
        );

        assert!(!conn.terminal_controls.contains_key("task-detach"));
        assert!(!conn.terminal_inputs.contains_key("task-detach"));
        conn.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_attachment_lease_brackets_attach_snapshot_and_stream_end() {
        let unique = format!(
            "ksp-terminal-lease-order-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
        let (attach_started_tx, attach_started_rx) = tokio::sync::oneshot::channel();
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let session_id = "shell-terminal-lease-order";

        let daemon = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept attach connection");
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("read attach command");
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::AttachSnapshot { ref session_id, .. }
                    if session_id == "shell-terminal-lease-order"
            ));
            attach_started_tx.send(()).unwrap();
            reply_rx.await.unwrap();
            for event in [
                DaemonEvent::Snapshot {
                    session_id: session_id.to_string(),
                    snapshot: kanna_daemon::protocol::TerminalSnapshot {
                        version: 1,
                        rows: 24,
                        cols: 80,
                        cursor_row: 0,
                        cursor_col: 0,
                        cursor_visible: true,
                        saved_at: 0,
                        sequence: 0,
                        vt: String::new(),
                    },
                    agent_provider: None,
                },
                DaemonEvent::StatusChanged {
                    session_id: session_id.to_string(),
                    status: SessionStatus::Idle,
                    waiting_prompt_snippet: None,
                },
                DaemonEvent::Exit {
                    session_id: session_id.to_string(),
                    code: 0,
                    resume_session_id: None,
                    killed: false,
                },
            ] {
                write_half
                    .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
                    .await
                    .unwrap();
            }
        });

        let mut config = test_config("ksp-terminal-lease-order", "KSP Lease Order");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        let state = Arc::new(AppState::new(config));
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let mut conn = StreamConn {
            state: Arc::clone(&state),
            frame_tx,
            companion_tx,
            attachments: HashMap::new(),
            terminal_controls: HashMap::new(),
            terminal_inputs: HashMap::new(),
            agent_commands: None,
            requests: None,
            companion_events: None,
            authed: true,
            supports_companion_event_epoch: false,
            legacy_companion_tasks_on_connection: HashSet::new(),
            auth_mode: AuthMode::AllowEmpty,
            companion_access: true,
        };

        conn.attach(
            session_id.to_string(),
            StreamKind::Terminal,
            0,
            true,
            false,
            None,
        )
        .await;
        attach_started_rx.await.unwrap();
        assert!(
            state.terminal_attachments().is_attached(session_id),
            "lease must be held while AttachSnapshot is in flight"
        );

        reply_tx.send(()).unwrap();
        for _ in 0..3 {
            outbound_rx.recv().await.expect("expected terminal frame");
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            while state.terminal_attachments().is_attached(session_id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("lease was not released at stream end");

        daemon.await.unwrap();
        conn.shutdown().await;
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn handoff_lost_attach_marks_the_running_task_recoverable() {
        let unique = format!(
            "ksp-handoff-lost-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let daemon_dir_string = daemon_dir.to_string_lossy().to_string();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir_string);
        let _ = std::fs::remove_file(&socket_path);

        let mut config = test_config(&unique, "KSP Handoff Lost");
        config.daemon_dir = daemon_dir_string.clone();
        let db = crate::db::Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-handoff-lost",
            "repo-1",
            "Continue after handoff",
            Some("Handoff lost"),
            "in progress",
            "2026-07-30 21:09:00",
        )
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-handoff-lost",
            task_id: "task-handoff-lost",
            stage: "in progress",
            kind: "main",
            agent: None,
            agent_provider: Some("claude"),
            model: None,
            effort: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-handoff-lost"),
            provider_session_id: Some("provider-handoff-lost"),
            cwd: Some("/tmp/handoff-lost-worktree"),
            resumed_from_run_id: None,
        })
        .unwrap();

        let listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
        let daemon = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept daemon connection");
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::AttachSnapshot { ref session_id, .. }
                    if session_id == "task-handoff-lost"
            ));
            write_half
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&DaemonEvent::Error {
                            code: Some(kanna_daemon::protocol::ErrorCode::HandoffLost),
                            message: "session lost during daemon handoff: fd missing".to_string(),
                        })
                        .unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let state = AppState::new(config);
        let (frame_tx, mut frame_rx) = mpsc::channel(2);
        let mut attached_once = false;
        assert!(matches!(
            stream_terminal_once(
                &state,
                &daemon_dir_string,
                "task-handoff-lost",
                "task-handoff-lost",
                &mut attached_once,
                &frame_tx,
            )
            .await,
            StreamRunEnd::Done
        ));
        assert!(matches!(
            frame_rx.try_recv(),
            Ok(ServerFrame::Error { ref code, .. }) if code == "handoff_lost"
        ));
        let run = db.latest_stage_run("task-handoff-lost").unwrap().unwrap();
        assert_eq!(run.status, "failed");
        assert!(run
            .result
            .as_deref()
            .is_some_and(|result| result.contains("kanna_resume_task")));

        daemon.await.unwrap();
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn terminal_stream_forwards_queued_initial_and_live_status_without_synthesis() {
        let unique = format!(
            "ksp-terminal-status-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let daemon_dir_string = daemon_dir.to_string_lossy().to_string();
        let socket_path = daemon_socket_path_for_dir(&daemon_dir_string);
        let _ = std::fs::remove_file(&socket_path);

        let daemon_listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
        let daemon = tokio::spawn(async move {
            let (stream, _) = daemon_listener
                .accept()
                .await
                .expect("accept daemon connection");
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("read attach snapshot command");
            let command: DaemonCommand =
                serde_json::from_str(line.trim()).expect("parse attach snapshot command");
            assert!(matches!(
                command,
                DaemonCommand::AttachSnapshot { ref session_id, .. }
                    if session_id == "daemon-terminal-status"
            ));

            let events = [
                DaemonEvent::Snapshot {
                    session_id: "daemon-terminal-status".to_string(),
                    snapshot: kanna_daemon::protocol::TerminalSnapshot {
                        version: 1,
                        rows: 24,
                        cols: 80,
                        cursor_row: 0,
                        cursor_col: 0,
                        cursor_visible: true,
                        saved_at: 0,
                        sequence: 0,
                        vt: "busy snapshot".to_string(),
                    },
                    agent_provider: None,
                },
                // AttachSnapshot registers the subscriber with both the
                // authoritative snapshot and this initial status event.
                DaemonEvent::StatusChanged {
                    session_id: "daemon-terminal-status".to_string(),
                    status: SessionStatus::Busy,
                    waiting_prompt_snippet: None,
                },
                DaemonEvent::StatusChanged {
                    session_id: "another-session".to_string(),
                    status: SessionStatus::Idle,
                    waiting_prompt_snippet: None,
                },
                DaemonEvent::StatusChanged {
                    session_id: "daemon-terminal-status".to_string(),
                    status: SessionStatus::Waiting,
                    waiting_prompt_snippet: None,
                },
                DaemonEvent::Exit {
                    session_id: "daemon-terminal-status".to_string(),
                    code: 0,
                    resume_session_id: None,
                    killed: false,
                },
            ];
            for event in events {
                write_half
                    .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
                    .await
                    .expect("write daemon event");
            }
        });

        let mut config = test_config(&unique, "KSP Terminal Status");
        config.daemon_dir = daemon_dir_string.clone();
        let state = AppState::new(config);
        let (frame_tx, mut frame_rx) = mpsc::channel(8);
        let mut attached_once = false;
        assert!(matches!(
            stream_terminal_once(
                &state,
                &daemon_dir_string,
                "task-status",
                "daemon-terminal-status",
                &mut attached_once,
                &frame_tx,
            )
            .await,
            StreamRunEnd::Done
        ));

        assert!(matches!(
            frame_rx.try_recv(),
            Ok(ServerFrame::TermSnapshot { ref task_id, .. }) if task_id == "task-status"
        ));
        assert!(matches!(
            frame_rx.try_recv(),
            Ok(ServerFrame::StatusChanged { ref task_id, ref status })
                if task_id == "task-status" && status == "busy"
        ));
        assert!(matches!(
            frame_rx.try_recv(),
            Ok(ServerFrame::StatusChanged { ref task_id, ref status })
                if task_id == "task-status" && status == "waiting"
        ));
        assert!(matches!(
            frame_rx.try_recv(),
            Ok(ServerFrame::SessionExit { ref task_id, code: 0 }) if task_id == "task-status"
        ));
        assert!(
            frame_rx.try_recv().is_err(),
            "other-session status was forwarded"
        );

        daemon.await.expect("fake daemon task failed");
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn terminal_stream_preserves_snapshot_and_split_multibyte_output_bytes() {
        let unique = format!(
            "ksp-terminal-bytes-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);

        let daemon_listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
        let daemon = tokio::spawn(async move {
            let (stream, _) = daemon_listener
                .accept()
                .await
                .expect("accept daemon connection");
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("read attach snapshot command");
            let command: DaemonCommand =
                serde_json::from_str(line.trim()).expect("parse attach snapshot command");
            match command {
                DaemonCommand::AttachSnapshot {
                    session_id,
                    emulate_terminal,
                } => {
                    assert_eq!(session_id, "daemon-terminal-1");
                    assert!(emulate_terminal);
                }
                other => panic!("expected AttachSnapshot command, got {other:?}"),
            }

            let snapshot = DaemonEvent::Snapshot {
                session_id: "daemon-terminal-1".to_string(),
                snapshot: kanna_daemon::protocol::TerminalSnapshot {
                    version: 1,
                    rows: 24,
                    cols: 80,
                    cursor_row: 1,
                    cursor_col: 0,
                    cursor_visible: true,
                    saved_at: 0,
                    sequence: 0,
                    vt: "╭─界─╮\n".to_string(),
                },
                agent_provider: Some(kanna_daemon::protocol::AgentProvider::Claude),
            };
            let initial_status = DaemonEvent::StatusChanged {
                session_id: "daemon-terminal-1".to_string(),
                status: SessionStatus::Idle,
                waiting_prompt_snippet: None,
            };
            let output_prefix = DaemonEvent::Output {
                session_id: "daemon-terminal-1".to_string(),
                data: vec![0xf0, 0x9f],
            };
            let output_suffix = DaemonEvent::Output {
                session_id: "daemon-terminal-1".to_string(),
                data: vec![0x98, 0x80, b'\n'],
            };
            // A lag resync arrives as a mid-stream Snapshot on the same
            // connection and must be forwarded like the attach snapshot.
            let resync_snapshot = DaemonEvent::Snapshot {
                session_id: "daemon-terminal-1".to_string(),
                snapshot: kanna_daemon::protocol::TerminalSnapshot {
                    version: 1,
                    rows: 24,
                    cols: 80,
                    cursor_row: 2,
                    cursor_col: 0,
                    cursor_visible: true,
                    saved_at: 0,
                    sequence: 0,
                    vt: "RESYNCED\n".to_string(),
                },
                agent_provider: Some(kanna_daemon::protocol::AgentProvider::Claude),
            };
            let resync_status = DaemonEvent::StatusChanged {
                session_id: "daemon-terminal-1".to_string(),
                status: SessionStatus::Busy,
                waiting_prompt_snippet: None,
            };
            let exit = DaemonEvent::Exit {
                session_id: "daemon-terminal-1".to_string(),
                code: 0,
                resume_session_id: None,
                killed: false,
            };

            for event in [
                snapshot,
                initial_status,
                output_prefix,
                output_suffix,
                resync_snapshot,
                resync_status,
                exit,
            ] {
                write_half
                    .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
                    .await
                    .expect("write daemon event");
            }
        });

        let mut config = test_config("ksp-terminal-bytes", "KSP Terminal Bytes");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");

        let db = Db::open_for_tests(&config.db_path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One")
            .expect("insert repo");
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Terminal bytes",
            None,
            "in progress",
            "2026-06-20T00:00:00Z",
        )
        .expect("insert task");
        db.insert_test_terminal_session(
            "terminal-1",
            "repo-1",
            "task-1",
            "agent",
            "daemon-terminal-1",
        )
        .expect("insert terminal session");

        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Terminal,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;

        let decode = |data_b64: String| {
            base64::engine::general_purpose::STANDARD
                .decode(data_b64)
                .expect("decode terminal frame")
        };

        match recv_frame(&mut socket).await {
            ServerFrame::TermSnapshot {
                task_id,
                cols,
                rows,
                data_b64,
                agent_provider,
            } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
                assert_eq!(decode(data_b64), "╭─界─╮\n".as_bytes());
                assert_eq!(
                    agent_provider,
                    Some(kanna_agent_protocol::AgentProvider::Claude)
                );
            }
            other => panic!("expected terminal snapshot, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::StatusChanged { task_id, status } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(status, "idle");
            }
            other => panic!("expected initial terminal status, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::TermOutput { task_id, data_b64 } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(decode(data_b64), vec![0xf0, 0x9f]);
            }
            other => panic!("expected first terminal output, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::TermOutput { task_id, data_b64 } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(decode(data_b64), vec![0x98, 0x80, b'\n']);
            }
            other => panic!("expected second terminal output, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::TermSnapshot {
                task_id, data_b64, ..
            } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(decode(data_b64), b"RESYNCED\n");
            }
            other => panic!("expected mid-stream resync snapshot, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::StatusChanged { task_id, status } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(status, "busy");
            }
            other => panic!("expected resync terminal status, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::SessionExit { task_id, code } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(code, 0);
            }
            other => panic!("expected session exit, got {other:?}"),
        }

        daemon.await.expect("fake daemon task failed");
        drop(socket);
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn terminal_stream_reattaches_after_daemon_connection_loss() {
        let unique = format!(
            "ksp-terminal-reattach-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);

        let session_id = "shell-wt-reattach-1";

        // A daemon that dies after the first attach (connection dropped with
        // no Exit event — the handoff/restart shape) and then serves a second
        // attach from its replacement.
        let daemon_listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
        let daemon = tokio::spawn(async move {
            for round in 0..2u32 {
                let (stream, _) = daemon_listener
                    .accept()
                    .await
                    .expect("accept daemon connection");
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                reader.read_line(&mut line).await.expect("read command");
                let command: DaemonCommand =
                    serde_json::from_str(line.trim()).expect("parse command");
                match command {
                    DaemonCommand::AttachSnapshot {
                        session_id: attached,
                        ..
                    } => assert_eq!(attached, "shell-wt-reattach-1"),
                    other => panic!("expected AttachSnapshot, got {other:?}"),
                }

                let vt = if round == 0 {
                    "before restart"
                } else {
                    "after restart"
                };
                let mut events = vec![
                    DaemonEvent::Snapshot {
                        session_id: "shell-wt-reattach-1".to_string(),
                        snapshot: kanna_daemon::protocol::TerminalSnapshot {
                            version: 1,
                            rows: 24,
                            cols: 80,
                            cursor_row: 0,
                            cursor_col: 0,
                            cursor_visible: true,
                            saved_at: 0,
                            sequence: 0,
                            vt: vt.to_string(),
                        },
                        agent_provider: None,
                    },
                    DaemonEvent::StatusChanged {
                        session_id: "shell-wt-reattach-1".to_string(),
                        status: SessionStatus::Idle,
                        waiting_prompt_snippet: None,
                    },
                    DaemonEvent::Output {
                        session_id: "shell-wt-reattach-1".to_string(),
                        data: format!("output {round}").into_bytes(),
                    },
                ];
                if round == 1 {
                    events.push(DaemonEvent::Exit {
                        session_id: "shell-wt-reattach-1".to_string(),
                        code: 0,
                        resume_session_id: None,
                        killed: false,
                    });
                }
                for event in events {
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes(),
                        )
                        .await
                        .expect("write daemon event");
                }
                // round 0: drop the connection here without an Exit event.
            }
        });

        let mut config = test_config("ksp-terminal-reattach", "KSP Terminal Reattach");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");

        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: session_id.into(),
                kind: StreamKind::Terminal,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;

        let decode = |data_b64: String| {
            base64::engine::general_purpose::STANDARD
                .decode(data_b64)
                .expect("decode terminal frame")
        };

        // First attach: snapshot + output, then the daemon connection dies.
        match recv_frame(&mut socket).await {
            ServerFrame::TermSnapshot { data_b64, .. } => {
                assert_eq!(decode(data_b64), b"before restart");
            }
            other => panic!("expected first snapshot, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::StatusChanged { status, .. } => assert_eq!(status, "idle"),
            other => panic!("expected first snapshot status, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::TermOutput { data_b64, .. } => {
                assert_eq!(decode(data_b64), b"output 0");
            }
            other => panic!("expected first output, got {other:?}"),
        }

        // The stream must transparently re-attach (no client action, no error
        // frame) and resync with a fresh snapshot instead of going silent.
        match recv_frame(&mut socket).await {
            ServerFrame::TermSnapshot { data_b64, .. } => {
                assert_eq!(decode(data_b64), b"after restart");
            }
            other => panic!("expected re-attach snapshot, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::StatusChanged { status, .. } => assert_eq!(status, "idle"),
            other => panic!("expected re-attach snapshot status, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::TermOutput { data_b64, .. } => {
                assert_eq!(decode(data_b64), b"output 1");
            }
            other => panic!("expected post-restart output, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::SessionExit { code, .. } => assert_eq!(code, 0),
            other => panic!("expected session exit, got {other:?}"),
        }

        daemon.await.expect("fake daemon task failed");
        drop(socket);
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn agent_stream_reattaches_from_last_seq_after_daemon_connection_loss() {
        let unique = format!(
            "ksp-agent-reattach-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let socket_path = daemon_socket_path_for_dir(&daemon_dir.to_string_lossy());
        let _ = std::fs::remove_file(&socket_path);

        let daemon_listener = UnixListener::bind(&socket_path).expect("bind fake daemon socket");
        let daemon = tokio::spawn(async move {
            // Round 0: attach from seq 0, snapshot to next_seq=2, one live
            // event at seq 2, then the connection dies without warning.
            // Round 1: the replacement daemon must be asked for seq 3.
            for round in 0..2u32 {
                let (stream, _) = daemon_listener
                    .accept()
                    .await
                    .expect("accept daemon connection");
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                reader.read_line(&mut line).await.expect("read command");
                let command: DaemonCommand =
                    serde_json::from_str(line.trim()).expect("parse command");
                let from_seq = match command {
                    DaemonCommand::AttachAgent {
                        session_id,
                        from_seq,
                    } => {
                        assert_eq!(session_id, "daemon-agent-reattach-1");
                        from_seq
                    }
                    other => panic!("expected AttachAgent, got {other:?}"),
                };
                if round == 0 {
                    assert_eq!(from_seq, 0);
                } else {
                    assert_eq!(
                        from_seq, 3,
                        "re-attach must resume from the last forwarded seq"
                    );
                }

                let events = if round == 0 {
                    vec![
                        DaemonEvent::AgentSnapshot {
                            session_id: "daemon-agent-reattach-1".to_string(),
                            next_seq: 2,
                            events: vec![],
                        },
                        DaemonEvent::AgentEvent {
                            session_id: "daemon-agent-reattach-1".to_string(),
                            seq: 2,
                            event: kanna_daemon::protocol::NeutralAgentEvent::AssistantText {
                                text: "before restart".to_string(),
                                truncated: false,
                            },
                        },
                    ]
                } else {
                    vec![
                        DaemonEvent::AgentSnapshot {
                            session_id: "daemon-agent-reattach-1".to_string(),
                            next_seq: 3,
                            events: vec![],
                        },
                        DaemonEvent::AgentEvent {
                            session_id: "daemon-agent-reattach-1".to_string(),
                            seq: 3,
                            event: kanna_daemon::protocol::NeutralAgentEvent::AssistantText {
                                text: "after restart".to_string(),
                                truncated: false,
                            },
                        },
                    ]
                };
                for event in events {
                    write_half
                        .write_all(
                            format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes(),
                        )
                        .await
                        .expect("write daemon event");
                }
            }
        });

        let mut config = test_config("ksp-agent-reattach", "KSP Agent Reattach");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");

        let db = Db::open_for_tests(&config.db_path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One")
            .expect("insert repo");
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Agent reattach",
            None,
            "in progress",
            "2026-07-05T00:00:00Z",
        )
        .expect("insert task");
        db.insert_test_terminal_session(
            "terminal-1",
            "repo-1",
            "task-1",
            "agent",
            "daemon-agent-reattach-1",
        )
        .expect("insert terminal session");

        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "task-1".into(),
                kind: StreamKind::Agent,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;

        match recv_frame(&mut socket).await {
            ServerFrame::AgentSnapshot { next_seq, .. } => assert_eq!(next_seq, 2),
            other => panic!("expected first agent snapshot, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::AgentEvent { seq, .. } => assert_eq!(seq, 2),
            other => panic!("expected first agent event, got {other:?}"),
        }
        // Daemon connection lost; the stream re-attaches from seq 3 and keeps
        // flowing without any client-side action.
        match recv_frame(&mut socket).await {
            ServerFrame::AgentSnapshot { next_seq, .. } => assert_eq!(next_seq, 3),
            other => panic!("expected re-attach agent snapshot, got {other:?}"),
        }
        match recv_frame(&mut socket).await {
            ServerFrame::AgentEvent { seq, .. } => assert_eq!(seq, 3),
            other => panic!("expected post-restart agent event, got {other:?}"),
        }

        daemon.await.expect("fake daemon task failed");
        drop(socket);
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn shell_terminal_attach_routes_directly_to_daemon_session() {
        let unique = format!(
            "ksp-shell-attach-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-shell-attach", "KSP Shell Attach");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");

        let daemon = spawn_fake_daemon_once_with_response(
            config.daemon_dir.clone(),
            DaemonEvent::Snapshot {
                session_id: "shell-wt-task-1".to_string(),
                snapshot: kanna_daemon::protocol::TerminalSnapshot {
                    version: 1,
                    rows: 24,
                    cols: 80,
                    cursor_row: 0,
                    cursor_col: 0,
                    cursor_visible: true,
                    saved_at: 0,
                    sequence: 0,
                    vt: "shell prompt".to_string(),
                },
                agent_provider: None,
            },
        )
        .await;
        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));
        send_frame(
            &mut socket,
            &ClientFrame::Attach {
                task_id: "shell-wt-task-1".into(),
                kind: StreamKind::Terminal,
                from_seq: 0,
                include_assets: None,
                accept_snapshot_chunks: None,
                attachment_epoch: None,
            },
        )
        .await;

        match recv_frame(&mut socket).await {
            ServerFrame::TermSnapshot {
                task_id,
                cols,
                rows,
                data_b64,
                ..
            } => {
                assert_eq!(task_id, "shell-wt-task-1");
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(data_b64.as_bytes())
                    .expect("decode terminal snapshot");
                assert_eq!(String::from_utf8(decoded).unwrap(), "shell prompt");
            }
            other => panic!("expected TermSnapshot, got {other:?}"),
        }

        let command = tokio::time::timeout(std::time::Duration::from_secs(5), daemon)
            .await
            .expect("timed out waiting for daemon command")
            .expect("fake daemon task failed");
        match command {
            DaemonCommand::AttachSnapshot {
                session_id,
                emulate_terminal,
            } => {
                assert_eq!(session_id, "shell-wt-task-1");
                assert!(emulate_terminal);
            }
            other => panic!("expected AttachSnapshot command, got {other:?}"),
        }

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[tokio::test]
    async fn agent_set_model_frame_routes_to_daemon_command() {
        let unique = format!(
            "ksp-set-model-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        let mut config = test_config("ksp-set-model", "KSP Set Model");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        config.db_path = Db::test_db_path(&unique);
        config.pairing_store_path = format!("/tmp/kanna-pairings-{unique}.json");

        let db = Db::open_for_tests(&config.db_path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One")
            .expect("insert repo");
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Switch models",
            None,
            "in progress",
            "2026-06-17T00:00:00Z",
        )
        .expect("insert task");
        db.insert_test_terminal_session(
            "terminal-1",
            "repo-1",
            "task-1",
            "agent",
            "daemon-agent-1",
        )
        .expect("insert terminal session");

        let daemon = spawn_fake_daemon_once(config.daemon_dir.clone()).await;
        let router = crate::http_api::router(Arc::new(AppState::new(config)));
        let url = serve_router(router).await;
        let mut socket = ws_connect(&url).await;

        send_frame(&mut socket, &client_auth_frame()).await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));
        send_frame(
            &mut socket,
            &ClientFrame::AgentSetModel {
                task_id: "task-1".into(),
                model: "claude-haiku-4-5-20251001".into(),
            },
        )
        .await;

        let command = tokio::time::timeout(std::time::Duration::from_secs(5), daemon)
            .await
            .expect("timed out waiting for daemon command")
            .expect("fake daemon task failed");
        match command {
            DaemonCommand::AgentSetModel { session_id, model } => {
                assert_eq!(session_id, "daemon-agent-1");
                assert_eq!(model, "claude-haiku-4-5-20251001");
            }
            other => panic!("expected AgentSetModel command, got {other:?}"),
        }

        drop(socket);
        let _ = std::fs::remove_dir_all(&daemon_dir);
    }

    #[test]
    fn relay_tunnel_control_frames_are_ignored_by_ksp() {
        assert!(is_relay_tunnel_control_message(
            r#"{"type":"tunnel_ready","tunnelId":"t1","desktopId":"desktop-1"}"#
        ));
        assert!(!is_relay_tunnel_control_message(
            r#"{"type":"auth","credential":"token"}"#
        ));
    }

    #[tokio::test]
    async fn tunnel_stream_rejects_missing_or_bad_credential() {
        let state = Arc::new(crate::http_api::AppState::new(test_config(
            "ksp-auth-test",
            "KSP Auth Test",
        )));
        let (incoming_tx, incoming_rx) = mpsc::channel(8);
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let task = tokio::spawn(handle_stream_channels(
            incoming_rx,
            frame_tx,
            companion_tx,
            state,
            AuthMode::RequireCredential,
            true,
        ));

        incoming_tx
            .send(serde_json::to_string(&client_auth_frame()).unwrap())
            .await
            .unwrap();
        let frame = outbound_rx.recv().await.expect("error frame");
        match frame {
            ServerFrame::Error { code, .. } => assert_eq!(code, "unauthorized"),
            other => panic!("expected unauthorized error, got {other:?}"),
        }
        drop(incoming_tx);
        let _ = task.await;
    }

    #[tokio::test]
    async fn direct_lan_stream_rejects_empty_paired_device_credential() {
        let state = Arc::new(crate::http_api::AppState::new(test_config(
            "ksp-lan-auth-test",
            "KSP LAN Auth Test",
        )));
        let (incoming_tx, incoming_rx) = mpsc::channel(8);
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let task = tokio::spawn(handle_stream_channels(
            incoming_rx,
            frame_tx,
            companion_tx,
            state,
            AuthMode::RequirePairedDevice,
            false,
        ));

        incoming_tx
            .send(
                serde_json::to_string(&ClientFrame::Auth {
                    credential: None,
                    capabilities: vec![],
                })
                .unwrap(),
            )
            .await
            .unwrap();
        let frame = outbound_rx.recv().await.expect("error frame");
        match frame {
            ServerFrame::Error { code, .. } => assert_eq!(code, "unauthorized"),
            other => panic!("expected unauthorized error, got {other:?}"),
        }
        drop(incoming_tx);
        let _ = task.await;
    }

    #[tokio::test]
    async fn direct_lan_stream_rejects_stale_invalid_and_malformed_device_credentials() {
        let config = test_config("ksp-lan-auth-bad", "KSP LAN Auth Bad");
        let pairing_path = std::path::PathBuf::from(&config.pairing_store_path);
        let mut pairing_store = crate::pairing::PairingStore::default();
        pairing_store.add_trusted_device(
            &config.desktop_id,
            "phone-1",
            "Kanna Mobile",
            &crate::pairing::hash_device_secret("lan-secret"),
        );
        pairing_store.save(&pairing_path).unwrap();

        for credential in [
            serde_json::json!({
                "deviceId": "phone-stale",
                "deviceSecret": "old-secret",
            })
            .to_string(),
            serde_json::json!({
                "deviceId": "phone-1",
                "deviceSecret": "wrong-secret",
            })
            .to_string(),
            r#"{"deviceId":"phone-1"}"#.to_string(),
        ] {
            let state = Arc::new(crate::http_api::AppState::new(config.clone()));
            let (incoming_tx, incoming_rx) = mpsc::channel(8);
            let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
            let task = tokio::spawn(handle_stream_channels(
                incoming_rx,
                frame_tx,
                companion_tx,
                state,
                AuthMode::RequirePairedDevice,
                false,
            ));

            incoming_tx
                .send(
                    serde_json::to_string(&ClientFrame::Auth {
                        credential: Some(credential),
                        capabilities: vec![],
                    })
                    .unwrap(),
                )
                .await
                .unwrap();
            assert!(matches!(
                outbound_rx.recv().await,
                Some(ServerFrame::Error { code, .. }) if code == "unauthorized"
            ));
            drop(incoming_tx);
            task.await.unwrap();
        }
        let _ = std::fs::remove_file(pairing_path);
    }

    async fn serve_non_loopback_test_router(
        desktop_id: &str,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
            .await
            .expect("bind non-loopback KSP listener");
        let port = listener.local_addr().expect("listener address").port();
        let desktop_id = desktop_id.to_string();
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                crate::http_api::test_router(&desktop_id, "KSP Network Auth")
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        let lan_ip = if_addrs::get_if_addrs()
            .expect("enumerate network interfaces")
            .into_iter()
            .map(|interface| interface.ip())
            .find(|ip| ip.is_ipv4() && !ip.is_loopback())
            .expect("test host must expose a non-loopback IPv4 address");
        (format!("ws://{lan_ip}:{port}"), server)
    }

    #[tokio::test]
    async fn previous_mobile_gets_read_only_v1_access_from_current_non_loopback_desktop() {
        let (base_url, server) =
            serve_non_loopback_test_router("ksp-v1-previous-mobile-upgrade").await;
        let mut socket = ws_connect(&format!("{base_url}/v1/stream")).await;

        send_frame(
            &mut socket,
            &ClientFrame::Auth {
                credential: None,
                capabilities: vec![],
            },
        )
        .await;

        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::AuthOk { .. }
        ));
        send_frame(
            &mut socket,
            &ClientFrame::AgentInput {
                task_id: "task-1".into(),
                text: "must remain read-only".into(),
            },
        )
        .await;
        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::Error { code, .. } if code == "unauthorized"
        ));
        server.abort();
    }

    #[tokio::test]
    async fn non_loopback_v1_rejects_agent_terminal_lifecycle_and_file_frames() {
        let (base_url, server) = serve_non_loopback_test_router("ksp-v1-privileged-denial").await;
        let frames = [
            ClientFrame::AgentInput {
                task_id: "task-1".into(),
                text: "must not reach the agent".into(),
            },
            ClientFrame::TermInput {
                task_id: "shell-task-1".into(),
                data_b64: b64(b"must not reach the terminal"),
            },
            ClientFrame::Request {
                id: 1,
                method: "POST".into(),
                path: "/v1/tasks/task-1/actions/advance-stage".into(),
                body: None,
            },
            ClientFrame::Request {
                id: 2,
                method: "POST".into(),
                path: "/v1/tasks/task-1/actions/close".into(),
                body: None,
            },
            ClientFrame::Request {
                id: 3,
                method: "GET".into(),
                path: "/v1/tasks/task-1/files/content?path=secret.txt".into(),
                body: None,
            },
        ];

        for frame in frames {
            let mut socket = ws_connect(&format!("{base_url}/v1/stream")).await;
            send_frame(
                &mut socket,
                &ClientFrame::Auth {
                    credential: None,
                    capabilities: vec![],
                },
            )
            .await;
            assert!(matches!(
                recv_frame(&mut socket).await,
                ServerFrame::AuthOk { .. }
            ));
            send_frame(&mut socket, &frame).await;
            assert!(
                matches!(
                    recv_frame(&mut socket).await,
                    ServerFrame::Error { code, .. } if code == "unauthorized"
                ),
                "non-loopback v1 frame was not denied before dispatch: {frame:?}",
            );
            assert!(
                recv_frame_with_timeout(&mut socket, Duration::from_millis(100))
                    .await
                    .is_none(),
                "non-loopback v1 frame produced a privileged response: {frame:?}",
            );
        }
        server.abort();
    }

    #[tokio::test]
    async fn non_loopback_v2_stream_endpoint_rejects_empty_auth() {
        let (base_url, server) = serve_non_loopback_test_router("ksp-v2-network-auth").await;
        let mut socket = ws_connect(&format!("{base_url}/v2/stream")).await;

        send_frame(
            &mut socket,
            &ClientFrame::Auth {
                credential: None,
                capabilities: vec![],
            },
        )
        .await;

        assert!(matches!(
            recv_frame(&mut socket).await,
            ServerFrame::Error { code, .. } if code == "unauthorized"
        ));
        server.abort();
    }

    #[tokio::test]
    async fn loopback_empty_auth_remains_valid_for_local_stream_clients() {
        let state = Arc::new(crate::http_api::AppState::new(test_config(
            "ksp-legacy-mobile-auth-test",
            "KSP Legacy Mobile Auth Test",
        )));
        let (incoming_tx, incoming_rx) = mpsc::channel(8);
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let task = tokio::spawn(handle_stream_channels(
            incoming_rx,
            frame_tx,
            companion_tx,
            state,
            AuthMode::AllowEmpty,
            false,
        ));

        incoming_tx
            .send(
                serde_json::to_string(&ClientFrame::Auth {
                    credential: None,
                    capabilities: vec![],
                })
                .unwrap(),
            )
            .await
            .unwrap();
        assert!(matches!(
            outbound_rx.recv().await,
            Some(ServerFrame::AuthOk { .. })
        ));
        drop(incoming_tx);
        let _ = task.await;
    }

    #[tokio::test]
    async fn loopback_ksp_delivers_ordinary_input_to_merge_singleton() {
        let unique = format!(
            "ksp-merge-input-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        std::fs::create_dir_all(&daemon_dir).unwrap();
        let mut config = test_config(&unique, "KSP Merge Input");
        config.daemon_dir = daemon_dir.to_string_lossy().to_string();
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-merge-ksp", "Merge KSP").unwrap();
        db.insert_test_pipeline_item(
            "merge-ksp-task",
            "repo-merge-ksp",
            "merge",
            Some("Merge Master"),
            "in progress",
            "2026-08-04 00:00:00",
        )
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-merge-ksp",
            task_id: "merge-ksp-task",
            stage: "in progress",
            kind: "main",
            agent: Some("merge"),
            agent_provider: Some("claude"),
            model: None,
            effort: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("merge-ksp-session"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
        drop(db);

        let (daemon, mut commands) = spawn_fake_control_daemon(config.daemon_dir.clone(), 1).await;
        let state = Arc::new(crate::http_api::AppState::new(config));
        let url = serve_router(crate::http_api::router(state)).await;
        let mut socket = ws_connect(&url).await;
        send_frame(
            &mut socket,
            &ClientFrame::Auth {
                credential: None,
                capabilities: vec![],
            },
        )
        .await;
        assert_eq!(recv_frame(&mut socket).await, auth_ok_frame_for(false));
        send_frame(
            &mut socket,
            &ClientFrame::TermInput {
                task_id: "merge-ksp-task".into(),
                data_b64: b64(b"merge PR 123\r"),
            },
        )
        .await;
        assert_command(
            commands.recv().await,
            DaemonCommand::InputNoReply {
                session_id: "merge-ksp-session".into(),
                data: b"merge PR 123\r".to_vec(),
            },
        );
        daemon.await.unwrap();
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn empty_auth_lan_stream_cannot_input_advance_or_close_tasks() {
        for (index, path) in [
            "/v1/tasks/task-1/input",
            "/v1/tasks/task-1/actions/advance-stage",
            "/v1/tasks/task-1/actions/close",
        ]
        .into_iter()
        .enumerate()
        {
            let state = Arc::new(crate::http_api::AppState::new(test_config(
                &format!("ksp-lan-privileged-{index}"),
                "KSP LAN Privileged",
            )));
            let (incoming_tx, incoming_rx) = mpsc::channel(8);
            let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
            let task = tokio::spawn(handle_stream_channels(
                incoming_rx,
                frame_tx,
                companion_tx,
                state,
                AuthMode::RequirePairedDevice,
                false,
            ));

            incoming_tx
                .send(
                    serde_json::to_string(&ClientFrame::Auth {
                        credential: None,
                        capabilities: vec![],
                    })
                    .unwrap(),
                )
                .await
                .unwrap();
            incoming_tx
                .send(
                    serde_json::to_string(&ClientFrame::Request {
                        id: index as u64,
                        method: "POST".into(),
                        path: path.into(),
                        body: Some(serde_json::json!({ "message": "must not dispatch" })),
                    })
                    .unwrap(),
                )
                .await
                .unwrap();

            match outbound_rx.recv().await.expect("unauthorized frame") {
                ServerFrame::Error { code, .. } => assert_eq!(code, "unauthorized"),
                other => panic!("expected unauthorized error, got {other:?}"),
            }
            drop(incoming_tx);
            task.await.unwrap();
            assert!(
                outbound_rx.recv().await.is_none(),
                "unauthenticated request was dispatched for {path}"
            );
        }
    }

    #[tokio::test]
    async fn direct_lan_stream_accepts_paired_device_credential() {
        let config = test_config("ksp-lan-auth-ok", "KSP LAN Auth OK");
        let pairing_path = std::path::PathBuf::from(&config.pairing_store_path);
        let mut pairing_store = crate::pairing::PairingStore::default();
        pairing_store.add_trusted_device(
            &config.desktop_id,
            "phone-1",
            "Kanna Mobile",
            &crate::pairing::hash_device_secret("lan-secret"),
        );
        pairing_store.save(&pairing_path).unwrap();
        let state = Arc::new(crate::http_api::AppState::new(config));
        let (incoming_tx, incoming_rx) = mpsc::channel(8);
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let task = tokio::spawn(handle_stream_channels(
            incoming_rx,
            frame_tx,
            companion_tx,
            state,
            AuthMode::RequirePairedDevice,
            false,
        ));

        incoming_tx
            .send(
                serde_json::to_string(&ClientFrame::Auth {
                    credential: Some(
                        serde_json::json!({
                            "deviceId": "phone-1",
                            "deviceSecret": "lan-secret",
                        })
                        .to_string(),
                    ),
                    capabilities: vec![],
                })
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            outbound_rx.recv().await.expect("auth ok frame"),
            auth_ok_frame(),
        );
        incoming_tx
            .send(
                serde_json::to_string(&ClientFrame::Request {
                    id: 7,
                    method: "POST".into(),
                    path: "/v1/tasks/missing-task/input".into(),
                    body: Some(serde_json::json!({ "message": "authenticated" })),
                })
                .unwrap(),
            )
            .await
            .unwrap();
        match outbound_rx.recv().await.expect("authenticated response") {
            ServerFrame::Response { id, status, .. } => {
                assert_eq!(id, 7);
                assert_ne!(status, 401);
            }
            other => panic!("expected authenticated response, got {other:?}"),
        }
        drop(incoming_tx);
        let _ = task.await;
        let _ = std::fs::remove_file(pairing_path);
    }

    #[tokio::test]
    async fn unpaired_direct_lan_stream_cannot_attach_or_send_companion_data() {
        let state = Arc::new(crate::http_api::AppState::new(test_config(
            "ksp-unpaired-companion",
            "KSP Unpaired Companion",
        )));
        let (incoming_tx, incoming_rx) = mpsc::channel(8);
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let task = tokio::spawn(handle_stream_channels(
            incoming_rx,
            frame_tx,
            companion_tx,
            state,
            AuthMode::AllowEmpty,
            false,
        ));
        incoming_tx
            .send(serde_json::to_string(&client_auth_frame()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            outbound_rx.recv().await,
            Some(ServerFrame::AuthOk {
                stream_kinds: vec![StreamKind::Agent, StreamKind::Terminal],
                capabilities: vec![
                    KspCapability::CompanionAttachmentEpoch,
                    KspCapability::CompanionEventEpoch,
                ],
            })
        );

        incoming_tx
            .send(
                serde_json::to_string(&ClientFrame::Attach {
                    task_id: "task-secret".into(),
                    kind: StreamKind::Companion,
                    from_seq: 0,
                    include_assets: Some(false),
                    accept_snapshot_chunks: Some(true),
                    attachment_epoch: None,
                })
                .unwrap(),
            )
            .await
            .unwrap();
        assert!(matches!(
            outbound_rx.recv().await,
            Some(ServerFrame::Error { code, .. }) if code == "unauthorized"
        ));
        drop(incoming_tx);
        let _ = task.await;
    }

    #[tokio::test]
    async fn tunnel_stream_accepts_desktop_secret_credential() {
        let mut config = test_config("ksp-auth-ok", "KSP Auth OK");
        config.desktop_secret = Some("desktop-secret".to_string());
        let state = Arc::new(crate::http_api::AppState::new(config));
        let (incoming_tx, incoming_rx) = mpsc::channel(8);
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let task = tokio::spawn(handle_stream_channels(
            incoming_rx,
            frame_tx,
            companion_tx,
            state,
            AuthMode::RequireCredential,
            true,
        ));

        incoming_tx
            .send(
                serde_json::to_string(&ClientFrame::Auth {
                    credential: Some("desktop-secret".to_string()),
                    capabilities: vec![KspCapability::CompanionEventEpoch],
                })
                .unwrap(),
            )
            .await
            .unwrap();
        let frame = outbound_rx.recv().await.expect("auth ok frame");
        assert_eq!(frame, auth_ok_frame());
        drop(incoming_tx);
        let _ = task.await;
    }

    #[tokio::test]
    async fn tunnel_stream_rejects_wrong_nonempty_credential() {
        // Regression guard: a non-empty credential must not pass on the
        // strength of being non-empty — the secret comparison is the gate.
        let mut config = test_config("ksp-auth-wrong", "KSP Auth Wrong");
        config.desktop_secret = Some("desktop-secret".to_string());
        let state = Arc::new(crate::http_api::AppState::new(config));
        let (incoming_tx, incoming_rx) = mpsc::channel(8);
        let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(8);
        let task = tokio::spawn(handle_stream_channels(
            incoming_rx,
            frame_tx,
            companion_tx,
            state,
            AuthMode::RequireCredential,
            true,
        ));

        incoming_tx
            .send(
                serde_json::to_string(&ClientFrame::Auth {
                    credential: Some("not-the-secret".to_string()),
                    capabilities: vec![KspCapability::CompanionEventEpoch],
                })
                .unwrap(),
            )
            .await
            .unwrap();
        let frame = outbound_rx.recv().await.expect("error frame");
        match frame {
            ServerFrame::Error { code, .. } => assert_eq!(code, "unauthorized"),
            other => panic!("expected unauthorized error, got {other:?}"),
        }
        drop(incoming_tx);
        let _ = task.await;
    }
}
