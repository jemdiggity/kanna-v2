# Kanna Mobile: Remote Agent Monitoring via Tauri Mobile + Relay

## Problem

Kanna is a desktop-only app. When agents are running, there's no way to check task status or interact with terminals from a phone. The goal is to monitor and interact with running agents remotely — e.g., from a ski lift.

## Architecture

Thin relay architecture with four components:

```
Phone (Tauri mobile) ←wss→ Relay (Cloud Run) ←wss→ kanna-server (local) ←unix→ Daemon
```

The relay is a stateless WebSocket broker. It authenticates clients and forwards messages. All logic lives in kanna-server, which executes commands locally and returns results through the relay.

The protocol mirrors Tauri's IPC model: the phone sends `invoke` messages with a command name and args, kanna-server executes them and returns responses. The mobile Tauri app implements the same `#[tauri::command]` signatures as desktop, but serializes them over WebSocket instead of the native bridge. The frontend doesn't know which path it's on.

## Components

### 1. kanna-server (local Rust binary)

New crate at `crates/kanna-server/`. Rust binary using axum + tokio-tungstenite.

**Responsibilities:**
- Maintain persistent WebSocket connection to relay (reconnects with exponential backoff)
- Handle incoming `invoke` messages by executing command logic
- Stream daemon events (terminal output, session exit) back through relay as `event` messages
- Read SQLite DB directly (same DB the desktop app uses, read-only)
- Talk to daemon over Unix socket (same protocol)

**Daemon event bridge:**

The daemon has a "one client per session" invariant — only one output consumer per PTY session via `Attach`. The existing `Subscribe` command only broadcasts `HookEvent` messages (session lifecycle hooks), not terminal output. Terminal output flows exclusively through `Attach` → `stream_output` → `ActiveWriter`.

This means a **daemon protocol extension** is required to support mobile terminal streaming without breaking the desktop app.

**New daemon command: `Observe`**

```json
{"type": "Observe", "session_id": "..."}
{"type": "Unobserve", "session_id": "..."}
```

`Observe` registers a passive, read-only output listener for a session. The daemon tees PTY output to both the `ActiveWriter` (set by `Attach`, used by desktop) and any registered observers. Observers receive `Output` and `Exit` events but cannot send input or claim the session.

Key properties:
- Multiple observers per session (no limit)
- Observers are independent of `Attach` — the desktop app's `Attach`/`Detach` lifecycle is unchanged
- If no `ActiveWriter` is set, observers still receive output (the PTY reader runs regardless)
- `Observe` is idempotent; `Unobserve` removes the observer

**Implementation in daemon:** The `PtySession` gains an `observers: Vec<mpsc::Sender<Event>>` alongside the existing `active_writer: Option<mpsc::Sender<Event>>`. The `stream_output` loop sends each output chunk to both the active writer and all observers.

**kanna-server usage:** On startup, kanna-server opens one persistent connection to the daemon. When the phone sends `attach_session`, kanna-server sends `Observe` to the daemon and starts forwarding `Output`/`Exit` events through the relay. `detach_session` sends `Unobserve`. For `send_input`, kanna-server sends the daemon's existing `Input` command directly — input does not require `Attach` ownership.

**No resize from mobile:** The phone does not send `resize_session` — the PTY dimensions are owned by the desktop. Resizing from the phone would break the desktop terminal layout. The mobile xterm.js instance renders the output at whatever dimensions the desktop has set, using horizontal scrolling if needed.

**v1 command surface:**
- `list_pipeline_items` — read pipeline items from SQLite
- `get_pipeline_item` — single item detail
- `list_sessions` — daemon session list
- `attach_session` — start streaming terminal output
- `detach_session` — stop streaming
- `send_input` — send keystrokes to terminal (no coordination with desktop — concurrent input goes to the same PTY)

**Startup:**
- Reads relay URL + device token from config file (`~/Library/Application Support/Kanna/server.toml`)
- Connects to relay, authenticates with device token
- Discovers daemon socket path using same logic as Tauri app
- Opens SQLite DB read-only

**Not in v1:** git operations, filesystem access, agent SDK (creating new sessions), DB writes.

### 2. Relay (Cloud Run, Node/TypeScript)

Stateless WebSocket message broker deployed on Cloud Run.

**Responsibilities:**
- Accept WebSocket connections from phones and kanna-servers
- Authenticate phones via Firebase Auth ID tokens (verified server-side)
- Authenticate kanna-servers via device tokens (random secret, stored in Firestore as `deviceToken → userId`)
- Route messages between paired connections by user ID
- No message parsing, no state beyond device registry

**Connection state (in-memory):**
- Map of `userId → {phone: WebSocket?, server: WebSocket?}`
- Phone message with no server connected → `{"type": "error", "message": "Desktop offline"}`
- Server event with no phone connected → dropped (terminal output is ephemeral)

**Deployment:** Deploy with `--session-affinity` so Cloud Run routes reconnecting clients back to the same instance (preserves the in-memory connection map). kanna-server's exponential backoff reconnection handles instance recycling transparently — a dropped WebSocket just triggers a reconnect.

**Pairing flow (one-time):**
1. Run `kanna-server register` on Mac
2. Opens a browser-based Firebase Auth flow (localhost callback), obtains a Firebase ID token
3. Generates a random device token
4. Hits relay REST endpoint (`POST /register`) with Firebase ID token + device token
5. Relay verifies the Firebase token, stores `{deviceToken → userId}` in Firestore
6. kanna-server saves the device token locally (`~/Library/Application Support/Kanna/server.toml`)
7. Subsequent connections use device token only

### 3. Tauri Mobile App (`apps/mobile/`)

Separate Tauri app in the monorepo. Shares the Vue frontend with desktop but has a completely different Rust backend.

**Why separate from `apps/desktop/`:**
- Rust backend is different (WebSocket client vs daemon manager)
- No daemon, PTY, git2, or filesystem commands
- Smaller binary (only tokio, tungstenite, serde)
- Different `tauri.conf.json` (bundle ID, permissions)

**Rust backend (`apps/mobile/src-tauri/`):**
- Connects to relay via WebSocket on startup
- Implements same `#[tauri::command]` signatures as desktop
- Serializes commands to `{"type": "invoke", ...}`, sends over WebSocket, waits for response
- Relay pushes `event` messages → Rust emits Tauri events → frontend `listen()` works identically
- Firebase Auth via WebView-based OAuth flow, stores token in secure storage

**Shared frontend:**
- Same Vue components, stores, composables from `apps/desktop/src/`
- `listen()` works identically on both platforms
- Needs responsive CSS for phone screens
- Some views gated for mobile (e.g., hide file browser)
- xterm.js works in mobile WebViews

**DB access abstraction:**

The desktop frontend accesses SQLite directly via `tauri-plugin-sql` and `@kanna/db` query helpers (e.g., `listPipelineItems(db, repoId)`). These calls bypass Tauri `invoke` entirely. On mobile, there is no local database — all data comes from kanna-server through the relay.

The solution is a **data access layer** that abstracts the DB calls behind a platform-aware interface. On desktop, it calls the `@kanna/db` helpers directly. On mobile, it serializes the query as an `invoke` message through the relay to kanna-server, which executes the query against the local SQLite and returns the result.

Concretely: the kanna store (`apps/desktop/src/stores/kanna.ts`) currently calls `@kanna/db` helpers with a `DbHandle`. On mobile, a mock `DbHandle` (or a new composable like `useData()`) routes those calls through `invoke` instead. The store code doesn't change — only the data source behind it.

**Mobile-specific differences:**
- Settings stored locally (Firebase token, relay URL)

## Message Protocol

Messages are JSON over WebSocket. Three types:

### invoke (phone → server)
```json
{"type": "invoke", "id": 1, "command": "list_sessions", "args": {}}
```

### response (server → phone)
```json
{"type": "response", "id": 1, "data": [...]}
```
```json
{"type": "response", "id": 1, "error": "session not found"}
```

### event (server → phone, unsolicited)
```json
{"type": "event", "name": "terminal_output", "payload": {"session_id": "abc", "data_b64": "..."}}
```
```json
{"type": "event", "name": "session_exit", "payload": {"session_id": "abc", "code": 0}}
```

The relay forwards all three types without parsing. It only inspects the initial auth handshake.

## v1 Scope

**In scope:**
- View task pipeline (read-only)
- View task details
- Watch agent terminal output live
- Send terminal input
- Firebase Auth login on phone
- Device pairing (one-time setup)

**Out of scope (future increments):**
- Push notifications (FCM)
- Git operations (diffs, push, worktree management)
- Agent creation from mobile
- DB writes (stage changes, task creation)
- Offline mode / cached state
- Multi-user / team sharing
- File browsing

## v1 Experience

Open app on phone → see task pipeline → tap a task → watch agent terminal live → send input if needed.

## Monorepo Layout (additions)

```
crates/kanna-server/        # new: local HTTP/WebSocket server
apps/mobile/                 # new: Tauri mobile app (iOS/Android)
services/relay/              # new: Cloud Run relay service
```
