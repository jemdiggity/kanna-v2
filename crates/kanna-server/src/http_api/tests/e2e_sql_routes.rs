use super::*;
use axum::extract::connect_info::ConnectInfo;
use serde_json::json;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tokio::sync::Mutex;

static E2E_SQL_ENV_LOCK: Mutex<()> = Mutex::const_new(());

struct E2eSqlEnvGuard(Option<String>);

impl E2eSqlEnvGuard {
    fn enable() -> Self {
        let previous = std::env::var("KANNA_E2E_TEST_SQL").ok();
        std::env::set_var("KANNA_E2E_TEST_SQL", "1");
        Self(previous)
    }
}

impl Drop for E2eSqlEnvGuard {
    fn drop(&mut self) {
        match &self.0 {
            Some(value) => std::env::set_var("KANNA_E2E_TEST_SQL", value),
            None => std::env::remove_var("KANNA_E2E_TEST_SQL"),
        }
    }
}

fn e2e_sql_request(peer: SocketAddr) -> Request<Body> {
    let mut request = Request::post("/v1/e2e/sql")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "query": true,
                "sql": "SELECT 42 AS value"
            })
            .to_string(),
        ))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(peer));
    request
}

fn e2e_mobile_control_request(body: serde_json::Value) -> Request<Body> {
    let mut request = Request::post("/v1/e2e/mobile-machine-controls")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        48120,
    )));
    request
}

fn loopback_request(method: &str, path: &str, body: Body) -> Request<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(body)
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        48120,
    )));
    request
}

#[tokio::test]
async fn e2e_sql_route_requires_loopback_connect_info() {
    let _lock = E2E_SQL_ENV_LOCK.lock().await;
    let _env = E2eSqlEnvGuard::enable();

    let loopback_response = super::test_router("desktop-e2e-sql-loopback", "Studio Mac")
        .oneshot(e2e_sql_request(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            48120,
        )))
        .await
        .unwrap();

    assert_eq!(loopback_response.status(), StatusCode::OK);
    let loopback_body = axum::body::to_bytes(loopback_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let loopback_json: serde_json::Value = from_slice(&loopback_body).unwrap();
    assert_eq!(loopback_json["rows"], json!([{ "value": 42 }]));

    let lan_response = super::test_router("desktop-e2e-sql-lan", "Studio Mac")
        .oneshot(e2e_sql_request(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
            48120,
        )))
        .await
        .unwrap();

    assert_eq!(lan_response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn e2e_sql_route_accepts_authenticated_in_process_http_invokes() {
    let _lock = E2E_SQL_ENV_LOCK.lock().await;
    let _env = E2eSqlEnvGuard::enable();
    let state = super::test_state_with_seed("desktop-e2e-sql-invoke", "Studio Mac", |db| {
        db.insert_test_repo("repo-1", "Repo One").unwrap();
    });

    let response = crate::http_api::dispatch_authenticated_http_invoke(
        state,
        "POST",
        "/v1/e2e/sql",
        json!({
            "query": true,
            "sql": "SELECT name FROM repo WHERE id = ?1",
            "params": ["repo-1"]
        }),
    )
    .await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        response.body,
        Some(json!({
            "rows": [{ "name": "Repo One" }],
            "rowsAffected": 0
        }))
    );
}

#[tokio::test]
async fn e2e_mobile_controls_expire_an_active_pairing_session() {
    let _lock = E2E_SQL_ENV_LOCK.lock().await;
    let _env = E2eSqlEnvGuard::enable();
    let app = super::test_router("desktop-e2e-pairing", "Pairing Mac");

    let create_response = app
        .clone()
        .oneshot(loopback_request(
            "POST",
            "/v1/pairing/sessions",
            Body::empty(),
        ))
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let create_body = axum::body::to_bytes(create_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let pairing: crate::pairing::PairingSession = serde_json::from_slice(&create_body).unwrap();

    let control_response = app
        .clone()
        .oneshot(e2e_mobile_control_request(json!({
            "expirePairingSession": true
        })))
        .await
        .unwrap();
    assert_eq!(control_response.status(), StatusCode::OK);

    let claim_response = app
        .oneshot(loopback_request(
            "POST",
            "/v1/pairing/sessions/claim",
            Body::from(
                json!({
                    "code": pairing.code,
                    "deviceId": "phone-e2e",
                    "deviceName": "Kanna Mobile"
                })
                .to_string(),
            ),
        ))
        .await
        .unwrap();
    assert_eq!(claim_response.status(), StatusCode::GONE);
}

#[tokio::test]
async fn e2e_mobile_controls_gate_direct_lan_but_preserve_tunneled_transport() {
    let _lock = E2E_SQL_ENV_LOCK.lock().await;
    let _env = E2eSqlEnvGuard::enable();
    let state = super::test_state_with_seed("desktop-e2e-lan-gate", "Gate Mac", |_| {});
    let app = super::router(Arc::clone(&state));

    let disable_response = app
        .clone()
        .oneshot(e2e_mobile_control_request(json!({
            "lanHttpEnabled": false
        })))
        .await
        .unwrap();
    assert_eq!(disable_response.status(), StatusCode::OK);

    let direct_response = app
        .oneshot(loopback_request("GET", "/v1/status", Body::empty()))
        .await
        .unwrap();
    assert_eq!(direct_response.status(), StatusCode::SERVICE_UNAVAILABLE);

    let tunneled = crate::http_api::dispatch_authenticated_http_invoke(
        state,
        "GET",
        "/v1/status",
        json!(null),
    )
    .await;
    assert_eq!(tunneled.status, StatusCode::OK.as_u16());
    assert_eq!(tunneled.error, None);
    // This test is about LAN gating, not about which tools the catalog holds:
    // that list is asserted in `crates/kanna-tool-catalog/tests/catalog.rs`, so
    // pinning all of it here too would only make every catalog change edit this
    // assertion. Its presence is what matters, and that is checked first.
    let mut tunneled_body = tunneled.body;
    let advertised = tunneled_body
        .as_mut()
        .and_then(|body| body.as_object_mut())
        .and_then(|body| body.remove("agentApiTools"));
    assert!(
        advertised.is_some_and(|tools| tools.as_array().is_some_and(|tools| !tools.is_empty())),
        "status must advertise the agent-API surface so clients can detect version skew"
    );
    // Same for the agent provider inventory: which CLIs resolve depends on the
    // machine running the test, and its contents are asserted against a
    // controlled PATH in `tests/agent_provider_inventory_http.rs`.
    let inventory = tunneled_body
        .as_mut()
        .and_then(|body| body.as_object_mut())
        .and_then(|body| body.remove("agentProviders"));
    assert!(
        inventory.is_some_and(|providers| providers.is_array()),
        "status must report which agent providers this machine can run"
    );
    assert_eq!(
        tunneled_body,
        Some(json!({
            "state": "running",
            "desktopId": "desktop-e2e-lan-gate",
            "desktopName": "Gate Mac",
            "version": "test-version",
            "environment": "development",
            "serverVersion": "test-version",
            "kspStreamVersion": 2,
            "taskInputAttachmentVersion": 1,
            "lanHost": "0.0.0.0",
            "lanPort": 48120,
            "pairingCode": null,
            "writePathHealth": {
                "healthy": true,
                "status": "healthy",
                "activeWorkspaceCommands": 0,
                "maxWorkspaceCommands": 4,
                "longRunningWorkspaceCommands": 0,
                "oldestWorkspaceCommandSeconds": null
            }
        }))
    );
}
