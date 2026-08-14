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
    let persisted = render_persisted_stage_run_logs(&db, &pipeline_item_id, tail).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })?;
    let text = if item.agent_type.as_deref() == Some("agent") {
        render_agent_journal_logs(&state.config.daemon_dir, &pipeline_item_id, tail)?
    } else {
        render_pty_snapshot_logs(&state.config.daemon_dir, &pipeline_item_id).await
    };
    let text = if is_missing_live_log_response(&text) {
        persisted.unwrap_or(text)
    } else {
        text
    };
    let input_events = db
        .list_recent_input_events(&pipeline_item_id, tail)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {e}"),
            )
        })?;
    let text = append_input_audit(text, &input_events);
    Ok((
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        text,
    )
        .into_response())
}

fn render_persisted_stage_run_logs(
    db: &Db,
    task_id: &str,
    tail: usize,
) -> Result<Option<String>, rusqlite::Error> {
    let runs = db.list_stage_runs_for_task(task_id)?;
    let mut rendered = runs
        .into_iter()
        .filter_map(|run| {
            let mut lines = vec![format!(
                "stage run {} ({}) {}",
                run.stage, run.kind, run.status
            )];
            if let Some(result) = run.result {
                lines.push(format!("result: {result}"));
            }
            if let Some(feedback) = run.feedback {
                lines.push(format!("feedback: {feedback}"));
            }
            if let Some(cwd) = run.cwd {
                lines.push(format!("cwd: {cwd}"));
            }
            if lines.len() == 1 {
                None
            } else {
                Some(lines.join("\n"))
            }
        })
        .collect::<Vec<_>>();
    if rendered.len() > tail {
        rendered = rendered.split_off(rendered.len() - tail);
    }
    if rendered.is_empty() {
        Ok(None)
    } else {
        Ok(Some(rendered.join("\n\n")))
    }
}

fn is_missing_live_log_response(text: &str) -> bool {
    text.starts_with("no logs for agent session")
        || text.starts_with("no relevant agent logs")
        || text.starts_with("no logs for pty session")
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
        Ok(DaemonEvent::Snapshot {
            snapshot,
            agent_provider,
            ..
        }) => {
            let rendered = kanna_runtime_defaults::strip_ansi_for_display(&snapshot.vt);
            kanna_daemon::headless_terminal::annotate_unsubmitted_composer_for_display(
                &rendered,
                agent_provider,
            )
        }
        Ok(DaemonEvent::Error { message, .. }) => {
            format!("no logs for pty session: {message}")
        }
        Ok(other) => format!("no logs for pty session: unexpected daemon response: {other:?}"),
        Err(error) => format!("no logs for pty session: daemon error: {error}"),
    }
}

fn append_input_audit(mut text: String, events: &[crate::db::TaskEvent]) -> String {
    if events.is_empty() {
        return text;
    }
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str("\n--- input audit ---\n");
    for event in events {
        let payload = &event.payload;
        let source = payload["source"].as_str().unwrap_or("unknown");
        let delivery = payload["delivery"].as_str().unwrap_or("unknown");
        let boundary = payload["boundary"].as_str().unwrap_or("unknown");
        let sequence = payload["queueSequence"].as_u64().unwrap_or_default();
        let pid = payload["sessionPid"].as_u64().unwrap_or_default();
        text.push_str(&format!(
            "input #{sequence} source={source} delivery={delivery} boundary={boundary} pid={pid}\n"
        ));
        if let Some(value) = payload["text"].as_str() {
            text.push_str("text: ");
            text.push_str(value);
            if payload["truncated"].as_bool() == Some(true) {
                text.push_str(" [truncated]");
            }
            text.push('\n');
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use kanna_runtime_defaults::strip_ansi_for_display;

    #[test]
    fn strip_ansi_removes_color_codes() {
        assert_eq!(strip_ansi_for_display("\u{1b}[31mused\u{1b}[0m"), "used");
    }

    #[test]
    fn strip_ansi_preserves_cursor_movement_readability() {
        assert_eq!(
            strip_ansi_for_display("used\u{1b}[3C42\u{1b}[2Bdone"),
            "used   42\n\ndone"
        );
    }

    #[test]
    fn strip_ansi_removes_osc_sequences_and_carriage_returns() {
        assert_eq!(
            strip_ansi_for_display("a\u{1b}]0;title\u{7}b\rc\u{1b}]1;ignored\u{1b}\\d"),
            "abcd"
        );
    }

    #[test]
    fn strip_ansi_preserves_utf8_and_drops_incomplete_escapes() {
        assert_eq!(strip_ansi_for_display("✓ café\u{1b}\u{1b}[31"), "✓ café");
    }

    #[test]
    fn codex_current_composer_is_labelled_without_phrase_matching() {
        let rendered = concat!(
            "› Explain this codebase\n",
            "assistant response\n",
            "gpt-5.4 high · .kanna-worktrees/task-1\n",
            "› Explain this codebase",
        );
        let annotated = kanna_daemon::headless_terminal::annotate_unsubmitted_composer_for_display(
            rendered,
            Some(kanna_agent_protocol::AgentProvider::Codex),
        );
        assert_eq!(
            annotated
                .matches("[current Codex composer — not submitted]")
                .count(),
            1
        );
        assert!(annotated.starts_with("› Explain this codebase\n"));
        assert!(
            annotated.ends_with("[current Codex composer — not submitted] › Explain this codebase")
        );
    }

    #[test]
    fn non_codex_prompt_text_is_not_rewritten() {
        let rendered = "answer\n› Explain this codebase";
        assert_eq!(
            kanna_daemon::headless_terminal::annotate_unsubmitted_composer_for_display(
                rendered,
                Some(kanna_agent_protocol::AgentProvider::Opencode),
            ),
            rendered
        );
    }
}
