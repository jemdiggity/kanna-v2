//! Append-only task event log.
//!
//! An orchestrator agent watching N child tasks cannot use `kanna_wait_task`:
//! it blocks on one id and resolves only on finish. This log is the multi-task
//! alternative — every event a watcher needs, ordered by an opaque cursor, so a
//! caller that loops on `(cursor -> events, next cursor)` sees each event
//! exactly once and never loses one that fired between two calls.
//!
//! **Why `seq` is a safe cursor.** `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`
//! and SQLite admits one writer at a time for the whole database: a writer
//! cannot allocate a `seq` until the previous writer has committed. There is
//! therefore no window in which a higher `seq` is visible while a lower one is
//! still uncommitted, so `WHERE seq > cursor ORDER BY seq` can never skip an
//! event. Readers additionally bound their query by a head read *before* the
//! event query, so the cursor they hand back is never ahead of what they read.
//!
//! Events are appended by the same DB calls that already change the state they
//! describe, inside the caller's transaction where there is one. That keeps the
//! log consistent with `pipeline_item`/`stage_run` by construction rather than
//! by every call site remembering to publish.

use super::Db;
use rusqlite::{types::Value as SqlValue, OptionalExtension};
use serde_json::{json, Value};
use std::sync::LazyLock;
use tokio::sync::Notify;

/// Woken whenever an event is appended, so a waiting reader returns as soon as
/// the event lands instead of on its next tick. This is a latency optimization
/// only: the cursor — not this signal — is what makes delivery lossless, so a
/// missed wake costs latency, never an event.
static APPENDED: LazyLock<Notify> = LazyLock::new(Notify::new);

/// A `Notified` future that must be created *before* the caller queries for
/// events; otherwise an append landing between the query and the await would be
/// missed until the next tick.
pub fn appended() -> tokio::sync::futures::Notified<'static> {
    APPENDED.notified()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskEventKind {
    TaskCreated,
    RunStarted,
    RunFinished,
    StageChanged,
    TaskClosed,
    PrCreated,
    RevisionRequested,
    /// The task's agent is parked on an interactive prompt and will not make
    /// progress until someone answers it. Derived from the daemon's `Waiting`
    /// session status, which is a positive match on a prompt the agent CLI
    /// rendered — never inferred from a session merely going quiet, so a long
    /// build is never mislabelled as blocked.
    AwaitingInput,
}

impl TaskEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TaskCreated => "task.created",
            Self::RunStarted => "run.started",
            Self::RunFinished => "run.finished",
            Self::StageChanged => "stage.changed",
            Self::TaskClosed => "task.closed",
            Self::PrCreated => "task.pr_created",
            Self::RevisionRequested => "task.revision_requested",
            Self::AwaitingInput => "task.awaiting_input",
        }
    }

    #[cfg(test)]
    pub const ALL: &'static [Self] = &[
        Self::TaskCreated,
        Self::RunStarted,
        Self::RunFinished,
        Self::StageChanged,
        Self::TaskClosed,
        Self::PrCreated,
        Self::RevisionRequested,
        Self::AwaitingInput,
    ];
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskEvent {
    pub seq: i64,
    pub task_id: String,
    pub event_type: String,
    pub payload: Value,
    pub created_at: String,
}

impl TaskEvent {
    pub fn to_json(&self) -> Value {
        json!({
            "seq": self.seq,
            "taskId": self.task_id,
            "type": self.event_type,
            "payload": self.payload,
            "createdAt": self.created_at,
        })
    }
}

/// Which tasks a reader cares about. An orchestrator names its children; a
/// human-facing tool may watch a whole repo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskEventScope {
    Tasks(Vec<String>),
    Repo(String),
}

impl TaskEventScope {
    fn where_clause(&self) -> String {
        match self {
            Self::Tasks(task_ids) => {
                if task_ids.is_empty() {
                    return "0".to_string();
                }
                let placeholders = vec!["?"; task_ids.len()].join(", ");
                format!("task_id IN ({placeholders})")
            }
            Self::Repo(_) => {
                "task_id IN (SELECT id FROM pipeline_item WHERE repo_id = ?)".to_string()
            }
        }
    }

    fn params(&self) -> Vec<SqlValue> {
        match self {
            Self::Tasks(task_ids) => task_ids
                .iter()
                .map(|task_id| SqlValue::Text(task_id.clone()))
                .collect(),
            Self::Repo(repo_id) => vec![SqlValue::Text(repo_id.clone())],
        }
    }
}

impl Db {
    /// Append one event. Callers pass a JSON object payload; `task_id` must be
    /// a resolved pipeline item id (not a branch name).
    pub fn append_task_event(
        &self,
        task_id: &str,
        kind: TaskEventKind,
        payload: Value,
    ) -> Result<(), rusqlite::Error> {
        let payload = if payload.is_null() {
            None
        } else {
            Some(payload.to_string())
        };
        self.conn.execute(
            "INSERT INTO task_event (task_id, type, payload) VALUES (?, ?, ?)",
            rusqlite::params![task_id, kind.as_str(), payload],
        )?;
        APPENDED.notify_waiters();
        Ok(())
    }

    /// Highest allocated sequence number, or 0 for an empty log. Read this
    /// *before* querying events so the cursor handed back never outruns the
    /// rows actually returned.
    pub fn latest_task_event_seq(&self) -> Result<i64, rusqlite::Error> {
        self.conn
            .query_row("SELECT COALESCE(MAX(seq), 0) FROM task_event", [], |row| {
                row.get(0)
            })
    }

    /// Events in `scope` with `after_seq < seq <= head_seq`, oldest first.
    pub fn list_task_events(
        &self,
        scope: &TaskEventScope,
        after_seq: i64,
        head_seq: i64,
        limit: i64,
    ) -> Result<Vec<TaskEvent>, rusqlite::Error> {
        let sql = format!(
            "SELECT seq, task_id, type, payload, created_at
             FROM task_event
             WHERE seq > ? AND seq <= ? AND {}
             ORDER BY seq ASC
             LIMIT ?",
            scope.where_clause()
        );
        let mut params: Vec<SqlValue> =
            vec![SqlValue::Integer(after_seq), SqlValue::Integer(head_seq)];
        params.extend(scope.params());
        params.push(SqlValue::Integer(limit));

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params), |row| {
            let payload: Option<String> = row.get(3)?;
            Ok(TaskEvent {
                seq: row.get(0)?,
                task_id: row.get(1)?,
                event_type: row.get(2)?,
                payload: payload
                    .and_then(|payload| serde_json::from_str(&payload).ok())
                    .unwrap_or_else(|| json!({})),
                created_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Attach (or clear) the task that receives this task's completion
    /// notification. `notify_task_id` was creation-time only; an orchestrator
    /// that adopts an already-running task needs to set it afterwards.
    ///
    /// Setting a *new* target clears `notified_at`, so a task that already
    /// notified a previous parent still notifies the new one.
    pub fn update_pipeline_item_notify_task(
        &self,
        task_id: &str,
        notify_task_id: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item
             SET notify_task_id = ?1,
                 notified_at = CASE
                     WHEN ?1 IS NOT NULL AND COALESCE(notify_task_id, '') != ?1 THEN NULL
                     ELSE notified_at
                 END,
                 updated_at = datetime('now')
             WHERE id = ?2 AND closed_at IS NULL",
            rusqlite::params![notify_task_id, task_id],
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    /// Record the daemon's view of a task session: busy, waiting (parked on an
    /// interactive prompt), or idle. Unlike `activity` this is
    /// selection-independent and never collapses waiting into idle, which is
    /// what makes a blocked agent visible at all.
    ///
    /// Returns whether the stored status changed. Crossing into `waiting`
    /// appends the `task.awaiting_input` event exactly once per block.
    pub fn update_pipeline_item_runtime_status(
        &self,
        task_id: &str,
        runtime_status: &str,
        waiting_prompt: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let previous: Option<Option<String>> = db
                .conn
                .query_row(
                    "SELECT runtime_status FROM pipeline_item WHERE id = ? AND closed_at IS NULL",
                    [task_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(previous) = previous else {
                return Ok(false);
            };
            if previous.as_deref() == Some(runtime_status) {
                return Ok(false);
            }
            db.conn.execute(
                "UPDATE pipeline_item
                 SET runtime_status = ?, updated_at = datetime('now')
                 WHERE id = ?",
                (runtime_status, task_id),
            )?;
            if runtime_status == "waiting" {
                db.append_task_event(
                    task_id,
                    TaskEventKind::AwaitingInput,
                    json!({ "prompt": waiting_prompt }),
                )?;
            }
            Ok(true)
        })
    }

    #[cfg(test)]
    pub fn get_pipeline_item_runtime_status(
        &self,
        task_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT runtime_status FROM pipeline_item WHERE id = ?",
                [task_id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
    }
}
