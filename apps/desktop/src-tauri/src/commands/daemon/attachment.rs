use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::Emitter;

use crate::daemon_client::DaemonClient;

use super::protocol::{parse_ack, TerminalSnapshotPayload};
use super::{ActiveAttachedStreams, AttachedSessions, WindowSessionSizes};

pub struct ActiveAttachedStream {
    pub(super) attach_id: u64,
    pub(super) shutdown: tokio::sync::oneshot::Sender<()>,
}

static NEXT_ATTACH_ID: AtomicU64 = AtomicU64::new(1);

pub(super) fn register_attached_owner(
    attached: &mut HashMap<String, HashSet<String>>,
    session_id: &str,
    owner_label: &str,
) {
    attached
        .entry(session_id.to_string())
        .or_default()
        .insert(owner_label.to_string());
}

pub(super) fn unregister_attached_owner(
    attached: &mut HashMap<String, HashSet<String>>,
    session_id: &str,
    owner_label: &str,
) -> bool {
    let Some(owners) = attached.get_mut(session_id) else {
        return true;
    };

    owners.remove(owner_label);
    if owners.is_empty() {
        attached.remove(session_id);
        true
    } else {
        false
    }
}

fn clear_attached_owners(attached: &mut HashMap<String, HashSet<String>>, session_id: &str) {
    attached.remove(session_id);
}

pub(super) fn attached_owner_count(
    attached: &HashMap<String, HashSet<String>>,
    session_id: &str,
) -> usize {
    attached
        .get(session_id)
        .map(HashSet::len)
        .unwrap_or_default()
}

fn effective_window_session_size(window_sizes: &HashMap<String, (u16, u16)>) -> Option<(u16, u16)> {
    let cols = window_sizes.values().map(|(cols, _)| *cols).min()?;
    let rows = window_sizes.values().map(|(_, rows)| *rows).min()?;
    Some((cols, rows))
}

pub(super) fn update_window_session_size(
    sizes: &mut HashMap<String, HashMap<String, (u16, u16)>>,
    session_id: &str,
    owner_label: &str,
    cols: u16,
    rows: u16,
) -> Option<(u16, u16)> {
    let window_sizes = sizes.entry(session_id.to_string()).or_default();
    window_sizes.insert(owner_label.to_string(), (cols, rows));
    effective_window_session_size(window_sizes)
}

pub(super) fn remove_window_session_size(
    sizes: &mut HashMap<String, HashMap<String, (u16, u16)>>,
    session_id: &str,
    owner_label: &str,
) -> Option<(u16, u16)> {
    let window_sizes = sizes.get_mut(session_id)?;
    window_sizes.remove(owner_label);
    let effective_size = effective_window_session_size(window_sizes);
    if effective_size.is_none() {
        sizes.remove(session_id);
    }
    effective_size
}

pub(super) async fn spawn_attached_stream_task(
    app: tauri::AppHandle,
    stream_client: DaemonClient,
    session_id: String,
    attached: AttachedSessions,
    active_streams: ActiveAttachedStreams,
    window_sizes: WindowSessionSizes,
    initial_snapshot: Option<TerminalSnapshotPayload>,
) {
    let attach_id = NEXT_ATTACH_ID.fetch_add(1, Ordering::Relaxed);
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
    if let Some(previous) = active_streams.lock().await.insert(
        session_id.clone(),
        ActiveAttachedStream {
            attach_id,
            shutdown: shutdown_tx,
        },
    ) {
        let _ = previous.shutdown.send(());
    }

    let sid = session_id.clone();
    let app = app.clone();
    let attached_clone = attached.clone();
    let active_streams_clone = active_streams.clone();
    let window_sizes_clone = window_sizes.clone();
    tauri::async_runtime::spawn(async move {
        let mut exited_normally = false;
        let mut detached_intentionally = false;
        let mut output_event_count: usize = 0;
        let mut stream_client = stream_client;

        if let Some(snapshot) = initial_snapshot {
            let payload = serde_json::json!({
                "session_id": &sid,
                "snapshot": snapshot,
            });
            let _ = app.emit("terminal_snapshot", &payload);
        }

        loop {
            let line = tokio::select! {
                _ = &mut shutdown_rx => {
                    detached_intentionally = true;
                    if let Ok(cmd) = serde_json::to_string(&serde_json::json!({
                        "type": "Detach",
                        "session_id": &sid,
                    })) {
                        let _ = stream_client.send_command(&cmd).await;
                        if let Ok(response) = stream_client.read_event().await {
                            let _ = parse_ack(&response);
                        }
                    }
                    break;
                }
                line = stream_client.read_event() => match line {
                    Ok(line) => line,
                    Err(_) => break,
                }
            };
            let event: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match event.get("type").and_then(|t| t.as_str()) {
                Some("Output") => {
                    output_event_count += 1;
                    if output_event_count <= 5 {
                        let byte_len = event
                            .get("data")
                            .and_then(|d| d.as_array())
                            .map(|d| d.len())
                            .unwrap_or(0);
                        eprintln!(
                            "[attach] output session={} chunk={} bytes={}",
                            sid, output_event_count, byte_len
                        );
                    }
                    // Terminal bytes are delivered through kanna-server KSP
                    // term_output frames. This legacy stream task remains only
                    // for lifecycle forwarding until the command is fully retired.
                }
                Some("Exit") => {
                    {
                        let mut attached_guard = attached_clone.lock().await;
                        clear_attached_owners(&mut attached_guard, &sid);
                    }
                    {
                        let mut sizes_guard = window_sizes_clone.lock().await;
                        sizes_guard.remove(&sid);
                    }
                    eprintln!("[attach] exit event session={}", sid);
                    let _ = app.emit("session_exit", &event);
                    exited_normally = true;
                    break;
                }
                Some("StatusChanged") => {
                    let _ = app.emit("status_changed", &event);
                }
                _ => {}
            }
        }
        let removed = active_streams_clone.lock().await.remove(&sid);
        let replaced_by_newer_stream = removed
            .as_ref()
            .is_some_and(|stream| stream.attach_id != attach_id);
        if replaced_by_newer_stream {
            if let Some(stream) = removed {
                active_streams_clone
                    .lock()
                    .await
                    .insert(sid.clone(), stream);
            }
        } else {
            {
                let mut attached_guard = attached_clone.lock().await;
                clear_attached_owners(&mut attached_guard, &sid);
            }
            {
                let mut sizes_guard = window_sizes_clone.lock().await;
                sizes_guard.remove(&sid);
            }
        }
        if !replaced_by_newer_stream && !exited_normally && !detached_intentionally {
            let payload = serde_json::json!({
                "session_id": &sid,
            });
            let _ = app.emit("session_stream_lost", &payload);
            eprintln!("[attach] emitted session_stream_lost session={}", sid);
        }
        eprintln!("[attach] output stream ended for session {}", sid);
    });
}

#[cfg(test)]
mod tests {
    use super::{
        attached_owner_count, clear_attached_owners, register_attached_owner,
        remove_window_session_size, unregister_attached_owner, update_window_session_size,
    };
    use std::collections::HashMap;

    #[test]
    fn detaching_one_window_keeps_shared_session_attached_for_other_windows() {
        let mut attached = HashMap::new();
        register_attached_owner(&mut attached, "task-1", "main");
        register_attached_owner(&mut attached, "task-1", "window-2");

        assert!(!unregister_attached_owner(&mut attached, "task-1", "main"));
        assert_eq!(attached["task-1"].len(), 1);
        assert!(attached["task-1"].contains("window-2"));

        assert!(unregister_attached_owner(
            &mut attached,
            "task-1",
            "window-2"
        ));
        assert!(!attached.contains_key("task-1"));
    }

    #[test]
    fn clearing_a_session_removes_all_window_owners_after_exit() {
        let mut attached = HashMap::new();
        register_attached_owner(&mut attached, "task-1", "main");
        register_attached_owner(&mut attached, "task-1", "window-2");

        clear_attached_owners(&mut attached, "task-1");

        assert!(attached.is_empty());
    }

    #[test]
    fn attached_owner_count_reports_current_window_owners() {
        let mut attached = HashMap::new();
        register_attached_owner(&mut attached, "task-1", "main");
        register_attached_owner(&mut attached, "task-1", "window-2");

        assert_eq!(attached_owner_count(&attached, "task-1"), 2);
        assert_eq!(attached_owner_count(&attached, "missing-task"), 0);
    }

    #[test]
    fn session_size_registry_aggregates_by_window_and_recomputes_on_detach() {
        let mut sizes = HashMap::new();

        assert_eq!(
            update_window_session_size(&mut sizes, "task-1", "main", 120, 40),
            Some((120, 40))
        );
        assert_eq!(
            update_window_session_size(&mut sizes, "task-1", "window-2", 100, 50),
            Some((100, 40))
        );
        assert_eq!(
            update_window_session_size(&mut sizes, "task-1", "main", 90, 30),
            Some((90, 30))
        );
        assert_eq!(
            remove_window_session_size(&mut sizes, "task-1", "main"),
            Some((100, 50))
        );
        assert_eq!(
            remove_window_session_size(&mut sizes, "task-1", "window-2"),
            None
        );
        assert!(!sizes.contains_key("task-1"));
    }
}
