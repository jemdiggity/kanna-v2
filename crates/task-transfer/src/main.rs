use kanna_task_transfer::protocol::{ControlRequest, ControlResponse, SidecarEvent};
use kanna_task_transfer::runtime::{RuntimeConfig, RuntimeError, RuntimeEvent, TransferRuntime};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io::{BufRead, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::net::UnixStream as StdUnixStream;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::{oneshot, Semaphore};

const DEFAULT_CONTROL_MAX_IN_FLIGHT: usize = 32;
const DEFAULT_MARK_READ_CONTROL_MAX_IN_FLIGHT: usize = 4;
use std::sync::Weak;
use tokio::io::{AsyncWrite, AsyncWriteExt};

const COMPANION_IPC_FD_ENV: &str = "KANNA_TRANSFER_COMPANION_FD";
const MAX_COMPANION_IPC_PENDING_LATEST: usize = 64;
const MAX_COMPANION_IPC_PENDING_RELIABLE: usize = 1024;
const MAX_COMPANION_IPC_TRACKED_GENERATIONS: usize = 1024;
const MAX_COMPANION_IPC_FRAME_BYTES: usize = 40 * 1024 * 1024;
const MAX_COMPANION_IPC_RETAINED_BYTES: usize = 64 * 1024 * 1024;
const COMPANION_IPC_QUEUE_ITEM_OVERHEAD_BYTES: usize = 256;
const COMPANION_IPC_SERIALIZATION_CHUNK_BYTES: usize = 64 * 1024;
const COMPANION_IPC_SERIALIZATION_RESERVE_BYTES: usize =
    COMPANION_IPC_SERIALIZATION_CHUNK_BYTES * 3 + 1024;

type CompanionIpcKey = (String, String);
type CompanionControlKey = (String, String);

#[derive(Clone, Default)]
struct ControlRequestScheduler {
    companion_lanes: Arc<Mutex<HashMap<CompanionControlKey, Weak<tokio::sync::Mutex<()>>>>>,
}

impl ControlRequestScheduler {
    fn companion_key(request: &ControlRequest) -> Option<CompanionControlKey> {
        match request {
            ControlRequest::ObservePeerCompanion {
                target_peer_id,
                task_id,
                ..
            }
            | ControlRequest::SendPeerCompanionEvent {
                target_peer_id,
                task_id,
                ..
            }
            | ControlRequest::UnobservePeerCompanion {
                target_peer_id,
                task_id,
                ..
            } => Some((target_peer_id.clone(), task_id.clone())),
            _ => None,
        }
    }

    async fn run<T>(&self, request: &ControlRequest, future: impl Future<Output = T>) -> T {
        let Some(key) = Self::companion_key(request) else {
            return future.await;
        };
        let lane = {
            let mut lanes = self
                .companion_lanes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(lane) = lanes.get(&key).and_then(Weak::upgrade) {
                lane
            } else {
                let lane = Arc::new(tokio::sync::Mutex::new(()));
                lanes.insert(key.clone(), Arc::downgrade(&lane));
                lane
            }
        };
        let guard = lane.lock().await;
        let result = future.await;
        drop(guard);
        if Arc::strong_count(&lane) == 1 {
            let mut lanes = self
                .companion_lanes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let lane_weak = Arc::downgrade(&lane);
            if lanes
                .get(&key)
                .is_some_and(|current| Weak::ptr_eq(current, &lane_weak))
                && Arc::strong_count(&lane) == 1
            {
                lanes.remove(&key);
            }
        }
        result
    }
}

struct PendingCompanionIpcEvent {
    event: SidecarEvent,
    key: CompanionIpcKey,
    generation_order: u64,
    latest: bool,
    retained_bytes: usize,
}

#[derive(Default)]
struct CompanionIpcState {
    pending: VecDeque<PendingCompanionIpcEvent>,
    pending_latest: usize,
    pending_reliable: usize,
    active_write: bool,
    active_write_bytes: usize,
    retained_bytes: usize,
    current_generations: HashMap<CompanionIpcKey, (u64, String)>,
    // Retired entries remain as stale-event fences until capacity pressure
    // evicts the least recently retired tombstone.
    retired_generations: HashMap<CompanionIpcKey, u64>,
    retirement_clock: u64,
    // Generation order comes from the runtime's process-wide monotonic request
    // counter. This watermark keeps delayed events fenced after tombstone
    // eviction while admitting observations created later.
    evicted_generation_order: u64,
}

#[derive(Clone)]
struct CompanionIpcSender {
    state: Arc<Mutex<CompanionIpcState>>,
    notify: tokio::sync::mpsc::Sender<()>,
}

#[derive(Default)]
struct CountingWriter(usize);

impl Write for CountingWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl CompanionIpcSender {
    fn spawn<W>(writer: W) -> Self
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let state = Arc::new(Mutex::new(CompanionIpcState::default()));
        let (notify, notify_rx) = tokio::sync::mpsc::channel(1);
        tokio::spawn(run_companion_ipc_writer(
            writer,
            Arc::clone(&state),
            notify_rx,
        ));
        Self { state, notify }
    }

    fn publish(&self, event: SidecarEvent) -> Result<(), &'static str> {
        let ((peer_id, task_id), latest, generation, generation_order) =
            companion_ipc_event_class(&event)?;
        let key = (peer_id.to_owned(), task_id.to_owned());
        let generation = generation.to_owned();
        let retained_bytes = companion_ipc_event_retained_bytes(&event)?;
        if retained_bytes > MAX_COMPANION_IPC_RETAINED_BYTES {
            return Err("companion IPC event exceeds its retained byte limit");
        }
        if self.notify.is_closed() {
            return Err("companion IPC writer is unavailable");
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match state.current_generations.get(&key) {
            Some((current_order, current_generation))
                if *current_order > generation_order
                    || (*current_order == generation_order
                        && current_generation != &generation) =>
            {
                return Ok(());
            }
            Some((current_order, current_generation))
                if *current_order == generation_order
                    && current_generation == &generation
                    && state.retired_generations.contains_key(&key) =>
            {
                return Ok(());
            }
            Some((current_order, _)) if *current_order < generation_order => {
                state
                    .current_generations
                    .insert(key.clone(), (generation_order, generation.clone()));
                state.retired_generations.remove(&key);
                let mut retained_bytes = state.retained_bytes;
                let mut pending_latest = state.pending_latest;
                state.pending.retain(|pending| {
                    let remove = pending.latest
                        && pending.key == key
                        && pending.generation_order < generation_order;
                    if remove {
                        retained_bytes = retained_bytes.saturating_sub(pending.retained_bytes);
                        pending_latest = pending_latest.saturating_sub(1);
                    }
                    !remove
                });
                state.retained_bytes = retained_bytes;
                state.pending_latest = pending_latest;
            }
            Some(_) => {}
            None => {
                if generation_order <= state.evicted_generation_order {
                    return Ok(());
                }
                if state.current_generations.len() >= MAX_COMPANION_IPC_TRACKED_GENERATIONS {
                    let evicted = state
                        .retired_generations
                        .iter()
                        .min_by_key(|(_, retired_at)| *retired_at)
                        .map(|(retired_key, _)| retired_key.clone());
                    let Some(evicted) = evicted else {
                        return Err("companion IPC generation registry is full");
                    };
                    state.retired_generations.remove(&evicted);
                    if let Some((evicted_order, _)) = state.current_generations.remove(&evicted) {
                        state.evicted_generation_order =
                            state.evicted_generation_order.max(evicted_order);
                    }
                }
                state
                    .current_generations
                    .insert(key.clone(), (generation_order, generation.clone()));
            }
        }
        if latest {
            let mut replacement_index = None;
            for (index, pending) in state.pending.iter().enumerate().rev() {
                if !pending.latest {
                    break;
                }
                if pending.key == key {
                    replacement_index = Some(index);
                    break;
                }
            }
            if let Some(index) = replacement_index {
                let replaced_bytes = state.pending[index].retained_bytes;
                let next_retained = state
                    .retained_bytes
                    .saturating_sub(replaced_bytes)
                    .saturating_add(retained_bytes);
                if next_retained > MAX_COMPANION_IPC_RETAINED_BYTES {
                    return Err("companion IPC queue exceeds its retained byte limit");
                }
                state.retained_bytes = next_retained;
                state.pending[index] = PendingCompanionIpcEvent {
                    event,
                    key,
                    generation_order,
                    latest,
                    retained_bytes,
                };
                drop(state);
                return self.notify_writer();
            }
            if state.pending_latest >= MAX_COMPANION_IPC_PENDING_LATEST {
                return Err("companion IPC queue is full");
            }
            state.pending_latest += 1;
        } else {
            if state.pending_reliable >= MAX_COMPANION_IPC_PENDING_RELIABLE {
                return Err("companion IPC reliable queue is full");
            }
            state.pending_reliable += 1;
        }
        if state.retained_bytes.saturating_add(retained_bytes) > MAX_COMPANION_IPC_RETAINED_BYTES {
            if latest {
                state.pending_latest -= 1;
            } else {
                state.pending_reliable -= 1;
            }
            return Err("companion IPC queue exceeds its retained byte limit");
        }
        state.retained_bytes += retained_bytes;
        state.pending.push_back(PendingCompanionIpcEvent {
            event,
            key,
            generation_order,
            latest,
            retained_bytes,
        });
        drop(state);
        self.notify_writer()
    }

    fn retire_generation(&self, peer_id: &str, task_id: &str, generation: &str) {
        let key = (peer_id.to_owned(), task_id.to_owned());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state
            .current_generations
            .get(&key)
            .is_none_or(|(_, current_generation)| current_generation != generation)
        {
            return;
        }
        state.retirement_clock = state.retirement_clock.saturating_add(1);
        let retired_at = state.retirement_clock;
        state.retired_generations.insert(key.clone(), retired_at);
        let mut retained_bytes = state.retained_bytes;
        let mut pending_latest = state.pending_latest;
        let mut pending_reliable = state.pending_reliable;
        state.pending.retain(|pending| {
            if pending.key != key {
                return true;
            }
            retained_bytes = retained_bytes.saturating_sub(pending.retained_bytes);
            if pending.latest {
                pending_latest = pending_latest.saturating_sub(1);
            } else {
                pending_reliable = pending_reliable.saturating_sub(1);
            }
            false
        });
        state.retained_bytes = retained_bytes;
        state.pending_latest = pending_latest;
        state.pending_reliable = pending_reliable;
    }

    fn notify_writer(&self) -> Result<(), &'static str> {
        match self.notify.try_send(()) {
            Ok(()) | Err(tokio::sync::mpsc::error::TrySendError::Full(())) => Ok(()),
            Err(tokio::sync::mpsc::error::TrySendError::Closed(())) => {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state.pending.clear();
                state.pending_latest = 0;
                state.pending_reliable = 0;
                state.retained_bytes = state.active_write_bytes;
                Err("companion IPC writer is unavailable")
            }
        }
    }

    #[cfg(test)]
    fn has_active_write_for_tests(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active_write
    }

    #[cfg(test)]
    fn retained_bytes_for_tests(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retained_bytes
    }
}

async fn run_companion_ipc_writer<W>(
    mut writer: W,
    state: Arc<Mutex<CompanionIpcState>>,
    mut notify_rx: tokio::sync::mpsc::Receiver<()>,
) where
    W: AsyncWrite + Unpin,
{
    while notify_rx.recv().await.is_some() {
        loop {
            let pending = {
                let mut state = state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let pending = state.pending.pop_front();
                if let Some(pending) = &pending {
                    if pending.latest {
                        state.pending_latest -= 1;
                    } else {
                        state.pending_reliable -= 1;
                    }
                    state.active_write_bytes = pending.retained_bytes;
                }
                state.active_write = pending.is_some();
                pending
            };
            let Some(pending) = pending else {
                break;
            };
            let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel(1);
            let producer = tokio::task::spawn_blocking(move || {
                serialize_companion_ipc_chunks(pending.event, chunk_tx)
            });
            let mut write_failed = false;
            while let Some(chunk) = chunk_rx.recv().await {
                if writer.write_all(&chunk).await.is_err() {
                    write_failed = true;
                    break;
                }
            }
            if write_failed {
                drop(chunk_rx);
            }
            let serialized = producer.await;
            if write_failed || !matches!(serialized, Ok(Ok(()))) || writer.flush().await.is_err() {
                finish_companion_ipc_write(&state);
                return;
            }
            finish_companion_ipc_write(&state);
        }
    }
}

type CompanionIpcEventClass<'a> = ((&'a str, &'a str), bool, &'a str, u64);

fn companion_ipc_event_class(
    event: &SidecarEvent,
) -> Result<CompanionIpcEventClass<'_>, &'static str> {
    let SidecarEvent::CompanionEvent {
        peer_id,
        task_id,
        generation,
        generation_order,
        frame,
    } = event
    else {
        return Err("companion IPC accepts only companion events");
    };
    Ok((
        (peer_id, task_id),
        matches!(
            frame,
            kanna_agent_protocol::ServerFrame::CompanionSnapshot { .. }
                | kanna_agent_protocol::ServerFrame::CompanionUnavailable { .. }
        ),
        generation,
        *generation_order,
    ))
}

fn add_string_retained(retained: &mut usize, value: &String) {
    *retained = retained.saturating_add(value.capacity());
}

fn add_optional_string_retained(retained: &mut usize, value: &Option<String>) {
    if let Some(value) = value {
        add_string_retained(retained, value);
    }
}

fn companion_ipc_event_retained_bytes(event: &SidecarEvent) -> Result<usize, &'static str> {
    let SidecarEvent::CompanionEvent {
        peer_id,
        task_id,
        generation,
        frame,
        ..
    } = event
    else {
        return Err("companion IPC accepts only companion events");
    };
    let mut retained = std::mem::size_of::<PendingCompanionIpcEvent>()
        .saturating_add(COMPANION_IPC_QUEUE_ITEM_OVERHEAD_BYTES)
        .saturating_add(COMPANION_IPC_SERIALIZATION_RESERVE_BYTES);
    add_string_retained(&mut retained, peer_id);
    add_string_retained(&mut retained, task_id);
    add_string_retained(&mut retained, generation);
    retained = retained
        .saturating_add(peer_id.len())
        .saturating_add(task_id.len());
    match frame {
        kanna_agent_protocol::ServerFrame::CompanionSnapshot {
            task_id,
            session_id,
            revision,
            html,
            source_origin,
            assets,
            ..
        } => {
            add_string_retained(&mut retained, task_id);
            add_string_retained(&mut retained, session_id);
            add_string_retained(&mut retained, revision);
            add_string_retained(&mut retained, html);
            add_optional_string_retained(&mut retained, source_origin);
            retained = retained.saturating_add(
                assets
                    .capacity()
                    .saturating_mul(std::mem::size_of::<kanna_agent_protocol::CompanionAsset>()),
            );
            for asset in assets {
                add_string_retained(&mut retained, &asset.name);
                add_string_retained(&mut retained, &asset.content_type);
                add_string_retained(&mut retained, &asset.digest);
                add_string_retained(&mut retained, &asset.data_b64);
            }
        }
        kanna_agent_protocol::ServerFrame::CompanionUnavailable { task_id, .. } => {
            add_string_retained(&mut retained, task_id);
        }
        kanna_agent_protocol::ServerFrame::CompanionEventResult {
            task_id,
            session_id,
            revision,
            event_id,
            code,
            message,
            ..
        } => {
            add_string_retained(&mut retained, task_id);
            add_optional_string_retained(&mut retained, session_id);
            add_optional_string_retained(&mut retained, revision);
            add_string_retained(&mut retained, event_id);
            add_optional_string_retained(&mut retained, code);
            add_optional_string_retained(&mut retained, message);
        }
        kanna_agent_protocol::ServerFrame::CompanionError {
            task_id,
            code,
            message,
            ..
        } => {
            add_string_retained(&mut retained, task_id);
            add_string_retained(&mut retained, code);
            add_string_retained(&mut retained, message);
        }
        _ => return Err("companion IPC accepts only companion frames"),
    }
    Ok(retained)
}

struct CompanionIpcChunkWriter {
    sender: tokio::sync::mpsc::Sender<Box<[u8]>>,
    buffer: Vec<u8>,
}

impl CompanionIpcChunkWriter {
    fn new(sender: tokio::sync::mpsc::Sender<Box<[u8]>>) -> Self {
        Self {
            sender,
            buffer: Vec::with_capacity(COMPANION_IPC_SERIALIZATION_CHUNK_BYTES),
        }
    }

    fn send_buffer(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let chunk = std::mem::take(&mut self.buffer).into_boxed_slice();
        self.sender.blocking_send(chunk).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "IPC writer closed")
        })?;
        self.buffer = Vec::with_capacity(COMPANION_IPC_SERIALIZATION_CHUNK_BYTES);
        Ok(())
    }
}

impl Write for CompanionIpcChunkWriter {
    fn write(&mut self, mut bytes: &[u8]) -> std::io::Result<usize> {
        let written = bytes.len();
        while !bytes.is_empty() {
            let remaining = COMPANION_IPC_SERIALIZATION_CHUNK_BYTES - self.buffer.len();
            let take = remaining.min(bytes.len());
            self.buffer.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.buffer.len() == COMPANION_IPC_SERIALIZATION_CHUNK_BYTES {
                self.send_buffer()?;
            }
        }
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.send_buffer()
    }
}

fn serialize_companion_ipc_chunks(
    event: SidecarEvent,
    chunk_tx: tokio::sync::mpsc::Sender<Box<[u8]>>,
) -> Result<(), &'static str> {
    let mut counter = CountingWriter::default();
    serde_json::to_writer(&mut counter, &event)
        .map_err(|_| "failed to serialize companion IPC event")?;
    if counter.0 > MAX_COMPANION_IPC_FRAME_BYTES {
        return Err("companion IPC event exceeds its frame limit");
    }
    let header: Box<[u8]> = Box::new((counter.0 as u32).to_be_bytes());
    chunk_tx
        .blocking_send(header)
        .map_err(|_| "companion IPC writer is unavailable")?;
    let mut writer = CompanionIpcChunkWriter::new(chunk_tx);
    serde_json::to_writer(&mut writer, &event)
        .map_err(|_| "failed to serialize companion IPC event")?;
    writer
        .flush()
        .map_err(|_| "companion IPC writer is unavailable")
}

fn finish_companion_ipc_write(state: &Arc<Mutex<CompanionIpcState>>) {
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.retained_bytes = state
        .retained_bytes
        .saturating_sub(state.active_write_bytes);
    state.active_write_bytes = 0;
    state.active_write = false;
}

fn companion_ipc_stream_from_env() -> Result<tokio::net::UnixStream, Box<dyn std::error::Error>> {
    let raw_fd = std::env::var(COMPANION_IPC_FD_ENV)?
        .parse::<RawFd>()
        .map_err(|error| format!("invalid {COMPANION_IPC_FD_ENV}: {error}"))?;
    // SAFETY: the desktop parent passes this descriptor exclusively to the
    // child and clears close-on-exec immediately before spawning.
    let stream = unsafe { StdUnixStream::from_raw_fd(raw_fd) };
    stream.set_nonblocking(true)?;
    Ok(tokio::net::UnixStream::from_std(stream)?)
}

fn publish_companion_runtime_event(
    companion: &CompanionIpcSender,
    peer_id: String,
    task_id: String,
    generation: String,
    generation_order: u64,
    frame: kanna_agent_protocol::ServerFrame,
) -> Option<SidecarEvent> {
    let fallback_peer_id = peer_id.clone();
    let fallback_task_id = task_id.clone();
    let fallback_generation = generation.clone();
    companion
        .publish(SidecarEvent::CompanionEvent {
            peer_id,
            task_id,
            generation,
            generation_order,
            frame,
        })
        .err()
        .map(|reason| SidecarEvent::CompanionEvent {
            peer_id: fallback_peer_id,
            task_id: fallback_task_id.clone(),
            generation: fallback_generation,
            generation_order,
            frame: kanna_agent_protocol::ServerFrame::CompanionError {
                task_id: fallback_task_id,
                code: "companion_ipc_saturated".into(),
                message: reason.into(),
                attachment_epoch: None,
            },
        })
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = Arc::new(TransferRuntime::spawn(RuntimeConfig::from_env()?).await?);
    // Without the parent-provided IPC lane companion frames have nowhere to
    // go; transfers and terminals still work, so run without companions
    // rather than refusing to start.
    let companion = match std::env::var(COMPANION_IPC_FD_ENV) {
        Ok(_) => CompanionIpcSender::spawn(companion_ipc_stream_from_env()?),
        Err(_) => {
            eprintln!(
                "[task-transfer] {COMPANION_IPC_FD_ENV} is unset; visual companion frames are \
                 disabled for this process"
            );
            CompanionIpcSender::spawn(tokio::io::sink())
        }
    };
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let event_runtime = Arc::clone(&runtime);
    let event_stdout = Arc::clone(&stdout);
    let event_companion = companion.clone();
    let scheduler = ControlRequestScheduler::default();

    let event_task = tokio::spawn(async move {
        loop {
            let event = match event_runtime.next_event().await {
                Ok(event) => event,
                Err(RuntimeError::IncomingEventChannelClosed) => break,
                Err(error) => {
                    let response = ControlResponse::Error {
                        request_id: String::new(),
                        message: error.to_string(),
                    };
                    let _ = write_json_line(&event_stdout, &response);
                    break;
                }
            };

            let payload = match event {
                RuntimeEvent::PairingStarted(event) => SidecarEvent::PairingStarted {
                    peer_id: event.peer_id,
                    display_name: event.display_name,
                    verification_code: event.verification_code,
                },
                RuntimeEvent::PairingRequested(event) => SidecarEvent::PairingRequested {
                    request_id: event.request_id,
                    peer_id: event.peer_id,
                    display_name: event.display_name,
                    verification_code: event.verification_code,
                },
                RuntimeEvent::PairingCompleted(event) => SidecarEvent::PairingCompleted {
                    peer_id: event.peer_id,
                    display_name: event.display_name,
                    verification_code: event.verification_code,
                },
                RuntimeEvent::TaskPullRequested(event) => SidecarEvent::TaskPullRequested {
                    request_id: event.request_id,
                    requester_peer_id: event.requester_peer_id,
                    source_task_id: event.source_task_id,
                },
                RuntimeEvent::IncomingTransferRequest(event) => {
                    SidecarEvent::IncomingTransferRequest {
                        transfer_id: event.transfer_id,
                        source_peer_id: event.source_peer_id,
                        source_task_id: event.source_task_id,
                        source_name: event.source_name,
                        payload: event.payload,
                    }
                }
                RuntimeEvent::OutgoingTransferCommitted(event) => {
                    SidecarEvent::OutgoingTransferCommitted {
                        transfer_id: event.transfer_id,
                        source_task_id: event.source_task_id,
                        destination_local_task_id: event.destination_local_task_id,
                    }
                }
                RuntimeEvent::OutgoingTransferFinalizationRequested(event) => {
                    SidecarEvent::OutgoingTransferFinalizationRequested {
                        transfer_id: event.transfer_id,
                    }
                }
                RuntimeEvent::TerminalEvent {
                    peer_id,
                    session_id,
                    observer_lease_id,
                    event,
                } => SidecarEvent::TerminalEvent {
                    peer_id,
                    session_id,
                    observer_lease_id,
                    event,
                },
                RuntimeEvent::CompanionEvent {
                    peer_id,
                    task_id,
                    generation,
                    generation_order,
                    frame,
                } => {
                    if let Some(error) = publish_companion_runtime_event(
                        &event_companion,
                        peer_id,
                        task_id,
                        generation,
                        generation_order,
                        frame,
                    ) {
                        if write_json_line(&event_stdout, &error).is_err() {
                            break;
                        }
                    }
                    continue;
                }
            };

            if write_json_line(&event_stdout, &payload).is_err() {
                break;
            }
        }
    });

    let mut command_tasks = tokio::task::JoinSet::new();
    let control_permits = Arc::new(Semaphore::new(control_limit(
        "KANNA_TRANSFER_CONTROL_MAX_IN_FLIGHT",
        DEFAULT_CONTROL_MAX_IN_FLIGHT,
    )));
    let mark_read_control_permits = Arc::new(Semaphore::new(control_limit(
        "KANNA_TRANSFER_MARK_READ_CONTROL_MAX_IN_FLIGHT",
        DEFAULT_MARK_READ_CONTROL_MAX_IN_FLIGHT,
    )));
    let mut input_tails = HashMap::<(String, String), oneshot::Receiver<()>>::new();
    for line in std::io::stdin().lock().lines() {
        while command_tasks.try_join_next().is_some() {}
        input_tails.retain(|_, receiver| match receiver.try_recv() {
            Ok(()) | Err(oneshot::error::TryRecvError::Closed) => false,
            Err(oneshot::error::TryRecvError::Empty) => true,
        });
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request_id = extract_request_id(&line);
        match serde_json::from_str::<ControlRequest>(&line) {
            Ok(request) => {
                let is_mark_read = matches!(&request, ControlRequest::MarkPeerTaskRead { .. });
                let permits = if is_mark_read {
                    Arc::clone(&mark_read_control_permits)
                } else {
                    Arc::clone(&control_permits)
                };
                let permit = match permits.try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        write_json_line(
                            &stdout,
                            &ControlResponse::Error {
                                request_id,
                                message: if is_mark_read {
                                    "too many mark-read controls are already in flight".into()
                                } else {
                                    "too many transfer controls are already in flight".into()
                                },
                            },
                        )?;
                        continue;
                    }
                };
                let (input_predecessor, input_completion) = match &request {
                    ControlRequest::SendPeerSessionInput {
                        target_peer_id,
                        session_id,
                        ..
                    } => {
                        let key = (target_peer_id.clone(), session_id.clone());
                        let (completion, tail) = oneshot::channel();
                        (input_tails.insert(key, tail), Some(completion))
                    }
                    _ => (None, None),
                };
                let request_runtime = Arc::clone(&runtime);
                let request_stdout = Arc::clone(&stdout);
                let request_companion = companion.clone();
                let request_scheduler = scheduler.clone();
                command_tasks.spawn(async move {
                    let _permit = permit;
                    if let Some(predecessor) = input_predecessor {
                        let _ = predecessor.await;
                    }
                    let response = request_scheduler
                        .run(
                            &request,
                            handle_request(&request_runtime, &request_companion, request.clone()),
                        )
                        .await;
                    if let Err(error) = write_json_line(&request_stdout, &response) {
                        eprintln!("[task-transfer] failed writing control response: {error}");
                    }
                    if let Some(completion) = input_completion {
                        let _ = completion.send(());
                    }
                });
            }
            Err(error) => {
                write_json_line(
                    &stdout,
                    &ControlResponse::Error {
                        request_id,
                        message: error.to_string(),
                    },
                )?;
            }
        }
    }

    command_tasks.shutdown().await;
    event_task.abort();
    Ok(())
}

fn control_limit(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

async fn handle_request(
    runtime: &TransferRuntime,
    companion: &CompanionIpcSender,
    request: ControlRequest,
) -> ControlResponse {
    match request {
        ControlRequest::GetLocalIdentity { request_id } => {
            let identity = runtime.local_identity();
            ControlResponse::GetLocalIdentity {
                request_id,
                peer_id: identity.peer_id,
                display_name: identity.display_name,
                public_key: identity.public_key,
                protocol_version: identity.protocol_version,
                accepting_transfers: identity.accepting_transfers,
            }
        }
        ControlRequest::ListPeers { request_id } => match runtime.list_peers().await {
            Ok(peers) => ControlResponse::ListPeers { request_id, peers },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::UpsertExternalPeer { request_id, peer } => {
            match runtime.upsert_external_peer(peer).await {
                Ok(()) => ControlResponse::UpsertExternalPeer { request_id },
                Err(error) => control_error(request_id, error),
            }
        }
        ControlRequest::RemoveExternalPeer {
            request_id,
            peer_id,
        } => match runtime.remove_external_peer(&peer_id).await {
            Ok(()) => ControlResponse::RemoveExternalPeer { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ClearExternalPeers { request_id } => {
            match runtime.clear_external_peers().await {
                Ok(()) => ControlResponse::ClearExternalPeers { request_id },
                Err(error) => control_error(request_id, error),
            }
        }
        ControlRequest::SetTaskSnapshot {
            request_id,
            snapshot,
        } => match runtime.set_task_snapshot(snapshot).await {
            Ok(()) => ControlResponse::SetTaskSnapshot { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ListPeerTaskSnapshots { request_id } => {
            match runtime.list_peer_task_snapshots().await {
                Ok(listing) => ControlResponse::ListPeerTaskSnapshots {
                    request_id,
                    snapshots: listing.snapshots,
                    issues: listing.issues,
                },
                Err(error) => control_error(request_id, error),
            }
        }
        ControlRequest::ObservePeerSession {
            request_id,
            target_peer_id,
            session_id,
            observer_lease_id,
        } => match runtime
            .observe_peer_session(&target_peer_id, &session_id, &observer_lease_id)
            .await
        {
            Ok(()) => ControlResponse::ObservePeerSession { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ObservePeerCompanion {
            request_id,
            target_peer_id,
            task_id,
            generation,
        } => match runtime
            .observe_peer_companion(&target_peer_id, &task_id, &generation)
            .await
        {
            Ok(()) => ControlResponse::ObservePeerCompanion { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::SendPeerCompanionEvent {
            request_id,
            target_peer_id,
            task_id,
            session_id,
            revision,
            event,
            generation,
        } => match runtime
            .send_peer_companion_event(
                &target_peer_id,
                &task_id,
                &session_id,
                &revision,
                &generation,
                event,
            )
            .await
        {
            Ok(()) => ControlResponse::SendPeerCompanionEvent { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::UnobservePeerCompanion {
            request_id,
            target_peer_id,
            task_id,
            generation,
        } => match runtime
            .unobserve_peer_companion(&target_peer_id, &task_id, &generation)
            .await
        {
            Ok(()) => {
                companion.retire_generation(&target_peer_id, &task_id, &generation);
                ControlResponse::UnobservePeerCompanion { request_id }
            }
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::SendPeerSessionInput {
            request_id,
            target_peer_id,
            session_id,
            data,
            submission_boundary,
            control_input,
        } => match runtime
            .send_peer_session_input(
                &target_peer_id,
                &session_id,
                data,
                submission_boundary,
                control_input,
            )
            .await
        {
            Ok(()) => ControlResponse::SendPeerSessionInput { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ResizePeerSession {
            request_id,
            target_peer_id,
            session_id,
            cols,
            rows,
        } => match runtime
            .resize_peer_session(&target_peer_id, &session_id, cols, rows)
            .await
        {
            Ok(()) => ControlResponse::ResizePeerSession { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ClosePeerTask {
            request_id,
            target_peer_id,
            task_id,
        } => match runtime.close_peer_task(&target_peer_id, &task_id).await {
            Ok(()) => ControlResponse::ClosePeerTask { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::AdvancePeerTaskStage {
            request_id,
            target_peer_id,
            task_id,
            expected_transition_revision,
        } => match runtime
            .advance_peer_task_stage(
                &target_peer_id,
                &task_id,
                expected_transition_revision.as_deref(),
            )
            .await
        {
            Ok(()) => ControlResponse::AdvancePeerTaskStage { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ReadPeerTaskFile {
            request_id,
            target_peer_id,
            task_id,
            path,
        } => match runtime
            .read_peer_task_file(&target_peer_id, &task_id, &path)
            .await
        {
            Ok((path, content)) => ControlResponse::ReadPeerTaskFile {
                request_id,
                path,
                content,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ReadPeerTaskDirectory {
            request_id,
            target_peer_id,
            task_id,
            path,
            show_all_files,
            offset,
            limit,
        } => match runtime
            .read_peer_task_directory(
                &target_peer_id,
                &task_id,
                &path,
                show_all_files,
                offset,
                limit,
            )
            .await
        {
            Ok(listing) => ControlResponse::ReadPeerTaskDirectory {
                request_id,
                listing,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::ReadPeerTaskDiff {
            request_id,
            target_peer_id,
            task_id,
            scope,
            mode,
        } => match runtime
            .read_peer_task_diff(&target_peer_id, &task_id, &scope, &mode)
            .await
        {
            Ok(diff) => ControlResponse::ReadPeerTaskDiff { request_id, diff },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::MarkPeerTaskRead {
            request_id,
            target_peer_id,
            task_id,
            expected_activity_revision,
        } => match runtime
            .mark_peer_task_read(&target_peer_id, &task_id, expected_activity_revision)
            .await
        {
            Ok(()) => ControlResponse::MarkPeerTaskRead { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::UnobservePeerSession {
            request_id,
            target_peer_id,
            session_id,
            observer_lease_id,
        } => match runtime
            .unobserve_peer_session(&target_peer_id, &session_id, &observer_lease_id)
            .await
        {
            Ok(()) => ControlResponse::UnobservePeerSession { request_id },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::StartPairing {
            request_id,
            target_peer_id,
        } => match runtime.start_pairing(&target_peer_id).await {
            Ok(result) => ControlResponse::StartPairing {
                request_id,
                peer: result.peer,
                verification_code: result.verification_code,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::AcceptPairing {
            request_id,
            pairing_request_id,
            verification_code,
        } => match runtime
            .accept_pairing(&pairing_request_id, &verification_code)
            .await
        {
            Ok(()) => ControlResponse::AcceptPairing {
                request_id,
                pairing_request_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::RejectPairing {
            request_id,
            pairing_request_id,
        } => match runtime.reject_pairing(&pairing_request_id).await {
            Ok(()) => ControlResponse::RejectPairing {
                request_id,
                pairing_request_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::StageTransferArtifact {
            request_id,
            transfer_id,
            artifact_id,
            path,
            owned,
        } => match runtime
            .stage_transfer_artifact(&transfer_id, &artifact_id, path.into(), owned)
            .await
        {
            Ok(()) => ControlResponse::StageTransferArtifact {
                request_id,
                transfer_id,
                artifact_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::FetchTransferArtifact {
            request_id,
            transfer_id,
            artifact_id,
        } => match runtime
            .fetch_transfer_artifact(&transfer_id, &artifact_id)
            .await
        {
            Ok(artifact) => ControlResponse::FetchTransferArtifact {
                request_id,
                transfer_id,
                artifact_id,
                path: artifact.path.to_string_lossy().into_owned(),
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::PrepareTransferPreflight {
            request_id,
            source_task_id,
            target_peer_id,
            transport,
        } => match runtime
            .prepare_transfer_preflight_with_transport(&target_peer_id, &source_task_id, transport)
            .await
        {
            Ok(result) => ControlResponse::PrepareTransferPreflight {
                request_id,
                transfer_id: result.transfer_id,
                source_peer_id: result.source_peer_id,
                target_has_repo: result.target_has_repo,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::RequestTaskPull {
            request_id,
            target_peer_id,
            source_task_id,
            transport,
        } => match runtime
            .request_task_pull(&target_peer_id, &source_task_id, transport)
            .await
        {
            Ok(pull_request_id) => ControlResponse::RequestTaskPull {
                request_id,
                pull_request_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::PrepareTransferCommit {
            request_id,
            transfer_id,
            payload,
        } => match runtime.prepare_transfer_commit(&transfer_id, payload).await {
            Ok(()) => ControlResponse::PrepareTransferCommit {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::AbandonOutgoingTransfer {
            request_id,
            transfer_id,
        } => match runtime.abandon_outgoing_transfer(&transfer_id).await {
            Ok(()) => ControlResponse::AbandonOutgoingTransfer {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::FinalizeOutgoingTransfer {
            request_id,
            transfer_id,
        } => match runtime.finalize_outgoing_transfer(&transfer_id).await {
            Ok(result) => ControlResponse::FinalizeOutgoingTransfer {
                request_id,
                transfer_id,
                payload: result.payload,
                finalized_cleanly: result.finalized_cleanly,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::CompleteOutgoingTransferFinalization {
            request_id,
            transfer_id,
            payload,
            finalized_cleanly,
            error,
        } => match runtime
            .complete_outgoing_transfer_finalization(
                &transfer_id,
                match error {
                    Some(message) => Err(RuntimeError::Protocol(message)),
                    None => match payload {
                        Some(payload) => {
                            Ok(kanna_task_transfer::runtime::FinalizedOutgoingTransfer {
                                payload,
                                finalized_cleanly,
                            })
                        }
                        None => Err(RuntimeError::Protocol(
                            "complete outgoing transfer finalization missing payload".into(),
                        )),
                    },
                },
            )
            .await
        {
            Ok(()) => ControlResponse::CompleteOutgoingTransferFinalization {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::AcknowledgeImportCommitted {
            request_id,
            transfer_id,
            source_task_id,
            destination_local_task_id,
        } => match runtime
            .acknowledge_import_committed(&transfer_id, &source_task_id, &destination_local_task_id)
            .await
        {
            Ok(()) => ControlResponse::AcknowledgeImportCommitted {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::MarkIncomingEventRecorded {
            request_id,
            transfer_id,
        } => match runtime.mark_incoming_event_recorded(&transfer_id).await {
            Ok(()) => ControlResponse::MarkIncomingEventRecorded {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::MarkImportCommitApplied {
            request_id,
            transfer_id,
        } => match runtime.mark_import_commit_applied(&transfer_id).await {
            Ok(()) => ControlResponse::MarkImportCommitApplied {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::NackImportCommit {
            request_id,
            transfer_id,
        } => match runtime.nack_import_commit(&transfer_id).await {
            Ok(()) => ControlResponse::NackImportCommit {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
        ControlRequest::MarkImportAckCompleted {
            request_id,
            transfer_id,
        } => match runtime.mark_import_ack_completed(&transfer_id).await {
            Ok(()) => ControlResponse::MarkImportAckCompleted {
                request_id,
                transfer_id,
            },
            Err(error) => control_error(request_id, error),
        },
    }
}

fn control_error(request_id: String, error: RuntimeError) -> ControlResponse {
    ControlResponse::Error {
        request_id,
        message: error.to_string(),
    }
}

fn extract_request_id(line: &str) -> String {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("request_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

fn write_json_line<T, W>(stdout: &Arc<Mutex<W>>, value: &T) -> std::io::Result<()>
where
    T: serde::Serialize,
    W: Write,
{
    let encoded = serde_json::to_vec(value)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let mut writer = stdout
        .lock()
        .map_err(|_| std::io::Error::other("stdout mutex poisoned"))?;
    writer.write_all(&encoded)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use kanna_agent_protocol::{CompanionAsset, CompanionDocumentKind, ServerFrame};
    use kanna_visual_companion::{
        MAX_COMPANION_ASSET_COUNT, MAX_COMPANION_ASSET_TOTAL_BYTES, MAX_COMPANION_HTML_BYTES,
    };
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn maximum_companion_bundle_blocked_on_a_slow_reader_does_not_delay_terminal_output() {
        let (slow_companion_writer, _slow_companion_reader) = tokio::io::duplex(1);
        let companion = CompanionIpcSender::spawn(slow_companion_writer);
        companion
            .publish(maximum_companion_event())
            .expect("maximum companion event should be admitted");
        tokio::time::timeout(Duration::from_secs(5), async {
            while !companion.has_active_write_for_tests() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("companion writer should reach the slow IPC stream");

        let terminal = Arc::new(Mutex::new(Vec::<u8>::new()));
        tokio::time::timeout(Duration::from_millis(100), async {
            write_json_line(
                &terminal,
                &SidecarEvent::TerminalEvent {
                    peer_id: "peer-owner".into(),
                    session_id: "session-terminal".into(),
                    observer_lease_id: "lease-test".into(),
                    event: kanna_task_transfer::protocol::PeerTerminalEvent::Output {
                        session_id: "session-terminal".into(),
                        data: b"terminal-live".to_vec(),
                    },
                },
            )
        })
        .await
        .expect("terminal output must not wait for the companion reader")
        .expect("terminal output should be writable");
        assert!(
            companion.has_active_write_for_tests(),
            "maximum bundle should still be blocked on the independent slow reader"
        );
        let encoded_terminal = terminal.lock().unwrap().clone();
        let decoded_terminal: SidecarEvent =
            serde_json::from_slice(&encoded_terminal).expect("terminal event should serialize");
        assert!(matches!(
            decoded_terminal,
            SidecarEvent::TerminalEvent {
                event: kanna_task_transfer::protocol::PeerTerminalEvent::Output {
                    data,
                    ..
                },
                ..
            } if data == b"terminal-live"
        ));
    }

    #[tokio::test]
    async fn companion_ipc_saturation_does_not_stop_terminal_delivery() {
        let (slow_writer, _slow_reader) = tokio::io::duplex(1);
        let companion = CompanionIpcSender::spawn(slow_writer);
        companion
            .publish(companion_result_event("active"))
            .expect("the active result should be admitted");
        tokio::time::timeout(Duration::from_secs(1), async {
            while !companion.has_active_write_for_tests() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the companion writer should block on the undrained lane");
        let mut queued = 0;
        for index in 0..MAX_COMPANION_IPC_PENDING_RELIABLE {
            if companion
                .publish(companion_result_event(&format!("queued-{index}")))
                .is_err()
            {
                break;
            }
            queued += 1;
        }
        assert!(queued > 0, "the test should saturate a non-empty queue");

        let saturated = publish_companion_runtime_event(
            &companion,
            "peer-owner".into(),
            "task-1".into(),
            "generation-1".into(),
            1,
            match companion_result_event("rejected") {
                SidecarEvent::CompanionEvent { frame, .. } => frame,
                _ => unreachable!(),
            },
        )
        .expect("queue rejection should surface as a local companion error");
        assert!(matches!(
            saturated,
            SidecarEvent::CompanionEvent {
                frame: ServerFrame::CompanionError { ref code, .. },
                ..
            } if code == "companion_ipc_saturated"
        ));

        let terminal = Arc::new(Mutex::new(Vec::<u8>::new()));
        write_json_line(
            &terminal,
            &SidecarEvent::TerminalEvent {
                peer_id: "peer-owner".into(),
                session_id: "terminal-session".into(),
                observer_lease_id: "lease-test".into(),
                event: kanna_task_transfer::protocol::PeerTerminalEvent::Output {
                    session_id: "terminal-session".into(),
                    data: b"still-live".to_vec(),
                },
            },
        )
        .expect("ordinary terminal delivery must remain writable");
        assert!(!terminal.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn companion_ipc_keeps_reliable_results_while_a_snapshot_write_is_blocked() {
        let (slow_writer, mut slow_reader) = tokio::io::duplex(1);
        let companion = CompanionIpcSender::spawn(slow_writer);
        companion
            .publish(companion_snapshot_event("revision-1", "small"))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !companion.has_active_write_for_tests() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        companion
            .publish(companion_result_event("event-1"))
            .unwrap();
        companion
            .publish(companion_result_event("event-2"))
            .unwrap();

        let first = read_companion_ipc_event(&mut slow_reader).await;
        let second = read_companion_ipc_event(&mut slow_reader).await;
        let third = read_companion_ipc_event(&mut slow_reader).await;
        assert!(matches!(
            first,
            SidecarEvent::CompanionEvent {
                frame: ServerFrame::CompanionSnapshot { .. },
                ..
            }
        ));
        assert!(matches!(
            second,
            SidecarEvent::CompanionEvent {
                frame: ServerFrame::CompanionEventResult { event_id, .. },
                ..
            } if event_id == "event-1"
        ));
        assert!(matches!(
            third,
            SidecarEvent::CompanionEvent {
                frame: ServerFrame::CompanionEventResult { event_id, .. },
                ..
            } if event_id == "event-2"
        ));
    }

    #[tokio::test]
    async fn companion_ipc_drops_a_late_old_generation_behind_a_blocked_write() {
        let (slow_writer, mut slow_reader) = tokio::io::duplex(1);
        let companion = CompanionIpcSender::spawn(slow_writer);
        companion
            .publish(companion_snapshot_event_for_generation(
                "task-blocked",
                "generation-blocked",
                1,
                "revision-blocked",
            ))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !companion.has_active_write_for_tests() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first snapshot should block the IPC writer");

        companion
            .publish(companion_snapshot_event_for_generation(
                "task-recovery",
                "generation-new",
                3,
                "revision-recovery",
            ))
            .unwrap();
        companion
            .publish(companion_snapshot_event_for_generation(
                "task-recovery",
                "generation-old",
                2,
                "revision-late-old",
            ))
            .unwrap();

        let _blocked = read_companion_ipc_event(&mut slow_reader).await;
        let recovery = read_companion_ipc_event(&mut slow_reader).await;
        assert!(matches!(
            recovery,
            SidecarEvent::CompanionEvent {
                generation,
                generation_order: 3,
                frame: ServerFrame::CompanionSnapshot { revision, .. },
                ..
            } if generation == "generation-new" && revision == "revision-recovery"
        ));
    }

    #[tokio::test]
    async fn companion_ipc_reuses_retired_generation_capacity_after_key_churn() {
        let companion = CompanionIpcSender::spawn(tokio::io::sink());

        for index in 0..MAX_COMPANION_IPC_TRACKED_GENERATIONS + 64 {
            let task_id = format!("retired-task-{index}");
            companion
                .publish(companion_snapshot_event_for_generation(
                    &task_id,
                    &format!("generation-{}", index + 1),
                    index as u64 + 1,
                    "revision-1",
                ))
                .unwrap_or_else(|error| {
                    panic!("publication {index} failed before retirement: {error}")
                });
            companion.retire_generation(
                "peer-owner",
                &task_id,
                &format!("generation-{}", index + 1),
            );
        }

        let evicted_key = ("peer-owner".to_owned(), "retired-task-0".to_owned());
        assert!(
            !companion
                .state
                .lock()
                .unwrap()
                .current_generations
                .contains_key(&evicted_key),
            "the oldest retired tombstone should have been evicted"
        );
        companion
            .publish(companion_snapshot_event_for_generation(
                "retired-task-0",
                "generation-1",
                1,
                "revision-late",
            ))
            .expect("an evicted stale publication should be fenced without backpressure");
        assert!(
            !companion
                .state
                .lock()
                .unwrap()
                .current_generations
                .contains_key(&evicted_key),
            "an evicted stale publication recreated its generation entry"
        );

        companion
            .publish(companion_snapshot_event_for_generation(
                "later-active-task",
                "generation-later",
                MAX_COMPANION_IPC_TRACKED_GENERATIONS as u64 + 65,
                "revision-later",
            ))
            .expect("a later publication should survive retired-key churn");
        assert!(
            companion
                .state
                .lock()
                .unwrap()
                .current_generations
                .contains_key(&("peer-owner".to_owned(), "later-active-task".to_owned())),
            "the later publication was not admitted after retired-key churn"
        );
    }

    #[tokio::test]
    async fn companion_ipc_retired_generation_still_fences_late_events() {
        let (writer, mut reader) = tokio::io::duplex(64 * 1024);
        let companion = CompanionIpcSender::spawn(writer);
        companion
            .publish(companion_snapshot_event_for_generation(
                "retired-task",
                "generation-old",
                1,
                "revision-initial",
            ))
            .unwrap();
        let _initial = read_companion_ipc_event(&mut reader).await;

        companion.retire_generation("peer-owner", "retired-task", "generation-old");
        companion
            .publish(companion_snapshot_event_for_generation(
                "retired-task",
                "generation-old",
                1,
                "revision-late",
            ))
            .expect("a fenced late event should be dropped without backpressure");
        assert!(
            tokio::time::timeout(Duration::from_millis(25), reader.read_u32())
                .await
                .is_err(),
            "a late event escaped its retired-generation fence"
        );

        companion
            .publish(companion_snapshot_event_for_generation(
                "retired-task",
                "generation-new",
                2,
                "revision-new",
            ))
            .expect("a newer observation should reactivate the retired key");
        let replacement = read_companion_ipc_event(&mut reader).await;
        assert!(matches!(
            replacement,
            SidecarEvent::CompanionEvent {
                generation,
                generation_order: 2,
                frame: ServerFrame::CompanionSnapshot { revision, .. },
                ..
            } if generation == "generation-new" && revision == "revision-new"
        ));
    }

    #[tokio::test]
    async fn companion_ipc_caps_aggregate_bytes_including_a_blocked_active_write() {
        let (slow_writer, _slow_reader) = tokio::io::duplex(1);
        let companion = CompanionIpcSender::spawn(slow_writer);
        companion
            .publish(maximum_companion_event_for_task("task-active"))
            .expect("first maximum bundle should be admitted");
        tokio::time::timeout(Duration::from_secs(1), async {
            while !companion.has_active_write_for_tests() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first bundle should block in the active write");

        let mut admitted = 1;
        for index in 0..MAX_COMPANION_IPC_PENDING_LATEST {
            let task_id = format!("task-pending-{index}");
            if companion
                .publish(maximum_companion_event_for_task(&task_id))
                .is_err()
            {
                break;
            }
            admitted += 1;
        }

        assert!(
            admitted < MAX_COMPANION_IPC_PENDING_LATEST,
            "the byte cap must reject maximum bundles before the item-count cap"
        );
        assert!(
            companion.retained_bytes_for_tests() <= MAX_COMPANION_IPC_RETAINED_BYTES,
            "active and queued companion IPC frames exceeded the aggregate byte cap"
        );
        assert!(
            companion
                .publish(maximum_companion_event_for_task("task-over-budget"))
                .is_err(),
            "another maximum bundle must be rejected while the reader is blocked"
        );
    }

    #[tokio::test]
    async fn companion_ipc_applies_replacement_deltas_under_the_byte_cap() {
        const INITIAL_ASSET_BYTES: usize = 13 * 1024 * 1024;
        const REPLACEMENT_ASSET_BYTES: usize = 24 * 1024 * 1024;
        let (slow_writer, _slow_reader) = tokio::io::duplex(1);
        let companion = CompanionIpcSender::spawn(slow_writer);
        companion
            .publish(sized_companion_event(
                "task-active",
                "revision-1",
                INITIAL_ASSET_BYTES,
            ))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !companion.has_active_write_for_tests() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first bundle should block in the active write");
        companion
            .publish(sized_companion_event(
                "task-replaced",
                "revision-1",
                INITIAL_ASSET_BYTES,
            ))
            .unwrap();
        companion
            .publish(sized_companion_event(
                "task-other",
                "revision-1",
                INITIAL_ASSET_BYTES,
            ))
            .unwrap();
        let retained_before = companion.retained_bytes_for_tests();

        assert!(
            companion
                .publish(sized_companion_event(
                    "task-replaced",
                    "revision-2",
                    REPLACEMENT_ASSET_BYTES,
                ))
                .is_err(),
            "a replacement whose delta exceeds the aggregate cap must be rejected"
        );
        assert_eq!(
            companion.retained_bytes_for_tests(),
            retained_before,
            "a rejected replacement must leave the prior queued snapshot and accounting intact"
        );
    }

    #[tokio::test]
    async fn stalled_companion_control_does_not_delay_terminal_input_control() {
        let scheduler = ControlRequestScheduler::default();
        let companion_request = ControlRequest::ObservePeerCompanion {
            request_id: "observe-companion".into(),
            target_peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
        };
        let terminal_request = ControlRequest::SendPeerSessionInput {
            request_id: "terminal-input".into(),
            target_peer_id: "peer-owner".into(),
            session_id: "task-1".into(),
            data: b"live".to_vec(),
            submission_boundary: false,
            control_input: false,
        };
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let companion_scheduler = scheduler.clone();
        let companion_entered = Arc::clone(&entered);
        let companion_release = Arc::clone(&release);
        let companion_task = tokio::spawn(async move {
            companion_scheduler
                .run(&companion_request, async move {
                    companion_entered.notify_one();
                    companion_release.notified().await;
                    "companion"
                })
                .await
        });
        entered.notified().await;

        let terminal = tokio::time::timeout(
            Duration::from_millis(100),
            scheduler.run(&terminal_request, async { "terminal" }),
        )
        .await
        .expect("terminal input control must bypass a stalled companion observation");
        assert_eq!(terminal, "terminal");
        release.notify_one();
        assert_eq!(companion_task.await.unwrap(), "companion");
    }

    #[tokio::test]
    async fn companion_control_preserves_order_per_observation() {
        let scheduler = ControlRequestScheduler::default();
        let first_request = ControlRequest::ObservePeerCompanion {
            request_id: "observe-companion".into(),
            target_peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
        };
        let second_request = ControlRequest::SendPeerCompanionEvent {
            request_id: "companion-event".into(),
            target_peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            session_id: "session-1".into(),
            revision: "revision-1".into(),
            generation: "generation-1".into(),
            event: kanna_agent_protocol::CompanionEvent {
                event_id: "event-1".into(),
                session_id: "session-1".into(),
                revision: "revision-1".into(),
                event_type: "click".into(),
                choice: "grid".into(),
                text: "Grid".into(),
                element_id: None,
                timestamp: 1,
            },
        };
        let order = Arc::new(Mutex::new(Vec::new()));
        let release = Arc::new(tokio::sync::Notify::new());
        let first_scheduler = scheduler.clone();
        let first_order = Arc::clone(&order);
        let first_release = Arc::clone(&release);
        let first = tokio::spawn(async move {
            first_scheduler
                .run(&first_request, async move {
                    first_order.lock().unwrap().push("first-start");
                    first_release.notified().await;
                    first_order.lock().unwrap().push("first-end");
                })
                .await
        });
        tokio::task::yield_now().await;
        let second_scheduler = scheduler.clone();
        let second_order = Arc::clone(&order);
        let second = tokio::spawn(async move {
            second_scheduler
                .run(&second_request, async move {
                    second_order.lock().unwrap().push("second");
                })
                .await
        });
        tokio::task::yield_now().await;
        assert_eq!(*order.lock().unwrap(), vec!["first-start"]);

        release.notify_one();
        first.await.unwrap();
        second.await.unwrap();
        assert_eq!(
            *order.lock().unwrap(),
            vec!["first-start", "first-end", "second"],
        );
    }

    #[tokio::test]
    async fn companion_control_serializes_replacement_generations_per_peer_task() {
        let scheduler = ControlRequestScheduler::default();
        let first_request = ControlRequest::ObservePeerCompanion {
            request_id: "observe-generation-1".into(),
            target_peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
        };
        let replacement_request = ControlRequest::ObservePeerCompanion {
            request_id: "observe-generation-2".into(),
            target_peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-2".into(),
        };
        let first_entered = Arc::new(tokio::sync::Notify::new());
        let release_first = Arc::new(tokio::sync::Notify::new());
        let replacement_entered = Arc::new(tokio::sync::Notify::new());

        let first_scheduler = scheduler.clone();
        let first_entered_for_task = Arc::clone(&first_entered);
        let release_first_for_task = Arc::clone(&release_first);
        let first = tokio::spawn(async move {
            first_scheduler
                .run(&first_request, async move {
                    first_entered_for_task.notify_one();
                    release_first_for_task.notified().await;
                })
                .await;
        });
        first_entered.notified().await;

        let replacement_scheduler = scheduler.clone();
        let replacement_entered_for_task = Arc::clone(&replacement_entered);
        let replacement = tokio::spawn(async move {
            replacement_scheduler
                .run(&replacement_request, async move {
                    replacement_entered_for_task.notify_one();
                })
                .await;
        });
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(25),
                replacement_entered.notified(),
            )
            .await
            .is_err(),
            "generation 2 bypassed the in-flight generation 1 installation",
        );

        release_first.notify_one();
        first.await.unwrap();
        replacement.await.unwrap();
    }

    async fn read_companion_ipc_event<R>(reader: &mut R) -> SidecarEvent
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        tokio::time::timeout(Duration::from_secs(1), async {
            let length = reader.read_u32().await.unwrap() as usize;
            let mut encoded = vec![0; length];
            reader.read_exact(&mut encoded).await.unwrap();
            serde_json::from_slice(&encoded).unwrap()
        })
        .await
        .expect("companion IPC event should arrive")
    }

    fn companion_snapshot_event(revision: &str, html: &str) -> SidecarEvent {
        SidecarEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionSnapshot {
                task_id: "task-1".into(),
                session_id: "session-1".into(),
                revision: revision.into(),
                document_kind: CompanionDocumentKind::Fragment,
                html: html.into(),
                source_origin: None,
                assets: vec![],
                attachment_epoch: None,
            },
        }
    }

    fn companion_snapshot_event_for_generation(
        task_id: &str,
        generation: &str,
        generation_order: u64,
        revision: &str,
    ) -> SidecarEvent {
        SidecarEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: task_id.into(),
            generation: generation.into(),
            generation_order,
            frame: ServerFrame::CompanionSnapshot {
                task_id: task_id.into(),
                session_id: "session-1".into(),
                revision: revision.into(),
                document_kind: CompanionDocumentKind::Fragment,
                html: "<p>snapshot</p>".into(),
                source_origin: None,
                assets: vec![],
                attachment_epoch: None,
            },
        }
    }

    fn companion_result_event(event_id: &str) -> SidecarEvent {
        SidecarEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionEventResult {
                task_id: "task-1".into(),
                session_id: Some("session-1".into()),
                revision: Some("revision-1".into()),
                event_id: event_id.into(),
                accepted: true,
                code: None,
                message: None,
                attachment_epoch: None,
            },
        }
    }

    fn maximum_companion_event() -> SidecarEvent {
        maximum_companion_event_for_task("task-1")
    }

    fn maximum_companion_event_for_task(task_id: &str) -> SidecarEvent {
        let raw_asset_bytes = MAX_COMPANION_ASSET_TOTAL_BYTES as usize / MAX_COMPANION_ASSET_COUNT;
        let assets = (0..MAX_COMPANION_ASSET_COUNT)
            .map(|index| CompanionAsset {
                name: format!("asset-{index}.bin"),
                content_type: "application/octet-stream".into(),
                digest: format!("digest-{index}"),
                data_b64: base64::engine::general_purpose::STANDARD
                    .encode(vec![index as u8; raw_asset_bytes]),
            })
            .collect();
        SidecarEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: task_id.into(),
            generation: "generation-1".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionSnapshot {
                task_id: task_id.into(),
                session_id: "session-1".into(),
                revision: "revision-max".into(),
                document_kind: CompanionDocumentKind::Fragment,
                html: "x".repeat(MAX_COMPANION_HTML_BYTES as usize),
                source_origin: None,
                assets,
                attachment_epoch: None,
            },
        }
    }

    fn sized_companion_event(
        task_id: &str,
        revision: &str,
        raw_asset_bytes: usize,
    ) -> SidecarEvent {
        companion_snapshot_event_with_assets(
            task_id,
            revision,
            vec![CompanionAsset {
                name: "preview.png".into(),
                content_type: "image/png".into(),
                digest: "digest-preview".into(),
                data_b64: base64::engine::general_purpose::STANDARD
                    .encode(vec![0; raw_asset_bytes]),
            }],
        )
    }

    fn companion_snapshot_event_with_assets(
        task_id: &str,
        revision: &str,
        assets: Vec<CompanionAsset>,
    ) -> SidecarEvent {
        SidecarEvent::CompanionEvent {
            peer_id: "peer-owner".into(),
            task_id: task_id.into(),
            generation: "generation-1".into(),
            generation_order: 1,
            frame: ServerFrame::CompanionSnapshot {
                task_id: task_id.into(),
                session_id: "session-1".into(),
                revision: revision.into(),
                document_kind: CompanionDocumentKind::Fragment,
                html: "preview".into(),
                source_origin: None,
                assets,
                attachment_epoch: None,
            },
        }
    }
}
