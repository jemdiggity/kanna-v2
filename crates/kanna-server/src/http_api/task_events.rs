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

use super::lan_trust::AccountWideTaskEventAccess;
use super::state::{AppState, TunneledHttpInvoke};
use super::task_blockers::resolve_existing_task_id;
use crate::db::{Db, TaskEventScope};
use axum::extract::{Extension, Query, State};
use axum::Json;
use base64::Engine;
use kanna_tool_catalog::encode_path_segment;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

/// Upper bound on one response. A caller that asks for a whole repo's history
/// gets it in batches with `hasMore` set rather than one unbounded page.
const DEFAULT_EVENT_LIMIT: i64 = 100;
const MAX_EVENT_LIMIT: i64 = 500;
/// Keeps invalid public GET requests and legacy cursor decoding bounded. New
/// parent cursors are normally under 100 bytes. A deployed p1 cursor may be up
/// to 32 KiB; its bounded upgrade continuation adds one checkpoint field, so
/// leave explicit headroom without allowing an unbounded public request.
const MAX_CURSOR_LEN: usize = 64 * 1024;
const MAX_DEPLOYED_PARENT_CURSOR_LEN: usize = 32 * 1024;
const MAX_LEGACY_PARENT_WATERMARKS: usize = 500;
const LEGACY_CURSOR_SCAN_LIMIT: i64 = 500;

/// Backstop re-check while blocked. In-process appends wake the waiter
/// immediately (`db::task_events::appended`); this bounds latency for the rare
/// writer that is not this process — the debug-only E2E SQL route, a test
/// harness writing the database directly.
const WAIT_RECHECK_SECS: u64 = 5;
const AGGREGATE_CURSOR_PREFIX: &str = "ks1.";
const AGGREGATE_WAIT_SESSION_TTL: Duration = Duration::from_secs(10 * 60);
const ZERO_TIMEOUT_DRAIN_BUDGET: Duration = Duration::from_millis(100);
const MAX_AGGREGATE_WAIT_SESSIONS: usize = 256;
const MAX_AGGREGATE_MACHINES: usize = 128;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskEventsQuery {
    cursor: Option<String>,
    /// Comma-separated task ids or branch names. Omit to watch a whole repo.
    task_ids: Option<String>,
    /// Watch this task's direct children instead of naming their ids — the
    /// scope a fan-out can still express after losing the ids it created.
    parent_task_id: Option<String>,
    repo_id: Option<String>,
    /// Machine-independent repository identity. The public catalog exposes it
    /// for callers that already have the hash; aggregate repo-id waits resolve
    /// their local row to this value before contacting peers.
    repo_remote_url_hash: Option<String>,
    timeout_secs: Option<u64>,
    limit: Option<i64>,
    /// Used by kanna-mcp's existing km1 fan-in so its native local sub-wait
    /// does not recursively start the server-side fan-in too.
    #[serde(default)]
    local_only: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum AggregateScope {
    Tasks { task_ids: Vec<String> },
    Children { parent_task_id: String },
    Repo { remote_url_hash: String },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AggregateCursor {
    local_machine_id: String,
    scope: AggregateScope,
    machine_ids: Vec<String>,
    cursors_by_machine: BTreeMap<String, String>,
}

struct AggregateWaitCompletion {
    machine_id: String,
    result: Result<Value, String>,
}

struct AggregateWaitSession {
    cursor: AggregateCursor,
    pending: tokio::task::JoinSet<AggregateWaitCompletion>,
    pending_machines: HashSet<String>,
    pending_limit: Option<i64>,
    last_touched: tokio::time::Instant,
}

#[derive(Default)]
pub(super) struct AggregateWaitRegistry {
    sessions: HashMap<String, AggregateWaitSession>,
    reaper_started: bool,
}

impl AggregateWaitRegistry {
    fn abort_session(mut session: AggregateWaitSession) {
        session.pending.abort_all();
    }

    fn evict_expired(&mut self, now: tokio::time::Instant) {
        let expired = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                now.duration_since(session.last_touched) >= AGGREGATE_WAIT_SESSION_TTL
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in expired {
            if let Some(session) = self.sessions.remove(&key) {
                Self::abort_session(session);
            }
        }
    }

    fn insert_bounded(&mut self, key: String, session: AggregateWaitSession) {
        if let Some(replaced) = self.sessions.remove(&key) {
            Self::abort_session(replaced);
        }
        while self.sessions.len() >= MAX_AGGREGATE_WAIT_SESSIONS {
            let Some(oldest_key) = self
                .sessions
                .iter()
                .min_by_key(|(_, session)| session.last_touched)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(evicted) = self.sessions.remove(&oldest_key) {
                Self::abort_session(evicted);
            }
        }
        self.sessions.insert(key, session);
    }
}

fn ensure_aggregate_wait_reaper(state: &Arc<AppState>) {
    start_aggregate_wait_reaper(Arc::clone(&state.aggregate_task_event_waits));
}

fn start_aggregate_wait_reaper(registry: Arc<std::sync::Mutex<AggregateWaitRegistry>>) {
    {
        let mut registry = registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if registry.reaper_started {
            return;
        }
        registry.reaper_started = true;
    }

    let registry = Arc::downgrade(&registry);
    tokio::spawn(async move {
        loop {
            let Some(registry) = registry.upgrade() else {
                break;
            };
            let sleep_for = {
                let mut registry = registry
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let now = tokio::time::Instant::now();
                registry.evict_expired(now);
                registry
                    .sessions
                    .values()
                    .map(|session| {
                        AGGREGATE_WAIT_SESSION_TTL
                            .saturating_sub(now.duration_since(session.last_touched))
                    })
                    .min()
                    .unwrap_or(AGGREGATE_WAIT_SESSION_TTL)
            };
            drop(registry);
            tokio::time::sleep(sleep_for).await;
        }
    });
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
    /// Global progress made while draining this legacy map. Deployed p1
    /// cursors omit it. Once present, entries at or below this boundary can be
    /// discarded safely, including stale children that later reattach.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event_seq: Option<i64>,
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
        if (parsed.event_seq.is_none() && cursor.len() > MAX_DEPLOYED_PARENT_CURSOR_LEN)
            || parsed.watermarks.len() > MAX_LEGACY_PARENT_WATERMARKS
            || parsed.event_seq.is_some_and(|seq| seq < 0)
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
    let encoded = format!(
        "{prefix}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    );
    if encoded.len() > MAX_CURSOR_LEN {
        return Err((
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "failed to encode a bounded task event cursor".to_string(),
        ));
    }
    Ok(encoded)
}

fn resolve_scope(
    db: &Db,
    query: &TaskEventsQuery,
    tolerate_missing_tasks: bool,
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
        let resolved = if tolerate_missing_tasks {
            let mut resolved = Vec::new();
            for task_id in &task_ids {
                if let Some(task_id) = db.resolve_pipeline_item_id(task_id).map_err(db_error)? {
                    resolved.push(task_id);
                }
            }
            resolved
        } else {
            task_ids
                .iter()
                .map(|task_id| resolve_existing_task_id(db, task_id))
                .collect::<Result<Vec<_>, _>>()?
        };
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
        let resolved = if tolerate_missing_tasks {
            db.resolve_pipeline_item_id(parent_task_id)
                .map_err(db_error)?
                .unwrap_or_else(|| parent_task_id.to_string())
        } else {
            resolve_existing_task_id(db, parent_task_id)?
        };
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

    if let Some(remote_url_hash) = query
        .repo_remote_url_hash
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(TaskEventScope::RepoRemoteUrlHash(
            remote_url_hash.to_string(),
        ));
    }

    Err((
        axum::http::StatusCode::BAD_REQUEST,
        "task_ids, parent_task_id, repo_id or repo_remote_url_hash is required: an unscoped event feed \
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
/// forward compatibility: stale map entries cannot widen the current-parent
/// SQL scope, scans use the parent and per-task indexes, and the cursor
/// upgrades to constant-size p3 as soon as every legacy acknowledgement is
/// behind its global checkpoint.
fn read_legacy_parent_batch_with_hook(
    db: &Db,
    parent_task_id: &str,
    legacy: &ParentTaskEventsCursorV1,
    limit: i64,
    after_membership_read: impl FnOnce(),
) -> Result<EventBatch, (axum::http::StatusCode, String)> {
    if legacy.parent_task_id != parent_task_id {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "cursor belongs to a different parent_task_id scope".to_string(),
        ));
    }

    let (head_seq, members, mut candidates, cursor_is_valid) = db
        .with_read_transaction(|db| {
            // The head read establishes the WAL snapshot before membership is
            // observed. Validate cursor state against that same snapshot before
            // doing membership or candidate work; a forged future cursor must
            // not trigger a potentially expensive compatibility scan.
            let head_seq = db.latest_task_event_seq()?;
            if legacy
                .watermarks
                .values()
                .any(|watermark| *watermark > head_seq)
                || legacy.event_seq.is_some_and(|seq| seq > head_seq)
            {
                return Ok((head_seq, Vec::new(), Vec::new(), false));
            }
            let members = db.list_child_task_ids(parent_task_id)?;
            after_membership_read();
            let after_seq = legacy.event_seq.unwrap_or_else(|| {
                members
                    .iter()
                    .map(|task_id| legacy.watermarks.get(task_id).copied().unwrap_or(0))
                    .min()
                    .unwrap_or(0)
            });
            let candidates = db.list_task_event_candidates_bounded(
                &members,
                after_seq,
                head_seq,
                LEGACY_CURSOR_SCAN_LIMIT + 1,
            )?;
            Ok((head_seq, members, candidates, true))
        })
        .map_err(db_error)?;
    if !cursor_is_valid {
        return Err(invalid_cursor());
    }

    // A p1 map captured membership at issuance. Entries for children since
    // reparented away are legitimate but irrelevant to the current scope;
    // conversely, a current child absent from the map was adopted later and
    // retains p1's zero-watermark delivery semantics for the first upgrade
    // snapshot. Continuations carry a global checkpoint and never grow the
    // deployed map, so a valid 500-entry p1 always returns a valid cursor.
    let after_seq = legacy.event_seq.unwrap_or_else(|| {
        members
            .iter()
            .map(|task_id| legacy.watermarks.get(task_id).copied().unwrap_or(0))
            .min()
            .unwrap_or(0)
    });
    // Include stale entries in the safe compaction ceiling. Dropping a higher
    // acknowledgement merely because that child is currently away would make
    // p3 rewind and replay it if the child later reattaches.
    let ceiling = legacy
        .watermarks
        .values()
        .copied()
        .max()
        .unwrap_or(after_seq)
        .max(after_seq);
    let scan_has_more = candidates.len() as i64 > LEGACY_CURSOR_SCAN_LIMIT;
    candidates.truncate(LEGACY_CURSOR_SCAN_LIMIT as usize);

    let mut delivered = Vec::new();
    let mut processed_seq = after_seq;
    let mut stopped_at_page_limit = false;
    for event in candidates {
        let watermark = legacy
            .watermarks
            .get(&event.task_id)
            .copied()
            .unwrap_or(0)
            .max(after_seq);
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
        let mut watermarks = legacy.watermarks.clone();
        // `event_seq` now protects every acknowledgement through this global
        // boundary. Removing covered entries keeps the legacy state no larger
        // than the accepted input, while entries above it preserve the safe
        // boundary for temporarily reparented-away children.
        watermarks.retain(|_, watermark| *watermark > processed_seq);
        encode_parent_cursor(
            PARENT_CURSOR_V1_PREFIX,
            &ParentTaskEventsCursorV1 {
                parent_task_id: parent_task_id.to_string(),
                watermarks,
                event_seq: Some(processed_seq),
            },
        )?
    };

    Ok(EventBatch {
        events: delivered.iter().map(|event| event.to_json()).collect(),
        cursor,
        has_more,
    })
}

fn read_legacy_parent_batch(
    db: &Db,
    parent_task_id: &str,
    legacy: &ParentTaskEventsCursorV1,
    limit: i64,
) -> Result<EventBatch, (axum::http::StatusCode, String)> {
    read_legacy_parent_batch_with_hook(db, parent_task_id, legacy, limit, || {})
}

#[cfg(test)]
pub(super) fn read_legacy_parent_batch_for_test(
    db: &Db,
    parent_task_id: &str,
    cursor: &str,
    limit: i64,
    after_membership_read: impl FnOnce(),
) -> Result<Value, String> {
    let parsed = parse_cursor(Some(cursor)).map_err(|(_, error)| error)?;
    let TaskEventsCursor::ParentV1(legacy) = parsed.ok_or_else(|| "missing cursor".to_string())?
    else {
        return Err("expected p1 cursor".to_string());
    };
    let batch = read_legacy_parent_batch_with_hook(
        db,
        parent_task_id,
        &legacy,
        limit,
        after_membership_read,
    )
    .map_err(|(_, error)| error)?;
    Ok(json!({
        "cursor": batch.cursor,
        "events": batch.events,
        "hasMore": batch.has_more,
    }))
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
    let (head_seq, mut events) = db
        .with_read_transaction(|db| {
            let head_seq = db.latest_task_event_seq()?;
            let events = db.list_task_events(scope, after_seq, head_seq, limit + 1)?;
            Ok((head_seq, events))
        })
        .map_err(db_error)?;
    if after_seq > head_seq {
        return Err(invalid_cursor());
    }
    // The lower bound stays a plain range constraint on task_event's INTEGER
    // PRIMARY KEY. Scope filtering happens after that indexable cut, so a
    // drained long poll performs work proportional to new rows, not history.
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
                read_legacy_parent_batch(&db, parent_task_id, legacy, limit)
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

async fn wait_local_task_events(
    state: Arc<AppState>,
    query: TaskEventsQuery,
    tolerate_missing_tasks: bool,
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
        resolve_scope(&db, &query, tolerate_missing_tasks)?
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

fn invalid_aggregate_cursor() -> (axum::http::StatusCode, String) {
    (
        axum::http::StatusCode::BAD_REQUEST,
        "cursor is not a valid multi-machine cursor returned by this endpoint".to_string(),
    )
}

fn decode_aggregate_cursor(
    cursor: &str,
) -> Result<AggregateCursor, (axum::http::StatusCode, String)> {
    if cursor.len() > MAX_CURSOR_LEN {
        return Err(invalid_aggregate_cursor());
    }
    let encoded = cursor
        .strip_prefix(AGGREGATE_CURSOR_PREFIX)
        .ok_or_else(invalid_aggregate_cursor)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| invalid_aggregate_cursor())?;
    let mut cursor: AggregateCursor =
        serde_json::from_slice(&bytes).map_err(|_| invalid_aggregate_cursor())?;
    if cursor.local_machine_id.trim().is_empty()
        || cursor
            .machine_ids
            .iter()
            .any(|machine_id| machine_id.trim().is_empty())
        || cursor.machine_ids.len() > MAX_AGGREGATE_MACHINES
        || cursor
            .cursors_by_machine
            .keys()
            .any(|machine_id| !cursor.machine_ids.contains(machine_id))
    {
        return Err(invalid_aggregate_cursor());
    }
    cursor.machine_ids.sort();
    cursor.machine_ids.dedup();
    Ok(cursor)
}

fn encode_aggregate_cursor(
    cursor: &AggregateCursor,
) -> Result<String, (axum::http::StatusCode, String)> {
    let bytes = serde_json::to_vec(cursor).map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to encode multi-machine task event cursor: {error}"),
        )
    })?;
    let encoded = format!(
        "{AGGREGATE_CURSOR_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    );
    if encoded.len() > MAX_CURSOR_LEN {
        return Err((
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "failed to encode a bounded multi-machine task event cursor".to_string(),
        ));
    }
    Ok(encoded)
}

fn normalized_values(raw: Option<&str>) -> Vec<String> {
    let mut values = raw
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    values.sort();
    values.dedup();
    values
}

fn resolve_aggregate_scope(
    db: &Db,
    query: &TaskEventsQuery,
) -> Result<AggregateScope, (axum::http::StatusCode, String)> {
    let task_ids = normalized_values(query.task_ids.as_deref());
    if !task_ids.is_empty() {
        return Ok(AggregateScope::Tasks { task_ids });
    }
    if let Some(parent_task_id) = query
        .parent_task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let parent_task_id = db
            .resolve_pipeline_item_id(parent_task_id)
            .map_err(db_error)?
            .unwrap_or_else(|| parent_task_id.to_string());
        return Ok(AggregateScope::Children { parent_task_id });
    }
    if let Some(repo_id) = query
        .repo_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let repo = db.get_repo(repo_id).map_err(db_error)?.ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("repo not found: {repo_id}"),
            )
        })?;
        let remote_url_hash = repo.remote_url_hash.ok_or_else(|| {
            (
                axum::http::StatusCode::CONFLICT,
                format!(
                    "repository {repo_id} has no remote URL hash, so it cannot be matched across machines"
                ),
            )
        })?;
        return Ok(AggregateScope::Repo { remote_url_hash });
    }
    if let Some(remote_url_hash) = query
        .repo_remote_url_hash
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(AggregateScope::Repo {
            remote_url_hash: remote_url_hash.to_string(),
        });
    }
    Err((
        axum::http::StatusCode::BAD_REQUEST,
        "task_ids, parent_task_id, repo_id or repo_remote_url_hash is required: an unscoped event feed would hand an orchestrator every other task's events too".to_string(),
    ))
}

fn local_query_for_aggregate(
    scope: &AggregateScope,
    cursor: Option<String>,
    timeout_secs: u64,
    limit: i64,
) -> TaskEventsQuery {
    let mut query = TaskEventsQuery {
        cursor,
        timeout_secs: Some(timeout_secs),
        limit: Some(limit),
        local_only: true,
        ..TaskEventsQuery::default()
    };
    match scope {
        AggregateScope::Tasks { task_ids } => query.task_ids = Some(task_ids.join(",")),
        AggregateScope::Children { parent_task_id } => {
            query.parent_task_id = Some(parent_task_id.clone());
        }
        AggregateScope::Repo { remote_url_hash } => {
            query.repo_remote_url_hash = Some(remote_url_hash.clone());
        }
    }
    query
}

fn aggregate_query_path(query: &TaskEventsQuery) -> String {
    let mut params = vec![
        format!("timeoutSecs={}", query.timeout_secs.unwrap_or_default()),
        format!("limit={}", query.limit.unwrap_or(DEFAULT_EVENT_LIMIT)),
        "localOnly=true".to_string(),
    ];
    if let Some(task_ids) = query.task_ids.as_deref() {
        params.push(format!("taskIds={}", encode_path_segment(task_ids)));
    }
    if let Some(parent_task_id) = query.parent_task_id.as_deref() {
        params.push(format!(
            "parentTaskId={}",
            encode_path_segment(parent_task_id)
        ));
    }
    if let Some(remote_url_hash) = query.repo_remote_url_hash.as_deref() {
        params.push(format!(
            "repoRemoteUrlHash={}",
            encode_path_segment(remote_url_hash)
        ));
    }
    if let Some(cursor) = query.cursor.as_deref() {
        params.push(format!("cursor={}", encode_path_segment(cursor)));
    }
    format!("/v1/task-events?{}", params.join("&"))
}

fn spawn_aggregate_wait(
    session: &mut AggregateWaitSession,
    state: Arc<AppState>,
    machine_id: String,
    timeout_secs: u64,
    limit: i64,
) {
    session.pending_limit = Some(limit);
    let query = local_query_for_aggregate(
        &session.cursor.scope,
        session.cursor.cursors_by_machine.get(&machine_id).cloned(),
        timeout_secs,
        limit,
    );
    let local_machine_id = session.cursor.local_machine_id.clone();
    let completed_machine_id = machine_id.clone();
    let waited_machine_id = machine_id.clone();
    session.pending.spawn(async move {
        let result = if waited_machine_id == local_machine_id {
            wait_local_task_events(state, query, true)
                .await
                .map(|Json(value)| value)
                .map_err(|(_, error)| error)
        } else {
            let path = aggregate_query_path(&query);
            match state
                .invoke_relay_desktop(waited_machine_id, "GET".to_string(), path, Value::Null)
                .await
            {
                Ok(response) if (200..300).contains(&response.status) => response
                    .body
                    .ok_or_else(|| "peer returned an empty task-event response".to_string()),
                Ok(response) => Err(response.error.unwrap_or_else(|| {
                    format!("peer task-event wait failed with HTTP {}", response.status)
                })),
                Err(error) => Err(error),
            }
        };
        AggregateWaitCompletion {
            machine_id: completed_machine_id,
            result,
        }
    });
    session.pending_machines.insert(machine_id);
}

fn apply_aggregate_completion(
    session: &mut AggregateWaitSession,
    completion: AggregateWaitCompletion,
    events: &mut Vec<Value>,
    machine_errors: &mut Vec<Value>,
    failed_machines: &mut HashSet<String>,
    has_more: &mut bool,
    limit: i64,
) -> Result<bool, (axum::http::StatusCode, String)> {
    session.pending_machines.remove(&completion.machine_id);
    if session.pending_machines.is_empty() {
        session.pending_limit = None;
    }
    let response = match completion.result {
        Ok(response) => response,
        Err(error) => {
            failed_machines.insert(completion.machine_id.clone());
            machine_errors.push(json!({
                "machineId": completion.machine_id,
                "error": error,
                "stale": true,
            }));
            return Ok(false);
        }
    };
    let cursor = response
        .get("cursor")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                axum::http::StatusCode::BAD_GATEWAY,
                format!(
                    "machine {} returned a task-event response without a cursor",
                    completion.machine_id
                ),
            )
        })?;
    session
        .cursor
        .cursors_by_machine
        .insert(completion.machine_id.clone(), cursor.to_string());
    *has_more |= response
        .get("hasMore")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let returned_events = response
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            (
                axum::http::StatusCode::BAD_GATEWAY,
                format!(
                    "machine {} returned a task-event response without events",
                    completion.machine_id
                ),
            )
        })?;
    let remaining = (limit as usize).saturating_sub(events.len());
    if returned_events.len() > remaining {
        *has_more = true;
    }
    for event in returned_events.iter().take(remaining) {
        let mut event = event.as_object().cloned().ok_or_else(|| {
            (
                axum::http::StatusCode::BAD_GATEWAY,
                format!(
                    "machine {} returned a non-object task event",
                    completion.machine_id
                ),
            )
        })?;
        event.insert(
            "machineId".to_string(),
            Value::String(completion.machine_id.clone()),
        );
        events.push(Value::Object(event));
    }
    Ok(!returned_events.is_empty())
}

async fn wait_aggregate_task_events(
    state: Arc<AppState>,
    query: TaskEventsQuery,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let timeout_secs = kanna_tool_catalog::clamp_wait_timeout_secs(
        query
            .timeout_secs
            .unwrap_or(kanna_tool_catalog::DEFAULT_WAIT_TIMEOUT_SECS),
    );
    let limit = query
        .limit
        .unwrap_or(DEFAULT_EVENT_LIMIT)
        .clamp(1, MAX_EVENT_LIMIT);
    let db = Db::open(&state.config().db_path).map_err(db_error)?;
    let requested_scope = resolve_aggregate_scope(&db, &query)?;
    let supplied_cursor = query.cursor.as_deref();
    let decoded = supplied_cursor
        .filter(|cursor| cursor.starts_with(AGGREGATE_CURSOR_PREFIX))
        .map(decode_aggregate_cursor)
        .transpose()?;
    let local_machine_id = state.config().desktop_id.clone();
    let cursor = match decoded {
        Some(cursor) => {
            if cursor.local_machine_id != local_machine_id {
                return Err((
                    axum::http::StatusCode::BAD_REQUEST,
                    format!(
                        "multi-machine event cursor belongs to local machine {}, but this server is {}",
                        cursor.local_machine_id, local_machine_id
                    ),
                ));
            }
            if cursor.scope != requested_scope {
                return Err((
                    axum::http::StatusCode::BAD_REQUEST,
                    "cursor belongs to a different task-event scope".to_string(),
                ));
            }
            cursor
        }
        None => {
            let mut cursors_by_machine = BTreeMap::new();
            if let Some(native_cursor) = supplied_cursor {
                cursors_by_machine.insert(local_machine_id.clone(), native_cursor.to_string());
            }
            AggregateCursor {
                local_machine_id: local_machine_id.clone(),
                scope: requested_scope,
                machine_ids: vec![local_machine_id.clone()],
                cursors_by_machine,
            }
        }
    };
    drop(db);

    let input_cursor_key = supplied_cursor
        .filter(|cursor| cursor.starts_with(AGGREGATE_CURSOR_PREFIX))
        .map(str::to_string);
    ensure_aggregate_wait_reaper(&state);
    let mut session = {
        let mut registry = state
            .aggregate_task_event_waits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = tokio::time::Instant::now();
        registry.evict_expired(now);
        input_cursor_key
            .as_ref()
            .and_then(|key| registry.sessions.remove(key))
            .unwrap_or_else(|| AggregateWaitSession {
                cursor,
                pending: tokio::task::JoinSet::new(),
                pending_machines: HashSet::new(),
                pending_limit: None,
                last_touched: now,
            })
    };
    if !session.pending_machines.is_empty() && session.pending_limit != Some(limit) {
        session.pending.abort_all();
        session.pending = tokio::task::JoinSet::new();
        session.pending_machines.clear();
        session.pending_limit = None;
    }
    let mut machine_errors = Vec::new();
    let mut active_machines = HashSet::from([local_machine_id.clone()]);
    match state.list_active_relay_desktops().await {
        Ok(machine_ids) => {
            active_machines.extend(machine_ids);
        }
        Err(error) => {
            machine_errors.push(json!({
                "machineId": Value::Null,
                "error": error,
                "stale": true,
            }));
        }
    }
    for machine_id in &active_machines {
        if !session.cursor.machine_ids.contains(machine_id) {
            session.cursor.machine_ids.push(machine_id.clone());
        }
    }
    session.cursor.machine_ids.sort();
    session.cursor.machine_ids.dedup();
    if session.cursor.machine_ids.len() > MAX_AGGREGATE_MACHINES {
        return Err((
            axum::http::StatusCode::BAD_GATEWAY,
            "relay returned too many machines for one task-event cursor".to_string(),
        ));
    }
    for machine_id in &session.cursor.machine_ids {
        if !active_machines.contains(machine_id) {
            machine_errors.push(json!({
                "machineId": machine_id,
                "error": "machine is unreachable through the relay",
                "stale": true,
            }));
        }
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    let zero_timeout_deadline = tokio::time::Instant::now() + ZERO_TIMEOUT_DRAIN_BUDGET;
    let mut events = Vec::new();
    let mut completed_machines = HashSet::new();
    let mut failed_machines = HashSet::new();
    let mut has_more = false;
    loop {
        let remaining_secs = if timeout_secs == 0 {
            0
        } else {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            remaining
                .as_secs()
                .saturating_add(u64::from(remaining.subsec_nanos() > 0))
                .max(1)
        };
        let machines_to_start = active_machines
            .iter()
            .filter(|machine_id| {
                !(session.pending_machines.contains(*machine_id)
                    || completed_machines.contains(*machine_id)
                    || failed_machines.contains(*machine_id))
            })
            .cloned()
            .collect::<Vec<_>>();
        for machine_id in machines_to_start {
            spawn_aggregate_wait(
                &mut session,
                Arc::clone(&state),
                machine_id,
                remaining_secs,
                limit,
            );
        }

        let joined = if timeout_secs == 0 {
            tokio::time::timeout_at(zero_timeout_deadline, session.pending.join_next())
                .await
                .unwrap_or_default()
        } else {
            tokio::time::timeout_at(deadline, session.pending.join_next())
                .await
                .unwrap_or_default()
        };
        let Some(joined) = joined else {
            break;
        };
        let completion = joined.map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("machine wait task failed: {error}"),
            )
        })?;
        let completed_machine_id = completion.machine_id.clone();
        completed_machines.insert(completed_machine_id.clone());
        let completion_had_events = apply_aggregate_completion(
            &mut session,
            completion,
            &mut events,
            &mut machine_errors,
            &mut failed_machines,
            &mut has_more,
            limit,
        )?;
        if !completion_had_events
            && !failed_machines.contains(&completed_machine_id)
            && timeout_secs > 0
            && tokio::time::Instant::now() < deadline
        {
            completed_machines.remove(&completed_machine_id);
        }
        if !events.is_empty() || has_more {
            break;
        }
        if !machine_errors.is_empty() && completed_machines.len() >= active_machines.len() {
            break;
        }
        if completed_machines.len() >= active_machines.len()
            || (timeout_secs > 0 && tokio::time::Instant::now() >= deadline)
        {
            break;
        }
    }

    session.last_touched = tokio::time::Instant::now();
    let output_cursor = encode_aggregate_cursor(&session.cursor)?;
    {
        let mut registry = state
            .aggregate_task_event_waits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.evict_expired(tokio::time::Instant::now());
        registry.insert_bounded(output_cursor.clone(), session);
    }
    let wait_outcome = if !events.is_empty() || has_more {
        "events"
    } else if !machine_errors.is_empty() {
        "partial"
    } else {
        "timeout"
    };
    Ok(Json(json!({
        "waitOutcome": wait_outcome,
        "cursor": output_cursor,
        "events": events,
        "hasMore": has_more,
        "machineErrors": machine_errors,
        "waitTimeoutSecs": timeout_secs,
        "waitHint": if wait_outcome == "events" {
            Value::Null
        } else {
            Value::String("Pass the cursor back unchanged to keep watching every known machine. A stale machine keeps its previous native cursor and catches up after reconnect while retained history remains available.".to_string())
        },
    })))
}

pub(super) async fn wait_task_events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TaskEventsQuery>,
    account_wide_access: AccountWideTaskEventAccess,
    tunneled: Option<Extension<TunneledHttpInvoke>>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    if tunneled.is_some() || query.local_only {
        return wait_local_task_events(state, query, tunneled.is_some()).await;
    }

    if !account_wide_access.is_authorized() {
        let mut query = query;
        if query
            .cursor
            .as_deref()
            .is_some_and(|cursor| cursor.starts_with(AGGREGATE_CURSOR_PREFIX))
        {
            return Err((
                axum::http::StatusCode::FORBIDDEN,
                "this request is not authorized to resume an account-wide task-event cursor; retry from the trusted desktop client or start a new local-only wait".to_string(),
            ));
        }
        query.local_only = true;
        return wait_local_task_events(state, query, false).await;
    }

    let aggregate_cursor = query
        .cursor
        .as_deref()
        .is_some_and(|cursor| cursor.starts_with(AGGREGATE_CURSOR_PREFIX));
    if state.desktop_routing_available() || aggregate_cursor {
        return wait_aggregate_task_events(state, query).await;
    }

    // Preserve native numeric/p3 cursors when this server has never had a
    // relay route. The explicit error makes the incompleteness visible without
    // forcing every single-machine caller into a composite cursor.
    let Json(mut response) = wait_local_task_events(Arc::clone(&state), query, false).await?;
    if let Some(response) = response.as_object_mut() {
        response.insert(
            "machineErrors".to_string(),
            json!([{
                "machineId": Value::Null,
                "error": "desktop relay routing is unavailable; sibling machines were not observed",
                "stale": true,
            }]),
        );
    }
    Ok(Json(response))
}

#[cfg(test)]
mod aggregate_wait_registry_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CancellationMarker(Arc<AtomicUsize>);

    impl Drop for CancellationMarker {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    async fn pending_session(
        key: &str,
        last_touched: tokio::time::Instant,
        cancellations: Arc<AtomicUsize>,
    ) -> AggregateWaitSession {
        let machine_id = format!("machine-{key}");
        let mut pending = tokio::task::JoinSet::new();
        pending.spawn(async move {
            let _marker = CancellationMarker(cancellations);
            std::future::pending::<AggregateWaitCompletion>().await
        });
        tokio::task::yield_now().await;
        AggregateWaitSession {
            cursor: AggregateCursor {
                local_machine_id: machine_id.clone(),
                scope: AggregateScope::Tasks {
                    task_ids: vec![key.to_string()],
                },
                machine_ids: vec![machine_id.clone()],
                cursors_by_machine: BTreeMap::new(),
            },
            pending,
            pending_machines: HashSet::from([machine_id]),
            pending_limit: Some(DEFAULT_EVENT_LIMIT),
            last_touched,
        }
    }

    #[tokio::test]
    async fn registry_cap_evicts_and_aborts_the_oldest_session() {
        let cancellations = Arc::new(AtomicUsize::new(0));
        let mut registry = AggregateWaitRegistry::default();
        let now = tokio::time::Instant::now();
        for index in 0..=MAX_AGGREGATE_WAIT_SESSIONS {
            let session = pending_session(
                &index.to_string(),
                now + Duration::from_nanos(index as u64),
                Arc::clone(&cancellations),
            )
            .await;
            registry.insert_bounded(index.to_string(), session);
        }
        tokio::task::yield_now().await;

        assert_eq!(registry.sessions.len(), MAX_AGGREGATE_WAIT_SESSIONS);
        assert!(!registry.sessions.contains_key("0"));
        assert_eq!(cancellations.load(Ordering::SeqCst), 1);

        for (_, session) in registry.sessions.drain() {
            AggregateWaitRegistry::abort_session(session);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn reaper_expires_abandoned_sessions_and_aborts_their_legs() {
        let cancellations = Arc::new(AtomicUsize::new(0));
        let registry = Arc::new(std::sync::Mutex::new(AggregateWaitRegistry::default()));
        let session = pending_session(
            "expired",
            tokio::time::Instant::now(),
            Arc::clone(&cancellations),
        )
        .await;
        registry
            .lock()
            .expect("registry")
            .insert_bounded("expired".to_string(), session);
        start_aggregate_wait_reaper(Arc::clone(&registry));
        tokio::task::yield_now().await;

        tokio::time::advance(AGGREGATE_WAIT_SESSION_TTL).await;
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;

        assert!(registry.lock().expect("registry").sessions.is_empty());
        assert_eq!(cancellations.load(Ordering::SeqCst), 1);
    }
}
