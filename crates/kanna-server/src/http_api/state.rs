use crate::config::Config;
use crate::pairing::{self, ActivePairingSession};
use kanna_agent_protocol::{ServerFrame, StateChangeScope, TaskStateChange};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, Notify};

type SingletonOwnerObservations = HashMap<(String, String), HashMap<String, Vec<String>>>;

#[derive(Clone, Copy)]
pub(super) struct TunneledHttpInvoke;

/// Marker for an in-process HTTP invoke whose caller was authenticated before
/// the request entered the Axum router (for example, an authenticated relay
/// tunnel). This is deliberately distinct from `TunneledHttpInvoke`: the
/// latter records transport provenance but grants no authority by itself.
#[derive(Clone, Copy)]
pub(super) struct AuthenticatedHttpInvoke;

#[derive(Clone)]
pub struct AppState {
    pub(super) config: Config,
    pub(super) local_task_events_token: Option<String>,
    pub(super) pairing_session: Arc<Mutex<Option<ActivePairingSession>>>,
    pub(super) pairing_persistence_mutation: Arc<Mutex<()>>,
    #[cfg(debug_assertions)]
    pub(super) e2e_lan_http_enabled: Arc<AtomicBool>,
    pub(super) session_replacements: crate::session_replacements::SessionReplacements,
    pub(super) terminal_attachments: crate::terminal_attachments::TerminalAttachments,
    transfer_sidecar: Arc<crate::transfer_sidecar::TransferSidecarSupervisor>,
    transfer_work: Arc<crate::transfer_engine::queue::TransferWorkQueue>,
    cloud_transfer_proxies: crate::cloud_transfer_proxy::CloudTransferProxyState,
    pub(super) preview_sessions: super::preview::PreviewSessions,
    pub(crate) companion_resources: crate::ksp::CompanionResources,
    pub(crate) terminal_taps: crate::ksp::TerminalTapRegistry,
    pub(crate) agent_histories: crate::ksp::AgentHistoryRegistry,
    pub(super) repo_definitions: Arc<crate::task_creator::RepoDefinitionsCache>,
    requested_task_operations: Arc<RequestedTaskOperations>,
    pub(super) repo_checkouts: Arc<StdMutex<HashMap<String, RepoCheckoutOperation>>>,
    pub(super) repo_checkout_root: std::path::PathBuf,
    known_singleton_owners: Arc<StdMutex<SingletonOwnerObservations>>,
    relay_reconnect: Arc<Notify>,
    anonymous_push_revocations_changed: Arc<Notify>,
    relay_desktop_routing_available: Arc<AtomicBool>,
    relay_desktop_routing_unavailable_reason: Arc<StdMutex<Option<String>>>,
    relay_desktop_routing_generation: Arc<AtomicU64>,
    desktop_relay_tx: mpsc::Sender<DesktopRelayRequest>,
    desktop_relay_rx: Arc<StdMutex<Option<mpsc::Receiver<DesktopRelayRequest>>>>,
    pub(super) aggregate_task_event_waits:
        Arc<StdMutex<crate::http_api::task_events::AggregateWaitRegistry>>,
    /// Version of the relay's `mobileNotifications` capability on the live
    /// session; `0` while no session offers it. Version 2 adds the distinct
    /// push-registration probe message.
    relay_mobile_notifications_version: Arc<AtomicU64>,
    mobile_notification_tx: mpsc::Sender<MobileNotificationRequest>,
    mobile_notification_rx: Arc<StdMutex<Option<mpsc::Receiver<MobileNotificationRequest>>>>,
    requested_task_mutations: Arc<RequestedTaskMutations>,
    state_changes: broadcast::Sender<ServerFrame>,
    #[cfg(test)]
    pub(super) task_creator: Option<TestTaskCreator>,
    #[cfg(test)]
    pub(super) merge_agent_runner: Option<TestMergeAgentRunner>,
    #[cfg(test)]
    pub(super) task_input_sender: Option<TestTaskInputSender>,
    #[cfg(test)]
    pub(super) task_closer: Option<TestTaskCloser>,
    #[cfg(test)]
    pub(super) stage_advancer: Option<TestStageAdvancer>,
    #[cfg(test)]
    pub(super) stage_rerunner: Option<TestStageRerunner>,
    #[cfg(test)]
    pub(super) stage_completer: Option<TestStageCompleter>,
    #[cfg(test)]
    pub(super) revision_requester: Option<TestRevisionRequester>,
    #[cfg(test)]
    pub(super) task_file_resolution_hook: Option<TestTaskFileResolutionHook>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RepoCheckoutOperation {
    pub id: String,
    pub state: &'static str,
    pub repo_name: String,
    pub remote_url_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub(crate) struct MobileNotificationRequest {
    pub notification: crate::relay_client::MobileNotificationPayload,
    pub response: oneshot::Sender<Result<crate::relay_client::MobileNotificationDelivery, String>>,
}

pub(crate) enum DesktopRelayRequest {
    PublishTaskSnapshot {
        generation: u64,
        response: oneshot::Sender<Result<(), String>>,
    },
    ListActive {
        generation: u64,
        response: oneshot::Sender<Result<Vec<String>, String>>,
    },
    ListRepoSingletons {
        generation: u64,
        remote_url_hash: String,
        agent: String,
        response: oneshot::Sender<Result<Vec<RemoteSingletonOwner>, String>>,
    },
    ClaimRepoSingleton {
        generation: u64,
        remote_url_hash: String,
        agent: String,
        task_id: String,
        response: oneshot::Sender<Result<RemoteSingletonClaim, String>>,
    },
    ReleaseRepoSingletonReservation {
        generation: u64,
        remote_url_hash: String,
        agent: String,
        task_id: String,
        response: oneshot::Sender<Result<bool, String>>,
    },
    Invoke {
        generation: u64,
        desktop_id: String,
        method: String,
        path: String,
        body: serde_json::Value,
        response: oneshot::Sender<Result<HttpInvokeResponse, String>>,
    },
}

#[derive(Debug, Clone, serde::Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSingletonOwner {
    pub machine_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, serde::Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSingletonClaim {
    pub status: String,
    pub machine_id: String,
    pub task_id: String,
    #[serde(default)]
    pub owners: Vec<RemoteSingletonOwner>,
}

#[derive(Default)]
struct RequestedTaskOperations {
    active: StdMutex<HashSet<String>>,
    changed: Notify,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RequestedTaskMutationKind {
    Advance,
    Other,
}

#[derive(Default)]
struct RequestedTaskMutations {
    active: StdMutex<HashMap<String, RequestedTaskMutationKind>>,
    changed: Notify,
}

pub(super) struct RequestedTaskOperation {
    task_id: String,
    operations: Arc<RequestedTaskOperations>,
}

pub(super) struct RequestedTaskMutation {
    task_id: String,
    mutations: Arc<RequestedTaskMutations>,
}

impl Drop for RequestedTaskOperation {
    fn drop(&mut self) {
        self.operations
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.task_id);
        self.operations.changed.notify_waiters();
    }
}

impl Drop for RequestedTaskMutation {
    fn drop(&mut self) {
        self.mutations
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.task_id);
        self.mutations.changed.notify_waiters();
    }
}

#[cfg(test)]
pub(super) type TestTaskCreator = Arc<
    dyn Fn(
            crate::mobile_api::CreateTaskRequest,
        ) -> Result<crate::mobile_api::CreateTaskResponse, String>
        + Send
        + Sync,
>;

#[cfg(test)]
pub(super) type TestMergeAgentRunner =
    Arc<dyn Fn(String) -> Result<crate::mobile_api::TaskActionResponse, String> + Send + Sync>;

#[cfg(test)]
pub(super) type TestTaskInputSender =
    Arc<dyn Fn(String, String) -> Result<(), String> + Send + Sync>;

#[cfg(test)]
pub(super) type TestTaskCloser = Arc<dyn Fn(String) -> Result<(), String> + Send + Sync>;

#[cfg(test)]
pub(super) type TestStageAdvancer =
    Arc<dyn Fn(String) -> Result<crate::mobile_api::TaskActionResponse, String> + Send + Sync>;

#[cfg(test)]
pub(super) type TestStageRerunner =
    Arc<dyn Fn(String) -> Result<crate::mobile_api::TaskActionResponse, String> + Send + Sync>;

#[cfg(test)]
pub(super) type TestStageCompleter = Arc<
    dyn Fn(
            String,
            crate::mobile_api::CompleteStageRequest,
        ) -> Result<crate::mobile_api::TaskActionResponse, String>
        + Send
        + Sync,
>;

#[cfg(test)]
pub(super) type TestRevisionRequester = Arc<
    dyn Fn(
            String,
            crate::mobile_api::RequestRevisionRequest,
        ) -> Result<crate::mobile_api::TaskActionResponse, String>
        + Send
        + Sync,
>;

#[cfg(test)]
pub(super) type TestTaskFileResolutionHook = Arc<dyn Fn() + Send + Sync>;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpInvokeResponse {
    pub status: u16,
    pub body: Option<serde_json::Value>,
    pub error: Option<String>,
}

pub(super) fn db_write_error(
    message_prefix: &str,
    err: rusqlite::Error,
) -> (axum::http::StatusCode, String) {
    match err {
        rusqlite::Error::QueryReturnedNoRows => (
            axum::http::StatusCode::NOT_FOUND,
            format!("{message_prefix}: not found"),
        ),
        err => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("{message_prefix}: {}", err),
        ),
    }
}

impl AppState {
    pub(crate) fn config(&self) -> &Config {
        &self.config
    }

    /// Shared handle for the daemon Exit watcher, so orchestrated kills
    /// performed through the HTTP actions are not misread as completions.
    pub fn session_replacements(&self) -> crate::session_replacements::SessionReplacements {
        self.session_replacements.clone()
    }

    pub(crate) fn terminal_attachments(&self) -> crate::terminal_attachments::TerminalAttachments {
        self.terminal_attachments.clone()
    }

    /// The sidecar owner. The inbound tunnel bridge holds this too: a relay
    /// tunnel arriving for a never-yet-used sidecar must start it rather than
    /// fail to connect to an unbound port.
    pub(crate) fn transfer_sidecar(
        &self,
    ) -> Arc<crate::transfer_sidecar::TransferSidecarSupervisor> {
        Arc::clone(&self.transfer_sidecar)
    }

    /// The transfer engine's durable work queue. Held here so an HTTP intent
    /// (push a task, approve or reject an incoming transfer) and the sidecar's
    /// own event reader append to the same queue the drain loop consumes.
    pub(crate) fn transfer_work(&self) -> Arc<crate::transfer_engine::queue::TransferWorkQueue> {
        Arc::clone(&self.transfer_work)
    }

    pub(super) fn cloud_transfer_proxies(
        &self,
    ) -> &crate::cloud_transfer_proxy::CloudTransferProxyState {
        &self.cloud_transfer_proxies
    }

    pub fn new(config: Config) -> Self {
        if let Err(err) = pairing::PairingStore::load(Path::new(&config.pairing_store_path)) {
            log::warn!(
                "failed to load pairing store {}: {}",
                config.pairing_store_path,
                err
            );
        }
        let local_task_events_token = config.task_events_token_path().and_then(|path| {
            match super::lan_trust::load_or_create_task_events_token(&path) {
                Ok(token) => Some(token),
                Err(error) => {
                    log::error!(
                        "failed to initialize local task-event credential {}: {error}",
                        path.display()
                    );
                    None
                }
            }
        });

        let (mobile_notification_tx, mobile_notification_rx) = mpsc::channel(16);
        let (desktop_relay_tx, desktop_relay_rx) = mpsc::channel(32);
        let transfer_work =
            crate::transfer_engine::queue::TransferWorkQueue::new(config.db_path.clone());
        let transfer_sidecar = Arc::new(crate::transfer_sidecar::TransferSidecarSupervisor::new(
            config.clone(),
            Arc::clone(&transfer_work),
        ));
        let repo_checkout_root = std::env::var("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join(".kanna")
            .join("repos");
        Self {
            config,
            local_task_events_token,
            transfer_sidecar,
            transfer_work,
            cloud_transfer_proxies: Arc::new(Mutex::new(HashMap::new())),
            preview_sessions: super::preview::PreviewSessions::default(),
            pairing_session: Arc::new(Mutex::new(None)),
            pairing_persistence_mutation: Arc::new(Mutex::new(())),
            #[cfg(debug_assertions)]
            e2e_lan_http_enabled: Arc::new(AtomicBool::new(true)),
            session_replacements: crate::session_replacements::SessionReplacements::default(),
            terminal_attachments: crate::terminal_attachments::TerminalAttachments::default(),
            companion_resources: crate::ksp::CompanionResources::default(),
            terminal_taps: crate::ksp::TerminalTapRegistry::default(),
            agent_histories: crate::ksp::AgentHistoryRegistry::default(),
            repo_definitions: Arc::new(crate::task_creator::RepoDefinitionsCache::default()),
            requested_task_operations: Arc::new(RequestedTaskOperations::default()),
            repo_checkouts: Arc::new(StdMutex::new(HashMap::new())),
            repo_checkout_root,
            known_singleton_owners: Arc::new(StdMutex::new(HashMap::new())),
            relay_reconnect: Arc::new(Notify::new()),
            anonymous_push_revocations_changed: Arc::new(Notify::new()),
            relay_desktop_routing_available: Arc::new(AtomicBool::new(false)),
            relay_desktop_routing_unavailable_reason: Arc::new(StdMutex::new(Some(
                "desktop relay has not connected".to_string(),
            ))),
            relay_desktop_routing_generation: Arc::new(AtomicU64::new(0)),
            desktop_relay_tx,
            desktop_relay_rx: Arc::new(StdMutex::new(Some(desktop_relay_rx))),
            aggregate_task_event_waits: Arc::new(StdMutex::new(Default::default())),
            relay_mobile_notifications_version: Arc::new(AtomicU64::new(0)),
            mobile_notification_tx,
            mobile_notification_rx: Arc::new(StdMutex::new(Some(mobile_notification_rx))),
            requested_task_mutations: Arc::new(RequestedTaskMutations::default()),
            state_changes: broadcast::channel(256).0,
            #[cfg(test)]
            task_creator: None,
            #[cfg(test)]
            merge_agent_runner: None,
            #[cfg(test)]
            task_input_sender: None,
            #[cfg(test)]
            task_closer: None,
            #[cfg(test)]
            stage_advancer: None,
            #[cfg(test)]
            stage_rerunner: None,
            #[cfg(test)]
            stage_completer: None,
            #[cfg(test)]
            revision_requester: None,
            #[cfg(test)]
            task_file_resolution_hook: None,
        }
    }

    pub async fn mobile_server_status(&self) -> crate::mobile_api::MobileServerStatus {
        crate::mobile_api::build_mobile_server_status(&self.config, None)
    }

    pub fn subscribe_state_changes(&self) -> broadcast::Receiver<ServerFrame> {
        self.state_changes.subscribe()
    }

    pub fn publish_state_changed(&self, scope: StateChangeScope) {
        let _ = self.state_changes.send(ServerFrame::StateChanged {
            scope,
            task_state: None,
        });
    }

    /// Publish a cheap task-only update. Failure to resolve a complete payload
    /// degrades to the coarse frame so clients retain snapshot correctness.
    pub fn publish_task_state_changed(&self, task_id: &str) {
        let task_state = crate::db::Db::open(&self.config.db_path)
            .and_then(|db| db.get_task_state_summary(task_id));
        let Ok(Some(summary)) = task_state else {
            self.publish_state_changed(StateChangeScope::Tasks);
            return;
        };
        let read_state = if summary.activity == "unread" {
            "unread"
        } else {
            "read"
        };
        let _ = self.state_changes.send(ServerFrame::StateChanged {
            scope: StateChangeScope::Tasks,
            task_state: Some(TaskStateChange {
                version: 1,
                task_id: summary.task_id,
                activity: summary.activity,
                activity_revision: summary.activity_revision,
                activity_changed_at: summary.activity_changed_at,
                unread_at: summary.unread_at,
                runtime_state: summary.runtime_state,
                read_state: read_state.to_string(),
                last_output_preview: summary.last_output_preview,
            }),
        });
    }

    pub fn request_cloud_relay_reconnect(&self) {
        self.relay_reconnect.notify_one();
    }

    pub async fn wait_for_cloud_relay_reconnect(&self) {
        self.relay_reconnect.notified().await;
    }

    pub(crate) async fn wait_for_anonymous_push_revocations(&self) {
        self.anonymous_push_revocations_changed.notified().await;
    }

    pub(crate) async fn remove_trusted_device(&self, device_id: &str) -> Result<bool, String> {
        let _mutation = self.pairing_persistence_mutation.lock().await;
        let path = Path::new(&self.config.pairing_store_path);
        let mut store = pairing::PairingStore::load(path)?;
        let removed = store.remove_trusted_device(&self.config.desktop_id, device_id);
        if removed {
            store.save(path)?;
            self.anonymous_push_revocations_changed.notify_one();
        }
        Ok(removed)
    }

    pub(crate) async fn pending_anonymous_push_revocations(
        &self,
    ) -> Result<Vec<pairing::PendingAnonymousPushRevocation>, String> {
        let _mutation = self.pairing_persistence_mutation.lock().await;
        Ok(
            pairing::PairingStore::load(Path::new(&self.config.pairing_store_path))?
                .pending_anonymous_push_revocations,
        )
    }

    pub(crate) async fn acknowledge_anonymous_push_revocation(
        &self,
        revocation: &pairing::PendingAnonymousPushRevocation,
    ) -> Result<(), String> {
        let _mutation = self.pairing_persistence_mutation.lock().await;
        let path = Path::new(&self.config.pairing_store_path);
        let mut store = pairing::PairingStore::load(path)?;
        if store.acknowledge_anonymous_push_revocation(revocation) {
            store.save(path)?;
        }
        Ok(())
    }

    pub(crate) fn set_desktop_routing_available(&self, available: bool) -> u64 {
        let generation = if available {
            self.relay_desktop_routing_generation
                .fetch_add(1, Ordering::AcqRel)
                .wrapping_add(1)
        } else {
            self.relay_desktop_routing_generation
                .load(Ordering::Acquire)
        };
        self.relay_desktop_routing_available
            .store(available, Ordering::Release);
        if available {
            *self
                .relay_desktop_routing_unavailable_reason
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        }
        generation
    }

    pub(crate) fn set_desktop_routing_unavailable(&self, reason: impl Into<String>) {
        *self
            .relay_desktop_routing_unavailable_reason
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(reason.into());
        self.relay_desktop_routing_available
            .store(false, Ordering::Release);
    }

    pub(crate) fn desktop_routing_unavailable_reason(&self) -> String {
        self.relay_desktop_routing_unavailable_reason
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .unwrap_or_else(|| "desktop relay routing is unavailable".to_string())
    }

    pub(crate) fn desktop_routing_available(&self) -> bool {
        self.relay_desktop_routing_available.load(Ordering::Acquire)
    }

    pub(crate) fn take_desktop_relay_requests(
        &self,
    ) -> Result<mpsc::Receiver<DesktopRelayRequest>, String> {
        self.desktop_relay_rx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
            .ok_or_else(|| "desktop relay request receiver already taken".to_string())
    }

    async fn send_desktop_relay_request(&self, request: DesktopRelayRequest) -> Result<(), String> {
        if !self.desktop_routing_available() {
            return Err(self.desktop_routing_unavailable_reason());
        }
        self.desktop_relay_tx
            .send(request)
            .await
            .map_err(|_| self.desktop_routing_unavailable_reason())
    }

    /// An acknowledgement barrier, not a second publisher or retry loop.
    /// Singleton arbitration must see closes already committed by this desktop.
    pub(crate) async fn publish_task_snapshot_now(&self) -> Result<(), String> {
        let (response, result) = oneshot::channel();
        let generation = self
            .relay_desktop_routing_generation
            .load(Ordering::Acquire);
        self.send_desktop_relay_request(DesktopRelayRequest::PublishTaskSnapshot {
            generation,
            response,
        })
        .await?;
        tokio::time::timeout(std::time::Duration::from_secs(30), result)
            .await
            .map_err(|_| "singleton close publication acknowledgement timed out".to_string())?
            .map_err(|_| "desktop relay disconnected before singleton publication".to_string())?
    }

    pub(crate) async fn list_active_relay_desktops(&self) -> Result<Vec<String>, String> {
        let (response, result) = oneshot::channel();
        let generation = self
            .relay_desktop_routing_generation
            .load(Ordering::Acquire);
        self.send_desktop_relay_request(DesktopRelayRequest::ListActive {
            generation,
            response,
        })
        .await?;
        tokio::time::timeout(std::time::Duration::from_secs(10), result)
            .await
            .map_err(|_| "desktop relay listing timed out".to_string())?
            .map_err(|_| "desktop relay disconnected".to_string())?
    }

    pub(crate) async fn list_relay_repo_singletons(
        &self,
        remote_url_hash: String,
        agent: String,
    ) -> Result<Vec<RemoteSingletonOwner>, String> {
        let (response, result) = oneshot::channel();
        let generation = self
            .relay_desktop_routing_generation
            .load(Ordering::Acquire);
        self.send_desktop_relay_request(DesktopRelayRequest::ListRepoSingletons {
            generation,
            remote_url_hash,
            agent,
            response,
        })
        .await?;
        tokio::time::timeout(std::time::Duration::from_secs(10), result)
            .await
            .map_err(|_| "repository singleton directory lookup timed out".to_string())?
            .map_err(|_| "desktop relay disconnected".to_string())?
    }

    pub(crate) async fn claim_relay_repo_singleton(
        &self,
        remote_url_hash: String,
        agent: String,
        task_id: String,
    ) -> Result<RemoteSingletonClaim, String> {
        let (response, result) = oneshot::channel();
        let generation = self
            .relay_desktop_routing_generation
            .load(Ordering::Acquire);
        self.send_desktop_relay_request(DesktopRelayRequest::ClaimRepoSingleton {
            generation,
            remote_url_hash,
            agent,
            task_id,
            response,
        })
        .await?;
        tokio::time::timeout(std::time::Duration::from_secs(10), result)
            .await
            .map_err(|_| "repository singleton ownership claim timed out".to_string())?
            .map_err(|_| "desktop relay disconnected".to_string())?
    }

    pub(crate) async fn release_relay_repo_singleton_reservation(
        &self,
        remote_url_hash: String,
        agent: String,
        task_id: String,
    ) -> Result<bool, String> {
        let (response, result) = oneshot::channel();
        let generation = self
            .relay_desktop_routing_generation
            .load(Ordering::Acquire);
        self.send_desktop_relay_request(DesktopRelayRequest::ReleaseRepoSingletonReservation {
            generation,
            remote_url_hash,
            agent,
            task_id,
            response,
        })
        .await?;
        tokio::time::timeout(std::time::Duration::from_secs(10), result)
            .await
            .map_err(|_| "repository singleton reservation release timed out".to_string())?
            .map_err(|_| "desktop relay disconnected".to_string())?
    }

    pub(crate) async fn invoke_relay_desktop(
        &self,
        desktop_id: String,
        method: String,
        path: String,
        body: serde_json::Value,
    ) -> Result<HttpInvokeResponse, String> {
        let (response, result) = oneshot::channel();
        let generation = self
            .relay_desktop_routing_generation
            .load(Ordering::Acquire);
        self.send_desktop_relay_request(DesktopRelayRequest::Invoke {
            generation,
            desktop_id,
            method,
            path,
            body,
            response,
        })
        .await?;
        // Remote task-event waits may legitimately occupy almost the MCP
        // client's entire 240-second wait window. Leave enough room for the
        // remote server to finish that request while still failing before the
        // MCP client's 300-second tools/call deadline.
        tokio::time::timeout(std::time::Duration::from_secs(270), result)
            .await
            .map_err(|_| "desktop relay invocation timed out".to_string())?
            .map_err(|_| "desktop relay disconnected".to_string())?
    }

    /// Retain the last proven owner set for a sibling. An absent desktop in a
    /// later active-desktop listing is not evidence that its open singleton
    /// disappeared; keeping this observation is what turns sleep/offline into
    /// an explicit refusal instead of permission to create a rival. A
    /// successful lookup replaces the observation, including with an empty
    /// set after the old singleton was closed.
    pub(crate) fn observe_singleton_owners(
        &self,
        remote_url_hash: &str,
        agent: &str,
        machine_id: &str,
        task_ids: Vec<String>,
    ) {
        let mut observations = self
            .known_singleton_owners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        observations
            .entry((remote_url_hash.to_string(), agent.to_string()))
            .or_default()
            .insert(machine_id.to_string(), task_ids);
    }

    /// Replace the complete relay-backed owner snapshot for this repository
    /// and agent. Unlike an active-desktop lookup, the durable directory can
    /// prove that a formerly observed offline owner has closed, so absence
    /// from a successful directory response must clear stale observations.
    pub(crate) fn replace_singleton_owners(
        &self,
        remote_url_hash: &str,
        agent: &str,
        owners: Vec<RemoteSingletonOwner>,
    ) {
        let mut by_machine = HashMap::<String, Vec<String>>::new();
        for owner in owners {
            by_machine
                .entry(owner.machine_id)
                .or_default()
                .push(owner.task_id);
        }
        let mut observations = self
            .known_singleton_owners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        observations.insert((remote_url_hash.to_string(), agent.to_string()), by_machine);
    }

    pub(crate) fn known_singleton_owners(
        &self,
        remote_url_hash: &str,
        agent: &str,
    ) -> Vec<(String, String)> {
        self.known_singleton_owners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&(remote_url_hash.to_string(), agent.to_string()))
            .into_iter()
            .flat_map(|owners| owners.iter())
            .flat_map(|(machine_id, task_ids)| {
                task_ids
                    .iter()
                    .map(move |task_id| (machine_id.clone(), task_id.clone()))
            })
            .collect()
    }

    pub(crate) fn set_mobile_notifications_available(&self, available: bool) {
        self.set_mobile_notifications_version(u64::from(available));
    }

    /// Record the relay's advertised `mobileNotifications.version` (`0` when
    /// the capability is absent or the session is gone).
    pub(crate) fn set_mobile_notifications_version(&self, version: u64) {
        self.relay_mobile_notifications_version
            .store(version, Ordering::Release);
    }

    pub(crate) fn mobile_notifications_available(&self) -> bool {
        self.relay_mobile_notifications_version
            .load(Ordering::Acquire)
            >= 1
    }

    /// Whether the live relay session supports the distinct registration
    /// probe message. The request is refused without this advertised contract.
    pub(crate) fn mobile_notification_probe_supported(&self) -> bool {
        self.relay_mobile_notifications_version
            .load(Ordering::Acquire)
            >= 2
    }

    pub(crate) fn take_mobile_notification_requests(
        &self,
    ) -> Result<mpsc::Receiver<MobileNotificationRequest>, String> {
        self.mobile_notification_rx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
            .ok_or_else(|| "mobile notification relay receiver already taken".to_string())
    }

    pub(super) async fn queue_mobile_notification(
        &self,
        notification: crate::relay_client::MobileNotificationPayload,
    ) -> Result<crate::relay_client::MobileNotificationDelivery, String> {
        if !self.mobile_notifications_available() {
            return Err("mobile notification relay is unavailable".to_string());
        }

        let (response, result) = oneshot::channel();
        let handoff = async {
            self.mobile_notification_tx
                .send(MobileNotificationRequest {
                    notification,
                    response,
                })
                .await
                .map_err(|_| "mobile notification relay is unavailable".to_string())?;
            result
                .await
                .map_err(|_| "mobile notification relay disconnected".to_string())?
        };
        tokio::time::timeout(std::time::Duration::from_secs(10), handoff)
            .await
            .map_err(|_| "mobile notification relay timed out".to_string())?
    }

    pub(super) fn begin_requested_task_creation(
        &self,
        task_id: &str,
    ) -> Option<RequestedTaskOperation> {
        self.begin_requested_task_operation(task_id)
    }

    /// Single-flight for one task's revision action. The budget check, the
    /// workspace preparation, and the round accounting must not interleave
    /// with another revision for the same task: two admitted requests would
    /// both start a revision and spend rounds past the configured cap, and an
    /// overlapping human reset would race an agent's claim. Shares the
    /// per-task operation key space with creation and abort, since those
    /// equally must not overlap a revision that replaces the task's session.
    pub(super) fn begin_requested_task_revision(
        &self,
        task_id: &str,
    ) -> Option<RequestedTaskOperation> {
        self.begin_requested_task_operation(task_id)
    }

    fn begin_requested_task_operation(&self, task_id: &str) -> Option<RequestedTaskOperation> {
        let mut flights = self
            .requested_task_operations
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !flights.insert(task_id.to_string()) {
            return None;
        }
        Some(RequestedTaskOperation {
            task_id: task_id.to_string(),
            operations: Arc::clone(&self.requested_task_operations),
        })
    }

    pub(super) async fn begin_requested_task_abort(&self, task_id: &str) -> RequestedTaskOperation {
        loop {
            let mut changed = Box::pin(self.requested_task_operations.changed.notified());
            changed.as_mut().enable();
            {
                let mut active = self
                    .requested_task_operations
                    .active
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if active.insert(task_id.to_string()) {
                    return RequestedTaskOperation {
                        task_id: task_id.to_string(),
                        operations: Arc::clone(&self.requested_task_operations),
                    };
                }
            }
            changed.await;
        }
    }

    pub(super) async fn begin_requested_stage_advance(
        &self,
        task_id: &str,
    ) -> Option<RequestedTaskMutation> {
        loop {
            let mut changed = Box::pin(self.requested_task_mutations.changed.notified());
            changed.as_mut().enable();
            {
                let mut active = self
                    .requested_task_mutations
                    .active
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match active.get(task_id) {
                    Some(RequestedTaskMutationKind::Advance) => return None,
                    Some(RequestedTaskMutationKind::Other) => {}
                    None => {
                        active.insert(task_id.to_string(), RequestedTaskMutationKind::Advance);
                        return Some(RequestedTaskMutation {
                            task_id: task_id.to_string(),
                            mutations: Arc::clone(&self.requested_task_mutations),
                        });
                    }
                }
            }
            changed.await;
        }
    }

    pub(super) async fn begin_requested_task_mutation(
        &self,
        task_id: &str,
    ) -> RequestedTaskMutation {
        loop {
            let mut changed = Box::pin(self.requested_task_mutations.changed.notified());
            changed.as_mut().enable();
            if let Some(mutation) = self.try_begin_requested_task_mutation(task_id) {
                return mutation;
            }
            changed.await;
        }
    }

    /// Non-blocking acquire for callers that must not park: the daemon event
    /// loop handles every task's exits, so waiting there for one task's
    /// in-flight mutation would stall the others. A caller that cannot take
    /// the guard stands down — whatever holds it owns the task's next session.
    pub(super) fn try_begin_requested_task_mutation(
        &self,
        task_id: &str,
    ) -> Option<RequestedTaskMutation> {
        let mut active = self
            .requested_task_mutations
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active.contains_key(task_id) {
            return None;
        }
        active.insert(task_id.to_string(), RequestedTaskMutationKind::Other);
        Some(RequestedTaskMutation {
            task_id: task_id.to_string(),
            mutations: Arc::clone(&self.requested_task_mutations),
        })
    }

    #[cfg(test)]
    pub(super) fn with_task_creator(config: Config, task_creator: TestTaskCreator) -> Self {
        let mut state = Self::new(config);
        state.task_creator = Some(task_creator);
        state
    }

    #[cfg(test)]
    pub(super) fn with_merge_agent_runner(
        config: Config,
        merge_agent_runner: TestMergeAgentRunner,
    ) -> Self {
        let mut state = Self::new(config);
        state.merge_agent_runner = Some(merge_agent_runner);
        state
    }

    #[cfg(test)]
    pub(super) fn with_task_input_sender(
        config: Config,
        task_input_sender: TestTaskInputSender,
    ) -> Self {
        let mut state = Self::new(config);
        state.task_input_sender = Some(task_input_sender);
        state
    }

    #[cfg(test)]
    pub(super) fn with_task_closer(config: Config, task_closer: TestTaskCloser) -> Self {
        let mut state = Self::new(config);
        state.task_closer = Some(task_closer);
        state
    }

    #[cfg(test)]
    pub(super) fn with_stage_advancer(config: Config, stage_advancer: TestStageAdvancer) -> Self {
        let mut state = Self::new(config);
        state.stage_advancer = Some(stage_advancer);
        state
    }

    #[cfg(test)]
    pub(super) fn with_stage_rerunner(config: Config, stage_rerunner: TestStageRerunner) -> Self {
        let mut state = Self::new(config);
        state.stage_rerunner = Some(stage_rerunner);
        state
    }

    #[cfg(test)]
    pub(super) fn with_stage_completer(
        config: Config,
        stage_completer: TestStageCompleter,
    ) -> Self {
        let mut state = Self::new(config);
        state.stage_completer = Some(stage_completer);
        state
    }

    #[cfg(test)]
    pub(super) fn with_revision_requester(
        config: Config,
        revision_requester: TestRevisionRequester,
    ) -> Self {
        let mut state = Self::new(config);
        state.revision_requester = Some(revision_requester);
        state
    }
}
