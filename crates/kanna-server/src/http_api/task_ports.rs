use super::state::{db_write_error, AppState};
use super::task_blockers::resolve_existing_task_id;
use crate::db::Db;
use crate::internal_ports::reserve_internal_ports;
use axum::extract::{Path, State};
use axum::Json;
use kanna_agent_protocol::StateChangeScope;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClaimTaskPortsRequest {
    #[serde(default)]
    ports: Option<HashMap<String, i64>>,
    #[serde(default)]
    reserved_ports: Vec<i64>,
    #[serde(default)]
    reserved_port_offsets: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClaimTaskPortsResponse {
    task_id: String,
    port_env: HashMap<String, String>,
    first_port: Option<i64>,
}

fn add_reserved_ports(occupied: &mut HashSet<i64>, payload: &ClaimTaskPortsRequest) {
    reserve_internal_ports(occupied);
    for port in &payload.reserved_ports {
        if (1..=65535).contains(port) {
            occupied.insert(*port);
        }
    }

    let Some(ports) = payload.ports.as_ref() else {
        return;
    };
    for preferred in ports.values() {
        if !(1..=65535).contains(preferred) {
            continue;
        }
        for offset in &payload.reserved_port_offsets {
            if *offset < 0 {
                continue;
            }
            let Some(reserved) = preferred.checked_add(*offset) else {
                continue;
            };
            if (1..=65535).contains(&reserved) {
                occupied.insert(reserved);
            }
        }
    }
}

fn first_port(port_env: &HashMap<String, String>) -> Option<i64> {
    port_env
        .values()
        .find_map(|value| value.parse::<i64>().ok())
}

fn persist_port_env(
    db: &Db,
    task_id: &str,
    port_env: &HashMap<String, String>,
) -> Result<(), String> {
    let port_env_json = if port_env.is_empty() {
        None
    } else {
        Some(serde_json::to_string(port_env).map_err(|e| format!("serialize error: {e}"))?)
    };
    db.update_pipeline_item_ports(task_id, first_port(port_env), port_env_json.as_deref())
        .map_err(|e| format!("db error: {e}"))
}

fn claim_ports(
    db: &Db,
    task_id: &str,
    payload: &ClaimTaskPortsRequest,
) -> Result<HashMap<String, String>, String> {
    let mut port_env = HashMap::new();
    let Some(ports) = payload.ports.as_ref() else {
        persist_port_env(db, task_id, &port_env)?;
        return Ok(port_env);
    };

    let mut occupied = db
        .list_task_ports()
        .map_err(|e| format!("db error: {e}"))?
        .into_iter()
        .collect::<HashSet<_>>();
    add_reserved_ports(&mut occupied, payload);
    let existing = db
        .list_task_ports_for_item(task_id)
        .map_err(|e| format!("db error: {e}"))?;

    for (env_name, preferred) in ports {
        if let Some(existing_port) = existing.get(env_name) {
            occupied.insert(*existing_port);
            port_env.insert(env_name.clone(), existing_port.to_string());
            continue;
        }

        if !(1..=65535).contains(preferred) {
            return Err(format!("invalid port for {env_name}: {preferred}"));
        }

        let mut candidate = preferred + 1;
        loop {
            if !occupied.contains(&candidate)
                && db
                    .claim_task_port(task_id, env_name, candidate)
                    .map_err(|e| format!("db error: {e}"))?
            {
                occupied.insert(candidate);
                port_env.insert(env_name.clone(), candidate.to_string());
                break;
            }
            candidate += 1;
            if candidate > 65535 {
                return Err(format!("no free port available near {preferred}"));
            }
        }
    }

    persist_port_env(db, task_id, &port_env)?;
    Ok(port_env)
}

pub(super) async fn claim_task_ports(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
    Json(payload): Json<ClaimTaskPortsRequest>,
) -> Result<Json<ClaimTaskPortsResponse>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = resolve_existing_task_id(&db, &task_id)?;
    let port_env = match claim_ports(&db, &task_id, &payload) {
        Ok(port_env) => port_env,
        Err(error) => {
            let _ = db.release_task_ports(&task_id);
            return Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, error));
        }
    };
    let first_port = first_port(&port_env);
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(ClaimTaskPortsResponse {
        task_id,
        port_env,
        first_port,
    }))
}

pub(super) async fn release_task_ports(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let task_id = resolve_existing_task_id(&db, &task_id)?;
    db.release_task_ports(&task_id)
        .map_err(|e| db_write_error("db error", e))?;
    state.preview_sessions.revoke_task(&task_id).await;
    state.publish_state_changed(StateChangeScope::Tasks);
    Ok(Json(serde_json::json!({ "taskId": task_id })))
}
