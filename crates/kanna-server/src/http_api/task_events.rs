//! `GET /v1/task-events` — the multi-task, cursor-based wait.
//!
//! The wait happens here, not in the client: `kanna-mcp` and `kanna-cli` both
//! issue one plain GET and block on the response, so the cursor contract has a
//! single implementation and neither client grows a polling loop of its own.
//!
//! Contract:
//! - `cursor` omitted → the caller is starting fresh and gets the scope's
//!   retained history from the beginning, so events that fired before the first
//!   call are not lost.
//! - Events available → return them immediately. Fixed scopes return the last
//!   delivered `seq`; a parent scope returns an opaque cursor containing one
//!   watermark per current child. `hasMore` says another batch is already
//!   waiting, so the caller loops without waiting.
//! - Nothing available → block until an event arrives or the window elapses,
//!   then return an empty list and advance each current member to the head read
//!   *before* the query. A task adopted later has no watermark, so its retained
//!   history is still eligible even when its sequence numbers are older than
//!   events already delivered for existing children.

use super::state::AppState;
use super::task_blockers::resolve_existing_task_id;
use crate::db::{Db, TaskEventScope};
use axum::extract::{Query, State};
use axum::Json;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

/// Upper bound on one response. A caller that asks for a whole repo's history
/// gets it in batches with `hasMore` set rather than one unbounded page.
const DEFAULT_EVENT_LIMIT: i64 = 100;
const MAX_EVENT_LIMIT: i64 = 500;

/// Backstop re-check while blocked. In-process appends wake the waiter
/// immediately (`db::task_events::appended`); this bounds latency for the rare
/// writer that is not this process — the debug-only E2E SQL route, a test
/// harness writing the database directly.
const WAIT_RECHECK_SECS: u64 = 5;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskEventsQuery {
    cursor: Option<String>,
    /// Comma-separated task ids or branch names. Omit to watch a whole repo.
    task_ids: Option<String>,
    /// Watch this task's direct children instead of naming their ids — the
    /// scope a fan-out can still express after losing the ids it created.
    parent_task_id: Option<String>,
    repo_id: Option<String>,
    timeout_secs: Option<u64>,
    limit: Option<i64>,
}

#[derive(Debug)]
enum TaskEventsCursor {
    Sequence(i64),
    Parent(ParentTaskEventsCursor),
}

#[derive(Debug, Deserialize, Serialize)]
struct ParentTaskEventsCursor {
    parent_task_id: String,
    watermarks: BTreeMap<String, i64>,
}

const PARENT_CURSOR_PREFIX: &str = "p1.";

fn invalid_cursor(cursor: &str) -> (axum::http::StatusCode, String) {
    (
        axum::http::StatusCode::BAD_REQUEST,
        format!("cursor is not a cursor returned by this endpoint: {cursor}"),
    )
}

fn parse_cursor(
    cursor: Option<&str>,
) -> Result<Option<TaskEventsCursor>, (axum::http::StatusCode, String)> {
    let Some(cursor) = cursor.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if let Some(encoded) = cursor.strip_prefix(PARENT_CURSOR_PREFIX) {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| invalid_cursor(cursor))?;
        let parsed = serde_json::from_slice(&bytes).map_err(|_| invalid_cursor(cursor))?;
        return Ok(Some(TaskEventsCursor::Parent(parsed)));
    }
    cursor
        .parse::<i64>()
        .map(TaskEventsCursor::Sequence)
        .map(Some)
        .map_err(|_| invalid_cursor(cursor))
}

fn encode_parent_cursor(
    cursor: &ParentTaskEventsCursor,
) -> Result<String, (axum::http::StatusCode, String)> {
    let bytes = serde_json::to_vec(cursor).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to encode task event cursor: {e}"),
        )
    })?;
    Ok(format!(
        "{PARENT_CURSOR_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    ))
}

fn resolve_scope(
    db: &Db,
    query: &TaskEventsQuery,
) -> Result<TaskEventScope, (axum::http::StatusCode, String)> {
    let task_ids: Vec<String> = query
        .task_ids
        .as_deref()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    if !task_ids.is_empty() {
        // Branch names are accepted everywhere else a task id is; a watcher
        // must not silently observe nothing because it passed one here.
        let resolved = task_ids
            .iter()
            .map(|task_id| resolve_existing_task_id(db, task_id))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(TaskEventScope::Tasks(resolved));
    }

    // Narrower than a repo and, unlike an id list, still nameable by a parent
    // that no longer remembers what it created. Resolved to an id here and
    // matched by `parent_task_id` at query time, so children created after this
    // call started are picked up by the very next read.
    if let Some(parent_task_id) = query
        .parent_task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let resolved = resolve_existing_task_id(db, parent_task_id)?;
        return Ok(TaskEventScope::Children(resolved));
    }

    if let Some(repo_id) = query
        .repo_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(TaskEventScope::Repo(repo_id.to_string()));
    }

    Err((
        axum::http::StatusCode::BAD_REQUEST,
        "task_ids, parent_task_id or repo_id is required: an unscoped event feed \
         would hand an orchestrator every other task's events too"
            .to_string(),
    ))
}

struct EventBatch {
    events: Vec<Value>,
    cursor: String,
    has_more: bool,
}

fn read_batch(
    db_path: &str,
    scope: &TaskEventScope,
    cursor: Option<&TaskEventsCursor>,
    limit: i64,
) -> Result<EventBatch, (axum::http::StatusCode, String)> {
    let db = Db::open(db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {e}"),
        )
    })?;
    if let TaskEventScope::Children(parent_task_id) = scope {
        let prior_watermarks = match cursor {
            Some(TaskEventsCursor::Parent(cursor)) => {
                if cursor.parent_task_id != *parent_task_id {
                    return Err((
                        axum::http::StatusCode::BAD_REQUEST,
                        "cursor belongs to a different parent_task_id scope".to_string(),
                    ));
                }
                cursor.watermarks.clone()
            }
            // Numeric cursors were returned for this scope before parent
            // membership became part of the cursor. Replaying retained child
            // history is the only lossless upgrade behavior: assigning that
            // one sequence to every current child could skip a later adoptee.
            Some(TaskEventsCursor::Sequence(_)) | None => BTreeMap::new(),
        };
        let (head_seq, child_task_ids, mut events) = db
            .list_child_task_events(parent_task_id, &prior_watermarks, limit + 1)
            .map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("db error: {e}"),
                )
            })?;
        let has_more = events.len() as i64 > limit;
        events.truncate(limit as usize);

        let mut watermarks = child_task_ids
            .into_iter()
            .map(|task_id| {
                let watermark = prior_watermarks.get(&task_id).copied().unwrap_or(0);
                (task_id, watermark)
            })
            .collect::<BTreeMap<_, _>>();
        for event in &events {
            watermarks.insert(event.task_id.clone(), event.seq);
        }
        if !has_more {
            // The query inspected every current child's eligible events through
            // this head. Advancing each child independently is safe; a task
            // adopted after this snapshot starts with no watermark at all.
            for watermark in watermarks.values_mut() {
                *watermark = head_seq;
            }
        }
        let cursor = encode_parent_cursor(&ParentTaskEventsCursor {
            parent_task_id: parent_task_id.clone(),
            watermarks,
        })?;
        return Ok(EventBatch {
            events: events.iter().map(|event| event.to_json()).collect(),
            cursor,
            has_more,
        });
    }

    let after_seq = match cursor {
        Some(TaskEventsCursor::Sequence(seq)) => *seq,
        Some(TaskEventsCursor::Parent(_)) => {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                "parent-scoped cursor cannot be used with a fixed task or repo scope".to_string(),
            ));
        }
        None => 0,
    };
    // Read the head first: the returned cursor must never be ahead of the rows
    // the same call looked at.
    let head_seq = db.latest_task_event_seq().map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {e}"),
        )
    })?;
    // Read one past the limit so `hasMore` reports whether a batch is really
    // waiting, rather than guessing from a full page.
    let mut events = db
        .list_task_events(scope, after_seq, head_seq, limit + 1)
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {e}"),
            )
        })?;
    let has_more = events.len() as i64 > limit;
    events.truncate(limit as usize);
    let cursor = events
        .last()
        .map(|event| event.seq)
        .unwrap_or(head_seq)
        .to_string();
    Ok(EventBatch {
        events: events.iter().map(|event| event.to_json()).collect(),
        cursor,
        has_more,
    })
}

pub(super) async fn wait_task_events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TaskEventsQuery>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let after_seq = parse_cursor(query.cursor.as_deref())?;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_EVENT_LIMIT)
        .clamp(1, MAX_EVENT_LIMIT);
    // Clamped in code, not only in the tool catalog: an override catalog must
    // not be able to hand back a window the MCP client is guaranteed to kill.
    let timeout_secs = kanna_tool_catalog::clamp_wait_timeout_secs(
        query
            .timeout_secs
            .unwrap_or(kanna_tool_catalog::DEFAULT_WAIT_TIMEOUT_SECS),
    );

    let db_path = state.config().db_path.clone();
    let scope = {
        let db = Db::open(&db_path).map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("db error: {e}"),
            )
        })?;
        resolve_scope(&db, &query)?
    };

    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        // Arm the wake-up *before* reading, and `enable()` it so it is actually
        // registered: an append landing between the read and the await must
        // wake this call, not wait for the next re-check.
        let mut appended = Box::pin(crate::db::task_event_appended());
        appended.as_mut().enable();
        let batch = read_batch(&db_path, &scope, after_seq.as_ref(), limit)?;
        if !batch.events.is_empty() {
            return Ok(Json(json!({
                "waitOutcome": "events",
                "cursor": batch.cursor.to_string(),
                "events": batch.events,
                "hasMore": batch.has_more,
            })));
        }

        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(Json(json!({
                "waitOutcome": "timeout",
                "cursor": batch.cursor.to_string(),
                "events": [],
                "hasMore": false,
                "waitTimeoutSecs": timeout_secs,
                "waitHint": format!(
                    "no matching task events within {timeout_secs}s. This is not an error \
                     and nothing was lost — call kanna_wait_events again with the returned \
                     cursor to keep watching."
                ),
            })));
        }
        let _ = tokio::time::timeout(
            (deadline - now).min(Duration::from_secs(WAIT_RECHECK_SECS)),
            appended,
        )
        .await;
    }
}
