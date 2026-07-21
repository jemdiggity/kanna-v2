# kanna-daemon Specification

## Purpose

kanna-daemon manages persistent PTY sessions for Claude CLI agents. It runs as a standalone process, independent of the Tauri app lifecycle, so terminal sessions survive app restarts and upgrades.

## Invariants

1. **One daemon at a time.** Only one daemon process owns the socket. A new daemon always replaces the old one.
2. **Always handoff.** When a new daemon starts and an old one is running, the new daemon takes over all live sessions via fd transfer. The old daemon exits.
3. **Always spawn on first startup. Reconnect (don't spawn) on daemon restart. Spawn again only if reconnect backoff is exhausted (daemon crash recovery).**
4. **Sessions survive upgrades.** Child processes (Claude CLI) are unaware of daemon restarts. Their PTY connections are preserved through fd transfer.
5. **One reader per session.** Each PTY session has exactly one `stream_output` task. Newly spawned sessions start it immediately so detached output is captured by the headless terminal. Adopted handoff sessions start it on first `AttachSnapshot`.
6. **Headless terminal is authoritative while detached.** PTY bytes are always consumed by `stream_output` and applied to the per-session headless terminal. There is no raw pre-attach byte replay buffer.
7. **AttachSnapshot is the only frontend attach path.** It atomically sends the current headless terminal snapshot, adds the connection to the live writer list, and then streams future output.
8. **Multiple clients per session.** Attached clients receive output via broadcast. Smallest terminal dimensions are used for the PTY.
9. **Always broadcast.** Before exiting during handoff, the old daemon broadcasts `ShuttingDown` to all subscribers.
10. **Always reconnect.** Apps detect daemon restart (via `ShuttingDown` or EOF) and automatically reconnect + re-attach all tracked sessions.

## Startup Sequence

Every daemon startup follows this sequence:

```
1. Read PID file
2. If old daemon alive:
   a. Connect to old daemon's socket
   b. Send Handoff{version}
   c. Receive HandoffReady{sessions} + master fds (SCM_RIGHTS)
   d. Adopt sessions from transferred fds
   e. Wait for old daemon to exit (SIGTERM/SIGKILL if stuck)
3. Write our PID file
4. Bind socket (removes stale socket file first)
5. Accept connections
```

If handoff fails at any step, the new daemon kills the old one and starts fresh. Sessions from the old daemon are lost — this is acceptable as a fallback.

## Session Lifecycle

```
             App creates task
                    │
                    ▼
    Spawn ──► PTY created, session stored, stream_output starts
                    │
                    ▼
    PTY output ──► stream_output ──► headless terminal + live writers
                    │
                    ▼
    AttachSnapshot ──► send headless snapshot, add writer to list
                    │
                    ▼
              Resize updates effective PTY dimensions
                    │
                    ▼
              Output flows: PTY → stream_output → broadcast → all clients
                    │
              ┌─────┴──────┐
              ▼             ▼
    Tab switch away    Process exits
              │             │
              ▼             ▼
    Detach (remove from writer list)   Exit event sent, session removed
              │
              ▼
    Tab switch back
              │
              ▼
    AttachSnapshot (reattach) ──► snapshot + live stream
```

## Reconnection

The daemon does **not** buffer raw scrollback. Reconnection uses the headless terminal snapshot:

1. Client sends `AttachSnapshot`
2. Daemon ensures the session has one `stream_output` reader
3. Daemon snapshots the headless terminal and adds the client to the writer broadcast list
4. Client hydrates xterm.js from the snapshot and sends `Resize`
5. Future PTY output streams live to the client

**Why no raw scrollback buffer:** Claude's TUI uses absolute cursor positioning and full-screen rendering. Raw byte replay can resurrect overwritten output and garble state. The headless terminal is the single detached-state copy; xterm.js is hydrated from that state on attach.

## Handoff Protocol

### Version

Both sides must agree on `HANDOFF_VERSION` (currently `1`). Mismatched versions are rejected.

### Sequence

```
New daemon                              Old daemon
    │                                        │
    ├──► {"type":"Handoff","version":1} ────►│
    │                                        ├── lock SessionManager
    │                                        ├── for each live session:
    │                                        │     detach_for_handoff() → extract fd
    │                                        ├── clear SessionWriters
    │◄── {"type":"HandoffReady",       ◄─────┤
    │      "sessions":[...]}                 │
    │◄── [SCM_RIGHTS: master fds]      ◄─────┤
    │                                        ├── close fd copies
    │                                        ├── exit(0)
    ├── for each (info, fd):                 ✗
    │     PtySession::adopt(fd, pid, cwd)
    │     insert into SessionManager
    ├── bind socket
    ├── ready
```

### FD Transfer (SCM_RIGHTS)

File descriptors are sent as ancillary data on the Unix socket using `sendmsg`/`recvmsg` with `SOL_SOCKET`/`SCM_RIGHTS`. The kernel maps fd numbers into the receiving process's fd table. One dummy byte is sent as the required payload.

The fds are sent in the same order as the sessions in `HandoffReady`. The receiver zips them by index.

### Adopted Sessions

Adopted sessions differ from spawned sessions:
- The daemon did **not** fork the child process, so `waitpid()` won't work
- Liveness is checked via `kill(pid, 0)` (returns 0 if alive)
- The master fd was received via SCM_RIGHTS, wrapped in `OwnedFd`
- No `stream_output` task is running — it starts on first `AttachSnapshot`

## Protocol Reference

Line-delimited JSON over Unix domain socket. Each message is one JSON object + `\n`.

### Commands (client → daemon)

| Command | Fields | Description |
|---------|--------|-------------|
| `Spawn` | session_id, executable, args, cwd, env, cols, rows | Create PTY session |
| `AttachSnapshot` | session_id, emulate_terminal | Snapshot current headless terminal and start/resume live output |
| `ObserveSnapshot` | session_id | Atomically snapshot and register a passive observer; the `Snapshot` event is the reply and every later `Output` is ordered after it |
| `Detach` | session_id | Stop receiving output |
| `Input` | session_id, data (byte array) | Send keystrokes to PTY |
| `Resize` | session_id, cols, rows | Update terminal dimensions |
| `Signal` | session_id, signal (string) | Send Unix signal |
| `Kill` | session_id | Terminate and remove session |
| `List` | — | List all sessions |
| `Handoff` | version (u32) | Request session transfer |

### Events (daemon → client)

| Event | Fields | Description |
|-------|--------|-------------|
| `Ok` | — | Command acknowledged |
| `Error` | message | Command failed |
| `Output` | session_id, data (byte array) | PTY output |
| `Exit` | session_id, code | Process exited |
| `SessionCreated` | session_id | New session ready |
| `SessionList` | sessions | Response to List |
| `HandoffReady` | sessions | Session metadata (followed by SCM_RIGHTS) |
| `ShuttingDown` | — | Daemon shutting down (handoff) |

## Logging

The daemon logs to both stderr and a per-process log file using `flexi_logger` with the standard `log` crate macros.

**Log file location:** `{KANNA_DAEMON_DIR}/kanna-daemon_{discriminant}.log`

Default: `~/Library/Application Support/Kanna/kanna-daemon_{pid}.log`

**Log level:** Controlled by `RUST_LOG` env var. Defaults to `info`.

| Level | Usage |
|-------|-------|
| `error` | PTY read failures, accept errors |
| `info` | Startup, shutdown, handoff progress, session adoption |
| `debug` | Detailed protocol tracing (when `RUST_LOG=debug`) |

Logs are written to both destinations simultaneously — the file for tooling/debugging, stderr for the dev terminal running `bun tauri dev`.

## Configuration

| Env Var | Description | Default |
|---------|-------------|---------|
| `KANNA_DAEMON_DIR` | Data directory (socket, PID, log files) | `~/Library/Application Support/Kanna` |
| `RUST_LOG` | Log level filter | `info` |

## Benchmarks

Local daemon benchmark usage and the current synthetic benchmark baseline are
documented in [`BENCHMARKS.md`](./BENCHMARKS.md).

## Dev Workflow

`bun tauri dev` executes:

1. `cargo build -p kanna-daemon` — rebuild daemon binary
2. `vite` — start frontend dev server
3. Tauri builds and starts the app
4. App calls `ensure_daemon_running()` — always spawns new daemon
5. New daemon performs handoff from old daemon (if running)
6. Claude sessions continue uninterrupted

The daemon binary at `crates/daemon/target/debug/kanna-daemon` is always the latest build. The app always spawns it, and the handoff ensures zero-downtime upgrades during development.
