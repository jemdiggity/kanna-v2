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
use kanna_agent_protocol::AgentEvent;
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
    let sidecar_path = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .join(name);
    if sidecar_path.exists() {
        return (sidecar_path, false);
    }

    std::fs::write(&sidecar_path, "#!/bin/sh\nexit 0\n").unwrap();
    (sidecar_path, true)
}

fn init_test_git_repo(repo_root: &Path) {
    let _ = std::fs::remove_dir_all(repo_root);
    std::fs::create_dir_all(repo_root).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
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
        .args(["add", "README.md"])
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
