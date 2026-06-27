use crate::api::{
    advance_stage_via_api, block_task_via_api, close_task_via_api, create_task_via_api,
    get_task_via_api, parse_wait_until, rename_task_via_api, repo_task_list_path,
    send_task_input_via_api, task_get_path, task_list_path, task_logs_path,
    task_matches_wait_until, task_search_path, unblock_task_via_api,
};
use crate::commands::guide::{
    build_guide_context, render_guide_json, render_guide_markdown, run_guide_command, GuideContext,
};
use crate::commands::repo::build_add_repo_request;
use crate::commands::stage_complete::build_complete_stage_request;
use crate::commands::task::{
    build_block_task_request, build_create_task_request, build_request_revision_request,
    build_send_task_input_request, find_task_status_row, format_task_list, format_task_status,
    task_not_found_error,
};
use crate::commands::tool::build_tool_call_args;
use crate::config::{
    resolve_optional_server_base_url, resolve_server_base_url, resolve_stage_db_path,
};
use crate::models::{
    TaskCreateOptions, TaskDetail, TaskInputResponse, TaskRenameRequest, TaskSummary, WaitUntil,
};
use clap::{Command, CommandFactory, Parser};
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
                param_args: &[],
            },
        ),
        (
            "kanna_get_task",
            TypedToolSurface {
                command_path: &["task", "get"],
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
            "kanna_task_logs",
            TypedToolSurface {
                command_path: &["task", "logs"],
                param_args: &[("task_id", "task_id"), ("tail", "tail")],
            },
        ),
        (
            "kanna_search_tasks",
            TypedToolSurface {
                command_path: &["task", "search"],
                param_args: &[("query", "query")],
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
            "kanna_create_task",
            TypedToolSurface {
                command_path: &["task", "create"],
                param_args: &[
                    ("repo_id", "repo_id"),
                    ("prompt", "prompt"),
                    ("display_name", "display_name"),
                    ("pipeline_name", "pipeline_name"),
                    ("base_ref", "base_ref"),
                    ("stage", "stage"),
                    ("agent_provider", "agent_provider"),
                    ("agent_type", "agent_type"),
                    ("model", "model"),
                    ("permission_mode", "permission_mode"),
                    ("notify_task_id", "notify_task"),
                    ("allowed_tools", "allowed_tool"),
                    ("blocker_task_ids", "blocker_task_id"),
                ],
            },
        ),
        (
            "kanna_send_task_input",
            TypedToolSurface {
                command_path: &["task", "send-input"],
                param_args: &[("task_id", "task_id"), ("input", "message")],
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

mod api_paths;
mod builders;
mod cli_surface;
mod config;
mod guide;
mod http_api;
mod task_format;
