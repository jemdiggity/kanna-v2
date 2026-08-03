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
//! - Events available → return them immediately. Fixed scopes return a numeric
//!   sequence; a parent scope returns the same global sequence bound to the
//!   parent id in a constant-size opaque cursor. `hasMore` says another batch
//!   is already waiting, so the caller loops without waiting.
//! - Nothing available → advance to the global head read before the query and
//!   block until an event arrives or the window elapses. Each recheck advances
//!   again, so unrelated retained history is never rescanned by a drained poll.
//! - Parent membership is evaluated at each read checkpoint. Reparenting never
//!   rewinds the global sequence: events at or below an acknowledged checkpoint
//!   do not become eligible later, while events after it are included whenever
//!   the child is in the parent scope at the next read.

use super::state::AppState;
use super::task_blockers::resolve_existing_task_id;
use crate::db::{Db, TaskEventScope};
use axum::extract::{Query, State};
use axum::Json;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

/// Upper bound on one response. A caller that asks for a whole repo's history
/// gets it in batches with `hasMore` set rather than one unbounded page.
const DEFAULT_EVENT_LIMIT: i64 = 100;
const MAX_EVENT_LIMIT: i64 = 500;
/// Keeps invalid public GET requests and legacy cursor decoding bounded. New
/// parent cursors are normally under 100 bytes; this larger allowance exists
/// only so deployed p1 cursors can make one bounded forward-upgrade pass.
const MAX_CURSOR_LEN: usize = 32 * 1024;
const MAX_LEGACY_PARENT_WATERMARKS: usize = 500;
const LEGACY_CURSOR_SCAN_LIMIT: i64 = 500;

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

#[derive(Debug, Clone)]
enum TaskEventsCursor {
    Sequence(i64),
    ParentV1(ParentTaskEventsCursorV1),
    ParentV3(ParentTaskEventsCursorV3),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ParentTaskEventsCursorV1 {
    parent_task_id: String,
    watermarks: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ParentTaskEventsCursorV3 {
    parent_task_id: String,
    event_seq: i64,
}

const PARENT_CURSOR_V1_PREFIX: &str = "p1.";
const PARENT_CURSOR_V3_PREFIX: &str = "p3.";

fn invalid_cursor() -> (axum::http::StatusCode, String) {
    (
        axum::http::StatusCode::BAD_REQUEST,
        "cursor is not a valid cursor returned by this endpoint".to_string(),
    )
}

fn parse_cursor(
    cursor: Option<&str>,
) -> Result<Option<TaskEventsCursor>, (axum::http::StatusCode, String)> {
    let Some(cursor) = cursor.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if cursor.len() > MAX_CURSOR_LEN {
        return Err(invalid_cursor());
    }
    if let Some(encoded) = cursor.strip_prefix(PARENT_CURSOR_V3_PREFIX) {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| invalid_cursor())?;
        let parsed: ParentTaskEventsCursorV3 =
            serde_json::from_slice(&bytes).map_err(|_| invalid_cursor())?;
        if parsed.event_seq < 0 {
            return Err(invalid_cursor());
        }
        return Ok(Some(TaskEventsCursor::ParentV3(parsed)));
    }
    if let Some(encoded) = cursor.strip_prefix(PARENT_CURSOR_V1_PREFIX) {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| invalid_cursor())?;
        let parsed: ParentTaskEventsCursorV1 =
            serde_json::from_slice(&bytes).map_err(|_| invalid_cursor())?;
        if parsed.watermarks.len() > MAX_LEGACY_PARENT_WATERMARKS
            || parsed.watermarks.values().any(|seq| *seq < 0)
        {
            return Err(invalid_cursor());
        }
        return Ok(Some(TaskEventsCursor::ParentV1(parsed)));
    }
    let sequence = cursor.parse::<i64>().map_err(|_| invalid_cursor())?;
    if sequence < 0 {
        return Err(invalid_cursor());
    }
    Ok(Some(TaskEventsCursor::Sequence(sequence)))
}

fn encode_parent_cursor<T: Serialize>(
    prefix: &str,
    cursor: &T,
) -> Result<String, (axum::http::StatusCode, String)> {
    let bytes = serde_json::to_vec(cursor).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to encode task event cursor: {e}"),
        )
    })?;
    Ok(format!(
        "{prefix}{}",
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

fn db_error(error: rusqlite::Error) -> (axum::http::StatusCode, String) {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        format!("db error: {error}"),
    )
}

fn encode_v3_cursor(
    parent_task_id: &str,
    event_seq: i64,
) -> Result<String, (axum::http::StatusCode, String)> {
    encode_parent_cursor(
        PARENT_CURSOR_V3_PREFIX,
        &ParentTaskEventsCursorV3 {
            parent_task_id: parent_task_id.to_string(),
            event_seq,
        },
    )
}

/// Drain one bounded slice of a deployed p1 cursor. This path exists only for
/// forward compatibility: it validates every client-supplied task id against
/// the current parent, scans via the global `seq > ?` hot path, never adds map
/// entries, and upgrades to constant-size p3 as soon as the uneven legacy
/// watermarks converge.
fn read_legacy_parent_batch(
    db: &Db,
    scope: &TaskEventScope,
    parent_task_id: &str,
    legacy: &ParentTaskEventsCursorV1,
    limit: i64,
) -> Result<EventBatch, (axum::http::StatusCode, String)> {
    if legacy.parent_task_id != parent_task_id {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "cursor belongs to a different parent_task_id scope".to_string(),
        ));
    }

    let members = db
        .list_child_task_ids(parent_task_id)
        .map_err(db_error)?
        .into_iter()
        .collect::<BTreeSet<_>>();
    if legacy
        .watermarks
        .keys()
        .any(|task_id| !members.contains(task_id))
    {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "legacy parent cursor contains a task outside its parent scope".to_string(),
        ));
    }

    // An empty p1 map is already equivalent to a fresh global cursor.
    if legacy.watermarks.is_empty() {
        return read_sequence_batch(db, scope, 0, limit, Some(parent_task_id));
    }

    let floor = legacy.watermarks.values().copied().min().unwrap_or(0);
    let ceiling = legacy.watermarks.values().copied().max().unwrap_or(0);
    let head_seq = db.latest_task_event_seq().map_err(db_error)?;
    if ceiling > head_seq {
        return Err(invalid_cursor());
    }
    let mut candidates = db
        .list_task_events(scope, floor, head_seq, LEGACY_CURSOR_SCAN_LIMIT + 1)
        .map_err(db_error)?;
    let scan_has_more = candidates.len() as i64 > LEGACY_CURSOR_SCAN_LIMIT;
    candidates.truncate(LEGACY_CURSOR_SCAN_LIMIT as usize);

    let missing_member_watermark = ceiling;
    let mut delivered = Vec::new();
    let mut processed_seq = floor;
    let mut stopped_at_page_limit = false;
    for event in candidates {
        let watermark = legacy
            .watermarks
            .get(&event.task_id)
            .copied()
            .unwrap_or(missing_member_watermark);
        if event.seq > watermark {
            if delivered.len() as i64 == limit {
                stopped_at_page_limit = true;
                break;
            }
            delivered.push(event.clone());
        }
        processed_seq = event.seq;
    }

    let fully_scanned = !scan_has_more && !stopped_at_page_limit;
    if fully_scanned {
        processed_seq = head_seq;
    }
    let can_upgrade = processed_seq >= ceiling;
    let has_more = !fully_scanned;
    let cursor = if can_upgrade {
        encode_v3_cursor(parent_task_id, processed_seq)?
    } else {
        let watermarks = legacy
            .watermarks
            .iter()
            .map(|(task_id, watermark)| (task_id.clone(), (*watermark).max(processed_seq)))
            .collect();
        encode_parent_cursor(
            PARENT_CURSOR_V1_PREFIX,
            &ParentTaskEventsCursorV1 {
                parent_task_id: parent_task_id.to_string(),
                watermarks,
            },
        )?
    };

    Ok(EventBatch {
        events: delivered.iter().map(|event| event.to_json()).collect(),
        cursor,
        has_more,
    })
}

fn read_sequence_batch(
    db: &Db,
    scope: &TaskEventScope,
    after_seq: i64,
    limit: i64,
    parent_task_id: Option<&str>,
) -> Result<EventBatch, (axum::http::StatusCode, String)> {
    // Read the head first: the returned cursor must never be ahead of the rows
    // the same call looked at.
    let head_seq = db.latest_task_event_seq().map_err(db_error)?;
    if after_seq > head_seq {
        return Err(invalid_cursor());
    }
    // The lower bound stays a plain range constraint on task_event's INTEGER
    // PRIMARY KEY. Scope filtering happens after that indexable cut, so a
    // drained long poll performs work proportional to new rows, not history.
    let mut events = db
        .list_task_events(scope, after_seq, head_seq, limit + 1)
        .map_err(db_error)?;
    let has_more = events.len() as i64 > limit;
    events.truncate(limit as usize);
    let cursor_seq = if has_more {
        events.last().map(|event| event.seq).unwrap_or(after_seq)
    } else {
        // The query proved there are no more matching rows through this head;
        // skipping unrelated rows prevents every recheck from scanning them.
        head_seq
    };
    let cursor = if let Some(parent_task_id) = parent_task_id {
        encode_v3_cursor(parent_task_id, cursor_seq)?
    } else {
        cursor_seq.to_string()
    };
    Ok(EventBatch {
        events: events.iter().map(|event| event.to_json()).collect(),
        cursor,
        has_more,
    })
}

fn read_batch(
    db_path: &str,
    scope: &TaskEventScope,
    cursor: Option<&TaskEventsCursor>,
    limit: i64,
) -> Result<EventBatch, (axum::http::StatusCode, String)> {
    let db = Db::open(db_path).map_err(db_error)?;
    if let TaskEventScope::Children(parent_task_id) = scope {
        return match cursor {
            Some(TaskEventsCursor::ParentV1(legacy)) => {
                read_legacy_parent_batch(&db, scope, parent_task_id, legacy, limit)
            }
            Some(TaskEventsCursor::ParentV3(parent_cursor)) => {
                if parent_cursor.parent_task_id != *parent_task_id {
                    return Err((
                        axum::http::StatusCode::BAD_REQUEST,
                        "cursor belongs to a different parent_task_id scope".to_string(),
                    ));
                }
                read_sequence_batch(
                    &db,
                    scope,
                    parent_cursor.event_seq,
                    limit,
                    Some(parent_task_id),
                )
            }
            // Numeric parent cursors were returned by the first deployed
            // implementation. Their global watermark maps exactly to p3.
            Some(TaskEventsCursor::Sequence(seq)) => {
                read_sequence_batch(&db, scope, *seq, limit, Some(parent_task_id))
            }
            None => read_sequence_batch(&db, scope, 0, limit, Some(parent_task_id)),
        };
    }

    let after_seq = match cursor {
        Some(TaskEventsCursor::Sequence(seq)) => *seq,
        Some(TaskEventsCursor::ParentV1(_) | TaskEventsCursor::ParentV3(_)) => {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                "parent-scoped cursor cannot be used with a fixed task or repo scope".to_string(),
            ));
        }
        None => 0,
    };
    read_sequence_batch(&db, scope, after_seq, limit, None)
}

pub(super) async fn wait_task_events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TaskEventsQuery>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let mut cursor = parse_cursor(query.cursor.as_deref())?;
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
        let batch = read_batch(&db_path, &scope, cursor.as_ref(), limit)?;
        if !batch.events.is_empty() || batch.has_more {
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
        // Advance the in-flight checkpoint before waiting. Without this, every
        // five-second recheck would rescan unrelated rows between the caller's
        // original cursor and the latest head.
        cursor = parse_cursor(Some(&batch.cursor))?;
        let _ = tokio::time::timeout(
            (deadline - now).min(Duration::from_secs(WAIT_RECHECK_SECS)),
            appended,
        )
        .await;
    }
}
