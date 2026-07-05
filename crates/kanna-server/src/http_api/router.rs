use super::desktop::list_desktops;
use super::ksp::ksp_stream;
use super::pairing::create_pairing_session;
use super::repos::{add_repo, list_repo_tasks, list_repos};
use super::signal_agent::signal_agent;
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
use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;
use tower::ServiceExt;
use tower_http::cors::CorsLayer;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/status", get(status))
        .route("/v1/stream", get(ksp_stream))
        .route("/v1/desktops", get(list_desktops))
        .route("/v1/repos", get(list_repos).post(add_repo))
        .route("/v1/repos/{repo_id}/tasks", get(list_repo_tasks))
        .route(
            "/v1/repos/{repo_id}/agents/{agent}/signal",
            post(signal_agent),
        )
        .route("/v1/tasks/recent", get(list_recent_tasks))
        .route("/v1/tasks/search", get(search_tasks))
        .route("/v1/tasks", post(create_task))
        .route("/v1/tasks/{task_id}", get(get_task).patch(update_task))
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
        .with_state(state)
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
    let local_addr = format!("{}:{}", state.config.local_host, state.config.local_port);
    let lan_addr = format!("{}:{}", state.config.lan_host, state.config.lan_port);

    let local_listener = tokio::net::TcpListener::bind(&local_addr)
        .await
        .map_err(|e| format!("failed to bind local API on {}: {}", local_addr, e))?;
    log::info!("local API listening on {}", local_addr);

    let serve_local = axum::serve(local_listener, router(Arc::clone(&state)));
    if local_addr == lan_addr {
        return serve_local
            .await
            .map_err(|e| format!("local API server failed: {}", e));
    }

    let lan_listener = tokio::net::TcpListener::bind(&lan_addr)
        .await
        .map_err(|e| format!("failed to bind LAN API on {}: {}", lan_addr, e))?;
    log::info!("LAN API listening on {}", lan_addr);
    let serve_lan = axum::serve(lan_listener, router(state));

    tokio::select! {
        result = serve_local => result.map_err(|e| format!("local API server failed: {}", e)),
        result = serve_lan => result.map_err(|e| format!("LAN API server failed: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn temp_path(label: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "kanna-server-router-{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .to_string_lossy()
            .to_string()
    }

    #[tokio::test]
    async fn serve_binds_distinct_local_and_lan_listeners() {
        let local_port = free_port();
        let lan_port = free_port();
        let state = Arc::new(AppState::new(Config {
            relay_url: "".to_string(),
            device_token: "token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: temp_path("daemon"),
            db_path: temp_path("db.sqlite"),
            kanna_cli_path: None,
            desktop_id: "desktop-router-test".to_string(),
            desktop_secret: Some("secret".to_string()),
            desktop_name: "Router Test".to_string(),
            server_version: Some("test-version".to_string()),
            local_host: "127.0.0.1".to_string(),
            local_port,
            lan_host: "127.0.0.1".to_string(),
            lan_port,
            pairing_store_path: temp_path("pairings.json"),
        }));
        let server = tokio::spawn(serve(state));

        let local_url = format!("http://127.0.0.1:{local_port}/v1/status");
        let lan_url = format!("http://127.0.0.1:{lan_port}/v1/status");
        wait_for_ok(&local_url).await;
        wait_for_ok(&lan_url).await;

        server.abort();
    }

    async fn wait_for_ok(url: &str) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if reqwest::get(url)
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {url}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}
