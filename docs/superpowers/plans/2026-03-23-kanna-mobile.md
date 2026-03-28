# Kanna Mobile Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable remote agent monitoring and terminal interaction from a phone via a thin relay architecture.

**Architecture:** Local Rust server (kanna-server) connects to a stateless Cloud Run relay via WebSocket. A Tauri mobile app shares the desktop Vue frontend and routes invoke/listen calls through the relay to kanna-server, which talks to the daemon and SQLite locally.

**Tech Stack:** Rust (axum, tokio-tungstenite), Node/TypeScript (Cloud Run relay), Firebase Auth, Firestore, Tauri v2 mobile, Vue 3, xterm.js

**Spec:** `docs/superpowers/specs/2026-03-22-kanna-mobile-design.md`

---

## File Structure

### Daemon Protocol Extension (Observe/Unobserve)
- Modify: `crates/daemon/src/protocol.rs` — add Observe/Unobserve command variants
- Modify: `crates/daemon/src/main.rs` — add observers map, tee output in stream_output, handle Observe/Unobserve commands

### kanna-server (new crate)
- Create: `crates/kanna-server/Cargo.toml`
- Create: `crates/kanna-server/src/main.rs` — entry point, config loading, startup
- Create: `crates/kanna-server/src/relay_client.rs` — WebSocket connection to relay, reconnect logic
- Create: `crates/kanna-server/src/commands.rs` — command dispatcher (invoke → handler routing)
- Create: `crates/kanna-server/src/db.rs` — SQLite read-only queries (list_pipeline_items, get_pipeline_item)
- Create: `crates/kanna-server/src/daemon_client.rs` — Unix socket client to daemon (reuse protocol crate)
- Create: `crates/kanna-server/src/config.rs` — config file parsing (relay URL, device token)
- Create: `crates/kanna-server/src/register.rs` — device registration CLI flow

### Relay Service
- Create: `services/relay/package.json`
- Create: `services/relay/tsconfig.json`
- Create: `services/relay/src/index.ts` — Cloud Run entry point, WebSocket server
- Create: `services/relay/src/auth.ts` — Firebase Auth token verification
- Create: `services/relay/src/router.ts` — connection pairing and message routing
- Create: `services/relay/Dockerfile`

### Tauri Mobile App
- Create: `apps/mobile/` — Tauri v2 mobile app scaffold (iOS/Android)
- Create: `apps/mobile/src-tauri/Cargo.toml`
- Create: `apps/mobile/src-tauri/src/lib.rs` — Tauri commands that proxy through relay
- Create: `apps/mobile/src-tauri/src/relay_client.rs` — WebSocket to relay
- Create: `apps/mobile/src-tauri/src/commands.rs` — invoke proxy commands
- Shared: `apps/desktop/src/` — Vue frontend (shared via symlink or Vite config)

### DB Access Abstraction
- Modify: `packages/db/src/queries.ts` — no changes needed (already uses DbHandle interface)
- Create: `packages/db/src/remote-db.ts` — RemoteDbHandle that routes queries through invoke
- Modify: `apps/desktop/src/stores/kanna.ts` — use platform-aware DB initialization
- Modify: `apps/desktop/src/stores/db.ts` — export createDbHandle factory

---

## Task 1: Daemon Protocol Extension — Observe/Unobserve

Add Observe/Unobserve commands to the daemon protocol so kanna-server can passively receive terminal output without claiming the Attach writer.

**Files:**
- Modify: `crates/daemon/src/protocol.rs:6-46` (Command enum)
- Modify: `crates/daemon/src/main.rs:17-27` (types), `main.rs:673-749` (stream_output), `main.rs:296-325` (handle_client), `main.rs:328-457` (handle_command)

### Steps

- [ ] **Step 1: Add Observe/Unobserve variants to Command enum**

In `crates/daemon/src/protocol.rs`, add to the `Command` enum (after `Subscribe`):

```rust
Observe {
    session_id: String,
},
Unobserve {
    session_id: String,
},
```

- [ ] **Step 2: Add protocol roundtrip tests**

In `crates/daemon/src/protocol.rs`, add tests at the end of the `mod tests` block:

```rust
#[test]
fn test_command_observe_roundtrip() {
    let cmd = Command::Observe {
        session_id: "s1".to_string(),
    };
    let json = serde_json::to_string(&cmd).unwrap();
    let decoded: Command = serde_json::from_str(&json).unwrap();
    match decoded {
        Command::Observe { session_id } => assert_eq!(session_id, "s1"),
        _ => panic!("wrong variant"),
    }
}

#[test]
fn test_command_unobserve_roundtrip() {
    let cmd = Command::Unobserve {
        session_id: "s1".to_string(),
    };
    let json = serde_json::to_string(&cmd).unwrap();
    let decoded: Command = serde_json::from_str(&json).unwrap();
    match decoded {
        Command::Unobserve { session_id } => assert_eq!(session_id, "s1"),
        _ => panic!("wrong variant"),
    }
}
```

- [ ] **Step 3: Run protocol tests**

Run: `cd crates/daemon && cargo test -- protocol`
Expected: All tests pass including the two new ones

- [ ] **Step 4: Add SessionObservers type**

In `crates/daemon/src/main.rs`, after the `PreAttachBuffers` type (line 27), add:

```rust
/// Map of session_id → list of observer writers (passive output tee).
/// Observers receive Output and Exit events without claiming the ActiveWriter.
type SessionObservers = Arc<Mutex<HashMap<String, Vec<Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>>>>>;
```

- [ ] **Step 5: Initialize SessionObservers in main()**

Find where `session_writers` and `pre_attach_buffers` are initialized in `main()` and add:

```rust
let session_observers: SessionObservers = Arc::new(Mutex::new(HashMap::new()));
```

Pass `session_observers.clone()` to `handle_connection` (note: the function is called `handle_connection`, not `handle_client`), and from there to `handle_command` and `stream_output`.

- [ ] **Step 6: Update handle_connection signature**

Add `session_observers: SessionObservers` parameter to `handle_connection` (line 281 of `main.rs`). Pass it through to `handle_command`.

- [ ] **Step 7: Update handle_command signature**

Add `session_observers: SessionObservers` parameter to `handle_command` (line 328).

- [ ] **Step 8: Implement Observe command handler**

Add Observe handling inside `handle_connection`'s match block (alongside `Subscribe` at ~line 304), NOT in `handle_command`. This is because `Observe` needs to register the connection's `writer` as an observer, similar to how `Subscribe` registers the writer for hook events at the connection level:

```rust
Some(Command::Observe { session_id }) => {
    let mgr = sessions.lock().await;
    if !mgr.contains(&session_id) {
        let evt = Event::Error {
            message: format!("session not found: {}", session_id),
        };
        drop(mgr);
        let _ = write_event(&mut *writer.lock().await, &evt).await;
        continue;
    }
    drop(mgr);

    let mut observers = session_observers.lock().await;
    observers
        .entry(session_id.clone())
        .or_insert_with(Vec::new)
        .push(writer.clone());

    let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
}
```

- [ ] **Step 9: Implement Unobserve command handler**

Also in `handle_connection`'s match block:

```rust
Some(Command::Unobserve { session_id }) => {
    let mut observers = session_observers.lock().await;
    if let Some(list) = observers.get_mut(&session_id) {
        let writer_ptr = Arc::as_ptr(&writer);
        list.retain(|w| Arc::as_ptr(w) != writer_ptr);
        if list.is_empty() {
            observers.remove(&session_id);
        }
    }
    let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
}
```

- [ ] **Step 10: Tee output to observers in stream_output**

Update `stream_output` signature to accept `session_observers: SessionObservers`. **Important:** `stream_output` is a non-async function running in a blocking thread — it uses `rt.block_on()` to bridge into async. All observer tee code must follow this pattern.

In the output path (after sending to `active_writer`, around line 714-719), add:

```rust
// Tee to observers (inside the existing rt.block_on block, or a new one)
rt.block_on(async {
    let observers_guard = session_observers.lock().await;
    if let Some(observer_list) = observers_guard.get(&session_id) {
        let obs_evt = Event::Output {
            session_id: session_id.clone(),
            data: data.clone(),
        };
        for obs in observer_list {
            let _ = write_event(&mut *obs.lock().await, &obs_evt).await;
        }
    }
});
```

Also tee the `Exit` event (around line 742-748):

```rust
// Notify observers of exit
rt.block_on(async {
    let observers_guard = session_observers.lock().await;
    if let Some(observer_list) = observers_guard.get(&session_id) {
        for obs in observer_list {
            let _ = write_event(&mut *obs.lock().await, &evt).await;
        }
    }
    // Clean up observers for this session
    session_observers.lock().await.remove(&session_id);
});
```

- [ ] **Step 11: Pass session_observers to stream_output call sites**

Update both `stream_output` call sites in `handle_command` (Spawn at ~line 374, Attach at ~line 454) to pass `session_observers.clone()`.

- [ ] **Step 12: Run daemon tests**

Run: `cd crates/daemon && cargo test -- --test-threads=1`
Expected: All tests pass

- [ ] **Step 13: Commit**

```bash
git add crates/daemon/
git commit -m "feat(daemon): add Observe/Unobserve protocol for passive output tee"
```

---

## Task 2: kanna-server — Config and Daemon Client

Create the kanna-server crate scaffold with config loading and daemon communication.

**Files:**
- Create: `crates/kanna-server/Cargo.toml`
- Create: `crates/kanna-server/src/main.rs`
- Create: `crates/kanna-server/src/config.rs`
- Create: `crates/kanna-server/src/daemon_client.rs`

### Steps

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "kanna-server"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
toml = "0.8"
axum = "0.8"
tokio-tungstenite = { version = "0.26", features = ["native-tls"] }
futures-util = "0.3"
rusqlite = { version = "0.34", features = ["bundled"] }
log = "0.4"
env_logger = "0.11"
base64 = "0.22"
kanna-daemon = { path = "../daemon" }
```

Note: `kanna-daemon` dependency is for sharing the `protocol` module. If protocol is not pub, we'll copy the types. Check this during implementation.

- [ ] **Step 2: Verify daemon protocol is accessible**

Check if `crates/daemon/src/protocol.rs` types are public. Read `crates/daemon/src/main.rs` line 2: `mod protocol;` — it's private. We need to either make it `pub mod protocol;` in the daemon or extract protocol into a shared crate.

Decision: Make `protocol` module public in the daemon crate. Add `pub` to `mod protocol;` in `crates/daemon/src/main.rs` (line 2). This is the simplest change — the daemon is a binary crate, but since kanna-server depends on it as a library, we also need to add a `lib.rs`.

Alternative (simpler): Extract protocol types into the daemon's `lib.rs` so they can be imported by kanna-server. Create `crates/daemon/src/lib.rs` that re-exports:

```rust
pub mod protocol;
```

And in `main.rs`, change `mod protocol;` to `use kanna_daemon::protocol;`.

- [ ] **Step 3: Create daemon lib.rs for protocol sharing**

Create `crates/daemon/src/lib.rs`:

```rust
pub mod protocol;
```

Update `crates/daemon/src/main.rs` line 2: change `mod protocol;` to remove it, and add `use kanna_daemon::protocol;` after the other use statements. Keep `use protocol::{Command, Event};` as-is since it now refers to the re-exported module.

- [ ] **Step 4: Verify daemon still compiles**

Run: `cd crates/daemon && cargo build`
Expected: Compiles successfully

- [ ] **Step 5: Create config.rs**

```rust
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub relay_url: String,
    pub device_token: String,
    #[serde(default = "default_daemon_dir")]
    pub daemon_dir: String,
    #[serde(default = "default_db_path")]
    pub db_path: String,
}

fn default_daemon_dir() -> String {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Kanna")
        .to_string_lossy()
        .to_string()
}

fn default_db_path() -> String {
    // Tauri stores the DB in the bundle identifier directory, not the daemon dir
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.kanna.app")
        .join("kanna-v2.db")
        .to_string_lossy()
        .to_string()
}

impl Config {
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let config_path = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Kanna")
            .join("server.toml");

        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}. Run 'kanna-server register' first.", config_path.display(), e))?;

        let config: Config = toml::from_str(&content)?;
        Ok(config)
    }
}
```

Note: Add `dirs = "6"` to Cargo.toml dependencies.

- [ ] **Step 6: Create daemon_client.rs**

```rust
use kanna_daemon::protocol::{Command, Event};
use std::collections::HashMap;
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

pub struct DaemonClient {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
}

impl DaemonClient {
    pub async fn connect(daemon_dir: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let socket_path = socket_path_for_dir(daemon_dir);
        let stream = UnixStream::connect(&socket_path).await
            .map_err(|e| format!("Failed to connect to daemon at {}: {}", socket_path.display(), e))?;

        let (read_half, write_half) = stream.into_split();
        Ok(Self {
            reader: BufReader::new(read_half),
            writer: write_half,
        })
    }

    pub async fn send_command(&mut self, cmd: &Command) -> Result<Event, Box<dyn std::error::Error>> {
        let json = serde_json::to_string(cmd)?;
        self.writer.write_all(json.as_bytes()).await?;
        self.writer.write_all(b"\n").await?;
        self.writer.flush().await?;

        let mut line = String::new();
        self.reader.read_line(&mut line).await?;
        let event: Event = serde_json::from_str(line.trim())?;
        Ok(event)
    }

    pub async fn read_event(&mut self) -> Result<Event, Box<dyn std::error::Error>> {
        let mut line = String::new();
        self.reader.read_line(&mut line).await?;
        let event: Event = serde_json::from_str(line.trim())?;
        Ok(event)
    }
}

fn socket_path_for_dir(daemon_dir: &str) -> std::path::PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    daemon_dir.hash(&mut hasher);
    let hash = hasher.finish();
    let hex = format!("{:08x}", hash as u32);
    std::path::PathBuf::from(format!("/tmp/kanna-{}.sock", hex))
}
```

- [ ] **Step 7: Create minimal main.rs**

```rust
mod config;
mod daemon_client;

use config::Config;

#[tokio::main]
async fn main() {
    env_logger::init();

    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("register") {
        eprintln!("Registration not yet implemented");
        std::process::exit(1);
    }

    let config = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    };

    log::info!("kanna-server starting, relay: {}", config.relay_url);
    log::info!("Connecting to daemon at {}", config.daemon_dir);

    // Verify daemon connection
    match daemon_client::DaemonClient::connect(&config.daemon_dir).await {
        Ok(_client) => log::info!("Connected to daemon"),
        Err(e) => {
            eprintln!("Failed to connect to daemon: {}", e);
            std::process::exit(1);
        }
    }

    log::info!("kanna-server ready (relay connection not yet implemented)");
}
```

- [ ] **Step 8: Verify it compiles**

Run: `cd crates/kanna-server && cargo build`
Expected: Compiles successfully

- [ ] **Step 9: Commit**

```bash
git add crates/kanna-server/ crates/daemon/src/lib.rs
git commit -m "feat(kanna-server): scaffold crate with config and daemon client"
```

---

## Task 3: kanna-server — SQLite Queries and Command Dispatcher

Add read-only SQLite queries and the command routing layer.

**Files:**
- Create: `crates/kanna-server/src/db.rs`
- Create: `crates/kanna-server/src/commands.rs`
- Modify: `crates/kanna-server/src/main.rs`

### Steps

- [ ] **Step 1: Create db.rs**

Read-only queries matching the `@kanna/db` TypeScript queries. Only the v1 subset:

```rust
use rusqlite::{Connection, params};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct PipelineItem {
    pub id: String,
    pub repo_id: String,
    pub issue_number: Option<i64>,
    pub issue_title: Option<String>,
    pub prompt: Option<String>,
    pub stage: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
    pub branch: Option<String>,
    pub agent_type: Option<String>,
    pub activity: Option<String>,
    pub activity_changed_at: Option<String>,
    pub pinned: Option<i64>,
    pub pin_order: Option<i64>,
    pub display_name: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Repo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub hidden: Option<i64>,
    pub created_at: Option<String>,
    pub last_opened_at: Option<String>,
}

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Ok(Self { conn })
    }

    pub fn list_repos(&self) -> Result<Vec<Repo>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, default_branch, hidden, created_at, last_opened_at FROM repo WHERE hidden = 0 OR hidden IS NULL ORDER BY last_opened_at DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Repo {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                default_branch: row.get(3)?,
                hidden: row.get(4)?,
                created_at: row.get(5)?,
                last_opened_at: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn list_pipeline_items(&self, repo_id: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, stage, pr_number, pr_url, branch, agent_type, activity, activity_changed_at, pinned, pin_order, display_name, created_at, updated_at FROM pipeline_item WHERE repo_id = ? ORDER BY pin_order ASC, created_at DESC"
        )?;
        let rows = stmt.query_map(params![repo_id], |row| {
            Ok(PipelineItem {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                issue_number: row.get(2)?,
                issue_title: row.get(3)?,
                prompt: row.get(4)?,
                stage: row.get(5)?,
                pr_number: row.get(6)?,
                pr_url: row.get(7)?,
                branch: row.get(8)?,
                agent_type: row.get(9)?,
                activity: row.get(10)?,
                activity_changed_at: row.get(11)?,
                pinned: row.get(12)?,
                pin_order: row.get(13)?,
                display_name: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_pipeline_item(&self, id: &str) -> Result<Option<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, stage, pr_number, pr_url, branch, agent_type, activity, activity_changed_at, pinned, pin_order, display_name, created_at, updated_at FROM pipeline_item WHERE id = ?"
        )?;
        let mut rows = stmt.query_map(params![id], |row| {
            Ok(PipelineItem {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                issue_number: row.get(2)?,
                issue_title: row.get(3)?,
                prompt: row.get(4)?,
                stage: row.get(5)?,
                pr_number: row.get(6)?,
                pr_url: row.get(7)?,
                branch: row.get(8)?,
                agent_type: row.get(9)?,
                activity: row.get(10)?,
                activity_changed_at: row.get(11)?,
                pinned: row.get(12)?,
                pin_order: row.get(13)?,
                display_name: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }
}
```

- [ ] **Step 2: Create commands.rs**

```rust
use crate::daemon_client::DaemonClient;
use crate::db::Db;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};
use serde_json::Value;

pub async fn handle_invoke(
    command: &str,
    args: &Value,
    db: &Db,
    daemon: &mut DaemonClient,
) -> Result<Value, String> {
    match command {
        "list_repos" => {
            let repos = db.list_repos().map_err(|e| e.to_string())?;
            serde_json::to_value(repos).map_err(|e| e.to_string())
        }
        "list_pipeline_items" => {
            let repo_id = args.get("repo_id")
                .and_then(|v| v.as_str())
                .ok_or("missing repo_id")?;
            let items = db.list_pipeline_items(repo_id).map_err(|e| e.to_string())?;
            serde_json::to_value(items).map_err(|e| e.to_string())
        }
        "get_pipeline_item" => {
            let id = args.get("id")
                .and_then(|v| v.as_str())
                .ok_or("missing id")?;
            let item = db.get_pipeline_item(id).map_err(|e| e.to_string())?;
            serde_json::to_value(item).map_err(|e| e.to_string())
        }
        "list_sessions" => {
            let resp = daemon.send_command(&DaemonCommand::List).await
                .map_err(|e| e.to_string())?;
            match resp {
                DaemonEvent::SessionList { sessions } => {
                    serde_json::to_value(sessions).map_err(|e| e.to_string())
                }
                DaemonEvent::Error { message } => Err(message),
                _ => Err("unexpected daemon response".to_string()),
            }
        }
        "send_input" => {
            let session_id = args.get("session_id")
                .and_then(|v| v.as_str())
                .ok_or("missing session_id")?
                .to_string();
            let data: Vec<u8> = if let Some(arr) = args.get("data").and_then(|v| v.as_array()) {
                arr.iter().filter_map(|v| v.as_u64().map(|n| n as u8)).collect()
            } else if let Some(s) = args.get("data").and_then(|v| v.as_str()) {
                s.as_bytes().to_vec()
            } else {
                return Err("missing data".to_string());
            };
            let resp = daemon.send_command(&DaemonCommand::Input { session_id, data }).await
                .map_err(|e| e.to_string())?;
            match resp {
                DaemonEvent::Ok => Ok(Value::Null),
                DaemonEvent::Error { message } => Err(message),
                _ => Err("unexpected daemon response".to_string()),
            }
        }
        _ => Err(format!("unknown command: {}", command)),
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd crates/kanna-server && cargo build`
Expected: Compiles (though main.rs doesn't use commands.rs yet)

- [ ] **Step 4: Commit**

```bash
git add crates/kanna-server/
git commit -m "feat(kanna-server): add SQLite queries and command dispatcher"
```

---

## Task 4: kanna-server — Relay WebSocket Client

Connect kanna-server to the relay via WebSocket with reconnection and message routing.

**Files:**
- Create: `crates/kanna-server/src/relay_client.rs`
- Modify: `crates/kanna-server/src/main.rs`

### Steps

- [ ] **Step 1: Create relay_client.rs**

```rust
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RelayMessage {
    #[serde(rename = "auth")]
    Auth { device_token: String },
    #[serde(rename = "invoke")]
    Invoke { id: u64, command: String, args: serde_json::Value },
    #[serde(rename = "response")]
    Response { id: u64, #[serde(skip_serializing_if = "Option::is_none")] data: Option<serde_json::Value>, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String> },
    #[serde(rename = "event")]
    Event { name: String, payload: serde_json::Value },
    #[serde(rename = "error")]
    Error { message: String },
}

pub async fn connect_to_relay(
    relay_url: &str,
    device_token: &str,
) -> Result<(
    futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>,
    futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>,
), Box<dyn std::error::Error>> {
    let (ws_stream, _) = connect_async(relay_url).await?;
    let (mut sink, stream) = ws_stream.split();

    // Authenticate
    let auth_msg = RelayMessage::Auth {
        device_token: device_token.to_string(),
    };
    let json = serde_json::to_string(&auth_msg)?;
    sink.send(Message::Text(json.into())).await?;

    Ok((sink, stream))
}
```

- [ ] **Step 2: Update main.rs with full relay loop**

```rust
mod commands;
mod config;
mod daemon_client;
mod db;
mod relay_client;

use config::Config;
use daemon_client::DaemonClient;
use db::Db;
use relay_client::{RelayMessage, connect_to_relay};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() {
    env_logger::init();

    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("register") {
        eprintln!("Registration not yet implemented");
        std::process::exit(1);
    }

    let config = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    };

    // Open DB (uses db_path, not daemon_dir — Tauri stores DB in bundle ID dir)
    let db_path = config.db_path.clone();
    let db = match Db::open(&db_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed to open database at {}: {}", db_path, e);
            std::process::exit(1);
        }
    };

    log::info!("kanna-server starting, relay: {}", config.relay_url);

    // Reconnection loop
    loop {
        log::info!("Connecting to relay...");
        match connect_to_relay(&config.relay_url, &config.device_token).await {
            Ok((sink, mut stream)) => {
                log::info!("Connected to relay");
                let sink = Arc::new(Mutex::new(sink));

                while let Some(msg) = stream.next().await {
                    match msg {
                        Ok(Message::Text(text)) => {
                            let relay_msg: RelayMessage = match serde_json::from_str(&text) {
                                Ok(m) => m,
                                Err(e) => {
                                    log::error!("Failed to parse relay message: {}", e);
                                    continue;
                                }
                            };

                            match relay_msg {
                                RelayMessage::Invoke { id, command, args } => {
                                    let mut daemon = match DaemonClient::connect(&config.daemon_dir).await {
                                        Ok(d) => d,
                                        Err(e) => {
                                            let resp = RelayMessage::Response {
                                                id,
                                                data: None,
                                                error: Some(format!("daemon connection failed: {}", e)),
                                            };
                                            let json = serde_json::to_string(&resp).unwrap();
                                            let _ = sink.lock().await.send(Message::Text(json.into())).await;
                                            continue;
                                        }
                                    };

                                    let result = commands::handle_invoke(&command, &args, &db, &mut daemon).await;
                                    let resp = match result {
                                        Ok(data) => RelayMessage::Response { id, data: Some(data), error: None },
                                        Err(e) => RelayMessage::Response { id, data: None, error: Some(e) },
                                    };
                                    let json = serde_json::to_string(&resp).unwrap();
                                    let _ = sink.lock().await.send(Message::Text(json.into())).await;
                                }
                                _ => {
                                    log::warn!("Unexpected relay message type");
                                }
                            }
                        }
                        Ok(Message::Close(_)) => {
                            log::info!("Relay closed connection");
                            break;
                        }
                        Err(e) => {
                            log::error!("WebSocket error: {}", e);
                            break;
                        }
                        _ => {}
                    }
                }
            }
            Err(e) => {
                log::error!("Failed to connect to relay: {}", e);
            }
        }

        // Exponential backoff
        log::info!("Reconnecting in 5 seconds...");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd crates/kanna-server && cargo build`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add crates/kanna-server/
git commit -m "feat(kanna-server): add relay WebSocket client with reconnection"
```

---

## Task 5: kanna-server — Observe-Based Terminal Streaming

Wire up daemon Observe/Unobserve for terminal output streaming through the relay.

**Files:**
- Modify: `crates/kanna-server/src/commands.rs`
- Modify: `crates/kanna-server/src/main.rs`

### Steps

- [ ] **Step 1: Add attach_session and detach_session commands**

In `commands.rs`, add handlers for `attach_session` and `detach_session`. These use `Observe`/`Unobserve` instead of `Attach`/`Detach`:

Add to the match in `handle_invoke`:

```rust
"attach_session" => {
    let session_id = args.get("session_id")
        .and_then(|v| v.as_str())
        .ok_or("missing session_id")?
        .to_string();
    let resp = daemon.send_command(&DaemonCommand::Observe { session_id }).await
        .map_err(|e| e.to_string())?;
    match resp {
        DaemonEvent::Ok => Ok(Value::Null),
        DaemonEvent::Error { message } => Err(message),
        _ => Err("unexpected daemon response".to_string()),
    }
}
"detach_session" => {
    let session_id = args.get("session_id")
        .and_then(|v| v.as_str())
        .ok_or("missing session_id")?
        .to_string();
    let resp = daemon.send_command(&DaemonCommand::Unobserve { session_id }).await
        .map_err(|e| e.to_string())?;
    match resp {
        DaemonEvent::Ok => Ok(Value::Null),
        DaemonEvent::Error { message } => Err(message),
        _ => Err("unexpected daemon response".to_string()),
    }
}
```

- [ ] **Step 2: Add observer event forwarding in main.rs**

After sending `Observe` and getting `Ok`, spawn a task that reads events from the daemon connection and forwards them through the relay as `event` messages. This requires keeping the daemon connection alive for the duration of the observation.

Refactor: `attach_session` should not use the on-demand daemon connection pattern. Instead, create a dedicated daemon connection for observation that lives in a background task.

Add to `main.rs` — a HashMap tracking active observation tasks:

```rust
use std::collections::HashMap;
use tokio::task::JoinHandle;

// In the main loop, before the message processing:
let mut observe_tasks: HashMap<String, JoinHandle<()>> = HashMap::new();
```

In the `Invoke` handler, special-case `attach_session`:

```rust
"attach_session" => {
    // Handle in main loop to manage the observer task
}
```

When `attach_session` is invoked:
1. Connect a new DaemonClient
2. Send `Observe { session_id }`
3. Spawn a task that reads events and forwards them via the relay sink
4. Store the task handle

When `detach_session` is invoked:
1. Abort the observer task
2. (The daemon will clean up the observer when the connection drops)

- [ ] **Step 3: Implement observer task spawning**

This is the core streaming logic. When attach_session is called:

```rust
if command == "attach_session" {
    let session_id = args.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Cancel existing observer if any
    if let Some(handle) = observe_tasks.remove(&session_id) {
        handle.abort();
    }

    let mut obs_daemon = match DaemonClient::connect(&config.daemon_dir).await {
        Ok(d) => d,
        Err(e) => {
            // send error response
            continue;
        }
    };

    match obs_daemon.send_command(&DaemonCommand::Observe { session_id: session_id.clone() }).await {
        Ok(DaemonEvent::Ok) => {
            // Send success response
            let resp = RelayMessage::Response { id, data: Some(Value::Null), error: None };
            let json = serde_json::to_string(&resp).unwrap();
            let _ = sink.lock().await.send(Message::Text(json.into())).await;

            // Spawn observer forwarding task
            let sink_clone = sink.clone();
            let sid = session_id.clone();
            let handle = tokio::spawn(async move {
                loop {
                    match obs_daemon.read_event().await {
                        Ok(DaemonEvent::Output { session_id, data }) => {
                            let evt = RelayMessage::Event {
                                name: "terminal_output".to_string(),
                                payload: serde_json::json!({
                                    "session_id": session_id,
                                    "data_b64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data),
                                }),
                            };
                            let json = serde_json::to_string(&evt).unwrap();
                            if sink_clone.lock().await.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                        Ok(DaemonEvent::Exit { session_id, code }) => {
                            let evt = RelayMessage::Event {
                                name: "session_exit".to_string(),
                                payload: serde_json::json!({
                                    "session_id": session_id,
                                    "code": code,
                                }),
                            };
                            let json = serde_json::to_string(&evt).unwrap();
                            let _ = sink_clone.lock().await.send(Message::Text(json.into())).await;
                            break;
                        }
                        Err(e) => {
                            log::error!("Observer read error for {}: {}", sid, e);
                            break;
                        }
                        _ => {}
                    }
                }
            });
            observe_tasks.insert(session_id, handle);
            continue; // Skip normal command handling
        }
        Ok(DaemonEvent::Error { message }) => {
            let resp = RelayMessage::Response { id, data: None, error: Some(message) };
            let json = serde_json::to_string(&resp).unwrap();
            let _ = sink.lock().await.send(Message::Text(json.into())).await;
            continue;
        }
        _ => continue,
    }
}
```

- [ ] **Step 4: Handle detach_session**

```rust
if command == "detach_session" {
    let session_id = args.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if let Some(handle) = observe_tasks.remove(&session_id) {
        handle.abort(); // Connection drop triggers daemon cleanup
    }
    let resp = RelayMessage::Response { id, data: Some(Value::Null), error: None };
    let json = serde_json::to_string(&resp).unwrap();
    let _ = sink.lock().await.send(Message::Text(json.into())).await;
    continue;
}
```

- [ ] **Step 5: Clean up observer tasks on relay disconnect**

Before the reconnection sleep, abort all observer tasks:

```rust
for (_, handle) in observe_tasks.drain() {
    handle.abort();
}
```

- [ ] **Step 6: Verify it compiles**

Run: `cd crates/kanna-server && cargo build`
Expected: Compiles successfully

- [ ] **Step 7: Commit**

```bash
git add crates/kanna-server/
git commit -m "feat(kanna-server): add Observe-based terminal streaming through relay"
```

---

## Task 6: kanna-server — Device Registration

Implement the `kanna-server register` CLI flow.

**Files:**
- Create: `crates/kanna-server/src/register.rs`
- Modify: `crates/kanna-server/src/main.rs`
- Modify: `crates/kanna-server/src/config.rs`

### Steps

- [ ] **Step 1: Create register.rs**

The registration flow:
1. Open browser for Firebase Auth (Google sign-in)
2. Start local HTTP server to receive OAuth callback
3. Exchange auth code for Firebase ID token
4. Generate random device token
5. POST to relay's /register endpoint
6. Save config to disk

```rust
use crate::config::Config;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

pub async fn register(relay_url: &str) -> Result<(), Box<dyn std::error::Error>> {
    // Generate device token
    let device_token = generate_device_token();

    println!("Device token generated.");
    println!();
    println!("To complete registration:");
    println!("1. Log in to the Kanna mobile app on your phone");
    println!("2. The app will pair with this device automatically");
    println!();
    println!("For now, saving config with device token...");

    // Save config
    let config_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Kanna");
    std::fs::create_dir_all(&config_dir)?;

    let config_path = config_dir.join("server.toml");
    let config_content = format!(
        r#"relay_url = "{}"
device_token = "{}"
daemon_dir = "{}"
"#,
        relay_url,
        device_token,
        config_dir.to_string_lossy(),
    );

    std::fs::write(&config_path, config_content)?;
    println!("Config saved to {}", config_path.display());
    println!("Device token: {}", device_token);

    Ok(())
}

fn generate_device_token() -> String {
    // Crypto-secure random — this token is the sole auth credential for kanna-server
    use std::fs::File;
    use std::io::Read;
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")
        .expect("failed to open /dev/urandom")
        .read_exact(&mut bytes)
        .expect("failed to read random bytes");
    bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>()
}
```

Note: Full browser-based Firebase Auth flow will be implemented when the relay is deployed. For now, registration generates a device token and saves config. The relay registration endpoint (`POST /register`) will validate the Firebase token and store the device mapping.

- [ ] **Step 2: Wire register into main.rs**

Update the args check in `main.rs`:

```rust
if args.get(1).map(|s| s.as_str()) == Some("register") {
    let relay_url = args.get(2).map(|s| s.as_str()).unwrap_or("wss://kanna-relay.run.app");
    if let Err(e) = register::register(relay_url).await {
        eprintln!("Registration failed: {}", e);
        std::process::exit(1);
    }
    return;
}
```

Add `mod register;` to the module declarations.

- [ ] **Step 3: Verify it compiles**

Run: `cd crates/kanna-server && cargo build`
Expected: Compiles

- [ ] **Step 4: Commit**

```bash
git add crates/kanna-server/
git commit -m "feat(kanna-server): add device registration CLI"
```

---

## Task 7: Relay Service — Cloud Run WebSocket Broker

Build the stateless relay service.

**Files:**
- Create: `services/relay/package.json`
- Create: `services/relay/tsconfig.json`
- Create: `services/relay/src/index.ts`
- Create: `services/relay/src/auth.ts`
- Create: `services/relay/src/router.ts`
- Create: `services/relay/Dockerfile`

### Steps

- [ ] **Step 1: Create package.json**

```json
{
  "name": "kanna-relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "ws": "^8.18.0",
    "firebase-admin": "^13.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/ws": "^8.5.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create auth.ts**

```typescript
import { initializeApp, cert, type ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin (uses GOOGLE_APPLICATION_CREDENTIALS in prod)
const app = initializeApp();
const auth = getAuth(app);
const db = getFirestore(app);

export async function verifyPhoneToken(idToken: string): Promise<string | null> {
  try {
    const decoded = await auth.verifyIdToken(idToken);
    return decoded.uid;
  } catch (e) {
    console.error('Firebase Auth verification failed:', e);
    return null;
  }
}

export async function verifyDeviceToken(deviceToken: string): Promise<string | null> {
  try {
    const doc = await db.collection('devices').doc(deviceToken).get();
    if (!doc.exists) return null;
    return doc.data()?.userId ?? null;
  } catch (e) {
    console.error('Device token verification failed:', e);
    return null;
  }
}

export async function registerDevice(userId: string, deviceToken: string): Promise<void> {
  await db.collection('devices').doc(deviceToken).set({
    userId,
    registeredAt: new Date().toISOString(),
  });
}
```

- [ ] **Step 4: Create router.ts**

```typescript
import type { WebSocket } from 'ws';

interface Connection {
  phone?: WebSocket;
  server?: WebSocket;
}

const connections = new Map<string, Connection>();

export function setPhoneConnection(userId: string, ws: WebSocket): void {
  const conn = connections.get(userId) ?? {};
  conn.phone = ws;
  connections.set(userId, conn);

  ws.on('close', () => {
    const c = connections.get(userId);
    if (c?.phone === ws) {
      c.phone = undefined;
      if (!c.server) connections.delete(userId);
    }
  });
}

export function setServerConnection(userId: string, ws: WebSocket): void {
  const conn = connections.get(userId) ?? {};
  conn.server = ws;
  connections.set(userId, conn);

  ws.on('close', () => {
    const c = connections.get(userId);
    if (c?.server === ws) {
      c.server = undefined;
      if (!c.phone) connections.delete(userId);
    }
  });
}

export function routeMessage(userId: string, from: 'phone' | 'server', data: string): void {
  const conn = connections.get(userId);
  if (!conn) return;

  const target = from === 'phone' ? conn.server : conn.phone;
  if (!target || target.readyState !== 1 /* WebSocket.OPEN */) {
    // If phone sent a message but server is offline, send error back
    if (from === 'phone' && conn.phone?.readyState === 1) {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'invoke' && parsed.id != null) {
          conn.phone.send(JSON.stringify({
            type: 'response',
            id: parsed.id,
            error: 'Desktop offline',
          }));
        }
      } catch {}
    }
    return;
  }

  target.send(data);
}
```

- [ ] **Step 5: Create index.ts**

```typescript
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyPhoneToken, verifyDeviceToken, registerDevice } from './auth.js';
import { setPhoneConnection, setServerConnection, routeMessage } from './router.js';

const PORT = parseInt(process.env.PORT ?? '8080');

const httpServer = createServer(async (req, res) => {
  // Registration endpoint
  if (req.method === 'POST' && req.url === '/register') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { idToken, deviceToken } = JSON.parse(body);
        const userId = await verifyPhoneToken(idToken);
        if (!userId) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Invalid Firebase token' }));
          return;
        }
        await registerDevice(userId, deviceToken);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    });
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws: WebSocket) => {
  let authenticated = false;
  let userId: string | null = null;
  let clientType: 'phone' | 'server' | null = null;

  // Expect first message to be auth
  const authTimeout = setTimeout(() => {
    if (!authenticated) ws.close(4001, 'Auth timeout');
  }, 10000);

  ws.on('message', async (raw: Buffer) => {
    const data = raw.toString();

    if (!authenticated) {
      clearTimeout(authTimeout);
      try {
        const msg = JSON.parse(data);

        if (msg.type === 'auth' && msg.id_token) {
          // Phone authentication
          userId = await verifyPhoneToken(msg.id_token);
          if (!userId) {
            ws.close(4003, 'Invalid token');
            return;
          }
          authenticated = true;
          clientType = 'phone';
          setPhoneConnection(userId, ws);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        } else if (msg.type === 'auth' && msg.device_token) {
          // Server authentication
          userId = await verifyDeviceToken(msg.device_token);
          if (!userId) {
            ws.close(4003, 'Invalid device token');
            return;
          }
          authenticated = true;
          clientType = 'server';
          setServerConnection(userId, ws);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        } else {
          ws.close(4002, 'Invalid auth message');
        }
      } catch {
        ws.close(4002, 'Invalid auth message');
      }
      return;
    }

    // Authenticated — route message
    if (userId && clientType) {
      routeMessage(userId, clientType, data);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Kanna relay listening on port ${PORT}`);
});
```

- [ ] **Step 6: Create Dockerfile**

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist dist/
ENV PORT=8080
CMD ["node", "dist/index.js"]
```

- [ ] **Step 7: Install deps and verify it compiles**

Run: `cd services/relay && npm install && npx tsc --noEmit`
Expected: Compiles with no errors

- [ ] **Step 8: Commit**

```bash
git add services/relay/
git commit -m "feat(relay): add Cloud Run WebSocket broker with Firebase Auth"
```

---

## Task 8: Tauri Mobile App — Scaffold

Create the Tauri v2 mobile app structure.

**Files:**
- Create: `apps/mobile/` (Tauri v2 mobile scaffold)

### Steps

- [ ] **Step 1: Check Tauri CLI version**

Run: `cd apps/desktop && bunx @tauri-apps/cli info`
Expected: Shows Tauri v2 CLI version

- [ ] **Step 2: Initialize Tauri mobile project**

Run: `mkdir -p apps/mobile && cd apps/mobile && bun create tauri-app . --template vue-ts --manager bun`

If the Tauri CLI scaffold doesn't support mobile directly, initialize manually:
- Copy `apps/desktop/package.json` as a starting point, strip unnecessary deps
- Create `src-tauri/` with mobile-specific Cargo.toml and config

- [ ] **Step 3: Configure for mobile**

Update `apps/mobile/src-tauri/tauri.conf.json`:
- Set `productName` to `Kanna Mobile`
- Set `identifier` to `com.kanna.mobile`
- Set mobile-specific settings

- [ ] **Step 4: Create Cargo.toml**

```toml
[package]
name = "kanna-mobile"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = ["wry"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
tokio-tungstenite = { version = "0.26", features = ["native-tls"] }
futures-util = "0.3"
log = "0.4"

[lib]
name = "kanna_mobile_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
```

- [ ] **Step 5: Create src-tauri/src/lib.rs**

```rust
mod commands;
mod relay_client;

use std::sync::Arc;
use tokio::sync::Mutex;

pub type RelaySink = Arc<Mutex<Option<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::Message,
>>>>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RelaySink::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_pipeline_items,
            commands::get_pipeline_item,
            commands::list_sessions,
            commands::attach_session,
            commands::detach_session,
            commands::send_input,
            commands::connect_relay,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 6: Create src-tauri/src/commands.rs**

Proxy commands that serialize to relay messages, send over WebSocket, and wait for response:

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, oneshot};
use serde_json::Value;

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

// Pending request map: id → oneshot sender
pub type PendingRequests = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

#[tauri::command]
pub async fn list_pipeline_items(
    relay: tauri::State<'_, crate::RelaySink>,
    pending: tauri::State<'_, PendingRequests>,
    repo_id: String,
) -> Result<Value, String> {
    invoke_remote(&relay, &pending, "list_pipeline_items", serde_json::json!({"repo_id": repo_id})).await
}

#[tauri::command]
pub async fn get_pipeline_item(
    relay: tauri::State<'_, crate::RelaySink>,
    pending: tauri::State<'_, PendingRequests>,
    id: String,
) -> Result<Value, String> {
    invoke_remote(&relay, &pending, "get_pipeline_item", serde_json::json!({"id": id})).await
}

#[tauri::command]
pub async fn list_sessions(
    relay: tauri::State<'_, crate::RelaySink>,
    pending: tauri::State<'_, PendingRequests>,
) -> Result<Value, String> {
    invoke_remote(&relay, &pending, "list_sessions", serde_json::json!({})).await
}

#[tauri::command]
pub async fn attach_session(
    relay: tauri::State<'_, crate::RelaySink>,
    pending: tauri::State<'_, PendingRequests>,
    session_id: String,
) -> Result<Value, String> {
    invoke_remote(&relay, &pending, "attach_session", serde_json::json!({"session_id": session_id})).await
}

#[tauri::command]
pub async fn detach_session(
    relay: tauri::State<'_, crate::RelaySink>,
    pending: tauri::State<'_, PendingRequests>,
    session_id: String,
) -> Result<Value, String> {
    invoke_remote(&relay, &pending, "detach_session", serde_json::json!({"session_id": session_id})).await
}

#[tauri::command]
pub async fn send_input(
    relay: tauri::State<'_, crate::RelaySink>,
    pending: tauri::State<'_, PendingRequests>,
    session_id: String,
    data: Vec<u8>,
) -> Result<Value, String> {
    invoke_remote(&relay, &pending, "send_input", serde_json::json!({"session_id": session_id, "data": data})).await
}

#[tauri::command]
pub async fn connect_relay(
    app: tauri::AppHandle,
    relay: tauri::State<'_, crate::RelaySink>,
    pending: tauri::State<'_, PendingRequests>,
    relay_url: String,
    id_token: String,
) -> Result<(), String> {
    // Connect to relay, authenticate, spawn reader task
    // Reader task routes responses to pending requests and events to Tauri events
    crate::relay_client::connect(&app, &relay, &pending, &relay_url, &id_token).await
}

async fn invoke_remote(
    relay: &crate::RelaySink,
    pending: &PendingRequests,
    command: &str,
    args: Value,
) -> Result<Value, String> {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;

    let id = REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();

    pending.lock().await.insert(id, tx);

    let msg = serde_json::json!({
        "type": "invoke",
        "id": id,
        "command": command,
        "args": args,
    });

    let mut sink = relay.lock().await;
    let sink = sink.as_mut().ok_or("Not connected to relay")?;
    sink.send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
        .await
        .map_err(|e| format!("Send failed: {}", e))?;
    drop(sink);

    rx.await.map_err(|_| "Request cancelled".to_string())?
}
```

- [ ] **Step 7: Create src-tauri/src/relay_client.rs**

```rust
use crate::commands::PendingRequests;
use crate::RelaySink;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub async fn connect(
    app: &tauri::AppHandle,
    relay: &RelaySink,
    pending: &PendingRequests,
    relay_url: &str,
    id_token: &str,
) -> Result<(), String> {
    let (ws_stream, _) = connect_async(relay_url).await
        .map_err(|e| format!("WebSocket connection failed: {}", e))?;

    let (mut sink, mut stream) = ws_stream.split();

    // Authenticate
    let auth_msg = serde_json::json!({
        "type": "auth",
        "id_token": id_token,
    });
    sink.send(Message::Text(serde_json::to_string(&auth_msg).unwrap().into()))
        .await
        .map_err(|e| format!("Auth send failed: {}", e))?;

    // Wait for auth_ok
    if let Some(Ok(Message::Text(text))) = stream.next().await {
        let msg: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid auth response: {}", e))?;
        if msg.get("type").and_then(|v| v.as_str()) != Some("auth_ok") {
            return Err("Authentication failed".to_string());
        }
    } else {
        return Err("No auth response".to_string());
    }

    // Store sink
    *relay.lock().await = Some(sink);

    // Spawn reader task
    let pending_clone = pending.inner().clone();
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                        match parsed.get("type").and_then(|v| v.as_str()) {
                            Some("response") => {
                                if let Some(id) = parsed.get("id").and_then(|v| v.as_u64()) {
                                    if let Some(tx) = pending_clone.lock().await.remove(&id) {
                                        let result = if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                                            Err(err.to_string())
                                        } else {
                                            Ok(parsed.get("data").cloned().unwrap_or(serde_json::Value::Null))
                                        };
                                        let _ = tx.send(result);
                                    }
                                }
                            }
                            Some("event") => {
                                if let (Some(name), Some(payload)) = (
                                    parsed.get("name").and_then(|v| v.as_str()),
                                    parsed.get("payload"),
                                ) {
                                    let _ = app_clone.emit(name, payload.clone());
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Err(_) => break,
                _ => {}
            }
        }
    });

    Ok(())
}
```

- [ ] **Step 8: Symlink or configure shared frontend**

The mobile app needs the same Vue source. Options:
- Symlink `apps/mobile/src` → `apps/desktop/src`
- Or configure Vite to read from `apps/desktop/src`

Create `apps/mobile/vite.config.ts` pointing to the desktop source.

- [ ] **Step 9: Verify mobile Rust compiles**

Run: `cd apps/mobile/src-tauri && cargo check`
Expected: Compiles (may need Tauri mobile targets configured)

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/
git commit -m "feat(mobile): scaffold Tauri v2 mobile app with relay proxy commands"
```

---

## Task 9: DB Access Abstraction

Create a platform-aware DB layer so the shared frontend works on both desktop and mobile.

**Files:**
- Create: `packages/db/src/remote-db.ts`
- Modify: `apps/desktop/src/stores/db.ts`

### Steps

- [ ] **Step 1: Create remote-db.ts**

A `DbHandle` implementation that routes queries through `invoke`:

```typescript
import type { DbHandle } from './queries';

/**
 * Remote DB handle that routes SQL queries through Tauri invoke
 * to kanna-server via the relay. Used on mobile where there's
 * no local SQLite database.
 */
export function createRemoteDbHandle(invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>): DbHandle {
  return {
    async execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }> {
      const result = await invoke('db_execute', { query, bind_values: bindValues ?? [] });
      return result as { rowsAffected: number };
    },
    async select<T>(query: string, bindValues?: unknown[]): Promise<T[]> {
      const result = await invoke('db_select', { query, bind_values: bindValues ?? [] });
      return result as T[];
    },
  };
}
```

Note: This requires adding `db_execute` and `db_select` commands to kanna-server. For v1 read-only scope, only `db_select` is needed.

- [ ] **Step 2: Add db_select to kanna-server commands**

In `crates/kanna-server/src/commands.rs`, add:

```rust
"db_select" => {
    let query = args.get("query")
        .and_then(|v| v.as_str())
        .ok_or("missing query")?;
    let bind_values = args.get("bind_values")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let results = db.select_raw(query, &bind_values).map_err(|e| e.to_string())?;
    Ok(results)
}
```

Add `select_raw` to `crates/kanna-server/src/db.rs`:

```rust
pub fn select_raw(&self, query: &str, bind_values: &[serde_json::Value]) -> Result<serde_json::Value, rusqlite::Error> {
    // Security: reject non-SELECT queries — this endpoint is exposed over the network via relay
    let trimmed = query.trim_start().to_uppercase();
    if !trimmed.starts_with("SELECT") {
        return Err(rusqlite::Error::InvalidParameterName("Only SELECT queries are allowed".to_string()));
    }

    let mut stmt = self.conn.prepare(query)?;
    let column_count = stmt.column_count();
    let column_names: Vec<String> = (0..column_count)
        .map(|i| stmt.column_name(i).unwrap().to_string())
        .collect();

    let params: Vec<Box<dyn rusqlite::types::ToSql>> = bind_values.iter().map(|v| {
        match v {
            serde_json::Value::String(s) => Box::new(s.clone()) as Box<dyn rusqlite::types::ToSql>,
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Box::new(i)
                } else {
                    Box::new(n.as_f64().unwrap_or(0.0))
                }
            }
            serde_json::Value::Null => Box::new(rusqlite::types::Null),
            _ => Box::new(v.to_string()),
        }
    }).collect();

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows: Vec<serde_json::Value> = stmt.query_map(param_refs.as_slice(), |row| {
        let mut obj = serde_json::Map::new();
        for (i, name) in column_names.iter().enumerate() {
            let val: rusqlite::types::Value = row.get(i)?;
            let json_val = match val {
                rusqlite::types::Value::Null => serde_json::Value::Null,
                rusqlite::types::Value::Integer(i) => serde_json::Value::Number(i.into()),
                rusqlite::types::Value::Real(f) => serde_json::json!(f),
                rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
                rusqlite::types::Value::Blob(b) => serde_json::Value::String(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &b)),
            };
            obj.insert(name.clone(), json_val);
        }
        Ok(serde_json::Value::Object(obj))
    })?.collect::<Result<Vec<_>, _>>()?;

    Ok(serde_json::Value::Array(rows))
}
```

- [ ] **Step 3: Update store db initialization**

Read `apps/desktop/src/stores/db.ts` to understand current DB init, then add platform detection:

```typescript
import { createRemoteDbHandle } from '@kanna/db/remote-db';
import { invoke } from '../invoke';

export async function createDbHandle(): Promise<DbHandle> {
  // Mobile: use remote DB through relay
  if (window.__KANNA_MOBILE__) {
    return createRemoteDbHandle(invoke);
  }

  // Desktop: use local SQLite
  // ... existing tauri-plugin-sql initialization
}
```

The `__KANNA_MOBILE__` flag would be set by the mobile app's index.html or Vite config.

- [ ] **Step 4: Verify packages/db compiles**

Run: `cd packages/db && bun run build` (or `bun tsc --noEmit` if no build script)
Expected: Compiles

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/remote-db.ts crates/kanna-server/src/db.rs crates/kanna-server/src/commands.rs
git commit -m "feat(db): add remote DB handle for mobile and raw query support in kanna-server"
```

---

## Task 10: Integration Test — End-to-End Message Flow

Test the full path: kanna-server ↔ relay ↔ simulated phone client.

**Files:**
- Create: `services/relay/test/integration.test.ts`

### Steps

- [ ] **Step 1: Create integration test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { WebSocket } from 'ws';

const RELAY_URL = 'ws://localhost:8080';
let relayProcess: any;

// This test requires:
// 1. Relay running locally: cd services/relay && bun run dev
// 2. A test device token in Firestore (or mock auth)

describe('Relay message routing', () => {
  it('should route invoke from phone to server and response back', (done) => {
    // Simulate server connection
    const server = new WebSocket(RELAY_URL);
    server.on('open', () => {
      server.send(JSON.stringify({ type: 'auth', device_token: 'test-token' }));
    });

    server.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'auth_ok') {
        // Now connect as phone
        const phone = new WebSocket(RELAY_URL);
        phone.on('open', () => {
          phone.send(JSON.stringify({ type: 'auth', id_token: 'test-firebase-token' }));
        });

        phone.on('message', (data: Buffer) => {
          const phoneMsg = JSON.parse(data.toString());
          if (phoneMsg.type === 'auth_ok') {
            // Send invoke
            phone.send(JSON.stringify({
              type: 'invoke',
              id: 1,
              command: 'list_sessions',
              args: {},
            }));
          } else if (phoneMsg.type === 'response') {
            expect(phoneMsg.id).toBe(1);
            expect(phoneMsg.data).toBe('echoed');
            phone.close();
            server.close();
            done();
          }
        });
      } else if (msg.type === 'invoke') {
        // Server receives invoke, sends response
        server.send(JSON.stringify({
          type: 'response',
          id: msg.id,
          data: 'echoed',
        }));
      }
    });
  });
});
```

Note: This test needs mock auth or a test Firebase project. For local development, add a `SKIP_AUTH=true` env var to the relay that bypasses token verification.

- [ ] **Step 2: Add SKIP_AUTH mode to relay**

In `services/relay/src/auth.ts`, add:

```typescript
const SKIP_AUTH = process.env.SKIP_AUTH === 'true';

export async function verifyPhoneToken(idToken: string): Promise<string | null> {
  if (SKIP_AUTH) return 'test-user';
  // ... existing implementation
}

export async function verifyDeviceToken(deviceToken: string): Promise<string | null> {
  if (SKIP_AUTH) return 'test-user';
  // ... existing implementation
}
```

- [ ] **Step 3: Run integration test**

Run: `cd services/relay && SKIP_AUTH=true bun run dev &` then `bun test test/integration.test.ts`
Expected: Test passes

- [ ] **Step 4: Commit**

```bash
git add services/relay/
git commit -m "test(relay): add integration test with SKIP_AUTH mode"
```

---

## Dependencies

```
Task 1 (Daemon Observe) ← Task 5 (Terminal Streaming)
Task 2 (kanna-server scaffold) ← Task 3 (DB + Commands) ← Task 4 (Relay Client) ← Task 5 (Terminal Streaming)
Task 2 ← Task 6 (Registration)
Task 7 (Relay Service) — independent
Task 8 (Mobile App) — depends on relay protocol being defined (Task 7)
Task 9 (DB Abstraction) — depends on Task 3
Task 10 (Integration Test) — depends on Tasks 4, 5, 7
```

Parallelizable: Tasks 1 + 7 can run in parallel. Task 8 can start after Task 7.
