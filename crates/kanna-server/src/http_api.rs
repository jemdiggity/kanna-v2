mod analytics;
mod backup;
mod blocking;
mod cloud_desktops;
mod cloud_relay;
mod desktop;
#[cfg(debug_assertions)]
mod e2e_mobile_controls;
#[cfg(debug_assertions)]
mod e2e_sql;
mod ksp;
mod lan_trust;
mod mobile_notifications;
mod operator_events;
mod pairing;
mod preview;
mod repo_browser;
mod repo_commands;
mod repos;
mod resume_recovery;
#[path = "http_api/router.rs"]
mod routes;
pub(crate) mod settings;
mod signal_agent;
mod snapshot;
mod state;
mod status;
mod task_actions;
pub(crate) mod task_activity;
mod task_agent_session;
mod task_blockers;
mod task_diff;
mod task_events;
mod task_files;
mod task_input;
mod task_logs;
mod task_ports;
mod tasks;
mod transfer_sidecar;
mod transfers;
mod window_workspace;

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

pub use state::{AppState, HttpInvokeResponse};
pub(crate) use state::{
    DesktopRelayRequest, MobileNotificationRequest, RemoteSingletonClaim, RemoteSingletonOwner,
};

#[allow(dead_code)]
pub fn router(state: std::sync::Arc<AppState>) -> axum::Router {
    routes::router(state)
}

pub async fn dispatch_http_invoke(
    state: std::sync::Arc<AppState>,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> HttpInvokeResponse {
    routes::dispatch_http_invoke(state, method, path, body).await
}

pub(crate) async fn dispatch_authenticated_http_invoke(
    state: std::sync::Arc<AppState>,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> HttpInvokeResponse {
    routes::dispatch_authenticated_http_invoke(state, method, path, body).await
}

pub(crate) async fn dispatch_authenticated_relay_http_invoke(
    state: std::sync::Arc<AppState>,
    actor: String,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> HttpInvokeResponse {
    routes::dispatch_authenticated_relay_http_invoke(state, actor, method, path, body).await
}

pub async fn serve(state: std::sync::Arc<AppState>) -> Result<(), String> {
    routes::serve(state).await
}
/// In-process entry points the transfer engine calls.
///
/// The engine performs the same task lifecycle actions the LAN routes serve —
/// creating the destination task, closing the source once its import is
/// acknowledged — and must perform *those* actions rather than a second
/// implementation of them.
pub(crate) use task_actions::close_task_in_process;
pub(crate) use tasks::create_task_in_process;

pub(crate) use task_input::{
    handle_task_terminal_state, mark_task_session_interrupted,
    mark_task_session_interrupted_for_recovery, restore_task_run_for_live_session,
    try_submit_task_input, TaskInputError, INPUT_BLOCKED_INHERITED_DRAFT,
};

#[cfg(test)]
pub(crate) use test_support::{
    test_router, test_state_with_daemon_dir, test_state_with_daemon_dir_and_debounce,
    test_state_with_seed,
};
