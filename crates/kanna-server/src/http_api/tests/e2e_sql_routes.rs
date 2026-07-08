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

    assert_eq!(lan_response.status(), StatusCode::FORBIDDEN);
}
