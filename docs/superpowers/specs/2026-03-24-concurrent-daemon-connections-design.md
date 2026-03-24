# Concurrent App Connections to Daemon

## Problem

Today, only one Kanna app instance can meaningfully connect to a daemon at a time. When a second app launches (e.g., the installed release build alongside a dev worktree), it spawns a fresh daemon, triggering handoff. The first app's connections silently break — its command connection, event bridge, and per-session attach connections all hit EOF with no recovery path.

The "one client per session" invariant (Attach swaps the ActiveWriter atomically) means if two apps both view the same session, the second silently steals output from the first — the first app's terminal freezes with no error or notification.

## Goals

1. Multiple Kanna processes can connect to the same daemon simultaneously, each viewing their own sessions
2. When one app triggers a daemon restart (handoff), all other connected apps seamlessly reconnect
3. Multiple windows within the same Kanna process work without additional changes (already supported by shared backend + session_id filtering)

## Non-Goals

- Daemon reuse / skip-handoff optimization (every app launch still spawns fresh)
- Frontend changes (reconnection is handled entirely in the Tauri backend)

## Design

### 1. Protocol: Add `ShuttingDown` Event

Add a new event to the daemon protocol:

```rust
// protocol.rs — Event enum
ShuttingDown,
```

Wire format: `{"type":"ShuttingDown"}\n`

The daemon broadcasts this to all `Subscribe`d connections during handoff, after fd transfer completes but before exiting. This tells apps: "I'm about to die — don't reconnect to me, wait for the new daemon."

Without this signal, apps that detect a broken connection would race to reconnect and might reach the old daemon's socket in the brief window before it exits, only to lose the connection again immediately.

### 2. Daemon: Broadcast `ShuttingDown` During Handoff

In `handle_handoff()`, after sending `HandoffReady` + SCM_RIGHTS fds, broadcast `ShuttingDown` to all subscribers before exiting:

```
handle_handoff():
  1. Collect live sessions, detach fds
  2. Clear SessionWriters
  3. Send HandoffReady + fds to new daemon
  4. Serialize ShuttingDown as JSON, send via hook_tx.send()
  5. Wait for subscriber flush (see timing below)
  6. Exit
```

**Implementation detail:** `handle_handoff`'s signature must be updated to accept `hook_tx: broadcast::Sender<String>`. The call site in `handle_connection` (main.rs line 301) must pass `hook_tx_clone.clone()`:

```rust
// handle_connection, line 301
Command::Handoff { version } => {
    handle_handoff(version, raw_fd, sessions_clone, session_writers.clone(),
                   writer.clone(), hook_tx_clone.clone()).await;
    break;
}
```

**Flush timing:** The broadcast channel's `send()` is non-blocking — it deposits into subscriber ringbuffers. But subscriber tasks need Tokio scheduling to actually `write_all` and `flush` to their sockets. The current 100ms sleep before `exit(0)` may not be sufficient under load. Change the exit delay from 100ms to 500ms to give subscribers time to flush, and log a warning if any subscribers are still connected at exit time.

### 3. Tauri Backend: Event Bridge Reconnection

The event bridge (`spawn_event_bridge` in `lib.rs`) is the natural place to coordinate reconnection since it already has a long-lived connection with a read loop.

**Current behavior:** On read error, logs "daemon connection lost" and exits the task.

**New behavior:**

```
spawn_event_bridge(app, daemon_state):
  loop:                                          // outer reconnect loop
    client = connect_with_backoff()
    subscribe(client)
    app.emit("daemon_ready")                     // signal: new daemon connection established
    loop:
      event = client.read_event()
      match event:
        ShuttingDown =>
          break                                  // exit inner loop → reconnect
        Output => app.emit("terminal_output")    // preserve existing handler
        Exit => app.emit("session_exit")         // preserve existing handler
        HookEvent => app.emit("hook_event")
        StatusChanged => app.emit("status_changed")
        Err => break                             // EOF fallback, same as ShuttingDown
    // Clear command connection so next use reconnects
    *daemon_state.lock() = None
```

The event bridge must receive a reference to `DaemonState` so it can clear it on disconnect. Currently `spawn_event_bridge` only takes `app: AppHandle` — add `daemon_state: DaemonState` as a second parameter.

**Note:** The `Output` and `Exit` handlers are preserved from the current event bridge implementation. These handle output from sessions that were attached via the event bridge's own Subscribe connection. The per-session attach connections (Section 5) handle their own output streams independently.

`connect_with_backoff()` retries connection with exponential backoff (50ms, 100ms, 200ms, ... capped at 2s, max 30 attempts). The new daemon needs time to complete handoff, write its PID file, and bind the socket. If all attempts fail, log an error and stop the event bridge (the app is non-functional without a daemon).

### 4. Tauri Backend: Command Connection Recovery

**Current state:** `DaemonState = Arc<Mutex<Option<DaemonClient>>>`. `ensure_connected()` lazily connects if `None`.

**Change:** When the event bridge detects `ShuttingDown` or EOF, it sets `DaemonState` to `None`. The next command from any frontend window will trigger `ensure_connected()`, which reconnects to the new daemon transparently.

Commands in flight during the handoff window will fail with "daemon not connected". These are short-lived (the handoff takes <1s) and the frontend already handles command errors.

### 5. Tauri Backend: Per-Session Attach Reconnection

Each `attach_session` call spawns a dedicated background task that streams `Output`/`Exit` events for one session. When the daemon restarts, these connections break (EOF).

**New behavior:** Track attached session IDs and re-attach after reconnection.

```rust
// New state alongside DaemonState
pub type AttachedSessions = Arc<Mutex<HashSet<String>>>;
```

**On attach:** Add `session_id` to `AttachedSessions`.
**On explicit detach:** `detach_session` must accept `AttachedSessions` as managed state and call `.remove(&session_id)` before sending the Detach command. This prevents the re-attach coordinator from reviving sessions the user intentionally closed.
**On session exit:** Remove `session_id` from `AttachedSessions` (the process is gone, nothing to re-attach).
**On EOF in attach task (daemon restart):** Don't remove — the session is still alive in the new daemon.

**Extract `attach_session_inner`:** The current `attach_session` is a `#[tauri::command]` designed for frontend invocation. The re-attach coordinator runs in Rust backend code and cannot call Tauri commands directly. Extract the core logic into a shared function:

```rust
/// Core attach logic — callable from both the Tauri command and the re-attach coordinator.
pub async fn attach_session_inner(app: &AppHandle, session_id: String) -> Result<(), String> {
    // Current attach_session body moves here
}

#[tauri::command]
pub async fn attach_session(app: AppHandle, session_id: String) -> Result<(), String> {
    attach_session_inner(&app, session_id).await
}
```

**Re-attach coordinator:** A background task spawned at app startup that listens for `daemon_ready` (emitted by the event bridge after reconnecting — see Section 3). On each `daemon_ready`:

1. Reads `AttachedSessions`
2. For each session_id, calls `attach_session_inner` (opens a new connection, sends Attach, starts streaming)
3. Sends SIGWINCH via Resize to trigger Claude TUI redraw

The brief gap between old daemon exit and re-attach manifests as a terminal freeze (~0.5-2s). No data is lost — the new daemon inherited the PTY fds and `stream_output` resumes on Attach.

### 6. Tauri Backend: `hasSpawnedThisLaunch` Guard

**Problem:** If two Kanna processes are running and the daemon dies for any reason (crash, manual kill), both would try to spawn a new daemon simultaneously.

**Solution:** Like the Swift version, track whether this app instance has already spawned a daemon this launch:

```rust
static HAS_SPAWNED: AtomicBool = AtomicBool::new(false);
```

- **First call (app startup):** Always spawn. Set `HAS_SPAWNED = true`.
- **Subsequent reconnects (after ShuttingDown/EOF):** Don't spawn. Just reconnect with backoff — another app (or the user) triggered the restart.

**Crash recovery:** If `connect_with_backoff()` exhausts all attempts (no daemon responds after ~30s), the event bridge falls back to spawning a new daemon regardless of `HAS_SPAWNED`. This handles the case where the daemon crashed (no `ShuttingDown` broadcast) and no other app instance is alive to spawn a replacement. After spawning, reset the backoff and retry connection.

This prevents the "thundering herd" problem in the common case while still recovering from daemon crashes.

### 7. Daemon: Broadcast Model for Session Output

Replace the single-writer `ActiveWriter` pattern with a broadcast model where multiple clients can attach to the same session simultaneously. This matches the Swift v1 daemon's proven approach.

**Current architecture (single writer):**
```rust
// One writer slot per session — Attach swaps atomically, previous client silently loses output
type ActiveWriter = Arc<Mutex<Option<Arc<Mutex<OwnedWriteHalf>>>>>;
type SessionWriters = Arc<Mutex<HashMap<String, ActiveWriter>>>;
```

**New architecture (broadcast to all attached clients):**
```rust
// Multiple writers per session — Attach adds to the list, all clients receive output
type SessionWriter = Arc<Mutex<OwnedWriteHalf>>;
type SessionWriters = Arc<Mutex<HashMap<String, Vec<SessionWriter>>>>;
```

**Attach:** Adds the new client's writer to the session's writer list. Does not remove or affect existing writers.

**Detach:** Removes the client's writer from the session's writer list.

**`stream_output` changes:** Instead of writing to one `ActiveWriter`, iterate over all writers in the session's list. If a write to any client fails (broken pipe, slow consumer), remove that writer from the list and continue — don't block other clients.

```
stream_output loop:
  data = pty.read()
  writers = session_writers.get(session_id)
  retain only writers where write_event succeeds
```

**Pre-attach buffer:** Each new Attach flushes the pre-attach buffer to that specific client (if still available). The buffer is consumed after the first Attach — subsequent clients that attach later won't receive startup output. This is acceptable: the primary consumer (the app that spawned the session) always attaches first.

**Connection acceptance:** The daemon already accepts multiple connections in its `loop { listener.accept() }`. Each connection gets its own `handle_connection` task. Multiple apps can connect simultaneously — each gets its own command connection, event bridge (Subscribe), and per-session attach connections. Two apps attaching to the same session now both receive output.

## Connection Topology

```
                    ┌──────────────────────────────┐
                    │          Daemon               │
                    │                               │
  App A             │   sessions: HashMap           │            App B
  ─────             │   hook_tx: broadcast          │            ─────
                    │   writers: HashMap<id, Vec>   │
                    │                               │
  cmd conn ────────►│   conn handler (A-cmd)        │◄──────── cmd conn
  event bridge ────►│   conn handler (A-sub) ◄─hook │◄──────── event bridge
  attach(s1) ──────►│   conn handler (A-s1) ◄─s1──►│◄──────── attach(s1)  ← both see s1
  attach(s3) ──────►│   conn handler (A-s3)         │◄──────── attach(s4)
                    │                               │
                    └──────────────────────────────┘
```

Each connection is independent. Multiple clients can attach to the same session — all receive output via broadcast.

## Reconnection Sequence

```
Time ──►

App A                    Daemon (old)              Daemon (new)              App B
  │                          │                         │                       │
  │  (both connected)        │◄── Handoff{v:1} ────────│    (spawned by B)     │
  │                          │── HandoffReady + fds ──►│                       │
  │                          │                         │                       │
  │◄── ShuttingDown ─────────│── ShuttingDown ────────────────────────────────►│
  │                          │                         │                       │
  │  clear DaemonState       │── exit(0) ─────────────►X                       │  clear DaemonState
  │                          X                         │                       │
  │                                                    │── write PID           │
  │                                                    │── bind socket         │
  │                                                    │                       │
  │── connect_with_backoff() ─────────────────────────►│◄── connect_with_backoff()
  │── Subscribe ──────────────────────────────────────►│◄── Subscribe ─────────│
  │── emit("daemon_ready") internally                  │    emit("daemon_ready")
  │── re-attach(s1) ──────────────────────────────────►│◄── re-attach(s2) ────│
  │── re-attach(s3) ──────────────────────────────────►│◄── re-attach(s4) ────│
  │── Resize (SIGWINCH) ──────────────────────────────►│◄── Resize (SIGWINCH) │
  │                                                    │                       │
  │    terminals resume                                │       terminals resume│
```

Both apps receive `ShuttingDown` and reconnect independently in parallel.

## Invariant Updates

Current SPEC.md invariants that change:

| # | Current | New |
|---|---------|-----|
| 3 | Always spawn. App always spawns on startup. | Always spawn on first startup. Reconnect (don't spawn) on daemon restart. Spawn again only if reconnect backoff is exhausted (daemon crash recovery). |
| 5 | One reader per session. Single `stream_output` task. | Unchanged — still one reader per session, but output is broadcast to all attached writers. |
| 6 | One client per session. Attach swaps atomically. | **Multiple clients per session.** Attach adds to writer list. All attached clients receive output via broadcast. |

New invariants:

| # | Invariant |
|---|-----------|
| 7 | **Always broadcast.** Before exiting during handoff, the old daemon broadcasts `ShuttingDown` to all subscribers. |
| 8 | **Always reconnect.** Apps detect daemon restart (via `ShuttingDown` or EOF) and automatically reconnect + re-attach all tracked sessions. |

## Files to Modify

### Daemon (`crates/daemon/`)
- `src/protocol.rs` — Add `ShuttingDown` variant to `Event` enum + serialization test
- `src/main.rs` — Replace `ActiveWriter` (single writer) with `Vec<SessionWriter>` (broadcast list); update `stream_output` to iterate writers and drop failed ones; update `Attach` to push to writer list instead of swapping; update `Detach` to remove from list; add `hook_tx` parameter to `handle_handoff`; update call site in `handle_connection`; broadcast `ShuttingDown` before exit; increase exit delay to 500ms

### Tauri Backend (`apps/desktop/src-tauri/`)
- `src/lib.rs` — Rewrite `spawn_event_bridge` with reconnect loop and `daemon_state`/`daemon_ready` coordination; add `AttachedSessions` managed state; add `HAS_SPAWNED` guard with crash recovery fallback; spawn re-attach coordinator listening for `daemon_ready`
- `src/commands/daemon.rs` — Extract `attach_session_inner` from `attach_session`; add `AttachedSessions` tracking to `attach_session_inner` (add on attach), `detach_session` (remove on detach), and the attach streaming task (remove on Exit, keep on EOF)

### Daemon SPEC (`crates/daemon/SPEC.md`)
- Update invariant 3, add invariants 7 and 8
- Add `ShuttingDown` to protocol reference table
- Add reconnection sequence documentation

### Frontend
- No changes required

## Testing

- **Unit test:** `ShuttingDown` event serialization roundtrip in `protocol.rs`
- **Integration test:** Spawn daemon, connect two clients (each subscribing), trigger handoff from a third connection, verify both clients receive `ShuttingDown`
- **Integration test:** Verify crash recovery — kill daemon with SIGKILL (no `ShuttingDown`), confirm app detects EOF and respawns after backoff exhaustion
- **Integration test:** Spawn a session, attach two clients to the same session, send input, verify both clients receive the same output (broadcast model)
- **Manual test:** Run release Kanna + dev worktree Kanna simultaneously, restart one, verify the other's terminals recover seamlessly
