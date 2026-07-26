mod analytics;
mod backup;
mod blocking;
mod cloud_relay;
mod desktop;
#[cfg(debug_assertions)]
mod e2e_mobile_controls;
#[cfg(debug_assertions)]
mod e2e_sql;
mod ksp;
mod lan_trust;
mod operator_events;
mod pairing;
mod repo_commands;
mod repos;
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
mod task_files;
mod task_input;
mod task_logs;
mod task_ports;
mod tasks;
mod transfers;
mod window_workspace;

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

pub use state::{AppState, HttpInvokeResponse};

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

pub async fn serve(state: std::sync::Arc<AppState>) -> Result<(), String> {
    routes::serve(state).await
}
pub(crate) use task_input::{handle_task_terminal_state, try_submit_task_input, TaskInputError};
#[cfg(test)]
pub(crate) use test_support::test_router;
