use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, RawQuery, State};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::Engine as _;
use futures_util::{SinkExt as _, StreamExt as _};
use kanna_agent_protocol::{CompanionAsset, CompanionEvent};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path as FsPath};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock, Weak};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, watch, Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio::time::Instant;

const DEFAULT_GRACE_PERIOD: Duration = Duration::from_secs(30);
const DEFAULT_HTTP_HEADER_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BRIDGE_ENTRIES: usize = 16;
const MAX_TOTAL_BUNDLE_BYTES: usize = 64 * 1024 * 1024;
const MAX_RENDERED_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ASSET_COUNT: usize = 32;
const MAX_ASSET_BYTES: usize = 4 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES: usize = 16 * 1024 * 1024;
const MAX_BUNDLE_PREPARATION_WORKERS: usize = 2;
const MAX_BROWSER_CONNECTIONS: usize = 8;
const MAX_HTTP_CONNECTIONS: usize = 32;
const MAX_HTTP_HEADER_BYTES: usize = 32 * 1024;
const MAX_PENDING_EVENTS: usize = 64;
const MAX_BROWSER_EVENT_BYTES: usize = 8 * 1024;
const MAX_EVENT_ID_BYTES: usize = 128;
const MAX_CHOICE_BYTES: usize = 256;
const MAX_TEXT_BYTES: usize = 4 * 1024;
const MAX_ELEMENT_ID_BYTES: usize = 256;
const MAX_LIFECYCLE_STRING_BYTES: usize = 4 * 1024;
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;
const NOTIFICATION_CAPACITY: usize = 32;
const COOKIE_NAME: &str = "kanna_companion";
const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
const ASSET_CONTENT_SECURITY_POLICY: &str = "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox";

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct CompanionBridgeKey {
    pub owner_window_label: String,
    pub owner_lease_generation: String,
    pub owner_desktop_id: String,
    pub owner_task_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompanionBridgeBundle {
    pub session_id: String,
    pub revision: String,
    pub document_html: String,
    pub lifecycle_page_strings: CompanionLifecyclePageStrings,
    pub assets: Vec<CompanionAsset>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompanionLifecyclePageStrings {
    pub unavailable_title: String,
    pub unavailable_detail: String,
    pub error_title: String,
    pub error_detail: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompanionBridgeLifecycle {
    Available,
    Reconnecting,
    Unavailable,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompanionBridgeStateUpdate {
    pub status: CompanionBridgeLifecycle,
    pub selected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompanionBridgeEventResult {
    pub session_id: String,
    pub revision: String,
    pub event_id: String,
    pub accepted: bool,
    pub code: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionBrowserEvent {
    #[serde(skip)]
    pub owner_window_label: String,
    pub bridge_id: String,
    pub session_id: String,
    pub revision: String,
    pub event: CompanionEvent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionBridgeHandle {
    pub bridge_id: String,
    pub base_url: String,
    pub entry_url: String,
}

#[cfg(test)]
type PhasedTestBarriers<P> = Option<(P, Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>)>;

pub struct CompanionBridgeManager {
    entries: Mutex<HashMap<CompanionBridgeKey, Arc<CompanionBridgeEntry>>>,
    window_leases: Mutex<HashMap<String, WindowLeaseState>>,
    browser_events: mpsc::Sender<CompanionBrowserEvent>,
    grace_period: Duration,
    http_header_timeout: Duration,
    bundle_preparation_slots: Arc<Semaphore>,
    closed: AtomicBool,
    #[cfg(test)]
    cleanup_barriers: StdMutex<Option<(Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>)>>,
    #[cfg(test)]
    handshake_barriers: StdMutex<PhasedTestBarriers<HandshakePhase>>,
    #[cfg(test)]
    publication_barriers: StdMutex<PhasedTestBarriers<PublicationPhase>>,
    #[cfg(test)]
    lease_claim_barriers: StdMutex<Option<(Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>)>>,
    #[cfg(test)]
    bundle_preparation_gate: StdMutex<Option<(String, Arc<BundlePreparationTestGate>)>>,
}

#[derive(Default)]
struct WindowLeaseState {
    current: Option<String>,
    retired: HashSet<String>,
    destroyed: bool,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HandshakePhase {
    BeforeReservation,
    AfterReservation,
    BeforeInitialStatus,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublicationPhase {
    SetState(CompanionBridgeLifecycle),
    BundleAvailable,
}

#[cfg(test)]
struct BundlePreparationTestGate {
    released: StdMutex<bool>,
    release: std::sync::Condvar,
}

#[cfg(test)]
impl BundlePreparationTestGate {
    fn wait(&self) {
        let mut released = self
            .released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !*released {
            released = self
                .release
                .wait(released)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn release(&self) {
        *self
            .released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        self.release.notify_all();
    }
}

struct CompanionBridgeEntry {
    owner_window_label: String,
    owner_lease_generation: String,
    bridge_id: String,
    advertised_host_port: String,
    base_url: String,
    cookie_value: String,
    capability: StdMutex<Option<String>>,
    state: RwLock<EntryState>,
    bundle_bytes: AtomicUsize,
    state_changed: broadcast::Sender<()>,
    bundle_identity: watch::Sender<CompanionDocumentIdentity>,
    next_browser_id: AtomicU64,
    shutdown: watch::Sender<bool>,
}

struct EntryState {
    bundle: Arc<StoredBundle>,
    lifecycle: CompanionBridgeLifecycle,
    selected: bool,
    grace: Option<GraceAnchor>,
    next_grace_generation: u64,
    browser_connections: HashMap<u64, BrowserConnection>,
    pending_events: HashMap<String, PendingEventIdentity>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompanionDocumentIdentity {
    session_id: String,
    revision: String,
}

struct GraceAnchor {
    generation: u64,
    deadline: Instant,
    cleanup_scheduled: bool,
}

struct PendingEventIdentity {
    session_id: String,
    revision: String,
    connection_id: u64,
    result_permit: OwnedSemaphorePermit,
}

struct BrowserConnection {
    document_identity: CompanionDocumentIdentity,
    results: mpsc::Sender<ReliableBrowserNotification>,
    result_slots: Arc<Semaphore>,
}

enum BrowserReservation {
    Current(u64),
    Stale,
}

struct ReliableBrowserNotification {
    notification: BrowserNotification,
    _result_permit: OwnedSemaphorePermit,
}

#[derive(PartialEq, Eq)]
struct StoredBundle {
    session_id: String,
    revision: String,
    document: Bytes,
    lifecycle_page_strings: CompanionLifecyclePageStrings,
    assets: HashMap<String, StoredAsset>,
    byte_len: usize,
}

#[derive(PartialEq, Eq)]
struct StoredAsset {
    content_type: HeaderValue,
    attachment: bool,
    data: Bytes,
}

#[derive(Clone)]
struct BridgeRouteState {
    entry: Arc<CompanionBridgeEntry>,
    manager: Weak<CompanionBridgeManager>,
    browser_events: mpsc::Sender<CompanionBrowserEvent>,
}

struct ActiveBrowserGuard {
    manager: Arc<CompanionBridgeManager>,
    entry: Arc<CompanionBridgeEntry>,
    connection_id: u64,
    released: bool,
}

impl ActiveBrowserGuard {
    async fn release(mut self) {
        self.released = true;
        self.manager
            .release_browser(&self.entry, self.connection_id)
            .await;
    }
}

impl Drop for ActiveBrowserGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let manager = self.manager.clone();
        let entry = self.entry.clone();
        let connection_id = self.connection_id;
        tauri::async_runtime::spawn(async move {
            manager.release_browser(&entry, connection_id).await;
        });
    }
}

struct BoundedHeaderIo {
    stream: tokio::net::TcpStream,
    header: Vec<u8>,
    terminator_state: usize,
    response_header: Vec<u8>,
    response_terminator_state: usize,
    awaiting_upgrade_response: bool,
    websocket_upgraded: bool,
}

impl BoundedHeaderIo {
    fn new(stream: tokio::net::TcpStream) -> Self {
        Self {
            stream,
            header: Vec::with_capacity(1024),
            terminator_state: 0,
            response_header: Vec::with_capacity(1024),
            response_terminator_state: 0,
            awaiting_upgrade_response: false,
            websocket_upgraded: false,
        }
    }

    fn inspect(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        if self.websocket_upgraded {
            return Ok(());
        }
        for byte in bytes {
            if self.websocket_upgraded {
                return Ok(());
            }
            self.header.push(*byte);
            if self.header.len() > MAX_HTTP_HEADER_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "HTTP request headers exceed the bridge limit",
                ));
            }
            self.terminator_state = match (self.terminator_state, *byte) {
                (0, b'\r') => 1,
                (1, b'\n') => 2,
                (2, b'\r') => 3,
                (3, b'\n') => 4,
                (_, b'\r') => 1,
                _ => 0,
            };
            if self.terminator_state == 4 {
                let normalized = String::from_utf8_lossy(&self.header).to_ascii_lowercase();
                let mut lines = normalized.lines();
                let is_websocket_target = lines.next().is_some_and(|request_line| {
                    let mut parts = request_line.split_whitespace();
                    let method = parts.next();
                    let target = parts.next();
                    let version = parts.next();
                    parts.next().is_none()
                        && method == Some("get")
                        && target
                            .is_some_and(|target| target == "/ws" || target.starts_with("/ws?"))
                        && version == Some("http/1.1")
                });
                let has_websocket_upgrade = lines.any(|line| {
                    line.split_once(':').is_some_and(|(name, value)| {
                        name.trim() == "upgrade" && value.trim().eq_ignore_ascii_case("websocket")
                    })
                });
                self.awaiting_upgrade_response = is_websocket_target && has_websocket_upgrade;
                self.header.clear();
                self.terminator_state = 0;
            }
        }
        Ok(())
    }

    fn inspect_response(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        if self.websocket_upgraded || !self.awaiting_upgrade_response {
            return Ok(());
        }
        for byte in bytes {
            self.response_header.push(*byte);
            if self.response_header.len() > MAX_HTTP_HEADER_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "HTTP response headers exceed the bridge limit",
                ));
            }
            self.response_terminator_state = match (self.response_terminator_state, *byte) {
                (0, b'\r') => 1,
                (1, b'\n') => 2,
                (2, b'\r') => 3,
                (3, b'\n') => 4,
                (_, b'\r') => 1,
                _ => 0,
            };
            if self.response_terminator_state == 4 {
                self.websocket_upgraded = self
                    .response_header
                    .split(|byte| *byte == b'\n')
                    .next()
                    .is_some_and(|status| status.starts_with(b"HTTP/1.1 101 "));
                self.awaiting_upgrade_response = false;
                self.response_header.clear();
                self.response_terminator_state = 0;
                break;
            }
        }
        Ok(())
    }
}

impl AsyncRead for BoundedHeaderIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let mut storage = [0_u8; 8192];
        let limit = storage.len().min(output.remaining());
        if limit == 0 {
            return Poll::Ready(Ok(()));
        }
        let mut input = ReadBuf::new(&mut storage[..limit]);
        match Pin::new(&mut self.stream).poll_read(context, &mut input) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Ready(Ok(())) => {
                let filled = input.filled();
                if let Err(error) = self.inspect(filled) {
                    return Poll::Ready(Err(error));
                }
                output.put_slice(filled);
                Poll::Ready(Ok(()))
            }
        }
    }
}

impl AsyncWrite for BoundedHeaderIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match Pin::new(&mut self.stream).poll_write(context, bytes) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Ready(Ok(written)) => {
                if let Err(error) = self.inspect_response(&bytes[..written]) {
                    return Poll::Ready(Err(error));
                }
                Poll::Ready(Ok(written))
            }
        }
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(context)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BrowserNotification {
    Reload,
    Status {
        status: CompanionBridgeLifecycle,
    },
    EventResult {
        event_id: String,
        accepted: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserMessage {
    #[serde(rename = "type")]
    message_type: String,
    event: BrowserCompanionEvent,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserCompanionEvent {
    event_id: String,
    #[serde(rename = "type")]
    event_type: String,
    choice: String,
    text: String,
    #[serde(rename = "id")]
    element_id: Option<String>,
    timestamp: u64,
}

impl From<BrowserCompanionEvent> for CompanionEvent {
    fn from(event: BrowserCompanionEvent) -> Self {
        Self {
            session_id: String::new(),
            revision: String::new(),
            event_id: event.event_id,
            event_type: event.event_type,
            choice: event.choice,
            text: event.text,
            element_id: event.element_id,
            timestamp: event.timestamp,
        }
    }
}

impl CompanionBridgeManager {
    pub fn new(browser_events: mpsc::Sender<CompanionBrowserEvent>) -> Self {
        Self::with_grace_period(browser_events, DEFAULT_GRACE_PERIOD)
    }

    fn with_grace_period(
        browser_events: mpsc::Sender<CompanionBrowserEvent>,
        grace_period: Duration,
    ) -> Self {
        Self::with_timeouts(browser_events, grace_period, DEFAULT_HTTP_HEADER_TIMEOUT)
    }

    fn with_timeouts(
        browser_events: mpsc::Sender<CompanionBrowserEvent>,
        grace_period: Duration,
        http_header_timeout: Duration,
    ) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            window_leases: Mutex::new(HashMap::new()),
            browser_events,
            grace_period,
            http_header_timeout,
            bundle_preparation_slots: Arc::new(Semaphore::new(MAX_BUNDLE_PREPARATION_WORKERS)),
            closed: AtomicBool::new(false),
            #[cfg(test)]
            cleanup_barriers: StdMutex::new(None),
            #[cfg(test)]
            handshake_barriers: StdMutex::new(None),
            #[cfg(test)]
            publication_barriers: StdMutex::new(None),
            #[cfg(test)]
            lease_claim_barriers: StdMutex::new(None),
            #[cfg(test)]
            bundle_preparation_gate: StdMutex::new(None),
        }
    }

    #[cfg(test)]
    fn install_bundle_preparation_gate(&self, session_id: &str) -> Arc<BundlePreparationTestGate> {
        let gate = Arc::new(BundlePreparationTestGate {
            released: StdMutex::new(false),
            release: std::sync::Condvar::new(),
        });
        *self
            .bundle_preparation_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            Some((session_id.to_owned(), Arc::clone(&gate)));
        gate
    }

    #[cfg(test)]
    fn bundle_preparation_gate(&self, session_id: &str) -> Option<Arc<BundlePreparationTestGate>> {
        self.bundle_preparation_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .filter(|(candidate, _)| candidate == session_id)
            .map(|(_, gate)| Arc::clone(gate))
    }

    #[cfg(test)]
    async fn wait_handshake_phase(&self, phase: HandshakePhase) {
        let barriers = self
            .handshake_barriers
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .as_ref()
            .filter(|(candidate, _, _)| *candidate == phase)
            .map(|(_, reached, release)| (reached.clone(), release.clone()));
        if let Some((reached, release)) = barriers {
            reached.wait().await;
            release.wait().await;
        }
    }

    #[cfg(test)]
    async fn wait_publication_phase(&self, phase: PublicationPhase) {
        let barriers = self
            .publication_barriers
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .as_ref()
            .filter(|(candidate, _, _)| *candidate == phase)
            .map(|(_, reached, release)| (reached.clone(), release.clone()));
        if let Some((reached, release)) = barriers {
            reached.wait().await;
            release.wait().await;
        }
    }

    #[cfg(test)]
    async fn wait_lease_claim_barrier(&self) {
        let barriers = self
            .lease_claim_barriers
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .clone();
        if let Some((reached, release)) = barriers {
            reached.wait().await;
            release.wait().await;
        }
    }

    pub async fn upsert(
        self: &Arc<Self>,
        key: CompanionBridgeKey,
        bundle: CompanionBridgeBundle,
    ) -> Result<CompanionBridgeHandle, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("visual companion bridge is shutting down".into());
        }
        let preparation_slot = Arc::clone(&self.bundle_preparation_slots)
            .acquire_owned()
            .await
            .map_err(|_| "visual companion bridge is shutting down".to_string())?;
        if self.closed.load(Ordering::Acquire) {
            return Err("visual companion bridge is shutting down".into());
        }
        #[cfg(test)]
        let preparation_gate = self.bundle_preparation_gate(&bundle.session_id);
        let preparation_key = key.clone();
        let stored = tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            if let Some(gate) = preparation_gate {
                gate.wait();
            }
            validate_key(&preparation_key)?;
            StoredBundle::try_from_bundle(&preparation_key, bundle)
        })
        .await
        .map_err(|_| "visual companion bundle preparation failed".to_string())??;
        drop(preparation_slot);
        let stored = Arc::new(stored);
        self.claim_window_lease(&key.owner_window_label, &key.owner_lease_generation)
            .await?;
        #[cfg(test)]
        self.wait_lease_claim_barrier().await;

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| "failed to start visual companion bridge".to_string())?;
        let port = listener
            .local_addr()
            .map_err(|_| "failed to start visual companion bridge".to_string())?
            .port();
        let host_token = random_hex_128()?;
        let advertised_host = format!("{host_token}.localhost");
        let advertised_host_port = format!("{advertised_host}:{port}");
        let base_url = format!("http://{advertised_host_port}");
        let bridge_id = random_hex_128()?;
        let cookie_value = random_hex_128()?;
        let capability = random_hex_128()?;
        let (state_changed, _) = broadcast::channel(NOTIFICATION_CAPACITY);
        let (bundle_identity, _) = watch::channel(stored.document_identity());
        let (shutdown, _) = watch::channel(false);
        let entry = Arc::new(CompanionBridgeEntry {
            owner_window_label: key.owner_window_label.clone(),
            owner_lease_generation: key.owner_lease_generation.clone(),
            bridge_id,
            advertised_host_port,
            base_url,
            cookie_value,
            capability: StdMutex::new(Some(capability)),
            bundle_bytes: AtomicUsize::new(stored.byte_len),
            state: RwLock::new(EntryState {
                bundle: stored,
                lifecycle: CompanionBridgeLifecycle::Available,
                selected: true,
                grace: None,
                next_grace_generation: 0,
                browser_connections: HashMap::new(),
                pending_events: HashMap::new(),
            }),
            state_changed,
            bundle_identity,
            next_browser_id: AtomicU64::new(1),
            shutdown,
        });

        let winner = {
            let leases = self.window_leases.lock().await;
            if leases
                .get(&key.owner_window_label)
                .and_then(|state| state.current.as_deref())
                != Some(key.owner_lease_generation.as_str())
            {
                return Err("visual companion bridge lease is not current".into());
            }
            let mut entries = self.entries.lock().await;
            if let Some(existing) = entries.get(&key).cloned() {
                Some(existing)
            } else {
                if entries.len() >= MAX_BRIDGE_ENTRIES {
                    return Err("too many visual companion bridges are open".into());
                }
                let total = entries
                    .values()
                    .map(|entry| entry.bundle_bytes.load(Ordering::Acquire))
                    .sum::<usize>();
                if total.saturating_add(entry.bundle_bytes.load(Ordering::Acquire))
                    > MAX_TOTAL_BUNDLE_BYTES
                {
                    return Err("visual companion bridges exceed their resource limit".into());
                }
                entries.insert(key, entry.clone());
                None
            }
        };
        if let Some(existing) = winner {
            self.replace_entry_bundle(&existing, entry.current_bundle())
                .await?;
            return existing.issue_handle();
        }

        self.spawn_entry_server(listener, entry.clone());
        entry.issue_handle()
    }

    async fn replace_entry_bundle(
        &self,
        entry: &Arc<CompanionBridgeEntry>,
        bundle: Arc<StoredBundle>,
    ) -> Result<(), String> {
        let entries = self.entries.lock().await;
        if !entries
            .values()
            .any(|candidate| Arc::ptr_eq(candidate, entry))
        {
            return Err("visual companion bridge not found".into());
        }
        let total = entries
            .values()
            .map(|candidate| candidate.bundle_bytes.load(Ordering::Acquire))
            .sum::<usize>();
        let old_len = entry.bundle_bytes.load(Ordering::Acquire);
        if total
            .saturating_sub(old_len)
            .saturating_add(bundle.byte_len)
            > MAX_TOTAL_BUNDLE_BYTES
        {
            return Err("visual companion bridges exceed their resource limit".into());
        }
        let (changed, status_changed) = {
            let mut state = entry.state.write().unwrap_or_else(|lock| lock.into_inner());
            let status_changed = state.lifecycle != CompanionBridgeLifecycle::Available;
            state.lifecycle = CompanionBridgeLifecycle::Available;
            if state.bundle.as_ref() == bundle.as_ref() {
                (false, status_changed)
            } else {
                state.bundle = bundle;
                state.pending_events.clear();
                entry
                    .bundle_identity
                    .send_replace(state.bundle.document_identity());
                (true, status_changed)
            }
        };
        entry
            .bundle_bytes
            .store(entry.current_bundle().byte_len, Ordering::Release);
        drop(entries);
        if !changed && status_changed {
            #[cfg(test)]
            self.wait_publication_phase(PublicationPhase::BundleAvailable)
                .await;
            let _ = entry.state_changed.send(());
        }
        Ok(())
    }

    fn spawn_entry_server(
        self: &Arc<Self>,
        listener: TcpListener,
        entry: Arc<CompanionBridgeEntry>,
    ) {
        let route_state = Arc::new(BridgeRouteState {
            entry: entry.clone(),
            manager: Arc::downgrade(self),
            browser_events: self.browser_events.clone(),
        });
        let router = Router::new()
            .route("/", get(root))
            .route("/files/{name}", get(asset))
            .route("/ws", get(websocket))
            .fallback(not_found)
            .layer(middleware::from_fn(enforce_narrow_request))
            .layer(middleware::from_fn_with_state(
                route_state.clone(),
                validate_exact_host,
            ))
            .with_state(route_state);
        let shutdown = entry.shutdown.subscribe();
        let manager = Arc::downgrade(self);
        let bridge_id = entry.bridge_id.clone();
        let header_timeout = self.http_header_timeout;
        tauri::async_runtime::spawn(async move {
            serve_entry_http(listener, router, shutdown, header_timeout).await;
            if let Some(manager) = manager.upgrade() {
                manager.remove_by_id_if_present(&bridge_id).await;
            }
        });
    }

    pub async fn set_state(
        self: &Arc<Self>,
        bridge_id: &str,
        update: CompanionBridgeStateUpdate,
    ) -> Result<(), String> {
        let entry = self
            .entry_by_id(bridge_id)
            .await
            .ok_or_else(|| "visual companion bridge not found".to_string())?;
        {
            let mut state = entry.state.write().unwrap_or_else(|lock| lock.into_inner());
            state.lifecycle = update.status;
            if update.selected {
                if !state.selected || state.grace.is_some() {
                    state.next_grace_generation = state.next_grace_generation.wrapping_add(1);
                    state.grace = None;
                }
            } else if state.selected || state.grace.is_none() {
                state.next_grace_generation = state.next_grace_generation.wrapping_add(1);
                state.grace = Some(GraceAnchor {
                    generation: state.next_grace_generation,
                    deadline: Instant::now() + self.grace_period,
                    cleanup_scheduled: false,
                });
            }
            state.selected = update.selected;
            if update.status != CompanionBridgeLifecycle::Available {
                state.pending_events.clear();
            }
        }
        #[cfg(test)]
        self.wait_publication_phase(PublicationPhase::SetState(update.status))
            .await;
        let _ = entry.state_changed.send(());
        self.reconcile_entry(&entry).await;
        Ok(())
    }

    pub async fn set_event_result(
        &self,
        bridge_id: &str,
        result: CompanionBridgeEventResult,
    ) -> Result<(), String> {
        if result.event_id.is_empty() || result.event_id.len() > MAX_EVENT_ID_BYTES {
            return Err("visual companion event result is invalid".into());
        }
        let entry = self
            .entry_by_id(bridge_id)
            .await
            .ok_or_else(|| "visual companion bridge not found".to_string())?;
        let (result_sender, pending) = {
            let mut state = entry.state.write().unwrap_or_else(|lock| lock.into_inner());
            let pending = state.pending_events.get(&result.event_id);
            let connection_id = pending
                .filter(|pending| {
                    pending.session_id == result.session_id && pending.revision == result.revision
                })
                .map(|pending| pending.connection_id)
                .ok_or_else(|| "visual companion event is no longer pending".to_string())?;
            let sender = state
                .browser_connections
                .get(&connection_id)
                .map(|connection| connection.results.clone())
                .ok_or_else(|| "visual companion browser is no longer connected".to_string())?;
            let pending = state
                .pending_events
                .remove(&result.event_id)
                .expect("validated pending event must remain under the state lock");
            (sender, pending)
        };
        let accepted = result.accepted;
        let notification = BrowserNotification::EventResult {
            event_id: result.event_id,
            accepted,
            code: if accepted {
                None
            } else {
                sanitize_code(result.code.as_deref())
            },
            message: if accepted {
                None
            } else {
                Some("Selection failed. Try again.".into())
            },
        };
        result_sender
            .try_send(ReliableBrowserNotification {
                notification,
                _result_permit: pending.result_permit,
            })
            .map_err(|_| "visual companion browser result channel is unavailable".to_string())
    }

    pub async fn close(&self, bridge_id: &str) -> Result<(), String> {
        let entry = self
            .remove_by_id(bridge_id)
            .await
            .ok_or_else(|| "visual companion bridge not found".to_string())?;
        entry.shutdown();
        Ok(())
    }

    pub async fn close_owned_by_window(&self, owner_window_label: &str) -> usize {
        let removed = {
            let mut leases = self.window_leases.lock().await;
            let state = leases.entry(owner_window_label.to_owned()).or_default();
            state.destroyed = true;
            if let Some(current) = state.current.take() {
                state.retired.insert(current);
            }
            let mut entries = self.entries.lock().await;
            let keys = entries
                .iter()
                .filter(|(_, entry)| entry.owner_window_label == owner_window_label)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| entries.remove(&key))
                .collect::<Vec<_>>()
        };
        let removed_count = removed.len();
        for entry in removed {
            entry.shutdown();
        }
        removed_count
    }

    pub async fn close_owned_by_lease(
        &self,
        owner_window_label: &str,
        owner_lease_generation: &str,
    ) -> usize {
        {
            let mut leases = self.window_leases.lock().await;
            if let Some(state) = leases.get_mut(owner_window_label) {
                if state.current.as_deref() == Some(owner_lease_generation) {
                    let retired = state.current.take().expect("current lease was checked");
                    state.retired.insert(retired);
                }
            }
        }
        self.close_owned_entries(|entry| {
            entry.owner_window_label == owner_window_label
                && entry.owner_lease_generation == owner_lease_generation
        })
        .await
    }

    pub async fn ensure_lease(
        &self,
        bridge_id: &str,
        owner_window_label: &str,
        owner_lease_generation: &str,
    ) -> Result<(), String> {
        if self
            .window_leases
            .lock()
            .await
            .get(owner_window_label)
            .and_then(|state| state.current.as_deref())
            != Some(owner_lease_generation)
        {
            return Err("visual companion bridge lease is not current".into());
        }
        self.entry_by_id(bridge_id)
            .await
            .ok_or_else(|| "visual companion bridge not found".to_string())?
            .ensure_owner(owner_window_label, owner_lease_generation)
    }

    #[cfg(test)]
    async fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        let entries = {
            let mut entries = self.entries.lock().await;
            entries.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
        };
        self.window_leases.lock().await.clear();
        for entry in entries {
            entry.shutdown();
        }
    }

    async fn entry_by_id(&self, bridge_id: &str) -> Option<Arc<CompanionBridgeEntry>> {
        self.entries
            .lock()
            .await
            .values()
            .find(|entry| entry.bridge_id == bridge_id)
            .cloned()
    }

    async fn remove_by_id(&self, bridge_id: &str) -> Option<Arc<CompanionBridgeEntry>> {
        let mut entries = self.entries.lock().await;
        let key = entries
            .iter()
            .find_map(|(key, entry)| (entry.bridge_id == bridge_id).then(|| key.clone()))?;
        entries.remove(&key)
    }

    async fn remove_by_id_if_present(&self, bridge_id: &str) {
        let _ = self.remove_by_id(bridge_id).await;
    }

    async fn claim_window_lease(
        &self,
        owner_window_label: &str,
        current_lease_generation: &str,
    ) -> Result<(), String> {
        let retired = {
            let mut leases = self.window_leases.lock().await;
            let state = leases.entry(owner_window_label.to_owned()).or_default();
            if state.destroyed {
                return Err("visual companion bridge window is destroyed".into());
            }
            if state.current.as_deref() != Some(current_lease_generation) {
                if state.retired.contains(current_lease_generation) {
                    return Err("visual companion bridge lease is retired".into());
                }
                if let Some(previous) = state.current.replace(current_lease_generation.to_owned()) {
                    state.retired.insert(previous);
                }
            }
            let mut entries = self.entries.lock().await;
            let keys = entries
                .iter()
                .filter(|(_, entry)| {
                    entry.owner_window_label == owner_window_label
                        && entry.owner_lease_generation != current_lease_generation
                })
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| entries.remove(&key))
                .collect::<Vec<_>>()
        };
        for entry in retired {
            entry.shutdown();
        }
        Ok(())
    }

    async fn close_owned_entries(&self, owns: impl Fn(&CompanionBridgeEntry) -> bool) -> usize {
        let removed = {
            let mut entries = self.entries.lock().await;
            let keys = entries
                .iter()
                .filter(|(_, entry)| owns(entry))
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| entries.remove(&key))
                .collect::<Vec<_>>()
        };
        let removed_count = removed.len();
        for entry in removed {
            entry.shutdown();
        }
        removed_count
    }

    async fn reconcile_entry(self: &Arc<Self>, entry: &Arc<CompanionBridgeEntry>) {
        let mut removed_entry = None;
        let mut grace_cleanup = None;
        {
            let mut entries = self.entries.lock().await;
            let Some(key) = entries
                .iter()
                .find_map(|(key, candidate)| Arc::ptr_eq(candidate, entry).then(|| key.clone()))
            else {
                return;
            };
            let mut state = entry.state.write().unwrap_or_else(|lock| lock.into_inner());
            if !state.browser_connections.is_empty() {
                return;
            }
            let mut should_remove = false;
            if state.lifecycle == CompanionBridgeLifecycle::Unavailable {
                should_remove = true;
            } else if !state.selected {
                let anchor = state
                    .grace
                    .as_mut()
                    .expect("an unselected entry must retain a grace anchor");
                if anchor.deadline <= Instant::now() {
                    should_remove = true;
                } else if !anchor.cleanup_scheduled {
                    anchor.cleanup_scheduled = true;
                    grace_cleanup = Some((anchor.generation, anchor.deadline));
                }
            }
            drop(state);
            if should_remove {
                removed_entry = entries.remove(&key);
            }
        }
        if let Some(removed_entry) = removed_entry {
            removed_entry.shutdown();
        } else if let Some((generation, deadline)) = grace_cleanup {
            self.spawn_grace_cleanup(entry, generation, deadline);
        }
    }

    async fn reserve_browser(
        self: &Arc<Self>,
        entry: &Arc<CompanionBridgeEntry>,
        document_identity: CompanionDocumentIdentity,
        results: mpsc::Sender<ReliableBrowserNotification>,
        result_slots: Arc<Semaphore>,
    ) -> Option<BrowserReservation> {
        let entries = self.entries.lock().await;
        if !entries
            .values()
            .any(|candidate| Arc::ptr_eq(candidate, entry))
        {
            return None;
        }
        let mut state = entry.state.write().unwrap_or_else(|lock| lock.into_inner());
        if state.bundle.session_id != document_identity.session_id
            || state.bundle.revision != document_identity.revision
        {
            return Some(BrowserReservation::Stale);
        }
        if state.browser_connections.len() >= MAX_BROWSER_CONNECTIONS {
            return None;
        }
        let connection_id = entry.next_browser_id.fetch_add(1, Ordering::AcqRel);
        state.browser_connections.insert(
            connection_id,
            BrowserConnection {
                document_identity,
                results,
                result_slots,
            },
        );
        Some(BrowserReservation::Current(connection_id))
    }

    async fn release_browser(
        self: &Arc<Self>,
        entry: &Arc<CompanionBridgeEntry>,
        connection_id: u64,
    ) {
        {
            let mut state = entry.state.write().unwrap_or_else(|lock| lock.into_inner());
            state.browser_connections.remove(&connection_id);
            state
                .pending_events
                .retain(|_, pending| pending.connection_id != connection_id);
        }
        self.reconcile_entry(entry).await;
    }

    fn spawn_grace_cleanup(
        self: &Arc<Self>,
        entry: &Arc<CompanionBridgeEntry>,
        generation: u64,
        deadline: Instant,
    ) {
        let weak_manager = Arc::downgrade(self);
        let weak_entry = Arc::downgrade(entry);
        #[cfg(test)]
        let cleanup_barriers = self
            .cleanup_barriers
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            #[cfg(test)]
            if let Some((reached, release)) = cleanup_barriers {
                reached.wait().await;
                release.wait().await;
            }
            let (Some(manager), Some(entry)) = (weak_manager.upgrade(), weak_entry.upgrade())
            else {
                return;
            };
            let removed = {
                let mut entries = manager.entries.lock().await;
                let Some(key) = entries.iter().find_map(|(key, candidate)| {
                    Arc::ptr_eq(candidate, &entry).then(|| key.clone())
                }) else {
                    return;
                };
                let mut state = entry.state.write().unwrap_or_else(|lock| lock.into_inner());
                let matching_anchor = state.grace.as_ref().is_some_and(|anchor| {
                    anchor.generation == generation && anchor.deadline == deadline
                });
                let removable =
                    matching_anchor && !state.selected && state.browser_connections.is_empty();
                if matching_anchor && !removable {
                    if let Some(anchor) = state.grace.as_mut() {
                        anchor.cleanup_scheduled = false;
                    }
                }
                drop(state);
                removable.then(|| entries.remove(&key)).flatten()
            };
            if let Some(removed) = removed {
                removed.shutdown();
            }
        });
    }

    #[cfg(test)]
    async fn contains(&self, bridge_id: &str) -> bool {
        self.entry_by_id(bridge_id).await.is_some()
    }
}

impl Drop for CompanionBridgeManager {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut entries) = self.entries.try_lock() {
            for entry in entries.drain().map(|(_, entry)| entry) {
                entry.shutdown();
            }
        }
    }
}

impl CompanionBridgeEntry {
    fn ensure_owner(&self, window_label: &str, generation: &str) -> Result<(), String> {
        if self.owner_window_label == window_label && self.owner_lease_generation == generation {
            Ok(())
        } else {
            Err("visual companion bridge lease is not current".into())
        }
    }

    fn current_bundle(&self) -> Arc<StoredBundle> {
        self.state
            .read()
            .unwrap_or_else(|lock| lock.into_inner())
            .bundle
            .clone()
    }

    fn issue_handle(&self) -> Result<CompanionBridgeHandle, String> {
        let capability = {
            let mut pending = self
                .capability
                .lock()
                .unwrap_or_else(|lock| lock.into_inner());
            match pending.as_ref() {
                Some(capability) => capability.clone(),
                None => {
                    let capability = random_hex_128()?;
                    *pending = Some(capability.clone());
                    capability
                }
            }
        };
        Ok(CompanionBridgeHandle {
            bridge_id: self.bridge_id.clone(),
            base_url: self.base_url.clone(),
            entry_url: format!("{}/?cap={capability}", self.base_url),
        })
    }

    fn exchange_capability(&self, presented: &str) -> bool {
        let mut capability = self
            .capability
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        if capability.as_deref() != Some(presented) {
            return false;
        }
        *capability = None;
        true
    }

    fn is_authorized(&self, headers: &HeaderMap) -> bool {
        let expected = self.cookie_value.as_str();
        let mut matches = 0_u8;
        for header_value in headers.get_all(header::COOKIE) {
            let Ok(value) = header_value.to_str() else {
                return false;
            };
            for cookie in value.split(';') {
                let Some((name, value)) = cookie.trim().split_once('=') else {
                    continue;
                };
                if name == COOKIE_NAME {
                    matches = matches.saturating_add(1);
                    if value != expected {
                        return false;
                    }
                }
            }
        }
        matches == 1
    }

    fn notification_for_browser(&self, connection_id: u64) -> BrowserNotification {
        let state = self.state.read().unwrap_or_else(|lock| lock.into_inner());
        let current = state
            .browser_connections
            .get(&connection_id)
            .is_some_and(|connection| {
                connection.document_identity.session_id == state.bundle.session_id
                    && connection.document_identity.revision == state.bundle.revision
            });
        if current {
            BrowserNotification::Status {
                status: state.lifecycle,
            }
        } else {
            BrowserNotification::Reload
        }
    }

    fn browser_matches_current(&self, connection_id: u64) -> bool {
        let state = self.state.read().unwrap_or_else(|lock| lock.into_inner());
        state
            .browser_connections
            .get(&connection_id)
            .is_some_and(|connection| {
                connection.document_identity.session_id == state.bundle.session_id
                    && connection.document_identity.revision == state.bundle.revision
            })
    }

    fn shutdown(&self) {
        let _ = self.shutdown.send(true);
    }
}

impl StoredBundle {
    fn document_identity(&self) -> CompanionDocumentIdentity {
        CompanionDocumentIdentity {
            session_id: self.session_id.clone(),
            revision: self.revision.clone(),
        }
    }

    fn try_from_bundle(
        key: &CompanionBridgeKey,
        bundle: CompanionBridgeBundle,
    ) -> Result<Self, String> {
        if bundle.session_id != key.session_id
            || !valid_identifier(&bundle.session_id)
            || !valid_identifier(&bundle.revision)
        {
            return Err("visual companion bundle identity is invalid".into());
        }
        if bundle.document_html.len() > MAX_RENDERED_DOCUMENT_BYTES {
            return Err("visual companion document exceeds its resource limit".into());
        }
        if [
            &bundle.lifecycle_page_strings.unavailable_title,
            &bundle.lifecycle_page_strings.unavailable_detail,
            &bundle.lifecycle_page_strings.error_title,
            &bundle.lifecycle_page_strings.error_detail,
        ]
        .into_iter()
        .any(|value| {
            value.is_empty()
                || value.len() > MAX_LIFECYCLE_STRING_BYTES
                || value.bytes().any(|byte| byte == 0)
        }) {
            return Err("visual companion lifecycle strings are invalid".into());
        }
        if bundle.assets.len() > MAX_ASSET_COUNT {
            return Err("visual companion assets exceed their resource limit".into());
        }
        let mut assets = HashMap::with_capacity(bundle.assets.len());
        let mut total_asset_bytes = 0_usize;
        for asset in bundle.assets {
            if !valid_basename(&asset.name)
                || !valid_content_type(&asset.content_type)
                || assets.contains_key(&asset.name)
            {
                return Err("visual companion asset is invalid".into());
            }
            if asset.data_b64.len() > MAX_ASSET_BYTES.saturating_mul(2) {
                return Err("visual companion asset exceeds its resource limit".into());
            }
            let data = base64::engine::general_purpose::STANDARD
                .decode(asset.data_b64)
                .map_err(|_| "visual companion asset is invalid".to_string())?;
            if data.len() > MAX_ASSET_BYTES {
                return Err("visual companion asset exceeds its resource limit".into());
            }
            total_asset_bytes = total_asset_bytes.saturating_add(data.len());
            if total_asset_bytes > MAX_ASSET_TOTAL_BYTES {
                return Err("visual companion assets exceed their resource limit".into());
            }
            let passive_content_type = passive_asset_content_type(&asset.name, &asset.content_type);
            let (content_type, attachment) = match passive_content_type {
                Some(content_type) => (HeaderValue::from_static(content_type), false),
                None => (HeaderValue::from_static("application/octet-stream"), true),
            };
            assets.insert(
                asset.name,
                StoredAsset {
                    content_type,
                    attachment,
                    data: Bytes::from(data),
                },
            );
        }
        let document = Bytes::from(bundle.document_html);
        Ok(Self {
            session_id: bundle.session_id,
            revision: bundle.revision,
            byte_len: document.len().saturating_add(total_asset_bytes),
            document,
            lifecycle_page_strings: bundle.lifecycle_page_strings,
            assets,
        })
    }
}

async fn serve_entry_http(
    listener: TcpListener,
    router: Router,
    mut shutdown: watch::Receiver<bool>,
    header_timeout: Duration,
) {
    use hyper_util::rt::{TokioIo, TokioTimer};
    use hyper_util::service::TowerToHyperService;

    let permits = Arc::new(Semaphore::new(MAX_HTTP_CONNECTIONS));
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            completed = connections.join_next(), if !connections.is_empty() => {
                let _ = completed;
            }
            permit = permits.clone().acquire_owned() => {
                let Ok(permit) = permit else {
                    break;
                };
                let accepted = tokio::select! {
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() {
                            None
                        } else {
                            continue;
                        }
                    }
                    accepted = listener.accept() => Some(accepted),
                };
                let Some(accepted) = accepted else {
                    break;
                };
                let Ok((stream, _address)) = accepted else {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                };
                let service = TowerToHyperService::new(router.clone());
                connections.spawn(async move {
                    let _permit = permit;
                    let mut builder = hyper::server::conn::http1::Builder::new();
                    builder
                        .timer(TokioTimer::new())
                        .header_read_timeout(header_timeout)
                        .max_headers(64)
                        .max_buf_size(MAX_HTTP_HEADER_BYTES);
                    let connection = builder
                        .serve_connection(
                            TokioIo::new(BoundedHeaderIo::new(stream)),
                            service,
                        )
                        .with_upgrades();
                    let _ = connection.await;
                });
            }
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

async fn enforce_narrow_request(request: Request<Body>, next: Next) -> Response {
    if request.method() != http::Method::GET {
        let mut response = secure_empty(StatusCode::METHOD_NOT_ALLOWED);
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET"));
        response
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
        return response;
    }
    let carries_body = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value != "0")
        || request.headers().contains_key(header::TRANSFER_ENCODING);
    if carries_body {
        let mut response = secure_empty(StatusCode::BAD_REQUEST);
        response
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
        return response;
    }
    let mut response = next.run(request).await;
    apply_security_headers(response.headers_mut());
    response
}

async fn validate_exact_host(
    State(state): State<Arc<BridgeRouteState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let exact = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == state.entry.advertised_host_port);
    if !exact {
        return secure_empty(StatusCode::MISDIRECTED_REQUEST);
    }
    next.run(request).await
}

async fn root(
    State(state): State<Arc<BridgeRouteState>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    if let Some(query) = query {
        let Some(capability) = query.strip_prefix("cap=") else {
            return secure_empty(StatusCode::UNAUTHORIZED);
        };
        if capability.is_empty()
            || capability.contains('&')
            || !state.entry.exchange_capability(capability)
        {
            return secure_empty(StatusCode::UNAUTHORIZED);
        }
        let mut response = secure_empty(StatusCode::SEE_OTHER);
        response
            .headers_mut()
            .insert(header::LOCATION, HeaderValue::from_static("/"));
        let cookie = format!(
            "{COOKIE_NAME}={}; HttpOnly; SameSite=Strict; Path=/",
            state.entry.cookie_value
        );
        if let Ok(cookie) = HeaderValue::from_str(&cookie) {
            response.headers_mut().insert(header::SET_COOKIE, cookie);
        }
        return response;
    }
    if !state.entry.is_authorized(&headers) {
        return secure_empty(StatusCode::UNAUTHORIZED);
    }
    let state_guard = state
        .entry
        .state
        .read()
        .unwrap_or_else(|lock| lock.into_inner());
    let body = match state_guard.lifecycle {
        CompanionBridgeLifecycle::Available | CompanionBridgeLifecycle::Reconnecting => {
            state_guard.bundle.document.clone()
        }
        CompanionBridgeLifecycle::Unavailable => lifecycle_page(
            &state_guard.bundle.lifecycle_page_strings.unavailable_title,
            &state_guard.bundle.lifecycle_page_strings.unavailable_detail,
        ),
        CompanionBridgeLifecycle::Error => lifecycle_page(
            &state_guard.bundle.lifecycle_page_strings.error_title,
            &state_guard.bundle.lifecycle_page_strings.error_detail,
        ),
    };
    drop(state_guard);
    secure_response(StatusCode::OK, "text/html; charset=utf-8", body)
}

async fn asset(
    State(state): State<Arc<BridgeRouteState>>,
    Path(name): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    if query.is_some() {
        return secure_empty(StatusCode::NOT_FOUND);
    }
    if !state.entry.is_authorized(&headers) || !valid_basename(&name) {
        return secure_empty(if state.entry.is_authorized(&headers) {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::UNAUTHORIZED
        });
    }
    let state_guard = state
        .entry
        .state
        .read()
        .unwrap_or_else(|lock| lock.into_inner());
    if !matches!(
        state_guard.lifecycle,
        CompanionBridgeLifecycle::Available | CompanionBridgeLifecycle::Reconnecting
    ) {
        return secure_empty(StatusCode::NOT_FOUND);
    }
    let Some(asset) = state_guard.bundle.assets.get(&name) else {
        return secure_empty(StatusCode::NOT_FOUND);
    };
    let content_type = asset.content_type.clone();
    let attachment = asset.attachment;
    let data = asset.data.clone();
    drop(state_guard);
    let mut response = secure_response(StatusCode::OK, "application/octet-stream", data);
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(ASSET_CONTENT_SECURITY_POLICY),
    );
    if attachment {
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment"),
        );
    }
    response
}

async fn websocket(
    State(state): State<Arc<BridgeRouteState>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !state.entry.is_authorized(&headers) {
        return secure_close(StatusCode::UNAUTHORIZED);
    }
    let origin_matches = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| origin == state.entry.base_url);
    if !origin_matches {
        return secure_close(StatusCode::FORBIDDEN);
    }
    let Some(document_identity) = query
        .as_deref()
        .and_then(|query| serde_urlencoded::from_str::<CompanionDocumentIdentity>(query).ok())
        .filter(|identity| {
            valid_identifier(&identity.session_id) && valid_identifier(&identity.revision)
        })
    else {
        return secure_close(StatusCode::BAD_REQUEST);
    };
    let Some(manager) = state.manager.upgrade() else {
        return secure_close(StatusCode::SERVICE_UNAVAILABLE);
    };
    #[cfg(test)]
    manager
        .wait_handshake_phase(HandshakePhase::BeforeReservation)
        .await;
    let (result_sender, result_receiver) = mpsc::channel(MAX_PENDING_EVENTS);
    let result_slots = Arc::new(Semaphore::new(MAX_PENDING_EVENTS));
    let Some(reservation) = manager
        .reserve_browser(&state.entry, document_identity, result_sender, result_slots)
        .await
    else {
        return secure_close(StatusCode::SERVICE_UNAVAILABLE);
    };
    let BrowserReservation::Current(connection_id) = reservation else {
        return upgrade
            .max_message_size(MAX_BROWSER_EVENT_BYTES)
            .max_frame_size(MAX_BROWSER_EVENT_BYTES)
            .on_upgrade(|mut socket| async move {
                let _ = send_notification(&mut socket, BrowserNotification::Reload).await;
                let _ = socket.close().await;
            })
            .into_response();
    };
    #[cfg(test)]
    manager
        .wait_handshake_phase(HandshakePhase::AfterReservation)
        .await;
    upgrade
        .max_message_size(MAX_BROWSER_EVENT_BYTES)
        .max_frame_size(MAX_BROWSER_EVENT_BYTES)
        .on_failed_upgrade({
            let manager = manager.clone();
            let entry = state.entry.clone();
            move |_| {
                tauri::async_runtime::spawn(async move {
                    manager.release_browser(&entry, connection_id).await;
                });
            }
        })
        .on_upgrade(move |socket| {
            let guard = ActiveBrowserGuard {
                manager,
                entry: state.entry.clone(),
                connection_id,
                released: false,
            };
            serve_websocket(socket, state, guard, result_receiver)
        })
        .into_response()
}

async fn serve_websocket(
    mut socket: WebSocket,
    route: Arc<BridgeRouteState>,
    guard: ActiveBrowserGuard,
    mut event_results: mpsc::Receiver<ReliableBrowserNotification>,
) {
    let connection_id = guard.connection_id;
    let mut state_changed = route.entry.state_changed.subscribe();
    let mut bundle_identity = route.entry.bundle_identity.subscribe();
    let mut shutdown = route.entry.shutdown.subscribe();
    #[cfg(test)]
    guard
        .manager
        .wait_handshake_phase(HandshakePhase::BeforeInitialStatus)
        .await;
    let initial = route.entry.notification_for_browser(connection_id);
    let initial_is_current = if initial == BrowserNotification::Reload {
        let _ = send_notification(&mut socket, BrowserNotification::Reload).await;
        false
    } else {
        tokio::select! {
            biased;
            changed = bundle_identity.changed() => {
                if changed.is_ok() {
                    let _ = send_notification(&mut socket, BrowserNotification::Reload).await;
                }
                false
            }
            sent = send_notification(&mut socket, initial) => {
                sent.is_ok() && route.entry.browser_matches_current(connection_id)
            },
        }
    };
    if !*shutdown.borrow() && initial_is_current {
        loop {
            tokio::select! {
                biased;
                changed = bundle_identity.changed() => {
                    if changed.is_ok() {
                        let _ = send_notification(&mut socket, BrowserNotification::Reload).await;
                    }
                    break;
                }
                changed = state_changed.recv() => {
                    match changed {
                        Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) => {
                            let current = route.entry.notification_for_browser(connection_id);
                            let reload = current == BrowserNotification::Reload;
                            if send_notification(&mut socket, current).await.is_err() || reload {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                result = event_results.recv() => {
                    match result {
                        Some(result) => {
                            if send_notification(&mut socket, result.notification).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                incoming = socket.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            if let Some(notification) = accept_browser_message(
                                &route.entry,
                                &route.browser_events,
                                connection_id,
                                text.as_str(),
                            ) {
                                if send_notification(&mut socket, notification).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        Some(Ok(_)) => {}
                    }
                }
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
            }
        }
    }
    let _ = socket.close().await;
    guard.release().await;
}

fn accept_browser_message(
    entry: &CompanionBridgeEntry,
    browser_events: &mpsc::Sender<CompanionBrowserEvent>,
    connection_id: u64,
    text: &str,
) -> Option<BrowserNotification> {
    if text.len() > MAX_BROWSER_EVENT_BYTES {
        return None;
    }
    let Ok(message) = serde_json::from_str::<BrowserMessage>(text) else {
        return None;
    };
    if message.message_type != "companion-event" {
        return None;
    }
    let mut event = CompanionEvent::from(message.event);
    if !valid_event(&event) {
        return None;
    }
    let event_id = event.event_id.clone();
    let (session_id, revision) = {
        let mut state = entry.state.write().unwrap_or_else(|lock| lock.into_inner());
        if state.lifecycle != CompanionBridgeLifecycle::Available
            || state.pending_events.len() >= MAX_PENDING_EVENTS
            || state.pending_events.contains_key(&event.event_id)
        {
            return Some(local_event_failure(event.event_id));
        }
        let Some(connection) = state.browser_connections.get(&connection_id) else {
            return Some(local_event_failure(event.event_id));
        };
        if connection.document_identity.session_id != state.bundle.session_id
            || connection.document_identity.revision != state.bundle.revision
        {
            return Some(BrowserNotification::Reload);
        }
        let document_identity = connection.document_identity.clone();
        let result_permit = connection.result_slots.clone().try_acquire_owned().ok();
        let Some(result_permit) = result_permit else {
            return Some(local_event_failure(event.event_id));
        };
        let identity = PendingEventIdentity {
            session_id: document_identity.session_id,
            revision: document_identity.revision,
            connection_id,
            result_permit,
        };
        let session_id = identity.session_id.clone();
        let revision = identity.revision.clone();
        state
            .pending_events
            .insert(event.event_id.clone(), identity);
        (session_id, revision)
    };
    event.session_id = session_id.clone();
    event.revision = revision.clone();
    let forwarded = CompanionBrowserEvent {
        owner_window_label: entry.owner_window_label.clone(),
        bridge_id: entry.bridge_id.clone(),
        session_id,
        revision,
        event,
    };
    if browser_events.try_send(forwarded).is_err() {
        let mut state = entry.state.write().unwrap_or_else(|lock| lock.into_inner());
        state.pending_events.remove(&event_id);
        return Some(local_event_failure(event_id));
    }
    None
}

fn local_event_failure(event_id: String) -> BrowserNotification {
    BrowserNotification::EventResult {
        event_id,
        accepted: false,
        code: Some("bridge_busy".into()),
        message: Some("Selection failed. Try again.".into()),
    }
}

async fn send_notification(
    socket: &mut WebSocket,
    notification: BrowserNotification,
) -> Result<(), ()> {
    let serialized = serde_json::to_string(&notification).map_err(|_| ())?;
    socket
        .send(Message::Text(serialized.into()))
        .await
        .map_err(|_| ())
}

async fn not_found() -> Response {
    secure_empty(StatusCode::NOT_FOUND)
}

fn secure_response(status: StatusCode, content_type: &'static str, body: Bytes) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    apply_security_headers(headers);
    response
}

fn secure_empty(status: StatusCode) -> Response {
    secure_response(status, "text/plain; charset=utf-8", Bytes::new())
}

fn secure_close(status: StatusCode) -> Response {
    let mut response = secure_empty(status);
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

fn apply_security_headers(headers: &mut HeaderMap) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CONTENT_SECURITY_POLICY),
        );
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        header::HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
    );
}

fn lifecycle_page(title: &str, detail: &str) -> Bytes {
    let title = escape_html_text(title);
    let detail = escape_html_text(detail);
    Bytes::from(format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head><body><main><h1>{title}</h1><p>{detail}</p></main></body></html>"
    ))
}

fn escape_html_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn validate_key(key: &CompanionBridgeKey) -> Result<(), String> {
    if !valid_identifier(&key.owner_window_label)
        || !valid_identifier(&key.owner_lease_generation)
        || !valid_identifier(&key.owner_desktop_id)
        || !valid_identifier(&key.owner_task_id)
        || !valid_identifier(&key.session_id)
    {
        return Err("visual companion bridge identity is invalid".into());
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.bytes().any(|byte| byte.is_ascii_control())
}

fn valid_basename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.contains(['/', '\\', '\0'])
        && FsPath::new(value).components().count() == 1
        && matches!(
            FsPath::new(value).components().next(),
            Some(Component::Normal(_))
        )
}

fn valid_content_type(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/+.-".contains(&byte))
}

fn passive_asset_content_type(name: &str, content_type: &str) -> Option<&'static str> {
    let extension = FsPath::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    let expected = if extension.eq_ignore_ascii_case("css") {
        "text/css"
    } else if extension.eq_ignore_ascii_case("txt") {
        "text/plain"
    } else if extension.eq_ignore_ascii_case("png") {
        "image/png"
    } else if extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg") {
        "image/jpeg"
    } else if extension.eq_ignore_ascii_case("gif") {
        "image/gif"
    } else if extension.eq_ignore_ascii_case("webp") {
        "image/webp"
    } else if extension.eq_ignore_ascii_case("avif") {
        "image/avif"
    } else if extension.eq_ignore_ascii_case("ico") {
        "image/x-icon"
    } else if extension.eq_ignore_ascii_case("woff") {
        "font/woff"
    } else if extension.eq_ignore_ascii_case("woff2") {
        "font/woff2"
    } else if extension.eq_ignore_ascii_case("ttf") {
        "font/ttf"
    } else if extension.eq_ignore_ascii_case("otf") {
        "font/otf"
    } else {
        return None;
    };
    (content_type == expected).then_some(expected)
}

fn valid_event(event: &CompanionEvent) -> bool {
    event.event_type == "click"
        && !event.event_id.is_empty()
        && event.event_id.len() <= MAX_EVENT_ID_BYTES
        && !event.choice.is_empty()
        && event.choice.len() <= MAX_CHOICE_BYTES
        && event.text.len() <= MAX_TEXT_BYTES
        && event
            .element_id
            .as_ref()
            .is_none_or(|element_id| element_id.len() <= MAX_ELEMENT_ID_BYTES)
        && event.timestamp <= MAX_SAFE_JSON_INTEGER
        && serde_json::to_vec(event)
            .is_ok_and(|serialized| serialized.len() <= MAX_BROWSER_EVENT_BYTES)
}

fn sanitize_code(code: Option<&str>) -> Option<String> {
    code.filter(|code| {
        !code.is_empty()
            && code.len() <= 128
            && code
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    })
    .map(ToOwned::to_owned)
}

fn random_hex_128() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| "failed to initialize visual companion bridge".to_string())?;
    let mut encoded = String::with_capacity(32);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}")
            .map_err(|_| "failed to initialize visual companion bridge".to_string())?;
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::{
        BoundedHeaderIo, CompanionBridgeBundle, CompanionBridgeEventResult, CompanionBridgeKey,
        CompanionBridgeLifecycle, CompanionBridgeManager, CompanionBridgeStateUpdate,
        CompanionLifecyclePageStrings, HandshakePhase, PublicationPhase, COOKIE_NAME,
        MAX_ASSET_BYTES, MAX_ASSET_COUNT, MAX_BRIDGE_ENTRIES, MAX_BROWSER_CONNECTIONS,
        MAX_BROWSER_EVENT_BYTES, MAX_HTTP_CONNECTIONS, MAX_HTTP_HEADER_BYTES, MAX_PENDING_EVENTS,
        MAX_RENDERED_DOCUMENT_BYTES,
    };
    use axum::body::Bytes;
    use base64::Engine as _;
    use futures_util::{SinkExt, StreamExt};
    use http::{header, Method, StatusCode};
    use kanna_agent_protocol::CompanionAsset;
    use reqwest::cookie::{CookieStore as _, Jar};
    use reqwest::{Client, Url};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;
    use tokio::time::timeout;
    use tokio_tungstenite::tungstenite::{
        client::IntoClientRequest,
        protocol::{
            frame::{
                coding::{Data, OpCode},
                Frame,
            },
            Message,
        },
    };

    fn key(task: &str, session: &str) -> CompanionBridgeKey {
        CompanionBridgeKey {
            owner_window_label: "main".into(),
            owner_lease_generation: "lease-1".into(),
            owner_desktop_id: "desktop-owner".into(),
            owner_task_id: task.into(),
            session_id: session.into(),
        }
    }

    fn bundle(session: &str, revision: &str, label: &str) -> CompanionBridgeBundle {
        CompanionBridgeBundle {
            session_id: session.into(),
            revision: revision.into(),
            document_html: format!(
                "<!doctype html><html><body><button data-choice=\"layout\">{label}</button></body></html>"
            ),
            lifecycle_page_strings: CompanionLifecyclePageStrings {
                unavailable_title: "This visual companion has ended.".into(),
                unavailable_detail: "The companion is no longer available.".into(),
                error_title: "Visual companion unavailable".into(),
                error_detail: "The companion could not be displayed.".into(),
            },
            assets: vec![CompanionAsset {
                name: "layout.png".into(),
                content_type: "image/png".into(),
                digest: format!("digest-{revision}"),
                data_b64: base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    label.as_bytes(),
                ),
            }],
        }
    }

    #[tokio::test]
    async fn window_lease_cannot_retire_another_windows_healthy_bridge() {
        let (events, _receiver) = mpsc::channel(8);
        let manager = Arc::new(CompanionBridgeManager::new(events));
        let first = manager
            .upsert(key("task-1", "session-1"), bundle("session-1", "r1", "one"))
            .await
            .unwrap();
        let mut second_key = key("task-1", "session-1");
        second_key.owner_window_label = "window-2".into();
        second_key.owner_lease_generation = "lease-2".into();
        let second = manager
            .upsert(second_key, bundle("session-1", "r1", "two"))
            .await
            .unwrap();

        assert_ne!(first.bridge_id, second.bridge_id);
        assert!(manager
            .ensure_lease(&second.bridge_id, "main", "lease-1")
            .await
            .is_err());
        manager.close(&first.bridge_id).await.unwrap();
        assert!(manager
            .ensure_lease(&second.bridge_id, "window-2", "lease-2")
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn window_destruction_atomically_reclaims_only_owned_bridges() {
        let (events, _receiver) = mpsc::channel(8);
        let manager = Arc::new(CompanionBridgeManager::new(events));
        let first = manager
            .upsert(key("task-1", "session-1"), bundle("session-1", "r1", "one"))
            .await
            .unwrap();
        let mut second_key = key("task-2", "session-2");
        second_key.owner_window_label = "window-2".into();
        let second = manager
            .upsert(second_key, bundle("session-2", "r1", "two"))
            .await
            .unwrap();

        assert_eq!(manager.close_owned_by_window("main").await, 1);
        assert!(manager
            .ensure_lease(&first.bridge_id, "main", "lease-1")
            .await
            .is_err());
        assert!(manager
            .ensure_lease(&second.bridge_id, "window-2", "lease-1")
            .await
            .is_ok());
        let stale = manager
            .upsert(
                key("task-3", "session-3"),
                bundle("session-3", "r1", "stale"),
            )
            .await
            .expect_err("a destroyed window must reject in-flight bridge creation");
        assert!(stale.contains("destroyed"));
    }

    #[tokio::test]
    async fn a_new_window_lease_reclaims_entries_from_the_replaced_lease() {
        let (events, _receiver) = mpsc::channel(8);
        let manager = Arc::new(CompanionBridgeManager::new(events));
        let first = manager
            .upsert(key("task-1", "session-1"), bundle("session-1", "r1", "one"))
            .await
            .unwrap();
        let mut replacement_key = key("task-2", "session-2");
        replacement_key.owner_lease_generation = "lease-2".into();
        let replacement = manager
            .upsert(replacement_key, bundle("session-2", "r1", "replacement"))
            .await
            .unwrap();

        assert!(manager
            .ensure_lease(&first.bridge_id, "main", "lease-1")
            .await
            .is_err());
        assert!(manager
            .ensure_lease(&replacement.bridge_id, "main", "lease-2")
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn a_retired_window_lease_cannot_reclaim_its_replacement() {
        let (events, _receiver) = mpsc::channel(8);
        let manager = Arc::new(CompanionBridgeManager::new(events));
        let first = manager
            .upsert(key("task-1", "session-1"), bundle("session-1", "r1", "one"))
            .await
            .unwrap();
        let mut replacement_key = key("task-2", "session-2");
        replacement_key.owner_lease_generation = "lease-2".into();
        let replacement = manager
            .upsert(replacement_key, bundle("session-2", "r1", "replacement"))
            .await
            .unwrap();
        let stale = manager
            .upsert(
                key("task-3", "session-3"),
                bundle("session-3", "r1", "stale"),
            )
            .await
            .expect_err("the retired lease must not become current again");

        assert!(stale.contains("retired"));
        assert!(manager
            .ensure_lease(&first.bridge_id, "main", "lease-1")
            .await
            .is_err());
        assert!(manager
            .ensure_lease(&replacement.bridge_id, "main", "lease-2")
            .await
            .is_ok());
        assert_eq!(manager.entries.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn concurrent_distinct_lease_upserts_leave_only_one_current_window_lease() {
        let (events, _receiver) = mpsc::channel(8);
        let manager = Arc::new(CompanionBridgeManager::new(events));
        let reached = Arc::new(tokio::sync::Barrier::new(3));
        let release = Arc::new(tokio::sync::Barrier::new(3));
        *manager
            .lease_claim_barriers
            .lock()
            .unwrap_or_else(|lock| lock.into_inner()) =
            Some((Arc::clone(&reached), Arc::clone(&release)));

        let first_manager = Arc::clone(&manager);
        let first = tokio::spawn(async move {
            first_manager
                .upsert(
                    key("task-1", "session-1"),
                    bundle("session-1", "r1", "first"),
                )
                .await
        });
        let second_manager = Arc::clone(&manager);
        let second = tokio::spawn(async move {
            let mut second_key = key("task-2", "session-2");
            second_key.owner_lease_generation = "lease-2".into();
            second_manager
                .upsert(second_key, bundle("session-2", "r1", "second"))
                .await
        });
        reached.wait().await;
        release.wait().await;
        let first = first.await.unwrap();
        let second = second.await.unwrap();

        assert_eq!(
            usize::from(first.is_ok()) + usize::from(second.is_ok()),
            1,
            "exactly one concurrently claimed lease must remain current"
        );
        assert_eq!(manager.entries.lock().await.len(), 1);
    }

    fn manager(
        grace: Duration,
    ) -> (
        Arc<CompanionBridgeManager>,
        mpsc::Receiver<super::CompanionBrowserEvent>,
    ) {
        let (events, receiver) = mpsc::channel(8);
        (
            Arc::new(CompanionBridgeManager::with_grace_period(events, grace)),
            receiver,
        )
    }

    async fn reserve_current_browser(
        manager: &Arc<CompanionBridgeManager>,
        entry: &Arc<super::CompanionBridgeEntry>,
        session_id: &str,
        revision: &str,
        sender: mpsc::Sender<super::ReliableBrowserNotification>,
        slots: Arc<tokio::sync::Semaphore>,
    ) -> u64 {
        let reservation = manager
            .reserve_browser(
                entry,
                super::CompanionDocumentIdentity {
                    session_id: session_id.into(),
                    revision: revision.into(),
                },
                sender,
                slots,
            )
            .await
            .unwrap();
        let super::BrowserReservation::Current(connection_id) = reservation else {
            panic!("expected the current document to reserve a browser");
        };
        connection_id
    }

    async fn authorize(client: &Client, entry_url: &str) -> String {
        let response = client.get(entry_url).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers()[header::LOCATION], "/");
        let set_cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Strict"));
        assert!(set_cookie.contains("Path=/"));
        assert!(!set_cookie.contains("Domain="));
        set_cookie.split(';').next().unwrap().to_owned()
    }

    async fn connect_ws(
        base_url: &str,
        cookie: &str,
        origin: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        connect_ws_for_document(base_url, cookie, origin, "session-1", "revision-1").await
    }

    async fn connect_ws_for_document(
        base_url: &str,
        cookie: &str,
        origin: &str,
        session_id: &str,
        revision: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let url = format!(
            "{}/ws?sessionId={session_id}&revision={revision}",
            base_url.replacen("http://", "ws://", 1)
        );
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert(header::COOKIE, cookie.parse().unwrap());
        request
            .headers_mut()
            .insert(header::ORIGIN, origin.parse().unwrap());
        tokio_tungstenite::connect_async(request).await.unwrap().0
    }

    #[tokio::test]
    async fn capability_exchange_serves_only_the_bounded_http_contract() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let (manager, _events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "PNG"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();

        let unauthorized = client
            .get(format!("{}/", entry.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let cookie = authorize(&client, &entry.entry_url).await;
        let capability = entry.entry_url.split_once("?cap=").unwrap().1;
        assert!(!cookie.contains(capability));
        let replay = client.get(&entry.entry_url).send().await.unwrap();
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

        let document = client
            .get(format!("{}/", entry.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(document.status(), StatusCode::OK);
        assert_eq!(
            document.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(document.headers()[header::CACHE_CONTROL], "no-store");
        let content_security_policy = document
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(content_security_policy.contains("connect-src 'self'"));
        assert!(!content_security_policy.contains(" ws:"));
        let document = document.text().await.unwrap();
        assert!(document.contains("PNG"));
        assert!(!document.contains(capability));

        let asset = client
            .get(format!("{}/files/layout.png", entry.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(asset.status(), StatusCode::OK);
        assert_eq!(asset.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(asset.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(asset.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert!(asset.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("script-src 'none'"));
        assert_eq!(asset.bytes().await.unwrap().as_ref(), b"PNG");

        for path in ["/missing", "/files/missing.png", "/files/../layout.png"] {
            let response = client
                .get(format!("{}{}", entry.base_url, path))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
        let denied = client
            .request(Method::POST, format!("{}/", entry.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert!(denied
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY));
        assert_eq!(denied.headers()["x-frame-options"], "DENY");
        assert_eq!(denied.headers()[header::CONNECTION], "close");

        let host = entry.base_url.strip_prefix("http://").unwrap();
        let port = host.rsplit_once(':').unwrap().1.parse::<u16>().unwrap();
        let mut raw = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        raw.write_all(
            format!("POST / HTTP/1.1\r\nHost: {host}\r\nContent-Length: 999999999\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
        let mut response = [0_u8; 1024];
        let read = timeout(Duration::from_secs(1), raw.read(&mut response))
            .await
            .expect("method rejection must not wait for the declared request body")
            .unwrap();
        let response = String::from_utf8_lossy(&response[..read]).to_ascii_lowercase();
        assert!(response.starts_with("http/1.1 405"));
        assert!(response.contains("connection: close"));
    }

    #[tokio::test]
    async fn websocket_requires_the_entry_cookie_and_exact_loopback_origin() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let ws_url = format!("{}/ws", entry.base_url.replacen("http://", "ws://", 1));

        let missing_cookie = tokio_tungstenite::connect_async(&ws_url).await.unwrap_err();
        assert!(missing_cookie.to_string().contains("401"));

        let mut wrong_origin = ws_url.clone().into_client_request().unwrap();
        wrong_origin
            .headers_mut()
            .insert(header::COOKIE, cookie.parse().unwrap());
        wrong_origin
            .headers_mut()
            .insert(header::ORIGIN, "http://127.0.0.1:1".parse().unwrap());
        let wrong_origin = tokio_tungstenite::connect_async(wrong_origin)
            .await
            .unwrap_err();
        assert!(wrong_origin.to_string().contains("403"));

        let mut socket = connect_ws(&entry.base_url, &cookie, &entry.base_url).await;
        let initial = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(initial.to_text().unwrap()).unwrap(),
            serde_json::json!({"type":"status","status":"available"})
        );
        socket
            .send(Message::Ping(Bytes::from_static(b"health")))
            .await
            .unwrap();
        let pong = timeout(Duration::from_secs(1), socket.next())
            .await
            .expect("bridge should answer WebSocket ping")
            .unwrap()
            .unwrap();
        assert_eq!(pong, Message::Pong(Bytes::from_static(b"health")));
        socket.close(None).await.unwrap();
    }

    #[tokio::test]
    async fn websocket_reloads_a_document_that_was_replaced_after_get_and_rejects_its_click() {
        let (manager, mut events) = manager(Duration::from_secs(30));
        let bridge_key = key("task-race", "session-race");
        let entry = manager
            .upsert(
                bridge_key.clone(),
                bundle("session-race", "revision-1", "old"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;

        let rendered_r1 = client
            .get(format!("{}/", entry.base_url))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(rendered_r1.contains("old"));

        manager
            .upsert(bridge_key, bundle("session-race", "revision-2", "new"))
            .await
            .unwrap();

        let mut socket = connect_ws_for_document(
            &entry.base_url,
            &cookie,
            &entry.base_url,
            "session-race",
            "revision-1",
        )
        .await;
        let notification = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(notification.to_text().unwrap()).unwrap(),
            serde_json::json!({"type":"reload"})
        );
        let _ = socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "companion-event",
                    "event": {
                        "event_id": "stale-click",
                        "type": "click",
                        "choice": "old",
                        "text": "Old",
                        "id": "old",
                        "timestamp": 1
                    }
                })
                .to_string()
                .into(),
            ))
            .await;
        tokio::task::yield_now().await;
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn websocket_handshake_observes_bundle_swaps_at_every_admission_phase() {
        for phase in [
            HandshakePhase::BeforeReservation,
            HandshakePhase::AfterReservation,
            HandshakePhase::BeforeInitialStatus,
        ] {
            let (manager, _events) = manager(Duration::from_secs(30));
            let bridge_key = key("task-handshake", "session-handshake");
            let entry = manager
                .upsert(
                    bridge_key.clone(),
                    bundle("session-handshake", "revision-1", "old"),
                )
                .await
                .unwrap();
            let client = Client::builder()
                .cookie_store(true)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();
            let cookie = authorize(&client, &entry.entry_url).await;
            let reached = Arc::new(tokio::sync::Barrier::new(2));
            let release = Arc::new(tokio::sync::Barrier::new(2));
            *manager.handshake_barriers.lock().unwrap() =
                Some((phase, reached.clone(), release.clone()));

            let base_url = entry.base_url.clone();
            let origin = entry.base_url.clone();
            let connection = tokio::spawn(async move {
                connect_ws_for_document(
                    &base_url,
                    &cookie,
                    &origin,
                    "session-handshake",
                    "revision-1",
                )
                .await
            });
            reached.wait().await;
            manager
                .upsert(bridge_key, bundle("session-handshake", "revision-2", "new"))
                .await
                .unwrap();
            *manager.handshake_barriers.lock().unwrap() = None;
            release.wait().await;

            let mut socket = connection.await.unwrap();
            let notification = timeout(Duration::from_secs(1), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(notification.to_text().unwrap()).unwrap(),
                serde_json::json!({"type":"reload"}),
                "bundle swap at {phase:?} must win over the initial available status"
            );
        }
    }

    #[tokio::test]
    async fn websocket_document_identity_accepts_current_events_and_rejects_invalid_queries() {
        let (manager, mut events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-current", "session-current"),
                bundle("session-current", "revision-current", "current"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut socket = connect_ws_for_document(
            &entry.base_url,
            &cookie,
            &entry.base_url,
            "session-current",
            "revision-current",
        )
        .await;
        let initial = socket.next().await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(initial.to_text().unwrap()).unwrap(),
            serde_json::json!({"type":"status","status":"available"})
        );
        socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "companion-event",
                    "event": {
                        "event_id": "current-click",
                        "type": "click",
                        "choice": "current",
                        "text": "Current",
                        "id": "current",
                        "timestamp": 1
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let forwarded = timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(forwarded.session_id, "session-current");
        assert_eq!(forwarded.revision, "revision-current");
        assert_eq!(forwarded.event.event_id, "current-click");
        socket.close(None).await.unwrap();

        for query in [
            "sessionId=session-current".to_string(),
            "sessionId=session-current&revision=revision-current&extra=nope".to_string(),
            "sessionId=session-current&sessionId=duplicate&revision=revision-current".to_string(),
            "sessionId=session-current&revision=".to_string(),
            "sessionId=session-current&revision=bad%00revision".to_string(),
            format!("sessionId=session-current&revision={}", "x".repeat(257)),
        ] {
            let url = format!(
                "{}/ws?{query}",
                entry.base_url.replacen("http://", "ws://", 1)
            );
            let mut request = url.into_client_request().unwrap();
            request
                .headers_mut()
                .insert(header::COOKIE, cookie.parse().unwrap());
            request
                .headers_mut()
                .insert(header::ORIGIN, entry.base_url.parse().unwrap());
            assert!(tokio_tungstenite::connect_async(request).await.is_err());
        }
    }

    #[tokio::test]
    async fn replacement_swaps_document_and_assets_before_one_reload() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let bridge_key = key("task-1", "session-1");
        let first = manager
            .upsert(bridge_key.clone(), bundle("session-1", "revision-1", "old"))
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &first.entry_url).await;
        let mut socket = connect_ws(&first.base_url, &cookie, &first.base_url).await;
        let _ = socket.next().await;

        let replacement = CompanionBridgeBundle {
            assets: vec![CompanionAsset {
                name: "new.png".into(),
                content_type: "image/png".into(),
                digest: "replacement".into(),
                data_b64: base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    b"new-asset",
                ),
            }],
            ..bundle("session-1", "revision-2", "new")
        };
        let second = manager.upsert(bridge_key, replacement).await.unwrap();
        assert_eq!(first.bridge_id, second.bridge_id);
        assert_eq!(first.base_url, second.base_url);

        let reload = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(reload.to_text().unwrap(), r#"{"type":"reload"}"#);

        let document = client
            .get(format!("{}/", first.base_url))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(document.contains("new"));
        assert!(!document.contains("old"));
        let new_asset = client
            .get(format!("{}/files/new.png", first.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(new_asset.bytes().await.unwrap().as_ref(), b"new-asset");
        let old_asset = client
            .get(format!("{}/files/layout.png", first.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(old_asset.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn websocket_forwards_only_valid_bounded_revision_bound_events() {
        let (manager, mut events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut socket = connect_ws(&entry.base_url, &cookie, &entry.base_url).await;
        let _ = socket.next().await;

        socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "companion-event",
                    "event": {
                        "event_id": "event-1",
                        "type": "click",
                        "choice": "layout",
                        "text": "Choose a layout",
                        "id": "layout",
                        "timestamp": 1234
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let forwarded = timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(forwarded.bridge_id, entry.bridge_id);
        assert_eq!(forwarded.session_id, "session-1");
        assert_eq!(forwarded.revision, "revision-1");
        assert_eq!(forwarded.event.event_id, "event-1");

        manager
            .set_event_result(
                &entry.bridge_id,
                CompanionBridgeEventResult {
                    session_id: "session-1".into(),
                    revision: "revision-1".into(),
                    event_id: "event-1".into(),
                    accepted: true,
                    code: None,
                    message: None,
                },
            )
            .await
            .unwrap();
        let result = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(result.to_text().unwrap()).unwrap(),
            serde_json::json!({
                "type":"event_result",
                "event_id":"event-1",
                "accepted":true
            })
        );

        socket
            .send(Message::Text(
                r#"{"type":"companion-event","event":{"event_id":"bad","type":"click","choice":"","text":"","id":null,"timestamp":1}}"#
                    .into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                r#"{"type":"companion-event","event":{"event_id":"unknown","type":"click","choice":"layout","text":"","id":null,"timestamp":1,"extra":"rejected"}}"#
                    .into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Binary(Bytes::from_static(
                br#"{"type":"companion-event","event":{"event_id":"binary","type":"click","choice":"layout","text":"","id":null,"timestamp":1}}"#,
            )))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                r#"{"type":"companion-event","event":{"event_id":"unsafe-timestamp","type":"click","choice":"layout","text":"","id":null,"timestamp":9007199254740992}}"#
                    .into(),
            ))
            .await
            .unwrap();
        assert!(timeout(Duration::from_millis(100), events.recv())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn repeated_upsert_issues_a_fresh_single_use_capability_without_disrupting_browser() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let bridge_key = key("task-1", "session-1");
        let current = bundle("session-1", "revision-1", "current");
        let first = manager
            .upsert(bridge_key.clone(), current.clone())
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let first_cookie = authorize(&client, &first.entry_url).await;
        let mut socket = connect_ws(&first.base_url, &first_cookie, &first.base_url).await;
        let _ = socket.next().await;

        let second = manager.upsert(bridge_key, current).await.unwrap();
        assert_eq!(second.bridge_id, first.bridge_id);
        assert_ne!(second.entry_url, first.entry_url);

        let first_replay = client.get(&first.entry_url).send().await.unwrap();
        assert_eq!(first_replay.status(), StatusCode::UNAUTHORIZED);
        let second_cookie = authorize(&client, &second.entry_url).await;
        assert_eq!(second_cookie.split_once('=').unwrap().0, COOKIE_NAME);

        manager
            .set_state(
                &first.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Reconnecting,
                    selected: true,
                },
            )
            .await
            .unwrap();
        let status = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(status.to_text().unwrap()).unwrap(),
            serde_json::json!({"type":"status","status":"reconnecting"})
        );
    }

    #[tokio::test]
    async fn concurrent_capability_exchange_has_exactly_one_winner() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let first = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let second = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let (first, second) = tokio::join!(
            first.get(&entry.entry_url).send(),
            second.get(&entry.entry_url).send()
        );
        let statuses = [first.unwrap().status(), second.unwrap().status()];
        assert_eq!(
            statuses
                .iter()
                .filter(|status| **status == StatusCode::SEE_OTHER)
                .count(),
            1
        );
        assert_eq!(
            statuses
                .iter()
                .filter(|status| **status == StatusCode::UNAUTHORIZED)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn event_results_require_exact_session_revision_and_pending_event() {
        let (manager, mut events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut socket = connect_ws(&entry.base_url, &cookie, &entry.base_url).await;
        let _ = socket.next().await;
        socket
            .send(Message::Text(
                r#"{"type":"companion-event","event":{"event_id":"event-1","type":"click","choice":"layout","text":"","id":null,"timestamp":1}}"#
                    .into(),
            ))
            .await
            .unwrap();
        let _ = events.recv().await.unwrap();

        let stale = manager
            .set_event_result(
                &entry.bridge_id,
                CompanionBridgeEventResult {
                    session_id: "session-1".into(),
                    revision: "revision-stale".into(),
                    event_id: "event-1".into(),
                    accepted: false,
                    code: Some("stale_revision".into()),
                    message: Some("/private/path must not be reflected".into()),
                },
            )
            .await;
        assert!(stale.is_err());
        assert!(timeout(Duration::from_millis(100), socket.next())
            .await
            .is_err());

        manager
            .set_event_result(
                &entry.bridge_id,
                CompanionBridgeEventResult {
                    session_id: "session-1".into(),
                    revision: "revision-1".into(),
                    event_id: "event-1".into(),
                    accepted: false,
                    code: Some("stale_revision".into()),
                    message: Some("/private/path must not be reflected".into()),
                },
            )
            .await
            .unwrap();
        let result = socket.next().await.unwrap().unwrap();
        let text = result.to_text().unwrap();
        assert!(text.contains("stale_revision"));
        assert!(!text.contains("/private/path"));
    }

    #[tokio::test]
    async fn duplicate_event_ids_and_results_are_isolated_to_the_originating_browser() {
        let (manager, mut events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut first = connect_ws(&entry.base_url, &cookie, &entry.base_url).await;
        let mut second = connect_ws(&entry.base_url, &cookie, &entry.base_url).await;
        let _ = first.next().await;
        let _ = second.next().await;
        let duplicate = Message::Text(
            r#"{"type":"companion-event","event":{"event_id":"duplicate","type":"click","choice":"layout","text":"","id":null,"timestamp":1}}"#
                .into(),
        );

        first.send(duplicate.clone()).await.unwrap();
        let _ = events.recv().await.unwrap();
        second.send(duplicate).await.unwrap();
        let local_failure = second.next().await.unwrap().unwrap();
        assert!(local_failure.to_text().unwrap().contains("bridge_busy"));

        manager
            .set_event_result(
                &entry.bridge_id,
                CompanionBridgeEventResult {
                    session_id: "session-1".into(),
                    revision: "revision-1".into(),
                    event_id: "duplicate".into(),
                    accepted: true,
                    code: None,
                    message: None,
                },
            )
            .await
            .unwrap();
        let accepted = first.next().await.unwrap().unwrap();
        assert!(accepted.to_text().unwrap().contains("\"accepted\":true"));
        assert!(timeout(Duration::from_millis(100), second.next())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn reliable_result_slots_bound_pending_plus_queued_results() {
        let (browser_events, _events) = mpsc::channel(128);
        let manager = Arc::new(CompanionBridgeManager::with_grace_period(
            browser_events.clone(),
            Duration::from_secs(30),
        ));
        let handle = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let entry = manager.entry_by_id(&handle.bridge_id).await.unwrap();
        let (sender, mut receiver) = mpsc::channel(MAX_PENDING_EVENTS);
        let slots = Arc::new(tokio::sync::Semaphore::new(MAX_PENDING_EVENTS));
        let connection_id =
            reserve_current_browser(&manager, &entry, "session-1", "revision-1", sender, slots)
                .await;
        let message = |event_id: &str| {
            format!(
                r#"{{"type":"companion-event","event":{{"event_id":"{event_id}","type":"click","choice":"layout","text":"","id":null,"timestamp":1}}}}"#
            )
        };
        for index in 0..MAX_PENDING_EVENTS {
            assert!(super::accept_browser_message(
                &entry,
                &browser_events,
                connection_id,
                &message(&format!("event-{index}")),
            )
            .is_none());
        }
        let result = |event_id: &str| CompanionBridgeEventResult {
            session_id: "session-1".into(),
            revision: "revision-1".into(),
            event_id: event_id.into(),
            accepted: true,
            code: None,
            message: None,
        };
        for index in 0..MAX_PENDING_EVENTS {
            manager
                .set_event_result(&handle.bridge_id, result(&format!("event-{index}")))
                .await
                .unwrap();
        }
        assert!(matches!(
            super::accept_browser_message(
                &entry,
                &browser_events,
                connection_id,
                &message("while-stalled"),
            ),
            Some(super::BrowserNotification::EventResult {
                accepted: false,
                ..
            })
        ));
        let delivered = receiver.recv().await.unwrap();
        assert!(matches!(
            &delivered.notification,
            super::BrowserNotification::EventResult { accepted: true, .. }
        ));
        drop(delivered);
        assert!(super::accept_browser_message(
            &entry,
            &browser_events,
            connection_id,
            &message("after-drain"),
        )
        .is_none());
        manager.release_browser(&entry, connection_id).await;
    }

    #[tokio::test]
    async fn full_browser_event_channel_returns_a_correlated_local_failure() {
        let (events, _receiver) = mpsc::channel(1);
        let manager = Arc::new(CompanionBridgeManager::with_grace_period(
            events,
            Duration::from_secs(30),
        ));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut socket = connect_ws(&entry.base_url, &cookie, &entry.base_url).await;
        let _ = socket.next().await;

        for event_id in ["event-1", "event-2"] {
            socket
                .send(Message::Text(
                    format!(
                        r#"{{"type":"companion-event","event":{{"event_id":"{event_id}","type":"click","choice":"layout","text":"","id":null,"timestamp":1}}}}"#
                    )
                    .into(),
                ))
                .await
                .unwrap();
        }
        let result = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(result.to_text().unwrap()).unwrap(),
            serde_json::json!({
                "type":"event_result",
                "event_id":"event-2",
                "accepted":false,
                "code":"bridge_busy",
                "message":"Selection failed. Try again."
            })
        );
    }

    #[tokio::test]
    async fn fragmented_text_is_reassembled_binary_is_ignored_and_oversize_closes() {
        let (manager, mut events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut socket = connect_ws(&entry.base_url, &cookie, &entry.base_url).await;
        let _ = socket.next().await;

        let message = r#"{"type":"companion-event","event":{"event_id":"fragmented","type":"click","choice":"layout","text":"","id":null,"timestamp":1}}"#;
        let split = message.len() / 2;
        socket
            .send(Message::Frame(Frame::message(
                Bytes::copy_from_slice(&message.as_bytes()[..split]),
                OpCode::Data(Data::Text),
                false,
            )))
            .await
            .unwrap();
        socket
            .send(Message::Frame(Frame::message(
                Bytes::copy_from_slice(&message.as_bytes()[split..]),
                OpCode::Data(Data::Continue),
                true,
            )))
            .await
            .unwrap();
        let event = timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.event.event_id, "fragmented");

        socket
            .send(Message::Binary(Bytes::from_static(b"ignored")))
            .await
            .unwrap();
        assert!(timeout(Duration::from_millis(50), events.recv())
            .await
            .is_err());
        socket
            .send(Message::Text(
                "x".repeat(MAX_BROWSER_EVENT_BYTES + 1).into(),
            ))
            .await
            .unwrap();
        let closed = timeout(Duration::from_secs(1), socket.next())
            .await
            .expect("oversized browser frames must close the socket");
        assert!(matches!(
            closed,
            None | Some(Ok(Message::Close(_))) | Some(Err(_))
        ));
    }

    #[tokio::test]
    async fn entry_document_asset_and_aggregate_resource_limits_are_enforced() {
        let (entry_manager, _events) = manager(Duration::from_secs(30));
        for index in 0..MAX_BRIDGE_ENTRIES {
            entry_manager
                .upsert(
                    key(&format!("task-{index}"), &format!("session-{index}")),
                    bundle(&format!("session-{index}"), "r1", "small"),
                )
                .await
                .unwrap();
        }
        assert!(entry_manager
            .upsert(
                key("task-overflow", "session-overflow"),
                bundle("session-overflow", "r1", "small"),
            )
            .await
            .unwrap_err()
            .contains("too many"));
        drop(entry_manager);

        let (manager, _events) = manager(Duration::from_secs(30));
        let mut too_many_assets = bundle("session-assets", "r1", "assets");
        too_many_assets.assets = (0..=MAX_ASSET_COUNT)
            .map(|index| CompanionAsset {
                name: format!("asset-{index}.bin"),
                content_type: "application/octet-stream".into(),
                digest: format!("digest-{index}"),
                data_b64: String::new(),
            })
            .collect();
        assert!(manager
            .upsert(key("task-assets", "session-assets"), too_many_assets)
            .await
            .is_err());

        let mut oversized_document = bundle("session-document", "r1", "document");
        oversized_document.document_html = "x".repeat(MAX_RENDERED_DOCUMENT_BYTES + 1);
        assert!(manager
            .upsert(key("task-document", "session-document"), oversized_document,)
            .await
            .is_err());

        let mut oversized_asset = bundle("session-asset-size", "r1", "asset");
        oversized_asset.assets = vec![CompanionAsset {
            name: "large.bin".into(),
            content_type: "application/octet-stream".into(),
            digest: "digest".into(),
            data_b64: base64::engine::general_purpose::STANDARD
                .encode(vec![0_u8; MAX_ASSET_BYTES + 1]),
        }];
        assert!(manager
            .upsert(
                key("task-asset-size", "session-asset-size"),
                oversized_asset,
            )
            .await
            .is_err());

        let encoded_asset =
            base64::engine::general_purpose::STANDARD.encode(vec![0_u8; MAX_ASSET_BYTES]);
        for index in 0..4 {
            let session = format!("session-total-{index}");
            let mut aggregate = bundle(&session, "r1", "aggregate");
            aggregate.assets = (0..4)
                .map(|asset_index| CompanionAsset {
                    name: format!("asset-{asset_index}.bin"),
                    content_type: "application/octet-stream".into(),
                    digest: format!("digest-{asset_index}"),
                    data_b64: encoded_asset.clone(),
                })
                .collect();
            let result = manager
                .upsert(key(&format!("task-total-{index}"), &session), aggregate)
                .await;
            if index < 3 {
                result.unwrap();
            } else {
                assert!(result.unwrap_err().contains("resource limit"));
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn maximum_bundle_preparation_keeps_unrelated_runtime_work_responsive() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let session_id = "session-maximum-preparation";
        let mut maximum = bundle(session_id, "r1", "maximum");
        let encoded_asset =
            base64::engine::general_purpose::STANDARD.encode(vec![0_u8; MAX_ASSET_BYTES]);
        maximum.assets = (0..4)
            .map(|index| CompanionAsset {
                name: format!("asset-{index}.bin"),
                content_type: "application/octet-stream".into(),
                digest: format!("digest-{index}"),
                data_b64: encoded_asset.clone(),
            })
            .collect();

        let gate = manager.install_bundle_preparation_gate(session_id);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            gate.release();
        });
        let runtime_progressed = Arc::new(AtomicBool::new(false));
        let progress = Arc::clone(&runtime_progressed);
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            progress.store(true, Ordering::Release);
        });

        manager
            .upsert(key("task-maximum-preparation", session_id), maximum)
            .await
            .expect("maximum legal companion bundle should be prepared");

        assert!(
            runtime_progressed.load(Ordering::Acquire),
            "maximum bundle preparation blocked unrelated Tokio runtime work"
        );
    }

    #[tokio::test]
    async fn invalid_assets_are_rejected_and_error_pages_are_sanitized() {
        let (manager, _events) = manager(Duration::from_secs(30));
        for (name, content_type) in [
            ("../secret", "image/png"),
            ("layout.png", "image/png\r\nx-leak: yes"),
        ] {
            let mut invalid = bundle("session-invalid", "revision-1", "invalid");
            invalid.assets[0].name = name.into();
            invalid.assets[0].content_type = content_type.into();
            assert!(manager
                .upsert(key("task-invalid", "session-invalid"), invalid)
                .await
                .is_err());
        }

        let entry = manager
            .upsert(
                key("task-error", "session-error"),
                bundle("session-error", "revision-1", "/private/worktree/path"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let _cookie = authorize(&client, &entry.entry_url).await;
        manager
            .set_state(
                &entry.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Error,
                    selected: true,
                },
            )
            .await
            .unwrap();
        let page = client
            .get(format!("{}/", entry.base_url))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(page.contains("Visual companion unavailable"));
        assert!(!page.contains("/private/worktree/path"));
    }

    #[tokio::test]
    async fn active_or_mismatched_assets_are_forced_to_attachment_octet_stream() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let mut active = bundle("session-active", "revision-1", "active");
        active.assets = vec![
            CompanionAsset {
                name: "payload.html".into(),
                content_type: "text/html".into(),
                digest: "html-digest".into(),
                data_b64: base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    b"<script>window.top.location='https://attacker.invalid'</script>",
                ),
            },
            CompanionAsset {
                name: "pretend.png".into(),
                content_type: "text/javascript".into(),
                digest: "mismatch-digest".into(),
                data_b64: base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    b"window.pwned = true",
                ),
            },
        ];
        let entry = manager
            .upsert(key("task-active", "session-active"), active)
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        authorize(&client, &entry.entry_url).await;

        for name in ["payload.html", "pretend.png"] {
            let response = client
                .get(format!("{}/files/{name}", entry.base_url))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "application/octet-stream"
            );
            assert_eq!(
                response.headers()[header::CONTENT_DISPOSITION],
                "attachment"
            );
            assert!(response.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("script-src 'none'"));
        }
    }

    #[tokio::test]
    async fn websocket_connection_limit_rejects_excess_browsers() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut sockets = Vec::new();
        for _ in 0..MAX_BROWSER_CONNECTIONS {
            let mut socket = connect_ws(&entry.base_url, &cookie, &entry.base_url).await;
            let _ = socket.next().await;
            sockets.push(socket);
        }
        let mut request = format!(
            "{}/ws?sessionId=session-1&revision=revision-1",
            entry.base_url.replacen("http://", "ws://", 1)
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert(header::COOKIE, cookie.parse().unwrap());
        request
            .headers_mut()
            .insert(header::ORIGIN, entry.base_url.parse().unwrap());
        let rejected = tokio_tungstenite::connect_async(request).await.unwrap_err();
        assert!(rejected.to_string().contains("503"));
        for mut socket in sockets {
            socket.close(None).await.unwrap();
        }
    }

    #[tokio::test]
    async fn stalled_and_partial_headers_time_out_and_release_connection_permits() {
        use tokio::io::AsyncWriteExt as _;

        let (events, _receiver) = mpsc::channel(8);
        let manager = Arc::new(CompanionBridgeManager::with_timeouts(
            events,
            Duration::from_secs(30),
            Duration::from_millis(50),
        ));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let port = entry
            .base_url
            .rsplit_once(':')
            .unwrap()
            .1
            .parse::<u16>()
            .unwrap();
        let mut stalled = Vec::new();
        for index in 0..MAX_HTTP_CONNECTIONS {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            if index == 0 {
                stream
                    .write_all(b"GET / HTTP/1.1\r\nHost: partial")
                    .await
                    .unwrap();
            }
            stalled.push(stream);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;

        let legitimate = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(format!("{}/", entry.base_url))
            .header(header::COOKIE, cookie)
            .send();
        let response = timeout(Duration::from_secs(1), legitimate)
            .await
            .expect("header deadlines must free a permit for the queued request")
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        drop(stalled);
    }

    #[tokio::test]
    async fn header_deadline_does_not_apply_after_authenticated_websocket_upgrade() {
        let (events, _receiver) = mpsc::channel(8);
        let manager = Arc::new(CompanionBridgeManager::with_timeouts(
            events,
            Duration::from_secs(30),
            Duration::from_millis(40),
        ));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut socket = connect_ws(&entry.base_url, &cookie, &entry.base_url).await;
        let _ = socket.next().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        socket
            .send(Message::Ping(Bytes::from_static(b"still-open")))
            .await
            .unwrap();
        let pong = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(pong, Message::Pong(Bytes::from_static(b"still-open")));
    }

    #[tokio::test]
    async fn header_bound_is_lifted_only_after_the_server_confirms_an_upgrade() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::net::TcpStream::connect(address);
        let accepted = listener.accept();
        let (client, accepted) = tokio::join!(client, accepted);
        let _client = client.unwrap();
        let (server, _) = accepted.unwrap();
        let mut bounded = BoundedHeaderIo::new(server);
        let apparent_upgrade =
            b"GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: upgrade\r\n\r\n";

        bounded.inspect(apparent_upgrade).unwrap();
        assert!(!bounded.websocket_upgraded);
        assert!(bounded
            .inspect(&vec![b'x'; MAX_HTTP_HEADER_BYTES + 1])
            .is_err());

        let (client, accepted) =
            tokio::join!(tokio::net::TcpStream::connect(address), listener.accept());
        let _client = client.unwrap();
        let (server, _) = accepted.unwrap();
        let mut bounded = BoundedHeaderIo::new(server);
        bounded.inspect(apparent_upgrade).unwrap();
        bounded
            .inspect_response(b"HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\n\r\n")
            .unwrap();
        assert!(bounded.websocket_upgraded);
        bounded
            .inspect(&vec![b'x'; MAX_HTTP_HEADER_BYTES + 1])
            .unwrap();
    }

    #[tokio::test]
    async fn http_header_bytes_targets_names_and_smuggling_inputs_are_bounded() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        async fn raw_exchange(port: u16, request: Vec<u8>) -> String {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            stream.write_all(&request).await.unwrap();
            let mut response = Vec::new();
            let _ = timeout(Duration::from_secs(1), stream.read_to_end(&mut response)).await;
            String::from_utf8_lossy(&response).into_owned()
        }

        let (manager, _events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let host = entry.base_url.strip_prefix("http://").unwrap();
        let port = host.rsplit_once(':').unwrap().1.parse::<u16>().unwrap();

        let below_limit = format!(
            "GET / HTTP/1.1\r\nHost: {host}\r\nCookie: {cookie}\r\nX-Pad: {}\r\nConnection: close\r\n\r\n",
            "a".repeat(MAX_HTTP_HEADER_BYTES - 1024)
        );
        let accepted = raw_exchange(port, below_limit.into_bytes()).await;
        assert!(accepted.starts_with("HTTP/1.1 200"));

        for oversized in [
            format!(
                "GET / HTTP/1.1\r\nHost: {host}\r\nCookie: {cookie}\r\nX-Pad: {}\r\n\r\n",
                "a".repeat(MAX_HTTP_HEADER_BYTES + 1)
            ),
            format!(
                "GET / HTTP/1.1\r\nHost: {host}\r\nCookie: {cookie}\r\n{}: value\r\n\r\n",
                "x".repeat(MAX_HTTP_HEADER_BYTES + 1)
            ),
            format!(
                "GET /{} HTTP/1.1\r\nHost: {host}\r\nCookie: {cookie}\r\n\r\n",
                "x".repeat(MAX_HTTP_HEADER_BYTES + 1)
            ),
        ] {
            let response = raw_exchange(port, oversized.into_bytes()).await;
            assert!(
                response.is_empty()
                    || response.starts_with("HTTP/1.1 400")
                    || response.starts_with("HTTP/1.1 431"),
                "oversized headers must not reach the application router"
            );
            assert!(!response.contains("X-Pad"));
        }

        let smuggling = format!(
            "GET / HTTP/1.1\r\nHost: {host}\r\nCookie: {cookie}\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n"
        );
        let response = raw_exchange(port, smuggling.into_bytes()).await;
        assert!(
            response.is_empty()
                || response.starts_with("HTTP/1.1 400")
                || response.starts_with("HTTP/1.1 405")
        );
        assert!(!response.starts_with("HTTP/1.1 200"));
    }

    #[tokio::test]
    async fn authoritative_same_revision_snapshot_restores_available_status() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let bridge_key = key("task-1", "session-1");
        let current = bundle("session-1", "revision-1", "current");
        let entry = manager
            .upsert(bridge_key.clone(), current.clone())
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut socket = connect_ws(&entry.base_url, &cookie, &entry.base_url).await;
        let _ = socket.next().await;

        manager
            .set_state(
                &entry.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Reconnecting,
                    selected: true,
                },
            )
            .await
            .unwrap();
        let reconnecting = socket.next().await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(reconnecting.to_text().unwrap()).unwrap(),
            serde_json::json!({"type":"status","status":"reconnecting"})
        );

        manager.upsert(bridge_key, current).await.unwrap();
        let available = timeout(Duration::from_secs(1), socket.next())
            .await
            .expect("authoritative snapshot should publish availability")
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(available.to_text().unwrap()).unwrap(),
            serde_json::json!({"type":"status","status":"available"})
        );
    }

    #[tokio::test]
    async fn concurrent_state_calls_never_publish_an_older_lifecycle_after_a_newer_commit() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-state-order", "session-state-order"),
                bundle("session-state-order", "revision-1", "state order"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut socket = connect_ws_for_document(
            &entry.base_url,
            &cookie,
            &entry.base_url,
            "session-state-order",
            "revision-1",
        )
        .await;
        let _ = socket.next().await;

        let reached = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Barrier::new(2));
        *manager.publication_barriers.lock().unwrap() = Some((
            PublicationPhase::SetState(CompanionBridgeLifecycle::Available),
            reached.clone(),
            release.clone(),
        ));
        let earlier_manager = manager.clone();
        let earlier_bridge_id = entry.bridge_id.clone();
        let earlier = tokio::spawn(async move {
            earlier_manager
                .set_state(
                    &earlier_bridge_id,
                    CompanionBridgeStateUpdate {
                        status: CompanionBridgeLifecycle::Available,
                        selected: true,
                    },
                )
                .await
        });
        reached.wait().await;
        manager
            .set_state(
                &entry.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Reconnecting,
                    selected: true,
                },
            )
            .await
            .unwrap();
        let newer = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(newer.to_text().unwrap()).unwrap(),
            serde_json::json!({"type":"status","status":"reconnecting"})
        );

        *manager.publication_barriers.lock().unwrap() = None;
        release.wait().await;
        earlier.await.unwrap().unwrap();
        let delayed_earlier = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(delayed_earlier.to_text().unwrap()).unwrap(),
            serde_json::json!({"type":"status","status":"reconnecting"}),
            "a delayed wakeup must re-derive the latest committed lifecycle"
        );
    }

    #[tokio::test]
    async fn concurrent_same_bundle_upsert_never_restores_stale_available_status() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let bridge_key = key("task-upsert-order", "session-upsert-order");
        let current = bundle("session-upsert-order", "revision-1", "upsert order");
        let entry = manager
            .upsert(bridge_key.clone(), current.clone())
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut socket = connect_ws_for_document(
            &entry.base_url,
            &cookie,
            &entry.base_url,
            "session-upsert-order",
            "revision-1",
        )
        .await;
        let _ = socket.next().await;
        manager
            .set_state(
                &entry.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Reconnecting,
                    selected: true,
                },
            )
            .await
            .unwrap();
        let _ = socket.next().await;

        let reached = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Barrier::new(2));
        *manager.publication_barriers.lock().unwrap() = Some((
            PublicationPhase::BundleAvailable,
            reached.clone(),
            release.clone(),
        ));
        let earlier_manager = manager.clone();
        let earlier =
            tokio::spawn(async move { earlier_manager.upsert(bridge_key, current).await });
        reached.wait().await;
        manager
            .set_state(
                &entry.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Reconnecting,
                    selected: true,
                },
            )
            .await
            .unwrap();
        let newer = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(newer.to_text().unwrap()).unwrap(),
            serde_json::json!({"type":"status","status":"reconnecting"})
        );

        *manager.publication_barriers.lock().unwrap() = None;
        release.wait().await;
        earlier.await.unwrap().unwrap();
        let delayed_upsert = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(delayed_upsert.to_text().unwrap()).unwrap(),
            serde_json::json!({"type":"status","status":"reconnecting"}),
            "a delayed upsert wakeup must not re-enable a reconnecting companion"
        );
    }

    #[tokio::test]
    async fn concurrent_bundle_replacement_reload_precedes_any_state_wakeup() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let bridge_key = key("task-reload-order", "session-reload-order");
        let entry = manager
            .upsert(
                bridge_key.clone(),
                bundle("session-reload-order", "revision-1", "old"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;
        let mut socket = connect_ws_for_document(
            &entry.base_url,
            &cookie,
            &entry.base_url,
            "session-reload-order",
            "revision-1",
        )
        .await;
        let _ = socket.next().await;

        let reached = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Barrier::new(2));
        *manager.publication_barriers.lock().unwrap() = Some((
            PublicationPhase::SetState(CompanionBridgeLifecycle::Available),
            reached.clone(),
            release.clone(),
        ));
        let earlier_manager = manager.clone();
        let earlier_bridge_id = entry.bridge_id.clone();
        let earlier = tokio::spawn(async move {
            earlier_manager
                .set_state(
                    &earlier_bridge_id,
                    CompanionBridgeStateUpdate {
                        status: CompanionBridgeLifecycle::Available,
                        selected: true,
                    },
                )
                .await
        });
        reached.wait().await;
        manager
            .upsert(
                bridge_key,
                bundle("session-reload-order", "revision-2", "new"),
            )
            .await
            .unwrap();
        *manager.publication_barriers.lock().unwrap() = None;
        release.wait().await;
        earlier.await.unwrap().unwrap();

        let notification = timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(notification.to_text().unwrap()).unwrap(),
            serde_json::json!({"type":"reload"})
        );
    }

    #[tokio::test]
    async fn assets_and_websockets_reject_query_variants() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let entry = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "one"),
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &entry.entry_url).await;

        let asset = client
            .get(format!(
                "{}/files/layout.png?upstream=http://example.com",
                entry.base_url
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(asset.status(), StatusCode::NOT_FOUND);

        let mut request = format!(
            "{}/ws?upstream=ignored",
            entry.base_url.replacen("http://", "ws://", 1)
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert(header::COOKIE, cookie.parse().unwrap());
        request
            .headers_mut()
            .insert(header::ORIGIN, entry.base_url.parse().unwrap());
        let rejected = tokio_tungstenite::connect_async(request).await.unwrap_err();
        assert!(rejected.to_string().contains("400"));
    }

    #[tokio::test]
    async fn random_localhost_hosts_isolate_cookies_content_and_events() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let first = manager
            .upsert(
                key("task-1", "session-1"),
                bundle("session-1", "revision-1", "first"),
            )
            .await
            .unwrap();
        let second = manager
            .upsert(
                key("task-2", "session-2"),
                bundle("session-2", "revision-2", "second"),
            )
            .await
            .unwrap();
        assert_ne!(first.bridge_id, second.bridge_id);
        assert_ne!(first.base_url, second.base_url);
        assert!(first.base_url.contains(".localhost:"));
        assert!(second.base_url.contains(".localhost:"));

        let jar = Arc::new(Jar::default());
        let client = Client::builder()
            .cookie_provider(jar.clone())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let _first_cookie = authorize(&client, &first.entry_url).await;
        let first_url = Url::parse(&format!("{}/", first.base_url)).unwrap();
        let second_url = Url::parse(&format!("{}/", second.base_url)).unwrap();
        let numeric_url =
            Url::parse(&format!("http://127.0.0.1:{}/", first_url.port().unwrap())).unwrap();
        assert!(jar.cookies(&first_url).is_some());
        assert!(
            jar.cookies(&second_url).is_none(),
            "a host-only cookie must not be sent to a sibling random localhost hostname"
        );
        assert!(
            jar.cookies(&numeric_url).is_none(),
            "a host-only cookie must not be sent to the numeric loopback host"
        );
        let first_document = client
            .get(format!("{}/", first.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(first_document.status(), StatusCode::OK);

        let cross_entry = client
            .get(format!("{}/", second.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(cross_entry.status(), StatusCode::UNAUTHORIZED);

        let port = first.base_url.rsplit_once(':').unwrap().1;
        let numeric_host = client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(numeric_host.status(), StatusCode::MISDIRECTED_REQUEST);

        let alternate_host = client
            .get(format!("{}/", first.base_url))
            .header(header::HOST, format!("attacker.localhost:{port}"))
            .send()
            .await
            .unwrap();
        assert_eq!(alternate_host.status(), StatusCode::MISDIRECTED_REQUEST);
    }

    #[tokio::test]
    async fn grace_cleanup_and_failed_upgrade_release_recheck_atomic_browser_state() {
        let (manager, _events) = manager(Duration::from_millis(20));
        let handle = manager
            .upsert(
                key("task-race", "session-race"),
                bundle("session-race", "r1", "race"),
            )
            .await
            .unwrap();
        let entry = manager.entry_by_id(&handle.bridge_id).await.unwrap();
        let reached = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Barrier::new(2));
        *manager.cleanup_barriers.lock().unwrap() = Some((reached.clone(), release.clone()));
        manager
            .set_state(
                &handle.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Available,
                    selected: false,
                },
            )
            .await
            .unwrap();
        reached.wait().await;
        *manager.cleanup_barriers.lock().unwrap() = None;
        let (sender, _receiver) = mpsc::channel(MAX_PENDING_EVENTS);
        let connection_id = reserve_current_browser(
            &manager,
            &entry,
            "session-race",
            "r1",
            sender,
            Arc::new(tokio::sync::Semaphore::new(MAX_PENDING_EVENTS)),
        )
        .await;
        release.wait().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(manager.contains(&handle.bridge_id).await);

        manager
            .set_state(
                &handle.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Unavailable,
                    selected: false,
                },
            )
            .await
            .unwrap();
        assert!(manager.contains(&handle.bridge_id).await);
        manager.release_browser(&entry, connection_id).await;
        assert!(!manager.contains(&handle.bridge_id).await);
    }

    #[tokio::test]
    async fn unavailable_selection_grace_and_shutdown_follow_browser_lifecycle() {
        let (manager, _events) = manager(Duration::from_millis(40));

        let grace = manager
            .upsert(
                key("task-grace", "session-grace"),
                bundle("session-grace", "r1", "grace"),
            )
            .await
            .unwrap();
        manager
            .set_state(
                &grace.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Available,
                    selected: false,
                },
            )
            .await
            .unwrap();
        assert!(manager.contains(&grace.bridge_id).await);
        tokio::time::sleep(Duration::from_millis(15)).await;
        manager
            .upsert(
                key("task-grace", "session-grace"),
                bundle("session-grace", "r2", "updated while unselected"),
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(65)).await;
        assert!(!manager.contains(&grace.bridge_id).await);

        let unavailable = manager
            .upsert(
                key("task-unavailable", "session-unavailable"),
                bundle("session-unavailable", "r1", "unavailable"),
            )
            .await
            .unwrap();
        manager
            .set_state(
                &unavailable.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Unavailable,
                    selected: true,
                },
            )
            .await
            .unwrap();
        assert!(!manager.contains(&unavailable.bridge_id).await);

        let live = manager
            .upsert(
                key("task-live", "session-live"),
                CompanionBridgeBundle {
                    lifecycle_page_strings: CompanionLifecyclePageStrings {
                        unavailable_title: "ビジュアルコンパニオンは終了しました。".into(),
                        unavailable_detail: "このコンパニオンは利用できなくなりました。".into(),
                        error_title: "ビジュアルコンパニオンを利用できません".into(),
                        error_detail: "コンパニオンを表示できませんでした。".into(),
                    },
                    ..bundle("session-live", "r1", "live")
                },
            )
            .await
            .unwrap();
        let client = Client::builder()
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let cookie = authorize(&client, &live.entry_url).await;
        let mut socket = connect_ws_for_document(
            &live.base_url,
            &cookie,
            &live.base_url,
            "session-live",
            "r1",
        )
        .await;
        let _ = socket.next().await;
        manager
            .set_state(
                &live.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Unavailable,
                    selected: false,
                },
            )
            .await
            .unwrap();
        assert!(manager.contains(&live.bridge_id).await);
        let ended = client
            .get(format!("{}/", live.base_url))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(ended.contains("ビジュアルコンパニオンは終了しました。"));
        assert!(ended.contains("このコンパニオンは利用できなくなりました。"));
        assert!(!ended.contains("This visual companion has ended."));
        assert!(!ended.contains("live"));
        socket.close(None).await.unwrap();
        timeout(Duration::from_secs(1), async {
            while manager.contains(&live.bridge_id).await {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let shutdown = manager
            .upsert(
                key("task-shutdown", "session-shutdown"),
                bundle("session-shutdown", "r1", "shutdown"),
            )
            .await
            .unwrap();
        let shutdown_cookie = authorize(&client, &shutdown.entry_url).await;
        let mut shutdown_socket = connect_ws_for_document(
            &shutdown.base_url,
            &shutdown_cookie,
            &shutdown.base_url,
            "session-shutdown",
            "r1",
        )
        .await;
        let _ = shutdown_socket.next().await;
        manager.shutdown().await;
        assert!(!manager.contains(&shutdown.bridge_id).await);
        let closed = timeout(Duration::from_secs(1), shutdown_socket.next())
            .await
            .expect("shutdown must close live browser sockets");
        assert!(matches!(closed, None | Some(Ok(Message::Close(_)))));
        assert!(client
            .get(format!("{}/", shutdown.base_url))
            .send()
            .await
            .is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_unselected_status_updates_do_not_renew_the_grace_deadline() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let handle = manager
            .upsert(
                key("task-anchor", "session-anchor"),
                bundle("session-anchor", "r1", "anchor"),
            )
            .await
            .unwrap();
        manager
            .set_state(
                &handle.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Available,
                    selected: false,
                },
            )
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(20)).await;
        manager
            .set_state(
                &handle.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Reconnecting,
                    selected: false,
                },
            )
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(11)).await;
        manager
            .set_state(
                &handle.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Reconnecting,
                    selected: false,
                },
            )
            .await
            .unwrap();
        assert!(!manager.contains(&handle.bridge_id).await);
    }

    #[tokio::test(start_paused = true)]
    async fn browser_held_past_grace_deadline_is_removed_immediately_on_release() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let handle = manager
            .upsert(
                key("task-held", "session-held"),
                bundle("session-held", "r1", "held"),
            )
            .await
            .unwrap();
        let entry = manager.entry_by_id(&handle.bridge_id).await.unwrap();
        manager
            .set_state(
                &handle.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Available,
                    selected: false,
                },
            )
            .await
            .unwrap();
        let (sender, _receiver) = mpsc::channel(MAX_PENDING_EVENTS);
        let connection_id = reserve_current_browser(
            &manager,
            &entry,
            "session-held",
            "r1",
            sender,
            Arc::new(tokio::sync::Semaphore::new(MAX_PENDING_EVENTS)),
        )
        .await;
        tokio::time::advance(Duration::from_secs(31)).await;
        tokio::task::yield_now().await;
        assert!(manager.contains(&handle.bridge_id).await);
        manager.release_browser(&entry, connection_id).await;
        assert!(!manager.contains(&handle.bridge_id).await);
    }

    #[tokio::test(start_paused = true)]
    async fn reselect_then_deselect_creates_a_fresh_grace_deadline() {
        let (manager, _events) = manager(Duration::from_secs(30));
        let handle = manager
            .upsert(
                key("task-reset", "session-reset"),
                bundle("session-reset", "r1", "reset"),
            )
            .await
            .unwrap();
        manager
            .set_state(
                &handle.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Available,
                    selected: false,
                },
            )
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(20)).await;
        manager
            .set_state(
                &handle.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Available,
                    selected: true,
                },
            )
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(15)).await;
        tokio::task::yield_now().await;
        assert!(manager.contains(&handle.bridge_id).await);
        manager
            .set_state(
                &handle.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Available,
                    selected: false,
                },
            )
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(29)).await;
        tokio::task::yield_now().await;
        assert!(manager.contains(&handle.bridge_id).await);
        tokio::time::advance(Duration::from_secs(2)).await;
        manager
            .set_state(
                &handle.bridge_id,
                CompanionBridgeStateUpdate {
                    status: CompanionBridgeLifecycle::Available,
                    selected: false,
                },
            )
            .await
            .unwrap();
        assert!(!manager.contains(&handle.bridge_id).await);
    }
}
