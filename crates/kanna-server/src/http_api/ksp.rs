use super::state::AppState;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::State;
use std::sync::Arc;

pub(super) async fn ksp_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    ws.on_upgrade(move |socket| crate::ksp::handle_stream(socket, state))
}
