use super::state::AppState;
use crate::db::Db;
use axum::extract::{ConnectInfo, State};
use axum::Json;
use rusqlite::types::{Value, ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map};
use std::net::SocketAddr;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct E2eSqlRequest {
    sql: String,
    #[serde(default)]
    params: Vec<serde_json::Value>,
    #[serde(default)]
    query: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct E2eSqlResponse {
    rows: Vec<serde_json::Value>,
    rows_affected: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct E2eServerWorkRequest {
    duration_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct E2eServerWorkResponse {
    duration_ms: u64,
}

fn bounded_server_work_duration_ms(duration_ms: u64) -> u64 {
    duration_ms.clamp(1, 2_000)
}

fn server_work_concurrency() -> usize {
    std::thread::available_parallelism()
        .map(|parallelism| parallelism.get().min(32))
        .unwrap_or(1)
}

fn burn_cpu_until(deadline: std::time::Instant, seed: u64) {
    let mut state = seed;
    while std::time::Instant::now() < deadline {
        for _ in 0..4_096 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1)
                .rotate_left(17);
        }
        std::hint::black_box(state);
    }
}

pub(super) async fn execute_e2e_server_work(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<E2eServerWorkRequest>,
) -> Result<Json<E2eServerWorkResponse>, (axum::http::StatusCode, String)> {
    if std::env::var("KANNA_E2E_TEST_SQL").ok().as_deref() != Some("1") {
        return Err((axum::http::StatusCode::NOT_FOUND, "not found".to_string()));
    }
    if !is_loopback_peer(Some(peer)) {
        return Err((
            axum::http::StatusCode::FORBIDDEN,
            "E2E server work is only available from loopback clients".to_string(),
        ));
    }

    let duration_ms = bounded_server_work_duration_ms(request.duration_ms);
    // Exercise scheduler contention rather than only occupying sleeping
    // blocking threads. Real development machines commonly have rustc, Node,
    // and fseventd consuming every logical CPU.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(duration_ms);
    let mut workers = tokio::task::JoinSet::new();
    for worker in 0..server_work_concurrency() {
        workers.spawn_blocking(move || {
            burn_cpu_until(
                deadline,
                0x9e37_79b9_7f4a_7c15u64.wrapping_add(worker as u64),
            );
        });
    }
    while let Some(result) = workers.join_next().await {
        result.map_err(internal_error)?;
    }
    Ok(Json(E2eServerWorkResponse { duration_ms }))
}

pub(super) async fn execute_e2e_sql(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<E2eSqlRequest>,
) -> Result<Json<E2eSqlResponse>, (axum::http::StatusCode, String)> {
    if std::env::var("KANNA_E2E_TEST_SQL").ok().as_deref() != Some("1") {
        return Err((axum::http::StatusCode::NOT_FOUND, "not found".to_string()));
    }
    if !is_loopback_peer(Some(peer)) {
        return Err((
            axum::http::StatusCode::FORBIDDEN,
            "E2E SQL is only available from loopback clients".to_string(),
        ));
    }

    let db = Db::open(&state.config.db_path).map_err(internal_error)?;
    let params = request
        .params
        .into_iter()
        .map(json_to_sql_value)
        .collect::<Result<Vec<_>, _>>()?;
    if request.query {
        let rows = query_rows(&db, &request.sql, params).map_err(internal_error)?;
        return Ok(Json(E2eSqlResponse {
            rows,
            rows_affected: 0,
        }));
    }

    let rows_affected = db
        .connection_for_e2e_tests()
        .execute(&request.sql, rusqlite::params_from_iter(params.iter()))
        .map_err(internal_error)?;
    Ok(Json(E2eSqlResponse {
        rows: Vec::new(),
        rows_affected,
    }))
}

fn is_loopback_peer(peer: Option<SocketAddr>) -> bool {
    peer.is_some_and(|addr| addr.ip().is_loopback())
}

fn json_to_sql_value(value: serde_json::Value) -> Result<Value, (axum::http::StatusCode, String)> {
    match value {
        serde_json::Value::Null => Ok(Value::Null),
        serde_json::Value::Bool(value) => Ok(Value::Integer(if value { 1 } else { 0 })),
        serde_json::Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                Ok(Value::Integer(integer))
            } else if let Some(float) = value.as_f64() {
                Ok(Value::Real(float))
            } else {
                Err((
                    axum::http::StatusCode::BAD_REQUEST,
                    format!("unsupported numeric SQL param: {value}"),
                ))
            }
        }
        serde_json::Value::String(value) => Ok(Value::Text(value)),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => Err((
            axum::http::StatusCode::BAD_REQUEST,
            "SQL params must be null, boolean, number, or string".to_string(),
        )),
    }
}

fn query_rows(
    db: &Db,
    sql: &str,
    params: Vec<Value>,
) -> Result<Vec<serde_json::Value>, rusqlite::Error> {
    let mut statement = db.connection_for_e2e_tests().prepare(sql)?;
    let column_names = statement
        .column_names()
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
    let mut rows = statement.query(rusqlite::params_from_iter(params.iter()))?;
    let mut values = Vec::new();
    while let Some(row) = rows.next()? {
        let mut object = Map::new();
        for (index, name) in column_names.iter().enumerate() {
            object.insert(name.clone(), sql_value_to_json(row.get_ref(index)?));
        }
        values.push(serde_json::Value::Object(object));
    }
    Ok(values)
}

fn sql_value_to_json(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(value) => json!(value),
        ValueRef::Real(value) => json!(value),
        ValueRef::Text(value) => json!(String::from_utf8_lossy(value).to_string()),
        ValueRef::Blob(value) => json!(value),
    }
}

fn internal_error(error: impl std::fmt::Display) -> (axum::http::StatusCode, String) {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        error.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    #[test]
    fn e2e_sql_peer_gate_allows_only_loopback() {
        assert!(super::is_loopback_peer(Some(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            48120,
        ))));
        assert!(!super::is_loopback_peer(Some(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
            48120,
        ))));
        assert!(!super::is_loopback_peer(None));
    }

    #[test]
    fn e2e_server_work_duration_is_bounded() {
        assert_eq!(super::bounded_server_work_duration_ms(0), 1);
        assert_eq!(super::bounded_server_work_duration_ms(750), 750);
        assert_eq!(super::bounded_server_work_duration_ms(5_000), 2_000);
    }
}
