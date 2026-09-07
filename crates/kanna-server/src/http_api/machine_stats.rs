use super::state::AppState;
use crate::db::Db;
use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MachineStatsQuery {
    #[serde(default)]
    local_only: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadAverages {
    one: f64,
    five: f64,
    fifteen: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryStats {
    total_bytes: u64,
    used_bytes: u64,
    free_bytes: u64,
    available_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pressure: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MachineStats {
    machine_id: String,
    load_averages: LoadAverages,
    cpu_core_count: usize,
    memory: MemoryStats,
    heavy_process_count: usize,
    heavy_processes: BTreeMap<String, usize>,
    busy_task_count: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MachineStatsResponse {
    machines: Vec<MachineStats>,
    machine_errors: Vec<serde_json::Value>,
}

pub(super) async fn machine_stats(
    State(state): State<Arc<AppState>>,
    Query(query): Query<MachineStatsQuery>,
) -> Result<Json<MachineStatsResponse>, (axum::http::StatusCode, String)> {
    let local = gather_local_stats(&state)?;
    if query.local_only {
        return Ok(Json(MachineStatsResponse {
            machines: vec![local],
            machine_errors: Vec::new(),
        }));
    }

    let mut machines = vec![local];
    let mut machine_errors = Vec::new();
    match state.list_active_relay_desktops().await {
        Ok(machine_ids) => {
            for machine_id in machine_ids {
                if machine_id == state.config.desktop_id {
                    continue;
                }
                match state
                    .invoke_relay_desktop(
                        machine_id.clone(),
                        "GET".to_string(),
                        "/v1/machine-stats?localOnly=true".to_string(),
                        serde_json::Value::Null,
                    )
                    .await
                {
                    Ok(response) if response.status == 200 => match response.body {
                        Some(body) => match serde_json::from_value::<MachineStatsResponse>(body) {
                            Ok(mut remote) => machines.append(&mut remote.machines),
                            Err(error) => machine_errors.push(serde_json::json!({
                                "machineId": machine_id,
                                "error": format!("invalid machine-stats response: {error}"),
                            })),
                        },
                        None => machine_errors.push(serde_json::json!({
                            "machineId": machine_id,
                            "error": "machine-stats response had no body",
                        })),
                    },
                    Ok(response) => machine_errors.push(serde_json::json!({
                        "machineId": machine_id,
                        "error": response.error.unwrap_or_else(|| format!("HTTP {}", response.status)),
                    })),
                    Err(error) => machine_errors.push(serde_json::json!({
                        "machineId": machine_id,
                        "error": error,
                    })),
                }
            }
        }
        Err(error) => machine_errors.push(serde_json::json!({
            "machineId": serde_json::Value::Null,
            "error": error,
        })),
    }
    machines.sort_by(|left, right| left.machine_id.cmp(&right.machine_id));
    Ok(Json(MachineStatsResponse {
        machines,
        machine_errors,
    }))
}

fn gather_local_stats(state: &AppState) -> Result<MachineStats, (axum::http::StatusCode, String)> {
    let db = Db::open(&state.config.db_path).map_err(internal_error)?;
    let busy_task_count = db.count_busy_tasks().map_err(internal_error)?;
    let mut system = System::new();
    system.refresh_memory();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_exe(UpdateKind::OnlyIfNotSet),
    );
    let mut heavy_processes = BTreeMap::from([
        ("bazel".to_string(), 0),
        ("cargo".to_string(), 0),
        ("nodeTestRunner".to_string(), 0),
        ("rustc".to_string(), 0),
        ("vitest".to_string(), 0),
        ("xcodebuild".to_string(), 0),
    ]);
    for process in system.processes().values() {
        if let Some(kind) = heavy_process_kind(process) {
            if let Some(count) = heavy_processes.get_mut(kind) {
                *count += 1;
            }
        }
    }
    let load = System::load_average();
    Ok(MachineStats {
        machine_id: state.config.desktop_id.clone(),
        load_averages: LoadAverages {
            one: load.one,
            five: load.five,
            fifteen: load.fifteen,
        },
        cpu_core_count: system.physical_core_count().unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1)
        }),
        memory: MemoryStats {
            total_bytes: system.total_memory(),
            used_bytes: system.used_memory(),
            free_bytes: system.free_memory(),
            available_bytes: system.available_memory(),
            pressure: memory_pressure(),
        },
        heavy_process_count: heavy_processes.values().sum(),
        heavy_processes,
        busy_task_count,
    })
}

fn heavy_process_kind(process: &sysinfo::Process) -> Option<&'static str> {
    let name = process.name().to_string_lossy().to_ascii_lowercase();
    let arguments = process
        .cmd()
        .iter()
        .map(|part| part.to_string_lossy().to_ascii_lowercase())
        .collect::<Vec<_>>();
    let argument_names = arguments
        .iter()
        .map(|argument| {
            std::path::Path::new(argument)
                .file_name()
                .and_then(|part| part.to_str())
                .unwrap_or(argument)
        })
        .collect::<Vec<_>>();
    if name == "rustc" {
        Some("rustc")
    } else if name == "cargo" {
        Some("cargo")
    } else if name == "bazel" || name == "bazelisk" {
        Some("bazel")
    } else if name == "vitest"
        || (name == "node"
            && arguments
                .iter()
                .any(|argument| tool_argument(argument, "vitest")))
    {
        Some("vitest")
    } else if name == "xcodebuild" {
        Some("xcodebuild")
    } else if name == "node" && is_node_test_runner(&argument_names) {
        Some("nodeTestRunner")
    } else {
        None
    }
}

fn is_node_test_runner(arguments: &[&str]) -> bool {
    arguments.iter().any(|argument| {
        matches!(*argument, "jest" | "mocha" | "ava" | "tap") || *argument == "--test"
    }) || arguments
        .windows(2)
        .any(|pair| pair[0] == "playwright" && pair[1] == "test")
}

fn tool_argument(argument: &str, tool: &str) -> bool {
    argument.split('/').any(|part| {
        part == tool
            || part
                .strip_prefix(tool)
                .is_some_and(|suffix| suffix.starts_with('.'))
    })
}

#[cfg(target_os = "macos")]
fn memory_pressure() -> Option<String> {
    let mut level: libc::c_int = 0;
    let mut length = std::mem::size_of_val(&level);
    let name = b"kern.memorystatus_vm_pressure_level\0";
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr().cast(),
            (&mut level as *mut libc::c_int).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        return None;
    }
    match level {
        1 => Some("normal".to_string()),
        2 => Some("warning".to_string()),
        4 => Some("critical".to_string()),
        _ => None,
    }
}

#[cfg(not(target_os = "macos"))]
fn memory_pressure() -> Option<String> {
    None
}

fn internal_error(error: impl std::fmt::Display) -> (axum::http::StatusCode, String) {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        format!("machine stats error: {error}"),
    )
}
