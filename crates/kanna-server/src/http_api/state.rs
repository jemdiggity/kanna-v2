use crate::config::Config;
use crate::pairing::{self, ActivePairingSession};
use kanna_agent_protocol::{ServerFrame, StateChangeScope};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, Notify};

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
    #[cfg(debug_assertions)]
    pub(super) e2e_lan_http_enabled: Arc<AtomicBool>,
    pub(super) session_replacements: crate::session_replacements::SessionReplacements,
    pub(super) terminal_attachments: crate::terminal_attachments::TerminalAttachments,
    transfer_sidecar: Arc<crate::transfer_sidecar::TransferSidecarSupervisor>,
    transfer_work: Arc<crate::transfer_engine::queue::TransferWorkQueue>,
    cloud_transfer_proxies: crate::cloud_transfer_proxy::CloudTransferProxyState,
    pub(crate) companion_resources: crate::ksp::CompanionResources,
    pub(crate) terminal_taps: crate::ksp::TerminalTapRegistry,
    pub(crate) agent_histories: crate::ksp::AgentHistoryRegistry,
    pub(super) repo_definitions: Arc<crate::task_creator::RepoDefinitionsCache>,
    requested_task_operations: Arc<RequestedTaskOperations>,
    relay_reconnect: Arc<Notify>,
    relay_desktop_routing_available: Arc<AtomicBool>,
    relay_desktop_routing_generation: Arc<AtomicU64>,
    desktop_relay_tx: mpsc::Sender<DesktopRelayRequest>,
    desktop_relay_rx: Arc<StdMutex<Option<mpsc::Receiver<DesktopRelayRequest>>>>,
    pub(super) aggregate_task_event_waits:
        Arc<StdMutex<crate::http_api::task_events::AggregateWaitRegistry>>,
    relay_mobile_notifications_available: Arc<AtomicBool>,
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

pub(crate) struct MobileNotificationRequest {
    pub notification: crate::relay_client::MobileNotificationPayload,
    pub response: oneshot::Sender<Result<crate::relay_client::MobileNotificationDelivery, String>>,
}

pub(crate) enum DesktopRelayRequest {
    ListActive {
        generation: u64,
        response: oneshot::Sender<Result<Vec<String>, String>>,
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
        Self {
            config,
            local_task_events_token,
            transfer_sidecar,
            transfer_work,
            cloud_transfer_proxies: Arc::new(Mutex::new(HashMap::new())),
            pairing_session: Arc::new(Mutex::new(None)),
            #[cfg(debug_assertions)]
            e2e_lan_http_enabled: Arc::new(AtomicBool::new(true)),
            session_replacements: crate::session_replacements::SessionReplacements::default(),
            terminal_attachments: crate::terminal_attachments::TerminalAttachments::default(),
            companion_resources: crate::ksp::CompanionResources::default(),
            terminal_taps: crate::ksp::TerminalTapRegistry::default(),
            agent_histories: crate::ksp::AgentHistoryRegistry::default(),
            repo_definitions: Arc::new(crate::task_creator::RepoDefinitionsCache::default()),
            requested_task_operations: Arc::new(RequestedTaskOperations::default()),
            relay_reconnect: Arc::new(Notify::new()),
            relay_desktop_routing_available: Arc::new(AtomicBool::new(false)),
            relay_desktop_routing_generation: Arc::new(AtomicU64::new(0)),
            desktop_relay_tx,
            desktop_relay_rx: Arc::new(StdMutex::new(Some(desktop_relay_rx))),
            aggregate_task_event_waits: Arc::new(StdMutex::new(Default::default())),
            relay_mobile_notifications_available: Arc::new(AtomicBool::new(false)),
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
        let _ = self.state_changes.send(ServerFrame::StateChanged { scope });
    }

    pub fn request_cloud_relay_reconnect(&self) {
        self.relay_reconnect.notify_one();
    }

    pub async fn wait_for_cloud_relay_reconnect(&self) {
        self.relay_reconnect.notified().await;
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
        generation
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
            return Err("desktop relay routing is unavailable".to_string());
        }
        self.desktop_relay_tx
            .send(request)
            .await
            .map_err(|_| "desktop relay routing is unavailable".to_string())
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

    pub(crate) fn set_mobile_notifications_available(&self, available: bool) {
        self.relay_mobile_notifications_available
            .store(available, Ordering::Release);
    }

    pub(crate) fn mobile_notifications_available(&self) -> bool {
        self.relay_mobile_notifications_available
            .load(Ordering::Acquire)
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
