use crate::config::Config;
use crate::pairing::{self, ActivePairingSession};
use kanna_agent_protocol::{ServerFrame, StateChangeScope};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
#[cfg(debug_assertions)]
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{broadcast, Mutex, Notify};

#[derive(Clone, Copy)]
pub(super) struct TunneledHttpInvoke;

#[derive(Clone)]
pub struct AppState {
    pub(super) config: Config,
    pub(super) pairing_session: Arc<Mutex<Option<ActivePairingSession>>>,
    #[cfg(debug_assertions)]
    pub(super) e2e_lan_http_enabled: Arc<AtomicBool>,
    pub(super) session_replacements: crate::session_replacements::SessionReplacements,
    pub(super) terminal_attachments: crate::terminal_attachments::TerminalAttachments,
    pub(super) repo_definitions: Arc<crate::task_creator::RepoDefinitionsCache>,
    requested_task_operations: Arc<RequestedTaskOperations>,
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

#[derive(Default)]
struct RequestedTaskOperations {
    active: StdMutex<HashSet<String>>,
    changed: Notify,
}

pub(super) struct RequestedTaskOperation {
    task_id: String,
    operations: Arc<RequestedTaskOperations>,
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

    pub fn new(config: Config) -> Self {
        if let Err(err) = pairing::PairingStore::load(Path::new(&config.pairing_store_path)) {
            log::warn!(
                "failed to load pairing store {}: {}",
                config.pairing_store_path,
                err
            );
        }

        Self {
            config,
            pairing_session: Arc::new(Mutex::new(None)),
            #[cfg(debug_assertions)]
            e2e_lan_http_enabled: Arc::new(AtomicBool::new(true)),
            session_replacements: crate::session_replacements::SessionReplacements::default(),
            terminal_attachments: crate::terminal_attachments::TerminalAttachments::default(),
            repo_definitions: Arc::new(crate::task_creator::RepoDefinitionsCache::default()),
            requested_task_operations: Arc::new(RequestedTaskOperations::default()),
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

    pub(super) fn begin_requested_task_creation(
        &self,
        task_id: &str,
    ) -> Option<RequestedTaskOperation> {
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
            let changed = self.requested_task_operations.changed.notified();
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
