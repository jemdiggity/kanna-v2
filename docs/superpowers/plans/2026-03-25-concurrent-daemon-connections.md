# Concurrent Daemon Connections Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow multiple Kanna app instances to share a single daemon with seamless reconnection on handoff, and support multiple clients viewing the same session via broadcast.

**Architecture:** Replace the single-writer `ActiveWriter` pattern with a broadcast model (`Vec<SessionWriter>`), add a `ShuttingDown` protocol event for graceful handoff signaling, and add reconnection logic to the Tauri event bridge with session re-attach coordination.

**Tech Stack:** Rust (daemon + Tauri backend), tokio async, Unix domain sockets, NDJSON protocol

**Spec:** `docs/superpowers/specs/2026-03-24-concurrent-daemon-connections-design.md`

---

### Task 1: Add `ShuttingDown` Event to Protocol

**Files:**
- Modify: `crates/daemon/src/protocol.rs:48-82` (Event enum)

- [ ] **Step 1: Add ShuttingDown variant and write failing test**

Add to the `Event` enum after `HandoffUnsupported` (line 76):

```rust
ShuttingDown,
```

Add serialization roundtrip test in the `#[cfg(test)]` block:

```rust
#[test]
fn test_event_shutting_down_roundtrip() {
    let evt = Event::ShuttingDown;
    let json = serde_json::to_string(&evt).unwrap();
    assert_eq!(json, r#"{"type":"ShuttingDown"}"#);
    let decoded: Event = serde_json::from_str(&json).unwrap();
    assert!(matches!(decoded, Event::ShuttingDown));
}
```

- [ ] **Step 2: Run tests to verify**

Run: `cd crates/daemon && cargo test -- --test-threads=1`
Expected: All protocol tests PASS including the new one.

- [ ] **Step 3: Commit**

```bash
git add crates/daemon/src/protocol.rs
git commit -m "feat(daemon): add ShuttingDown event to protocol"
```

---

### Task 2: Replace ActiveWriter with Broadcast Model

**Files:**
- Modify: `crates/daemon/src/main.rs:17-27` (type aliases)
- Modify: `crates/daemon/src/main.rs:336-457` (Spawn, Attach, Detach handlers)
- Modify: `crates/daemon/src/main.rs:537-551` (Kill handler — cleanup)
- Modify: `crates/daemon/src/main.rs:678-749` (stream_output)

This is the largest change. It replaces the single `ActiveWriter` slot per session with a `Vec` of writers, and updates every consumer.

- [ ] **Step 1: Replace type aliases**

Replace lines 17-22 in `main.rs`:

```rust
// OLD:
/// Swappable writer target. stream_output checks this on every read.
/// None = no client attached (output buffered).
type ActiveWriter = Arc<Mutex<Option<Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>>>>;

/// Map of session_id → active writer target.
type SessionWriters = Arc<Mutex<HashMap<String, ActiveWriter>>>;
```

With:

```rust
/// A single client's write half, wrapped for shared access.
type SessionWriter = Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>;

/// Map of session_id → list of attached client writers (broadcast model).
/// All writers in the list receive every Output event for the session.
type SessionWriters = Arc<Mutex<HashMap<String, Vec<SessionWriter>>>>;
```

- [ ] **Step 2: Update Spawn handler (lines 355-376)**

Replace the `ActiveWriter` creation on Spawn with an empty `Vec`:

```rust
// In Spawn handler, after mgr.insert:
if let Ok(reader) = pty_reader {
    session_writers.lock().await.insert(session_id.clone(), Vec::new());

    let buffer: PreAttachBuffer = Arc::new(Mutex::new(Some(Vec::new())));
    pre_attach_buffers.lock().await.insert(session_id.clone(), buffer.clone());

    let sid = session_id.clone();
    let sessions_exit = sessions.clone();
    let writers_cleanup = session_writers.clone();
    tokio::task::spawn_blocking(move || {
        stream_output(sid, reader, writers_cleanup.clone(), buffer, sessions_exit, writers_cleanup);
    });
}
```

Note: `stream_output` now takes the shared `SessionWriters` map instead of a per-session `ActiveWriter`, so it can iterate the Vec on each read.

- [ ] **Step 3: Update Attach handler (lines 392-457)**

Replace the writer swap logic. For the `is_streaming` (Spawn'd session) path:

```rust
// Instead of swapping ActiveWriter:
let writers = session_writers.lock().await;
if let Some(writer_list) = writers.get(&session_id) {
    // No need to lock — we just need to check it exists
}
drop(writers);

// Add this client's writer to the broadcast list
session_writers.lock().await
    .entry(session_id.clone())
    .or_default()
    .push(writer.clone());

let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;

// Flush pre-attach buffer to THIS client only
if let Some(buffer) = pre_attach_buffers.lock().await.remove(&session_id) {
    if let Some(data) = buffer.lock().await.take() {
        if !data.is_empty() {
            log::info!("[attach] flushing {} bytes of pre-attach output for {}", data.len(), session_id);
            let evt = Event::Output {
                session_id: session_id.clone(),
                data,
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }
    }
}
```

For the adopted-session (handoff) path, similarly push to Vec instead of setting single writer, and start `stream_output` with the `SessionWriters` map.

- [ ] **Step 4: Update Detach handler (lines 459-473)**

Replace setting `ActiveWriter` to `None` with removing this writer from the Vec:

```rust
Command::Detach { session_id } => {
    let evt = if sessions.lock().await.contains(&session_id) {
        let mut writers = session_writers.lock().await;
        if let Some(writer_list) = writers.get_mut(&session_id) {
            // Remove this specific writer by Arc pointer identity
            let writer_ptr = Arc::as_ptr(&writer) as usize;
            writer_list.retain(|w| Arc::as_ptr(w) as usize != writer_ptr);
        }
        Event::Ok
    } else {
        Event::Error {
            message: format!("session not found: {}", session_id),
        }
    };
    let _ = write_event(&mut *writer.lock().await, &evt).await;
}
```

- [ ] **Step 5: Update Kill handler (lines 537-551)**

No structural change needed — `session_writers.lock().await.remove(&session_id)` already removes the entire Vec entry. This is correct for broadcast: when a session is killed, all writers are dropped.

- [ ] **Step 6: Rewrite stream_output (lines 678-749)**

```rust
fn stream_output(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    session_writers: SessionWriters,
    pre_attach_buffer: PreAttachBuffer,
    sessions: Arc<Mutex<SessionManager>>,
    writers_cleanup: SessionWriters,
) {
    let rt = tokio::runtime::Handle::current();
    let mut buf = [0u8; 4096];

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let data = buf[..n].to_vec();

                // If pre-attach buffer is active, append to it
                let buffered = rt.block_on(async {
                    let mut guard = pre_attach_buffer.lock().await;
                    if let Some(ref mut buffer) = *guard {
                        if buffer.len() + data.len() <= MAX_PRE_ATTACH_BUFFER {
                            buffer.extend_from_slice(&data);
                        }
                        true
                    } else {
                        false
                    }
                });
                if buffered { continue; }

                let evt = Event::Output {
                    session_id: session_id.clone(),
                    data,
                };

                // Broadcast to all attached writers, remove any that fail
                rt.block_on(async {
                    let mut writers = session_writers.lock().await;
                    if let Some(writer_list) = writers.get_mut(&session_id) {
                        let mut failed = Vec::new();
                        for (i, w) in writer_list.iter().enumerate() {
                            if write_event(&mut *w.lock().await, &evt).await.is_err() {
                                failed.push(i);
                            }
                        }
                        // Remove failed writers in reverse order to preserve indices
                        for i in failed.into_iter().rev() {
                            writer_list.remove(i);
                        }
                    }
                });
            }
            Err(e) => {
                log::error!("PTY read error for session {}: {}", session_id, e);
                break;
            }
        }
    }

    // Session ended — broadcast Exit to all remaining writers
    let exit_code = {
        let mut mgr = rt.block_on(sessions.lock());
        let code = match mgr.get_mut(&session_id) {
            Some(session) => session.try_wait().unwrap_or(0),
            None => 0,
        };
        mgr.remove(&session_id);
        code
    };

    let evt = Event::Exit {
        session_id: session_id.clone(),
        code: exit_code,
    };
    rt.block_on(async {
        let mut writers = writers_cleanup.lock().await;
        if let Some(writer_list) = writers.remove(&session_id) {
            for w in &writer_list {
                let _ = write_event(&mut *w.lock().await, &evt).await;
            }
        }
    });
}
```

- [ ] **Step 7: Update handle_handoff (lines 632-633)**

The `session_writers.lock().await.clear()` line clears the entire HashMap, which drops all writer Vecs. This is correct for broadcast — all clients lose output during handoff. No change needed.

- [ ] **Step 8: Run daemon tests**

Run: `cd crates/daemon && cargo test -- --test-threads=1`
Expected: All existing tests PASS. Some reconnect tests may need updating (see Task 3).

- [ ] **Step 9: Update reconnect tests for broadcast behavior**

In `crates/daemon/tests/reconnect.rs`, the test `test_reattach_new_connection_no_split_bytes` asserts that after a second client attaches, output goes to the new connection and NOT the old one. With broadcast, both connections receive output. Update the test to verify both clients receive output.

Similarly, `test_rapid_reattach` should verify the final connection receives output (it will, since all do now).

- [ ] **Step 10: Run all daemon tests again**

Run: `cd crates/daemon && cargo test -- --test-threads=1`
Expected: All PASS.

- [ ] **Step 11: Commit**

```bash
git add crates/daemon/src/main.rs crates/daemon/tests/reconnect.rs
git commit -m "feat(daemon): replace single-writer with broadcast model

Multiple clients can now attach to the same session and all receive
output. Failed writers are removed from the broadcast list automatically."
```

---

### Task 3: Add Broadcast Integration Test

**Files:**
- Modify: `crates/daemon/tests/reconnect.rs`

- [ ] **Step 1: Add test for two clients receiving same output**

Add to `reconnect.rs`:

```rust
/// Two clients attached to the same session both receive output (broadcast model).
#[test]
fn test_broadcast_both_clients_receive_output() {
    let daemon = DaemonHandle::start();

    let mut shared = daemon.connect();
    spawn_echo_session(&mut shared, "sess-broadcast");

    // Two dedicated connections, both attach to the same session
    let mut client_a = daemon.connect();
    attach(&mut client_a, "sess-broadcast");
    client_a.drain_output(Duration::from_millis(200));

    let mut client_b = daemon.connect();
    attach(&mut client_b, "sess-broadcast");
    client_b.drain_output(Duration::from_millis(200));

    // Send input
    send_input(&mut shared, "sess-broadcast", b"BROADCAST\n");

    // Both clients should receive the output
    let output_a = client_a.collect_output(9);
    let output_b = client_b.collect_output(9);
    assert!(
        String::from_utf8_lossy(&output_a).contains("BROADCAST"),
        "client A should receive broadcast output, got: {:?}",
        String::from_utf8_lossy(&output_a)
    );
    assert!(
        String::from_utf8_lossy(&output_b).contains("BROADCAST"),
        "client B should receive broadcast output, got: {:?}",
        String::from_utf8_lossy(&output_b)
    );
}
```

- [ ] **Step 2: Run test**

Run: `cd crates/daemon && cargo test test_broadcast_both_clients_receive_output -- --test-threads=1`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/daemon/tests/reconnect.rs
git commit -m "test(daemon): add broadcast integration test"
```

---

### Task 4: Smallest-Client-Wins Resize

**Files:**
- Modify: `crates/daemon/src/main.rs` (new type alias, Attach/Detach/Resize/stream_output updates)

- [ ] **Step 1: Add SessionSizes type and integrate into Attach/Resize/Detach**

Add new type alias near the top of `main.rs`:

```rust
/// Per-session size registry: maps client pointer → (cols, rows).
/// Used to compute min(cols) x min(rows) across all attached clients.
type SessionSizes = Arc<Mutex<HashMap<String, HashMap<usize, (u16, u16)>>>>;
```

Initialize in `main()` alongside `session_writers`:

```rust
let session_sizes: SessionSizes = Arc::new(Mutex::new(HashMap::new()));
```

Thread through `handle_connection` → `handle_command` alongside `session_writers`.

Update `Resize` handler: instead of directly calling `mgr.resize()`, compute min dimensions:

```rust
Command::Resize { session_id, cols, rows } => {
    // Update this client's size in the registry
    let writer_id = Arc::as_ptr(&writer) as usize;
    {
        let mut sizes = session_sizes.lock().await;
        sizes.entry(session_id.clone()).or_default().insert(writer_id, (cols, rows));
    }

    // Compute effective size: min across all attached clients
    let (eff_cols, eff_rows) = {
        let sizes = session_sizes.lock().await;
        if let Some(client_sizes) = sizes.get(&session_id) {
            let min_cols = client_sizes.values().map(|(c, _)| *c).min().unwrap_or(cols);
            let min_rows = client_sizes.values().map(|(_, r)| *r).min().unwrap_or(rows);
            (min_cols, min_rows)
        } else {
            (cols, rows)
        }
    };

    let mgr = sessions.lock().await;
    let result = mgr.resize(&session_id, eff_cols, eff_rows);
    drop(mgr);
    let evt = match result {
        Ok(_) => Event::Ok,
        Err(e) => Event::Error { message: e.to_string() },
    };
    let _ = write_event(&mut *writer.lock().await, &evt).await;
}
```

Update `Detach` handler to remove client's size entry and recompute:

```rust
// In Detach handler, after removing writer from list:
{
    let mut sizes = session_sizes.lock().await;
    if let Some(client_sizes) = sizes.get_mut(&session_id) {
        let writer_id = Arc::as_ptr(&writer) as usize;
        client_sizes.remove(&writer_id);
        // Recompute effective size if clients remain
        if !client_sizes.is_empty() {
            let min_cols = client_sizes.values().map(|(c, _)| *c).min().unwrap_or(80);
            let min_rows = client_sizes.values().map(|(_, r)| *r).min().unwrap_or(24);
            let mgr = sessions.lock().await;
            let _ = mgr.resize(&session_id, min_cols, min_rows);
        }
    }
}
```

Also clean up sizes in `Kill` handler and `stream_output` exit path.

- [ ] **Step 2: Run daemon tests**

Run: `cd crates/daemon && cargo test -- --test-threads=1`
Expected: All PASS. Existing resize behavior unchanged for single-client case.

- [ ] **Step 3: Commit**

```bash
git add crates/daemon/src/main.rs
git commit -m "feat(daemon): smallest-client-wins resize for multi-client sessions"
```

---

### Task 5: Broadcast `ShuttingDown` During Handoff

**Files:**
- Modify: `crates/daemon/src/main.rs:281-326` (handle_connection — pass hook_tx)
- Modify: `crates/daemon/src/main.rs:590-667` (handle_handoff — broadcast + timing)

- [ ] **Step 1: Update handle_handoff signature and call site**

Add `hook_tx: broadcast::Sender<String>` parameter to `handle_handoff`. Update the call in `handle_connection` (line 301):

```rust
Some(Command::Handoff { version }) => {
    handle_handoff(version, raw_fd, sessions.clone(), session_writers.clone(),
                   writer.clone(), hook_tx.clone()).await;
    break;
}
```

- [ ] **Step 2: Broadcast ShuttingDown before exit**

In `handle_handoff`, after sending fds and before the exit thread, broadcast `ShuttingDown`:

```rust
// After fd transfer, before exit:
let shutdown_evt = Event::ShuttingDown;
if let Ok(json) = serde_json::to_string(&shutdown_evt) {
    let _ = hook_tx.send(json);
}

log::info!("[handoff] complete, broadcasting ShuttingDown, exiting");
std::thread::spawn(|| {
    std::thread::sleep(std::time::Duration::from_millis(500)); // was 100ms
    std::process::exit(0);
});
tokio::time::sleep(std::time::Duration::from_millis(600)).await; // was 200ms
```

- [ ] **Step 3: Add integration test for ShuttingDown broadcast**

Add to `crates/daemon/tests/handoff.rs`. Need to add `Subscribe` to the test `Cmd` enum and `ShuttingDown` to `Evt`:

```rust
// Add to Cmd enum:
Subscribe,

// Add to Evt enum:
ShuttingDown,
```

Then add the test:

```rust
/// Two subscribed clients both receive ShuttingDown when handoff is triggered.
#[test]
fn test_handoff_broadcasts_shutting_down() {
    let dir = test_dir("shutdown-broadcast");

    let daemon_a = DaemonHandle::start_in(&dir);

    // Two subscriber clients
    let mut sub_a = daemon_a.connect();
    sub_a.send(&Cmd::Subscribe);
    match sub_a.recv() { Evt::Ok => {}, other => panic!("expected Ok, got {:?}", other) }

    let mut sub_b = daemon_a.connect();
    sub_b.send(&Cmd::Subscribe);
    match sub_b.recv() { Evt::Ok => {}, other => panic!("expected Ok, got {:?}", other) }

    // Trigger handoff by starting daemon B in same dir
    let _daemon_b = DaemonHandle::start_in(&dir);

    // Both subscribers should receive ShuttingDown
    // Set short timeout — event should arrive quickly
    sub_a.writer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    sub_b.writer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();

    let evt_a = sub_a.recv();
    assert!(matches!(evt_a, Evt::ShuttingDown), "sub_a should get ShuttingDown, got: {:?}", evt_a);

    let evt_b = sub_b.recv();
    assert!(matches!(evt_b, Evt::ShuttingDown), "sub_b should get ShuttingDown, got: {:?}", evt_b);

    cleanup(&dir);
}
```

- [ ] **Step 4: Run tests**

Run: `cd crates/daemon && cargo test -- --test-threads=1`
Expected: All PASS including new ShuttingDown broadcast test.

- [ ] **Step 5: Commit**

```bash
git add crates/daemon/src/main.rs crates/daemon/tests/handoff.rs
git commit -m "feat(daemon): broadcast ShuttingDown to subscribers during handoff"
```

---

### Task 6: Event Bridge Reconnection

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs:273-323` (spawn_event_bridge)
- Modify: `apps/desktop/src-tauri/src/lib.rs:380-388` (setup — pass daemon_state)

- [ ] **Step 1: Add HAS_SPAWNED static and connect_with_backoff helper**

Add near the top of `lib.rs`:

```rust
use std::sync::atomic::{AtomicBool, Ordering};

static HAS_SPAWNED: AtomicBool = AtomicBool::new(false);

async fn connect_with_backoff() -> Option<DaemonClient> {
    let socket_path = daemon_socket_path();
    let mut delay = std::time::Duration::from_millis(50);
    for attempt in 1..=30 {
        match DaemonClient::connect(&socket_path).await {
            Ok(client) => {
                eprintln!("[reconnect] connected on attempt {}", attempt);
                return Some(client);
            }
            Err(_) => {
                tokio::time::sleep(delay).await;
                delay = std::cmp::min(delay * 2, std::time::Duration::from_secs(2));
            }
        }
    }
    eprintln!("[reconnect] failed to connect after 30 attempts");
    None
}
```

- [ ] **Step 2: Rewrite spawn_event_bridge with reconnect loop**

```rust
fn spawn_event_bridge(app: tauri::AppHandle, daemon_state: DaemonState) {
    tauri::async_runtime::spawn(async move {
        loop {
            let mut event_client = match connect_with_backoff().await {
                Some(c) => c,
                None => {
                    // Crash recovery: if we can't connect, try spawning a new daemon
                    eprintln!("[event-bridge] backoff exhausted, attempting daemon spawn");
                    ensure_daemon_running().await;
                    match connect_with_backoff().await {
                        Some(c) => c,
                        None => {
                            eprintln!("[event-bridge] cannot connect after spawn, giving up");
                            return;
                        }
                    }
                }
            };

            // Subscribe to hook event broadcasts
            let _ = event_client
                .send_command(&serde_json::json!({"type":"Subscribe"}).to_string())
                .await;
            let _ = event_client.read_event().await; // consume Ok

            eprintln!("[event-bridge] connected and subscribed to daemon events");
            let _ = app.emit("daemon_ready", ());

            // Inner read loop
            loop {
                match event_client.read_event().await {
                    Ok(line) => {
                        let event: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };

                        match event.get("type").and_then(|t| t.as_str()) {
                            Some("ShuttingDown") => {
                                eprintln!("[event-bridge] received ShuttingDown, reconnecting...");
                                break;
                            }
                            Some("Output") => {
                                let _ = app.emit("terminal_output", &event);
                            }
                            Some("Exit") => {
                                let _ = app.emit("session_exit", &event);
                            }
                            Some("HookEvent") => {
                                let _ = app.emit("hook_event", &event);
                            }
                            Some("StatusChanged") => {
                                let _ = app.emit("status_changed", &event);
                            }
                            _ => {}
                        }
                    }
                    Err(_) => {
                        eprintln!("[event-bridge] daemon connection lost, reconnecting...");
                        break;
                    }
                }
            }

            // Clear command connection so next use reconnects
            *daemon_state.lock().await = None;
        }
    });
}
```

- [ ] **Step 3: Update setup to use HAS_SPAWNED and pass daemon_state**

```rust
// In setup closure:
let handle = app.handle().clone();
let daemon_state: DaemonState = app.handle().state::<DaemonState>().inner().clone();
let daemon_state_bridge = daemon_state.clone();
tauri::async_runtime::spawn(async move {
    HAS_SPAWNED.store(true, Ordering::Relaxed);
    ensure_daemon_running().await;
    *daemon_state.lock().await = None;
    spawn_event_bridge(handle, daemon_state_bridge);
});
```

- [ ] **Step 4: Build to verify compilation**

Run: `cd apps/desktop && bun tauri build --debug 2>&1 | tail -5` (or just `cargo check -p kanna-desktop`)
Expected: Compiles without errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(app): event bridge reconnection with backoff and crash recovery"
```

---

### Task 7: AttachedSessions Tracking and Re-attach Coordinator

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/daemon.rs:1-8` (imports, new types)
- Modify: `apps/desktop/src-tauri/src/commands/daemon.rs:199-301` (attach/detach)
- Modify: `apps/desktop/src-tauri/src/lib.rs:342-344` (manage state)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (re-attach coordinator)

- [ ] **Step 1: Add AttachedSessions type and extract attach_session_inner**

In `commands/daemon.rs`, add:

```rust
use std::collections::HashSet;

pub type AttachedSessions = Arc<Mutex<HashSet<String>>>;
```

Extract the body of `attach_session` into `attach_session_inner`:

```rust
pub async fn attach_session_inner(
    app: &tauri::AppHandle,
    session_id: String,
    attached: &AttachedSessions,
) -> Result<(), String> {
    let socket_path = daemon_socket_path();
    let mut stream_client = DaemonClient::connect(&socket_path).await?;

    let cmd = serde_json::json!({ "type": "Attach", "session_id": session_id });
    stream_client
        .send_command(&serde_json::to_string(&cmd).unwrap())
        .await?;

    let response = stream_client.read_event().await?;
    let event: serde_json::Value = serde_json::from_str(&response).map_err(|e| e.to_string())?;
    if let Some("Error") = event.get("type").and_then(|t| t.as_str()) {
        let msg = event
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("attach failed");
        return Err(msg.to_string());
    }

    // Track this session
    attached.lock().await.insert(session_id.clone());

    let sid = session_id.clone();
    let app_clone = app.clone();
    let attached_clone = attached.clone();
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        loop {
            match stream_client.read_event().await {
                Ok(line) => {
                    // ... same Output/Exit handling as current attach_session ...
                    let event: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    match event.get("type").and_then(|t| t.as_str()) {
                        Some("Output") => {
                            if let Some(data) = event.get("data").and_then(|d| d.as_array()) {
                                let bytes: Vec<u8> = data
                                    .iter()
                                    .filter_map(|v| v.as_u64().map(|n| n as u8))
                                    .collect();
                                use base64::Engine;
                                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                                let payload = serde_json::json!({
                                    "session_id": event.get("session_id"),
                                    "data_b64": b64,
                                });
                                let _ = app_clone.emit("terminal_output", &payload);
                                if bytes.windows(11).any(|w| w == b"Interrupted") {
                                    let hook = serde_json::json!({
                                        "session_id": event.get("session_id"),
                                        "event": "Interrupted",
                                    });
                                    let _ = app_clone.emit("hook_event", &hook);
                                }
                                if bytes.windows(21).any(|w| w == b"Do you want to allow") {
                                    let hook = serde_json::json!({
                                        "session_id": event.get("session_id"),
                                        "event": "WaitingForInput",
                                    });
                                    let _ = app_clone.emit("hook_event", &hook);
                                }
                            } else {
                                let _ = app_clone.emit("terminal_output", &event);
                            }
                        }
                        Some("Exit") => {
                            let _ = app_clone.emit("session_exit", &event);
                            // Session exited — remove from tracked set
                            attached_clone.lock().await.remove(&sid);
                            break;
                        }
                        _ => {}
                    }
                }
                Err(_) => {
                    // EOF — daemon restarted. Do NOT remove from AttachedSessions.
                    break;
                }
            }
        }
        eprintln!("[attach] output stream ended for session {}", sid);
    });

    Ok(())
}

#[tauri::command]
pub async fn attach_session(
    app: tauri::AppHandle,
    attached: tauri::State<'_, AttachedSessions>,
    session_id: String,
) -> Result<(), String> {
    attach_session_inner(&app, session_id, &attached).await
}
```

- [ ] **Step 2: Update detach_session to remove from AttachedSessions**

```rust
#[tauri::command]
pub async fn detach_session(
    state: tauri::State<'_, DaemonState>,
    attached: tauri::State<'_, AttachedSessions>,
    session_id: String,
) -> Result<(), String> {
    attached.lock().await.remove(&session_id);
    let cmd = serde_json::json!({
        "type": "Detach",
        "session_id": session_id,
    });
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    ensure_connected(&state).await?;
    let mut guard = state.lock().await;
    guard.as_mut().unwrap().send_command(&json).await
}
```

- [ ] **Step 3: Register AttachedSessions in lib.rs**

In `lib.rs`, add:

```rust
use commands::daemon::AttachedSessions;
use std::collections::HashSet;
```

In the builder chain:

```rust
.manage(Arc::new(Mutex::new(HashSet::new())) as AttachedSessions)
```

- [ ] **Step 4: Add re-attach coordinator in lib.rs**

```rust
fn spawn_reattach_coordinator(app: tauri::AppHandle, attached: AttachedSessions) {
    tauri::async_runtime::spawn(async move {
        let app_clone = app.clone();
        let _ = app.listen("daemon_ready", move |_| {
            let app = app_clone.clone();
            let attached = attached.clone();
            tauri::async_runtime::spawn(async move {
                let session_ids: Vec<String> = attached.lock().await.iter().cloned().collect();
                if session_ids.is_empty() {
                    return;
                }
                eprintln!("[reattach] re-attaching {} sessions", session_ids.len());
                for sid in session_ids {
                    if let Err(e) = commands::daemon::attach_session_inner(&app, sid.clone(), &attached).await {
                        eprintln!("[reattach] failed to re-attach {}: {}", sid, e);
                        attached.lock().await.remove(&sid);
                    } else {
                        // Trigger SIGWINCH redraw
                        let _ = // send resize via command connection
                    }
                }
            });
        });
    });
}
```

Call from setup after `spawn_event_bridge`:

```rust
let attached: AttachedSessions = app.handle().state::<AttachedSessions>().inner().clone();
spawn_reattach_coordinator(handle.clone(), attached);
```

- [ ] **Step 5: Build to verify compilation**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: Compiles.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/daemon.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(app): session tracking, re-attach coordinator, and reconnection"
```

---

### Task 8: Update SPEC.md and Clippy/Fmt

**Files:**
- Modify: `crates/daemon/SPEC.md`

- [ ] **Step 1: Update invariants in SPEC.md**

Update invariant 3, replace invariant 6, add 7 and 8. Add `ShuttingDown` to the protocol reference table. Add a reconnection section.

- [ ] **Step 2: Run clippy and fmt**

```bash
cd crates/daemon && cargo clippy && cargo fmt
cd apps/desktop/src-tauri && cargo clippy && cargo fmt
```

Fix any warnings.

- [ ] **Step 3: Run full test suite**

```bash
cd crates/daemon && cargo test -- --test-threads=1
bun tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add crates/daemon/SPEC.md crates/daemon/src/ apps/desktop/src-tauri/src/
git commit -m "docs: update SPEC.md invariants and protocol reference for concurrent connections"
```
