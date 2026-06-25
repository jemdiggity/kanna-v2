use crate::config::Config;
use crate::pairing::{self, PairingSession};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct AppState {
    pub(super) config: Config,
    pub(super) pairing_session: Arc<Mutex<Option<PairingSession>>>,
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
    pub(super) stage_completer: Option<TestStageCompleter>,
    #[cfg(test)]
    pub(super) revision_requester: Option<TestRevisionRequester>,
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
            stage_completer: None,
            #[cfg(test)]
            revision_requester: None,
        }
    }

    pub async fn mobile_server_status(&self) -> crate::mobile_api::MobileServerStatus {
        let pairing_code = {
            let session = self.pairing_session.lock().await;
            pairing::active_pairing_code(session.as_ref())
        };
        crate::mobile_api::build_mobile_server_status(&self.config, pairing_code)
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
