use super::state::AppState;
use crate::db::Db;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use kanna_agent_protocol::AgentEvent;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskLogsQuery {
    tail: Option<usize>,
}

const DEFAULT_TASK_LOG_TAIL: usize = 50;

pub(super) async fn task_logs(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<TaskLogsQuery>,
) -> Result<Response, (axum::http::StatusCode, String)> {
    let tail = query.tail.unwrap_or(DEFAULT_TASK_LOG_TAIL).max(1);
    let db = Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let pipeline_item_id = db
        .resolve_pipeline_item_id(&task_id)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("task not found: {task_id}"),
            )
        })?;
    let item = db.get_pipeline_item(&pipeline_item_id).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let Some(item) = item else {
        return Err((
            axum::http::StatusCode::NOT_FOUND,
            format!("task not found: {task_id}"),
        ));
    };
    let text = if item.agent_type.as_deref() == Some("agent") {
        render_agent_journal_logs(&state.config.daemon_dir, &pipeline_item_id, tail)?
    } else {
        render_pty_snapshot_logs(&state.config.daemon_dir, &pipeline_item_id).await
    };
    Ok((
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        text,
    )
        .into_response())
}

fn render_agent_journal_logs(
    daemon_dir: &str,
    session_id: &str,
    tail: usize,
) -> Result<String, (axum::http::StatusCode, String)> {
    let path = Path::new(daemon_dir)
        .join("agent-journals")
        .join(format!("{session_id}.ndjson"));
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok("no logs for agent session".to_string());
        }
        Err(error) => {
            return Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read agent journal: {error}"),
            ));
        }
    };
    let mut rendered = contents
        .lines()
        .filter_map(|line| serde_json::from_str::<kanna_daemon::protocol::SeqAgentEvent>(line).ok())
        .filter_map(|entry| render_agent_event(entry.event))
        .collect::<Vec<_>>();
    if rendered.len() > tail {
        rendered = rendered.split_off(rendered.len() - tail);
    }
    if rendered.is_empty() {
        Ok("no relevant agent logs".to_string())
    } else {
        Ok(rendered.join("\n"))
    }
}

fn render_agent_event(event: AgentEvent) -> Option<String> {
    match event {
        AgentEvent::AssistantText { text, .. } => Some(text),
        AgentEvent::ToolResult {
            output, is_error, ..
        } => {
            let prefix = if is_error {
                "tool error"
            } else {
                "tool result"
            };
            Some(format!("{prefix}: {output}"))
        }
        _ => None,
    }
}

async fn render_pty_snapshot_logs(daemon_dir: &str, session_id: &str) -> String {
    let mut daemon = match crate::daemon_client::DaemonClient::connect(daemon_dir).await {
        Ok(daemon) => daemon,
        Err(error) => return format!("no logs for pty session: daemon unavailable: {error}"),
    };
    let event = daemon
        .send_command(&DaemonCommand::Snapshot {
            session_id: session_id.to_string(),
        })
        .await;
    match event {
        Ok(DaemonEvent::Snapshot { snapshot, .. }) => strip_ansi(&snapshot.vt),
        Ok(DaemonEvent::Error { message, .. }) => {
            format!("no logs for pty session: {message}")
        }
        Ok(other) => format!("no logs for pty session: unexpected daemon response: {other:?}"),
        Err(error) => format!("no logs for pty session: daemon error: {error}"),
    }
}

fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            let _ = chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            output.push(ch);
        }
    }
    output
}
