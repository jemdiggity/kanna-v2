//! Forwards the transfer sidecar's *advisory* events to the renderer.
//!
//! What used to live here — deliveries, consumer incarnations, 30-second
//! leases, ack/nack, phase claims and a 1 Hz redelivery sweeper — existed for
//! one reason: to elect a single renderer window to perform transfer
//! orchestration, and to survive that window disappearing. Orchestration is
//! `kanna-server`'s now, and the four state-mutating lifecycle events never
//! leave that process, so none of the election machinery has anything left to
//! elect.
//!
//! What remains is a plain fan-out of the events a *window* is genuinely for:
//! pairing prompts, which need a human, and remote terminal frames, which need
//! a terminal. Losing one costs a prompt nobody was there to answer, never a
//! transfer step.
//!
//! The same long-poll shape carries `kanna-server`'s desktop view commands —
//! an agent asking a window to open a file for the person watching the task.
//! It is advisory for exactly the same reason: a window that is not there
//! loses the request, and nothing about the task depended on it.

use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

fn forwarded_event_name(value: &Value) -> Option<&'static str> {
    match value.get("type").and_then(Value::as_str) {
        Some("pairing_started") => Some("pairing-started"),
        Some("pairing_requested") => Some("pairing-requested"),
        Some("pairing_completed") => Some("pairing-completed"),
        Some("terminal_event") => Some("transfer-terminal-event"),
        Some("sidecar_exited") => Some("transfer-sidecar-exited"),
        Some("companion_event") => Some("transfer-companion-event"),
        Some("desktop_view_open") => Some("desktop-view-open"),
        _ => None,
    }
}

/// Long-poll the server's advisory event stream and emit each entry to every
/// window.
///
/// The cursor travels with the `streamId` it came from. `kanna-server` restarts
/// independently of this process and its event sequence restarts at zero with
/// it, so a cursor replayed into a new server would otherwise prune the fresh
/// log's first events. Pairing the two makes the server discard the stale
/// position instead.
pub fn spawn_transfer_event_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // App startup owns starting kanna-server. Polling before it is up
        // would race that start for the server lock and make one of the two
        // fail, so wait for it rather than starting a second one.
        crate::commands::mobile::wait_for_server_started(&app).await;
        let client = reqwest::Client::new();
        let mut position: Option<TransferEventPosition> = None;
        loop {
            match poll_transfer_events(&app, &client, position.as_ref()).await {
                Ok(batch) => {
                    if batch.missed_events {
                        eprintln!(
                            "[transfer-events] resumed at cursor {:?}; the server reports advisory \
                             events were missed (its stream is {})",
                            position.as_ref().map(|position| position.cursor),
                            batch.stream_id
                        );
                    }
                    for event in batch.events {
                        match forwarded_event_name(&event) {
                            Some(event_name) => {
                                let _ = app.emit(event_name, &event);
                            }
                            None => {
                                eprintln!("[transfer-events] unhandled sidecar event: {event}")
                            }
                        }
                    }
                    position = Some(TransferEventPosition {
                        cursor: batch.cursor,
                        stream_id: batch.stream_id,
                    });
                }
                Err(error) => {
                    // The server restarts independently of this process; a
                    // failed poll is expected during that window.
                    eprintln!("[transfer-events] poll failed: {error}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    });
}

/// Long-poll the server's companion frame lane and emit each frame to every
/// window as `transfer-companion-event`. Companion frames travel apart from
/// the advisory stream so a large snapshot can never delay a pairing prompt;
/// this poller mirrors the advisory one against the companion route.
pub fn spawn_transfer_companion_event_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        crate::commands::mobile::wait_for_server_started(&app).await;
        let client = reqwest::Client::new();
        let mut position: Option<TransferEventPosition> = None;
        loop {
            match poll_transfer_event_route(
                &app,
                &client,
                "/v1/transfers/sidecar/companion-events",
                position.as_ref(),
            )
            .await
            {
                Ok(batch) => {
                    if batch.missed_events {
                        eprintln!(
                            "[transfer-companion-events] resumed at cursor {:?}; the server \
                             reports companion frames were missed (its stream is {})",
                            position.as_ref().map(|position| position.cursor),
                            batch.stream_id
                        );
                    }
                    for event in batch.events {
                        if forwarded_event_name(&event) == Some("transfer-companion-event") {
                            let _ = app.emit("transfer-companion-event", &event);
                        } else {
                            eprintln!(
                                "[transfer-companion-events] unhandled companion event: {event}"
                            );
                        }
                    }
                    position = Some(TransferEventPosition {
                        cursor: batch.cursor,
                        stream_id: batch.stream_id,
                    });
                }
                Err(error) => {
                    eprintln!("[transfer-companion-events] poll failed: {error}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    });
}

/// Long-poll the desktop view command lane and emit each command to every
/// window as `desktop-view-open`. A lane of its own so a burst of terminal
/// frames cannot delay a file the operator was just asked to look at.
pub fn spawn_desktop_view_command_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        crate::commands::mobile::wait_for_server_started(&app).await;
        let client = reqwest::Client::new();
        let mut position: Option<TransferEventPosition> = None;
        loop {
            match poll_transfer_event_route(
                &app,
                &client,
                "/v1/desktop/view-commands",
                position.as_ref(),
            )
            .await
            {
                Ok(batch) => {
                    for event in batch.events {
                        if forwarded_event_name(&event) == Some("desktop-view-open") {
                            let _ = app.emit("desktop-view-open", &event);
                        } else {
                            eprintln!("[desktop-view-commands] unhandled command: {event}");
                        }
                    }
                    position = Some(TransferEventPosition {
                        cursor: batch.cursor,
                        stream_id: batch.stream_id,
                    });
                }
                Err(error) => {
                    eprintln!("[desktop-view-commands] poll failed: {error}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    });
}

/// A cursor is only meaningful within the server incarnation that issued it,
/// so the two are never carried apart.
#[derive(Debug)]
struct TransferEventPosition {
    cursor: u64,
    stream_id: String,
}

#[derive(Debug)]
struct TransferEventBatch {
    events: Vec<Value>,
    cursor: u64,
    stream_id: String,
    missed_events: bool,
}

async fn poll_transfer_events(
    app: &AppHandle,
    client: &reqwest::Client,
    position: Option<&TransferEventPosition>,
) -> Result<TransferEventBatch, String> {
    poll_transfer_event_route(app, client, "/v1/transfers/sidecar/events", position).await
}

async fn poll_transfer_event_route(
    app: &AppHandle,
    client: &reqwest::Client,
    route: &str,
    position: Option<&TransferEventPosition>,
) -> Result<TransferEventBatch, String> {
    let base_url = crate::commands::mobile::ensure_server_base_url(app).await?;
    let mut url = format!("{base_url}{route}?timeoutSecs=25");
    if let Some(position) = position {
        url.push_str(&format!(
            "&cursor={}&streamId={}",
            position.cursor,
            crate::commands::transfer::percent_encode_component(&position.stream_id)
        ));
    }
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(40))
        .send()
        .await
        .map_err(|error| format!("transfer event request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "transfer event request failed: {}",
            response.status()
        ));
    }
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| format!("invalid transfer event response: {error}"))?;
    parse_transfer_event_batch(&body)
}

/// A malformed batch is an error, never a silently shorter one.
fn parse_transfer_event_batch(body: &Value) -> Result<TransferEventBatch, String> {
    let cursor = body
        .get("cursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| "transfer event response missing cursor".to_string())?;
    // Resuming without knowing which server incarnation issued the cursor is
    // exactly the mistake the stream id exists to prevent, so an absent one is
    // a failed poll rather than a resume from an unknown position.
    let stream_id = body
        .get("streamId")
        .and_then(Value::as_str)
        .filter(|stream_id| !stream_id.is_empty())
        .ok_or_else(|| "transfer event response missing streamId".to_string())?
        .to_string();
    let events = body
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "transfer event response missing events".to_string())?
        .iter()
        .map(|entry| {
            entry
                .get("event")
                .cloned()
                .ok_or_else(|| "transfer event entry missing event".to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(TransferEventBatch {
        events,
        cursor,
        stream_id,
        missed_events: body
            .get("missedEvents")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn advisory_batches_advance_the_cursor_and_map_to_their_renderer_topics() {
        let batch = parse_transfer_event_batch(&json!({
            "cursor": 7,
            "streamId": "1234-9999",
            "missedEvents": true,
            "events": [
                { "seq": 7, "event": { "type": "pairing_requested", "request_id": "p-1" } },
            ],
        }))
        .expect("batch should parse");
        assert_eq!(batch.cursor, 7);
        assert_eq!(batch.stream_id, "1234-9999");
        assert!(batch.missed_events);
        assert_eq!(
            forwarded_event_name(&batch.events[0]),
            Some("pairing-requested")
        );
    }

    /// The four state-mutating kinds are the engine's, and never reach a
    /// window. Forwarding one here would put a transfer step back in a place
    /// that can close mid-flight.
    #[test]
    fn lifecycle_events_have_no_renderer_topic_left() {
        for kind in [
            "incoming_transfer_request",
            "task_pull_requested",
            "outgoing_transfer_committed",
            "outgoing_transfer_finalization_requested",
        ] {
            assert_eq!(
                forwarded_event_name(&json!({ "type": kind })),
                None,
                "{kind}"
            );
        }
    }

    /// A cursor without the incarnation that issued it is unusable: replayed
    /// into a restarted server it would prune the fresh log's first events.
    #[test]
    fn a_batch_without_a_stream_id_fails_rather_than_resuming_blind() {
        let error = parse_transfer_event_batch(&json!({
            "cursor": 4,
            "events": [],
        }))
        .expect_err("a cursor with no stream id must not be adopted");
        assert!(error.contains("streamId"), "{error}");
    }

    #[test]
    fn a_batch_entry_without_its_event_fails_instead_of_being_skipped() {
        let error = parse_transfer_event_batch(&json!({
            "cursor": 1,
            "streamId": "1234-9999",
            "events": [{ "seq": 1 }],
        }))
        .expect_err("a malformed entry must not be silently dropped");
        assert!(error.contains("event"), "{error}");
    }

    #[test]
    fn stream_ids_are_escaped_into_the_poll_query() {
        use crate::commands::transfer::percent_encode_component;
        assert_eq!(percent_encode_component("4321-17"), "4321-17");
        assert_eq!(percent_encode_component("a&b=c"), "a%26b%3Dc");
    }
}
