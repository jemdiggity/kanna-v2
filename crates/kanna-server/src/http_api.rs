mod desktop;
mod ksp;
mod operator_events;
mod pairing;
mod repos;
mod settings;
#[path = "http_api/router.rs"]
mod routes;
mod signal_agent;
mod snapshot;
mod state;
mod status;
mod task_actions;
mod task_blockers;
mod task_input;
mod task_logs;
mod tasks;

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

pub async fn serve(state: std::sync::Arc<AppState>) -> Result<(), String> {
    routes::serve(state).await
}
pub(crate) use task_input::{handle_task_terminal_state, try_submit_task_input, TaskInputError};
#[cfg(test)]
pub(crate) use test_support::test_router;
