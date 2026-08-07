//! The engine's entry point for new work.
//!
//! Deliberately holds no `AppState`: the sidecar supervisor appends here from
//! its stdout reader, and the HTTP routes append here from a request, while the
//! drain loop that consumes the rows is the only thing that needs the rest of
//! the server. Keeping the queue independent is what lets both sides reach it
//! without an ownership cycle.

use crate::db::Db;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

/// Work kinds. Each is a step the renderer used to perform on receipt of a
/// lifecycle event, or an intent a client now expresses through a route.
pub const KIND_INCOMING_REQUEST: &str = "incoming-request";
pub const KIND_IMPORT: &str = "import";
pub const KIND_REJECT: &str = "reject";
pub const KIND_PUSH: &str = "push";
pub const KIND_FINALIZE: &str = "finalize";
pub const KIND_OUTGOING_COMMITTED: &str = "outgoing-committed";

/// How long a failed enqueue waits before trying again. An append that cannot
/// land must not drop the event — the whole point of the durable queue — so the
/// caller applies backpressure instead.
const ENQUEUE_RETRY: Duration = Duration::from_millis(200);

pub struct TransferWorkQueue {
    db_path: String,
    appended: Notify,
}

impl TransferWorkQueue {
    pub fn new(db_path: String) -> Arc<Self> {
        Arc::new(Self {
            db_path,
            appended: Notify::new(),
        })
    }

    pub fn open_db(&self) -> Result<Db, String> {
        Db::open(&self.db_path).map_err(|error| format!("db error: {error}"))
    }

    /// Appends work under a caller-chosen id. The id is what makes the queue
    /// idempotent: a redelivered sidecar event derives the same one and
    /// collapses onto the row already there.
    pub fn enqueue(
        &self,
        id: &str,
        kind: &str,
        transfer_id: Option<&str>,
        payload: &Value,
    ) -> Result<bool, String> {
        let payload_json = serde_json::to_string(payload)
            .map_err(|error| format!("failed to encode transfer work payload: {error}"))?;
        let appended = self
            .open_db()?
            .enqueue_transfer_work(id, kind, transfer_id, &payload_json)
            .map_err(|error| format!("db error: {error}"))?;
        self.appended.notify_waiters();
        Ok(appended)
    }

    /// Appends a durable sidecar lifecycle event, retrying until it lands.
    ///
    /// This runs on the sidecar's stdout reader, so returning early would drop
    /// a transfer step with no trace — the exact failure the in-memory queue
    /// had. Blocking here instead backpressures the reader, which is the
    /// behaviour the previous event log already chose for durable events.
    pub async fn enqueue_durable_event(&self, event: &Value) {
        let Some(work) = durable_event_work(event) else {
            log::warn!("unrecognized durable transfer event: {event}");
            return;
        };
        loop {
            match self.enqueue(&work.id, work.kind, work.transfer_id.as_deref(), event) {
                Ok(_) => return,
                Err(error) => {
                    log::error!(
                        "failed to queue transfer lifecycle work {}; retrying: {error}",
                        work.id
                    );
                    tokio::time::sleep(ENQUEUE_RETRY).await;
                }
            }
        }
    }

    pub fn wake(&self) {
        self.appended.notify_waiters();
    }

    /// Blocks until work is appended or `timeout` elapses.
    pub async fn wait_for_work(&self, timeout: Duration) {
        let notified = self.appended.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let _ = tokio::time::timeout(timeout, notified).await;
    }
}

pub struct DurableEventWork {
    pub id: String,
    pub kind: &'static str,
    pub transfer_id: Option<String>,
}

fn string_field(event: &Value, key: &str) -> Option<String> {
    event.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Maps a durable sidecar event onto the work it schedules, and onto the id
/// that makes a redelivery of it a no-op.
pub fn durable_event_work(event: &Value) -> Option<DurableEventWork> {
    let event_type = event.get("type").and_then(Value::as_str)?;
    match event_type {
        "incoming_transfer_request" => {
            let transfer_id = string_field(event, "transfer_id")?;
            Some(DurableEventWork {
                id: format!("incoming:{transfer_id}"),
                kind: KIND_INCOMING_REQUEST,
                transfer_id: Some(transfer_id),
            })
        }
        // Keyed by the sidecar's own pull request id, which it already reuses
        // for a repeated pull of the same task from the same peer — so two
        // deliveries of one request schedule one push.
        "task_pull_requested" => {
            let request_id = string_field(event, "request_id")?;
            Some(DurableEventWork {
                id: format!("pull:{request_id}"),
                kind: KIND_PUSH,
                transfer_id: None,
            })
        }
        "outgoing_transfer_committed" => {
            let transfer_id = string_field(event, "transfer_id")?;
            Some(DurableEventWork {
                id: format!("committed:{transfer_id}"),
                kind: KIND_OUTGOING_COMMITTED,
                transfer_id: Some(transfer_id),
            })
        }
        "outgoing_transfer_finalization_requested" => {
            let transfer_id = string_field(event, "transfer_id")?;
            Some(DurableEventWork {
                id: format!("finalize:{transfer_id}"),
                kind: KIND_FINALIZE,
                transfer_id: Some(transfer_id),
            })
        }
        _ => None,
    }
}

/// The four event kinds whose delivery changes state on the receiving side.
/// Everything else the sidecar emits is advisory and goes to the window.
pub fn is_durable_transfer_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "incoming_transfer_request"
            | "task_pull_requested"
            | "outgoing_transfer_committed"
            | "outgoing_transfer_finalization_requested"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_durable_event_maps_to_work_keyed_for_redelivery() {
        let cases = [
            (
                json!({ "type": "incoming_transfer_request", "transfer_id": "t-1" }),
                "incoming:t-1",
                KIND_INCOMING_REQUEST,
            ),
            (
                json!({ "type": "task_pull_requested", "request_id": "pull-7" }),
                "pull:pull-7",
                KIND_PUSH,
            ),
            (
                json!({ "type": "outgoing_transfer_committed", "transfer_id": "t-2" }),
                "committed:t-2",
                KIND_OUTGOING_COMMITTED,
            ),
            (
                json!({ "type": "outgoing_transfer_finalization_requested", "transfer_id": "t-3" }),
                "finalize:t-3",
                KIND_FINALIZE,
            ),
        ];
        for (event, expected_id, expected_kind) in cases {
            let event_type = event["type"].as_str().expect("type");
            assert!(is_durable_transfer_event(event_type), "{event_type}");
            let work = durable_event_work(&event).expect("durable event maps to work");
            assert_eq!(work.id, expected_id);
            assert_eq!(work.kind, expected_kind);
        }
        assert!(!is_durable_transfer_event("pairing_started"));
        assert!(durable_event_work(&json!({ "type": "pairing_started" })).is_none());
    }

    /// An event missing the field its work id is derived from must not be
    /// silently given a colliding id, which would make two unrelated transfers
    /// dedupe against each other.
    #[test]
    fn a_durable_event_without_its_key_schedules_nothing() {
        assert!(durable_event_work(&json!({ "type": "incoming_transfer_request" })).is_none());
        assert!(durable_event_work(&json!({ "type": "task_pull_requested" })).is_none());
    }
}
