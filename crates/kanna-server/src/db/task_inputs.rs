//! Durable record of messages injected into a task's agent session from
//! outside that session.
//!
//! `POST /v1/tasks/{task_id}/input` writes to a PTY. Until this table existed
//! the message was visible only in that live terminal: nothing on the task,
//! nothing on the `stage_run`, nothing in the event feed. Every consumer that
//! reasons from durable records — a review stage running in a forked worktree
//! with a fresh session, a dispatcher, a post-hoc audit — was structurally
//! blind to it, and could therefore "prove" from the record that an owner
//! directive it was told about had never been issued. It happened: a round-2
//! reviewer read the stage prompts and revision feedback, found no send-input,
//! and instructed the implementer to revert an owner's design directive.
//!
//! So each delivery that the daemon accepted is appended here with its text,
//! the stage and run that were live when it landed, and who delivered it. The
//! row is the evidence; the `task.input_delivered` event is only its
//! announcement.
//!
//! Scope, stated so a reader knows what an empty list does and does not mean:
//! this covers deliveries through `POST /v1/tasks/{task_id}/input` and the
//! server's own completion notifications. Stage prompts, post prompts, and
//! revision feedback are already durable on `stage_run` and are not duplicated
//! here.

use super::{Db, TaskEventKind};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::json;

/// Longest prefix of the message carried in the `task.input_delivered` event.
/// The event feed is a wake-up channel with 14-day retention; the full text
/// lives in the row, which is retained for as long as the task is.
const TASK_INPUT_EVENT_PREVIEW_CHARS: usize = 200;

/// Who delivered a task input.
///
/// `Notify` is the only variant the server assigns from its own knowledge — it
/// generated the message. The rest are **declared by the caller** and are not
/// verified: `POST /v1/tasks/{task_id}/input` cannot tell a human typing on
/// mobile from an orchestrating agent's MCP call, and inventing a distinction
/// it cannot observe would be worse than admitting `Unspecified`. What every
/// record proves regardless of its label is that text entered the session from
/// outside it, at a recorded time, with the recorded content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskInputSource {
    /// A human — the task's owner or another operator — declared themselves
    /// the author, including when relaying their words through a client.
    Operator,
    /// An orchestrating agent (a task manager, a dispatcher) declared itself
    /// the author.
    Manager,
    /// The server's own `TASK <id> DONE [status]: <title>` completion
    /// notification. Never accepted from a caller.
    Notify,
    /// The caller declared nothing. Ordinary for desktop, mobile, and CLI
    /// deliveries, which have no reason to claim authorship.
    Unspecified,
}

impl TaskInputSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Operator => "operator",
            Self::Manager => "manager",
            Self::Notify => "notify",
            Self::Unspecified => "unspecified",
        }
    }

    /// Accept a source label from an API caller. `notify` is rejected because
    /// it means "the server generated this itself", which a caller cannot make
    /// true, and `unspecified` is what an omitted field already means.
    pub fn from_caller_declared(value: &str) -> Result<Self, String> {
        match value {
            "operator" => Ok(Self::Operator),
            "manager" => Ok(Self::Manager),
            other => Err(format!(
                "unknown input source: {other}; use \"operator\" or \"manager\", or omit it"
            )),
        }
    }
}

/// One delivered input, as stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInputRecord {
    /// Monotonic within the database; orders deliveries that share a
    /// one-second `delivered_at`.
    pub id: i64,
    pub task_id: String,
    /// The `stage_run` that was running when the message landed, when there
    /// was one. Null rather than the latest finished run: attributing an input
    /// to a run that had already ended would misreport when it arrived.
    pub run_id: Option<String>,
    /// The task's stage at delivery. Recorded separately from `run_id` because
    /// it survives a task with no running run, and because a later stage's
    /// reviewer reads it to tell which stage was being instructed.
    pub stage: Option<String>,
    pub source: String,
    pub message: String,
    pub delivered_at: String,
}

fn preview_of(message: &str) -> (String, bool) {
    match message.char_indices().nth(TASK_INPUT_EVENT_PREVIEW_CHARS) {
        Some((boundary, _)) => (message[..boundary].to_string(), true),
        None => (message.to_string(), false),
    }
}

impl Db {
    /// Append one delivered input and announce it.
    ///
    /// Call this only after the daemon has accepted the message. A delivery
    /// whose outcome is uncertain is deliberately not recorded: a row claiming
    /// text reached the agent when it may not have is a worse record than a
    /// missing one, and the uncertain path already tells its caller not to
    /// retry blindly.
    ///
    /// `Ok(None)` means the task id does not exist, which is how a
    /// notification aimed at a deleted task stays a log line instead of an
    /// error.
    pub fn record_task_input(
        &self,
        task_id: &str,
        source: TaskInputSource,
        message: &str,
    ) -> Result<Option<TaskInputRecord>, rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let stage: Option<Option<String>> = db
                .conn
                .query_row(
                    "SELECT stage FROM pipeline_item WHERE id = ?",
                    [task_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(stage) = stage else {
                return Ok(None);
            };
            let run_id: Option<String> = db
                .conn
                .query_row(
                    "SELECT id FROM stage_run
                     WHERE task_id = ? AND status = 'running'
                     ORDER BY rowid DESC
                     LIMIT 1",
                    [task_id],
                    |row| row.get(0),
                )
                .optional()?;
            db.conn.execute(
                "INSERT INTO task_input (task_id, run_id, stage, source, message)
                 VALUES (?, ?, ?, ?, ?)",
                params![task_id, run_id, stage, source.as_str(), message],
            )?;
            let id = db.conn.last_insert_rowid();
            let delivered_at: String = db.conn.query_row(
                "SELECT delivered_at FROM task_input WHERE id = ?",
                [id],
                |row| row.get(0),
            )?;
            let (preview, truncated) = preview_of(message);
            db.append_task_event(
                task_id,
                TaskEventKind::InputDelivered,
                json!({
                    "inputId": id,
                    "source": source.as_str(),
                    "runId": run_id,
                    "stage": stage,
                    "preview": preview,
                    "truncated": truncated,
                }),
            )?;
            Ok(Some(TaskInputRecord {
                id,
                task_id: task_id.to_string(),
                run_id,
                stage,
                source: source.as_str().to_string(),
                message: message.to_string(),
                delivered_at,
            }))
        })
    }

    /// The task's most recent `limit` delivered inputs, returned oldest first
    /// so the list reads as the instruction history it is.
    pub fn list_task_inputs(
        &self,
        task_id: &str,
        limit: i64,
    ) -> Result<Vec<TaskInputRecord>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, run_id, stage, source, message, delivered_at
             FROM task_input
             WHERE task_id = ?
             ORDER BY id DESC
             LIMIT ?",
        )?;
        let rows = stmt.query_map(params![task_id, limit.max(1)], |row| {
            Ok(TaskInputRecord {
                id: row.get(0)?,
                task_id: row.get(1)?,
                run_id: row.get(2)?,
                stage: row.get(3)?,
                source: row.get(4)?,
                message: row.get(5)?,
                delivered_at: row.get(6)?,
            })
        })?;
        let mut records = rows.collect::<Result<Vec<_>, _>>()?;
        records.reverse();
        Ok(records)
    }

    /// How many inputs the task has received in total. Task detail reports
    /// this so a consumer reading only the detail cannot conclude from it that
    /// nothing was ever sent; a non-zero count sends them to the records.
    pub fn count_task_inputs(&self, task_id: &str) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM task_input WHERE task_id = ?",
            [task_id],
            |row| row.get(0),
        )
    }
}
