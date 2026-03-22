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

**v1 command surface:**
- `list_pipeline_items` — read pipeline items from SQLite
- `get_pipeline_item` — single item detail
- `list_sessions` — daemon session list
- `attach_session` — start streaming terminal output
- `detach_session` — stop streaming
- `send_input` — send keystrokes to terminal
- `resize_session` — terminal resize

**Startup:**
- Reads relay URL + device token from config file
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

**Pairing flow (one-time):**
1. Run `kanna-server register` on Mac
2. Generates random device token, hits relay REST endpoint with Firebase Auth token + device token
3. Relay stores `{deviceToken → userId}` in Firestore
4. kanna-server saves device token locally
5. Subsequent connections use device token only

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
- `invoke()` and `listen()` work identically on both platforms
- Needs responsive CSS for phone screens
- Some views gated for mobile (e.g., hide file browser)
- xterm.js works in mobile WebViews

**Mobile-specific differences:**
- DB queries go through relay (as invoke commands to kanna-server) instead of local `tauri-plugin-sql`
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
