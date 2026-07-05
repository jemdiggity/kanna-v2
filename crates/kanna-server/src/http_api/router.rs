use super::analytics::get_repo_analytics;
use super::desktop::list_desktops;
use super::ksp::ksp_stream;
use super::operator_events::post_operator_events;
use super::pairing::create_pairing_session;
use super::repos::{add_repo, dependent_tasks_exist, list_repo_tasks, list_repos, patch_repo};
use super::settings::{get_setting, put_setting};
use super::signal_agent::signal_agent;
use super::snapshot::get_snapshot;
use super::state::{AppState, HttpInvokeResponse};
use super::status::status;
use super::task_actions::{
    advance_stage, close_task, complete_stage, request_revision, rerun_stage, run_merge_agent,
    set_task_parent,
};
use super::task_blockers::{block_task, unblock_task};
use super::task_input::send_task_input;
use super::task_logs::task_logs;
use super::tasks::{create_task, get_task, list_recent_tasks, search_tasks, update_task};
use axum::body::Body;
use axum::http::Request;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;
use tower::ServiceExt;
use tower_http::cors::CorsLayer;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/status", get(status))
        .route("/v1/snapshot", get(get_snapshot))
        .route("/v1/settings/{key}", get(get_setting).put(put_setting))
        .route("/v1/operator-events", post(post_operator_events))
        .route("/v1/analytics/repos/{repo_id}", get(get_repo_analytics))
        .route("/v1/stream", get(ksp_stream))
        .route("/v1/desktops", get(list_desktops))
        .route("/v1/repos", get(list_repos).post(add_repo))
        .route("/v1/repos/{repo_id}", axum::routing::patch(patch_repo))
        .route("/v1/repos/{repo_id}/tasks", get(list_repo_tasks))
        .route(
            "/v1/repos/{repo_id}/agents/{agent}/signal",
            post(signal_agent),
        )
        .route("/v1/tasks/recent", get(list_recent_tasks))
        .route("/v1/tasks/search", get(search_tasks))
        .route("/v1/tasks", post(create_task))
        .route("/v1/tasks/{task_id}", get(get_task).patch(update_task))
        .route(
            "/v1/tasks/{task_id}/dependent-tasks-exist",
            get(dependent_tasks_exist),
        )
        .route("/v1/tasks/{task_id}/logs", get(task_logs))
        .route("/v1/tasks/{task_id}/input", post(send_task_input))
        .route("/v1/tasks/{task_id}/actions/block", post(block_task))
        .route("/v1/tasks/{task_id}/actions/unblock", post(unblock_task))
        .route(
            "/v1/tasks/{task_id}/actions/advance-stage",
            post(advance_stage),
        )
        .route("/v1/tasks/{task_id}/actions/rerun-stage", post(rerun_stage))
        .route(
            "/v1/tasks/{task_id}/actions/complete-stage",
            post(complete_stage),
        )
        .route(
            "/v1/tasks/{task_id}/actions/request-revision",
            post(request_revision),
        )
        .route(
            "/v1/tasks/{task_id}/actions/set-parent",
            post(set_task_parent),
        )
        .route("/v1/tasks/{task_id}/actions/close", post(close_task))
        .route(
            "/v1/tasks/{task_id}/actions/run-merge-agent",
            post(run_merge_agent),
        )
        .route("/v1/pairing/sessions", post(create_pairing_session))
        .layer(CorsLayer::permissive())
        .layer(axum::middleware::from_fn(log_error_responses))
        .with_state(state)
}

/// Log every error response with its body. Clients see the body too, but a
/// crashed or headless client leaves no trace — this is the server-side
/// record of what actually failed (request-revision once returned a bare 500
/// that nothing recorded).
async fn log_error_responses(
    request: Request<Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let response = next.run(request).await;
    let status = response.status();
    if !(status.is_client_error() || status.is_server_error()) {
        return response;
    }
    let (parts, body) = response.into_parts();
    match axum::body::to_bytes(body, usize::MAX).await {
        Ok(bytes) => {
            log::error!(
                "{method} {path} -> {status}: {}",
                String::from_utf8_lossy(&bytes)
            );
            axum::response::Response::from_parts(parts, Body::from(bytes))
        }
        Err(error) => {
            log::error!("{method} {path} -> {status}: failed to read error body: {error}");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read error response body: {error}"),
            )
                .into_response()
        }
    }
}

pub async fn dispatch_http_invoke(
    state: Arc<AppState>,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> HttpInvokeResponse {
    let method = match method.parse::<axum::http::Method>() {
        Ok(method) => method,
        Err(error) => {
            return HttpInvokeResponse {
                status: axum::http::StatusCode::BAD_REQUEST.as_u16(),
                body: None,
                error: Some(format!("invalid HTTP method: {error}")),
            };
        }
    };

    if !path.starts_with('/') {
        return HttpInvokeResponse {
            status: axum::http::StatusCode::BAD_REQUEST.as_u16(),
            body: None,
            error: Some("HTTP invoke path must start with /".to_string()),
        };
    }

    let body = if body.is_null() {
        Body::empty()
    } else {
        match serde_json::to_vec(&body) {
            Ok(bytes) => Body::from(bytes),
            Err(error) => {
                return HttpInvokeResponse {
                    status: axum::http::StatusCode::BAD_REQUEST.as_u16(),
                    body: None,
                    error: Some(format!("invalid HTTP invoke body: {error}")),
                };
            }
        }
    };

    let request = match Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(body)
    {
        Ok(request) => request,
        Err(error) => {
            return HttpInvokeResponse {
                status: axum::http::StatusCode::BAD_REQUEST.as_u16(),
                body: None,
                error: Some(format!("invalid HTTP invoke request: {error}")),
            };
        }
    };

    match router(state).oneshot(request).await {
        Ok(response) => response_to_http_invoke(response).await,
        Err(error) => HttpInvokeResponse {
            status: axum::http::StatusCode::INTERNAL_SERVER_ERROR.as_u16(),
            body: None,
            error: Some(format!("HTTP invoke dispatch failed: {error}")),
        },
    }
}

async fn response_to_http_invoke(response: axum::response::Response) -> HttpInvokeResponse {
    let status = response.status();
    let bytes = match axum::body::to_bytes(response.into_body(), usize::MAX).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return HttpInvokeResponse {
                status: axum::http::StatusCode::INTERNAL_SERVER_ERROR.as_u16(),
                body: None,
                error: Some(format!("failed to read HTTP invoke response: {error}")),
            };
        }
    };

    let body = if bytes.is_empty() {
        None
    } else {
        Some(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_else(|_| {
                serde_json::Value::String(String::from_utf8_lossy(&bytes).into_owned())
            }),
        )
    };
    let error = if status.is_success() {
        None
    } else {
        Some(match &body {
            Some(serde_json::Value::String(message)) => message.clone(),
            Some(value) => value.to_string(),
            None => status.to_string(),
        })
    };

    HttpInvokeResponse {
        status: status.as_u16(),
        body,
        error,
    }
}

pub async fn serve(state: Arc<AppState>) -> Result<(), String> {
    let bind_addr = format!("{}:{}", state.config.lan_host, state.config.lan_port);
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .map_err(|e| format!("failed to bind LAN API on {}: {}", bind_addr, e))?;
    log::info!("LAN API listening on {}", bind_addr);
    axum::serve(listener, router(state))
        .await
        .map_err(|e| format!("LAN API server failed: {}", e))
}
