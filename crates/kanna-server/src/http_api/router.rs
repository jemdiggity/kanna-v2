use super::analytics::get_repo_analytics;
use super::backup::create_backup;
use super::cloud_desktops::{invoke_cloud_desktop, list_cloud_desktops};
use super::cloud_relay::reconnect_cloud_relay;
use super::desktop::list_desktops;
#[cfg(debug_assertions)]
use super::e2e_mobile_controls::{gate_direct_lan_http, update_e2e_mobile_machine_controls};
#[cfg(debug_assertions)]
use super::e2e_sql::{execute_e2e_server_work, execute_e2e_sql};
use super::ksp::{ksp_stream, legacy_ksp_stream};
use super::lan_trust::{attach_trusted_lan_device, require_privileged_task_access};
use super::mobile_notifications::notify_mobile;
use super::operator_events::post_operator_events;
use super::pairing::{
    claim_pairing_session, create_pairing_session, reissue_push_pairing_certificate,
    remove_trusted_device,
};
use super::repo_browser::{list_task_directory, read_task_file_range};
use super::repo_commands::{list_repo_commands, run_repo_command};
use super::repos::{
    add_repo, dependent_tasks_exist, get_repo_agent_definition, get_repo_by_path,
    get_repo_checkout, get_repo_kanna_definitions, get_repo_workflow_definition,
    list_available_agent_providers, list_recent_repo_workflows, list_repo_agents, list_repo_tasks,
    list_repos, patch_repo, refresh_repo_origin, reorder_repos, start_repo_checkout,
};
use super::settings::{delete_setting, get_setting, put_cloud_transfer_identity, put_setting};
use super::signal_agent::{signal_agent, signal_merge_handoff};
use super::snapshot::get_snapshot;
use super::state::{AppState, AuthenticatedHttpInvoke, HttpInvokeResponse, TunneledHttpInvoke};
use super::status::status;
use super::task_actions::{
    abort_task_creation, advance_stage, close_task, complete_stage, pin_task, reopen_task,
    reorder_pinned_tasks, request_revision, rerun_stage, resume_task, run_merge_agent,
    set_task_parent, set_task_workflow, unpin_task,
};
use super::task_activity::{apply_runtime_status, mark_task_read};
use super::task_agent_session::put_task_agent_session;
use super::task_blockers::{block_task, unblock_task};
use super::task_diff::get_task_diff;
use super::task_events::wait_task_events;
use super::task_files::{get_task_file, resolve_task_file_mentions};
use super::task_input::send_task_input;
use super::task_logs::task_logs;
use super::task_ports::{claim_task_ports, release_task_ports};
use super::tasks::{
    create_task, get_task, get_task_children, get_task_inputs, list_closed_task_identities,
    list_recent_tasks, put_task, search_tasks, set_task_notify, update_task,
};
use super::transfer_sidecar::{
    clear_cloud_transfer_proxies, ensure_cloud_transfer_proxy, remove_cloud_transfer_proxy,
    run_transfer_control, wait_transfer_companion_events, wait_transfer_events,
};
use super::transfers::{
    approve_incoming_transfer, claim_pending_incoming_transfer, complete_task_transfer,
    fail_outgoing_transfer, fail_pending_incoming_transfer, get_active_outgoing_transfer,
    get_task_transfer, insert_task_transfer, insert_task_transfer_provenance,
    list_incoming_transfer_cleanup_candidates, list_pending_incoming_transfers,
    mark_incoming_transfer_awaiting_acknowledgment, mark_incoming_transfer_importing,
    mark_incoming_transfer_sidecar_cleanup_completed, push_task_to_peer, reject_incoming_transfer,
    reject_task_transfer, renew_incoming_transfer_claim, set_task_cloud_identity,
    update_task_transfer_payload,
};
use super::window_workspace::mutate_window_workspace;
use axum::body::Body;
use axum::http::Request;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use std::net::SocketAddr;
use std::sync::Arc;
use tower::ServiceExt;
use tower_http::cors::CorsLayer;

pub fn router(state: Arc<AppState>) -> Router {
    let router = Router::new()
        .route("/v1/status", get(status))
        .route("/v1/snapshot", get(get_snapshot))
        .route("/v1/backup", post(create_backup))
        .route(
            "/v1/cloud/relay/actions/reconnect",
            post(reconnect_cloud_relay),
        )
        .route("/v1/cloud/desktops", get(list_cloud_desktops))
        .route(
            "/v1/cloud/desktops/{desktop_id}/invoke",
            post(invoke_cloud_desktop),
        )
        .route(
            "/v1/settings/cloud-transfer-identity",
            axum::routing::put(put_cloud_transfer_identity),
        )
        .route(
            "/v1/settings/{key}",
            get(get_setting).put(put_setting).delete(delete_setting),
        )
        .route(
            "/v1/window-workspace/mutations",
            post(mutate_window_workspace),
        )
        .route("/v1/operator-events", post(post_operator_events))
        .route("/v1/mobile/notifications", post(notify_mobile))
        .route("/v1/analytics/repos/{repo_id}", get(get_repo_analytics))
        .route("/v1/stream", get(legacy_ksp_stream))
        .route("/v2/stream", get(ksp_stream))
        .route("/v1/desktops", get(list_desktops))
        .route("/v1/repos", get(list_repos).post(add_repo))
        .route("/v1/repo-checkouts", post(start_repo_checkout))
        .route("/v1/repo-checkouts/{operation_id}", get(get_repo_checkout))
        .route("/v1/repos/by-path", get(get_repo_by_path))
        .route("/v1/repos/actions/reorder", post(reorder_repos))
        .route("/v1/repos/{repo_id}", axum::routing::patch(patch_repo))
        .route("/v1/repos/{repo_id}/tasks", get(list_repo_tasks))
        .route("/v1/repos/{repo_id}/agents", get(list_repo_agents))
        .route("/v1/repos/{repo_id}/commands", get(list_repo_commands))
        .route(
            "/v1/repos/{repo_id}/commands/{command_id}/run",
            post(run_repo_command),
        )
        .route(
            "/v1/repos/{repo_id}/kanna-definitions",
            get(get_repo_kanna_definitions),
        )
        .route(
            "/v1/repos/{repo_id}/fetch-origin",
            post(refresh_repo_origin),
        )
        .route(
            "/v1/repos/{repo_id}/kanna-definitions/workflows/{workflow_name}",
            get(get_repo_workflow_definition),
        )
        .route(
            "/v1/repos/{repo_id}/kanna-definitions/pipelines/{workflow_name}",
            get(get_repo_workflow_definition),
        )
        .route(
            "/v1/repos/{repo_id}/kanna-definitions/agents/{agent_selector}",
            get(get_repo_agent_definition),
        )
        .route(
            "/v1/repos/{repo_id}/recent-workflows",
            get(list_recent_repo_workflows),
        )
        .route(
            "/v1/repos/{repo_id}/recent-pipelines",
            get(list_recent_repo_workflows),
        )
        .route(
            "/v1/repos/{repo_id}/agent-providers",
            get(list_available_agent_providers),
        )
        .route(
            "/v1/repos/{repo_id}/agents/{agent}/signal",
            post(signal_agent),
        )
        .route("/v1/task-events", get(wait_task_events))
        .route("/v1/tasks/recent", get(list_recent_tasks))
        .route("/v1/tasks/search", get(search_tasks))
        .route(
            "/v1/tasks/closed-identities",
            get(list_closed_task_identities),
        )
        .route("/v1/tasks", post(create_task))
        .route(
            "/v1/tasks/{task_id}",
            get(get_task).put(put_task).patch(update_task),
        )
        .route("/v1/tasks/{task_id}/children", get(get_task_children))
        .route("/v1/tasks/{task_id}/inputs", get(get_task_inputs))
        .route("/v1/tasks/{task_id}/files/content", get(get_task_file))
        .route("/v1/tasks/{task_id}/browse", get(list_task_directory))
        .route(
            "/v1/tasks/{task_id}/browse/content",
            get(read_task_file_range),
        )
        .route(
            "/v1/tasks/{task_id}/files/resolve-mentions",
            post(resolve_task_file_mentions),
        )
        .route("/v1/tasks/{task_id}/diff", get(get_task_diff))
        .route(
            "/v1/tasks/{task_id}/dependent-tasks-exist",
            get(dependent_tasks_exist),
        )
        .route("/v1/tasks/{task_id}/logs", get(task_logs))
        // Photo attachments ride in this route's JSON body, so it alone opts
        // out of axum's default 2 MiB limit. See
        // `task_input_attachments::MAX_TASK_INPUT_BODY_BYTES` for the budget.
        .route(
            "/v1/tasks/{task_id}/input",
            post(send_task_input).layer(axum::extract::DefaultBodyLimit::max(
                crate::task_input_attachments::MAX_TASK_INPUT_BODY_BYTES,
            )),
        )
        .route("/v1/tasks/{task_id}/actions/block", post(block_task))
        .route("/v1/tasks/{task_id}/actions/unblock", post(unblock_task))
        .route(
            "/v1/tasks/{task_id}/actions/runtime-status",
            post(apply_runtime_status),
        )
        .route(
            "/v1/tasks/{task_id}/actions/mark-read",
            post(mark_task_read),
        )
        .route(
            "/v1/tasks/{task_id}/actions/agent-session",
            post(put_task_agent_session),
        )
        .route(
            "/v1/tasks/{task_id}/actions/agent-session-id",
            post(put_task_agent_session),
        )
        .route(
            "/v1/tasks/{task_id}/actions/advance-stage",
            post(advance_stage),
        )
        .route("/v1/tasks/{task_id}/actions/rerun-stage", post(rerun_stage))
        .route("/v1/tasks/{task_id}/actions/resume", post(resume_task))
        .route(
            "/v1/tasks/{task_id}/actions/complete-stage",
            post(complete_stage),
        )
        .route(
            "/v1/tasks/{task_id}/actions/signal-merge-handoff",
            post(signal_merge_handoff),
        )
        .route(
            "/v1/tasks/{task_id}/actions/request-revision",
            post(request_revision),
        )
        .route(
            "/v1/tasks/{task_id}/actions/set-parent",
            post(set_task_parent),
        )
        .route(
            "/v1/tasks/{task_id}/actions/set-notify",
            post(set_task_notify),
        )
        .route(
            "/v1/tasks/{task_id}/actions/set-workflow",
            post(set_task_workflow),
        )
        .route(
            "/v1/tasks/{task_id}/actions/set-pipeline",
            post(set_task_workflow),
        )
        .route("/v1/tasks/{task_id}/actions/pin", post(pin_task))
        .route("/v1/tasks/{task_id}/actions/unpin", post(unpin_task))
        .route(
            "/v1/tasks/actions/reorder-pinned",
            post(reorder_pinned_tasks),
        )
        .route("/v1/tasks/{task_id}/actions/close", post(close_task))
        .route(
            "/v1/tasks/{task_id}/actions/abort-creation",
            post(abort_task_creation),
        )
        .route("/v1/tasks/{task_id}/actions/reopen", post(reopen_task))
        .route(
            "/v1/tasks/{task_id}/ports",
            post(claim_task_ports).delete(release_task_ports),
        )
        .route(
            "/v1/tasks/{task_id}/actions/run-merge-agent",
            post(run_merge_agent),
        )
        .route(
            "/v1/tasks/{task_id}/actions/cloud-task-identity",
            axum::routing::put(set_task_cloud_identity),
        )
        .route(
            "/v1/transfers/incoming/pending",
            get(list_pending_incoming_transfers),
        )
        .route(
            "/v1/transfers/incoming/cleanup-candidates",
            get(list_incoming_transfer_cleanup_candidates),
        )
        .route(
            "/v1/transfers/outgoing/active/{source_task_id}",
            get(get_active_outgoing_transfer),
        )
        .route("/v1/transfers", post(insert_task_transfer))
        .route(
            "/v1/tasks/{source_task_id}/actions/push-to-peer",
            post(push_task_to_peer),
        )
        .route(
            "/v1/transfers/{transfer_id}/actions/approve",
            post(approve_incoming_transfer),
        )
        .route(
            "/v1/transfers/{transfer_id}/actions/reject-incoming",
            post(reject_incoming_transfer),
        )
        .route(
            "/v1/transfers/provenance",
            post(insert_task_transfer_provenance),
        )
        .route("/v1/transfers/{transfer_id}", get(get_task_transfer))
        .route(
            "/v1/transfers/{transfer_id}/payload",
            axum::routing::put(update_task_transfer_payload),
        )
        .route(
            "/v1/transfers/{transfer_id}/actions/complete",
            post(complete_task_transfer),
        )
        .route(
            "/v1/transfers/{transfer_id}/actions/importing",
            post(mark_incoming_transfer_importing),
        )
        .route(
            "/v1/transfers/{transfer_id}/actions/awaiting-acknowledgment",
            post(mark_incoming_transfer_awaiting_acknowledgment),
        )
        .route(
            "/v1/transfers/{transfer_id}/actions/reject",
            post(reject_task_transfer),
        )
        .route(
            "/v1/transfers/{transfer_id}/actions/claim",
            post(claim_pending_incoming_transfer),
        )
        .route(
            "/v1/transfers/{transfer_id}/actions/renew-claim",
            post(renew_incoming_transfer_claim),
        )
        .route(
            "/v1/transfers/{transfer_id}/actions/fail",
            post(fail_pending_incoming_transfer),
        )
        .route(
            "/v1/transfers/{transfer_id}/actions/fail-outgoing",
            post(fail_outgoing_transfer),
        )
        .route(
            "/v1/transfers/{transfer_id}/actions/sidecar-cleanup-complete",
            post(mark_incoming_transfer_sidecar_cleanup_completed),
        )
        .route("/v1/transfers/sidecar/events", get(wait_transfer_events))
        .route(
            "/v1/transfers/sidecar/companion-events",
            get(wait_transfer_companion_events),
        )
        .route(
            "/v1/transfers/sidecar/control/{operation}",
            post(run_transfer_control),
        )
        .route(
            "/v1/transfers/cloud-proxies",
            post(ensure_cloud_transfer_proxy).delete(clear_cloud_transfer_proxies),
        )
        .route(
            "/v1/transfers/cloud-proxies/{peer_id}",
            axum::routing::delete(remove_cloud_transfer_proxy),
        )
        .route("/v1/pairing/sessions", post(create_pairing_session))
        .route("/v1/pairing/sessions/claim", post(claim_pairing_session))
        .route(
            "/v1/pairing/push-certificate",
            post(reissue_push_pairing_certificate),
        )
        .route(
            "/v1/pairing/trusted-devices/{device_id}",
            axum::routing::delete(remove_trusted_device),
        );

    #[cfg(debug_assertions)]
    let router = router
        .route("/v1/e2e/sql", post(execute_e2e_sql))
        .route("/v1/e2e/server-work", post(execute_e2e_server_work))
        .route(
            "/v1/e2e/mobile-machine-controls",
            post(update_e2e_mobile_machine_controls),
        )
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state),
            gate_direct_lan_http,
        ));

    router
        .layer(CorsLayer::permissive())
        .layer(axum::middleware::from_fn(log_error_responses))
        .layer(axum::middleware::from_fn(require_privileged_task_access))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state),
            attach_trusted_lan_device,
        ))
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
    dispatch_http_invoke_with_access(state, method, path, body, false, None).await
}

pub async fn dispatch_authenticated_http_invoke(
    state: Arc<AppState>,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> HttpInvokeResponse {
    dispatch_http_invoke_with_access(state, method, path, body, true, None).await
}

pub async fn dispatch_authenticated_relay_http_invoke(
    state: Arc<AppState>,
    actor: String,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> HttpInvokeResponse {
    dispatch_http_invoke_with_access(state, method, path, body, true, Some(actor)).await
}

async fn dispatch_http_invoke_with_access(
    state: Arc<AppState>,
    method: &str,
    path: &str,
    body: serde_json::Value,
    authenticated_file_access: bool,
    authenticated_human_actor: Option<String>,
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

    let has_json_body = !body.is_null();
    let body = if has_json_body {
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
    } else {
        Body::empty()
    };

    let mut request_builder = Request::builder().method(method).uri(path);
    if has_json_body {
        request_builder = request_builder.header("content-type", "application/json");
    }
    let mut request = match request_builder.body(body) {
        Ok(request) => request,
        Err(error) => {
            return HttpInvokeResponse {
                status: axum::http::StatusCode::BAD_REQUEST.as_u16(),
                body: None,
                error: Some(format!("invalid HTTP invoke request: {error}")),
            };
        }
    };
    // Preserve loopback identity for the debug-only remote E2E API while
    // explicitly marking every KSP/relay dispatch as tunneled. Privileged
    // desktop control routes reject that marker; the desktop command reaches
    // the server over its real loopback listener and has no marker.
    let invoke_peer = SocketAddr::from(([127, 0, 0, 1], 0));
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(invoke_peer));
    request.extensions_mut().insert(TunneledHttpInvoke);
    if authenticated_file_access {
        request.extensions_mut().insert(AuthenticatedHttpInvoke);
        request
            .extensions_mut()
            .insert(super::task_files::AuthenticatedTaskFileAccess);
    }
    let _ = authenticated_human_actor;

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
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .map_err(|e| format!("LAN API server failed: {}", e))
}
