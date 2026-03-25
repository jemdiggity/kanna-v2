# kanna-daemon Specification

## Purpose

kanna-daemon manages persistent PTY sessions for Claude CLI agents. It runs as a standalone process, independent of the Tauri app lifecycle, so terminal sessions survive app restarts and upgrades.

## Invariants

1. **One daemon at a time.** Only one daemon process owns the socket. A new daemon always replaces the old one.
2. **Always handoff.** When a new daemon starts and an old one is running, the new daemon takes over all live sessions via fd transfer. The old daemon exits.
3. **Always spawn on first startup. Reconnect (don't spawn) on daemon restart. Spawn again only if reconnect backoff is exhausted (daemon crash recovery).**
4. **Sessions survive upgrades.** Child processes (Claude CLI) are unaware of daemon restarts. Their PTY connections are preserved through fd transfer.
5. **One reader per session.** Each PTY session has exactly one `stream_output` task. It is created on the first `Attach` and runs for the session's lifetime. Still one reader per session, but output is broadcast to all attached writers.
6. **Multiple clients per session.** Attach adds to writer list. All attached clients receive output via broadcast. Smallest terminal dimensions are used for the PTY.
7. **Always broadcast.** Before exiting during handoff, the old daemon broadcasts `ShuttingDown` to all subscribers.
8. **Always reconnect.** Apps detect daemon restart (via `ShuttingDown` or EOF) and automatically reconnect + re-attach all tracked sessions.

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
    Spawn ──► PTY created, session stored
                    │
                    ▼
    Attach ──► first: clone reader, start stream_output, add to writer list
               reattach: add writer to list, send resize (SIGWINCH)
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
    Attach (reattach) ──► add writer to list, resize → Claude redraws
```

## Reconnection

The daemon does **not** buffer scrollback. Reconnection relies on Claude CLI's TUI redrawing on SIGWINCH:

1. Client sends `Attach` (reattach path — session already has a reader)
2. Daemon swaps the `ActiveWriter` to the new connection
3. Client sends `Resize` with current terminal dimensions
4. Daemon calls `ioctl(TIOCSWINSZ)` which delivers SIGWINCH to the child
5. Claude CLI (ink/React) re-renders its entire component tree
6. Client sees the full, correct terminal state

**Why no scrollback buffer:** Claude's TUI uses absolute cursor positioning and full-screen rendering. Raw byte replay produces garbled output. A resize-triggered redraw produces perfect output. The trade-off is a brief blank terminal (~50-100ms) between attach and redraw.

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
- No `stream_output` task is running — it starts on first `Attach`

## Protocol Reference

Line-delimited JSON over Unix domain socket. Each message is one JSON object + `\n`.

### Commands (client → daemon)

| Command | Fields | Description |
|---------|--------|-------------|
| `Spawn` | session_id, executable, args, cwd, env, cols, rows | Create PTY session |
| `Attach` | session_id | Start/resume receiving output |
| `Detach` | session_id | Stop receiving output |
| `Input` | session_id, data (byte array) | Send keystrokes to PTY |
| `Resize` | session_id, cols, rows | Update terminal dimensions |
| `Signal` | session_id, signal (string) | Send Unix signal |
| `Kill` | session_id | Terminate and remove session |
| `List` | — | List all sessions |
| `Subscribe` | — | Opt into hook event broadcast |
| `Handoff` | version (u32) | Request session transfer |
| `HookEvent` | session_id, event, data | Broadcast hook event |

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
| `HookEvent` | session_id, event, data | Broadcast hook event |
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

## Dev Workflow

`bun tauri dev` executes:

1. `cargo build -p kanna-daemon` — rebuild daemon binary
2. `cargo build -p kanna-hook` — rebuild hook binary
3. `vite` — start frontend dev server
4. Tauri builds and starts the app
5. App calls `ensure_daemon_running()` — always spawns new daemon
6. New daemon performs handoff from old daemon (if running)
7. Claude sessions continue uninterrupted

The daemon binary at `crates/daemon/target/debug/kanna-daemon` is always the latest build. The app always spawns it, and the handoff ensures zero-downtime upgrades during development.
