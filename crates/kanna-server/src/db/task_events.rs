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
    /// A manual-transition main-stage agent session ended without recording a
    /// stage verdict. The work is parked for an operator or manager to inspect
    /// and advance; unlike `ActivityChanged`, this is an authoritative daemon
    /// Exit lifecycle event rather than a display-state heuristic.
    AwaitingAdvance,
    /// The daemon's provider-neutral runtime classification settled from
    /// `busy` to a non-busy state. This is the manager activity dimension,
    /// never the human read/unread inbox dimension exposed as `activity`.
    RuntimeSettled,
    /// A provider-neutral display transition that held past the server's
    /// debounce. Every direction and provider uses this same event; unlike
    /// `AwaitingInput`, it does not identify a question.
    ActivityChanged,
    /// The task's merge request reached the repo's merge agent. `payload.source`
    /// says who delivered it: `agent` for the approve post's own
    /// `kanna_signal_merge_handoff`, `engine` for the backstop Kanna runs
    /// before closing a task whose final stage promised the handoff.
    MergeSignaled,
    /// The task finished a final stage that declares the merge-signaling
    /// `approve` post, but no PR URL was ever recorded — so there was nothing
    /// to hand off and Kanna refused to close the task. A watcher must treat
    /// this as a failed approval, not a completed workflow.
    MergeHandoffMissing,
    /// A message was delivered into the task's agent session from outside it
    /// — an operator or manager call to `POST /v1/tasks/{id}/input`.
    /// Historical events may have source `notify`. `payload.source` says who
    /// declared authorship, `payload.preview` carries a bounded prefix and
    /// `payload.truncated` says whether it was cut; the full text is the
    /// durable `task_input` row this event announces, readable through
    /// `GET /v1/tasks/{id}/inputs`.
    InputDelivered,
    /// The task's agent session started or stopped refusing messages
    /// delivered into it from outside. `payload.inputBlocked` names the reason
    /// while it is blocked (`inherited-draft-unknown`) and is null when it
    /// clears. A blocked session is not a failed one and not a busy one: it is
    /// running normally and silently dropping nothing — every delivery into it
    /// is refused, including the pre-close merge handoff, until the composer it
    /// inherited is resolved.
    InputBlocked,
    /// A detached workspace teardown failed to start or exceeded its deadline.
    TeardownFailed,
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
            Self::AwaitingAdvance => "task.awaiting_advance",
            Self::RuntimeSettled => "task.runtime_settled",
            Self::ActivityChanged => "task.activity_changed",
            Self::MergeSignaled => "task.merge_signaled",
            Self::MergeHandoffMissing => "task.merge_handoff_missing",
            Self::InputDelivered => "task.input_delivered",
            Self::InputBlocked => "task.input_blocked",
            Self::TeardownFailed => "task.teardown_failed",
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
        Self::AwaitingAdvance,
        Self::RuntimeSettled,
        Self::ActivityChanged,
        Self::MergeSignaled,
        Self::MergeHandoffMissing,
        Self::InputDelivered,
        Self::InputBlocked,
        Self::TeardownFailed,
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

    fn pipeline_item_where_clause(&self) -> String {
        match self {
            Self::Tasks(task_ids) => {
                if task_ids.is_empty() {
                    return "0".to_string();
                }
                format!("id IN ({})", vec!["?"; task_ids.len()].join(", "))
            }
            Self::Children(_) => "parent_task_id = ?".to_string(),
            Self::Repo(_) => "repo_id = ?".to_string(),
            Self::RepoRemoteUrlHash(_) => {
                "repo_id IN (SELECT id FROM repo WHERE remote_url_hash = ?)".to_string()
            }
        }
    }
}

/// `AND <column> NOT IN (?, …)` for a non-empty exclusion list, or an empty
/// string so the surrounding query is unchanged when nothing is excluded.
///
/// Exclusion is a filter layered over a scope, never a scope of its own: it
/// does not participate in cursor identity, so a caller may add or drop an
/// excluded task between two calls without losing its checkpoint.
fn exclusion_clause(column: &str, exclude_task_ids: &[String]) -> String {
    if exclude_task_ids.is_empty() {
        return String::new();
    }
    let placeholders = vec!["?"; exclude_task_ids.len()].join(", ");
    format!(" AND {column} NOT IN ({placeholders})")
}

fn exclusion_params(exclude_task_ids: &[String]) -> impl Iterator<Item = SqlValue> + '_ {
    exclude_task_ids
        .iter()
        .map(|task_id| SqlValue::Text(task_id.clone()))
}

impl Db {
    pub fn list_non_busy_task_runtime_states(
        &self,
        scope: &TaskEventScope,
        exclude_task_ids: &[String],
        after_task_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<(String, String)>, rusqlite::Error> {
        let sql = format!(
            "SELECT id, runtime_status FROM pipeline_item
             WHERE closed_at IS NULL
               AND runtime_status IN ('idle', 'waiting', 'exited')
               AND runtime_event_pending_at IS NULL
               AND (? IS NULL OR id > ?)
               AND {}{}
             ORDER BY id ASC
             LIMIT ?",
            scope.pipeline_item_where_clause(),
            exclusion_clause("id", exclude_task_ids)
        );
        let mut params = vec![
            after_task_id
                .map(|task_id| SqlValue::Text(task_id.to_string()))
                .unwrap_or(SqlValue::Null),
            after_task_id
                .map(|task_id| SqlValue::Text(task_id.to_string()))
                .unwrap_or(SqlValue::Null),
        ];
        params.extend(scope.params());
        params.extend(exclusion_params(exclude_task_ids));
        params.push(SqlValue::Integer(limit));
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(params), |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        rows.collect()
    }

    /// Append one event. Callers pass a JSON object payload; `task_id` must be
    /// a resolved task id (a `pipeline_item` row id, not a branch name).
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
    #[cfg(test)]
    pub fn list_task_events(
        &self,
        scope: &TaskEventScope,
        after_seq: i64,
        head_seq: i64,
        limit: i64,
    ) -> Result<Vec<TaskEvent>, rusqlite::Error> {
        self.list_task_events_excluding(scope, &[], after_seq, head_seq, limit)
    }

    /// Events in `scope` with `after_seq < seq <= head_seq`, oldest first,
    /// minus every event whose task is in `exclude_task_ids` — how a
    /// repo-scoped watcher running inside a task session keeps its own runtime
    /// edges out of its wake-up feed.
    pub fn list_task_events_excluding(
        &self,
        scope: &TaskEventScope,
        exclude_task_ids: &[String],
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
             WHERE seq > ? AND seq <= ? AND {}{}
             ORDER BY seq ASC
             LIMIT ?",
            scope.where_clause(),
            exclusion_clause("task_id", exclude_task_ids)
        );
        let mut params: Vec<SqlValue> =
            vec![SqlValue::Integer(after_seq), SqlValue::Integer(head_seq)];
        params.extend(scope.params());
        params.extend(exclusion_params(exclude_task_ids));
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

    /// Resolve the stage in effect when an already-retained event was written.
    ///
    /// New and historical run rows carry `stage`; task creation does too, and
    /// a stage transition carries `toStage`. Looking backward through those
    /// immutable facts lets the HTTP replay repair older event kinds that did
    /// not stamp a stage of their own without substituting today's task stage.
    pub fn task_event_stage_at(
        &self,
        task_id: &str,
        event_seq: i64,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT COALESCE(
                     json_extract(payload, '$.stage'),
                     json_extract(payload, '$.toStage')
                 )
                 FROM task_event
                 WHERE task_id = ?1
                   AND seq <= ?2
                   AND COALESCE(
                       json_extract(payload, '$.stage'),
                       json_extract(payload, '$.toStage')
                   ) IS NOT NULL
                 ORDER BY seq DESC
                 LIMIT 1",
                rusqlite::params![task_id, event_seq],
                |row| row.get(0),
            )
            .optional()
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
        if self.conn.is_autocommit() {
            self.with_immediate_transaction(|db| {
                db.update_pipeline_item_runtime_status_in_transaction(
                    task_id,
                    runtime_status,
                    waiting_prompt,
                )
            })
        } else {
            self.update_pipeline_item_runtime_status_in_transaction(
                task_id,
                runtime_status,
                waiting_prompt,
            )
        }
    }

    fn update_pipeline_item_runtime_status_in_transaction(
        &self,
        task_id: &str,
        runtime_status: &str,
        waiting_prompt: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        let previous: Option<(Option<String>, Option<String>)> = self
            .conn
            .query_row(
                "SELECT runtime_status, runtime_event_pending_at
                 FROM pipeline_item WHERE id = ? AND closed_at IS NULL",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((previous, pending_at)) = previous else {
            return Ok(false);
        };
        if previous.as_deref() == Some(runtime_status) {
            return Ok(false);
        }
        if runtime_status == "busy" {
            // Busy is asserted immediately. Only the following non-busy side
            // needs damping, so it has an unambiguous busy baseline.
            self.conn.execute(
                "UPDATE pipeline_item
                 SET runtime_status = ?, runtime_event_baseline = 'busy',
                     runtime_event_pending_at = NULL, updated_at = datetime('now')
                 WHERE id = ?",
                (runtime_status, task_id),
            )?;
        } else if previous.as_deref() == Some("busy") || previous.is_none() || pending_at.is_some()
        {
            // A non-busy verdict must hold for the fixed window. A change
            // between candidate non-busy states restarts that same window.
            self.conn.execute(
                "UPDATE pipeline_item
                 SET runtime_status = ?,
                     runtime_event_baseline = COALESCE(runtime_event_baseline, ?),
                     runtime_event_pending_at = datetime('now'),
                     updated_at = datetime('now')
                 WHERE id = ?",
                (runtime_status, previous.as_deref(), task_id),
            )?;
        } else {
            self.conn.execute(
                "UPDATE pipeline_item
                 SET runtime_status = ?, runtime_event_baseline = ?,
                     runtime_event_pending_at = NULL, updated_at = datetime('now')
                 WHERE id = ?",
                (runtime_status, runtime_status, task_id),
            )?;
        }
        if runtime_status == "waiting" {
            self.append_task_event(
                task_id,
                TaskEventKind::AwaitingInput,
                json!({ "prompt": waiting_prompt }),
            )?;
        }
        Ok(true)
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

    /// Record whether messages delivered into this task's agent session are
    /// being refused, and why. `None` clears it.
    ///
    /// Returns whether the stored value changed; each edge appends one
    /// `task.input_blocked` event. Kept off `activity` and `runtime_status`
    /// deliberately — a wedged session is `idle` and reads as perfectly
    /// healthy through both, which is exactly why the wedge was invisible
    /// until an unrelated agent's delivery failed against it.
    pub fn update_pipeline_item_input_blocked(
        &self,
        task_id: &str,
        input_blocked: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let previous: Option<Option<String>> = db
                .conn
                .query_row(
                    "SELECT input_blocked FROM pipeline_item WHERE id = ? AND closed_at IS NULL",
                    [task_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(previous) = previous else {
                return Ok(false);
            };
            if previous.as_deref() == input_blocked {
                return Ok(false);
            }
            db.conn.execute(
                "UPDATE pipeline_item
                 SET input_blocked = ?, updated_at = datetime('now')
                 WHERE id = ?",
                (input_blocked, task_id),
            )?;
            db.append_task_event(
                task_id,
                TaskEventKind::InputBlocked,
                json!({ "inputBlocked": input_blocked }),
            )?;
            Ok(true)
        })
    }

    #[cfg(test)]
    pub fn get_pipeline_item_input_blocked(
        &self,
        task_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT input_blocked FROM pipeline_item WHERE id = ?",
                [task_id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
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
