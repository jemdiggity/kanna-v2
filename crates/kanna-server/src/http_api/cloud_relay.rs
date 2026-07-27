use super::lan_trust::PrivilegedTaskAccess;
use super::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use std::sync::Arc;

pub(super) async fn reconnect_cloud_relay(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
) -> StatusCode {
    state.request_cloud_relay_reconnect();
    StatusCode::NO_CONTENT
}
