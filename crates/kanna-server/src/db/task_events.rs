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
use std::cmp::Ordering;
use std::collections::BinaryHeap;
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
    WorkflowChanged,
    TaskClosed,
    PrCreated,
    RevisionRequested,
    /// The task's agent is parked on an interactive prompt and will not make
    /// progress until someone answers it. Derived from the daemon's `Waiting`
    /// session status, which is a positive match on a prompt the agent CLI
    /// rendered — never inferred from a session merely going quiet, so a long
    /// build is never mislabelled as blocked.
    AwaitingInput,
    /// A provider-neutral stopped edge. This is weaker than `AwaitingInput`:
    /// the task moved from working to idle/unread and has a transcript tail,
    /// but the provider did not necessarily expose a structured prompt.
    ActivityChanged,
    /// The task's merge request reached the repo's merge agent. `payload.source`
    /// says who delivered it: `agent` for the approve post's own
    /// `kanna_signal_merge_handoff`, `engine` for the backstop Kanna runs
    /// before closing a task whose final stage promised the handoff.
    MergeSignaled,
    /// The task finished a final stage that declares the merge-signaling
    /// `approve` post, but no PR URL was ever recorded — so there was nothing
    /// to hand off and Kanna refused to close the task. A watcher must treat
    /// this as a failed approval, not a completed pipeline.
    MergeHandoffMissing,
    /// A message was delivered into the task's agent session from outside it
    /// — an operator or manager call to `POST /v1/tasks/{id}/input`, or the
    /// server's own completion notification. `payload.source` says who
    /// declared authorship, `payload.preview` carries a bounded prefix and
    /// `payload.truncated` says whether it was cut; the full text is the
    /// durable `task_input` row this event announces, readable through
    /// `GET /v1/tasks/{id}/inputs`.
    InputDelivered,
    /// A cross-machine transfer is shutting the task's agent down so its
    /// conversation can be shipped. `payload.phase` names the step —
    /// `wrap-up-sent`, `idle`, `quit-sent`, `exited`, `already-exited`, or
    /// `degraded` (with `payload.detail` carrying the reason). The wrap-up can
    /// legitimately take minutes, and this is what makes that latency legible
    /// as a transfer rather than as a hung task.
    TransferFinalizing,
}

impl TaskEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TaskCreated => "task.created",
            Self::RunStarted => "run.started",
            Self::RunFinished => "run.finished",
            Self::StageChanged => "stage.changed",
            Self::WorkflowChanged => "task.workflow_changed",
            Self::TaskClosed => "task.closed",
            Self::PrCreated => "task.pr_created",
            Self::RevisionRequested => "task.revision_requested",
            Self::AwaitingInput => "task.awaiting_input",
            Self::ActivityChanged => "task.activity_changed",
            Self::MergeSignaled => "task.merge_signaled",
            Self::MergeHandoffMissing => "task.merge_handoff_missing",
            Self::InputDelivered => "task.input_delivered",
            Self::TransferFinalizing => "task.transfer_finalizing",
        }
    }

    #[cfg(test)]
    pub const ALL: &'static [Self] = &[
        Self::TaskCreated,
        Self::RunStarted,
        Self::RunFinished,
        Self::StageChanged,
        Self::WorkflowChanged,
        Self::TaskClosed,
        Self::PrCreated,
        Self::RevisionRequested,
        Self::AwaitingInput,
        Self::ActivityChanged,
        Self::MergeSignaled,
        Self::MergeHandoffMissing,
        Self::InputDelivered,
        Self::TransferFinalizing,
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

/// Reverse sequence ordering turns `BinaryHeap` into a min-heap. Task-event
/// sequences are unique, so no secondary ordering key is needed.
struct PendingTaskEvent(TaskEvent);

impl PartialEq for PendingTaskEvent {
    fn eq(&self, other: &Self) -> bool {
        self.0.seq == other.0.seq
    }
}

impl Eq for PendingTaskEvent {}

impl PartialOrd for PendingTaskEvent {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PendingTaskEvent {
    fn cmp(&self, other: &Self) -> Ordering {
        other.0.seq.cmp(&self.0.seq)
    }
}

/// Which tasks a reader cares about. An orchestrator names its children, or
/// names *itself* and gets whatever it fanned out; a human-facing tool may
/// watch a whole repo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskEventScope {
    Tasks(Vec<String>),
    /// Every task whose `parent_task_id` is this task — the scope an
    /// orchestrator that lost its id list can still name. Resolved per query
    /// rather than snapshotted, so a child created while the caller is blocked
    /// is in scope for the same call.
    ///
    /// Direct children only, and the parent's own events are excluded: this is
    /// exactly the set `TaskDetail::child_task_ids` reports, so ids and events
    /// reconcile against each other without a second rule.
    Children(String),
    Repo(String),
    /// Every task in the repository identified by its normalized remote URL
    /// hash. Repository row ids are installation-local, while this hash is the
    /// identity shared by copies of the same repository on sibling machines.
    RepoRemoteUrlHash(String),
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
            Self::Children(_) => {
                "task_id IN (SELECT id FROM pipeline_item WHERE parent_task_id = ?)".to_string()
            }
            Self::Repo(_) => {
                "task_id IN (SELECT id FROM pipeline_item WHERE repo_id = ?)".to_string()
            }
            Self::RepoRemoteUrlHash(_) => "task_id IN (
                    SELECT pipeline_item.id
                    FROM pipeline_item
                    JOIN repo ON repo.id = pipeline_item.repo_id
                    WHERE repo.remote_url_hash = ?
                )"
            .to_string(),
        }
    }

    fn params(&self) -> Vec<SqlValue> {
        match self {
            Self::Tasks(task_ids) => task_ids
                .iter()
                .map(|task_id| SqlValue::Text(task_id.clone()))
                .collect(),
            Self::Children(parent_task_id) => vec![SqlValue::Text(parent_task_id.clone())],
            Self::Repo(repo_id) => vec![SqlValue::Text(repo_id.clone())],
            Self::RepoRemoteUrlHash(remote_url_hash) => {
                vec![SqlValue::Text(remote_url_hash.clone())]
            }
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
        // `sqlite_sequence` preserves the highest AUTOINCREMENT allocation even
        // when retention deletes every event. `MAX(task_event.seq)` would fall
        // backwards to zero and make a drained response rewind a valid cursor.
        self.conn.query_row(
            "SELECT COALESCE(
                 (SELECT seq FROM sqlite_sequence WHERE name = 'task_event'),
                 0
             )",
            [],
            |row| row.get(0),
        )
    }

    /// Events in `scope` with `after_seq < seq <= head_seq`, oldest first.
    pub fn list_task_events(
        &self,
        scope: &TaskEventScope,
        after_seq: i64,
        head_seq: i64,
        limit: i64,
    ) -> Result<Vec<TaskEvent>, rusqlite::Error> {
        // For a dynamic parent scope, SQLite otherwise prefers one
        // `idx_task_event_task_seq` probe per child. `NOT INDEXED` still permits
        // the INTEGER PRIMARY KEY range seek, and forces work to start at the
        // global cursor instead of scaling with total fan-out on a drained poll.
        let event_source = if matches!(scope, TaskEventScope::Children(_)) {
            "task_event NOT INDEXED"
        } else {
            "task_event"
        };
        let sql = format!(
            "SELECT seq, task_id, type, payload, created_at
             FROM {event_source}
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

    /// Globally ordered events for a known parent-membership snapshot, with
    /// candidate work bounded by `task_ids.len() + limit` index hits.
    ///
    /// This is the legacy p1 upgrade path. Starting from the global sequence
    /// index can walk unrelated retained history for a sparse parent, while a
    /// relationship-first join makes SQLite sort the parent's entire retained
    /// history before applying its global limit. Instead, seed a merge heap
    /// with one indexed row per child and replenish only the child whose row
    /// was consumed. The compatibility path is therefore bounded even when a
    /// child has dense retained history, without sacrificing sparse parents.
    pub fn list_task_event_candidates_bounded(
        &self,
        task_ids: &[String],
        after_seq: i64,
        head_seq: i64,
        limit: i64,
    ) -> Result<Vec<TaskEvent>, rusqlite::Error> {
        if task_ids.is_empty() || limit <= 0 {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT seq, task_id, type, payload, created_at
             FROM task_event INDEXED BY idx_task_event_task_seq
             WHERE task_id = ?1 AND seq > ?2 AND seq <= ?3
             ORDER BY seq ASC
             LIMIT 1",
        )?;
        let read_next = |stmt: &mut rusqlite::Statement<'_>, task_id: &str, after_seq: i64| {
            stmt.query_row(rusqlite::params![task_id, after_seq, head_seq], |row| {
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
            })
            .optional()
        };

        let mut pending = BinaryHeap::with_capacity(task_ids.len());
        for task_id in task_ids {
            if let Some(event) = read_next(&mut stmt, task_id, after_seq)? {
                pending.push(PendingTaskEvent(event));
            }
        }

        let mut events = Vec::with_capacity(limit as usize);
        while events.len() < limit as usize {
            let Some(PendingTaskEvent(event)) = pending.pop() else {
                break;
            };
            let task_id = event.task_id.clone();
            let event_seq = event.seq;
            events.push(event);
            if let Some(next) = read_next(&mut stmt, &task_id, event_seq)? {
                pending.push(PendingTaskEvent(next));
            }
        }
        Ok(events)
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

    /// Record the runtime dimension of a task: what its agent session is
    /// doing, independent of whether a human has read its output.
    ///
    /// The vocabulary is the daemon's own — `busy`, `waiting` (parked on an
    /// interactive prompt), `idle` — plus `exited`, which the server writes
    /// when a session ends without being replaced (see
    /// `mark_task_session_interrupted`). Unlike `activity` this is
    /// selection-independent and never collapses waiting into idle, which is
    /// what makes a blocked agent visible at all, and it never encodes read
    /// state, which is what lets a wait tell a working task from a finished
    /// one it happens to have read.
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

    /// Drop a stale `exited` verdict for a task whose session has been proven
    /// live again — a new running run, or a daemon that still lists the
    /// session. Returns whether anything was cleared.
    ///
    /// Only the terminal value is cleared, and it is cleared to "no verdict
    /// yet" rather than to an invented live one: the daemon owns `busy` /
    /// `waiting` / `idle`, and guessing one here would put a value on the
    /// record that no rendered frame produced. `exited`, by contrast, is a
    /// statement about a process that demonstrably no longer describes this
    /// task, and leaving it would report a running agent as gone — which
    /// `WaitUntil::Finished` resolves on.
    pub fn clear_exited_runtime_status(&self, task_id: &str) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item
             SET runtime_status = NULL, updated_at = datetime('now')
             WHERE id = ? AND runtime_status = 'exited'",
            [task_id],
        )?;
        Ok(rows_affected > 0)
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
