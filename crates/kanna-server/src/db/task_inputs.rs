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
//! this covers deliveries through `POST /v1/tasks/{task_id}/input`. Historical
//! rows may have the retired `notify` source. Stage prompts, post prompts, and
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
/// These labels are **declared by the caller** and are not verified:
/// `POST /v1/tasks/{task_id}/input` cannot tell a human typing on
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
    /// The caller declared nothing. Ordinary for desktop, mobile, and CLI
    /// deliveries, which have no reason to claim authorship.
    Unspecified,
}

impl TaskInputSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Operator => "operator",
            Self::Manager => "manager",
            Self::Unspecified => "unspecified",
        }
    }

    /// Accept a source label from an API caller. `notify` is a retired
    /// server-owned historical label, so callers cannot claim it;
    /// `unspecified` is already what an omitted field means.
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

/// One raw terminal write, as announced on the event feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawInputWriteRecord {
    /// The named key, or `None` when the caller supplied explicit bytes.
    pub key: Option<String>,
    /// Lowercase hex of exactly the bytes written.
    pub bytes_hex: String,
    /// The producer-declared composer meaning: `draft` or `submission`.
    pub class: &'static str,
    /// `written`, `uncertain`, or `not_written`.
    pub status: &'static str,
}

impl Db {
    /// Announce a raw terminal write against a task.
    ///
    /// Deliberately *not* a `task_input` row. That table is the durable record
    /// of messages a later stage must read as instructions, and a reviewer is
    /// told to treat what it finds there as owner or manager speech. An arrow
    /// key is not speech: recording `\x1b[B` as a delivered directive would put
    /// terminal control bytes into the one place the codebase promises carries
    /// sentences somebody meant. So the action is announced where actions are
    /// announced — the append-only event log — carrying what it was, what
    /// happened, and who claimed it, and nothing pretends it was a message.
    pub fn append_raw_input_event(
        &self,
        task_id: &str,
        source: &str,
        session_pid: u32,
        status: &str,
        writes: &[RawInputWriteRecord],
    ) -> Result<bool, rusqlite::Error> {
        let stage: Option<Option<String>> = self
            .conn
            .query_row(
                "SELECT stage FROM pipeline_item WHERE id = ?",
                [task_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(stage) = stage else {
            return Ok(false);
        };
        let run_id: Option<String> = self
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
        let writes = writes
            .iter()
            .map(|write| {
                json!({
                    "key": write.key,
                    "bytes": write.bytes_hex,
                    "class": write.class,
                    "status": write.status,
                })
            })
            .collect::<Vec<_>>();
        self.append_task_event(
            task_id,
            TaskEventKind::RawInputDelivered,
            json!({
                "source": source,
                "runId": run_id,
                "stage": stage,
                "sessionPid": session_pid,
                "status": status,
                "writes": writes,
            }),
        )?;
        Ok(true)
    }

    fn insert_delivered_task_input(
        &self,
        task_id: &str,
        source: &str,
        message: &str,
    ) -> Result<Option<TaskInputRecord>, rusqlite::Error> {
        let stage: Option<Option<String>> = self
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
        let run_id: Option<String> = self
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
        self.conn.execute(
            "INSERT INTO task_input (task_id, run_id, stage, source, message)
             VALUES (?, ?, ?, ?, ?)",
            params![task_id, run_id, stage, source, message],
        )?;
        let id = self.conn.last_insert_rowid();
        let delivered_at: String = self.conn.query_row(
            "SELECT delivered_at FROM task_input WHERE id = ?",
            [id],
            |row| row.get(0),
        )?;
        let (preview, truncated) = preview_of(message);
        self.append_task_event(
            task_id,
            TaskEventKind::InputDelivered,
            json!({
                "inputId": id,
                "source": source,
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
            source: source.to_string(),
            message: message.to_string(),
            delivered_at,
        }))
    }

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
    #[cfg(test)]
    pub fn record_task_input(
        &self,
        task_id: &str,
        source: TaskInputSource,
        message: &str,
    ) -> Result<Option<TaskInputRecord>, rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            db.insert_delivered_task_input(task_id, source.as_str(), message)
        })
    }

    pub fn prepare_queued_task_input(
        &self,
        task_id: &str,
        session_pid: u32,
        source: TaskInputSource,
        message: &str,
    ) -> Result<Option<i64>, rusqlite::Error> {
        let inserted = self.conn.execute(
            "INSERT INTO queued_task_input (task_id, session_pid, source, message, state)
             SELECT id, ?, ?, ?, 'preparing' FROM pipeline_item WHERE id = ?",
            params![session_pid, source.as_str(), message, task_id],
        )?;
        Ok((inserted == 1).then(|| self.conn.last_insert_rowid()))
    }

    pub fn mark_queued_task_input_held(
        &self,
        id: i64,
        session_pid: u32,
        reason: &str,
    ) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE queued_task_input SET state = 'held', reason = ?
             WHERE id = ? AND session_pid = ? AND state = 'preparing'",
            params![reason, id, session_pid],
        )?;
        Ok(changed == 1)
    }

    pub fn mark_queued_task_input_uncertain(
        &self,
        id: i64,
        reason: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE queued_task_input SET state = 'uncertain', reason = ? WHERE id = ?",
            params![reason, id],
        )?;
        Ok(())
    }

    pub fn discard_queued_task_input(&self, id: i64) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM queued_task_input WHERE id = ?", [id])?;
        Ok(())
    }

    pub fn deliver_queued_task_input(
        &self,
        id: i64,
    ) -> Result<Option<TaskInputRecord>, rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let queued: Option<(String, String, String)> = db
                .conn
                .query_row(
                    "SELECT task_id, source, message FROM queued_task_input WHERE id = ?",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((task_id, source, message)) = queued else {
                return Ok(None);
            };
            let delivered = db.insert_delivered_task_input(&task_id, &source, &message)?;
            db.conn
                .execute("DELETE FROM queued_task_input WHERE id = ?", [id])?;
            Ok(delivered)
        })
    }

    pub fn deliver_next_released_task_input(
        &self,
        task_id: &str,
        session_pid: u32,
        include_preparing: bool,
    ) -> Result<Option<TaskInputRecord>, rusqlite::Error> {
        let queued: Option<(i64, String)> = self
            .conn
            .query_row(
                "SELECT id, state FROM queued_task_input
                 WHERE task_id = ? AND session_pid = ? ORDER BY id LIMIT 1",
                params![task_id, session_pid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match queued {
            Some((id, state)) if state == "held" || (include_preparing && state == "preparing") => {
                self.deliver_queued_task_input(id)
            }
            // An uncertain earlier slot may still be the daemon release this
            // evidence describes. It is a FIFO barrier: skipping it would
            // falsely attribute that release to a later message.
            Some(_) | None => Ok(None),
        }
    }

    pub fn count_queued_task_inputs(&self, task_id: &str) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM queued_task_input WHERE task_id = ?",
            [task_id],
            |row| row.get(0),
        )
    }

    pub fn count_held_task_inputs(
        &self,
        task_id: &str,
        session_pid: u32,
    ) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM queued_task_input
             WHERE task_id = ? AND session_pid = ? AND state = 'held'",
            params![task_id, session_pid],
            |row| row.get(0),
        )
    }

    pub fn has_uncertain_task_inputs(
        &self,
        task_id: &str,
        session_pid: u32,
    ) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(
                    SELECT 1 FROM queued_task_input
                    WHERE task_id = ? AND session_pid = ? AND state = 'uncertain'
                 )",
            params![task_id, session_pid],
            |row| row.get(0),
        )
    }

    /// A server restart cannot know whether a `preparing` reservation reached
    /// the daemon before the process stopped. Keep the message visible, but do
    /// not let reconnect invent either acceptance or delivery.
    pub fn mark_preparing_task_inputs_uncertain(&self) -> Result<usize, rusqlite::Error> {
        self.conn.execute(
            "UPDATE queued_task_input
             SET state = 'uncertain', reason = 'server interrupted while daemon acceptance was pending'
             WHERE state = 'preparing'",
            [],
        )
    }

    pub fn pending_task_input_incarnations(&self) -> Result<Vec<(String, u32)>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT task_id, session_pid FROM queued_task_input
             WHERE state IN ('preparing', 'held') AND session_pid IS NOT NULL",
        )?;
        let owners = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect();
        owners
    }

    pub fn mark_pending_task_inputs_uncertain_for_incarnation(
        &self,
        task_id: &str,
        session_pid: u32,
    ) -> Result<usize, rusqlite::Error> {
        self.conn.execute(
            "UPDATE queued_task_input
             SET state = 'uncertain', reason = 'owning daemon session was replaced or exited before delivery was proven'
             WHERE task_id = ? AND session_pid = ? AND state IN ('preparing', 'held')",
            params![task_id, session_pid],
        )
    }

    pub fn queued_task_input_reason_for_id(
        &self,
        id: i64,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT CASE state
                    WHEN 'held' THEN 'input_held_by_draft'
                    WHEN 'uncertain' THEN 'delivery_uncertain'
                    ELSE 'sending'
                 END
                 FROM queued_task_input WHERE id = ?",
                [id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn queued_task_input_reason(
        &self,
        task_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT CASE state
                    WHEN 'held' THEN 'input_held_by_draft'
                    WHEN 'uncertain' THEN 'delivery_uncertain'
                    ELSE 'sending'
                 END
                 FROM queued_task_input WHERE task_id = ? ORDER BY id LIMIT 1",
                [task_id],
                |row| row.get(0),
            )
            .optional()
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
