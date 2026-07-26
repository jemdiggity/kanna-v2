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
   b. Request transactional handoff v3
   c. Only after an explicit version mismatch, reconnect and request legacy v2
   d. Receive HandoffReady{sessions} + session fds (SCM_RIGHTS)
   e. Authenticate the peer and validate the descriptor transfer
   f. Send HandoffAdopted{version} to commit the transfer
   g. Wait for the old daemon to release its readers and exit
   h. Adopt sessions from the transferred fds
3. Write our PID file
4. Bind socket (removes stale socket file first)
5. Accept connections
```

An ambiguous failure never triggers a version fallback and never permits the
new daemon to publish alongside a live incumbent. The newcomer exits instead.
After an acknowledged transfer, only an authenticated, identity-pinned
incumbent may be terminated if it fails to exit.

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

Handoff versions identify guarantee epochs:

- **v3 (`HANDOFF_PROTOCOL_VERSION`)** — transactional handoff. The sender
  seals PTY and agent lifecycle mutation around an exact snapshot, keeps
  descriptor copies alive through acknowledgement, and treats
  `HandoffAdopted { version: 3 }` as the commit point.
- **v2 (`LEGACY_HANDOFF_PROTOCOL_VERSION`)** — the deployed pre-transaction
  protocol, retained only so existing live sessions survive the upgrade to
  v3. Stable PTYs and agent state transfer, but Spawn/Kill operations racing
  the old v2 snapshot have unspecified ordering.

A current adopter requests v3 first. It makes exactly one v2 attempt only when
the incumbent returns an explicit handoff-version-mismatch error before any
transfer. Timeouts, disconnects, malformed responses, partial descriptor
transfers, and all other ambiguous failures are fail-closed. Version 1 is not
supported.

A current sender accepts both versions. It still applies its hardened seal and
descriptor ownership when a deployed v2 adopter requests v2.

### Sequence

```
New daemon                              Old daemon
    │                                        │
    ├──► {"type":"Handoff","version":3} ────►│
    │                                        ├── seal PTY + agent registries
    │                                        ├── snapshot exact incarnations
    │                                        ├── duplicate owned session fds
    │◄── {"type":"HandoffReady",       ◄─────┤
    │      "sessions":[...]}                 │
    │◄── [SCM_RIGHTS: session fds]     ◄─────┤
    ├── authenticate peer + transfer shape   │
    ├──► {"type":"HandoffAdopted",      ────►│
    │      "version":3}                      ├── stop old readers
    │                                        ├── broadcast ShuttingDown
    │                                        ├── close fd copies + exit
    ├── wait for authenticated old daemon ───┤
    ├── authenticate per-session provenance  ✗
    ├── adopt PTYs + live/resumable agents
    ├── bind socket
    ├── ready
```

Before the acknowledgement, the adopter pins the daemon process identity,
checks Unix-socket peer credentials, validates every metadata-declared FD
count, rejects truncated or extra ancillary data, and rechecks the pinned peer.
During adoption, the transferred descriptor is the authority:

- A PTY leader gets signal authority only when the claimed live process is on
  the slave terminal derived from the transferred master. Otherwise the PTY
  remains usable but non-signalable.
- A live agent pipe bundle is accepted only when every stdout, stderr, and
  optional stdin descriptor has the expected direction and is bound to the
  claimed child. Otherwise the descriptors are closed and the logical agent
  session remains resumable from its journal.

The same receiver checks apply in legacy-v2 mode. They prevent forged
descriptor authority, but they cannot reconstruct the lifecycle seal absent
from a deployed v2 sender.

### Cross-version verification

The integration suite builds the daemon from the fixed shipped-v2 tag and
exercises both binary pairings. In the v2-sender → current-adopter case, a
test-only adopter delay opens a deterministic post-transfer/pre-ACK window;
the harness requires a complete PTY Spawn/Kill and agent Spawn/Kill cycle to
succeed against the deployed sender during that window, then verifies that
stable PTY and agent sessions remain usable after adoption. The reverse
current-sender → v2-adopter case verifies that the hardened sender's retained
v2 wire path transfers live PTY and agent descriptors end to end.

### FD Transfer (SCM_RIGHTS)

File descriptors are sent as ancillary data on the Unix socket using `sendmsg`/`recvmsg` with `SOL_SOCKET`/`SCM_RIGHTS`. The kernel maps fd numbers into the receiving process's fd table. One dummy byte is sent as the required payload.

The fds are sent in the same order as the sessions in `HandoffReady`. A PTY
session contributes one master fd. An agent session contributes zero fds for
an exited/resumable child or two/three fds for stdout, stderr, and optional
stdin. Any other shape is rejected.

### Adopted Sessions

Adopted sessions differ from spawned sessions:
- The daemon did **not** fork the child process, so `waitpid()` won't work
- The master fd was received via SCM_RIGHTS, wrapped in `OwnedFd`
- Signal authority comes from descriptor provenance, never sender-provided pid
  metadata alone
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
