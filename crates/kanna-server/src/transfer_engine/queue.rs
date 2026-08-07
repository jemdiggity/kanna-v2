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
pub const KIND_SIDECAR_CLEANUP: &str = "sidecar-cleanup";

/// A value no other work id will reuse.
///
/// `transfer_work.id` is a permanent primary key and rows are never pruned, so
/// any id built from a value that repeats — a peer id, a counter that restarts
/// with its process — silently drops work forever once it has been used. This
/// is what callers reach for when the thing they are keying on is not itself
/// permanently unique. The pid and start timestamp only have to distinguish one
/// process from the next; the counter keeps two nonces minted inside one clock
/// tick apart, which the timestamp alone does not guarantee.
pub fn unique_work_nonce() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!(
        "{}-{nanos}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
}

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
    ///
    /// `incarnation` identifies the sidecar process the event came from, for
    /// the one event whose own id restarts with it.
    pub async fn enqueue_durable_event(&self, event: &Value, incarnation: &str) {
        let Some(work) = durable_event_work(event, incarnation) else {
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
///
/// Three of the four are keyed on `transfer_id`, which the destination mints
/// randomly and never reuses, so those ids stay unique for the life of the
/// database — which is what the primary key needs, since no row is ever pruned.
pub fn durable_event_work(event: &Value, incarnation: &str) -> Option<DurableEventWork> {
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
        // The pull request id dedupes two deliveries of one request — the
        // sidecar reuses it for a repeated pull of the same task from the same
        // peer. It is *not* unique on its own: it counts up from
        // `AtomicU64::new(1)` per sidecar process, so `pull-<peer>-1` recurs
        // after every respawn, and without the incarnation the first pull
        // served after a restart would collide with one from the last process
        // and be dropped silently.
        "task_pull_requested" => {
            let request_id = string_field(event, "request_id")?;
            Some(DurableEventWork {
                id: format!("pull:{incarnation}:{request_id}"),
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
                "pull:sidecar-a:pull-7",
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
            let work = durable_event_work(&event, "sidecar-a").expect("durable event maps to work");
            assert_eq!(work.id, expected_id);
            assert_eq!(work.kind, expected_kind);
        }
        assert!(!is_durable_transfer_event("pairing_started"));
        assert!(durable_event_work(&json!({ "type": "pairing_started" }), "sidecar-a").is_none());
    }

    /// The sidecar's pull request ids count up from 1 per process, so
    /// `pull-<peer>-1` recurs after every respawn. `transfer_work.id` is a
    /// permanent primary key and no row is ever pruned, so without the
    /// incarnation the first pull served after a restart would collide with one
    /// from the previous process and be dropped with no trace.
    #[test]
    fn a_pull_request_id_reused_by_a_new_sidecar_is_not_mistaken_for_a_redelivery() {
        let event = json!({ "type": "task_pull_requested", "request_id": "pull-peer-a-1" });
        let first = durable_event_work(&event, "sidecar-a").expect("first incarnation");
        let restarted = durable_event_work(&event, "sidecar-b").expect("second incarnation");
        assert_ne!(first.id, restarted.id);

        // Within one incarnation the id still dedupes, which is what makes two
        // deliveries of one request schedule one push.
        let redelivered = durable_event_work(&event, "sidecar-a").expect("redelivery");
        assert_eq!(first.id, redelivered.id);

        // The other three are keyed on a transfer id the destination mints
        // randomly and never reuses, so they must NOT be incarnation-scoped: a
        // commit receipt replayed after a respawn has to collapse onto the work
        // that already applied it rather than apply twice.
        for event in [
            json!({ "type": "outgoing_transfer_committed", "transfer_id": "t-1" }),
            json!({ "type": "outgoing_transfer_finalization_requested", "transfer_id": "t-1" }),
            json!({ "type": "incoming_transfer_request", "transfer_id": "t-1" }),
        ] {
            assert_eq!(
                durable_event_work(&event, "sidecar-a").expect("work").id,
                durable_event_work(&event, "sidecar-b").expect("work").id,
                "{event}",
            );
        }
    }

    /// Every id this module builds ends up in a permanent primary key, so a
    /// nonce that repeats would silently drop work forever.
    #[test]
    fn a_work_nonce_is_never_reused() {
        let nonces: std::collections::HashSet<String> =
            (0..1_000).map(|_| unique_work_nonce()).collect();
        assert_eq!(nonces.len(), 1_000);
    }

    /// An event missing the field its work id is derived from must not be
    /// silently given a colliding id, which would make two unrelated transfers
    /// dedupe against each other.
    #[test]
    fn a_durable_event_without_its_key_schedules_nothing() {
        assert!(
            durable_event_work(&json!({ "type": "incoming_transfer_request" }), "sidecar-a")
                .is_none()
        );
        assert!(
            durable_event_work(&json!({ "type": "task_pull_requested" }), "sidecar-a").is_none()
        );
    }
}
