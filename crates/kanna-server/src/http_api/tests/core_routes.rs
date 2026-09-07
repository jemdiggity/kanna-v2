use super::*;
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex};
use std::time::{Duration, Instant};

fn pairing_create_request(peer: [u8; 4]) -> Request<Body> {
    let mut request = Request::post("/v1/pairing/sessions")
        .body(Body::empty())
        .unwrap();
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            peer, 49152,
        ))));
    request
}

fn pairing_reissue_request(device_id: &str, device_secret: &str) -> Request<Body> {
    Request::post("/v1/pairing/push-certificate")
        .header("x-kanna-device-id", device_id)
        .header("x-kanna-device-secret", device_secret)
        .body(Body::empty())
        .unwrap()
}

fn pairing_remove_request(device_id: &str, peer: [u8; 4]) -> Request<Body> {
    let mut request = Request::delete(format!("/v1/pairing/trusted-devices/{device_id}"))
        .body(Body::empty())
        .unwrap();
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            peer, 49152,
        ))));
    request
}

fn direct_lan_request(method: axum::http::Method, path: &str) -> Request<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [192, 168, 1, 42],
            49152,
        ))));
    request
}

async fn serve_non_loopback_http_router(desktop_id: &str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
        .await
        .expect("bind non-loopback HTTP listener");
    let port = listener.local_addr().expect("listener address").port();
    let desktop_id = desktop_id.to_string();
    let server = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            super::test_router(&desktop_id, "HTTP Network Auth")
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    let lan_ip = if_addrs::get_if_addrs()
        .expect("enumerate network interfaces")
        .into_iter()
        .map(|interface| interface.ip())
        .find(|ip| ip.is_ipv4() && !ip.is_loopback())
        .expect("test host must expose a non-loopback IPv4 address");
    (format!("http://{lan_ip}:{port}"), server)
}

#[tokio::test]
async fn privileged_settings_and_reconnect_reject_real_unauthenticated_non_loopback_clients() {
    let (base_url, server) = serve_non_loopback_http_router("desktop-settings-network-auth").await;
    let client = reqwest::Client::new();
    let identity = serde_json::json!({
        "peerId": "attacker",
        "displayName": "Attacker",
        "publicKey": "attacker-key",
        "protocolVersion": 1,
        "acceptingTransfers": true,
    });

    for (response, expected) in [
        (
            client
                .put(format!("{base_url}/v1/settings/cloud-transfer-identity"))
                .json(&identity)
                .send()
                .await
                .unwrap(),
            reqwest::StatusCode::UNAUTHORIZED,
        ),
        (
            client
                .put(format!("{base_url}/v1/settings/cloud_transfer_identity_v1"))
                .json(&serde_json::json!({ "value": identity.to_string() }))
                .send()
                .await
                .unwrap(),
            reqwest::StatusCode::UNAUTHORIZED,
        ),
        (
            client
                .delete(format!("{base_url}/v1/settings/cloud_transfer_identity_v1"))
                .send()
                .await
                .unwrap(),
            reqwest::StatusCode::UNAUTHORIZED,
        ),
        (
            client
                .post(format!("{base_url}/v1/cloud/relay/actions/reconnect"))
                .send()
                .await
                .unwrap(),
            reqwest::StatusCode::UNAUTHORIZED,
        ),
        (
            client
                .get(format!("{base_url}/v1/cloud/desktops"))
                .send()
                .await
                .unwrap(),
            reqwest::StatusCode::UNAUTHORIZED,
        ),
        (
            client
                .post(format!(
                    "{base_url}/v1/cloud/desktops/desktop-target/invoke"
                ))
                .json(&serde_json::json!({
                    "method": "GET",
                    "path": "/v1/tasks/recent",
                    "body": null
                }))
                .send()
                .await
                .unwrap(),
            reqwest::StatusCode::UNAUTHORIZED,
        ),
    ] {
        assert_eq!(response.status(), expected);
    }
    server.abort();
}

#[tokio::test]
async fn generic_settings_routes_cannot_mutate_the_reserved_transfer_identity() {
    let app = super::test_router("desktop-reserved-setting", "Reserved Setting Mac");
    for request in [
        Request::put("/v1/settings/cloud_transfer_identity_v1")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"value":"forged"}"#))
            .unwrap(),
        Request::delete("/v1/settings/cloud_transfer_identity_v1")
            .body(Body::empty())
            .unwrap(),
    ] {
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn privileged_task_routes_reject_unauthenticated_non_loopback_clients() {
    let app = super::test_router("desktop-private-actions", "Private Actions Mac");

    for path in [
        "/v1/tasks/task-private/input",
        "/v1/tasks/task-private/actions/advance-stage",
        "/v1/tasks/task-private/actions/close",
    ] {
        let response = app
            .clone()
            .oneshot(direct_lan_request(axum::http::Method::POST, path))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "unauthenticated direct-LAN request reached {path}",
        );
    }
}

#[tokio::test]
async fn transfer_control_plane_rejects_unauthenticated_non_loopback_cors_reads_and_mutations() {
    let app =
        super::test_router_with_seed("desktop-private-transfers", "Private Transfers Mac", |db| {
            db.insert_test_task_transfer(
                "transfer-private",
                "incoming",
                "pending",
                Some(r#"{"secret":"transfer-payload"}"#),
            )
            .unwrap();
        });

    for (method, path) in [
        (axum::http::Method::GET, "/v1/transfers/incoming/pending"),
        (
            axum::http::Method::POST,
            "/v1/transfers/transfer-private/actions/reject",
        ),
    ] {
        let mut request = direct_lan_request(method, path);
        request.headers_mut().insert(
            axum::http::header::ORIGIN,
            axum::http::HeaderValue::from_static("https://hostile.example"),
        );
        let response = app.clone().oneshot(request).await.unwrap();
        // Refused at the browser/local-client boundary, before the route's own
        // extractor runs: a request carrying an `Origin` is a browser's, and a
        // browser must present the local control credential or a paired
        // device secret. See `http_api::lan_trust`.
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "unauthenticated cross-origin direct-LAN request reached {path}",
        );
    }

    let loopback_list = app
        .oneshot(
            Request::get("/v1/transfers/incoming/pending")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(loopback_list.status(), StatusCode::OK);
    let body = axum::body::to_bytes(loopback_list.into_body(), usize::MAX)
        .await
        .unwrap();
    let list: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(list["transfers"][0]["id"], "transfer-private");
    assert_eq!(list["transfers"][0]["status"], "pending");
}

#[tokio::test]
async fn stale_incoming_importer_cannot_fail_a_replacement_claim_owner() {
    let app = super::test_router_with_seed("desktop-claim-fence", "Claim Fence Mac", |db| {
        db.insert_test_task_transfer(
            "transfer-claim-fence",
            "incoming",
            "pending",
            Some(r#"{"task":{},"repo":{}}"#),
        )
        .unwrap();
    });
    for owner in ["owner-old", "owner-new"] {
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/transfers/transfer-claim-fence/actions/claim")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "ownerToken": owner,
                            "recovery": owner == "owner-new",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    let stale_failure = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers/transfer-claim-fence/actions/fail")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "reason": "old importer failed late",
                        "claimOwnerToken": "owner-old",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(stale_failure.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["updated"],
        false
    );

    let transfer = app
        .clone()
        .oneshot(
            Request::get("/v1/transfers/transfer-claim-fence")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(transfer.into_body(), usize::MAX)
        .await
        .unwrap();
    let transfer = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    assert_eq!(transfer["transfer"]["status"], "claimed");

    let replacement_renewal = app
        .oneshot(
            Request::post("/v1/transfers/transfer-claim-fence/actions/renew-claim")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "ownerToken": "owner-new" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(replacement_renewal.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["updated"],
        true
    );
}

#[tokio::test]
async fn privileged_task_access_preserves_paired_loopback_and_authenticated_tunnel_dispatch() {
    let state =
        super::test_state_with_seed("desktop-private-positive", "Private Positive Mac", |_| {});
    let pairing_path = std::path::PathBuf::from(&state.config().pairing_store_path);
    let mut pairing_store = crate::pairing::PairingStore::default();
    pairing_store.add_trusted_device(
        &state.config().desktop_id,
        "phone-1",
        "Kanna Mobile",
        &crate::pairing::hash_device_secret("lan-secret"),
    );
    pairing_store.save(&pairing_path).unwrap();
    let app = crate::http_api::router(Arc::clone(&state));

    let mut paired = direct_lan_request(axum::http::Method::POST, "/v1/tasks/task-private/input");
    paired.headers_mut().insert(
        "x-kanna-device-id",
        axum::http::HeaderValue::from_static("phone-1"),
    );
    paired.headers_mut().insert(
        "x-kanna-device-secret",
        axum::http::HeaderValue::from_static("lan-secret"),
    );
    let paired_status = app.clone().oneshot(paired).await.unwrap().status();
    assert_ne!(paired_status, StatusCode::UNAUTHORIZED);

    let mut loopback = Request::post("/v1/tasks/task-private/actions/close")
        .body(Body::empty())
        .unwrap();
    loopback
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            49152,
        ))));
    let loopback_status = app.oneshot(loopback).await.unwrap().status();
    assert_ne!(loopback_status, StatusCode::UNAUTHORIZED);

    let tunneled = crate::http_api::dispatch_authenticated_http_invoke(
        state,
        "POST",
        "/v1/tasks/task-private/actions/advance-stage",
        serde_json::json!({}),
    )
    .await;
    assert_ne!(tunneled.status, StatusCode::UNAUTHORIZED.as_u16());
    let _ = std::fs::remove_file(pairing_path);
}

#[tokio::test]
async fn status_advertises_lan_ksp_v2_only_to_paired_devices_and_authenticated_relay() {
    let state = super::test_state_with_seed("desktop-status-auth", "Status Auth Mac", |_| {});
    let pairing_path = std::path::PathBuf::from(&state.config().pairing_store_path);
    let mut pairing_store = crate::pairing::PairingStore::default();
    pairing_store.add_trusted_device(
        &state.config().desktop_id,
        "phone-1",
        "Kanna Mobile",
        &crate::pairing::hash_device_secret("lan-secret"),
    );
    pairing_store.save(&pairing_path).unwrap();
    let app = crate::http_api::router(Arc::clone(&state));

    for headers in [
        None,
        Some(("phone-stale", "old-secret")),
        Some(("phone-1", "wrong-secret")),
    ] {
        let mut request = direct_lan_request(axum::http::Method::GET, "/v1/status");
        if let Some((device_id, device_secret)) = headers {
            request.headers_mut().insert(
                "x-kanna-device-id",
                axum::http::HeaderValue::from_str(device_id).unwrap(),
            );
            request.headers_mut().insert(
                "x-kanna-device-secret",
                axum::http::HeaderValue::from_str(device_secret).unwrap(),
            );
        }
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let status: MobileServerStatus = from_slice(&body).unwrap();
        assert_eq!(status.state, "pairing_required");
        assert_eq!(status.ksp_stream_version, None);
    }

    let mut paired = direct_lan_request(axum::http::Method::GET, "/v1/status");
    paired.headers_mut().insert(
        "x-kanna-device-id",
        axum::http::HeaderValue::from_static("phone-1"),
    );
    paired.headers_mut().insert(
        "x-kanna-device-secret",
        axum::http::HeaderValue::from_static("lan-secret"),
    );
    let paired_response = app.oneshot(paired).await.unwrap();
    let body = axum::body::to_bytes(paired_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let paired_status: MobileServerStatus = from_slice(&body).unwrap();
    assert_eq!(paired_status.state, "running");
    assert_eq!(paired_status.ksp_stream_version, Some(2));

    let relay_response = crate::http_api::dispatch_authenticated_http_invoke(
        state,
        "GET",
        "/v1/status",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(relay_response.status, StatusCode::OK.as_u16());
    assert_eq!(relay_response.body.as_ref().unwrap()["state"], "running");
    assert_eq!(relay_response.body.as_ref().unwrap()["kspStreamVersion"], 2);
    let _ = std::fs::remove_file(pairing_path);
}

#[tokio::test]
async fn list_desktops_route_returns_configured_desktop() {
    let app = super::test_router("desktop-1", "Studio Mac");
    let response = app
        .oneshot(Request::get("/v1/desktops").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn machine_stats_route_returns_sane_local_native_stats() {
    let app = super::test_router_with_seed("desktop-stats", "Stats Mac", |db| {
        db.insert_test_repo("repo-stats", "Stats Repo").unwrap();
        db.insert_test_pipeline_item(
            "task-busy",
            "repo-stats",
            "exercise busy count",
            Some("Busy task"),
            "in progress",
            "2026-09-07 12:00:00",
        )
        .unwrap();
        db.update_pipeline_item_runtime_status("task-busy", "busy", None)
            .unwrap();
    });
    let response = app
        .oneshot(
            Request::get("/v1/machine-stats?localOnly=true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let stats: serde_json::Value = from_slice(&body).unwrap();
    let machine = &stats["machines"][0];
    assert_eq!(machine["machineId"], "desktop-stats");
    assert!(machine["cpuCoreCount"].as_u64().unwrap() >= 1);
    assert!(machine["memory"]["totalBytes"].as_u64().unwrap() > 0);
    assert!(machine["memory"]["usedBytes"].as_u64().unwrap() > 0);
    assert!(machine["loadAverages"]["one"].as_f64().unwrap() >= 0.0);
    assert!(machine["heavyProcesses"]["rustc"].is_number());
    assert_eq!(machine["busyTaskCount"], 1);
    assert_eq!(stats["machineErrors"], serde_json::json!([]));
}

#[tokio::test]
async fn machine_stats_route_aggregates_siblings_and_reports_peer_errors() {
    let state = super::test_state_with_seed("desktop-local", "Local Mac", |_| {});
    let mut requests = state.take_desktop_relay_requests().unwrap();
    state.set_desktop_routing_available(true);
    let responder = tokio::spawn(async move {
        let super::super::state::DesktopRelayRequest::ListActive { response, .. } =
            requests.recv().await.expect("active desktop request")
        else {
            panic!("expected active desktop request");
        };
        response
            .send(Ok(vec![
                "desktop-local".to_string(),
                "desktop-remote".to_string(),
                "desktop-offline".to_string(),
            ]))
            .unwrap();

        let super::super::state::DesktopRelayRequest::Invoke {
            desktop_id,
            path,
            response,
            ..
        } = requests.recv().await.expect("remote stats request")
        else {
            panic!("expected remote stats request");
        };
        assert_eq!(desktop_id, "desktop-remote");
        assert_eq!(path, "/v1/machine-stats?localOnly=true");
        response
            .send(Ok(crate::http_api::HttpInvokeResponse {
                status: 200,
                body: Some(serde_json::json!({
                    "machines": [{
                        "machineId": "desktop-remote",
                        "loadAverages": { "one": 1.0, "five": 2.0, "fifteen": 3.0 },
                        "cpuCoreCount": 8,
                        "memory": {
                            "totalBytes": 16000000000_u64,
                            "usedBytes": 8000000000_u64,
                            "freeBytes": 2000000000_u64,
                            "availableBytes": 8000000000_u64
                        },
                        "heavyProcessCount": 2,
                        "heavyProcesses": {
                            "bazel": 0, "cargo": 1, "nodeTestRunner": 0,
                            "rustc": 1, "vitest": 0, "xcodebuild": 0
                        },
                        "busyTaskCount": 1
                    }],
                    "machineErrors": []
                })),
                error: None,
            }))
            .unwrap();

        let super::super::state::DesktopRelayRequest::Invoke {
            desktop_id,
            response,
            ..
        } = requests.recv().await.expect("offline stats request")
        else {
            panic!("expected offline stats request");
        };
        assert_eq!(desktop_id, "desktop-offline");
        response.send(Err("peer unavailable".to_string())).unwrap();
    });

    let response = crate::http_api::router(state)
        .oneshot(
            Request::get("/v1/machine-stats")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "aggregate request failed"
    );
    responder.await.unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let stats: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(stats["machines"].as_array().unwrap().len(), 2);
    assert!(stats["machines"]
        .as_array()
        .unwrap()
        .iter()
        .any(|machine| machine["machineId"] == "desktop-remote"));
    assert_eq!(stats["machineErrors"][0]["machineId"], "desktop-offline");
    assert_eq!(stats["machineErrors"][0]["error"], "peer unavailable");
}

#[tokio::test]
async fn cloud_desktop_listing_keeps_local_machine_when_relay_is_unavailable() {
    let state = super::test_state_with_seed("desktop-local-only", "Local Mac", |_| {});
    state.set_desktop_routing_unavailable(
        "desktop relay closed with code 1013: connection capacity exceeded",
    );
    let app = crate::http_api::router(state);
    let mut request = Request::get("/v1/cloud/desktops")
        .body(Body::empty())
        .unwrap();
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            49152,
        ))));
    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let listing: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(listing["currentMachineId"], "desktop-local-only");
    assert_eq!(listing["relayAvailable"], false);
    assert_eq!(
        listing["error"],
        "desktop relay closed with code 1013: connection capacity exceeded"
    );
    assert_eq!(listing["machines"][0]["id"], "desktop-local-only");
    assert_eq!(listing["machines"][0]["isLocal"], true);
}

#[tokio::test]
async fn cloud_desktop_invoke_crosses_the_server_relay_queue() {
    let state = super::test_state_with_seed("desktop-source", "Source Mac", |_| {});
    let mut requests = state.take_desktop_relay_requests().unwrap();
    state.set_desktop_routing_available(true);
    let responder = tokio::spawn(async move {
        let request = requests.recv().await.expect("desktop relay request");
        let super::super::state::DesktopRelayRequest::Invoke {
            generation: _,
            desktop_id,
            method,
            path,
            body,
            response,
        } = request
        else {
            panic!("expected invoke request");
        };
        assert_eq!(desktop_id, "desktop-target");
        assert_eq!(method, "GET");
        assert_eq!(path, "/v1/tasks/recent");
        assert!(body.is_null());
        response
            .send(Ok(crate::http_api::HttpInvokeResponse {
                status: 200,
                body: Some(serde_json::json!([{ "id": "remote-task" }])),
                error: None,
            }))
            .unwrap();
    });
    let app = crate::http_api::router(state);
    let mut request = Request::post("/v1/cloud/desktops/desktop-target/invoke")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({
                "method": "GET",
                "path": "/v1/tasks/recent",
                "body": null,
            })
            .to_string(),
        ))
        .unwrap();
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            49152,
        ))));
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let invoked: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(invoked["status"], 200);
    assert_eq!(invoked["body"][0]["id"], "remote-task");
    responder.await.unwrap();
}

#[tokio::test]
async fn list_repos_route_returns_repo_summaries() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
    });

    let response = app
        .oneshot(Request::get("/v1/repos").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let repos: Vec<crate::mobile_api::RepoSummary> = from_slice(&body).unwrap();
    assert_eq!(
        repos,
        vec![
            crate::mobile_api::RepoSummary {
                id: "repo-1".to_string(),
                name: "Repo One".to_string(),
                remote_url_hash: None,
                remote_url: None,
            },
            crate::mobile_api::RepoSummary {
                id: "repo-2".to_string(),
                name: "Repo Two".to_string(),
                remote_url_hash: None,
                remote_url: None,
            },
        ]
    );
}

#[tokio::test]
async fn list_repos_omits_credential_bearing_remote_url() {
    let credential = "inventory-secret-token";
    let remote_url = format!("https://{credential}@example.test/private.git");
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-private", "Private Repo").unwrap();
        db.patch_repo(
            "repo-private",
            crate::db::RepoPatch {
                remote_url: Some(Some(&remote_url)),
                remote_url_hash: Some(Some("private-hash")),
                ..crate::db::RepoPatch::default()
            },
        )
        .unwrap();
    });

    let response = app
        .oneshot(Request::get("/v1/repos").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_text = String::from_utf8(body.to_vec()).unwrap();
    assert!(!body_text.contains(credential));
    let repos: serde_json::Value = from_slice(body_text.as_bytes()).unwrap();
    assert_eq!(repos[0]["remoteUrlHash"], "private-hash");
    assert!(repos[0].get("remoteUrl").is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn repo_agent_provider_route_stays_responsive_and_uses_workspace_local_executables() {
    use std::os::unix::fs::PermissionsExt;

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-provider-availability-{unique}"));
    init_test_git_repo(&repo_root);
    let provider_dir = repo_root.join(".kanna/provider-bin");
    std::fs::create_dir_all(&provider_dir).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "workspace": { "path": { "prepend": [".kanna/provider-bin"] } }
        })
        .to_string(),
    )
    .unwrap();
    let local_antigravity = provider_dir.join("agy");
    std::fs::write(&local_antigravity, "#!/bin/sh\nexit 0\n").unwrap();
    let mut permissions = std::fs::metadata(&local_antigravity).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&local_antigravity, permissions).unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna/config.json", ".kanna/provider-bin/agy"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "configure workspace-local provider"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    publish_test_origin_main(&repo_root);

    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
    });
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let started_tx = Arc::new(StdMutex::new(Some(started_tx)));
    let release = Arc::new((StdMutex::new(false), Condvar::new()));
    state.repo_definitions.set_before_load(Arc::new({
        let started_tx = Arc::clone(&started_tx);
        let release = Arc::clone(&release);
        move || {
            if let Some(started_tx) = started_tx.lock().unwrap().take() {
                let _ = started_tx.send(());
            }
            let (released, ready) = &*release;
            let mut released = released.lock().unwrap();
            while !*released {
                released = ready.wait(released).unwrap();
            }
        }
    }));

    // Only a hang-breaker: a lookup that blocks the current-thread runtime
    // inline parks every timer too, so nothing else could ever release the
    // hook. It is deliberately far longer than any assertion below, so a
    // loaded box can never have it rescue a passing run.
    let (watchdog_cancel_tx, watchdog_cancel_rx) = std::sync::mpsc::channel();
    let watchdog = std::thread::spawn({
        let release = Arc::clone(&release);
        move || {
            if watchdog_cancel_rx
                .recv_timeout(Duration::from_secs(30))
                .is_err()
            {
                let (released, ready) = &*release;
                *released.lock().unwrap() = true;
                ready.notify_all();
            }
        }
    });
    let request = tokio::spawn(
        super::router(state).oneshot(
            Request::get("/v1/repos/repo-1/agent-providers")
                .body(Body::empty())
                .unwrap(),
        ),
    );
    tokio::time::timeout(Duration::from_secs(10), started_rx)
        .await
        .expect("provider route should resolve definitions through the shared cache")
        .unwrap();
    // The load-bearing check is a happens-before, not a wall-clock budget: the
    // loader hook is parked in its condvar right now, so whatever delivered
    // `started_rx` was not the thread running it. A lookup that ran inline on
    // the runtime could only reach this line after the watchdog released the
    // hook, which this reads directly instead of inferring from elapsed time.
    let hook_still_parked = !*release.0.lock().unwrap();
    let runtime_stayed_responsive = hook_still_parked
        && tokio::time::timeout(
            // A blocked runtime never fires this timer at all, so the ceiling
            // only has to be finite — 5s is orders of magnitude above the
            // scheduler noise a loaded box adds to a 1ms sleep.
            Duration::from_secs(5),
            tokio::time::sleep(Duration::from_millis(1)),
        )
        .await
        .is_ok();
    let (released, ready) = &*release;
    *released.lock().unwrap() = true;
    ready.notify_all();

    let response = request.await.unwrap().unwrap();
    watchdog_cancel_tx.send(()).unwrap();
    watchdog.join().unwrap();

    assert!(
        runtime_stayed_responsive,
        "provider definition lookup blocked the async runtime"
    );
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = from_slice(&body).unwrap();
    assert!(json["providers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|provider| {
            provider["id"] == "antigravity"
                && provider["executable"] == local_antigravity.to_string_lossy().as_ref()
        }));

    let _ = std::fs::remove_dir_all(repo_root);
}

#[tokio::test]
async fn snapshot_route_returns_ui_hydration_payload() {
    let visible_worktree = std::env::temp_dir().join(format!(
        "kanna-snapshot-visible-worktree-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&visible_worktree);
    std::fs::create_dir_all(&visible_worktree).unwrap();
    let visible_worktree = visible_worktree.to_string_lossy().to_string();
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
        db.insert_test_pipeline_item(
            "task-visible",
            "repo-1",
            "visible prompt",
            Some("Visible Task"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-blocker",
            "repo-1",
            "blocker prompt",
            Some("Blocker Task"),
            "review",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-closed",
            "repo-1",
            "closed prompt",
            Some("Closed Task"),
            "done",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.close_pipeline_item("task-closed").unwrap();
        db.insert_task_blocker("task-visible", "task-blocker")
            .unwrap();
        db.insert_task_blocker("task-visible", "task-closed")
            .unwrap();
        db.upsert_worktree(
            "wt-task-visible",
            "task-visible",
            &visible_worktree,
            "branch-task-visible",
        )
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-post",
            task_id: "task-visible",
            stage: "in progress",
            kind: "post",
            agent: Some("commit"),
            agent_provider: Some("claude"),
            model: None,
            effort: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-visible"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
        db.set_test_setting("ideCommand", "zed").unwrap();
    });

    let response = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot: serde_json::Value = from_slice(&body).unwrap();

    assert_eq!(snapshot["entries"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["entries"][0]["repo"]["id"], "repo-1");
    assert_eq!(snapshot["entries"][0]["items"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["entries"][0]["items"][0]["id"], "task-visible");
    assert_eq!(snapshot["entries"][0]["items"][0]["has_running_post"], 1);
    assert_eq!(snapshot["entries"][0]["items"][1]["id"], "task-blocker");
    assert_eq!(
        snapshot["taskBlockers"],
        serde_json::json!([
            { "blocked_item_id": "task-visible", "blocker_item_id": "task-blocker" },
            { "blocked_item_id": "task-visible", "blocker_item_id": "task-closed" }
        ])
    );
    assert_eq!(
        snapshot["blockerTaskStates"]["task-blocker"],
        serde_json::json!({
            "closed_at": null,
            "stage": "review",
            "pr_url": null
        })
    );
    assert!(snapshot["blockerTaskStates"]["task-closed"]["closed_at"]
        .as_str()
        .is_some());
    assert_eq!(
        snapshot["blockerTaskStates"]["task-closed"]["stage"],
        "done"
    );
    assert_eq!(
        snapshot["worktreePaths"],
        serde_json::json!({ "task-visible": visible_worktree.clone() })
    );
    assert_eq!(snapshot["settings"]["ideCommand"], "zed");

    let _ = std::fs::remove_dir_all(visible_worktree);
}

#[tokio::test]
async fn backup_route_creates_valid_snapshot_while_writes_continue() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
    });
    let db_path = state.config.db_path.clone();
    let seed_conn = Connection::open(&db_path).unwrap();
    seed_conn
        .execute_batch(
            r#"
                CREATE TABLE backup_probe (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  note TEXT NOT NULL
                );
                INSERT INTO backup_probe (note) VALUES ('seed');
            "#,
        )
        .unwrap();
    drop(seed_conn);
    let app = super::router(state);
    let stop = Arc::new(AtomicBool::new(false));
    let writer_stop = Arc::clone(&stop);
    let writer_db_path = db_path.clone();
    let writer = std::thread::spawn(move || {
        let conn = Connection::open(writer_db_path).unwrap();
        conn.busy_timeout(std::time::Duration::from_millis(10_000))
            .unwrap();
        conn.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
        let mut i = 0;
        while !writer_stop.load(Ordering::Relaxed) {
            let _ = conn.execute(
                "INSERT INTO backup_probe (note) VALUES (?1)",
                [format!("live-{i}")],
            );
            i += 1;
        }
    });

    let response = app
        .oneshot(
            Request::post("/v1/backup")
                .header("content-type", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    stop.store(true, Ordering::Relaxed);
    writer.join().unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: serde_json::Value = from_slice(&body).unwrap();
    let backup_path = payload["backupPath"].as_str().expect("backup path");

    let backup = Connection::open(backup_path).expect("open backup");
    let quick_check: String = backup
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .expect("quick check backup");
    assert_eq!(quick_check, "ok");
    let seed_count: i64 = backup
        .query_row(
            "SELECT COUNT(*) FROM backup_probe WHERE note = 'seed'",
            [],
            |row| row.get(0),
        )
        .expect("seed row copied");
    assert_eq!(seed_count, 1);

    let _ = std::fs::remove_file(backup_path);
    let _ = std::fs::remove_file(db_path);
}

#[tokio::test]
async fn snapshot_route_records_initialized_tasks_whose_worktree_is_missing() {
    let missing_worktree =
        std::env::temp_dir().join(format!("kanna-missing-worktree-{}", std::process::id()));
    let missing_worktree = missing_worktree.to_string_lossy().to_string();
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-orphan",
            "repo-1",
            "Orphaned task",
            Some("Orphaned Task"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.upsert_worktree(
            "wt-task-orphan",
            "task-orphan",
            &missing_worktree,
            "branch-task-orphan",
        )
        .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let response = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(snapshot["entries"][0]["items"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["entries"][0]["items"][0]["id"], "task-orphan");
    assert_eq!(snapshot["entries"][0]["items"][0]["activity"], "unread");
    assert_eq!(snapshot["worktreePaths"], serde_json::json!({}));

    let db = Db::open(&db_path).unwrap();
    let item = db.get_pipeline_item("task-orphan").unwrap().unwrap();
    assert!(item.closed_at.is_none());
    assert_eq!(item.activity.as_deref(), Some("unread"));
    let runs = db.list_stage_runs_for_task("task-orphan").unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "failed");
    assert!(runs[0]
        .result
        .as_deref()
        .unwrap_or_default()
        .contains("task workspace missing"));
}

#[tokio::test]
async fn recent_tasks_route_keeps_dormant_tasks_without_worktree_rows() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-dormant",
            "repo-1",
            "Wait for blocker",
            Some("Dormant Task"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/recent")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "task-dormant");
}

#[tokio::test]
async fn dependent_tasks_exist_route_detects_blockers_and_base_refs_for_task() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "blocker-1",
            "repo-1",
            "blocker prompt",
            Some("Blocker Task"),
            "pr",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_branch("blocker-1", "feature/parent")
            .unwrap();
        db.update_test_pipeline_item_pr_url("blocker-1", "https://github.com/acme/repo/pull/7")
            .unwrap();
        db.insert_test_pipeline_item(
            "dependent-blocked",
            "repo-1",
            "dependent prompt",
            Some("Dependent Blocked"),
            "blocked",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "dependent-started",
            "repo-1",
            "started prompt",
            Some("Dependent Started"),
            "in progress",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_base_ref("dependent-started", "origin/feature/parent")
            .unwrap();
        db.insert_task_blocker("dependent-blocked", "blocker-1")
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/blocker-1/dependent-tasks-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: serde_json::Value = from_slice(&body).unwrap();

    assert_eq!(payload["exists"], true);
    assert_eq!(
        payload["dependentTasks"],
        serde_json::json!([
            {
                "taskId": "dependent-blocked",
                "title": "Dependent Blocked",
                "branch": "branch-dependent-blocked",
                "baseRef": null,
                "reason": "task_blocker"
            },
            {
                "taskId": "dependent-started",
                "title": "Dependent Started",
                "branch": "branch-dependent-started",
                "baseRef": "origin/feature/parent",
                "reason": "base_ref"
            }
        ])
    );
}

#[tokio::test]
async fn dependent_tasks_exist_route_returns_false_for_task_without_dependents() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "standalone prompt",
            Some("Standalone"),
            "pr",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_branch("task-1", "feature/standalone")
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-1/dependent-tasks-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: serde_json::Value = from_slice(&body).unwrap();

    assert_eq!(payload["exists"], false);
    assert_eq!(payload["dependentTasks"], serde_json::json!([]));
}

#[tokio::test]
async fn settings_routes_get_and_put_setting_values() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.set_test_setting("ideCommand", "code").unwrap();
    });

    let initial = app
        .clone()
        .oneshot(
            Request::get("/v1/settings/ideCommand")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(initial.status(), StatusCode::OK);
    let initial_body = axum::body::to_bytes(initial.into_body(), usize::MAX)
        .await
        .unwrap();
    let initial_json: serde_json::Value = from_slice(&initial_body).unwrap();
    assert_eq!(
        initial_json,
        serde_json::json!({ "key": "ideCommand", "value": "code" })
    );

    let updated = app
        .clone()
        .oneshot(
            Request::put("/v1/settings/ideCommand")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "value": "zed" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let updated_body = axum::body::to_bytes(updated.into_body(), usize::MAX)
        .await
        .unwrap();
    let updated_json: serde_json::Value = from_slice(&updated_body).unwrap();
    assert_eq!(
        updated_json,
        serde_json::json!({ "key": "ideCommand", "value": "zed" })
    );

    let final_response = app
        .clone()
        .oneshot(
            Request::get("/v1/settings/ideCommand")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let final_body = axum::body::to_bytes(final_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let final_json: serde_json::Value = from_slice(&final_body).unwrap();
    assert_eq!(final_json["value"], "zed");

    let deleted = app
        .clone()
        .oneshot(
            Request::delete("/v1/settings/ideCommand")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);

    let missing = app
        .oneshot(
            Request::get("/v1/settings/ideCommand")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cloud_transfer_identity_route_persists_canonical_json_setting() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |_| {});
    let identity = serde_json::json!({
        "peerId": "peer-a",
        "displayName": "Studio Mac",
        "publicKey": "base64-key",
        "protocolVersion": 1,
        "acceptingTransfers": true,
    });

    let response = app
        .clone()
        .oneshot({
            let mut request = Request::put("/v1/settings/cloud-transfer-identity")
                .header("content-type", "application/json")
                .body(Body::from(identity.to_string()))
                .unwrap();
            request.extensions_mut().insert(axum::extract::ConnectInfo(
                std::net::SocketAddr::from(([127, 0, 0, 1], 49152)),
            ));
            request
        })
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let stored = app
        .oneshot(
            Request::get("/v1/settings/cloud_transfer_identity_v1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stored.status(), StatusCode::OK);
    let body = axum::body::to_bytes(stored.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(payload["key"], "cloud_transfer_identity_v1");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(payload["value"].as_str().unwrap()).unwrap(),
        identity,
    );
}

#[tokio::test]
async fn window_workspace_mutations_do_not_resurrect_a_concurrently_removed_window() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.set_test_setting(
            "window_workspace_v1",
            &serde_json::json!({
                "windows": [
                    {
                        "windowId": "main",
                        "selectedRepoId": null,
                        "selectedItemId": null,
                        "sidebarHidden": false,
                        "sidebarWidth": 260,
                        "order": 0
                    },
                    {
                        "windowId": "window-2",
                        "selectedRepoId": "repo-old",
                        "selectedItemId": null,
                        "sidebarHidden": false,
                        "sidebarWidth": 260,
                        "order": 1
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();
    });

    let update_selection = app.clone().oneshot(
        Request::post("/v1/window-workspace/mutations")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "operation": "updateSelection",
                    "windowId": "window-2",
                    "selectedRepoId": "repo-new",
                    "selectedItemId": "task-new"
                })
                .to_string(),
            ))
            .unwrap(),
    );
    let remove_main = app.clone().oneshot(
        Request::post("/v1/window-workspace/mutations")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "operation": "remove",
                    "windowId": "main",
                    "observedWindowIds": ["main", "window-2"],
                    "liveWindowIds": ["main", "window-2"]
                })
                .to_string(),
            ))
            .unwrap(),
    );

    let (updated, removed) = tokio::join!(update_selection, remove_main);
    assert_eq!(updated.unwrap().status(), StatusCode::OK);
    assert_eq!(removed.unwrap().status(), StatusCode::OK);

    let final_response = app
        .oneshot(
            Request::get("/v1/settings/window_workspace_v1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let final_body = axum::body::to_bytes(final_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let final_json: serde_json::Value = from_slice(&final_body).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(final_json["value"].as_str().unwrap()).unwrap();

    assert_eq!(snapshot["windows"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["windows"][0]["windowId"], "window-2");
    assert_eq!(snapshot["windows"][0]["selectedRepoId"], "repo-new");
    assert_eq!(snapshot["windows"][0]["selectedItemId"], "task-new");
    assert_eq!(snapshot["windows"][0]["order"], 0);
}

#[tokio::test]
async fn operator_events_route_inserts_batched_events() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::post("/v1/operator-events")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "events": [
                            {
                                "eventType": "task_selected",
                                "workflowItemId": "task-1",
                                "repoId": "repo-1"
                            },
                            {
                                "eventType": "app_blur",
                                "pipelineItemId": null,
                                "repoId": null
                            }
                        ]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(json, serde_json::json!({ "inserted": 2 }));
}

#[tokio::test]
async fn analytics_route_returns_repo_metrics() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt one",
            Some("Task One"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-2",
            "repo-1",
            "prompt two",
            Some("Task Two"),
            "in progress",
            "2026-04-18 08:00:00",
        )
        .unwrap();
        db.set_test_pipeline_item_closed_at("task-1", "2026-04-19 08:00:00")
            .unwrap();
        db.insert_test_activity_log("task-1", "working", 30)
            .unwrap();
        db.insert_test_activity_log("task-1", "idle", 60).unwrap();
        db.insert_test_operator_event(
            "task_selected",
            Some("task-1"),
            Some("repo-1"),
            "2026-04-17 08:05:00",
        )
        .unwrap();
        db.insert_test_operator_event(
            "task_selected",
            Some("task-2"),
            Some("repo-1"),
            "2026-04-17 08:07:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/analytics/repos/repo-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(json["hasData"], true);
    assert_eq!(json["taskBuckets"].as_array().unwrap().len(), 1);
    assert_eq!(json["taskBuckets"][0]["created"], 2);
    assert_eq!(json["taskBuckets"][0]["closed"], 1);
    assert_eq!(json["avgTimeInState"]["working"], 30.0);
    assert_eq!(json["avgTimeInState"]["idle"], 60.0);
    assert_eq!(json["hasOperatorData"], true);
    assert!(json["operatorMetrics"]["switchesPerHour"].as_f64().unwrap() > 0.0);
}

#[tokio::test]
async fn patch_repo_route_updates_remote_metadata_and_hidden_state() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
    });

    let response = app
        .clone()
        .oneshot(
            Request::patch("/v1/repos/repo-1")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "remoteUrl": "git@github.com:kanna/repo-one.git",
                        "remoteUrlHash": "hash-1",
                        "hidden": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let snapshot_response = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = axum::body::to_bytes(snapshot_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(snapshot["entries"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn reorder_repos_persists_remote_only_positions_and_reports_unknown_ids() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
        db.patch_repo(
            "repo-1",
            crate::db::RepoPatch {
                remote_url_hash: Some(Some("hash-local")),
                ..crate::db::RepoPatch::default()
            },
        )
        .unwrap();
    });

    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/repos/actions/reorder")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "orderedRepos": [
                            { "id": "cloud:remote", "remoteUrlHash": "hash-remote" },
                            { "id": "repo-1", "remoteUrlHash": "hash-local" },
                            { "id": "unknown-without-identity", "remoteUrlHash": null },
                            { "id": "repo-2", "remoteUrlHash": null }
                        ]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let result: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(result["updated"], 3);
    assert_eq!(
        result["updatedIds"],
        serde_json::json!(["cloud:remote", "repo-1", "repo-2"])
    );
    assert_eq!(
        result["notPersistedIds"],
        serde_json::json!(["unknown-without-identity"])
    );

    let snapshot_response = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = axum::body::to_bytes(snapshot_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(snapshot["repoSidebarOrder"]["hash-remote"], 0);
    assert_eq!(snapshot["repoSidebarOrder"]["hash-local"], 1);
    assert_eq!(snapshot["entries"][0]["repo"]["id"], "repo-1");
    assert_eq!(snapshot["entries"][0]["repo"]["sort_order"], 1);
    assert_eq!(snapshot["entries"][1]["repo"]["id"], "repo-2");
    assert_eq!(snapshot["entries"][1]["repo"]["sort_order"], 3);
}

#[tokio::test]
async fn patch_repo_route_updates_default_branch_without_reregistering() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "keep this task",
            Some("Existing Task"),
            "in progress",
            "2026-09-03 08:00:00",
        )
        .unwrap();
    });

    let response = app
        .clone()
        .oneshot(
            Request::patch("/v1/repos/repo-1")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"defaultBranch":"trunk"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let snapshot = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = axum::body::to_bytes(snapshot.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(snapshot["entries"][0]["repo"]["id"], "repo-1");
    assert_eq!(snapshot["entries"][0]["repo"]["default_branch"], "trunk");
    assert_eq!(
        snapshot["entries"][0]["repo"]["default_branch_source"],
        "api_update"
    );
    assert_eq!(snapshot["entries"][0]["items"][0]["id"], "task-1");
}

#[tokio::test]
async fn task_agent_session_route_persists_provider_session_id() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });

    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/agent-session")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "agentSessionId": "claude-session-1" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let snapshot_response = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = axum::body::to_bytes(snapshot_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(
        snapshot["entries"][0]["items"][0]["agent_session_id"],
        serde_json::json!("claude-session-1")
    );
}

/// `activity` blends two orthogonal facts, so task detail reports each one on
/// its own. The combination that motivated the split — an agent busy inside a
/// long tool or MCP call whose latest output nobody has read — is
/// indistinguishable from a finished task through `activity` alone.
#[tokio::test]
async fn task_detail_reports_the_runtime_and_read_dimensions_separately() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-08-18 08:00:00",
        )
        .unwrap();
        db.update_pipeline_item_runtime_status("task-1", "busy", None)
            .unwrap();
        db.update_pipeline_item_activity("task-1", "unread")
            .unwrap();
    });

    let response = app
        .clone()
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let detail: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(detail["activity"], serde_json::json!("unread"));
    assert_eq!(detail["runtimeState"], serde_json::json!("busy"));
    assert_eq!(detail["readState"], serde_json::json!("unread"));

    // Reading the task moves the read dimension and nothing else.
    let mark_read = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/mark-read")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mark_read.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let detail: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(detail["readState"], serde_json::json!("read"));
    assert_eq!(
        detail["runtimeState"],
        serde_json::json!("busy"),
        "reading a task says nothing about whether its agent is running"
    );

    // The listing surface an external supervisor sweeps carries the same two
    // dimensions, so a quiet-task alarm never has to key on the blend.
    let listing = app
        .oneshot(
            Request::get("/v1/repos/repo-1/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(listing.status(), StatusCode::OK);
    let body = axum::body::to_bytes(listing.into_body(), usize::MAX)
        .await
        .unwrap();
    let tasks: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(tasks[0]["id"], serde_json::json!("task-1"));
    assert_eq!(tasks[0]["runtimeState"], serde_json::json!("busy"));
    assert_eq!(tasks[0]["readState"], serde_json::json!("read"));
}

/// Tasks created before the daemon's first status observation have no runtime
/// verdict yet. That is a supported transient state, not `busy`: consumers
/// keep rendering the independently persisted activity until reconciliation.
#[tokio::test]
async fn task_detail_reports_null_runtime_state_without_losing_activity() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-08-21 08:00:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let detail: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(detail["runtimeState"], serde_json::Value::Null);
    assert_eq!(detail["activity"], serde_json::json!("idle"));
}

/// The split this exists for. `waitingPromptSnippet` is what the session said;
/// the composer is what somebody is about to say into it — and on a Claude
/// session that line is usually the CLI's own tab-to-accept suggestion. Once
/// they shared a field, a suggestion read as an owner directive and stalled a
/// task for a day.
#[tokio::test]
async fn task_detail_reports_the_composer_apart_from_what_the_session_said() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-08-18 08:00:00",
        )
        .unwrap();
        db.update_pipeline_item_waiting_prompt("task-1", "Ready for review.")
            .unwrap();
        db.update_pipeline_item_composer(
            "task-1",
            Some("run it on my phone so i can see it"),
            "not-typed",
        )
        .unwrap();
    });

    let response = app
        .clone()
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let detail: serde_json::Value = from_slice(&body).unwrap();

    assert_eq!(
        detail["waitingPromptSnippet"],
        serde_json::json!("Ready for review.")
    );
    assert!(detail.get("snippet").is_none());
    assert_eq!(
        detail["composer"],
        serde_json::json!({
            "text": "run it on my phone so i can see it",
            "attestation": "not-typed",
        }),
        "the composer line is reported, but only as its own labelled field"
    );
    assert!(!detail["waitingPromptSnippet"]
        .as_str()
        .unwrap_or_default()
        .contains("phone"));

    let agent_response = app
        .oneshot(
            Request::get("/v1/tasks/task-1?agentView=true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let agent_body = axum::body::to_bytes(agent_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let agent_detail: serde_json::Value = from_slice(&agent_body).unwrap();
    assert!(agent_detail.get("composer").is_none());
    assert!(!String::from_utf8(agent_body.to_vec())
        .unwrap()
        .contains("run it on my phone"));
}

/// A task nothing has reported a composer for says nothing about one. Absent
/// is not `unknown`: `unknown` is a session that reported and could prove
/// nothing.
#[tokio::test]
async fn task_detail_omits_the_composer_until_a_session_reports_one() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-08-18 08:00:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let detail: serde_json::Value = from_slice(&body).unwrap();
    assert!(detail.get("composer").is_none());
}

#[tokio::test]
async fn task_activity_routes_persist_runtime_status_and_mark_read() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });
    let mut state_changes = state.subscribe_state_changes();
    let app = super::router(state);

    let busy_response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/runtime-status")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "status": "busy", "selected": false }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(busy_response.status(), StatusCode::OK);
    let busy_change = state_changes.try_recv().expect("busy state change");
    assert!(matches!(
        busy_change,
        kanna_agent_protocol::ServerFrame::StateChanged {
            scope: kanna_agent_protocol::StateChangeScope::Tasks,
            task_state: Some(kanna_agent_protocol::TaskStateChange {
                version: 1,
                ref task_id,
                ref activity,
                activity_revision: 1,
                ref runtime_state,
                ref read_state,
                ..
            }),
        } if task_id == "task-1"
            && activity == "working"
            && runtime_state.as_deref() == Some("busy")
            && read_state == "read"
    ));

    let exited_response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/runtime-status")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "status": "idle", "selected": false }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(exited_response.status(), StatusCode::OK);
    let idle_change = state_changes.try_recv().expect("idle state change");
    assert!(matches!(
        idle_change,
        kanna_agent_protocol::ServerFrame::StateChanged {
            task_state: Some(kanna_agent_protocol::TaskStateChange {
                ref activity,
                activity_revision: 2,
                ref runtime_state,
                ref read_state,
                ..
            }),
            ..
        } if activity == "unread"
            && runtime_state.as_deref() == Some("idle")
            && read_state == "unread"
    ));

    let unread_snapshot = app
        .clone()
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let unread_body = axum::body::to_bytes(unread_snapshot.into_body(), usize::MAX)
        .await
        .unwrap();
    let unread_json: serde_json::Value = from_slice(&unread_body).unwrap();
    assert_eq!(
        unread_json["entries"][0]["items"][0]["activity"],
        serde_json::json!("unread")
    );

    let mark_read_response = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/actions/mark-read")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mark_read_response.status(), StatusCode::OK);
    let read_change = state_changes.try_recv().expect("read state change");
    assert!(matches!(
        read_change,
        kanna_agent_protocol::ServerFrame::StateChanged {
            task_state: Some(kanna_agent_protocol::TaskStateChange {
                ref activity,
                activity_revision: 3,
                ref runtime_state,
                ref read_state,
                ..
            }),
            ..
        } if activity == "idle"
            && runtime_state.as_deref() == Some("idle")
            && read_state == "read"
    ));

    let read_snapshot = app
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let read_body = axum::body::to_bytes(read_snapshot.into_body(), usize::MAX)
        .await
        .unwrap();
    let read_json: serde_json::Value = from_slice(&read_body).unwrap();
    assert_eq!(
        read_json["entries"][0]["items"][0]["activity"],
        serde_json::json!("idle")
    );
}

#[tokio::test]
async fn task_port_routes_claim_reuse_and_release_allocations() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-2",
            "repo-1",
            "prompt",
            Some("Task Two"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });

    let body = serde_json::json!({
        "ports": { "KANNA_DEV_PORT": 1420 },
        "reservedPorts": [1421],
        "reservedPortOffsets": [2]
    })
    .to_string();
    let first = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/ports")
                .header("content-type", "application/json")
                .body(Body::from(body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body = axum::body::to_bytes(first.into_body(), usize::MAX)
        .await
        .unwrap();
    let first_json: serde_json::Value = from_slice(&first_body).unwrap();
    assert_eq!(first_json["portEnv"]["KANNA_DEV_PORT"], "1423");
    assert_eq!(first_json["firstPort"], 1423);

    let task_detail = app
        .clone()
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let task_detail_body = axum::body::to_bytes(task_detail.into_body(), usize::MAX)
        .await
        .unwrap();
    let task_detail_json: serde_json::Value = from_slice(&task_detail_body).unwrap();
    assert_eq!(
        task_detail_json["ports"],
        serde_json::json!([{ "name": "KANNA_DEV_PORT", "port": 1423 }])
    );

    let reused = app
        .clone()
        .oneshot(
            Request::post("/v1/tasks/task-1/ports")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let reused_body = axum::body::to_bytes(reused.into_body(), usize::MAX)
        .await
        .unwrap();
    let reused_json: serde_json::Value = from_slice(&reused_body).unwrap();
    assert_eq!(reused_json["portEnv"]["KANNA_DEV_PORT"], "1423");

    let released = app
        .clone()
        .oneshot(
            Request::delete("/v1/tasks/task-1/ports")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(released.status(), StatusCode::OK);

    let claimed_after_release = app
        .oneshot(
            Request::post("/v1/tasks/task-2/ports")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "ports": { "KANNA_DEV_PORT": 1420 } }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let claimed_body = axum::body::to_bytes(claimed_after_release.into_body(), usize::MAX)
        .await
        .unwrap();
    let claimed_json: serde_json::Value = from_slice(&claimed_body).unwrap();
    assert_eq!(claimed_json["portEnv"]["KANNA_DEV_PORT"], "1421");
}

#[tokio::test]
async fn task_port_routes_never_claim_a_port_kanna_binds_for_itself() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "prompt",
            Some("Task One"),
            "in progress",
            "2026-08-05 08:00:00",
        )
        .unwrap();
    });

    // Base sits one below the production transfer port, so the allocator's
    // first candidate is a port Kanna itself listens on.
    let body = serde_json::json!({
        "ports": { "APP_PORT": kanna_runtime_defaults::DEFAULT_TRANSFER_PORT - 1 },
    })
    .to_string();
    let response = app
        .oneshot(
            Request::post("/v1/tasks/task-1/ports")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response_body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = from_slice(&response_body).unwrap();

    // 4455 and 4456 are Kanna's, so the first free port above 4454 is 4457.
    assert_eq!(json["portEnv"]["APP_PORT"], "4457");
}

#[tokio::test]
async fn transfer_routes_list_claim_and_fail_pending_incoming_transfers() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_task_transfer(
            "transfer-1",
            "incoming",
            "pending",
            Some(r#"{"task":{},"repo":{}}"#),
        )
        .unwrap();
    });

    let list_response = app
        .clone()
        .oneshot(
            Request::get("/v1/transfers/incoming/pending")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(list_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let list_json: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(list_json["transfers"].as_array().unwrap().len(), 1);
    assert_eq!(list_json["transfers"][0]["id"], "transfer-1");
    assert_eq!(list_json["transfers"][0]["sourcePeerId"], "peer-1");
    assert_eq!(list_json["transfers"][0]["sourceTaskId"], "source-task-1");
    assert_eq!(
        list_json["transfers"][0]["payloadJson"],
        r#"{"task":{},"repo":{}}"#
    );
    assert!(list_json["transfers"][0]["source_peer_id"].is_null());
    assert!(list_json["transfers"][0]["source_task_id"].is_null());
    assert!(list_json["transfers"][0]["payload_json"].is_null());

    let claim_response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers/transfer-1/actions/claim")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "ownerToken": "window-owner",
                        "recovery": false
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(claim_response.status(), StatusCode::OK);
    let claim_body = axum::body::to_bytes(claim_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let claim_json: serde_json::Value = from_slice(&claim_body).unwrap();
    assert_eq!(claim_json["updated"], true);

    let importing_response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers/transfer-1/actions/importing")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "localTaskId": "task-local",
                        "claimOwnerToken": "window-owner"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(importing_response.status(), StatusCode::OK);

    let awaiting_response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers/transfer-1/actions/awaiting-acknowledgment")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "localTaskId": "task-local",
                        "claimOwnerToken": "window-owner"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(awaiting_response.status(), StatusCode::OK);

    let resumable_response = app
        .clone()
        .oneshot(
            Request::get("/v1/transfers/incoming/pending")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let resumable_body = axum::body::to_bytes(resumable_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let resumable_json: serde_json::Value = from_slice(&resumable_body).unwrap();
    assert_eq!(
        resumable_json["transfers"][0]["status"],
        "awaiting_acknowledgment"
    );
    assert_eq!(resumable_json["transfers"][0]["localTaskId"], "task-local");

    let fail_response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers/transfer-1/actions/fail")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "reason": "failed import" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(fail_response.status(), StatusCode::OK);
    let fail_body = axum::body::to_bytes(fail_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let fail_json: serde_json::Value = from_slice(&fail_body).unwrap();
    assert_eq!(fail_json["updated"], false);

    let complete_response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers/transfer-1/actions/complete")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "localTaskId": "task-local",
                        "claimOwnerToken": "window-owner"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(complete_response.status(), StatusCode::OK);
    let completed_list = app
        .clone()
        .oneshot(
            Request::get("/v1/transfers/incoming/pending")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let completed_body = axum::body::to_bytes(completed_list.into_body(), usize::MAX)
        .await
        .unwrap();
    let completed_json: serde_json::Value = from_slice(&completed_body).unwrap();
    assert!(completed_json["transfers"].as_array().unwrap().is_empty());

    let cleanup_list = app
        .oneshot(
            Request::get("/v1/transfers/incoming/cleanup-candidates")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cleanup_list.status(), StatusCode::OK);
    let cleanup_body = axum::body::to_bytes(cleanup_list.into_body(), usize::MAX)
        .await
        .unwrap();
    let cleanup_json: serde_json::Value = from_slice(&cleanup_body).unwrap();
    assert_eq!(
        cleanup_json["transferIds"],
        serde_json::json!(["transfer-1"])
    );
}

/// The incoming side has always had a fail route; the outgoing side had none,
/// so a source whose finalization could not ship the agent's session state left
/// its row `pending` forever — invisible, and blocking a retry of the task.
#[tokio::test]
async fn fail_outgoing_transfer_route_terminalizes_only_live_outgoing_rows() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        for (id, direction, status) in [
            ("transfer-outgoing", "outgoing", "pending"),
            ("transfer-outgoing-done", "outgoing", "completed"),
            ("transfer-incoming", "incoming", "pending"),
        ] {
            db.insert_test_task_transfer(id, direction, status, Some("{}"))
                .unwrap();
        }
    });

    let fail = |transfer_id: &'static str| {
        let app = app.clone();
        async move {
            let response = app
                .oneshot(
                    Request::post(format!("/v1/transfers/{transfer_id}/actions/fail-outgoing"))
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::json!({ "reason": "no session transcript to ship" })
                                .to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            from_slice::<serde_json::Value>(&body).unwrap()["updated"]
                .as_bool()
                .unwrap()
        }
    };

    assert!(fail("transfer-outgoing").await);
    // Terminal rows and the incoming side are not this route's to move.
    assert!(!fail("transfer-outgoing").await);
    assert!(!fail("transfer-outgoing-done").await);
    assert!(!fail("transfer-incoming").await);

    let read = app
        .clone()
        .oneshot(
            Request::get("/v1/transfers/transfer-outgoing")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(read.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(json["transfer"]["status"], "failed");
    assert_eq!(json["transfer"]["error"], "no session transcript to ship");
    assert!(!json["transfer"]["completed_at"].is_null());
}

#[tokio::test]
async fn incoming_cleanup_candidates_include_completed_rejected_and_failed_rows() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        for (id, direction, status) in [
            ("transfer-completed", "incoming", "completed"),
            ("transfer-rejected", "incoming", "rejected"),
            ("transfer-failed", "incoming", "failed"),
            ("transfer-pending", "incoming", "pending"),
            ("transfer-outgoing", "outgoing", "completed"),
        ] {
            db.insert_test_task_transfer(id, direction, status, Some("{}"))
                .unwrap();
        }
    });

    let response = app
        .clone()
        .oneshot(
            Request::get("/v1/transfers/incoming/cleanup-candidates")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = from_slice(&body).unwrap();
    let mut ids = json["transferIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(
        ids,
        vec!["transfer-completed", "transfer-failed", "transfer-rejected"]
    );

    let cleanup_response = app
        .clone()
        .oneshot(
            Request::post("/v1/transfers/transfer-completed/actions/sidecar-cleanup-complete")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cleanup_response.status(), StatusCode::OK);
    let cleanup_body = axum::body::to_bytes(cleanup_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let cleanup_json: serde_json::Value = from_slice(&cleanup_body).unwrap();
    assert_eq!(cleanup_json["updated"], true);

    let remaining_response = app
        .oneshot(
            Request::get("/v1/transfers/incoming/cleanup-candidates")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let remaining_body = axum::body::to_bytes(remaining_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let remaining_json: serde_json::Value = from_slice(&remaining_body).unwrap();
    assert!(!remaining_json["transferIds"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("transfer-completed")));
}

#[tokio::test]
async fn cloud_task_identity_route_sets_once_and_rejects_open_task_collision() {
    let app = super::test_router_with_seed("desktop-cloud-identity", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        for task_id in ["task-1", "task-2"] {
            db.insert_test_pipeline_item(
                task_id,
                "repo-1",
                "transferred prompt",
                None,
                "in progress",
                "2026-07-25 10:00:00",
            )
            .unwrap();
        }
    });

    let set_response = app
        .clone()
        .oneshot(
            Request::put("/v1/tasks/task-1/actions/cloud-task-identity")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "cloudTaskId": "task-source-stable" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(set_response.status(), StatusCode::OK);

    let snapshot_response = app
        .clone()
        .oneshot(Request::get("/v1/snapshot").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let snapshot_body = axum::body::to_bytes(snapshot_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot_json: serde_json::Value = from_slice(&snapshot_body).unwrap();
    let task = snapshot_json["entries"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "task-1")
        .unwrap();
    assert_eq!(task["cloud_task_id"], "task-source-stable");

    let unchanged_response = app
        .clone()
        .oneshot(
            Request::put("/v1/tasks/task-1/actions/cloud-task-identity")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "cloudTaskId": "task-source-stable" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unchanged_response.status(), StatusCode::OK);

    let changed_response = app
        .clone()
        .oneshot(
            Request::put("/v1/tasks/task-1/actions/cloud-task-identity")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "cloudTaskId": "task-source-different" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(changed_response.status(), StatusCode::CONFLICT);

    let collision_response = app
        .oneshot(
            Request::put("/v1/tasks/task-2/actions/cloud-task-identity")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "cloudTaskId": "task-source-stable" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(collision_response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn cloud_task_identity_route_rejects_invalid_identity_and_missing_task() {
    let app = super::test_router_with_seed("desktop-cloud-identity-invalid", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "transferred prompt",
            None,
            "in progress",
            "2026-07-25 10:00:00",
        )
        .unwrap();
    });

    for identity in ["   ", "task-source\nstable"] {
        let response = app
            .clone()
            .oneshot(
                Request::put("/v1/tasks/task-1/actions/cloud-task-identity")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "cloudTaskId": identity }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    let missing_response = app
        .oneshot(
            Request::put("/v1/tasks/task-missing/actions/cloud-task-identity")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "cloudTaskId": "task-source-stable" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "current_thread")]
async fn cloud_task_identity_route_stays_responsive_while_database_write_is_blocked() {
    let state = super::test_state_with_seed("desktop-cloud-identity-blocked", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "transferred prompt",
            None,
            "in progress",
            "2026-07-25 10:00:00",
        )
        .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    // The writer holds the lock until this test has taken its measurement, so
    // the healthy path pays nothing and only a blocked runtime waits out the
    // ceiling. The window is an order of magnitude above the budget asserted
    // below, so a loaded box can never turn a real block into a pass.
    let (unlock_tx, unlock_rx) = std::sync::mpsc::channel();
    let locker = std::thread::spawn(move || {
        let conn = Connection::open(db_path).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        locked_tx.send(()).unwrap();
        let _ = unlock_rx.recv_timeout(Duration::from_secs(10));
        conn.execute_batch("COMMIT").unwrap();
    });
    locked_rx.recv().unwrap();

    let started_at = Instant::now();
    let request = tokio::spawn(
        app.oneshot(
            Request::put("/v1/tasks/task-1/actions/cloud-task-identity")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "cloudTaskId": "task-source-stable" }).to_string(),
                ))
                .unwrap(),
        ),
    );
    tokio::task::yield_now().await;
    let scheduler_delay = started_at.elapsed();
    let _ = unlock_tx.send(());
    let response = request.await.unwrap().unwrap();
    locker.join().unwrap();

    // Healthy is microseconds and a runtime-blocking write is the whole 10s
    // lock window, so this only has to sit somewhere between the two. 3s keeps
    // three orders of magnitude of headroom over the healthy path.
    assert!(
        scheduler_delay < Duration::from_secs(3),
        "cloud identity write blocked the async runtime for {scheduler_delay:?}"
    );
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn closed_task_identities_route_returns_closed_tasks() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-open",
            "repo-1",
            "open",
            Some("Open"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-older-closed",
            "repo-1",
            "older closed",
            Some("Older Closed"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.set_test_pipeline_item_closed_at("task-older-closed", "2026-04-17 08:00:00")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-closed",
            "repo-1",
            "closed",
            Some("Closed"),
            "in progress",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.set_test_pipeline_item_closed_at("task-closed", "2026-04-18 08:00:00")
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/closed-identities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "tasks": [
                { "id": "task-closed", "repo_id": "repo-1" },
                { "id": "task-older-closed", "repo_id": "repo-1" }
            ]
        })
    );
}

#[tokio::test]
async fn add_repo_route_registers_existing_git_repo() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-add-repo-{unique}"));
    init_test_git_repo(&repo_root);
    let app = super::test_router("desktop-1", "Studio Mac");

    let response = app
        .oneshot(
            Request::post("/v1/repos")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "path": repo_root,
                        "name": "Registered Repo"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let repo: crate::mobile_api::RepoDetail = from_slice(&body).unwrap();
    assert_eq!(repo.name, "Registered Repo");
    assert_eq!(repo.default_branch.as_deref(), Some("main"));
    assert_eq!(repo.hidden, Some(0));

    let _ = std::fs::remove_dir_all(repo_root);
}

fn repo_with_remote_main_and_local_master(label: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let temp = tempfile::Builder::new()
        .prefix(&format!("kanna-http-default-branch-{label}-"))
        .tempdir()
        .unwrap();
    let origin = temp.path().join("origin.git");
    let publisher = temp.path().join("publisher");
    let local = temp.path().join("local");
    std::fs::create_dir_all(&publisher).unwrap();
    std::fs::create_dir_all(&local).unwrap();
    let run = |cwd: &std::path::Path, args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(temp.path(), &["init", "--bare", origin.to_str().unwrap()]);
    run(&publisher, &["init", "--initial-branch=main"]);
    run(&publisher, &["config", "user.email", "test@example.com"]);
    run(&publisher, &["config", "user.name", "Kanna Test"]);
    std::fs::write(publisher.join("README.md"), "remote main").unwrap();
    run(&publisher, &["add", "."]);
    run(&publisher, &["commit", "-m", "remote main"]);
    run(
        &publisher,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    run(&publisher, &["push", "origin", "main"]);
    run(&origin, &["symbolic-ref", "HEAD", "refs/heads/main"]);

    run(&local, &["init", "--initial-branch=master"]);
    run(&local, &["config", "user.email", "test@example.com"]);
    run(&local, &["config", "user.name", "Kanna Test"]);
    std::fs::write(local.join("README.md"), "local master").unwrap();
    run(&local, &["add", "."]);
    run(&local, &["commit", "-m", "local master"]);
    run(
        &local,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    (temp, local)
}

#[tokio::test]
async fn add_repo_uses_remote_head_when_local_branch_differs() {
    let (_temp, repo_root) = repo_with_remote_main_and_local_master("registration");
    let app = super::test_router("desktop-remote-default", "Studio Mac");
    let response = app
        .oneshot(
            Request::post("/v1/repos")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "path": repo_root,
                        "defaultBranch": "master"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let repo: crate::mobile_api::RepoDetail = from_slice(&body).unwrap();
    assert_eq!(repo.default_branch.as_deref(), Some("main"));
    assert_eq!(repo.default_branch_source.as_deref(), Some("remote_symref"));
}

#[tokio::test]
async fn reconcile_repo_metadata_reports_and_repairs_default_branch_drift_in_place() {
    let (_temp, repo_root) = repo_with_remote_main_and_local_master("reconcile");
    let repo_path = repo_root.to_string_lossy().to_string();
    let app = super::test_router_with_seed("desktop-reconcile-default", "Studio Mac", move |db| {
        db.insert_repo_with_branch_source(
            crate::db::NewRepo {
                id: "repo-stale",
                path: &repo_path,
                name: "Stale Repo",
                default_branch: Some("master"),
            },
            Some("legacy_unknown"),
        )
        .unwrap();
    });

    let inspect = app
        .clone()
        .oneshot(
            Request::post("/v1/repos/repo-stale/reconcile-metadata")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"apply":false}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(inspect.status(), StatusCode::OK);
    let body = axum::body::to_bytes(inspect.into_body(), usize::MAX)
        .await
        .unwrap();
    let inspection: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(inspection["recordedDefaultBranch"], "master");
    assert_eq!(inspection["detectedDefaultBranch"], "main");
    assert_eq!(inspection["detectedDefaultBranchSource"], "remote_symref");
    assert_eq!(inspection["drift"], true);
    assert_eq!(inspection["updated"], false);

    let repair = app
        .oneshot(
            Request::post("/v1/repos/repo-stale/reconcile-metadata")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(repair.status(), StatusCode::OK);
    let body = axum::body::to_bytes(repair.into_body(), usize::MAX)
        .await
        .unwrap();
    let repaired: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(repaired["updated"], true);
    assert_eq!(repaired["repoId"], "repo-stale");
}

#[tokio::test]
async fn add_repo_route_honors_requested_default_branch() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-add-repo-branch-{unique}"));
    init_test_git_repo(&repo_root);
    let app = super::test_router("desktop-1", "Studio Mac");

    let response = app
        .oneshot(
            Request::post("/v1/repos")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "path": repo_root,
                        "name": "Transferred Repo",
                        "defaultBranch": "trunk"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let repo: crate::mobile_api::RepoDetail = from_slice(&body).unwrap();
    assert_eq!(repo.default_branch.as_deref(), Some("trunk"));

    let _ = std::fs::remove_dir_all(repo_root);
}

#[tokio::test]
async fn add_repo_route_registers_zero_commit_repo_with_its_unborn_branch() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-add-empty-repo-{unique}"));
    std::fs::create_dir_all(&repo_root).unwrap();
    assert!(Command::new("git")
        .args(["init", "--initial-branch=trunk"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    let app = super::test_router("desktop-1", "Studio Mac");

    let response = app
        .oneshot(
            Request::post("/v1/repos")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "path": repo_root,
                        "name": "Empty Repo"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let repo: crate::mobile_api::RepoDetail = from_slice(&body).unwrap();
    assert_eq!(repo.default_branch.as_deref(), Some("trunk"));

    let rev_count = Command::new("git")
        .args(["rev-list", "--all", "--count"])
        .current_dir(&repo_root)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&rev_count.stdout).trim(), "0");

    let _ = std::fs::remove_dir_all(repo_root);
}

#[tokio::test]
async fn add_repo_route_rejects_duplicate_path() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-add-repo-dupe-{unique}"));
    init_test_git_repo(&repo_root);
    let app = super::test_router("desktop-1", "Studio Mac");
    let body = Body::from(
        serde_json::json!({
            "path": repo_root,
        })
        .to_string(),
    );
    let first = app
        .clone()
        .oneshot(
            Request::post("/v1/repos")
                .header("content-type", "application/json")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);

    let second = app
        .oneshot(
            Request::post("/v1/repos")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "path": repo_root,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::CONFLICT);
    let _ = std::fs::remove_dir_all(repo_root);
}

#[tokio::test]
async fn repo_checkout_clones_registers_and_reports_done() {
    use sha2::{Digest, Sha256};

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let fixture_root = std::env::temp_dir().join(format!("kanna-checkout-happy-{unique}"));
    let remote = fixture_root.join("remote");
    let checkouts = fixture_root.join("checkouts");
    init_test_git_repo(&remote);
    let remote_url = format!("file://{}", remote.display());
    let remote_url_hash = format!("{:x}", Sha256::digest(remote_url.as_bytes()));
    let app =
        super::test_router_with_repo_checkout_root("desktop-1", "Studio Mac", checkouts.clone());

    let started = app
        .clone()
        .oneshot(
            Request::post("/v1/repo-checkouts")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "name": "kanji-kongbu",
                        "remoteUrl": remote_url,
                        "remoteUrlHash": remote_url_hash,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(started.status(), StatusCode::OK);
    let started: serde_json::Value = from_slice(
        &axum::body::to_bytes(started.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let operation_id = started["id"].as_str().expect("operation id");

    let operation = wait_for_repo_checkout(&app, operation_id).await;
    assert_eq!(operation["state"], "done");
    assert!(operation["repoId"].as_str().is_some());
    assert!(checkouts.join("kanji-kongbu/.git").is_dir());

    let repos = app
        .clone()
        .oneshot(Request::get("/v1/repos").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let repos: serde_json::Value = from_slice(
        &axum::body::to_bytes(repos.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(repos[0]["name"], "kanji-kongbu");
    assert_eq!(repos[0]["remoteUrl"], remote_url);
    assert_eq!(repos[0]["remoteUrlHash"], remote_url_hash);

    let _ = std::fs::remove_dir_all(fixture_root);
}

#[tokio::test]
async fn repo_checkout_failure_cleans_destination_and_registry() {
    use sha2::{Digest, Sha256};

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let fixture_root = std::env::temp_dir().join(format!("kanna-checkout-fail-{unique}"));
    let checkouts = fixture_root.join("checkouts");
    let remote_url = format!("file://{}/missing-private-repo", fixture_root.display());
    let remote_url_hash = format!("{:x}", Sha256::digest(remote_url.as_bytes()));
    let app =
        super::test_router_with_repo_checkout_root("desktop-1", "Studio Mac", checkouts.clone());

    let started = app
        .clone()
        .oneshot(
            Request::post("/v1/repo-checkouts")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "name": "private-repo",
                        "remoteUrl": remote_url,
                        "remoteUrlHash": remote_url_hash,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let started: serde_json::Value = from_slice(
        &axum::body::to_bytes(started.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let operation =
        wait_for_repo_checkout(&app, started["id"].as_str().expect("operation id")).await;
    assert_eq!(operation["state"], "failed");
    assert_eq!(
        operation["error"],
        "Could not check out the repository on Studio Mac. Configure a credential-free origin and git credentials on Studio Mac, then try again."
    );
    assert!(!operation.to_string().contains(&remote_url));
    assert!(!checkouts.join("private-repo").exists());

    let repos = app
        .oneshot(Request::get("/v1/repos").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let repos: serde_json::Value = from_slice(
        &axum::body::to_bytes(repos.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(repos, serde_json::json!([]));
    let _ = std::fs::remove_dir_all(fixture_root);
}

#[tokio::test]
async fn repo_checkout_rejects_credential_bearing_sources_without_side_effects_or_echo() {
    use sha2::{Digest, Sha256};

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let fixture_root = std::env::temp_dir().join(format!("kanna-checkout-secret-{unique}"));
    let checkouts = fixture_root.join("checkouts");
    let app =
        super::test_router_with_repo_checkout_root("desktop-1", "Studio Mac", checkouts.clone());
    let sources = [
        "https://post-secret@example.test/private.git",
        "https://example.test/private.git?signed=query-secret",
        "https://example.test/private.git#fragment-secret",
    ];

    for (index, remote_url) in sources.iter().enumerate() {
        let remote_url_hash = format!("{:x}", Sha256::digest(remote_url.as_bytes()));
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/repo-checkouts")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "name": format!("private-repo-{index}"),
                            "remoteUrl": remote_url,
                            "remoteUrlHash": remote_url_hash,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(body.contains("Studio Mac"), "{body}");
        assert!(body.contains("credential-free origin"), "{body}");
        assert!(body.contains("git credentials"), "{body}");
        assert!(!body.contains(remote_url), "{body}");
        assert!(!body.contains("secret"), "{body}");
    }

    assert!(!checkouts.exists());
    let repos = app
        .oneshot(Request::get("/v1/repos").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let repos: serde_json::Value = from_slice(
        &axum::body::to_bytes(repos.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(repos, serde_json::json!([]));
    let _ = std::fs::remove_dir_all(fixture_root);
}

async fn wait_for_repo_checkout(app: &axum::Router, operation_id: &str) -> serde_json::Value {
    for _ in 0..200 {
        let response = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/repo-checkouts/{operation_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let operation: serde_json::Value = from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        if operation["state"] != "running" {
            return operation;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("repository checkout did not finish");
}

#[tokio::test]
async fn list_repo_tasks_route_returns_repo_scoped_tasks() {
    const FULL_PROMPT: &str = "First line of the canonical task prompt.\nSecond line keeps the detailed requirements.\nPROMPT_END_SENTINEL";
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
        db.insert_test_pipeline_item(
            "task-repo-1",
            "repo-1",
            FULL_PROMPT,
            Some("Short renamed task"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-repo-2",
            "repo-2",
            "repo two prompt",
            Some("Repo Two Task"),
            "pr",
            "2026-04-17 08:00:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/repos/repo-1/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(json[0]["title"], "Short renamed task");
    assert_eq!(json[0]["prompt"], FULL_PROMPT);
    assert_eq!(json[0]["createdAt"], "2026-04-17 07:00:00");
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "task-repo-1");
    assert_eq!(tasks[0].repo_id, "repo-1");
    assert_eq!(tasks[0].activity.as_deref(), Some("idle"));
}

#[tokio::test]
async fn mobile_pin_actions_round_trip_through_canonical_task_summaries() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-first",
            "repo-1",
            "first prompt",
            Some("First Task"),
            "in progress",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-second",
            "repo-1",
            "second prompt",
            Some("Second Task"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.pin_pipeline_item("task-first", 0).unwrap();
    });

    let mut pin_request = direct_lan_request(
        axum::http::Method::POST,
        "/v1/tasks/task-second/actions/pin",
    );
    pin_request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            49152,
        ))));
    let pin = app.clone().oneshot(pin_request).await.unwrap();
    assert_eq!(pin.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(
            Request::get("/v1/repos/repo-1/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    let first = tasks.iter().find(|task| task.id == "task-first").unwrap();
    let second = tasks.iter().find(|task| task.id == "task-second").unwrap();
    assert!(first.pinned);
    assert_eq!(first.pin_order, Some(1));
    assert!(second.pinned);
    assert_eq!(second.pin_order, Some(0));

    let mut unpin_request = direct_lan_request(
        axum::http::Method::POST,
        "/v1/tasks/task-second/actions/unpin",
    );
    unpin_request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            49152,
        ))));
    let unpin = app.clone().oneshot(unpin_request).await.unwrap();
    assert_eq!(unpin.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::get("/v1/repos/repo-1/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    let second = tasks.iter().find(|task| task.id == "task-second").unwrap();
    assert!(!second.pinned);
    assert_eq!(second.pin_order, None);
}

#[tokio::test]
async fn list_recent_tasks_route_returns_open_tasks_in_updated_order() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-older",
            "repo-1",
            "older prompt",
            Some("Older Task"),
            "in progress",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-newer",
            "repo-1",
            "newer prompt",
            Some("Newer Task"),
            "pr",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-done",
            "repo-1",
            "done prompt",
            Some("Done Task"),
            "done",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.close_pipeline_item("task-done").unwrap();
        db.update_test_pipeline_item_preview("task-newer", Some("Latest agent output preview"))
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/recent")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let raw_tasks: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(raw_tasks[0]["repoName"], "Repo One");
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[0].id, "task-newer");
    assert!(raw_tasks[0].get("snippet").is_none());
    assert_eq!(
        raw_tasks[0]["waitingPromptSnippet"],
        "Latest agent output preview"
    );
    assert_eq!(tasks[0].activity.as_deref(), Some("idle"));
    assert_eq!(tasks[1].id, "task-older");
}

#[tokio::test]
async fn list_recent_tasks_route_filters_by_repo_and_applies_the_requested_limit() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
        for (id, repo_id, created_at) in [
            ("task-repo-1-old", "repo-1", "2026-08-24 08:00:00"),
            ("task-repo-1-new", "repo-1", "2026-08-24 10:00:00"),
            ("task-repo-2", "repo-2", "2026-08-24 11:00:00"),
        ] {
            db.insert_test_pipeline_item(id, repo_id, id, Some(id), "in progress", created_at)
                .unwrap();
        }
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/recent?repoId=repo-1&limit=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "task-repo-1-new");
}

#[tokio::test]
async fn task_listing_routes_reject_repo_id_with_all_machines() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
    });

    for path in [
        "/v1/tasks/recent?repoId=repo-1&allMachines=true",
        "/v1/tasks/search?query=review&repoId=repo-1&allMachines=true",
    ] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let message = String::from_utf8(body.to_vec()).unwrap();
        assert!(message.contains("repoId and allMachines"), "{message}");
        assert!(
            message.contains("repository IDs are machine-local"),
            "{message}"
        );
    }
}

#[tokio::test]
async fn get_task_route_returns_full_task_detail_by_id() {
    let full_prompt = format!("{}PROMPT_END_SENTINEL", "p".repeat(520));
    let seed_prompt = full_prompt.clone();
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", move |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            &seed_prompt,
            Some("Review MCP"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
        db.update_pipeline_item_agent_binding("task-1", "codex", "pty", None)
            .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-task-1",
            task_id: "task-1",
            stage: "in progress",
            kind: "main",
            agent: Some("implement"),
            agent_provider: Some("claude"),
            model: Some("claude-fable-5"),
            effort: Some("high"),
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-1"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();

    assert_eq!(task.id, "task-1");
    assert_eq!(task.repo_id, "repo-1");
    assert_eq!(task.title, "Review MCP");
    assert_eq!(task.prompt.as_deref(), Some(full_prompt.as_str()));
    assert!(task
        .prompt
        .as_deref()
        .unwrap()
        .contains("PROMPT_END_SENTINEL"));
    assert_eq!(task.stage.as_deref(), Some("in progress"));
    assert_eq!(task.activity.as_deref(), Some("idle"));
    assert_eq!(task.agent_type.as_deref(), Some("pty"));
    assert_eq!(task.agent_provider.as_deref(), Some("claude"));
    assert_eq!(task.model.as_deref(), Some("claude-fable-5"));
    assert_eq!(task.effort.as_deref(), Some("high"));
    assert_eq!(
        task.latest_run
            .as_ref()
            .and_then(|run| run.agent.as_deref()),
        Some("implement")
    );
    assert_eq!(task.branch.as_deref(), Some("branch-task-1"));
    assert_eq!(task.pr_url, None);
    assert_eq!(task.closed_at, None);
    assert_eq!(task.worktree_path, None);
    assert_eq!(task.commits_ahead, None);
    assert_eq!(task.commits_behind, None);
    assert!(!task.dirty);
}

#[tokio::test]
async fn list_task_children_route_returns_open_and_closed_direct_children_with_verdicts() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        for (id, created_at) in [
            ("task-parent", "2026-08-06 08:00:00"),
            ("task-child-security", "2026-08-06 09:00:00"),
            ("task-child-compat", "2026-08-06 10:00:00"),
            ("task-child-no-run", "2026-08-06 10:30:00"),
            ("task-child-default-no-run", "2026-08-06 10:45:00"),
            ("task-grandchild", "2026-08-06 11:00:00"),
            ("task-unrelated", "2026-08-06 12:00:00"),
        ] {
            db.insert_test_pipeline_item(
                id,
                "repo-1",
                "specialty review",
                None,
                "review",
                created_at,
            )
            .unwrap();
        }
        db.update_pipeline_item_parent("task-child-security", Some("task-parent"))
            .unwrap();
        db.update_pipeline_item_parent("task-child-compat", Some("task-parent"))
            .unwrap();
        db.update_pipeline_item_parent("task-child-no-run", Some("task-parent"))
            .unwrap();
        db.update_pipeline_item_parent("task-child-default-no-run", Some("task-parent"))
            .unwrap();
        db.update_pipeline_item_parent("task-grandchild", Some("task-child-security"))
            .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-parent",
            "task-parent-2",
            "specialized-reviewers",
            None,
            "claude",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-child-no-run",
            "branch-task-child-no-run",
            "specialty-review",
            None,
            "claude",
        )
        .unwrap();
        db.set_test_pipeline_item_closed_at("task-child-compat", "2026-08-06 10:30:00")
            .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-security-stale",
            task_id: "task-child-security",
            stage: "review",
            kind: "main",
            agent: Some("review-security-stale"),
            agent_provider: Some("claude"),
            model: None,
            effort: None,
            status: "failed",
            result: Some(
                r#"{"status":"failure","summary":"STALE: superseded security verdict","metadata":null}"#,
            ),
            feedback: None,
            session_id: Some("task-child-security"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-security",
            task_id: "task-child-security",
            stage: "review",
            kind: "main",
            agent: Some("review-security"),
            agent_provider: Some("claude"),
            model: None,
            effort: None,
            status: "succeeded",
            result: Some(
                r#"{"status":"success","summary":"PASS: no security findings","metadata":null}"#,
            ),
            feedback: None,
            session_id: Some("task-child-security"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-compat",
            task_id: "task-child-compat",
            stage: "review",
            kind: "main",
            agent: Some("review-compat"),
            agent_provider: Some("claude"),
            model: None,
            effort: None,
            status: "failed",
            result: Some(
                r#"{"status":"failure","summary":"FAIL: mobile contract changed","metadata":null}"#,
            ),
            feedback: None,
            session_id: Some("task-child-compat"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
    });

    let response = app
        .clone()
        .oneshot(
            Request::get("/v1/tasks/task-parent/children")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let children: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(
        children,
        serde_json::json!([
            {
                "id": "task-child-security",
                "agent": "review-security",
                "workflowName": "default",
                "pipelineName": "default",
                "createdAt": "2026-08-06 09:00:00",
                "closedAt": null,
                "latestRun": {
                    "id": "run-security",
                    "stage": "review",
                    "kind": "main",
                    "trigger": "unspecified",
                    "agent": "review-security",
                    "status": "succeeded",
                    "summary": "PASS: no security findings",
                    "resumedFromRunId": null,
                    "resumeFallbackReason": null,
                    "finishedAt": null
                }
            },
            {
                "id": "task-child-compat",
                "agent": "review-compat",
                "workflowName": "default",
                "pipelineName": "default",
                "createdAt": "2026-08-06 10:00:00",
                "closedAt": "2026-08-06 10:30:00",
                "latestRun": {
                    "id": "run-compat",
                    "stage": "review",
                    "kind": "main",
                    "trigger": "unspecified",
                    "agent": "review-compat",
                    "status": "failed",
                    "summary": "FAIL: mobile contract changed",
                    "resumedFromRunId": null,
                    "resumeFallbackReason": null,
                    "finishedAt": null
                }
            },
            {
                "id": "task-child-no-run",
                "agent": null,
                "workflowName": "specialty-review",
                "pipelineName": "specialty-review",
                "createdAt": "2026-08-06 10:30:00",
                "closedAt": null,
                "latestRun": null
            },
            {
                "id": "task-child-default-no-run",
                "agent": null,
                "workflowName": "default",
                "pipelineName": "default",
                "createdAt": "2026-08-06 10:45:00",
                "closedAt": null,
                "latestRun": null
            }
        ])
    );

    // A dispatcher resumes in a later stage's workspace, so it may only know
    // the task by one of its branch names; the tool's contract promises that
    // resolves to the same history.
    let by_branch = app
        .clone()
        .oneshot(
            Request::get("/v1/tasks/task-parent-2/children")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(by_branch.status(), StatusCode::OK);
    let by_branch_body = axum::body::to_bytes(by_branch.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        from_slice::<serde_json::Value>(&by_branch_body).unwrap(),
        children
    );

    // An existing task that dispatched nothing is an empty list, never a 404.
    // That is what lets the dispatcher tell "no children were ever created"
    // from "I asked about the wrong task".
    let childless = app
        .clone()
        .oneshot(
            Request::get("/v1/tasks/task-unrelated/children")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(childless.status(), StatusCode::OK);
    let childless_body = axum::body::to_bytes(childless.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        from_slice::<serde_json::Value>(&childless_body).unwrap(),
        serde_json::json!([])
    );

    let missing_parent = app
        .oneshot(
            Request::get("/v1/tasks/task-missing/children")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_parent.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn update_task_route_persists_display_name_and_get_list_return_new_title() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Original prompt",
            None,
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let response = app
        .clone()
        .oneshot(
            Request::patch("/v1/tasks/task-1")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "displayName": "Renamed task"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let action: crate::mobile_api::TaskActionResponse = from_slice(&body).unwrap();
    assert_eq!(action.task_id, "task-1");

    let db = Db::open(&db_path).unwrap();
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(item.display_name.as_deref(), Some("Renamed task"));
    drop(db);

    let get_response = app
        .clone()
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(get_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();
    assert_eq!(task.title, "Renamed task");

    let list_response = app
        .oneshot(
            Request::get("/v1/tasks/recent")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(list_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    assert_eq!(tasks[0].title, "Renamed task");
}

#[tokio::test]
async fn update_task_route_clears_display_name_with_null() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Original prompt",
            Some("Custom title"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
    });
    let db_path = state.config.db_path.clone();
    let app = super::router(state);

    let response = app
        .clone()
        .oneshot(
            Request::patch("/v1/tasks/task-1")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "displayName": null
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let db = Db::open(&db_path).unwrap();
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(item.display_name, None);
    drop(db);

    let get_response = app
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(get_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();
    assert_eq!(task.title, "Original prompt");
}

#[tokio::test]
async fn update_task_route_returns_not_found_for_unknown_task() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
    });

    let response = app
        .oneshot(
            Request::patch("/v1/tasks/missing-task")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "displayName": "Still missing"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn get_task_route_returns_worktree_git_state() {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-http-detail-repo-{unique}"));
    let worktree = std::env::temp_dir().join(format!("kanna-http-detail-worktree-{unique}"));
    init_test_git_repo(&repo_root);
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            "task-detail",
            worktree.to_str().unwrap()
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    std::fs::write(worktree.join("feature.txt"), "feature").unwrap();
    assert!(Command::new("git")
        .args(["add", "feature.txt"])
        .current_dir(&worktree)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "feature"])
        .current_dir(&worktree)
        .status()
        .unwrap()
        .success());
    std::fs::write(worktree.join("dirty.txt"), "dirty").unwrap();

    let worktree_string = worktree.to_string_lossy().to_string();
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Review MCP task detail",
            Some("Review MCP"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "task-1",
            "task-detail",
            "default",
            None,
            "claude",
        )
        .unwrap();
        db.update_test_pipeline_item_base_ref("task-1", "main")
            .unwrap();
        db.upsert_worktree("wt-task-1", "task-1", &worktree_string, "task-detail")
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();

    assert_eq!(
        task.worktree_path.as_deref(),
        Some(worktree_string.as_str())
    );
    assert_eq!(task.workflow_name.as_deref(), Some("default"));
    assert_eq!(task.stage_transition.as_deref(), Some("manual"));
    assert_eq!(task.commits_ahead, Some(1));
    assert_eq!(task.commits_behind, Some(0));
    assert!(task.dirty);

    let _ = Command::new("git")
        .args(["worktree", "remove", "--force", worktree.to_str().unwrap()])
        .current_dir(&repo_root)
        .status();
    let _ = std::fs::remove_dir_all(repo_root);
    let _ = std::fs::remove_dir_all(worktree);
}

fn run_task_stats_git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("run task stats git command");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn task_stats_fixture(label: &str) -> (PathBuf, PathBuf) {
    let unique = format!(
        "{}-{}-{label}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let repo_root = std::env::temp_dir().join(format!("kanna-task-stats-repo-{unique}"));
    let worktree = std::env::temp_dir().join(format!("kanna-task-stats-worktree-{unique}"));
    init_test_git_repo(&repo_root);
    run_task_stats_git(
        &repo_root,
        &[
            "worktree",
            "add",
            "-b",
            "task-stats",
            worktree.to_str().expect("utf-8 worktree path"),
        ],
    );
    std::fs::write(worktree.join("feature.txt"), "feature").expect("write feature");
    run_task_stats_git(&worktree, &["add", "feature.txt"]);
    run_task_stats_git(&worktree, &["commit", "-m", "feature"]);
    (repo_root, worktree)
}

async fn request_task_stats(
    repo_root: &Path,
    worktree: &Path,
    base_ref: &str,
) -> (serde_json::Value, crate::mobile_api::TaskDetail) {
    let repo_path = repo_root.to_string_lossy().to_string();
    let worktree_path = worktree.to_string_lossy().to_string();
    let base_ref = base_ref.to_string();
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", move |db| {
        db.insert_test_repo_with_path("repo-1", &repo_path, "Repo One")
            .expect("insert repo");
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Task git stats",
            Some("Task git stats"),
            "in progress",
            "2026-09-03 10:00:00",
        )
        .expect("insert task");
        db.update_test_pipeline_item_base_ref("task-1", &base_ref)
            .expect("set task base ref");
        db.upsert_worktree("wt-task-1", "task-1", &worktree_path, "task-stats")
            .expect("insert worktree");
    });
    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-1")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("request task detail");
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    let value: serde_json::Value = from_slice(&body).expect("parse task detail JSON");
    let detail = serde_json::from_value(value.clone()).expect("parse typed task detail");
    (value, detail)
}

fn remove_task_stats_fixture(repo_root: &Path, worktree: &Path) {
    let _ = Command::new("git")
        .args([
            "worktree",
            "remove",
            "--force",
            worktree.to_str().unwrap_or_default(),
        ])
        .current_dir(repo_root)
        .status();
    let _ = std::fs::remove_dir_all(repo_root);
    let _ = std::fs::remove_dir_all(worktree);
}

#[tokio::test]
async fn get_task_git_stats_resolve_origin_when_local_base_is_missing() {
    let (repo_root, worktree) = task_stats_fixture("remote-only");
    run_task_stats_git(&repo_root, &["checkout", "--detach"]);
    run_task_stats_git(&repo_root, &["branch", "-D", "main"]);

    let (json, detail) = request_task_stats(&repo_root, &worktree, "main").await;
    assert_eq!(detail.commits_ahead, Some(1));
    assert_eq!(detail.commits_behind, Some(0));
    assert_eq!(detail.base_ref_unresolved, None);
    assert_eq!(json["commitsAhead"], 1);
    assert!(json.get("baseRefUnresolved").is_none());

    remove_task_stats_fixture(&repo_root, &worktree);
}

#[tokio::test]
async fn get_task_git_stats_prefer_origin_when_local_base_is_stale() {
    let (repo_root, worktree) = task_stats_fixture("stale-local");
    run_task_stats_git(&repo_root, &["checkout", "-b", "remote-main"]);
    std::fs::write(repo_root.join("remote.txt"), "remote").expect("write remote change");
    run_task_stats_git(&repo_root, &["add", "remote.txt"]);
    run_task_stats_git(&repo_root, &["commit", "-m", "remote change"]);
    run_task_stats_git(
        &repo_root,
        &["update-ref", "refs/remotes/origin/main", "remote-main"],
    );
    run_task_stats_git(&repo_root, &["checkout", "main"]);

    let (_, detail) = request_task_stats(&repo_root, &worktree, "main").await;
    assert_eq!(detail.commits_ahead, Some(1));
    assert_eq!(detail.commits_behind, Some(1));
    assert_eq!(detail.base_ref_unresolved, None);

    remove_task_stats_fixture(&repo_root, &worktree);
}

#[tokio::test]
async fn get_task_git_stats_fall_back_from_stale_recorded_base_to_repo_default() {
    let (repo_root, worktree) = task_stats_fixture("stale-recorded-base");

    let (_, detail) = request_task_stats(&repo_root, &worktree, "retired-default").await;
    assert_eq!(detail.commits_ahead, Some(1));
    assert_eq!(detail.commits_behind, Some(0));
    assert_eq!(detail.base_ref_unresolved, None);

    remove_task_stats_fixture(&repo_root, &worktree);
}

#[tokio::test]
async fn get_task_git_stats_omit_counts_and_mark_an_unresolved_base() {
    let (repo_root, worktree) = task_stats_fixture("unresolved");
    run_task_stats_git(
        &repo_root,
        &["update-ref", "-d", "refs/remotes/origin/main"],
    );
    run_task_stats_git(&repo_root, &["checkout", "--detach"]);
    run_task_stats_git(&repo_root, &["branch", "-D", "main"]);

    let (json, detail) = request_task_stats(&repo_root, &worktree, "main").await;
    assert_eq!(detail.commits_ahead, None);
    assert_eq!(detail.commits_behind, None);
    assert_eq!(detail.base_ref_unresolved, Some(true));
    assert!(json.get("commitsAhead").is_none());
    assert!(json.get("commitsBehind").is_none());
    assert_eq!(json["baseRefUnresolved"], true);

    remove_task_stats_fixture(&repo_root, &worktree);
}

#[tokio::test]
async fn get_task_route_accepts_branch_name_alias() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-1",
            "repo-1",
            "Review MCP task detail",
            Some("Review MCP"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/branch-task-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let task: crate::mobile_api::TaskDetail = from_slice(&body).unwrap();

    assert_eq!(task.id, "task-1");
    assert_eq!(task.branch.as_deref(), Some("branch-task-1"));
}

#[tokio::test]
async fn get_task_route_returns_not_found_for_unknown_task() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/missing-task")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

struct TaskFileRouteFixture {
    app: axum::Router,
    state: Arc<AppState>,
    worktree: PathBuf,
    db_path: PathBuf,
    _temp_dir: tempfile::TempDir,
}

impl TaskFileRouteFixture {
    fn new() -> Self {
        Self::new_with_resolution_hook(None)
    }

    fn new_with_resolution_hook(resolution_hook: Option<Arc<dyn Fn() + Send + Sync>>) -> Self {
        let temp_dir = tempfile::tempdir().expect("create task file route fixture");
        let worktree = temp_dir.path().join("worktree");
        std::fs::create_dir_all(&worktree).expect("create route fixture worktree");
        let worktree_string = worktree.to_string_lossy().to_string();
        let repo_path = temp_dir.path().to_string_lossy().to_string();
        let mut state = super::test_state_with_seed("desktop-task-files", "Studio Mac", |db| {
            db.insert_test_repo_with_path("repo-task-files", &repo_path, "Task Files")
                .unwrap();
            for task_id in ["task-file", "task-file-no-workspace"] {
                db.insert_test_pipeline_item(
                    task_id,
                    "repo-task-files",
                    "Read task file",
                    Some("Read task file"),
                    "in progress",
                    "2026-07-15 10:00:00",
                )
                .unwrap();
            }
            db.upsert_worktree(
                "wt-task-file",
                "task-file",
                &worktree_string,
                "branch-task-file",
            )
            .unwrap();
        });
        Arc::get_mut(&mut state)
            .expect("task file route fixture owns its state")
            .task_file_resolution_hook = resolution_hook;
        let db_path = PathBuf::from(&state.config().db_path);
        let app = super::router(Arc::clone(&state));

        Self {
            app,
            state,
            worktree,
            db_path,
            _temp_dir: temp_dir,
        }
    }

    fn write(&self, path: &str, content: &[u8]) {
        let target = self.worktree.join(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("create route fixture file parent");
        }
        std::fs::write(target, content).expect("write route fixture file");
    }

    fn add_newest_worktree_with_tied_timestamp(&self) -> PathBuf {
        let newest = self._temp_dir.path().join("worktree-newest");
        std::fs::create_dir_all(&newest).expect("create newest route fixture worktree");
        let db = Db::open(self.db_path.to_str().expect("utf-8 fixture database path"))
            .expect("open task file fixture database");
        db.upsert_worktree(
            "wt-task-file-newest",
            "task-file",
            newest.to_str().expect("utf-8 newest worktree path"),
            "branch-task-file-newest",
        )
        .expect("insert newest fixture worktree");
        drop(db);

        let connection = Connection::open(&self.db_path).expect("open fixture timestamps");
        connection
            .execute(
                "UPDATE worktree SET created_at = '2026-07-16 00:00:00' WHERE pipeline_item_id = 'task-file'",
                [],
            )
            .expect("tie fixture worktree timestamps");
        newest
    }

    async fn get(&self, task_id: &str, encoded_path: &str) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/v1/tasks/{task_id}/files/content?path={encoded_path}"
                ))
                .extension(AuthenticatedTaskFileAccess)
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn get_unauthenticated(
        &self,
        task_id: &str,
        encoded_path: &str,
    ) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/v1/tasks/{task_id}/files/content?path={encoded_path}"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn get_from_a_browser(
        &self,
        task_id: &str,
        encoded_path: &str,
    ) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/v1/tasks/{task_id}/files/content?path={encoded_path}"
                ))
                .header("origin", "https://attacker.example")
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn get_through_authenticated_relay(
        &self,
        task_id: &str,
        encoded_path: &str,
    ) -> crate::http_api::HttpInvokeResponse {
        crate::http_api::dispatch_authenticated_http_invoke(
            Arc::clone(&self.state),
            "GET",
            &format!("/v1/tasks/{task_id}/files/content?path={encoded_path}"),
            serde_json::Value::Null,
        )
        .await
    }

    async fn browse_through_authenticated_relay(
        &self,
        task_id: &str,
        encoded_path: &str,
    ) -> crate::http_api::HttpInvokeResponse {
        crate::http_api::dispatch_authenticated_http_invoke(
            Arc::clone(&self.state),
            "GET",
            &format!("/v1/tasks/{task_id}/browse?path={encoded_path}&limit=100"),
            serde_json::Value::Null,
        )
        .await
    }

    async fn browse_as_desktop_loopback(
        &self,
        task_id: &str,
        encoded_path: &str,
    ) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/v1/tasks/{task_id}/browse?path={encoded_path}&limit=100"
                ))
                .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                    [127, 0, 0, 1],
                    52001,
                ))))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn browse_through_unauthenticated_tunnel(
        &self,
        task_id: &str,
        encoded_path: &str,
    ) -> crate::http_api::HttpInvokeResponse {
        crate::http_api::dispatch_http_invoke(
            Arc::clone(&self.state),
            "GET",
            &format!("/v1/tasks/{task_id}/browse?path={encoded_path}&limit=100"),
            serde_json::Value::Null,
        )
        .await
    }
    async fn post_resolve(
        &self,
        task_id: &str,
        body: serde_json::Value,
    ) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::post(format!("/v1/tasks/{task_id}/files/resolve-mentions"))
                    .header("content-type", "application/json")
                    .extension(AuthenticatedTaskFileAccess)
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn post_resolve_unauthenticated(
        &self,
        task_id: &str,
        body: serde_json::Value,
    ) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::post(format!("/v1/tasks/{task_id}/files/resolve-mentions"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn post_resolve_through_authenticated_relay(
        &self,
        task_id: &str,
        body: serde_json::Value,
    ) -> crate::http_api::HttpInvokeResponse {
        crate::http_api::dispatch_authenticated_http_invoke(
            Arc::clone(&self.state),
            "POST",
            &format!("/v1/tasks/{task_id}/files/resolve-mentions"),
            body,
        )
        .await
    }

    async fn get_as_desktop_loopback(
        &self,
        task_id: &str,
        encoded_path: &str,
    ) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/v1/tasks/{task_id}/files/content?path={encoded_path}"
                ))
                .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                    [127, 0, 0, 1],
                    52000,
                ))))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn get_through_unauthenticated_tunnel(
        &self,
        task_id: &str,
        encoded_path: &str,
    ) -> crate::http_api::HttpInvokeResponse {
        crate::http_api::dispatch_http_invoke(
            Arc::clone(&self.state),
            "GET",
            &format!("/v1/tasks/{task_id}/files/content?path={encoded_path}"),
            serde_json::Value::Null,
        )
        .await
    }
}

impl Drop for TaskFileRouteFixture {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut path = self.db_path.as_os_str().to_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(path));
        }
    }
}

async fn task_file_response_text(response: axum::response::Response) -> String {
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    String::from_utf8(body.to_vec()).unwrap()
}

#[tokio::test]
async fn task_file_resolver_route_returns_unique_and_ambiguous_matches() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("src/Unique.ts", b"unique");
    fixture.write("a/Shared.ts", b"a");
    fixture.write("b/Shared.ts", b"b");

    let response = fixture
        .post_resolve(
            "task-file",
            serde_json::json!({
                "mentions": [
                    { "path": "Unique.ts", "line": 7 },
                    { "path": "Shared.ts" }
                ]
            }),
        )
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let resolved: crate::task_files::TaskFileMentionResolution = from_slice(&body).unwrap();
    assert_eq!(resolved.mentions[0].matches[0].path, "src/Unique.ts");
    assert_eq!(resolved.mentions[0].line, Some(7));
    assert_eq!(
        resolved.mentions[1]
            .matches
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec!["a/Shared.ts", "b/Shared.ts"]
    );
}

#[tokio::test]
async fn task_directory_route_supports_authenticated_relay_dispatch() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("src/remote.ts", b"export const remote = true;\n");

    let response = fixture
        .browse_through_authenticated_relay("task-file", "src")
        .await;

    assert_eq!(response.status, StatusCode::OK.as_u16());
    assert_eq!(response.error, None);
    let body = response.body.expect("authenticated browse response body");
    assert_eq!(body["path"], "src");
    assert_eq!(body["entries"][0]["path"], "src/remote.ts");
    assert_eq!(body["entries"][0]["isDir"], false);
}

#[tokio::test]
async fn task_directory_route_allows_desktop_loopback_sidecar_requests() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("src/remote.ts", b"export const remote = true;\n");

    let response = fixture.browse_as_desktop_loopback("task-file", "src").await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let listing: serde_json::Value = from_slice(&body).unwrap();
    assert_eq!(listing["entries"][0]["path"], "src/remote.ts");
}

#[tokio::test]
async fn task_directory_route_denies_unauthenticated_tunneled_dispatch() {
    let fixture = TaskFileRouteFixture::new();
    let response = fixture
        .browse_through_unauthenticated_tunnel("task-file", "src")
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED.as_u16());
}

#[tokio::test]
async fn task_file_resolver_route_returns_per_mention_results_for_mixed_batch() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("docs/available.md", b"available");

    let response = fixture
        .post_resolve(
            "task-file",
            serde_json::json!({
                "mentions": [
                    { "path": "docs/available.md", "line": 3 },
                    { "path": "/tmp/kanna-verification.png" }
                ]
            }),
        )
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let resolved: crate::task_files::TaskFileMentionResolution = from_slice(&body).unwrap();
    assert_eq!(resolved.mentions[0].matches[0].path, "docs/available.md");
    assert_eq!(resolved.mentions[0].line, Some(3));
    assert_eq!(resolved.mentions[0].unavailable_reason, None);
    assert!(resolved.mentions[1].matches.is_empty());
    assert_eq!(
        resolved.mentions[1].unavailable_reason.as_deref(),
        Some("file path must stay within the task workspace")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn task_file_resolver_route_stays_responsive_during_blocking_resolution() {
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (probe_tx, probe_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release = Arc::new((StdMutex::new(false), Condvar::new()));
    let fixture = TaskFileRouteFixture::new_with_resolution_hook(Some(Arc::new({
        let release = Arc::clone(&release);
        move || {
            started_tx.send(()).unwrap();
            let (released, ready) = &*release;
            let mut released = released.lock().unwrap();
            while !*released {
                released = ready.wait(released).unwrap();
            }
        }
    })));
    let coordinator = std::thread::spawn({
        let release = Arc::clone(&release);
        move || {
            started_rx.recv().unwrap();
            let _ = probe_tx.send(Instant::now());
            // Held until the measurement below is taken; the ceiling is an
            // order of magnitude under this window, so load cannot mask a
            // resolution that ran on the runtime thread.
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
            let (released, ready) = &*release;
            *released.lock().unwrap() = true;
            ready.notify_all();
        }
    });

    let request = tokio::spawn(
        fixture.app.clone().oneshot(
            Request::post("/v1/tasks/task-file/files/resolve-mentions")
                .header("content-type", "application/json")
                .extension(AuthenticatedTaskFileAccess)
                .body(Body::from(
                    serde_json::json!({
                        "mentions": [{ "path": "NeverFound.ts" }]
                    })
                    .to_string(),
                ))
                .unwrap(),
        ),
    );
    let probe_sent_at = probe_rx.await.unwrap();
    tokio::time::timeout(
        // A blocked runtime never fires this timer until the hook is released
        // 10s later, so the ceiling only has to be finite and well clear of
        // scheduler noise.
        Duration::from_secs(3),
        tokio::time::sleep(Duration::from_millis(1)),
    )
    .await
    .expect("async runtime stayed responsive");
    let scheduler_delay = probe_sent_at.elapsed();
    let _ = release_tx.send(());
    coordinator.join().unwrap();
    let response = request.await.unwrap().unwrap();

    assert!(
        scheduler_delay < Duration::from_secs(3),
        "task file mention resolution blocked the async runtime for {scheduler_delay:?}"
    );
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn task_file_resolver_route_requires_task_file_access() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("src/Unique.ts", b"unique");
    let body = serde_json::json!({ "mentions": [{ "path": "Unique.ts" }] });

    let unauthenticated = fixture
        .post_resolve_unauthenticated("task-file", body.clone())
        .await;
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

    let authenticated = fixture
        .post_resolve_through_authenticated_relay("task-file", body)
        .await;
    assert_eq!(authenticated.status, StatusCode::OK.as_u16());
    assert_eq!(
        authenticated.body.unwrap()["mentions"][0]["matches"][0]["path"],
        "src/Unique.ts"
    );
}

#[tokio::test]
async fn task_file_resolver_route_maps_limits_and_missing_workspace() {
    let fixture = TaskFileRouteFixture::new();
    let oversized = fixture
        .post_resolve(
            "task-file",
            serde_json::json!({
                "mentions": (0..=crate::task_files::MAX_TASK_FILE_MENTIONS)
                    .map(|index| serde_json::json!({ "path": format!("file-{index}.ts") }))
                    .collect::<Vec<_>>()
            }),
        )
        .await;
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let unavailable = fixture
        .post_resolve(
            "task-file-no-workspace",
            serde_json::json!({ "mentions": [{ "path": "README.md" }] }),
        )
        .await;
    assert_eq!(unavailable.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn task_file_route_returns_normalized_content() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("docs/spec.md", b"# Spec\n");

    let response = fixture.get("task-file", "docs%2F.%2Fspec.md").await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let file: crate::task_files::TaskFileContent = from_slice(&body).unwrap();
    assert_eq!(file.path, "docs/spec.md");
    assert_eq!(file.content, "# Spec\n");
}

#[tokio::test]
async fn task_file_route_denies_ordinary_http_requests_before_reading_the_path() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("docs/spec.md", b"# Spec\n");

    let response = fixture
        .get_unauthenticated("task-file", "docs%2Fspec.md")
        .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(task_file_response_text(response)
        .await
        .contains("authenticated relay"));

    // A browser never reaches that check: the browser/local-client boundary
    // refuses it first, so a page cannot even probe for path behaviour.
    let from_browser = fixture
        .get_from_a_browser("task-file", "docs%2Fspec.md")
        .await;
    assert_eq!(from_browser.status(), StatusCode::FORBIDDEN);
    assert!(task_file_response_text(from_browser)
        .await
        .contains("local control credential"));
}

#[tokio::test]
async fn task_file_route_allows_desktop_loopback_requests() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("docs/spec.md", b"# Spec\n");

    let response = fixture
        .get_as_desktop_loopback("task-file", "docs%2Fspec.md")
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let file: crate::task_files::TaskFileContent = from_slice(&body).unwrap();
    assert_eq!(file.path, "docs/spec.md");
    assert_eq!(file.content, "# Spec\n");
}

#[tokio::test]
async fn task_file_route_denies_unauthenticated_tunneled_dispatch() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("docs/spec.md", b"# Spec\n");

    // Unauthenticated relay/KSP dispatches synthesize a loopback peer; the
    // tunnel marker must keep them from passing as desktop-local requests.
    let response = fixture
        .get_through_unauthenticated_tunnel("task-file", "docs%2Fspec.md")
        .await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED.as_u16());
}

#[tokio::test]
async fn task_file_route_allows_authenticated_relay_dispatch() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("docs/spec.md", b"# Spec\n");

    let response = fixture
        .get_through_authenticated_relay("task-file", "docs%2Fspec.md")
        .await;

    assert_eq!(response.status, StatusCode::OK.as_u16());
    assert_eq!(
        response.body,
        Some(serde_json::json!({
            "path": "docs/spec.md",
            "content": "# Spec\n"
        }))
    );
    assert_eq!(response.error, None);
}

#[tokio::test]
async fn task_file_route_reads_from_newest_task_worktree_when_timestamps_tie() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("docs/spec.md", b"stale workspace");
    let newest = fixture.add_newest_worktree_with_tied_timestamp();
    std::fs::create_dir_all(newest.join("docs")).unwrap();
    std::fs::write(newest.join("docs/spec.md"), "current workspace").unwrap();

    let response = fixture
        .get_through_authenticated_relay("task-file", "docs%2Fspec.md")
        .await;

    assert_eq!(response.status, StatusCode::OK.as_u16());
    assert_eq!(
        response.body,
        Some(serde_json::json!({
            "path": "docs/spec.md",
            "content": "current workspace"
        }))
    );
}

#[tokio::test]
async fn task_file_route_maps_disallowed_paths_and_directories_to_bad_request() {
    let fixture = TaskFileRouteFixture::new();
    std::fs::create_dir_all(fixture.worktree.join("docs")).unwrap();

    let traversal = fixture.get("task-file", "%2E%2E%2Foutside.md").await;
    assert_eq!(traversal.status(), StatusCode::BAD_REQUEST);
    assert!(task_file_response_text(traversal)
        .await
        .contains("stay within the task workspace"));

    let directory = fixture.get("task-file", "docs").await;
    assert_eq!(directory.status(), StatusCode::BAD_REQUEST);
    assert!(task_file_response_text(directory)
        .await
        .contains("regular file"));
}

#[tokio::test]
async fn task_file_route_maps_embedded_nul_to_bad_request() {
    let fixture = TaskFileRouteFixture::new();

    let response = fixture.get("task-file", "docs%2Fbad%00name.md").await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(task_file_response_text(response)
        .await
        .contains("stay within the task workspace"));
}

#[tokio::test]
async fn task_file_route_maps_traversal_through_regular_file_to_bad_request() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("README.md", b"read me");

    let response = fixture.get("task-file", "README.md%2Fchild.md").await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(task_file_response_text(response)
        .await
        .contains("stay within the task workspace"));
}

#[cfg(unix)]
#[tokio::test]
async fn task_file_route_maps_symlink_loop_to_bad_request() {
    let fixture = TaskFileRouteFixture::new();
    std::os::unix::fs::symlink("loop-b.md", fixture.worktree.join("loop-a.md")).unwrap();
    std::os::unix::fs::symlink("loop-a.md", fixture.worktree.join("loop-b.md")).unwrap();

    let response = fixture.get("task-file", "loop-a.md").await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(task_file_response_text(response)
        .await
        .contains("stay within the task workspace"));
}

#[cfg(unix)]
#[tokio::test]
async fn task_file_route_maps_unreadable_file_to_bad_request() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = TaskFileRouteFixture::new();
    fixture.write("private.md", b"private");
    std::fs::set_permissions(
        fixture.worktree.join("private.md"),
        std::fs::Permissions::from_mode(0o000),
    )
    .unwrap();

    let response = fixture.get("task-file", "private.md").await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(task_file_response_text(response)
        .await
        .contains("stay within the task workspace"));
}

#[tokio::test]
async fn task_file_route_maps_unknown_task_and_missing_file_to_not_found() {
    let fixture = TaskFileRouteFixture::new();

    let unknown_task = fixture.get("missing-task", "README.md").await;
    assert_eq!(unknown_task.status(), StatusCode::NOT_FOUND);
    assert!(task_file_response_text(unknown_task)
        .await
        .contains("task not found"));

    let missing_file = fixture.get("task-file", "missing.md").await;
    assert_eq!(missing_file.status(), StatusCode::NOT_FOUND);
    assert!(task_file_response_text(missing_file)
        .await
        .contains("file not found"));
}

#[tokio::test]
async fn task_file_route_maps_unavailable_workspace_to_conflict() {
    let fixture = TaskFileRouteFixture::new();

    let response = fixture.get("task-file-no-workspace", "README.md").await;

    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert!(task_file_response_text(response)
        .await
        .contains("workspace unavailable"));
}

#[tokio::test]
async fn task_file_route_maps_oversized_file_to_payload_too_large() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write(
        "large.md",
        &vec![b'x'; crate::task_files::MAX_TASK_FILE_BYTES as usize + 1],
    );

    let response = fixture.get("task-file", "large.md").await;

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(task_file_response_text(response)
        .await
        .contains("1 MiB limit"));
}

#[tokio::test]
async fn task_file_route_maps_non_utf8_file_to_unsupported_media_type() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("binary.md", &[0xff, 0xfe]);

    let response = fixture.get("task-file", "binary.md").await;

    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert!(task_file_response_text(response)
        .await
        .contains("valid UTF-8"));
}

#[tokio::test]
async fn task_file_route_maps_database_failure_to_internal_server_error() {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path().join("kanna.sqlite");
    drop(Connection::open(&db_path).unwrap());
    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: temp_dir.path().join("daemon").to_string_lossy().to_string(),
        db_path: db_path.to_string_lossy().to_string(),
        kanna_cli_path: None,
        desktop_id: "desktop-task-file-error".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: temp_dir
            .path()
            .join("pairings.json")
            .to_string_lossy()
            .to_string(),
    };
    let app = super::router(Arc::new(super::AppState::new(config)));

    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-file-error/files/content?path=README.md")
                .extension(AuthenticatedTaskFileAccess)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(task_file_response_text(response).await.contains("db error"));
}

struct TaskDiffRouteFixture {
    app: axum::Router,
    state: Arc<AppState>,
    worktree: PathBuf,
    db_path: PathBuf,
    _temp_dir: tempfile::TempDir,
}

impl TaskDiffRouteFixture {
    fn new() -> Self {
        let temp_dir = tempfile::tempdir().expect("create task diff route fixture");
        let worktree = temp_dir.path().join("worktree");
        std::fs::create_dir_all(&worktree).expect("create diff route fixture worktree");
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test User"],
        ] {
            assert!(Command::new("git")
                .current_dir(&worktree)
                .args(&args)
                .status()
                .unwrap()
                .success());
        }
        std::fs::write(worktree.join("README.md"), "hello\n").unwrap();
        for args in [vec!["add", "."], vec!["commit", "-m", "init"]] {
            assert!(Command::new("git")
                .current_dir(&worktree)
                .args(&args)
                .status()
                .unwrap()
                .success());
        }

        let worktree_string = worktree.to_string_lossy().to_string();
        let repo_path = temp_dir.path().to_string_lossy().to_string();
        let state = super::test_state_with_seed("desktop-task-diff", "Studio Mac", |db| {
            db.insert_test_repo_with_path("repo-task-diff", &repo_path, "Task Diff")
                .unwrap();
            for task_id in ["task-diff", "task-diff-no-workspace"] {
                db.insert_test_pipeline_item(
                    task_id,
                    "repo-task-diff",
                    "Diff task changes",
                    Some("Diff task changes"),
                    "in progress",
                    "2026-07-21 10:00:00",
                )
                .unwrap();
            }
            db.upsert_worktree(
                "wt-task-diff",
                "task-diff",
                &worktree_string,
                "branch-task-diff",
            )
            .unwrap();
        });
        let db_path = PathBuf::from(&state.config().db_path);
        let app = super::router(Arc::clone(&state));

        Self {
            app,
            state,
            worktree,
            db_path,
            _temp_dir: temp_dir,
        }
    }

    async fn get(&self, task_id: &str, authenticated: bool) -> axum::response::Response {
        let mut request = Request::get(format!("/v1/tasks/{task_id}/diff"))
            .body(Body::empty())
            .unwrap();
        if authenticated {
            request.extensions_mut().insert(AuthenticatedTaskFileAccess);
        }
        self.app.clone().oneshot(request).await.unwrap()
    }

    /// An unauthenticated request in a browser's shape, which the
    /// browser/local-client boundary refuses before the route is reached.
    async fn get_from_a_browser(&self, task_id: &str) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::get(format!("/v1/tasks/{task_id}/diff"))
                    .header("origin", "https://attacker.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn get_through_authenticated_relay(
        &self,
        task_id: &str,
    ) -> crate::http_api::HttpInvokeResponse {
        self.get_through_authenticated_relay_with_query(task_id, "")
            .await
    }

    async fn get_as_desktop_loopback(&self, task_id: &str) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::get(format!("/v1/tasks/{task_id}/diff"))
                    .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                        [127, 0, 0, 1],
                        52002,
                    ))))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn get_through_unauthenticated_tunnel(
        &self,
        task_id: &str,
    ) -> crate::http_api::HttpInvokeResponse {
        crate::http_api::dispatch_http_invoke(
            Arc::clone(&self.state),
            "GET",
            &format!("/v1/tasks/{task_id}/diff"),
            serde_json::Value::Null,
        )
        .await
    }

    async fn get_through_authenticated_relay_with_query(
        &self,
        task_id: &str,
        query: &str,
    ) -> crate::http_api::HttpInvokeResponse {
        crate::http_api::dispatch_authenticated_http_invoke(
            Arc::clone(&self.state),
            "GET",
            &format!("/v1/tasks/{task_id}/diff{query}"),
            serde_json::Value::Null,
        )
        .await
    }

    fn pair_device(&self, device_id: &str, device_secret: &str) {
        let store_path = std::path::PathBuf::from(&self.state.config().pairing_store_path);
        let mut store = crate::pairing::PairingStore::load(&store_path).unwrap();
        store.add_trusted_device(
            &self.state.config().desktop_id,
            device_id,
            "Kanna Mobile",
            &crate::pairing::hash_device_secret(device_secret),
        );
        store.save(&store_path).unwrap();
    }

    async fn get_with_device_headers(
        &self,
        task_id: &str,
        device_id: &str,
        device_secret: &str,
    ) -> axum::response::Response {
        let request = Request::get(format!("/v1/tasks/{task_id}/diff"))
            .header("origin", "http://kanna-mobile.local")
            .header("x-kanna-device-id", device_id)
            .header("x-kanna-device-secret", device_secret)
            .body(Body::empty())
            .unwrap();
        self.app.clone().oneshot(request).await.unwrap()
    }
}

impl Drop for TaskDiffRouteFixture {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut path = self.db_path.as_os_str().to_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(path));
        }
    }
}

#[tokio::test]
async fn task_diff_route_returns_branch_patch_with_uncommitted_changes() {
    let fixture = TaskDiffRouteFixture::new();
    std::fs::write(fixture.worktree.join("README.md"), "hello\nchanged\n").unwrap();

    let response = fixture.get("task-diff", true).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let diff: crate::task_diff::TaskDiff = from_slice(&body).unwrap();
    assert_eq!(diff.task_id, "task-diff");
    assert_eq!(diff.base_ref.as_deref(), Some("main"));
    assert!(diff.patch.contains("+changed"));
    assert!(!diff.truncated);
}

#[tokio::test]
async fn task_diff_route_denies_ordinary_http_requests() {
    let fixture = TaskDiffRouteFixture::new();

    // A non-browser request that proved nothing still fails the route's own
    // authenticated-relay check.
    let response = fixture.get("task-diff", false).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(task_file_response_text(response)
        .await
        .contains("authenticated relay"));

    // The same request from a browser never reaches the route: the
    // browser/local-client boundary refuses it first.
    let from_browser = fixture.get_from_a_browser("task-diff").await;
    assert_eq!(from_browser.status(), StatusCode::FORBIDDEN);
    assert!(task_file_response_text(from_browser)
        .await
        .contains("local control credential"));
}

#[tokio::test]
async fn task_diff_route_allows_authenticated_relay_dispatch() {
    let fixture = TaskDiffRouteFixture::new();
    std::fs::write(fixture.worktree.join("README.md"), "hello\nvia relay\n").unwrap();

    let response = fixture.get_through_authenticated_relay("task-diff").await;

    assert_eq!(response.status, StatusCode::OK.as_u16());
    let body = response.body.expect("diff body");
    assert_eq!(body["taskId"], "task-diff");
    assert!(body["patch"]
        .as_str()
        .expect("patch string")
        .contains("+via relay"));
    assert_eq!(response.error, None);
}

#[tokio::test]
async fn task_diff_route_allows_desktop_loopback_sidecar_requests() {
    let fixture = TaskDiffRouteFixture::new();
    std::fs::write(fixture.worktree.join("README.md"), "hello\nvia sidecar\n").unwrap();

    let response = fixture.get_as_desktop_loopback("task-diff").await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let diff: crate::task_diff::TaskDiff = from_slice(&body).unwrap();
    assert!(diff.patch.contains("+via sidecar"));
}

#[tokio::test]
async fn task_diff_route_denies_unauthenticated_tunneled_dispatch() {
    let fixture = TaskDiffRouteFixture::new();
    let response = fixture
        .get_through_unauthenticated_tunnel("task-diff")
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED.as_u16());
}

#[tokio::test]
async fn task_diff_route_allows_paired_lan_device_with_valid_secret() {
    let fixture = TaskDiffRouteFixture::new();
    fixture.pair_device("phone-1", "lan-secret");
    std::fs::write(fixture.worktree.join("README.md"), "hello\nvia lan\n").unwrap();

    let response = fixture
        .get_with_device_headers("task-diff", "phone-1", "lan-secret")
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let diff: crate::task_diff::TaskDiff = from_slice(&body).unwrap();
    assert!(diff.patch.contains("+via lan"));
}

#[tokio::test]
async fn task_diff_route_rejects_wrong_or_unpaired_device_secrets() {
    let fixture = TaskDiffRouteFixture::new();
    fixture.pair_device("phone-1", "lan-secret");

    // These carry an `Origin`, so an unverified secret leaves them in the
    // browser class the boundary refuses outright.
    let wrong_secret = fixture
        .get_with_device_headers("task-diff", "phone-1", "not-the-secret")
        .await;
    assert_eq!(wrong_secret.status(), StatusCode::FORBIDDEN);

    let unknown_device = fixture
        .get_with_device_headers("task-diff", "phone-2", "lan-secret")
        .await;
    assert_eq!(unknown_device.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn task_diff_route_honors_scope_and_mode_query_parameters() {
    let fixture = TaskDiffRouteFixture::new();
    std::fs::write(fixture.worktree.join("committed.txt"), "committed\n").unwrap();
    for args in [
        vec!["add", "committed.txt"],
        vec!["commit", "-m", "committed change"],
    ] {
        assert!(Command::new("git")
            .current_dir(&fixture.worktree)
            .args(&args)
            .status()
            .unwrap()
            .success());
    }
    std::fs::write(fixture.worktree.join("README.md"), "hello\nunstaged\n").unwrap();

    let response = fixture
        .get_through_authenticated_relay_with_query("task-diff", "?scope=working&mode=unstaged")
        .await;
    assert_eq!(response.status, StatusCode::OK.as_u16());
    let body = response.body.expect("diff body");
    let patch = body["patch"].as_str().expect("patch string");
    assert!(patch.contains("+unstaged"));
    assert!(!patch.contains("committed.txt"));
    assert_eq!(body["baseRef"], serde_json::Value::Null);

    let invalid = fixture
        .get_through_authenticated_relay_with_query("task-diff", "?scope=bogus")
        .await;
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST.as_u16());
}

#[tokio::test]
async fn task_diff_route_maps_missing_task_and_workspace() {
    let fixture = TaskDiffRouteFixture::new();

    let missing = fixture.get("no-such-task", true).await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    let no_workspace = fixture.get("task-diff-no-workspace", true).await;
    assert_eq!(no_workspace.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn task_logs_route_renders_agent_journal_tail() {
    let task_id = format!(
        "task-agent-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    );
    let journal_dir = PathBuf::from("/tmp/kanna-daemon").join("agent-journals");
    std::fs::create_dir_all(&journal_dir).unwrap();
    let journal_path = journal_dir.join(format!("{task_id}.ndjson"));
    let lines = [
        serde_json::to_string(&kanna_daemon::protocol::SeqAgentEvent {
            seq: 0,
            event: AgentEvent::AssistantText {
                text: "first assistant".to_string(),
                truncated: false,
            },
        })
        .unwrap(),
        serde_json::to_string(&kanna_daemon::protocol::SeqAgentEvent {
            seq: 1,
            event: AgentEvent::ToolResult {
                call_id: "call-1".to_string(),
                output: "tool output".to_string(),
                truncated: false,
                is_error: false,
            },
        })
        .unwrap(),
        serde_json::to_string(&kanna_daemon::protocol::SeqAgentEvent {
            seq: 2,
            event: AgentEvent::AssistantText {
                text: "second assistant".to_string(),
                truncated: false,
            },
        })
        .unwrap(),
    ]
    .join("\n");
    std::fs::write(&journal_path, lines).unwrap();

    let seeded_task_id = task_id.clone();
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", move |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            &seeded_task_id,
            "repo-1",
            "Read logs",
            Some("Read logs"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_agent_type(&seeded_task_id, "agent")
            .unwrap();
    });

    let response = app
        .oneshot(
            Request::get(format!("/v1/tasks/{task_id}/logs?tail=2"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&body),
        "tool result: tool output\nsecond assistant"
    );

    let _ = std::fs::remove_file(journal_path);
}

#[tokio::test]
async fn http_invoke_dispatches_shared_mobile_get_routes() {
    let state = super::test_state_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-newer",
            "repo-1",
            "newer prompt",
            Some("Newer Task"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
    });

    let repos = crate::http_api::dispatch_authenticated_http_invoke(
        Arc::clone(&state),
        "GET",
        "/v1/repos",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(repos.status, 200);
    assert_eq!(
        repos.body,
        Some(serde_json::json!([
            {
                "id": "repo-1",
                "name": "Repo One",
                "remoteUrlHash": null
            }
        ]))
    );
    assert_eq!(repos.error, None);

    let recent = crate::http_api::dispatch_authenticated_http_invoke(
        Arc::clone(&state),
        "GET",
        "/v1/tasks/recent",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(recent.status, 200);
    assert_eq!(recent.body.as_ref().unwrap()[0]["id"], "task-newer");
    assert_eq!(recent.body.as_ref().unwrap()[0]["activity"], "idle");
    assert_eq!(recent.error, None);
}

#[tokio::test]
async fn search_tasks_route_filters_by_query_text() {
    let app = super::test_router_with_seed("desktop-1", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-merge",
            "repo-1",
            "follow up on merge conflicts",
            Some("Merge Cleanup"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-other",
            "repo-1",
            "write release notes",
            Some("Docs"),
            "in progress",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-done",
            "repo-1",
            "merge old branch",
            Some("Done Merge"),
            "done",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.close_pipeline_item("task-done").unwrap();
    });

    let response = app
        .oneshot(
            Request::get("/v1/tasks/search?query=merge")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let tasks: Vec<crate::mobile_api::TaskSummary> = from_slice(&body).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "task-merge");
    assert_eq!(tasks[0].title, "Merge Cleanup");
    assert_eq!(tasks[0].activity.as_deref(), Some("idle"));
}

#[tokio::test]
async fn create_pairing_session_route_returns_pairing_payload() {
    let app = super::test_router("desktop-1", "Studio Mac");
    let response = app
        .oneshot(pairing_create_request([127, 0, 0, 1]))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let pairing: crate::pairing::PairingSession = from_slice(&body).unwrap();
    assert_eq!(pairing.desktop_id, "desktop-1");
    assert_eq!(pairing.desktop_name, "Studio Mac");
    assert_eq!(pairing.lan_port, 48120);
    assert_eq!(pairing.code.len(), 6);
    assert_eq!(
        pairing.pairing_payload,
        format!("KANNA1:DESKTOP-1:{}", pairing.code)
    );
}

#[tokio::test]
async fn create_pairing_session_route_rejects_lan_clients() {
    let response = super::test_router("desktop-private-pairing", "Private Mac")
        .oneshot(pairing_create_request([192, 168, 1, 42]))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn create_pairing_session_route_rejects_authenticated_relay_dispatch() {
    let response = crate::http_api::dispatch_authenticated_http_invoke(
        super::test_state_with_seed("desktop-1", "Studio Mac", |_| {}),
        "POST",
        "/v1/pairing/sessions",
        serde_json::Value::Null,
    )
    .await;

    assert_eq!(response.status, StatusCode::FORBIDDEN.as_u16());
    assert!(response
        .error
        .as_deref()
        .is_some_and(|message| message.contains("desktop app")));
}

#[tokio::test]
async fn desktop_trusted_device_removal_is_persisted_with_push_revocation() {
    let state = super::test_state_with_seed("desktop-remove-pairing", "Remove Mac", |_| {});
    let pairing_path = std::path::PathBuf::from(&state.config().pairing_store_path);
    let mut store = crate::pairing::PairingStore::default();
    store.add_trusted_device(
        "desktop-remove-pairing",
        "phone-1",
        "Phone",
        &crate::pairing::hash_device_secret("secret"),
    );
    store
        .trusted_devices
        .get_mut("desktop-remove-pairing")
        .and_then(|devices| devices.first_mut())
        .expect("trusted phone")
        .push_identity_public_key = Some("desktop-public-key".to_string());
    store.save(&pairing_path).unwrap();

    let response = crate::http_api::router(Arc::clone(&state))
        .oneshot(pairing_remove_request("phone-1", [127, 0, 0, 1]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let persisted = crate::pairing::PairingStore::load(&pairing_path).unwrap();
    assert!(!persisted.is_trusted("desktop-remove-pairing", "phone-1"));
    assert_eq!(
        persisted.pending_anonymous_push_revocations,
        vec![crate::pairing::PendingAnonymousPushRevocation {
            desktop_public_key: "desktop-public-key".to_string(),
            device_id: "phone-1".to_string(),
        }]
    );
    let _ = std::fs::remove_file(pairing_path);
}

#[tokio::test]
async fn pairing_claim_route_is_single_use() {
    let app = super::test_router("desktop-claim", "Claim Mac");
    let create_response = app
        .clone()
        .oneshot(pairing_create_request([127, 0, 0, 1]))
        .await
        .unwrap();
    let create_body = axum::body::to_bytes(create_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let pairing: crate::pairing::PairingSession = from_slice(&create_body).unwrap();

    let claim_body = serde_json::json!({
        "code": pairing.code,
        "deviceId": "phone-1",
        "deviceName": "Kanna Mobile"
    })
    .to_string();
    let claim_response = app
        .clone()
        .oneshot(
            Request::post("/v1/pairing/sessions/claim")
                .header("content-type", "application/json")
                .body(Body::from(claim_body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(claim_response.status(), StatusCode::OK);
    let claim_response_body = axum::body::to_bytes(claim_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let claimed: serde_json::Value = from_slice(&claim_response_body).unwrap();
    assert_eq!(claimed["desktopId"], "desktop-claim");
    assert_eq!(claimed["desktopName"], "Claim Mac");

    let replay_response = app
        .oneshot(
            Request::post("/v1/pairing/sessions/claim")
                .header("content-type", "application/json")
                .body(Body::from(claim_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(replay_response.status(), StatusCode::CONFLICT);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_legacy_pairing_certificate_reissues_preserve_every_device_marker() {
    let state =
        super::test_state_with_seed("desktop-concurrent-reissues", "Concurrent Mac", |_| {});
    let store_path = PathBuf::from(&state.config().pairing_store_path);
    let devices = [
        ("legacy-phone-1", "legacy-secret-1"),
        ("legacy-phone-2", "legacy-secret-2"),
        ("legacy-phone-3", "legacy-secret-3"),
        ("legacy-phone-4", "legacy-secret-4"),
    ];
    let mut store = crate::pairing::PairingStore::default();
    for (device_id, secret) in devices {
        store.add_trusted_device(
            &state.config().desktop_id,
            device_id,
            "Legacy Kanna Mobile",
            &crate::pairing::hash_device_secret(secret),
        );
    }
    store.save(&store_path).unwrap();

    let mutation_guard = Arc::clone(&state.pairing_persistence_mutation)
        .lock_owned()
        .await;
    let app = super::router(Arc::clone(&state));
    let mut reissues = Vec::new();
    for (device_id, secret) in devices {
        let app = app.clone();
        reissues.push(tokio::spawn(async move {
            app.oneshot(pairing_reissue_request(device_id, secret))
                .await
                .unwrap()
        }));
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        reissues.iter().all(|request| !request.is_finished()),
        "every reissue must wait at the shared pairing-store mutation boundary"
    );
    let authenticated_read = tokio::time::timeout(
        Duration::from_secs(1),
        app.clone().oneshot(
            Request::get("/v1/status")
                .header("x-kanna-device-id", "legacy-phone-1")
                .header("x-kanna-device-secret", "legacy-secret-1")
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .expect("read-only authentication must not wait for pairing-store mutation")
    .unwrap();
    let authenticated_body = axum::body::to_bytes(authenticated_read.into_body(), usize::MAX)
        .await
        .unwrap();
    let authenticated_status: MobileServerStatus = from_slice(&authenticated_body).unwrap();
    assert_eq!(authenticated_status.state, "running");
    drop(mutation_guard);

    for reissue in reissues {
        assert_eq!(reissue.await.unwrap().status(), StatusCode::OK);
    }
    let persisted = crate::pairing::PairingStore::load(&store_path).unwrap();
    let persisted_devices = persisted
        .trusted_devices
        .get(&state.config().desktop_id)
        .unwrap();
    for (device_id, _) in devices {
        assert!(
            persisted_devices.iter().any(|device| {
                device.device_id == device_id && device.push_identity_public_key.is_some()
            }),
            "reissued identity marker was not persisted for {device_id}"
        );
    }

    let _ = std::fs::remove_file(&store_path);
    let _ = std::fs::remove_file(format!(
        "{}.anonymous-push-identity.json",
        store_path.display()
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pairing_claim_racing_legacy_reissue_preserves_secret_and_both_markers() {
    let state = super::test_state_with_seed("desktop-claim-reissue-race", "Race Mac", |_| {});
    let store_path = PathBuf::from(&state.config().pairing_store_path);
    let mut store = crate::pairing::PairingStore::default();
    store.add_trusted_device(
        &state.config().desktop_id,
        "legacy-phone",
        "Legacy Kanna Mobile",
        &crate::pairing::hash_device_secret("legacy-secret"),
    );
    store.save(&store_path).unwrap();
    let app = super::router(Arc::clone(&state));
    let created = app
        .clone()
        .oneshot(pairing_create_request([127, 0, 0, 1]))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let created_body = axum::body::to_bytes(created.into_body(), usize::MAX)
        .await
        .unwrap();
    let session: crate::pairing::PairingSession = from_slice(&created_body).unwrap();

    let mutation_guard = Arc::clone(&state.pairing_persistence_mutation)
        .lock_owned()
        .await;
    let claim_app = app.clone();
    let claim = tokio::spawn(async move {
        claim_app
            .oneshot(
                Request::post("/v1/pairing/sessions/claim")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "code": session.code,
                            "deviceId": "new-phone",
                            "deviceName": "New Kanna Mobile"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap()
    });
    let reissue = tokio::spawn(async move {
        app.oneshot(pairing_reissue_request("legacy-phone", "legacy-secret"))
            .await
            .unwrap()
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !claim.is_finished() && !reissue.is_finished(),
        "claim and reissue must wait at the same pairing-store mutation boundary"
    );
    drop(mutation_guard);

    let claim_response = claim.await.unwrap();
    assert_eq!(claim_response.status(), StatusCode::OK);
    let claim_body = axum::body::to_bytes(claim_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let claimed: serde_json::Value = from_slice(&claim_body).unwrap();
    let claimed_secret = claimed["deviceSecret"].as_str().unwrap();
    assert_eq!(reissue.await.unwrap().status(), StatusCode::OK);

    let authenticated = super::router(Arc::clone(&state))
        .oneshot(
            Request::get("/v1/status")
                .header("x-kanna-device-id", "new-phone")
                .header("x-kanna-device-secret", claimed_secret)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let authenticated_body = axum::body::to_bytes(authenticated.into_body(), usize::MAX)
        .await
        .unwrap();
    let status: MobileServerStatus = from_slice(&authenticated_body).unwrap();
    assert_eq!(status.state, "running");

    let persisted = crate::pairing::PairingStore::load(&store_path).unwrap();
    let persisted_devices = persisted
        .trusted_devices
        .get(&state.config().desktop_id)
        .unwrap();
    for device_id in ["legacy-phone", "new-phone"] {
        assert!(
            persisted_devices.iter().any(|device| {
                device.device_id == device_id && device.push_identity_public_key.is_some()
            }),
            "identity marker was not persisted for {device_id}"
        );
    }

    let _ = std::fs::remove_file(&store_path);
    let _ = std::fs::remove_file(format!(
        "{}.anonymous-push-identity.json",
        store_path.display()
    ));
}

#[tokio::test]
async fn create_pairing_session_route_uses_local_identity_without_desktop_secret() {
    let daemon_dir =
        std::env::temp_dir().join(format!("kanna-http-local-pairing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&daemon_dir);

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: daemon_dir.to_string_lossy().to_string(),
        db_path: crate::db::Db::test_db_path("http-local-pairing"),
        kanna_cli_path: None,
        desktop_id: "desktop-local".to_string(),
        desktop_secret: None,
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "127.0.0.1".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        activity_event_debounce_seconds: 300,
        pairing_store_path: PathBuf::from("/tmp/kanna-pairings-http-local.json")
            .to_string_lossy()
            .to_string(),
    };
    let _ = crate::db::Db::open_for_tests(&config.db_path).unwrap();
    let app = super::router(Arc::new(super::AppState::new(config)));

    let response = app
        .oneshot(pairing_create_request([127, 0, 0, 1]))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let pairing: crate::pairing::PairingSession = from_slice(&body).unwrap();
    assert_eq!(pairing.desktop_id, "desktop-local");
    assert_eq!(pairing.desktop_name, "Studio Mac");
    assert_eq!(pairing.code.len(), 6);

    let _ = std::fs::remove_dir_all(daemon_dir);
}

#[tokio::test]
async fn paired_lan_client_pages_a_real_task_worktree_fixture() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("src/main.rs", b"fn one() {}\nfn two() {}\nfn three() {}\n");
    let pairing_path = PathBuf::from(&fixture.state.config().pairing_store_path);
    let mut pairing_store = crate::pairing::PairingStore::default();
    pairing_store.add_trusted_device(
        &fixture.state.config().desktop_id,
        "phone-browser",
        "Kanna Mobile",
        &crate::pairing::hash_device_secret("browser-secret"),
    );
    pairing_store.save(&pairing_path).unwrap();

    let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = super::router(Arc::clone(&fixture.state));
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let lan_ip = if_addrs::get_if_addrs()
        .unwrap()
        .into_iter()
        .map(|interface| interface.ip())
        .find(|ip| ip.is_ipv4() && !ip.is_loopback())
        .expect("test host must expose a non-loopback IPv4 address");
    let base_url = format!("http://{lan_ip}:{port}");
    let client = reqwest::Client::new();
    let missing_credentials = client
        .get(format!(
            "{base_url}/v1/tasks/task-file/files/content?path=src%2Fmain.rs"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(
        missing_credentials.status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    let invalid_credentials = client
        .get(format!(
            "{base_url}/v1/tasks/task-file/files/content?path=src%2Fmain.rs"
        ))
        .header("x-kanna-device-id", "phone-browser")
        .header("x-kanna-device-secret", "wrong-secret")
        .send()
        .await
        .unwrap();
    assert_eq!(
        invalid_credentials.status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    let directory = client
        .get(format!(
            "{base_url}/v1/tasks/task-file/browse?path=src&limit=1"
        ))
        .header("x-kanna-device-id", "phone-browser")
        .header("x-kanna-device-secret", "browser-secret")
        .send()
        .await
        .unwrap();
    assert_eq!(directory.status(), reqwest::StatusCode::OK);
    let listing: serde_json::Value = directory.json().await.unwrap();
    assert_eq!(listing["entries"][0]["path"], "src/main.rs");

    let range = client
        .get(format!(
            "{base_url}/v1/tasks/task-file/browse/content?path=src%2Fmain.rs&startLine=1&lineCount=1"
        ))
        .header("x-kanna-device-id", "phone-browser")
        .header("x-kanna-device-secret", "browser-secret")
        .send()
        .await
        .unwrap();
    assert_eq!(range.status(), reqwest::StatusCode::OK);
    let content: serde_json::Value = range.json().await.unwrap();
    assert_eq!(content["lines"], serde_json::json!(["fn two() {}"]));

    let file = client
        .get(format!(
            "{base_url}/v1/tasks/task-file/files/content?path=src%2Fmain.rs"
        ))
        .header("x-kanna-device-id", "phone-browser")
        .header("x-kanna-device-secret", "browser-secret")
        .send()
        .await
        .unwrap();
    assert_eq!(file.status(), reqwest::StatusCode::OK);
    let file_body: serde_json::Value = file.json().await.unwrap();
    assert_eq!(file_body["path"], "src/main.rs");
    assert_eq!(
        file_body["content"],
        "fn one() {}\nfn two() {}\nfn three() {}\n"
    );

    let mentions = client
        .post(format!(
            "{base_url}/v1/tasks/task-file/files/resolve-mentions"
        ))
        .header("content-type", "application/json")
        .header("x-kanna-device-id", "phone-browser")
        .header("x-kanna-device-secret", "browser-secret")
        .json(&serde_json::json!({
            "mentions": [{ "path": "main.rs", "line": 2 }]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(mentions.status(), reqwest::StatusCode::OK);
    let mentions_body: serde_json::Value = mentions.json().await.unwrap();
    assert_eq!(
        mentions_body["mentions"][0]["matches"][0]["path"],
        "src/main.rs"
    );

    let huge_line = "z".repeat(crate::repo_browser::FILE_RANGE_BYTES * 3 + 17_000);
    fixture.write("src/huge.txt", huge_line.as_bytes());
    let mut reconstructed = String::new();
    let mut start_line = 0_u64;
    let mut start_byte = 0_u64;
    let mut range_requests = 0;
    loop {
        let response = client
            .get(format!("{base_url}/v1/tasks/task-file/browse/content?path=src%2Fhuge.txt&startLine={start_line}&startByte={start_byte}&lineCount=1"))
            .header("x-kanna-device-id", "phone-browser")
            .header("x-kanna-device-secret", "browser-secret")
            .send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        range_requests += 1;
        let fragment = body["lines"][0].as_str().unwrap_or("");
        assert!(fragment.len() <= crate::repo_browser::FILE_RANGE_BYTES);
        reconstructed.push_str(fragment);
        let Some(next_line) = body["nextLine"].as_u64() else {
            break;
        };
        start_line = next_line;
        start_byte = body["nextByte"].as_u64().unwrap_or(0);
    }
    assert!(range_requests >= 4);
    assert_eq!(reconstructed, huge_line);

    #[cfg(unix)]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        let outside = fixture._temp_dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("value.txt"), "SECRET-OUTSIDE").unwrap();
        std::os::unix::fs::symlink(&outside, fixture.worktree.join("escape")).unwrap();
        let escaped = client
            .get(format!(
                "{base_url}/v1/tasks/task-file/browse/content?path=escape%2Fvalue.txt"
            ))
            .header("x-kanna-device-id", "phone-browser")
            .header("x-kanna-device-secret", "browser-secret")
            .send()
            .await
            .unwrap();
        assert_eq!(escaped.status(), reqwest::StatusCode::BAD_REQUEST);

        let swap = fixture.worktree.join("swap");
        let held = fixture.worktree.join("swap-held");
        std::fs::create_dir(&swap).unwrap();
        std::fs::write(swap.join("value.txt"), "SAFE-INSIDE").unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let swap_running = Arc::clone(&running);
        let swap_path = swap.clone();
        let held_path = held.clone();
        let outside_path = outside.clone();
        let swapper = std::thread::spawn(move || {
            while swap_running.load(Ordering::Relaxed) {
                if std::fs::rename(&swap_path, &held_path).is_ok() {
                    let _ = std::os::unix::fs::symlink(&outside_path, &swap_path);
                    let _ = std::fs::remove_file(&swap_path);
                    let _ = std::fs::rename(&held_path, &swap_path);
                }
            }
        });
        for _ in 0..100 {
            let response = client
                .get(format!(
                    "{base_url}/v1/tasks/task-file/browse/content?path=swap%2Fvalue.txt"
                ))
                .header("x-kanna-device-id", "phone-browser")
                .header("x-kanna-device-secret", "browser-secret")
                .send()
                .await
                .unwrap();
            if response.status() == reqwest::StatusCode::OK {
                let body: serde_json::Value = response.json().await.unwrap();
                assert_eq!(body["lines"], serde_json::json!(["SAFE-INSIDE"]));
            } else {
                assert!(matches!(
                    response.status(),
                    reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::NOT_FOUND
                ));
            }
        }
        running.store(false, Ordering::Relaxed);
        swapper.join().unwrap();
    }
    server.abort();
    let _ = std::fs::remove_file(pairing_path);
}

const LAN_AUTH_REFUSAL: &str =
    "privileged control requires desktop loopback, a paired LAN device, or an authenticated relay";

// Read the actual registrations, rather than maintaining a second route list
// that could silently miss a newly mounted endpoint. Exercise every method,
// including implicit HEAD and preflight, through the production router.
#[tokio::test]
async fn every_registered_http_route_denies_unpaired_lan_by_default() {
    let app = super::test_router("desktop-route-audit", "Route Audit");
    let source = include_str!("../router.rs");
    for mount in [".merge(", ".nest(", ".nest_service(", ".route_service("] {
        assert!(
            !source.contains(mount),
            "extend the route audit to enumerate {mount} mounts"
        );
    }
    let spec = include_str!("../../../../../docs/task-specs/c9f5721b.md");
    let mut count = 0;
    for registration in source.split(".route(").skip(1) {
        let pattern = registration.split('"').nth(1).expect("literal route path");
        assert!(
            spec.contains(&format!("`{pattern}`")),
            "unaudited route {pattern}"
        );
        let mut path = pattern.to_string();
        while let Some(start) = path.find('{') {
            let end = path[start..].find('}').unwrap() + start;
            path.replace_range(start..=end, "auth-audit-missing");
        }
        for method in ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
            if matches!(
                (method, pattern),
                ("GET" | "HEAD", "/v1/status" | "/v1/stream" | "/v2/stream")
                    | ("POST", "/v1/pairing/sessions/claim")
            ) {
                continue;
            }
            for secret in [None, Some("invalid-secret")] {
                let mut request = direct_lan_request(method.parse().unwrap(), &path);
                if let Some(secret) = secret {
                    request
                        .headers_mut()
                        .insert("x-kanna-device-id", "phone".parse().unwrap());
                    request
                        .headers_mut()
                        .insert("x-kanna-device-secret", secret.parse().unwrap());
                }
                let response = app.clone().oneshot(request).await.unwrap();
                assert_eq!(
                    response.status(),
                    StatusCode::UNAUTHORIZED,
                    "{method} {pattern}"
                );
                let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap();
                if method == "HEAD" {
                    assert!(body.is_empty());
                } else {
                    assert_eq!(&body[..], LAN_AUTH_REFUSAL.as_bytes(), "{method} {pattern}");
                }
            }
        }
        count += 1;
    }
    assert!(
        count > 90,
        "route enumeration unexpectedly empty/incomplete"
    );
}

#[tokio::test]
async fn lan_settings_and_repository_data_require_pairing_and_preserve_loopback() {
    let state = super::test_state_with_seed("desktop-data-auth", "Data Auth", |db| {
        db.insert_test_repo("repo-auth", "Private Repository")
            .unwrap();
        db.set_setting("private-setting", "private-value").unwrap();
    });
    let pairing_path = PathBuf::from(&state.config().pairing_store_path);
    let mut store = crate::pairing::PairingStore::default();
    store.add_trusted_device(
        &state.config().desktop_id,
        "phone",
        "Phone",
        &crate::pairing::hash_device_secret("secret"),
    );
    store.save(&pairing_path).unwrap();
    let app = crate::http_api::router(Arc::clone(&state));
    for (method, path, payload) in [
        ("GET", "/v1/settings/private-setting", "{}"),
        (
            "PUT",
            "/v1/settings/private-setting",
            r#"{"value":"private-value"}"#,
        ),
        ("DELETE", "/v1/settings/delete-me", "{}"),
        ("GET", "/v1/repos", "{}"),
        (
            "PATCH",
            "/v1/repos/repo-auth",
            r#"{"name":"Private Repository"}"#,
        ),
        (
            "POST",
            "/v1/repos/actions/reorder",
            r#"{"orderedIds":["repo-auth"]}"#,
        ),
        ("GET", "/v1/repos/repo-auth/tasks", "{}"),
        ("GET", "/v1/repos/repo-auth/recent-workflows", "{}"),
        ("GET", "/v1/repos/repo-auth/recent-pipelines", "{}"),
        ("GET", "/v1/snapshot", "{}"),
        ("GET", "/v1/desktops", "{}"),
        ("GET", "/v1/analytics/repos/repo-auth", "{}"),
        ("GET", "/v1/tasks/recent", "{}"),
        ("GET", "/v1/tasks/search?query=private", "{}"),
        ("GET", "/v1/tasks/closed-identities", "{}"),
        (
            "GET",
            "/v1/task-events?repoId=repo-auth&timeoutSecs=0&localOnly=true",
            "{}",
        ),
        ("POST", "/v1/operator-events", r#"{"events":[]}"#),
    ] {
        for caller in ["unpaired", "paired", "loopback"] {
            let mut request = direct_lan_request(method.parse().unwrap(), path);
            *request.body_mut() = Body::from(payload);
            if caller == "paired" {
                request
                    .headers_mut()
                    .insert("x-kanna-device-id", "phone".parse().unwrap());
                request
                    .headers_mut()
                    .insert("x-kanna-device-secret", "secret".parse().unwrap());
            } else if caller == "loopback" {
                request.extensions_mut().insert(axum::extract::ConnectInfo(
                    std::net::SocketAddr::from(([127, 0, 0, 1], 49152)),
                ));
            }
            let response = app.clone().oneshot(request).await.unwrap();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            if caller == "unpaired" {
                assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
                assert_eq!(&body[..], LAN_AUTH_REFUSAL.as_bytes());
            } else {
                assert!(
                    status.is_success(),
                    "{caller} {method} {path}: {status} {}",
                    String::from_utf8_lossy(&body)
                );
            }
        }
        let unauthenticated = crate::http_api::dispatch_http_invoke(
            Arc::clone(&state),
            method,
            path,
            serde_json::from_str(payload).unwrap(),
        )
        .await;
        assert_eq!(
            unauthenticated.status, 401,
            "untrusted tunnel {method} {path}"
        );
        let authenticated = crate::http_api::dispatch_authenticated_http_invoke(
            Arc::clone(&state),
            method,
            path,
            serde_json::from_str(payload).unwrap(),
        )
        .await;
        assert!(
            (200..300).contains(&authenticated.status),
            "trusted tunnel {method} {path}: {authenticated:?}"
        );
    }
    std::fs::remove_file(pairing_path).unwrap();
}

#[tokio::test]
async fn real_lan_http_and_both_stream_versions_require_pairing() {
    use futures_util::{SinkExt, StreamExt};
    use kanna_agent_protocol::{ClientFrame, ServerFrame};
    use tokio_tungstenite::tungstenite::Message;

    let state = super::test_state_with_seed("desktop-wire-auth", "Wire Auth", |db| {
        db.set_setting("canary", "secret-setting").unwrap();
        db.insert_test_repo("repo-canary", "Secret Repo").unwrap();
    });
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let lan_ip = if_addrs::get_if_addrs()
        .unwrap()
        .into_iter()
        .map(|interface| interface.ip())
        .find(|ip| ip.is_ipv4() && !ip.is_loopback())
        .expect("non-loopback test interface");
    let app = crate::http_api::router(Arc::clone(&state));
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://{lan_ip}:{port}");
    let pairing: serde_json::Value = client
        .post(format!("http://127.0.0.1:{port}/v1/pairing/sessions"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    for path in ["/v1/settings/canary", "/v1/repos"] {
        let response = client.get(format!("{base}{path}")).send().await.unwrap();
        assert_eq!(response.status(), 401);
        assert_eq!(response.text().await.unwrap(), LAN_AUTH_REFUSAL);
    }
    let claim: serde_json::Value = client.post(format!("{base}/v1/pairing/sessions/claim"))
        .json(&serde_json::json!({"code": pairing["code"], "deviceId": "wire-phone", "deviceName": "Phone"}))
        .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    let secret = claim["deviceSecret"].as_str().unwrap();
    for path in ["/v1/settings/canary", "/v1/repos"] {
        let response = client
            .get(format!("{base}{path}"))
            .header("x-kanna-device-id", "wire-phone")
            .header("x-kanna-device-secret", secret)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let body = response.text().await.unwrap();
        assert!(body.contains(if path.contains("settings") {
            "secret-setting"
        } else {
            "Secret Repo"
        }));
    }
    for version in ["v1", "v2"] {
        for credential in [
            None,
            Some("invalid".to_string()),
            Some(serde_json::json!({"deviceId":"wire-phone", "deviceSecret":secret}).to_string()),
        ] {
            let paired = credential
                .as_ref()
                .is_some_and(|value| value.starts_with('{'));
            let (mut socket, _) =
                tokio_tungstenite::connect_async(format!("ws://{lan_ip}:{port}/{version}/stream"))
                    .await
                    .unwrap();
            socket
                .send(Message::Text(
                    serde_json::to_string(&ClientFrame::Auth {
                        credential,
                        capabilities: vec![],
                    })
                    .unwrap()
                    .into(),
                ))
                .await
                .unwrap();
            let message = tokio::time::timeout(Duration::from_secs(30), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let frame: ServerFrame = serde_json::from_str(message.to_text().unwrap()).unwrap();
            if paired {
                assert!(
                    matches!(frame, ServerFrame::AuthOk { .. }),
                    "{version}: {frame:?}"
                );
                socket.close(None).await.unwrap();
            } else {
                assert!(
                    matches!(frame, ServerFrame::Error { ref code, .. } if code == "unauthorized"),
                    "{version}: {frame:?}"
                );
            }
        }
    }
    // Older paired v1 readers may authenticate only the HTTP upgrade. Keep
    // their established read-only access without reopening empty-auth LAN.
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let paired_status = client
        .get(format!("{base}/v1/status"))
        .header("x-kanna-device-id", "wire-phone")
        .header("x-kanna-device-secret", secret)
        .send()
        .await
        .unwrap();
    let cookie = paired_status.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    for use_cookie in [false, true] {
        let mut upgrade = format!("ws://{lan_ip}:{port}/v1/stream")
            .into_client_request()
            .unwrap();
        if use_cookie {
            upgrade
                .headers_mut()
                .insert("cookie", cookie.parse().unwrap());
        } else {
            upgrade
                .headers_mut()
                .insert("x-kanna-device-id", "wire-phone".parse().unwrap());
            upgrade
                .headers_mut()
                .insert("x-kanna-device-secret", secret.parse().unwrap());
        }
        let (mut socket, _) = tokio_tungstenite::connect_async(upgrade).await.unwrap();
        for (frame, expected) in [
            (
                ClientFrame::Auth {
                    credential: None,
                    capabilities: vec![],
                },
                "auth_ok",
            ),
            (
                ClientFrame::Request {
                    id: 1,
                    method: "PUT".into(),
                    path: "/v1/settings/canary".into(),
                    body: Some(serde_json::json!({"value":"forged"})),
                },
                "error",
            ),
        ] {
            socket
                .send(Message::Text(serde_json::to_string(&frame).unwrap().into()))
                .await
                .unwrap();
            let message = tokio::time::timeout(Duration::from_secs(30), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let response: serde_json::Value =
                serde_json::from_str(message.to_text().unwrap()).unwrap();
            assert_eq!(response["type"], expected);
            if expected == "error" {
                assert_eq!(response["code"], "unauthorized");
            }
        }
        socket.close(None).await.unwrap();
    }
    server.abort();
    let _ = server.await;
    std::fs::remove_file(&state.config().pairing_store_path).unwrap();
}

#[tokio::test]
async fn lan_repository_filesystem_and_definition_routes_require_pairing() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.tmp");
    std::fs::create_dir_all(&root).unwrap();
    let temp = tempfile::tempdir_in(root).unwrap();
    let repo = temp.path().join("repo");
    init_test_git_repo(&repo);
    let agent_dir = repo.join(".kanna/agents/auth-fixture");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nname: auth-fixture\ndescription: Authorization fixture\n---\nFixture agent\n",
    )
    .unwrap();
    for args in [
        vec!["add", "."],
        vec!["commit", "-m", "agent fixture"],
        vec!["remote", "add", "origin", repo.to_str().unwrap()],
    ] {
        assert!(Command::new("git")
            .args(args)
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());
    }
    publish_test_origin_main(&repo);
    let mut state = super::test_state_with_seed("desktop-repo-auth", "Repo Auth", |db| {
        db.insert_test_repo_with_path("repo-auth", repo.to_str().unwrap(), "Repo Auth")
            .unwrap();
        db.insert_test_pipeline_item(
            "task-auth",
            "repo-auth",
            "Auth fixture",
            Some("Auth"),
            "in progress",
            "2026-09-05 00:00:00",
        )
        .unwrap();
    });
    Db::open(&state.config().db_path)
        .unwrap()
        .update_test_pipeline_item_branch("task-auth", "main")
        .unwrap();
    let mutable = Arc::get_mut(&mut state).unwrap();
    mutable.repo_checkout_root = temp.path().join("checkouts");
    mutable.task_creator = Some(Arc::new(|request| {
        Ok(CreateTaskResponse {
            task_id: "created-auth-command".into(),
            repo_id: request.repo_id,
            title: "Auth command".into(),
            prompt: request.prompt,
            stage: "in progress".into(),
            agent_type: "pty".into(),
            worktree_path: None,
        })
    }));
    let mut store = crate::pairing::PairingStore::default();
    store.add_trusted_device(
        &state.config().desktop_id,
        "phone",
        "Phone",
        &crate::pairing::hash_device_secret("secret"),
    );
    store
        .save(Path::new(&state.config().pairing_store_path))
        .unwrap();
    let app = crate::http_api::router(Arc::clone(&state));
    async fn check(
        app: &axum::Router,
        method: &str,
        path: &str,
        payload: serde_json::Value,
    ) -> serde_json::Value {
        let mut value = serde_json::Value::Null;
        for paired in [false, true] {
            let mut request = direct_lan_request(method.parse().unwrap(), path);
            *request.body_mut() = Body::from(payload.to_string());
            if paired {
                request
                    .headers_mut()
                    .insert("x-kanna-device-id", "phone".parse().unwrap());
                request
                    .headers_mut()
                    .insert("x-kanna-device-secret", "secret".parse().unwrap());
            }
            let response = app.clone().oneshot(request).await.unwrap();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            if paired {
                assert!(
                    status.is_success(),
                    "{method} {path}: {status} {}",
                    String::from_utf8_lossy(&body)
                );
                value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
            } else {
                assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
                assert_eq!(&body[..], LAN_AUTH_REFUSAL.as_bytes());
            }
        }
        value
    }
    for path in [
        "/v1/repos/repo-auth/agents",
        "/v1/repos/repo-auth/agent-providers",
        "/v1/repos/repo-auth/kanna-definitions",
        "/v1/repos/repo-auth/kanna-definitions/workflows/test-provider-neutral",
        "/v1/repos/repo-auth/kanna-definitions/pipelines/test-provider-neutral",
        "/v1/repos/repo-auth/kanna-definitions/agents/auth-fixture",
        "/v1/tasks/task-auth",
        "/v1/tasks/task-auth/children",
        "/v1/tasks/task-auth/inputs",
        "/v1/tasks/task-auth/logs",
        "/v1/tasks/task-auth/dependent-tasks-exist",
        "/v1/repo-singletons/no-such-remote/auth-fixture",
    ] {
        check(&app, "GET", path, serde_json::json!({})).await;
    }
    check(
        &app,
        "GET",
        &format!("/v1/repos/by-path?path={}", repo.display()),
        serde_json::json!({}),
    )
    .await;
    check(
        &app,
        "POST",
        "/v1/repos/repo-auth/reconcile-metadata",
        serde_json::json!({"apply":false}),
    )
    .await;
    check(
        &app,
        "POST",
        "/v1/repos/repo-auth/fetch-origin",
        serde_json::json!({}),
    )
    .await;
    check(
        &app,
        "POST",
        "/v1/window-workspace/mutations",
        serde_json::json!({"operation":"remove","windowId":"absent"}),
    )
    .await;
    check(&app, "POST", "/v1/backup", serde_json::json!({})).await;
    let catalog = check(
        &app,
        "GET",
        "/v1/repos/repo-auth/commands",
        serde_json::json!({}),
    )
    .await;
    check(
        &app,
        "POST",
        "/v1/repos/repo-auth/commands/factory:create-agent/run",
        serde_json::json!({"catalogRevision":catalog["revision"]}),
    )
    .await;
    let added_repo = temp.path().join("added");
    init_test_git_repo(&added_repo);
    check(
        &app,
        "POST",
        "/v1/repos",
        serde_json::json!({"path":added_repo,"name":"Added"}),
    )
    .await;
    use sha2::{Digest, Sha256};
    let remote = format!("file://{}", repo.display());
    let operation = check(&app, "POST", "/v1/repo-checkouts", serde_json::json!({"name":"checkout","remoteUrl":remote,"remoteUrlHash":format!("{:x}",Sha256::digest(remote.as_bytes()))})).await;
    let operation_id = operation["id"].as_str().unwrap();
    let completed = wait_for_repo_checkout(&app, operation_id).await;
    assert_eq!(completed["state"], "done");
    check(
        &app,
        "GET",
        &format!("/v1/repo-checkouts/{operation_id}"),
        serde_json::json!({}),
    )
    .await;
    std::fs::remove_file(&state.config().pairing_store_path).unwrap();
}
