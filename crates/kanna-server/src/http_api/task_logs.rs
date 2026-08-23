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
    #[serde(default)]
    agent_view: bool,
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
        let rendered = render_pty_snapshot_logs(&state.config.daemon_dir, &pipeline_item_id).await;
        label_composer_line(
            &rendered,
            item.composer_attestation.as_deref(),
            query.agent_view,
        )
    };
    let text = if is_missing_live_log_response(&text) {
        persisted.unwrap_or(text)
    } else {
        text
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

/// Mark the composer line in a rendered PTY tail so nothing reads it as
/// transcript.
///
/// The tail is a terminal frame flattened to text, and the last line of a
/// Claude frame is its `❯` composer — which the CLI fills with a tab-to-accept
/// *suggestion* when it is idle. Left bare, that line reads exactly like
/// something the session said; it was read as an owner directive twice, once
/// stalling a task for a day. The line is kept rather than dropped — a reader
/// deserves to know a composer is there and what is in it — but it is labelled
/// with what the daemon can prove about who put it there.
fn label_composer_line(rendered: &str, attestation: Option<&str>, agent_view: bool) -> String {
    use kanna_daemon::headless_terminal::{composer_line_text, line_is_composer};

    let mut lines = rendered.lines().collect::<Vec<_>>();
    let Some(index) = lines.iter().rposition(|line| line_is_composer(line)) else {
        return rendered.to_string();
    };
    // Absent means no session has reported an attestation for this task, which
    // is the same thing a reader should do with it as `unknown`: prove
    // nothing, assume nothing.
    let attestation = attestation.unwrap_or("unknown");
    if agent_view && attestation != "typed" {
        lines.truncate(index);
        return lines.join("\n");
    }
    let label = if agent_view {
        "composer draft"
    } else {
        "composer"
    };
    let labelled = format!(
        "[{label} ({attestation}), not session output: {}]",
        composer_line_text(lines[index])
    );
    // Everything below the composer row goes with it. Those rows are the hint
    // bar, the box rule, and — the reason this is a truncation rather than a
    // one-line substitution — the composer's own wrapped continuation, which
    // carries no prompt glyph and would otherwise be left behind reading
    // exactly like transcript.
    lines.truncate(index);
    lines.push(&labelled);
    lines.join("\n")
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
        Ok(DaemonEvent::Snapshot { snapshot, .. }) => {
            kanna_runtime_defaults::strip_ansi_for_display(&snapshot.vt)
        }
        Ok(DaemonEvent::Error { message, .. }) => {
            format!("no logs for pty session: {message}")
        }
        Ok(other) => format!("no logs for pty session: unexpected daemon response: {other:?}"),
        Err(error) => format!("no logs for pty session: daemon error: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::label_composer_line;
    use kanna_runtime_defaults::strip_ansi_for_display;

    /// The tail is a terminal frame flattened to text, and its last line is
    /// the composer — which the Claude CLI fills with a tab-to-accept
    /// suggestion. Read bare, "run it on my phone so i can see it" is
    /// indistinguishable from something the agent said; it was acted on as an
    /// owner directive. The line stays, but says what it is.
    #[test]
    fn composer_line_is_labelled_rather_than_read_as_transcript() {
        let rendered = concat!(
            "⏺ Ready for review.\n",
            "────────────\n",
            "❯ run it on my phone so i can see it\n",
            "⏵⏵ bypass permissions on",
        );

        let labelled = label_composer_line(rendered, Some("not-typed"), false);

        assert!(labelled.contains("⏺ Ready for review."));
        assert!(
            labelled.contains(
                "[composer (not-typed), not session output: run it on my phone so i can see it]"
            ),
            "{labelled}"
        );
        assert!(
            !labelled.contains("❯ run it on my phone"),
            "the bare composer line must not survive: {labelled}"
        );
    }

    /// No attestation recorded reads the same way as `unknown`: prove nothing,
    /// assume nothing.
    #[test]
    fn composer_line_without_a_recorded_attestation_is_labelled_unknown() {
        let labelled = label_composer_line("❯ half typed", None, false);
        assert_eq!(
            labelled,
            "[composer (unknown), not session output: half typed]"
        );
    }

    /// A composer long enough to wrap leaves continuation rows below it that
    /// carry no prompt glyph. Labelling the prompt row alone would leave "ht
    /// now please" sitting in the tail as if the agent had said it.
    #[test]
    fn a_wrapped_composer_leaves_no_continuation_behind() {
        let rendered = concat!(
            "⏺ Ready for review.\n",
            "❯ run it on my phone so i can see it rig\n",
            "ht now please\n",
            "⏵⏵ bypass permissions on",
        );

        let labelled = label_composer_line(rendered, Some("not-typed"), false);

        assert!(labelled.starts_with("⏺ Ready for review."));
        assert!(
            !labelled.contains("ht now please"),
            "a wrapped composer row is not transcript: {labelled}"
        );
    }

    /// A frame with no composer is returned untouched — a plain shell session
    /// has no prompt line to label.
    #[test]
    fn a_frame_without_a_composer_is_left_alone() {
        let rendered = "$ cargo test\ntest result: ok.";
        assert_eq!(
            label_composer_line(rendered, Some("typed"), false),
            rendered
        );
    }

    #[test]
    fn agent_view_omits_idle_provider_suggestion_but_keeps_typed_draft_labelled() {
        let suggestion = "⏺ Done.\n❯ Write tests for @filename\n⏵⏵ bypass permissions on";
        let sanitized = label_composer_line(suggestion, Some("not-typed"), true);
        assert_eq!(sanitized, "⏺ Done.");
        assert!(!sanitized.contains("Write tests for @filename"));

        let typed = label_composer_line("⏺ Done.\n❯ please rename this", Some("typed"), true);
        assert!(typed.contains("[composer draft (typed), not session output: please rename this]"));
    }

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
}
