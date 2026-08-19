# kanna-daemon Specification

## Purpose

kanna-daemon manages persistent PTY sessions for Claude CLI agents. It runs as a standalone process, independent of the Tauri app lifecycle, so terminal sessions survive app restarts and upgrades.

## Invariants

1. **One daemon at a time.** Only one daemon process owns the socket. A new daemon always replaces the old one.
2. **Always handoff.** When a new daemon starts and an old one is running, the new daemon takes over all live sessions via fd transfer. The old daemon exits.
3. **Always spawn on first startup. Reconnect (don't spawn) on daemon restart. Spawn again only if reconnect backoff is exhausted (daemon crash recovery).**
4. **Sessions survive upgrades.** Child processes (Claude CLI) are unaware of daemon restarts. Their PTY connections are preserved through fd transfer.
5. **One reader per session.** Each PTY session has exactly one `stream_output` task. Newly spawned sessions start it immediately so detached output is captured by the headless terminal. Adopted handoff sessions start it immediately after the old-daemon release barrier.
6. **Headless terminal is authoritative while detached.** PTY bytes are always consumed by `stream_output` and applied to the per-session headless terminal. There is no raw pre-attach byte replay buffer.
7. **AttachSnapshot is the only frontend attach path.** It atomically sends the current headless terminal snapshot, adds the connection to the live writer list, and then streams future output.
8. **Multiple clients per session.** Attached clients receive output via broadcast. Smallest terminal dimensions are used for the PTY.
9. **Always broadcast.** Before exiting during handoff, the old daemon broadcasts `ShuttingDown` to all subscribers.
10. **Always reconnect.** Apps detect daemon restart (via `ShuttingDown` or EOF) and automatically reconnect + re-attach all tracked sessions.
11. **Authorize the successor before handoff state.** For every supported handoff version, the sender authenticates the peer as a daemon directly spawned by the trusted app-launcher executable before it acquires daemon-lifecycle ownership, seals a registry, snapshots a session, writes `HandoffReady`, or transfers a descriptor.

## Startup Sequence

Every daemon startup follows this sequence. Before step 1, while the spawning
app is still the daemon's live direct parent, the daemon captures its own
kernel-derived executable path and the parent's kernel-derived executable path.
The parent path remains the successor trust root after the app exits and the
daemon is reparented.

```
1. Read PID file
2. If old daemon alive:
   a. Connect to old daemon's socket
   b. Request transactional handoff v3
   c. Old daemon pins LOCAL_PEERPID + start identity and the peer's live
      direct-parent PID + start identity, matches their kernel executable
      paths to the recorded daemon and app-launcher paths, and rechecks them
   d. Only after an explicit version mismatch, reconnect and request legacy v2
      (the old daemon applies the same successor check)
   e. Only after successor authorization does the old daemon acquire lifecycle
      ownership and seal its registries
   f. Receive HandoffReady{sessions} + session fds (SCM_RIGHTS)
   g. Authenticate the old-daemon peer and validate the descriptor transfer
   h. Send HandoffAdopted{version} to commit the transfer
   i. Wait for EOF on the dedicated handoff connection, proving that the old daemon released its readers
   j. Adopt sessions from the transferred fds
3. Write our PID file
4. Bind socket (removes stale socket file first)
5. Accept connections
```

An ambiguous failure never triggers a version fallback and never permits the
new daemon to publish alongside a live incumbent. The newcomer exits instead.
After an acknowledged transfer, only an authenticated, identity-pinned
incumbent may be terminated if it fails to exit.

If the incumbent accepts the connection but does not answer before the
handoff deadline, the successor records the timeout in the stable lifecycle
audit, exits non-zero, and leaves the incumbent's pid file, socket, and
sessions untouched. A timeout is not evidence that any session was lost.

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
  the old v2 snapshot have unspecified ordering. A v2 transfer is refused if
  either side can see an explicitly protected-input session; protected PTYs
  may move only through v3.

A current adopter requests v3 first. It makes exactly one v2 attempt only when
the incumbent returns an explicit handoff-version-mismatch error before any
transfer. Timeouts, disconnects, malformed responses, partial descriptor
transfers, and all other ambiguous failures are fail-closed. Version 1 is not
supported.

A current sender accepts both versions for lineages without protected PTYs. It
still applies its hardened seal and descriptor ownership when a deployed v2
adopter requests v2.

### Sequence

```
New daemon                              Old daemon
    │                                        │
    ├──► {"type":"Handoff","version":3} ────►│
    │                                        ├── authenticate peer + parent
    │                                        ├── final identity/path recheck
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
    ├── wait for handoff connection EOF ─────┤
    ├── authenticate per-session provenance  ✗
    ├── adopt PTYs + live/resumable agents
    ├── bind socket
    ├── ready
```

### Successor Authorization

The Unix socket is a public local command surface, not a handoff capability.
For both supported handoff modes, the sending daemon authorizes the connected
process before entering the transactional lifecycle boundary:

- `LOCAL_PEERPID` identifies and pins the successor PID/start identity.
- The successor's live direct-parent PID/start identity is pinned.
- The successor executable path must equal the sender's kernel-derived daemon
  path captured at startup.
- The direct-parent executable path must equal the trusted app-launcher path
  captured when the sender itself started.
- Both identities, the direct-parent relationship, and both executable paths
  are re-read immediately before authorization succeeds.

Any missing or changed identity or path is refused with
`handoff_unauthorized`. Refusal occurs before the daemon-lifecycle write guard,
registry seals, snapshots, `HandoffReady`, and `SCM_RIGHTS`. Unsupported
versions retain the metadata-free version-mismatch response.

The wire request is unchanged. Installed releases and kd worktrees launch
successive daemon versions from stable instance-local executable paths, so
rolling and development upgrades keep sessions alive. Starting a replacement
from an unrelated shell or helper is intentionally unauthorized.

Before the acknowledgement, the adopter pins the daemon process identity,
checks Unix-socket peer credentials, validates every metadata-declared FD
count, rejects truncated or extra ancillary data, and rechecks the pinned peer.
After the acknowledgement, it waits for EOF on the dedicated handoff
connection before starting adopted readers. If the release deadline expires,
only that exact authenticated process identity may be terminated; failure to
prove release remains fail-closed.
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
- `stream_output` starts immediately after the old-daemon release barrier, so
  detached status and recovery state remain authoritative before first attach

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
| `InputIfSession` | session_id, expected_pid, data (byte array) | Send acknowledged keystrokes only if the id still names the PTY process ID observed by `List`; otherwise return `session_incarnation_mismatch` without writing |
| `Resize` | session_id, cols, rows | Update terminal dimensions |
| `Signal` | session_id, signal (string) | Send Unix signal |
| `Kill` | session_id | Terminate and remove session |
| `List` | — | List all sessions, each with `logical_input_blocked` |
| `Handoff` | version (u32) | Request session transfer |

### Events (daemon → client)

| Event | Fields | Description |
|-------|--------|-------------|
| `Ok` | — | Command acknowledged |
| `Error` | message, code | Command failed. `logical_input_held_by_draft` means the message is queued behind a human's unsent line and was not submitted |
| `Output` | session_id, data (byte array) | PTY output |
| `Exit` | session_id, code | Process exited |
| `SessionCreated` | session_id | New session ready |
| `InputBlockedChanged` | session_id, logical_input_blocked | Session started or stopped refusing logical input |
| `SessionList` | sessions | Response to List |
| `HandoffReady` | sessions | Session metadata (followed by SCM_RIGHTS) |
| `ShuttingDown` | — | Daemon shutting down (handoff) |

## Logging

The daemon logs to both stderr and a per-process log file using `flexi_logger` with the standard `log` crate macros.

**Per-process log location:**
`{KANNA_DAEMON_DIR}/kanna-daemon_{pid}_{timestamp}.log`

Default:
`~/Library/Application Support/Kanna/kanna-daemon_{pid}_{timestamp}.log`

The current published daemon also owns the
`{KANNA_DAEMON_DIR}/kanna-daemon.log` symlink. A replacement does not update
that link until it has adopted sessions and published its pid file and socket,
so a failed successor cannot hide the incumbent's active log.

Startup and handoff decisions are additionally appended to
`{KANNA_DAEMON_DIR}/kanna-daemon-lifecycle.log`. This path is stable across
process generations and does not depend on the `log`/`flexi_logger`
initialization path. It records logger initialization failures, authorization,
the exact transferred session ids, commit/rollback, timeout, publication, and
SIGTERM teardown. It is the first diagnostic to inspect when a per-process log
is absent.

**Log level:** Controlled by `RUST_LOG` env var. Defaults to `info`.

| Level | Usage |
|-------|-------|
| `error` | PTY read failures, accept errors |
| `info` | Startup, shutdown, handoff progress, session adoption |
| `debug` | Detailed protocol tracing (when `RUST_LOG=debug`) |

Normal logs are timestamped and written to both destinations simultaneously —
the file for tooling/debugging, stderr for the dev terminal started by `kd`.
Failure to initialize the normal logger is recorded in the lifecycle audit
instead of being discarded.

## Configuration

New PTYs, including merge singletons, use ordinary input. The
`operator_input_only` field and `OperatorInput` command remain as wire and
handoff compatibility for a protected session created by the previous
release; the server clears that retired classification after every daemon
generation. `SystemInput` remains as wire compatibility for those inherited
protected sessions; current merge requests use ordinary `Input`. Initial concurrent
startup admits only the exact server executable when it is a direct child of
the pinned desktop, then pins that process by PID and start time. For a server
surviving desktop restart, the newly authenticated desktop explicitly hands
the server's live process identity to the daemon. Neither path uses a bearer
credential, and another process running the same binary is refused.
Before serving HTTP, the authenticated server classifies inherited PTYs as
ordinary input, including merge singletons adopted from a protected release.
The same replay runs after daemon replacement so restart and handoff cannot
restore the retired native-terminal-only merge policy.
`NegotiateProtectedInput` version 3 must be acknowledged by the active daemon
before the server exposes HTTP/relay or creates a merge PTY. Version 2 includes
the observed-PTY-process-ID `InputIfSession` fence; version 3 adds daemon-owned
logical input coordination. `SubmitInput` accepts a complete logical message,
keeps it out of the PTY while an explicitly declared raw draft is active, then
writes the message and its delayed Enter after the terminal producer declares a
submission boundary. `Input`, `InputBoundary`, and `InputControl` (plus their
one-way forms) classify raw bytes as draft, submission, or non-composer control;
the daemon never infers a boundary from CR/LF bytes.

**`Ok` to `SubmitInput` means submitted, not accepted.** A logical message is
one delivery in two writes — the message, then its delayed Enter — and the
acknowledgement fires only after that Enter reaches the PTY. It travels with
the message rather than with the call, so a message dispatched immediately, one
released by a producer's boundary, and one released by composer attestation all
acknowledge through the same channel. A message the daemon parks behind a
declared raw draft has not been submitted, and is answered
`logical_input_held_by_draft` rather than `Ok`: the message stays queued for
the boundary, but no caller is told a delivery happened that did not. A writer
that ends between the two writes answers `write_failed`, because the text may
already be sitting unsent at the composer and a blind retry would duplicate it. A new server paired with a
previous daemon generation therefore waits for the supporting successor before
serving. The daemon records the exact negotiating server
process and refuses server-originated PTY spawns from an unnegotiated process,
making unsupported server/daemon pairings fail closed. `ClassifyInput` shares the daemon lifecycle fence with the handoff
snapshot; a command that loses that race receives `RetryOnSuccessor`, and the
server repeats negotiation plus the complete classification pass on every
published daemon generation.

Draft state and accepted logical messages are part of transactional-v3 handoff
state. A sender refuses a legacy-v2 adopter while that state is unknown, a draft
is active, or any logical message remains queued. A current daemon adopting a
legacy payload treats draft state as unknown and refuses logical input until it
is resolved. This preserves accepted messages across normal handoff without
guessing a submission from terminal bytes: submission boundaries are still
declared by the producer and never inferred, from PTY bytes or from rendered UI.

Two things withhold a logical message from the PTY, and one piece of evidence
answers both. An **unknown** draft state is an inherited session this daemon
never watched being typed into. An **active** draft state is one a producer
declared — and a producer can declare a draft but cannot un-declare one, so a
navigation key, an Escape or a Ctrl-key press, none of which leave an unsent
line, would otherwise withhold every later message until a human pressed Enter
at that terminal. Both are resolved by the same two things:

- **A producer-declared boundary** — `InputBoundary` on the raw path, which is
  what a human pressing Enter in that terminal produces.
- **Composer attestation** — a positive match on the provider's own idle
  composer chrome, rendered empty, in the daemon's headless terminal.

Attestation answers exactly the question both guards ask — whether an
unsubmitted draft is sitting at the prompt — and answers it more directly than
the keystroke: an empty composer holds no draft, so there is nothing a logical
message could be appended to. It is one-way (towards "no draft is here", never
the reverse and never "a draft is present"), it writes nothing to the PTY, and
it discards nothing on screen. It matches only Claude's `❯` and Codex's `›`
composers; only when that prompt is the last one in the status window with
nothing but provider chrome below it; only when the frame is neither busy nor
waiting; and only when the remainder of the prompt line is empty. A suggestion
the CLI drew and a half-typed line are indistinguishable in a rendered frame, so
any text at all leaves the state unknown. Providers whose empty composer has not
been captured, and sessions with no provider, are never attested. There is
deliberately no clear-and-submit control: the daemon never discards or submits
text a human may have typed.

The daemon runs attestation on each session's own status tick — an inherited
session nobody types into produces no output at all, so nothing else would ever
run it — and once more on the withholding path of a `SubmitInput` that would
otherwise be refused or parked.

A session that stays unknown refuses `SubmitInput` with
`inherited_draft_state_unknown`, and that refusal is visible before anything
tries to deliver into it: `List` reports `logical_input_blocked` per session,
and `InputBlockedChanged` is broadcast on every edge — adoption, a human
keystroke, attestation — from the session's own status loop, so one publisher
covers every cause.

| Env Var | Description | Default |
|---------|-------------|---------|
| `KANNA_DAEMON_DIR` | Data directory (socket, PID, log files) | `~/Library/Application Support/Kanna` |
| `KANNA_SERVER_EXECUTABLE` | Server executable allowed to clear inherited protected-input policy | unset (fails closed) |
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
