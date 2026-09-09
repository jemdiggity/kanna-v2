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
8. **Multiple clients per session.** Attached clients receive output via broadcast. A
   geometry-capable viewer registers its role and measured dimensions on the
   control connection. One daemon-owned controller proposes the PTY size:
   eligible local viewers win over eligible remote viewers, ties are
   deterministic by viewer id, and a remote viewer never shrinks an attached
   local viewer. An explicit takeover overrides automatic election until
   release or disconnect. Followers render the controller's authoritative grid
   and may pan/scroll it; their viewport is not a PTY resize.
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

Runtime status is classified from the headless terminal's rendered grid, after
ANSI control sequences have been interpreted. A DEC synchronized-output frame
is not observable provider state until its closing `CSI ? 2026 l`: intermediate
spinner, footer, and banner paint must not publish a status or consume the
per-session classification throttle. The periodic status tick performs an
independent settled-frame classification, so cosmetic output checks cannot
starve convergence to the provider's idle composer.

Provider idle detection is a positive rendered-chrome match. Claude's `❯`
composer is followed by a divider and its permission/mode bar, so the last
composer is idle when every row below it is measured Claude chrome and no
busy, subagent, or waiting marker is present. On transactional handoff, the
adopter classifies the restored live snapshot before publishing its session
list and prefers that positive verdict to the status copied beside the
snapshot. An inherited conservative `Busy` therefore cannot override a frame
that already proves the provider is parked.

### Detection rules

**The patterns are data, and they are selected by the CLI version the session
is running.** The chrome each provider draws lives in
`src/detection/rules.json` — bundled into the daemon, deep-merged with a
machine-local `detection-rules.json` in the daemon data directory, and
hot-reloaded into live sessions — not as constants in the binary. Every rule
and vocabulary entry carries a version range, so the patterns for an old CLI
and a new one coexist instead of one overwriting the other. A verdict names
the rule that produced it.

A PTY task's `Spawn` names the login shell that runs repo setup, so the daemon
cannot find the agent CLI by inspecting its own child; the server sends the
path it resolved as `Spawn.agent_executable`, and the daemon probes it off the
spawn path. **An unknown version applies every rule measured for the provider**
— before the probe answers, when it fails, and for a session inherited from a
daemon too old to send one — which is exactly what an unversioned session
classified from before rule selection existed. The version travels across
handoff as `HandoffSession.cli_version`.

The rendered grid stays authoritative. Terminal titles (OSC 0/2) and progress
reports (OSC 9) are addressable rule channels, evaluated only when no grid rule
matched — the case that latches a stale status — never to overrule a frame that
already proved something. Waiting is decided from the grid alone.

Design, rule schema and migration: `docs/specs/agent-status-detection-rules.md`.

## Reconnection

The daemon does **not** buffer raw scrollback. Reconnection uses the headless terminal snapshot:

1. Client sends `AttachSnapshot`
2. Daemon ensures the session has one `stream_output` reader
3. Daemon snapshots the headless terminal and adds the client to the writer broadcast list
4. Client hydrates xterm.js from the snapshot and, when geometry is negotiated,
   registers its measured proposal before sending `Resize`
5. Future PTY output streams live to the client

**Why no raw scrollback buffer:** Claude's TUI uses absolute cursor positioning and full-screen rendering. Raw byte replay can resurrect overwritten output and garble state. The headless terminal is the single detached-state copy; xterm.js is hydrated from that state on attach.

### Terminal geometry controller

`RegisterViewer` is atomic with the first positive `(cols, rows)` proposal and
is fenced by the control connection, viewer id, and registration generation.
`ResizeNoReply` updates a registered viewer's proposal, but only the elected
viewer can change the PTY and headless terminal. A follower resize is a no-op.
The selection table is:

| Eligible candidates | Automatic controller |
|---|---|
| local viewers | deterministic local candidate |
| no local, remote viewers | deterministic remote candidate |
| no visible measured viewers | retain last applied size |

The current eligible controller is retained. A local arrival preempts an
automatically selected remote controller; ordinary focus and input never
reclaim an explicit takeover. Detaching a follower does nothing. Detaching,
disconnecting, or backgrounding the controller elects once. A transient
transport loss may relinquish takeover; there is no heartbeat or timeout
arbitration loop.

Legacy undeclared resize requests retain the old minimum policy only while all
participants are legacy. Once a geometry-capable viewer registers, legacy
requests cannot displace its controller. This is a compatibility limitation,
not the synchronized-grid guarantee. Geometry changes publish an ordered
authoritative snapshot through fanout, so the snapshot/live tail cutover is
the same boundary as lag recovery. A failed PTY/headless resize is not
published as applied. Draft bytes and composer attestation are independent of
geometry and survive reflow. Handoff preserves the
last applied dimensions but never transfers pointer-based viewer ownership;
clients re-register after reconnect.

The server probes daemon terminal-geometry protocol version 1 on each daemon
PID before sending viewer commands. An older daemon is treated as legacy and
continues to receive only legacy resize commands; a replacement daemon is
probed again. This is deliberately separate from protected-input negotiation.

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
| `RawInputIfSession` | session_id, expected_pid, data (byte array), class (`draft`/`submission`/`control`) | `InputIfSession` plus the producer's declared composer meaning. `InputIfSession` classifies every fenced write as a draft, which is right for a keystroke and wrong for an Enter: a CR declared a draft arms the typed-byte ledger against a composer that Enter just emptied. Requires `NegotiateRawInput` on the same connection |
| `NegotiateRawInput` | version (u32) | Answer `RawInputReady` when this daemon speaks `RAW_INPUT_PROTOCOL_VERSION`. It has no session and no side effect, so a daemon too old to deserialize `RawInputIfSession` — which closes the connection without replying — is distinguishable from a write whose answer was lost, and the caller can honestly report that nothing reached a PTY |
| `Resize` | session_id, cols, rows | Update terminal dimensions |
| `Signal` | session_id, signal (string) | Send Unix signal |
| `Kill` | session_id | Terminate and remove session |
| `List` | — | List all sessions, each with `composer_text` and `composer_attestation` |
| `Handoff` | version (u32) | Request session transfer |

### Events (daemon → client)

| Event | Fields | Description |
|-------|--------|-------------|
| `Ok` | — | Command acknowledged |
| `Error` | message, code | Command failed. A `SubmitInput` failure is always about the session — it does not exist, its incarnation changed, or the writer ended mid-write — never about what is on its composer |
| `Output` | session_id, data (byte array) | PTY output |
| `Exit` | session_id, code | Process exited |
| `SessionCreated` | session_id | New session ready |
| `RawInputReady` | version | This daemon speaks the fenced raw-input contract at `version` |
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
logical input. `SubmitInput` accepts a complete logical message and writes it —
text and submission boundary, as one write — immediately. `Input`,
`InputBoundary`, and `InputControl` (plus their one-way forms) classify raw
bytes as draft, submission, or non-composer control for the composer
attestation ledger; the daemon never infers a boundary from CR/LF bytes.

**`Ok` to `SubmitInput` means written, submission boundary included.** A
logical message and its Enter are one PTY write, so the acknowledgement means
what a caller assumes it means. There is no held, parked, deferred or refused
answer: a live session always takes the message, whatever is on its composer.

Until 2026-09-08 the daemon did the opposite. It kept a delivery out of the PTY
while a producer-declared draft was active, and withheld its Enter from a
terminal that never settled; the text then sat unsent at a composer, the
delivery answered `logical_input_submission_unproven`, and about ten seconds
later the session began refusing every later message until a human pressed
Enter at that terminal. It reproduced three times in one day on
0.3.0-staging.12, once stranding an owner's answer to a consultation sent from
their phone, on a machine with no cross-machine raw-key path to clear it. The
owner's decision is recorded verbatim: *"The input protection is killing me.
I'd rather have collisions."* A message that occasionally lands after somebody's
half-typed line is far cheaper than one that silently never arrives.

So the collision is the accepted outcome. If a human has an unsent draft, the
delivered message is written after it and both go in. What remains is the
PTY-pid fence — a message reaches the session it was addressed to or nothing —
and the durable `task_input` record on the server side.

A writer that ends mid-write answers `write_failed`, because the bytes may
already be sitting at the composer and a blind retry would duplicate them. A
new server paired with a previous daemon generation waits for the supporting
successor before serving. The daemon records the exact negotiating server
process and refuses server-originated PTY spawns from an unnegotiated process,
making unsupported server/daemon pairings fail closed. `ClassifyInput` shares
the daemon lifecycle fence with the handoff snapshot; a command that loses that
race receives `RetryOnSuccessor`, and the server repeats negotiation plus the
complete classification pass on every published daemon generation.

**The daemon's writes are not the CLI's reads.** A PTY master's input queue
takes about a kilobyte per write — 1022 bytes on macOS — so a longer message
reaches the CLI as several separate input events however the daemon issues it,
and an interactive TUI reads the first burst as a paste and the rest as typing.
Measured on 2026-09-05 against Claude Code 2.1.261: a 1,191-byte single-line
message was written as 1022 + 169 bytes and only the 169-byte tail was
submitted. So when the application has enabled terminal bracketed-paste mode, a
message is framed with those markers in its first write if it contains CR or LF
**or** is at least 256 bytes long. The markers travel in-band with the bytes and
are therefore immune to however the queue splits them: everything between them
is one editor operation, closed before the fenced Enter submits it. A terminal
that never advertised the mode is left untouched — sending unsupported controls
would become literal composer text, a worse corruption — and so is a message
short enough to arrive in one write, which keeps provider slash commands typed
rather than pasted.

**The submission boundary is written immediately.** It travels in the same
buffer as the text, immediately after the closing paste marker when there is
one, so however the kernel queue divides that buffer the marker still closes
the editor operation in-band and the CR after it is a keypress rather than
pasted text. The daemon does not wait for the terminal to settle, does not read
the composer, and does not consult the ledger before writing it.

After a message's boundary the writer holds a fixed
`LOGICAL_INPUT_SUBMIT_DELAY_MS` pause before the next queued message may own
the composer: a CLI needs a processing turn after Enter, and two deliveries
written back to back without one arrive merged. It is write pacing between two
*delivered* messages — a fixed clock that always elapses, reads nothing, and
cannot withhold anything.

The composer attestation ledger is part of transactional-v3 handoff state. A
sender refuses a legacy-v2 adopter while a declared draft is active, because
that is the ledger's one positive assertion and a v2 payload cannot carry it;
nothing about *delivery* is at stake, since nothing is ever retained. A current
daemon adopting a legacy payload treats attestation as `unknown` — it still
delivers, it simply cannot say who wrote what is on that composer.

The handoff payload's `pending_logical_inputs` is always empty from a current
daemon. It stays on the wire so that adopting from a predecessor built before
this change submits whatever that daemon was still holding, rather than
dropping an owner's words on the upgrade that removed the hold.

Two states leave a composer unattested, and one piece of evidence answers both.
An **unknown** state is an inherited session this daemon never watched being
typed into. An **active** draft state is one a producer declared — and a
producer can declare a draft but cannot un-declare one, so a navigation key, an
Escape or a Ctrl-key press, none of which leave an unsent line, would otherwise
leave the composer reading `typed` for the life of the session. Both are
resolved by the same two things:

- **A producer-declared boundary** — `InputBoundary` on the raw path, which is
  what a human pressing Enter in that terminal produces.
- **Composer attestation** — a positive match on the provider's own idle
  composer chrome, rendered empty, in the daemon's headless terminal.

**Attestation is evidence from a rendered frame, and the frame must be proven
newer than the draft it is used against.** A frame says only what was on screen
when it was rendered. A declared byte still queued in the writer, or written but
not yet echoed by the provider, leaves a composer that renders empty because the
keystroke has not landed on it yet — not because there is no draft — and
clearing on that frame would assert that a human's first typed character is
provider chrome. So an **active** declared draft is cleared only when every
declared-draft write has completed at the PTY *and* at least one output chunk
has been mirrored since the last one did; the mirrored-chunk count is sampled
before the frame is read, so the frame is at least that new. Anything short of
that leaves the composer attested `typed`. The **unknown** state has no such
write to wait for — nothing here declared a draft — so it resolves from the
current frame alone.

Attestation answers exactly the question the ledger asks — whether an
unsubmitted draft is sitting at the prompt — and answers it more directly than
the keystroke: an empty composer holds no draft, so nothing rendered there is
somebody's unsent words. It is one-way (towards "no draft is here", never
the reverse and never "a draft is present"), it writes nothing to the PTY, and
it discards nothing on screen. It matches only Claude's `❯` and Codex's `›`
composers; only when that prompt is the last one in the status window with
nothing but provider chrome below it; and only when the frame is neither busy
nor waiting. Providers whose empty composer has not been captured, and sessions
with no provider, are never attested. There is deliberately no clear-and-submit
control: the daemon never discards or submits text a human may have typed.

**A composer that renders the provider's own suggestion is attested too, from
its cells rather than its text.** Normalised text cannot tell a half-typed line
from a ghost the CLI drew, but the *cells* can, and the difference had a cost:
Claude Code paints the last submitted line back as a faint tab-to-accept
suggestion, so a session whose ledger armed once never saw a textually empty
composer again and held every delivery for the rest of its life. That is the
owner report of 2026-09-07 — a composer attested `typed` whose text the owner
could see was grey while typed text is not. The daemon therefore reads the
composer row's styling and cursor, and calls it a suggestion only when **both**
are true at once: every rendered cell after the prompt is painted faint
(SGR 2), and the cursor is at the start of the composer rather than after the
text. Either one alone leaves the state unknown — a human who pressed Ctrl-A
over their own draft has the cursor at the start, and being wrong here appends
a delivered message to a real unsent line. Only Claude's styling has been
measured (`crates/daemon/tests/fixtures/claude/faint-suggestion-composer.ansi`,
captured off the reported session); no other provider matches, on this file's
standing rule that unmeasured chrome matches nothing.

The `❯` line also has to be *findable*, and it was not. Claude's status bar
carries rows nobody enumerated — a `/rc` release-channel token, an effort
badge, an update badge, a login-expiry notice; unclassified, any one of them
made every live Claude session fail the "nothing but provider chrome below the
composer" test, so `composer_state` answered `Unknown` for all of them and
attestation could not fire at all. Nothing enumerates them now either. The
composer box closes with a divider and only the status bar is drawn beneath it,
so everything past that border reads as chrome by construction — the same
reading the parked-composer rule already uses, and for the same reason.

Which providers get that reading is data, not a branch: the truncation runs off
the provider's own divider glyphs in `src/detection/rules.json`, and only a
provider whose box has actually been measured declares any. Everyone else
resolves an empty set and is read exactly as before. The *styling* half stays
out of the rule file on purpose — the matcher language describes what chrome
reads as, and a cell being painted faint is not text — so the cells are read
where the grid is rendered.

The daemon runs attestation on each session's own status tick, which is the
only thing that runs for every session: a session nobody types into produces no
output at all, so nothing else would ever resolve it.

**A frame is not the only evidence. The typed-byte ledger is the other, and it
is the stronger one.** The daemon counts the bytes a producer declared a draft
since the session's last submission boundary, resets that count at every
boundary and at every successful attestation, and carries it across v3 handoff.
`Some(0)` is positive proof that no unsent line exists — and unlike a frame it
survives the CLI painting *anything* at its own prompt. So a declared draft that
typed nothing attests `not-typed`: whatever the provider is rendering there is
its own. That is what ends the case a rendered suggestion used to create, where
no frame would ever read that composer empty again and the session claimed a
human's unsent line when nobody had typed a byte. `None` is *not* zero: it is a
draft inherited without its ledger, and it reads `unknown` exactly like a
counted one that cannot be cleared.

**The ledger counts only the bytes that can put text at the composer.** A
producer declares that bytes belong to a human's own line; their content decides
whether one can exist. The desktop declares every non-Enter keydown a draft, so
opening a task's terminal and pressing an arrow, an Escape or a PageUp — or
clicking, or scrolling — used to arm the ledger against a line nobody had
typed, which is the owner report of 2026-09-05: a queued-input banner on the
phone with a visibly empty composer on the desktop. So `crates/daemon/src/draft_bytes.rs` classifies each declared
write before it reaches the ledger, and a write that can create nothing declares
nothing — it is routed exactly like an `InputControl`, leaving the draft flag,
the write interlock and the count untouched.

- **Content**, counted: printable and UTF-8 bytes, `TAB`, `CR` and `LF` (a
  multiline composer's own newline), everything between bracketed-paste markers,
  every C0 control not named below — and **cursor up/down** (`ESC [ A`,
  `ESC [ B`, `ESC O A`, `ESC O B`). Those two look like navigation and are not:
  in Claude Code and in every readline shell they recall a previous line *into*
  the composer, which is exactly the unsent line a delivery must never be
  appended to. A recall with nothing to recall leaves the composer rendering
  empty, so attestation clears that case on the next frame.
- **Inert**, not counted: every other well-formed CSI (`ESC [ … final`) and SS3
  (`ESC O x`) sequence — left/right, Home/End, PageUp/PageDown, Delete, F-keys,
  SGR mouse reports, focus in/out, and every CSI-shaped terminal *reply*
  (device attributes, cursor-position and status reports, kitty keyboard flags,
  text-area size) — a bare `ESC`, an `ESC`+byte Alt chord, and the C0 controls
  that only move, delete, redraw or abandon (`NUL`, `Ctrl-A/B/C/D/E/F`, `BEL`,
  `BS`, `Ctrl-K`, `Ctrl-L`, `Ctrl-U`, `Ctrl-W`, `Ctrl-Z`, `FS`–`US`) and `DEL`.
- **Inert**, not counted: a terminated *string* escape and its whole payload —
  DCS (`ESC P`), OSC (`ESC ]`), SOS (`ESC X`), PM (`ESC ^`) and APC (`ESC _`),
  up to `ST` (`ESC \`) or, for OSC, `BEL`. No key produces one. They are how an
  emulator answers the application's own questions — XTVERSION, XTGETTCAP and
  DECRQSS replies, and the OSC 10/11/4 colour reports Claude Code asks for at
  startup and after every resize — and they arrive up the same PTY input path a
  keystroke uses. Their payloads used to be counted as printable characters,
  which armed the ledger on a terminal nobody had touched, because the plain
  `Input` command and the KSP `TermInput` frame declare every byte they carry a
  draft unless the client marks it control. The terminator is what makes this
  safe: `ESC ]` is also Alt-`]` and the desktop coalesces consecutive keydowns
  into one write, so an *unterminated* introducer stays a two-byte Alt chord and
  the characters after it still count.
- Anything unrecognized — an unassigned control, a truncated sequence — counts
  as content. The safe direction is to assume somebody typed.

This is not the inference this daemon refuses to make about *submission*.
Submission stays a producer declaration because a `\r` inside a paste and a
pressed Enter are the same byte; insertion is not like that, because a terminal
line editor discards an escape sequence it does not recognise.

**Escape, Ctrl-C and Ctrl-U are inert, not clearing.** Counting them as inert is
what fixes the report above, and it asserts nothing the daemon cannot prove.
Letting them *zero* a ledger that had already counted real typed content would
be an assertion: nothing here knows that a given CLI's Escape empties its
composer rather than dismissing a dialog or opening a transcript view, and being
wrong would let provider chrome be read as a human's words — the exact harm
this mechanism exists to prevent. Emptiness stays a claim about a rendered
frame, and after a genuine clear the frame does read empty, so attestation
resolves it on the next status tick.

The ledger is also what labels the composer for everything outside the daemon.
The verdict is `typed` (content bytes counted since the last boundary),
`not-typed` (an attested session with none, so any rendered `❯`-line text is
provably the provider's own chrome or suggestion), or `unknown` (draft state
inherited from before attestation). A session typed into and then cleared by its
human stays `typed` until a boundary or an empty-composer frame resolves it —
the conservative side of the trade.

**The verdict decides what may be read, never whether a message is delivered.**
A session that stays `unknown` still takes every `SubmitInput`; what `unknown`
costs is that nothing on that composer may be treated as an instruction.

The composer travels to consumers on the session's own edges: `List`
reports `composer_text` and `composer_attestation` per session, and
`ComposerChanged` is broadcast from that same status loop on the composer's own
edges. It is published only once a session has actually drawn a readable
composer — most sessions never do — so a daemon full of worktree shells stays
quiet. Consumers must keep the text out of anything that means "what the
session said": it is the input line, not output.

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
