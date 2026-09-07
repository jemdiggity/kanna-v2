use super::state::AppState;
use crate::db::Db;
use axum::extract::{Query, State};
use axum::Json;
use futures_util::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

const REMOTE_STATS_TIMEOUT: Duration = Duration::from_secs(3);

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
            let mut requests = FuturesUnordered::new();
            for machine_id in machine_ids {
                if machine_id == state.config.desktop_id {
                    continue;
                }
                let state = Arc::clone(&state);
                requests.push(async move {
                    let result = tokio::time::timeout(
                        REMOTE_STATS_TIMEOUT,
                        state.invoke_relay_desktop(
                            machine_id.clone(),
                            "GET".to_string(),
                            "/v1/machine-stats?localOnly=true".to_string(),
                            serde_json::Value::Null,
                        ),
                    )
                    .await;
                    (machine_id, result)
                });
            }
            while let Some((machine_id, result)) = requests.next().await {
                match result {
                    Err(_) => machine_errors.push(serde_json::json!({
                        "machineId": machine_id,
                        "error": "machine-stats request timed out",
                    })),
                    Ok(result) => match result {
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
                    },
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
    let arguments = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    heavy_process_kind_from_command(&name, &arguments)
}

fn heavy_process_kind_from_command(name: &str, arguments: &[&str]) -> Option<&'static str> {
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
    } else if name == "node" && is_node_test_runner(arguments) {
        Some("nodeTestRunner")
    } else {
        None
    }
}

fn is_node_test_runner(arguments: &[&str]) -> bool {
    arguments.iter().any(|argument| {
        *argument == "--test"
            || ["jest", "mocha", "ava", "tap"]
                .iter()
                .any(|tool| tool_argument(argument, tool))
    }) || arguments.iter().enumerate().any(|(index, argument)| {
        tool_argument(argument, "playwright") && arguments[index + 1..].contains(&"test")
    })
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

#[cfg(test)]
mod tests {
    use super::heavy_process_kind_from_command;

    #[test]
    fn classifies_node_test_runner_command_shapes() {
        let cases = [
            (
                "jest",
                vec!["node", "node_modules/jest/bin/jest.js"],
                Some("nodeTestRunner"),
            ),
            (
                "mocha",
                vec!["node", "node_modules/mocha/bin/mocha.js"],
                Some("nodeTestRunner"),
            ),
            (
                "ava",
                vec!["node", "node_modules/ava/entrypoints/cli.mjs"],
                Some("nodeTestRunner"),
            ),
            (
                "tap",
                vec!["node", "node_modules/tap/bin/run.js"],
                Some("nodeTestRunner"),
            ),
            (
                "node test",
                vec!["node", "--test", "test/unit.js"],
                Some("nodeTestRunner"),
            ),
            (
                "playwright",
                vec!["node", "node_modules/playwright/cli.js", "test"],
                Some("nodeTestRunner"),
            ),
            (
                "vitest",
                vec!["node", "node_modules/vitest/vitest.mjs", "run"],
                Some("vitest"),
            ),
            ("application", vec!["node", "server.js"], None),
            (
                "playwright browser",
                vec!["node", "node_modules/playwright/cli.js", "install"],
                None,
            ),
        ];

        for (label, arguments, expected) in cases {
            assert_eq!(
                heavy_process_kind_from_command("node", &arguments),
                expected,
                "{label}"
            );
        }
    }
}
