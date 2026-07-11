pub(super) use super::task_input::{submit_task_input, task_input_message};
pub(super) use super::test_support::{
    test_router, test_router_with_merge_agent_runner, test_router_with_revision_requester,
    test_router_with_seed, test_router_with_stage_advancer, test_router_with_stage_completer,
    test_router_with_stage_rerunner, test_router_with_task_closer, test_router_with_task_creator,
    test_router_with_task_input_sender, test_state_with_seed, test_state_with_task_input_sender,
};
pub(super) use super::{dispatch_http_invoke, handle_task_terminal_state, router, AppState};
use crate::config::Config;
use crate::db::Db;
use crate::mobile_api::{CreateTaskResponse, MobileServerStatus, TaskActionResponse};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use kanna_agent_protocol::{AgentEvent, AgentProvider};
use serde_json::from_slice;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tower::ServiceExt;

fn daemon_socket_path_for_dir(daemon_dir: &str) -> PathBuf {
    kanna_runtime_defaults::socket_path(Path::new(daemon_dir))
}

fn pipeline_socket_path_for_daemon_dir(daemon_dir: &str) -> String {
    let dir = PathBuf::from(daemon_dir).join("pipeline");
    kanna_runtime_defaults::socket_path(&dir)
        .to_string_lossy()
        .to_string()
}

fn ensure_test_kanna_cli_sidecar() -> (PathBuf, bool) {
    ensure_test_sidecar("kanna-cli")
}

fn ensure_test_sidecar(name: &str) -> (PathBuf, bool) {
    use std::os::unix::fs::PermissionsExt;

    let sidecar_path = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .join(name);
    if sidecar_path.exists() {
        return (sidecar_path, false);
    }

    std::fs::write(&sidecar_path, "#!/bin/sh\nexit 0\n").unwrap();
    let mut permissions = std::fs::metadata(&sidecar_path).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&sidecar_path, permissions).unwrap();
    (sidecar_path, true)
}

const TEST_PROVIDER_NEUTRAL_PIPELINE: &str = "test-provider-neutral";

fn init_test_git_repo(repo_root: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let _ = std::fs::remove_dir_all(repo_root);
    let pipeline_dir = repo_root.join(".kanna/pipelines");
    let provider_bin_dir = repo_root.join(".kanna/test-provider-bin");
    std::fs::create_dir_all(&pipeline_dir).unwrap();
    std::fs::create_dir_all(&provider_bin_dir).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "workspace": {
                "path": {
                    "prepend": [".kanna/test-provider-bin"]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        pipeline_dir.join(format!("{TEST_PROVIDER_NEUTRAL_PIPELINE}.json")),
        serde_json::json!({
            "name": TEST_PROVIDER_NEUTRAL_PIPELINE,
            "stages": [{
                "name": "in progress",
                "prompt": "$TASK_PROMPT",
                "policy": { "transition": "manual" }
            }]
        })
        .to_string(),
    )
    .unwrap();
    for provider in AgentProvider::ALL {
        let fixture = provider_bin_dir.join(provider.executable());
        std::fs::write(&fixture, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(Command::new("git")
        .arg("init")
        .arg("-b")
        .arg("main")
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.name", "Test User"])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["add", "."])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
}

mod actions;
mod core_routes;
mod create_task;
mod e2e_sql_routes;
mod input;
mod revision_status;
