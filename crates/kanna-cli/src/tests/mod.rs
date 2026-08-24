use crate::api::{
    advance_stage_via_api, block_task_via_api, close_task_via_api, create_task_via_api,
    dependent_tasks_exist_path, dependent_tasks_exist_via_api, get_task_via_api,
    list_task_children_via_api, parse_wait_until, rename_task_via_api, repo_agent_list_path,
    repo_task_list_path, request_revision_via_api, rerun_stage_via_api, resume_task_via_api,
    send_task_input_via_api, set_task_parent_via_api, set_task_workflow_via_api, signal_agent_path,
    signal_agent_via_api, signal_merge_handoff_via_api, task_children_path, task_get_path,
    task_list_path, task_logs_path, task_matches_wait_until, task_search_path,
    unblock_task_via_api, wait_task_via_api, WaitTaskOutcome,
};
use crate::commands::guide::{
    build_guide_context, render_guide_json, render_guide_markdown, run_guide_command, GuideContext,
};
use crate::commands::repo::build_add_repo_request;
use crate::commands::repo::build_signal_agent_request;
use crate::commands::stage_complete::{
    build_complete_stage_request, render_stage_complete_confirmation,
};
use crate::commands::task::{
    build_block_task_request, build_create_task_request, build_merge_handoff_request,
    build_request_revision_request, build_send_task_input_request, find_task_status_row,
    format_task_list, format_task_status, render_wait_outcome, task_not_found_error,
};
use crate::commands::tool::build_tool_call_args;
use crate::config::resolve_server_base_url;
use crate::models::{
    SetTaskParentRequest, SetTaskWorkflowRequest, SignalAgentRequest, TaskCreateOptions,
    TaskDetail, TaskInputResponse, TaskLatestRun, TaskRenameRequest, TaskSummary, WaitUntil,
};
use clap::{Command, CommandFactory, Parser};
use kanna_tool_catalog::{ParamLoc, CLIENT_TOOL_CALL_BUDGET_SECS, MAX_WAIT_TIMEOUT_SECS};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::net::TcpListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener as TokioTcpListener;

struct TypedToolSurface {
    command_path: &'static [&'static str],
    param_args: &'static [(&'static str, &'static str)],
}

fn typed_tool_surfaces() -> BTreeMap<&'static str, TypedToolSurface> {
    BTreeMap::from([
        (
            "kanna_info",
            TypedToolSurface {
                command_path: &["info"],
                param_args: &[],
            },
        ),
        (
            "kanna_list_machines",
            TypedToolSurface {
                command_path: &["machine", "list"],
                param_args: &[],
            },
        ),
        (
            "kanna_list_repos",
            TypedToolSurface {
                command_path: &["repo", "list"],
                param_args: &[],
            },
        ),
        (
            "kanna_add_repo",
            TypedToolSurface {
                command_path: &["repo", "add"],
                param_args: &[("path", "path"), ("name", "name")],
            },
        ),
        (
            "kanna_list_recent_tasks",
            TypedToolSurface {
                command_path: &["task", "list"],
                param_args: &[
                    ("repo_id", "repo_id"),
                    ("all_repos", "all_repos"),
                    ("limit", "limit"),
                    ("all_machines", "all_machines"),
                    ("include_closed", "include_closed"),
                ],
            },
        ),
        (
            "kanna_get_task",
            TypedToolSurface {
                command_path: &["task", "get"],
                param_args: &[("task_id", "task_id"), ("agent_view", "agent_view")],
            },
        ),
        (
            "kanna_list_task_children",
            TypedToolSurface {
                command_path: &["task", "children"],
                param_args: &[("task_id", "task_id")],
            },
        ),
        (
            "kanna_resume_task",
            TypedToolSurface {
                command_path: &["task", "resume"],
                param_args: &[("task_id", "task_id")],
            },
        ),
        (
            "kanna_is_dependent_tasks_exist",
            TypedToolSurface {
                command_path: &["task", "dependent-tasks-exist"],
                param_args: &[("task_id", "task_id")],
            },
        ),
        (
            "kanna_wait_task",
            TypedToolSurface {
                command_path: &["task", "wait"],
                param_args: &[
                    ("task_id", "task_id"),
                    ("timeout_secs", "timeout_secs"),
                    ("poll_secs", "poll_secs"),
                    ("until", "until"),
                ],
            },
        ),
        (
            "kanna_wait_events",
            TypedToolSurface {
                command_path: &["task", "wait-events"],
                param_args: &[
                    ("task_ids", "task_id"),
                    ("parent_task_id", "parent_task_id"),
                    ("repo_id", "repo_id"),
                    ("repo_remote_url_hash", "repo_remote_url_hash"),
                    ("local_only", "local_only"),
                    ("include_current_activity", "include_current_activity"),
                    ("short_cursor", "short_cursor"),
                    ("cursor", "cursor"),
                    ("timeout_secs", "timeout_secs"),
                    ("limit", "limit"),
                ],
            },
        ),
        (
            "kanna_notify_mobile",
            TypedToolSurface {
                command_path: &["task", "notify-mobile"],
                param_args: &[("title", "title"), ("body", "body"), ("task_id", "task_id")],
            },
        ),
        (
            "kanna_set_task_notify",
            TypedToolSurface {
                command_path: &["task", "set-notify"],
                param_args: &[("task_id", "task_id"), ("notify_task_id", "notify_task")],
            },
        ),
        (
            "kanna_set_task_workflow",
            TypedToolSurface {
                command_path: &["task", "set-workflow"],
                param_args: &[("task_id", "task_id"), ("workflow_name", "workflow_name")],
            },
        ),
        (
            "kanna_task_logs",
            TypedToolSurface {
                command_path: &["task", "logs"],
                param_args: &[
                    ("task_id", "task_id"),
                    ("tail", "tail"),
                    ("agent_view", "agent_view"),
                ],
            },
        ),
        (
            "kanna_task_inputs",
            TypedToolSurface {
                command_path: &["task", "inputs"],
                param_args: &[("task_id", "task_id"), ("tail", "tail")],
            },
        ),
        (
            "kanna_search_tasks",
            TypedToolSurface {
                command_path: &["task", "search"],
                param_args: &[
                    ("query", "query"),
                    ("repo_id", "repo_id"),
                    ("all_repos", "all_repos"),
                    ("all_machines", "all_machines"),
                    ("include_closed", "include_closed"),
                ],
            },
        ),
        (
            "kanna_list_repo_tasks",
            TypedToolSurface {
                command_path: &["task", "list"],
                param_args: &[("repo_id", "repo_id")],
            },
        ),
        (
            "kanna_list_agents",
            TypedToolSurface {
                command_path: &["repo", "agent", "list"],
                param_args: &[("repo_id", "repo_id")],
            },
        ),
        (
            "kanna_create_task",
            TypedToolSurface {
                command_path: &["task", "create"],
                param_args: &[
                    ("repo_id", "repo_id"),
                    ("prompt", "prompt"),
                    ("display_name", "display_name"),
                    ("workflow_name", "workflow_name"),
                    ("base_ref", "base_ref"),
                    ("agent", "agent"),
                    ("agent_provider", "agent_provider"),
                    ("agent_type", "agent_type"),
                    ("model", "model"),
                    ("effort", "effort"),
                    ("permission_mode", "permission_mode"),
                    ("notify_task_id", "notify_task"),
                    ("parent_task_id", "parent_task"),
                    ("allowed_tools", "allowed_tool"),
                    ("blocker_task_ids", "blocker_task_id"),
                ],
            },
        ),
        (
            "kanna_signal_agent",
            TypedToolSurface {
                command_path: &["repo", "agent", "signal"],
                param_args: &[
                    ("repo_id", "repo_id"),
                    ("agent", "agent"),
                    ("message", "message"),
                    ("agent_provider", "agent_provider"),
                    ("effort", "effort"),
                ],
            },
        ),
        (
            "kanna_set_task_parent",
            TypedToolSurface {
                command_path: &["task", "set-parent"],
                param_args: &[("task_id", "task_id"), ("parent_task_id", "parent_task")],
            },
        ),
        (
            "kanna_send_task_input",
            TypedToolSurface {
                command_path: &["task", "send-input"],
                param_args: &[
                    ("task_id", "task_id"),
                    ("input", "message"),
                    ("source", "source"),
                ],
            },
        ),
        (
            "kanna_close_task",
            TypedToolSurface {
                command_path: &["task", "close"],
                param_args: &[("task_id", "task_id")],
            },
        ),
        (
            "kanna_rename_task",
            TypedToolSurface {
                command_path: &["task", "rename"],
                param_args: &[("task_id", "task_id"), ("display_name", "name")],
            },
        ),
        (
            "kanna_advance_stage",
            TypedToolSurface {
                command_path: &["task", "advance-stage"],
                param_args: &[("task_id", "task_id")],
            },
        ),
        (
            "kanna_signal_merge_handoff",
            TypedToolSurface {
                command_path: &["task", "signal-merge"],
                param_args: &[
                    ("task_id", "task_id"),
                    ("branch", "branch"),
                    ("target", "target"),
                    ("pr_url", "pr_url"),
                    ("summary", "summary"),
                ],
            },
        ),
        (
            "kanna_rerun_stage",
            TypedToolSurface {
                command_path: &["task", "rerun-stage"],
                param_args: &[("task_id", "task_id")],
            },
        ),
        (
            "kanna_block_task",
            TypedToolSurface {
                command_path: &["task", "block"],
                param_args: &[
                    ("task_id", "task_id"),
                    ("blocker_task_ids", "blocker_task_id"),
                ],
            },
        ),
        (
            "kanna_unblock_task",
            TypedToolSurface {
                command_path: &["task", "unblock"],
                param_args: &[("task_id", "task_id")],
            },
        ),
        (
            "kanna_complete_stage",
            TypedToolSurface {
                command_path: &["stage-complete"],
                param_args: &[
                    ("task_id", "task_id"),
                    ("status", "status"),
                    ("summary", "summary"),
                    ("metadata", "metadata"),
                ],
            },
        ),
        (
            "kanna_request_revision",
            TypedToolSurface {
                command_path: &["task", "request-revision"],
                param_args: &[
                    ("task_id", "task_id"),
                    ("target_stage", "target_stage"),
                    ("summary", "summary"),
                    ("prompt", "prompt"),
                    ("metadata", "metadata"),
                ],
            },
        ),
    ])
}

fn command_for_path<'a>(command: &'a Command, path: &[&str]) -> Option<&'a Command> {
    let mut current = command;
    for part in path {
        current = current
            .get_subcommands()
            .find(|candidate| candidate.get_name() == *part)?;
    }
    Some(current)
}

fn http_json_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

async fn serve_single_http_response(response: String) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{addr}");
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0; 4096];
        let bytes_read = socket.read(&mut buffer).await.unwrap();
        let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
        socket.write_all(response.as_bytes()).await.unwrap();
        request
    });

    (base_url, handle)
}

/// Serves the same body for as many requests as a wait makes, so a polling test
/// does not have to pin the exact poll count. The body is shared so a test can
/// flip a task from running to finished between waits.
async fn serve_repeating_http_response(body: std::sync::Arc<std::sync::Mutex<String>>) -> String {
    let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buffer = vec![0; 4096];
            if socket.read(&mut buffer).await.is_err() {
                continue;
            }
            let response = match body.lock() {
                Ok(body) => http_json_response("200 OK", &body),
                Err(_) => return,
            };
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });

    format!("http://{addr}")
}

mod api_paths;
mod builders;
mod cli_surface;
mod config;
mod guide;
mod http_api;
mod task_format;
