# Kanna Server Boundary

`kanna-server` is the desktop-side service boundary for non-desktop consumers.
Mobile clients and future CLI tools should talk to `kanna-server`, not directly to the daemon protocol, Tauri commands, or desktop UI state.

The desktop frontend itself is planned to become a `kanna-server` client as well; see [2026-07-05-desktop-server-migration-plan.md](2026-07-05-desktop-server-migration-plan.md) for the phased migration off direct SQLite access.

## Responsibility Split

- `kanna-server`: LAN HTTP and WebSocket transport, route validation, task listing and search, task lifecycle actions, pairing state
- daemon: PTY and session ownership, terminal input and output, agent process lifecycle
- SQLite DB: repo and task persistence, task metadata, query backing for server resources

## Terminal Input Boundaries

`POST /v1/tasks/{task_id}/input` carries one logical message, not raw terminal
bytes. The daemon is the authoritative queue owner: it submits the message
immediately when the composer is clear, or retains it behind an unsent human
draft until that draft crosses a producer-declared submission boundary. The
accepted queue is session-scoped, survives server/frontend reconnects and
transactional daemon handoff, and is never redirected to a later run or stage.

**A `204` means submitted, not queued.** The message and its Enter are one
delivery in two PTY writes, and the daemon acknowledges only after the second,
so a success answer cannot be given for text still sitting unsent at the
composer. A message retained behind a draft answers `202` with
`status: "queued"`, `reason: "input_held_by_draft"`, and the task's
`queuedInputCount`: it stays queued for the producer's boundary and every task
summary exposes that backlog and reason. It is first stored in
`queued_task_input`, not falsely recorded as delivered. Reported by the product owner on 2026-08-20, when replies sent from
mobile sat at the agent's prompt until someone pressed Enter at that terminal
while the phone had been told they were delivered. A declared draft that leaves
nothing at the prompt — a navigation key, an Escape, a Ctrl-key press — no
longer holds anything: the daemon clears it from the composer's own rendered
emptiness (see `crates/daemon/SPEC.md`).

When the logical message contains an embedded CR or LF and the terminal
application has enabled bracketed-paste mode, the daemon frames the text as one
paste before the delayed Enter. The PTY is otherwise only a byte stream: an
interactive agent TUI can consume unframed multiline text as several editor
actions and submit only a trailing fragment. Unadvertised mode and single-line
input remain unframed, preserving literal-text and provider slash-command
semantics.

Raw terminal producers classify each frame as draft, submission, or control.
Desktop keyboard events declare unmodified Enter; mobile LAN and relay clients
forward the same boundary bit, while mobile mouse/scroll reports are controls
that neither create nor clear draft state. KSP peers must mutually advertise
`term_input_boundary`; a mixed-version connection rejects all terminal input
rather than accept bytes whose boundary meaning may be lost. CR/LF content is
opaque and never used to infer submission, including inside multiline paste.
Every accepted delivery is also recorded durably against the task — see
[Delivered Task Inputs](#delivered-task-inputs) — because terminal bytes are
not a record any later stage can read.

### Image attachments

`POST /v1/tasks/{task_id}/input` accepts one optional `attachment`:
`{ fileName?, mediaType, dataBase64 }`, where `mediaType` is one of
`image/jpeg`, `image/png`, `image/webp`, `image/heic`. Photos only — no video
and no arbitrary file types.

The agent CLIs are terminal programs, so nothing about the daemon contract
changes: the server writes the decoded bytes to a file and delivers the
caller's text **plus a reference to that file's absolute path** as one ordinary
logical message —
`<text> [Attached image: <path>]`, or the bracket alone when the caller sent no
text. The reference is joined with a space and never a newline, because the
daemon writes a logical message and then a carriage return: an inserted newline
would split one submission into two and put the words in front of the agent
before the picture.

- **Encoding is base64-in-JSON on both mobile transports.** The relay carries a
  desktop invocation as a JSON message and the LAN client posts the same JSON
  to the same route, so one encoding means one handler, one durable record, and
  one thing to test. Multipart would exist on one path only and would buy a
  third of a payload that is capped at a few megabytes anyway.
- **Budget.** 3 MiB decoded per attachment (`MAX_TASK_INPUT_ATTACHMENT_BYTES`);
  the route raises axum's body limit to 8 MiB to leave room for base64 plus the
  message. Mobile resizes to a 1568px longest edge and re-encodes as JPEG
  before uploading, which lands ordinary photos far below the cap; the server
  cap is the backstop, not the working limit. Over-budget returns 413
  `attachment_too_large`, an unsupported type 415, and a corrupt payload 400.
- **Storage and lifetime.** Files live beside the database, under
  `<db-dir>/<db-stem>-task-attachments/<task_id>/`, **not** in the task's
  worktree: closing a task snapshots its dirty worktree into a WIP commit, so a
  photo dropped there would be committed onto the branch and appear in every
  diff. They are removed when the task closes, alongside the task's other
  per-task on-disk artifacts. A stored file whose submission then failed is
  deleted again; a file whose delivery was *uncertain* is kept, because the
  agent may already have been told the path.
- **Durable record.** No separate attachment column: the `task_input` row holds
  the exact delivered text, which names the path. The record's contract is what
  entered the session, and a second representation could only disagree with it.
- **PTY sessions only.** A live daemon PTY session is required as it is for any
  other input; SDK-mode tasks answer over the agent stream, which carries text
  alone, and the mobile composer hides the attach control for them.
- **Clients must check `/v1/status` first.** `taskInputAttachmentVersion`
  (currently `1`) advertises this contract, and its **absence is the signal
  that the desktop predates it** — the same convention as `kspStreamVersion`.
  A desktop without the marker deserializes an `attachment` field, ignores it,
  delivers the text alone and still answers `204`, which is indistinguishable
  from success, so a phone that skipped the check would clear its composer
  while the agent answered about a picture it never received. That mismatch is
  the ordinary state on release day: phone and desktop are separate binaries
  on separate cadences. Mobile hides the attach control when the marker is
  absent, and it asks **the desktop that owns the task**, routed the same way
  the input itself is routed — a phone sees tasks owned by several machines at
  different versions, and on the relay path its own connection status
  describes the cloud rather than any desktop.

Desktop-to-desktop LAN input has the same fail-closed rule at task-transfer
protocol v5. A v4 peer may still be discovered and use unrelated compatible
features, but a current sender refuses all terminal input to it and a current
owner refuses its duplex observation/input before contacting the daemon.

## Bounded Terminal Windows

A terminal attach used to hand the client the whole serialized terminal: the
visible screen **plus** up to 10,000 rows of scrollback, re-shipped on every
reconnect. On a phone that is the wrong unit of transfer — the frame inventory
in `docs/task-specs/7a38cc18.md` measured 1.71 MiB base64 for a plain 10,000-row
scrollback and 114.8 MiB for a truecolor one, and a flaky link paid for it again
every time it dropped.

A client that advertises `term_scrollback_window` in its `auth` frame gets three
things instead; a client that does not is served exactly as before, including
its own daemon connection per attachment.

- **`term_snapshot` is a bounded window** — the visible screen plus a bounded
  slice of recent scrollback, capped by both a line count and a byte ceiling
  (`crates/kanna-server/src/terminal_window.rs`). The frame names the retained
  remainder: `history_id`, `scrollback_lines`, and where the live byte stream
  continues (`stream_id`, `stream_offset`).
- **Older scrollback is pulled on demand.** `term_scrollback_request
  { request_id, history_id, before_line, max_lines }` is answered with
  `term_scrollback_chunk { start_line, end_line, data_b64, remaining_lines }`,
  bounded per request by both lines and bytes and served newest-first. A request
  naming a `history_id` the server has replaced is answered with the current one
  and an empty chunk, so the client re-anchors rather than splicing stale rows
  above its buffer.
- **A reconnect replays the delta.** The client tracks its own position by
  adding each `term_output` frame's decoded length to the snapshot's
  `stream_offset` — nothing per-frame travels on the wire — and presents
  `term_resume { stream_id, offset }` on re-attach. Inside the server's replay
  window it receives `term_resumed` and then only the bytes it missed, keeping
  the buffer it already rendered. Outside it, a *bounded* fresh snapshot. Never
  the full history unconditionally. Resume offsets are accepted only at exact
  `term_output` frame boundaries recorded by the ring; an offset inside a frame
  falls back to a fresh snapshot rather than beginning with an ANSI or UTF-8
  continuation byte.

Mobile additionally reconciles transport receipt with emulator receipt after
an app-background grace interval. iOS may suspend WKWebView while native code
continues receiving bytes, so foregrounding resets and rehydrates xterm once
from the contiguous retained buffer. If client compaction has created a gap
between its snapshot and live tail, it discards the resume cursor and requests
a bounded fresh snapshot instead of replaying that invalid local buffer.

Capability clients attach through a session-scoped **terminal tap**: one daemon
connection per session shared by its subscribers, recording live output into a
bounded ring and outliving the last subscriber by a grace window. That grace is
what makes a dropped link cost O(delta); an offset only means anything inside
the `stream_id` generation that produced it, so a daemon reconnect voids it and
the client falls back to a bounded snapshot.

## v1 LAN Surface

- `GET /v1/status`
- `GET /v1/stream` (KSP WebSocket for terminal, agent, and streamed task API frames)
- `GET /v1/desktops`
- `GET /v1/repos`
- `POST /v1/repo-checkouts` (confirmed clone-and-register intent)
- `GET /v1/repo-checkouts/{operation_id}` (poll `running` / `done` / `failed`)
- `GET /v1/repos/{repo_id}/tasks`
- `GET /v1/repos/{repo_id}/agents` (resolved named agent definitions available to task creation)
- `GET /v1/repos/{repo_id}/recent-workflows` (workflow names the repo's tasks were most recently created with, newest first)
- `POST /v1/tasks/{task_id}/actions/set-workflow` (re-pin an open task to a compatible workflow definition)
- `GET /v1/tasks/recent`
- `GET /v1/tasks/search?query=...`
- `GET /v1/tasks/{task_id}/children` (durable direct-child fan-out history; includes closed children)
- `GET /v1/tasks/{task_id}/inputs?tail=...` (durable instruction history: every message delivered into the task's agent session from outside it)
- `GET /v1/task-events?taskIds=...|parentTaskId=...|repoId=...|repoRemoteUrlHash=...&excludeTaskIds=...&cursor=...&timeoutSecs=...&limit=...` (multi-task, multi-machine event feed; blocks server-side until an event arrives or the window elapses; `excludeTaskIds` is a filter over the chosen scope, see [Task Event Feed](#task-event-feed))
- `POST /v1/tasks`
- `POST /v1/tasks/{task_id}/input` (optionally with one base64 image `attachment`; see [Image attachments](#image-attachments))
- `POST /v1/tasks/{task_id}/actions/complete-stage`
- `POST /v1/tasks/{task_id}/actions/request-revision`
- `POST /v1/tasks/{task_id}/actions/close`
- `POST /v1/tasks/{task_id}/actions/advance-stage`
- `POST /v1/tasks/{task_id}/actions/signal-merge-handoff`
- `POST /v1/tasks/{task_id}/actions/rerun-stage`
- `POST /v1/tasks/{task_id}/actions/run-merge-agent`
- `POST /v1/mobile/notifications`
- `GET /v1/mobile/notifications/registration`
- `POST /v1/pairing/sessions`
- `POST /v1/pairing/sessions/claim`
- `POST /v1/pairing/push-certificate` (paired-device authentication required)

### Anonymous push pairing certificate

The pairing claim response keeps the compact `KANNA1:{DESKTOP-ID}:{CODE}` QR
payload unchanged and additively returns `desktopPushIdentity` and
`pushPairingCert`. The identity contains the raw 32-byte Ed25519 public key as
unpadded base64url plus the desktop's relay URL and environment. The
certificate contains `deviceId`, Unix-millisecond `issuedAt` and `expiresAt`
(730 days apart), and the raw 64-byte Ed25519 signature as unpadded base64url.

The canonical signed bytes are the ASCII domain
`kanna.push-pairing-cert.v1` followed by one NUL byte and compact JSON with
fields in this exact order:
`{"deviceId":...,"issuedAt":...,"expiresAt":...}`. This is the relay's
proof that the desktop consented to bind that paired device to its anonymous
push identity.

`kanna-server` creates the private identity on first use in a mode-0600 JSON
file beside the configured pairing store. A device paired before this surface
may obtain and persist its first certificate through authenticated
`POST /v1/pairing/push-certificate`; later calls transparently re-issue it with
a fresh 730-day lifetime. The pairing store records which public identity
issued a device's certificate. If the private key is lost or deliberately
rotated, that marker no longer matches and re-issue returns `409`; recovery is
a new LAN pairing ceremony, which binds the device to the new identity.

Task-list rows are deliberately bounded summaries. `prompt` contains at most
500 characters; `GET /v1/tasks/{task_id}` is the full-prompt surface.
`waitingPromptSnippet` is the canonical latest-output preview key (the server
still accepts the deprecated `snippet` key when aggregating an older peer, but
does not serialize both). `agent` is the name recorded on the latest durable
`stage_run`; `agentType` is only the session transport (`pty` or `agent`) and
must not be presented as the agent name. Recent listings accept `repoId` and a
`limit` (default 50, clamped to 200); search accepts the same repository
filter. The MCP adapter supplies the calling task's repository by default and
leaves the account-wide `all_machines` behavior unchanged; `all_repos` is the
explicit local cross-repository escape hatch.

Task-detail git history is computed against the same resolved base as the task
diff: an unqualified base prefers `origin/<base>` over local `<base>`, including
when the local branch exists but is stale. If a task's persisted base no longer
resolves, stats retry the repo's current default branch. When neither resolves,
`commitsAhead` and `commitsBehind` are omitted and `baseRefUnresolved: true` is
reported; this must not be interpreted as zero work. `dirty` remains an
independent working-tree result.

### Remote repository checkout

Authenticated repo inventory includes an optional, credential-free `remoteUrl`
alongside the cross-machine `remoteUrlHash`. HTTP(S) origins containing userinfo
or query/fragment data are treated as credential-bearing and their raw values
are never serialized. `POST /v1/repo-checkouts` independently rejects those
sources before git, filesystem, or database work, accepts ordinary HTTPS,
SSH/scp-style, and `file://` sources, verifies the URL's SHA-256 identity, and
starts a non-blocking clone into the desktop convention
`~/.kanna/repos/<name>[-N]`. The worker uses the same `MobileApi::add_repo`
registration path as `POST /v1/repos`, then persists the remote metadata.

The returned operation is polled through
`GET /v1/repo-checkouts/{operation_id}`. A failed clone or registration removes
the operation-owned destination and rolls back any row it inserted. Git uses
only credentials already configured on the target desktop; this API neither
forwards nor provisions credentials. Checkout errors do not echo the clone
source and direct the user to configure a credential-free origin plus git
credentials on the named target desktop. Relay invocation is a control operation: repository
bytes flow directly from the git remote to the target desktop, not through the
relay.

### Repository default-branch metadata

Repository registration treats `git ls-remote --symref origin HEAD` as the
authoritative default branch whenever `origin` exists. Local branch and HEAD
heuristics apply only to repositories without `origin`. The repo row stores
both `default_branch` and `default_branch_source`; repo detail responses expose
the provenance as `defaultBranchSource`.

`PATCH /v1/repos/{repo_id}` accepts `defaultBranch` for an explicit in-place
correction. `POST /v1/repos/{repo_id}/reconcile-metadata` re-detects the branch,
reports the recorded and detected values and provenance plus `drift`, and
updates the existing row by default (`apply: false` is the read-only doctor
mode). The agent-facing surface is `kanna_reconcile_repo_metadata`. Neither
path changes the repo id or its tasks.

Definition resolution reads the exact recorded `origin/<default_branch>`
snapshot. If `origin` exists but that ref does not, resolution fails with the
repo id, branch provenance, and reconciliation guidance; it must not treat a
missing snapshot as permission to fall back to bundled definitions.

## Multi-machine Agent Routing

`kanna-mcp` and `kanna-cli` remain clients of the machine-local
`kanna-server`; agent processes never receive Firebase credentials and do not
connect to the cloud relay themselves. Their shared tool catalog declares
`kanna_list_machines` (`GET /v1/cloud/desktops`) and an optional `machine_id`
on every routable tool. Machine discovery itself and the local-run-bound
`kanna_complete_stage` omit that property. In the CLI,
the same surface is available as `kanna-cli machine list` and
`kanna-cli tool call <tool> --machine-id <id>`. Omitting `machine_id` preserves
local behavior. Both adapters compare an explicit id with the live desktop id
from the local server first: naming the current machine takes the local path
and never requires relay discovery or availability. A different id wraps the
catalog-resolved HTTP request through
`POST /v1/cloud/desktops/{desktop_id}/invoke`.

Those two bridge routes require a real desktop-loopback request
(`DesktopLocalAccess`). A paired LAN client or an inbound relay request cannot
use one trusted desktop as a proxy into the rest of the account. The local
server submits the request through its existing desktop-authenticated relay
socket; the relay resolves that credential to one user and routes only to a
desktop socket registered under the same user. No raw server URL, device
secret, desktop secret, or Firebase token enters the MCP arguments.

The relay connection is also the availability boundary. Machine discovery
always returns the current machine and reports `relayAvailable` plus an error
when sibling discovery is unavailable. Remote calls fail closed when the
target is offline or the relay disconnects. The server enables the bridge only
after `auth_ok` advertises `desktopRouting` capability version 1, so deploying
the desktop ahead of the relay fails fast instead of hanging. That capability is
also the entitlement's: with relay enforcement on, an unentitled account is
advertised neither it nor `tunnelServices`, and a sibling `invoke` sent anyway
is refused with 4402 (`docs/specs/accounts-and-billing.md`, Decision 5). Outstanding and
queued requests are bound to that relay-connection generation and fail instead
of being replayed after reconnect. Task waits retain the normal 240-second MCP
window, with the server-side relay handoff bounded below the MCP client's
300-second tool-call deadline.

Desktop relay establishment — TCP, TLS, WebSocket upgrade, and authentication —
has one 15-second budget. A timeout abandons the socket and enters the normal
five-second reconnect backoff. The local reconnect action races both the
account-auth probe and primary establishment, so it can cancel a connection
that has not reached the established-session loop. While routing is
unavailable, machine discovery preserves the concrete connection reason;
establishment timeout and local cancellation are reported distinctly as
`desktop relay connect timed out` and
`desktop relay connect cancelled by local reconnect request`.

The local `GET /v1/task-events` surface is the account-wide event boundary for
a caller presenting the server's local task-event bearer credential or a
paired device credential. The server creates `task-events.token` beside its
pairing store with mode 0600; task sessions receive only its path through
`KANNA_TASK_EVENTS_TOKEN_PATH`, and Kanna MCP/CLI plus the documented Node
watcher read it and attach `Authorization: Bearer ...` to the local request.
Loopback peer addresses and browser metadata grant no account-wide authority:
an unauthenticated request, including one arriving through DNS rebinding,
receives only the native local feed. When desktop relay routing is available
and `localOnly` is absent, the server starts one native wait for itself and
every active sibling desktop returned by the existing authenticated relay
session. An unpaired LAN caller receives only the native local feed; it cannot
spend the desktop's relay authority or read sibling task metadata. Tunneled
peer waits are marked by the HTTP dispatcher and stay
native, so aggregation cannot recurse. Every aggregated event gains
`machineId`; the `ks1.` cursor binds the scope and connected desktop identity
and carries one opaque native cursor per machine. There is no fabricated
global order across SQLite databases: order is exact within each `machineId`
sequence space.

The server retains unfinished peer long-polls between calls, including when a
caller changes its response limit, rather than cancelling the local receiver
while the peer still holds a long-poll permit. A response larger than the
current aggregate limit advances that machine's native cursor only through the
last event actually emitted; the remainder is fetched on subsequent calls.
Abandoned
sessions expire after ten minutes even if no caller returns, and the registry
holds at most 256 sessions; both expiry and capacity eviction actively abort
their retained legs and buffered payloads. A cursor also retains every machine
observed during the wait. If a known peer is absent or a relay invoke fails,
the response includes a `machineErrors` entry with
`machineId` and `stale: true`, does not advance that peer's cursor, and returns
`waitOutcome: "partial"` when no events are ready. When the peer reconnects,
the next call resumes from that native cursor and catches up wherever the
peer's 14-day retained history still covers the gap. Thus a quiet reachable
peer (no error) is distinguishable from an unreachable peer.

Repository rows are installation-local, so aggregate repo waits never send the
caller's `repoId` to peers. The source resolves it to `repo.remote_url_hash` and
every native sub-wait filters by that hash. `repoRemoteUrlHash` exposes the
same canonical scope directly for a caller that has no local row. A repository
without a remote URL hash cannot be matched across machines and is rejected
while aggregation is active rather than silently becoming local-only.

Native numeric, p1, and p3 cursors remain accepted. A native cursor supplied
as aggregation becomes available initializes the local watermark and starts
new peers from retained history. A server that has no relay route keeps the
native cursor shape and, for an account-wide-authorized caller, adds a
relay-unavailable `machineErrors` warning.
Agent-facing catalog calls set `shortCursor=true`. The server then retains the
full native or `ks1.` checkpoint behind an immutable `kh1.` plus eight-hex-digit
handle for ten minutes after its last use. A fresh handle is issued for every
response, so concurrent resumes cannot rewind one another. Handles are
process-local by design: an expired, evicted, corrupt, or post-restart handle
fails with an instruction to omit the cursor and safely replay retained
history. Callers that omit `shortCursor` keep receiving the deployed stateless
cursor shapes, and numeric, `p1.`, `p3.`, `kc1.`, and `ks1.` inputs remain
accepted; resuming one with short cursors enabled upgrades the response.
`localOnly=true` is the explicit compatibility escape hatch used by adapters
that already own a per-machine fan-in; inbound relay invokes are local-only by
transport provenance regardless of the query.

`kanna_wait_events` retains its earlier MCP-side fan-in behavior. When its
explicit `task_ids` belong to several reachable machines and `machine_id` is
omitted, MCP discovers each task's owner, starts one native cursor wait per
owner, and returns as soon as any owner has events. Every returned event gains
`machineId`. Its legacy `km1.` aggregate cursor records the immutable
task-to-machine grouping plus each server's opaque native cursor. New responses
expose that checkpoint as a process-local `kmh1.` plus eight-hex-digit handle;
old `km1.` values remain accepted and upgrade on resume. An unknown or expired
handle tells the caller to omit it and replay retained history. The MCP process
retains the other in-flight long polls and
reuses them on the next call, rather than cancelling them, abandoning relay
work, or replacing the server event feed with client polling. If MCP restarts,
the aggregate cursor contains enough state to recreate those waits without
losing events. Machine failures are returned in `machineErrors` without
advancing that machine's cursor or discarding events received elsewhere. A 400
that identifies an invalid or expired embedded machine cursor instead
invalidates the aggregate call and gives the cursor-less recovery, rather than
returning a partial continuation that can only fail again.

On every aggregate-cursor resume, kanna-mcp compares the cursor's claimed
`localMachineId` with the live local server identity before using its ownership
map or native cursors. A cursor copied from another machine, made stale by an
identity change, or tampered to relabel the local sequence space is rejected.
Local-versus-remote event routing uses that same live identity, never the
cursor's self-asserted value.

MCP marks each of those native sub-waits `localOnly=true`, so its established
`km1.` sessions do not recursively enter the server `ks1.` fan-in or duplicate
remote events. New `repo_id`, `repo_remote_url_hash`, and `parent_task_id`
calls flow through the local server and therefore use `ks1.` aggregation.
Passing `machine_id` pins any scope to that one machine and returns its native
cursor.
There is no global ordering between independent SQLite sequence spaces;
ordering remains exact within each machine and `machineId` identifies the
sequence space for every aggregated event.

Task discovery follows the same explicit machine model. Recent-task and search
routes accept `allMachines=true`; that response contains `tasks`, with a
`machineId` on every row, plus `machineErrors` so a partial account view is
never silent. Both routes accept `includeClosed=true`. A local task-detail miss
checks reachable siblings and, when the id exists elsewhere, returns an error
that names the owning machine and tells MCP callers to repeat
`kanna_get_task` with that `machine_id`, rather than returning a bare 404.

Repository singleton signals use that authenticated desktop-routing boundary
before local creation. A repository row with `remote_url_hash` is identified
account-wide by that hash plus the singleton agent name; local repository ids
never cross machines. Cloud task snapshots persist the synthetic
`singletonAgent` beside each open singleton, so the relay-backed directory can
name owners whose desktops are already offline. Current publishers also stamp
`singletonDirectoryVersion: 1`; a registered desktop without that stamp makes
directory resolution fail closed until it publishes a current snapshot. The receiving server combines
that directory with its local database and every active sibling's native
lookup; a successful live lookup replaces stale directory state for that
machine. After all three sources prove absence, the requesting server proposes
a task id and atomically creates a relay-owned Firestore claim keyed by
`remoteUrlHash + agent` before it writes the local task. Concurrent first
signals therefore elect exactly one requesting desktop; a loser observes the
winning machine and task and either routes to an already-published owner or
fails closed while that task is still being prepared. Preparation failure
releases only the matching unpublished reservation; a persisted task keeps its
claim. The reservation records a random creator-process fence generated once
by the claiming `kanna-server` and included in both its claim commands and
complete cloud snapshots. The fence survives ordinary relay disconnects and
publication-session rollover, so an empty snapshot after reconnect cannot
clear a claim while the original HTTP request can still persist its task. If
that server crashes after acquisition but before SQLite persistence, its
replacement process publishes a different fence; only a complete snapshot
from that same desktop with the different process fence may clear the
reservation, and only when the proposed task id is absent. A snapshot carrying
the reservation's fence, a snapshot without a fence, or any other desktop's
snapshot is not authoritative for this purpose. Explicit failure cleanup is
also fenced to the creator process and the matching machine/task identity.
Cloud snapshot reconciliation otherwise promotes the matching reservation to a
durable owner and conditionally deletes that claim when the owning open task is
removed, so another desktop's claim can never be overwritten or released.
One remote match receives the message through the existing
task-input route. Two or more open matches are an existing-world duplicate:
resolution logs and returns every `machineId:taskId` owner instead of choosing
one.

Resolution fails closed. A signed-in server that cannot list siblings, cannot
complete any native lookup, or loses the discovered owner before input
delivery returns an error and never creates a replacement. The durable
directory plus successfully observed live owner sets ensure a later signal
still names and refuses an owner that has gone offline; only a successful live
lookup proving that task closed overrides its stale directory row. There is no
implicit takeover. A future takeover surface must be explicitly named and
must durably supersede or close the stranded task when its machine reconnects.
Repositories without `remote_url_hash` have no cross-machine identity and
deliberately keep the original per-machine behavior. A desktop without an
account credential likewise has no sibling namespace; when account routing
exists but is temporarily unavailable, uncertainty is an error rather than
permission to duplicate.

## Task Transfer Transport

`kanna-server` owns the `kanna-task-transfer` sidecar: it spawns the process,
holds its stdin/stdout control plane, and terminates both directions of the
relay. It spawns lazily — on the first control request or on an inbound
task-transfer tunnel — and respawns transparently once the previous child is
observed dead. Before this, the desktop process held the pipe, which made every
transfer depend on an open, signed-in window.

These routes are **not** part of the LAN surface. Unlike the rest of
`/v1/transfers/*`, which a paired LAN device may reach, each one requires a
direct desktop loopback connection (`DesktopLocalAccess`): they initiate
pairing and move tasks between machines, and their pre-move equivalent was
reachable only by whoever held a private stdio pipe.

- `POST /v1/transfers/sidecar/control/{operation}` — one control operation from
  a fixed allowlist (`crates/kanna-server/src/transfer_control.rs`), taking and
  returning camelCase JSON. The route cannot hand the sidecar an arbitrary
  message.
- `GET /v1/transfers/sidecar/events?cursor=...&streamId=...&timeoutSecs=...&limit=...`
  — long-poll of sidecar events, following the `/v1/task-events` cursor
  contract: pass the returned cursor back and nothing fired between two calls is
  missed. Unlike `/v1/task-events`, whose cursor is a durable `task_event.seq`,
  this log is in memory and its sequence restarts at zero with every server
  process — while the desktop that holds the cursor outlives those restarts. So
  a cursor should be sent back with the `streamId` it was issued with: a cursor
  presented alongside a `streamId` naming a *different* stream is discarded and
  answered with `missedEvents`, rather than applied to sequence numbers it never
  referred to. A cursor sent with no `streamId` at all — what a desktop from
  before this field existed sends — is honoured under the original sequence
  semantics instead, because refusing it would mean never pruning: the caller
  would be redelivered the same retained events indefinitely while durable
  entries climbed to the cap and backpressured the sidecar reader, wedging
  control. Absence of the field is not evidence of a stale cursor.
  Single-consumer: a read prunes through the cursor it is given, so exactly one
  desktop process subscribes. This feed carries only *advisory* events —
  pairing progress and remote terminal frames. The four state-mutating events
  (`incoming_transfer_request`, `task_pull_requested`,
  `outgoing_transfer_committed`, `outgoing_transfer_finalization_requested`)
  never reach it: the sidecar's stdout reader appends them straight to the
  transfer engine's durable work queue in this process. A full advisory log
  evicts its oldest entries and says so via `missedEvents`, which it could not
  do while a lifecycle event might be among them.
- `POST /v1/transfers/cloud-proxies`, `DELETE /v1/transfers/cloud-proxies`,
  `DELETE /v1/transfers/cloud-proxies/{peer_id}` — outbound cloud transfer
  tunnels. This cannot ride the server's own relay connection: the relay honours
  `tunnel_request` only from a socket authenticated with a Firebase user
  `id_token`, and the server authenticates as a *desktop* with its device token
  or desktop secret. The signed-in renderer holds the only Firebase credential,
  so it pushes and rotates the ID token through the first route.

Identity and port have one owner each, and it is the desktop: it derives
`transfer_port` into `server.toml` (the same value the inbound tunnel bridge
dials), and resolves `transfer/identity.json`, the peer id, the display name and
the registry directory into the server's environment at spawn. `kanna-server`
forwards all of it to the sidecar and re-derives none of it, so staging and
production keep the distinct ports and per-worktree registries they need to run
side by side.

## Task Transfer Orchestration

`kanna-server` performs the transfer, not just its transport. Push (preflight →
git bundle → artifact staging → insert → commit), incoming record and import
(repository acquisition, artifact materialization, task creation through the
server's own creator, provenance, acknowledgment), approve/reject execution,
outgoing-committed handling (closing the source task through the server's own
close action) and failure reporting all run here.

This is what makes a transfer independent of an open window. Orchestration used
to live in the renderer, elected among windows by a lease/incarnation/phase-claim
protocol whose whole job was surviving that window disappearing — and on
2026-08-06 it did not: ownership was lost before the PTY finalization signal,
the failure report could not be sent, and the commit acknowledgment failed. See
[2026-08-06-task-transfer-rearchitecture-plan.md](2026-08-06-task-transfer-rearchitecture-plan.md).

The engine's steps are rows in `transfer_work`, appended by the same reader
that observes the sidecar event, and drained by one in-process loop:

- A work id is **derived from the event** (`pull:<pull-request-id>`,
  `incoming:<transfer-id>`, `committed:<transfer-id>`,
  `finalize:<transfer-id>`), so a redelivery collapses onto the work already
  queued. At-least-once delivery to a window became exactly-once execution in
  one process.
- A step that must happen at most once — typing into the source agent, closing
  the source task, acknowledging an import — claims a row in
  `transfer_work_phase`. That is the durable form of the sidecar's in-memory
  `claimed_phases`, so a resumed item continues rather than repeating. A step
  whose *answer* cannot be recomputed on a retry — what the source session
  looked like before it was shut down, and whether the shutdown was clean —
  records that answer in the same table, first writer wins.
- Work left `running` by a dead process returns to `pending` at engine start,
  and incoming transfers recorded but not imported are re-enqueued. Before this,
  only `transfer-request` had any restart recovery at all.
- Attempts are bounded and backed off. A transfer that can make no further
  progress is driven to `failed` and its sidecar reservation released, rather
  than retried silently forever.

Clients express **intent**; the engine executes. These routes are ordinary
`/v1/` surface (not `DesktopLocalAccess`-only), so mobile can express the same
intents:

- `POST /v1/tasks/{source_task_id}/actions/push-to-peer` —
  `{peerId, transport?, cloudFallback?, targetDesktopId?, intentKey?}`.
  `intentKey` distinguishes a deliberate re-push from a retried request; the
  response's `scheduled: false` means the intent was already queued.
- `POST /v1/transfers/{transfer_id}/actions/approve`
- `POST /v1/transfers/{transfer_id}/actions/reject-incoming`

Progress reaches the UI through the snapshot's `transfer_status`, which the
sidebar already renders. There is no bespoke event protocol between the engine
and a window, and no window is required for a transfer to complete.

### Source finalization

A push cannot ship a conversation the source agent is still writing to, so the
engine shuts that agent down first — by **typing at it**, not by signalling it
(`transfer_engine/finalize.rs`):

1. inject a wrap-up message through the same two-step input helper every other
   Kanna input path uses (`task_input.rs`: the text as one write, 150 ms, then a
   lone CR so it registers as a discrete Enter);
2. wait for the daemon to report the session `Idle` — `Waiting` is a permission
   prompt, not idleness;
3. inject the provider's quit command (`AgentProvider::quit_command`);
4. wait for the daemon `Exit`, and only then stage artifacts.

Nothing is typed while the session is `Waiting`. Step 3 gets that from step 2 —
it is only reached on `Idle` — but step 1 has nothing in front of it, so the
status the daemon reported at attach is checked before the wrap-up goes out. The
helper's trailing CR is the keystroke that accepts a permission prompt's
highlighted option, so a wrap-up typed at a parked session approves whatever
tool call it is holding, in the operator's name — and silently, because the
agent then resumes, goes idle, quits on cue and ships `cleanlyFinalized: true`.
A session already parked when finalization starts degrades immediately instead;
one that parks mid-wrap-up reaches the same rung through the idle timeout.

The old mechanism was a `SIGINT` and a 1500 ms wait, and it could not work on
any session the daemon had **adopted** through a handoff: the daemon refuses
signals for a child it never forked, because the pid cannot be pinned across
`kill(2)`. Every session older than the running daemon is adopted, so after
every app upgrade no pre-existing task could be finalized. `Command::Input` has
no such ownership check, which is what makes injection the mechanism that works
where signalling cannot (pinned in `crates/daemon/tests/handoff.rs`).

Each step appends `task.transfer_finalizing` to the task event feed with a
`payload.phase`, because a wrap-up is legitimately minutes of latency and has to
read as a transfer rather than as a hung task.

That latency is also why `PeerRequest::FinalizeTransfer` has a request window of
its own. Every other peer request is a machine doing its own local work and
fits the ordinary 15 s window; this one is the destination waiting on somebody
else's *agent* being asked to stop. While the two shared a window, any wrap-up
longer than a few seconds surfaced on the destination as `PeerRequestTimeout`,
which is a retriable import failure — so a normal finalization silently spent
attempts from `MAX_TRANSFER_WORK_ATTEMPTS`, the budget held for a locked
OpenCode store or a dropped artifact fetch. The transfer still completed, off
the finalization result the source caches for the retry that collects it, so
nothing failed loudly; only the retry budget was gone.

`finalization_request_timeout` (10 minutes,
`crates/task-transfer/src/runtime/config.rs`) is what the source is given to
answer. The server's own budget must fit inside it — `WRAP_UP_TIMEOUT` plus
`QUIT_EXIT_TIMEOUT` is 6 minutes, leaving the rest for staging the session
artifacts, and a unit test in `finalize.rs` fails if that stops holding. The
destination allows the same window plus one ordinary request window, so the
source's answer — including its own timeout report — always arrives while the
destination is still listening. Injection failure or a session
that never goes idle degrades the finalization — artifacts are staged as they
stand and the payload carries `cleanlyFinalized: false` with the reason —
rather than failing the transfer. Destructive teardown stays last and stays
*after* staging: it is the source task's own close, once the destination has
acknowledged the import.

A payload arrives from another machine, so everything derived from it is fenced
before it is used: the artifact contract
(`transfer_engine/payload.rs`), the openat/`O_NOFOLLOW`/renameat-no-replace
materialization boundary (`transfer_artifact.rs`), and the git argv fence
(`transfer_engine/git.rs`) — a clone URL is checked against a scheme allowlist
and passed after `--`, because `git clone --upload-pack=…` and git's `ext::`
transport are both remote code execution.

## Agent Runtime Identity

`kanna_info` is a catalog-declared, parameterless client tool backed by
`GET /v1/status`; `kanna-cli info` exposes the same result when MCP is not
available. The result deliberately keeps three identities separate:

- `clientAdapter` identifies `kanna-mcp` or `kanna-cli`; MCP results include
  the adapter's MCP protocol version.
- `connection` is client-owned metadata: the exact effective HTTP base URL the
  client is using and its parsed host/port.
- `serverStatus` is an allow-listed snapshot of authoritative server state,
  environment, build version, safe desktop identity, capabilities, and
  write-path health. `lanAdvertisedEndpoint` separately reports the host/port
  advertised by that server, which need not match the actual loopback or relay
  transport endpoint.

The catalog crate owns the status allowlist shared by CLI and MCP. It never
passes the raw `/v1/status` object through, so `pairingCode`, compatibility
aliases, credentials, database paths, unknown future fields, and arbitrary
HTTP error bodies cannot enter the tool result. If status cannot be fetched or
decoded, the tool retains adapter and effective-connection metadata and sets
`serverStatus.available` to `false` with an explicit error; it does not infer
an environment or version. The server route itself is unchanged, preserving
existing mobile and status consumers.

## Agent Definition Discovery

`GET /v1/repos/{repo_id}/agents` and the catalog-backed
`kanna_list_agents` tool list the definitions that the `agent` field of task
creation can run. Names are invokable directory selectors. Descriptions,
default providers, and default models come from the fully resolved definition:
a repo `AGENT.md` wins over a built-in of the same name, then the repo's
`EXTEND.md` is layered on top. `source` is `built_in`, `repo_override`, or
`repo_authored`; extending a built-in counts as a repo override because the
definition that runs is repo-modified. Definitions whose resolved frontmatter
declares `visibility: internal` — the `commit` and `approve` stage posts and
the purpose-built `architect` consultation role Kanna binds itself — are
omitted from the listing, but still resolve when the
`agent` field names them explicitly: visibility governs listing, not access.

The matching `architect-consultation` workflow is internal for the same
reason: it is a finite manual-stage child contract named explicitly by the
task manager, not a product-work workflow choice. The workflow binds
`architect`; task creation supplies the assessed work item as `parentTaskId`
and the assessed committed branch as `baseRef`. The manager observes its
completion through the MCP wait surface. No singleton or new event loop is
involved. See
[Architect Consultations](specs/architect-consultations.md).

Task creation uses that same resolution path for any agent role, not only
specialty reviewers. An explicit request provider wins, followed by the
definition's provider candidates, then the configured user default when the
definition declares none. Role-specific agents can still fail their own
preconditions—for example, `pr` needs committed task work to publish—but Kanna
does not reject them as first-stage bindings.

## Agent Provider Inventory

A desktop reports which agent provider CLIs it can actually run. Kanna supports
a fixed provider set, but a given Mac usually has only some of them installed,
and a task created for a provider whose executable does not resolve there is
accepted, gets a worktree and a branch, and then never connects — the spawn
wraps a command that does not exist. Any client that offers a *choice* of
provider for a remote machine therefore needs the machine's own answer, not the
registry.

The inventory is computed with the same resolution a spawn uses
(`task_creator::resolve_agent_executable`: process PATH, then the cached
login-shell PATH, then live user install locations), memoized for 30 seconds. It
rides on the payloads that already describe a desktop, so no client needs an
extra round trip:

- `GET /v1/status` → `agentProviders` — what a paired LAN client sees, because
  it learns a desktop through its Bonjour status probe and never reads
  `/v1/desktops`.
- `GET /v1/desktops` → `agentProviders` — the directly addressed LAN desktop.
- the cloud task snapshot's `desktop.agentProviders`, which the relay
  shape-validates and stores on the desktop document — the WAN path, read by
  mobile with the rest of the desktop record.

The field is advisory and its three states are distinct. **Absent** means the
desktop predates the field or the record could not carry it: clients fall back
to offering every supported provider, which is the behaviour that shipped before
inventory existed, so a stale or missing inventory never blocks task creation.
**Non-empty** narrows the offer to that list. **Empty** is a reported answer —
that machine can run nothing — and a client should refuse creation with an
explanation rather than offer a choice that will fail. The relay validates
shape, not provider names: it ships separately from the desktop, and a desktop
that learns a new provider must not need a relay deploy.

Mobile's create-task composer consumes it: options come from the selected
machine, the default is that machine's first available provider rather than a
constant, and a selection made for one machine is re-resolved when the machine
changes or a refresh brings a newer inventory.

## Task Event Feed

`GET /v1/task-events` is the surface an orchestrating agent watches instead of
polling each child. Its outer account feed and each native machine feed are
cursor-based, not snapshot-diffed:

- Event order is `task_event.seq` (`INTEGER PRIMARY KEY AUTOINCREMENT`). SQLite
  allows one writer at a time, so a `seq` cannot be committed out of order.
  Fixed task/repo cursors are a single sequence watermark. Parent cursors bind
  that same global watermark to the parent id; they are constant-size and do
  not contain child ids or membership history. Callers pass back the cursor
  they were given unchanged; events that fire between two calls arrive on the
  next one. The `ks1` server aggregate and `km1` MCP aggregate both wrap every
  embedded native checkpoint in the same `ke1` per-machine envelope. Deployed
  aggregate cursors with bare numeric, `p3`, `kc1`, or short-handle values stay
  accepted and are canonicalized when resumed.
- Omitting the cursor returns the scope's retained history (14 days), so a
  watcher that starts after its children does not lose their early events.
- Events are appended by the same DB writes that change the state they describe
  (`pipeline_item`, `stage_run`), inside the caller's transaction where there is
  one — the log cannot drift from the state.
- The wait blocks inside the server, bounded by
  `kanna_tool_catalog::MAX_WAIT_TIMEOUT_SECS`, so `kanna-mcp` and `kanna-cli`
  each issue one plain GET and neither owns a polling loop.
- `task.awaiting_input` comes from the daemon's `Waiting` session status, which
  is a positive match on a prompt the agent CLI rendered. It is deliberately
  never inferred from a session going quiet; see
  [2026-07-29-awaiting-input-detection-e2e-gap.md](2026-07-29-awaiting-input-detection-e2e-gap.md).
- `task.runtime_settled` is the manager-grade activity signal. It is based only
  on the daemon runtime dimension, never the sidebar's human `read`/`unread`
  state. After transitioning from `busy`, a task must remain `idle`, `waiting`,
  or `exited` for the fixed 10-second server debounce before the event is
  appended; a busy→idle→busy blip inside that window emits nothing. It is unconditional —
  no waiting-prompt snippet, provider heuristic, or worktree timestamp gates
  it. Runtime settling extends the existing `activity_event_debounce_loop` and
  `flush_debounced_activity_events` transaction; there is no second debounce
  worker or snapshot-diff detector. With `includeCurrentActivity=true`, the
  wait is also level-triggered:
  every scoped task whose current non-busy state has already survived that
  debounce is returned immediately as a synthetic `task.runtime_settled`
  response row without consuming or inventing a sequence number. The durable
  sequence checkpoint remains independent, so restart cannot miss parked work
  and synthetic state cannot weaken the append-log ordering contract. Synthetic
  rows share the response limit with durable events. The opaque cursor also
  carries a stable task-id keyset checkpoint: passing it back while `hasMore`
  is true drains every scoped settled task once without an early row replay
  starving later rows. An aggregate cursor additionally records which machines
  still owe a native page, so it cannot report `hasMore: false` before every
  peer continuation has been consumed. Durable events appended during that
  drain remain ordered by, and advance, their own sequence checkpoint.
- `task.awaiting_advance` is appended atomically when an un-killed daemon Exit
  ends a manual-transition main run without a stage verdict. It is useful
  terminal context, but managers use the level-triggered runtime-settled wait
  as the general primitive because an agent can stop at its composer without
  exiting.
- `task.activity_changed` is the provider-neutral settled display transition.
  Every activity direction (`working`, `idle`, or `unread`) is eligible for
  every provider; no waiting-prompt placeholder is required. The server waits
  for `activity_event_debounce_seconds` (20 seconds by default in
  `server.toml`) before appending it. An A→B→A flicker inside that window emits
  nothing, while each value that holds emits once. Its payload contains
  `previousActivity`, `activity`, the authoritative `runtimeState`, and
  `latestRunFinishedWithoutCompletion`; the last field identifies a settled
  idle task whose latest run remains without a stage-completion verdict, so a
  manager can advance it without a private polling/debounce loop. The
  aggregated `ks1.` feed adds `machineId` in the usual way.
- `task.input_delivered` announces a message delivered into a task's agent
  session from outside it. `payload.source` is the caller-declared author
  (`operator`, `manager`, `unspecified`); historical retained events may carry
  the retired `notify` source. `payload.runId` and `payload.stage` are what was
  live at delivery; `payload.preview` is a bounded prefix with `payload.truncated`
  saying whether it was cut. The event is only the announcement — the record is
  the `task_input` row, read through `GET /v1/tasks/{task_id}/inputs`. See
  [Delivered Task Inputs](#delivered-task-inputs).
- `task.input_blocked` reports that a task's agent session started or stopped
  refusing messages delivered into it. `payload.inputBlocked` names the reason
  while it is blocked and is `null` when it clears; today the only reason is
  `inherited-draft-unknown`. See [Refused task input](#refused-task-input).
- `task.teardown_failed` reports that detached best-effort workspace teardown
  failed to start or exceeded its hard deadline. Its payload contains
  `sessionId` and `error`; the same failure is written to the server log.
- `task.transfer_finalizing` reports each step of a cross-machine transfer
  shutting the task's agent down (`payload.phase`: `wrap-up-sent`, `idle`,
  `quit-sent`, `exited`, `already-exited`, `degraded`). See
  [Source finalization](#source-finalization).

Every delivered event keeps event-time fields in the payload. In particular,
`payload.stage` is the stage in effect when the event was appended (older rows
that did not stamp it are reconstructed from preceding immutable task/run/stage
events), and run events keep their own `runId`, status, and result. Delivery-time
state is structurally separate under `payload.currentTask`: current title,
stage, activity, stage transition, and, for finished/awaiting events, latest-run
id/status plus a bounded summary snippet. A manager draining retained history
can therefore distinguish what happened from what it can do now. `machineId`
is present in the payload and at the aggregate row level.

Four scopes, in precedence order: `taskIds`, then `parentTaskId`, then
`repoId`, then `repoRemoteUrlHash`. `parentTaskId` exists because the other two do not cover a fan-out
that lost the ids it created — an id list dies with the context that held it,
and a repo scope hands the caller every other task's events to filter.
It is evaluated per read against `pipeline_item.parent_task_id`, so a task
created or adopted mid-watch is in scope at the next checkpoint. It covers
direct children only and excludes the parent's own events, which makes it
exactly the set `GET /v1/tasks/{task_id}` reports as `childTaskIds`.

`excludeTaskIds` (comma-separated task ids or branch names) is a filter over
whichever scope was chosen, never a scope of its own. It drops those tasks'
durable events and their synthetic `includeCurrentActivity` rows on every
machine leg of an aggregate wait, and it is deliberately not part of any
cursor: a checkpoint issued under one exclusion list resumes under another,
and changing it never trips the scope-switch rejection below. Excluded rows are
consumed by the checkpoint, not deferred — a later call that drops the
exclusion does not replay them. An id that matches no task excludes nothing.
It exists because the repository scope includes the caller: a manager running
`kanna-cli task watch --repo-id` inside its own task session was woken by its
own `task.runtime_settled` edge at the end of every turn, forever. The server
has no notion of "self", so the exclusion is client policy applied once in
`kanna-tool-catalog` (`args_with_self_exclusion`) and shared by `kanna-mcp`,
`kanna-cli tool call`, and the typed `kanna-cli task watch` / `task
wait-events` commands: a repository-scoped wait issued with `KANNA_TASK_ID`
set adds the caller's own id to `exclude_task_ids` unless `include_self` /
`--include-self` is given. Explicit `taskIds` and `parentTaskId` scopes are
taken literally — the former is already explicit and the latter excludes the
parent structurally.

A cursor is bound to its scope. Resuming a `repoId` cursor with `taskIds` or
`parentTaskId` (or vice versa) is rejected with HTTP 400 `cursor belongs to a
different task-event scope`; a watcher that changes scope must start at the
live tail (`from=now`) and cannot carry its checkpoint across. With
`excludeTaskIds` there is no reason for a manager to leave the repository
scope to avoid itself.

Reparenting uses read-checkpoint semantics. Every response advances one global
sequence after evaluating the membership that exists for that read. Moving a
child away and back never rewinds the sequence or replays acknowledged events;
an event after the checkpoint is eligible if the child is back under the parent
at the next read. An event that was outside the scope when an intervening empty
read advanced past it stays ineligible after the child returns. Omitting the
cursor is the explicit way to request retained history for current membership.
The hot query always starts with the indexable `task_event.seq > ?` range and
uses `idx_pipeline_item_parent_created_id` for membership, so an empty long poll
advances past unrelated rows instead of rescanning retained history on every
recheck.

## Delivered Task Inputs

`POST /v1/tasks/{task_id}/input` writes to a PTY. Terminal bytes are not a
record: the message is visible in that live terminal and nowhere else, so every
consumer that reasons from durable state — a review stage running in a forked
worktree with a fresh session, a dispatcher, a post-hoc audit — was structurally
blind to it, and could "prove" from the record that an owner directive it was
told about had never been issued. That happened on 2026-08-19: a round-2 review
agent read the stage prompts, post prompts, and revision feedback, concluded
there had been "no owner send-input at any point", and instructed the
implementer to revert an owner's mid-task design directive.

Every delivery the daemon **accepts** is therefore appended to `task_input`:
the full message text, `delivered_at`, the `stage` the task was on, the
`stage_run` that was running at the time (null when none was), and a `source`.
The row is the record; `task.input_delivered` is only its announcement.

- **Sources.** `operator` and `manager` are **declared by the caller and not
  verified**: the endpoint cannot tell a human typing on mobile from an
  orchestrating agent's MCP call, and a distinction it cannot observe is better
  admitted than invented. A caller may declare `operator` or `manager`;
  declaring `notify` is a 400. Omitting the field records `unspecified`, which
  is what desktop, mobile, and CLI deliveries do. Historical rows may carry the
  retired server-assigned `notify` source, but no new delivery uses it. What
  every record proves regardless of label is that text entered the session from
  outside it, at a recorded time, with the recorded content.
- **Completion is not task input.** The server does not inject completion
  messages into another task's PTY or append completion rows to `task_input`.
  Managers observe completion through `kanna_wait_events` for fan-out or
  `kanna_wait_task` for a single task, backed by durable run and task events.
- **Held deliveries move through a durable FIFO.** The server reserves a
  `queued_task_input` row before daemon submission, bound to the exact child
  PID used by `SubmitInputIfSession` as the daemon-session incarnation fence.
  A held response keeps that row visible; each incarnation-bearing
  `LogicalInputReleased` daemon event transactionally moves exactly the oldest
  matching row into `task_input`, preserving boundaries, source, and order.
  `SessionList.pending_logical_input_count` reconciles missed release events
  only against held rows owned by that same incarnation. A row owned by a
  replaced or exited session becomes `delivery_uncertain`; it is not promoted
  from the replacement's pending count.
- **Interrupted preparation is ambiguous, not delivery evidence.** A server
  restart converts any leftover `preparing` reservation to
  `delivery_uncertain`: the server cannot prove whether the daemon accepted and
  perhaps flushed it before the interruption. A live, exact-incarnation
  `LogicalInputReleased` edge may consume a `preparing` row when it races the
  HTTP held-state update, because that edge itself proves acceptance. Reconnect
  never makes that inference. An uncertain row remains a FIFO barrier for its
  incarnation: later release evidence cannot be attributed past it, because
  the event may describe the ambiguous slot itself. Uncertain rows remain
  sender-visible rather than being expired or discarded silently.
- **Uncertain deliveries are not recorded.** A `delivery_uncertain` response
  means the bytes may or may not have reached the PTY; a row asserting the agent
  was told something it may never have heard is a worse record than a missing
  one, and that path already tells its caller not to retry blindly.
- **Recording never fails a delivery.** By the time the row is written the bytes
  are queued in the PTY, so a DB failure is logged and the request still
  succeeds — answering with an error would invite a retry that duplicates
  terminal input.
- **Full text, no truncation.** Rows cascade with the task and are as short-lived
  as it is. Only the event payload's `preview` is bounded (200 characters, with
  `truncated`), because the event feed is a 14-day wake-up channel.
- **Attachments are the delivered text.** An input with a photo records the
  composed message, which names the stored file's absolute path — see
  [Image attachments](#image-attachments). There is no separate attachment
  field to read, and no record is written for an attachment whose message never
  reached the session.
- **Scope.** This covers `POST /v1/tasks/{task_id}/input`. Stage prompts, post
  prompts, and revision feedback
  are already durable on `stage_run` and are not duplicated here; blocker
  resolution instructions and transfer wrap-up messages are server-generated
  session control and are likewise not recorded. An empty list therefore means
  "nothing was sent through the input surface", not "nothing was ever said to
  this task".

`GET /v1/tasks/{task_id}/inputs?tail=N` returns the most recent `N` records
(default 100, clamped to 500) oldest first, plus `total` — so a tailed window is
visible rather than silent. `GET /v1/tasks/{task_id}` reports
`deliveredInputCount` so a consumer reading only task detail cannot conclude
from it that nothing was ever sent. The review and qa-dispatcher agent
definitions require reading this surface before making any claim about what was
or was not instructed.

## Refused Task Input

A daemon that adopted a session across a restart or handoff never watched that
terminal being typed into, so it cannot know whether an unsubmitted line is
sitting at the prompt. It refuses to submit a logical message into such a
session rather than append to someone else's draft — the guard the
draft-isolation work established, and it is not weakened here.

The session is alive and idle the whole time it refuses, so `activity`,
`runtimeState`, and `readState` all report a perfectly healthy task. That is how
one was found: a finishing task's merge handoff failed against an idle merge
singleton, and the only record of the wedge was inside the failing task's own
stage result.

The daemon now resolves most of these itself, by reading the composer it
inherited rather than waiting for a keystroke (see `crates/daemon/SPEC.md`).
What remains — a composer holding text nobody here saw typed — is a human's
decision about that screen, and it is surfaced rather than discovered:

- `GET /v1/tasks/{task_id}` reports `inputBlocked` (`inherited-draft-unknown`,
  or absent when the session accepts input). The value is written by the
  terminal watcher from the daemon's own `logical_input_blocked`, reconciled
  from `List` against every daemon generation — a session becomes blocked at
  adoption — and updated live from the daemon's `InputBlockedChanged` event.
- `task.input_blocked` announces each edge in the event feed.
- `POST /v1/tasks/{task_id}/input` answers `409` with `reason: "input_blocked"`
  and a message naming what unblocks it. Nothing was delivered, so nothing is
  recorded as delivered, and retrying changes nothing.
- Every server-side delivery that meets the refusal records it on the *target*
  and marks that task `unread`, so a wedged singleton stops reading as idle in
  the sidebar. This includes the pre-close merge-handoff backstop, which
  additionally refuses the close so
  the finishing task parks at its final stage instead of disappearing with an
  un-handed-off PR.

## The Composer Is Not Session Output

A CLI's composer line — the `❯` a Claude session sits at, the `›` Codex draws —
is where somebody is *about* to speak. It is not something the session said,
and the Claude CLI fills it with a tab-to-accept suggestion whenever it goes
idle. Presented as undifferentiated content it reads exactly like a directive:
"run it on my phone so i can see it" was read as one by a task manager and
stalled a task for a day.

So the composer is reported as its own labelled field and is excluded from
every surface that means "what the session said":

- The ordinary human/UI `GET /v1/tasks/{task_id}` view reports
  `composer: { text?, attestation }`. `attestation` is `typed` (keystrokes
  reached that composer since its last producer-declared submission boundary,
  so `text` may be a human's unsent line), `not-typed` (the daemon watched the
  session and counted none, so `text` is provably the provider's own chrome or
  suggestion), or `unknown` (a session inherited from before attestation, where
  nothing can be proven). The field is **absent** until a session reports one,
  which is a different answer from `unknown`.
- `waitingPromptSnippet` (and the deprecated input-only `snippet` alias) never
  contains composer-line text. The
  daemon's snippet extraction cuts at the composer's *position*, not by a
  per-line rule, because a composer long enough to wrap leaves continuation
  rows carrying no prompt glyph.
- The ordinary human/UI `GET /v1/tasks/{task_id}/logs` view keeps the composer line in the rendered tail
  but labels it — `[composer (not-typed), not session output: …]` — because a
  reader deserves to know a composer is there without being able to mistake it
  for transcript.
- Agent tools request `agentView=true`. In that view, task detail omits the
  entire composer field unless attestation is `typed`, and logs remove the
  composer row plus wrapped continuation/hint rows unless it is typed. A typed
  row remains as `[composer draft (typed), not session output: …]`. The bundled
  MCP catalog and CLI read/wait/log paths always select this view, so provider
  suggestions never reach an agent as content.

The values come from the daemon, which is the only thing that knows what was
typed: it publishes `ComposerChanged` on the composer's own edges (a suggestion
appearing, a human starting to type, a boundary clearing the ledger) and
carries the same two fields on `SessionInfo`, so the watcher reconciles them
from `List` against every daemon generation. Raw PTY transcripts are unchanged;
this is a rule about derived surfaces.

The broader meaning and future of `waitingPromptSnippet` is deliberately out of
scope here and tracked by issue #1213. Event delivery never gates on snippet
presence; beyond excluding composer rows, its existing semantics are unchanged.

The same ledger decides whether a delivered message is held — see
"Refused Task Input" above and `crates/daemon/SPEC.md`. Zero typed bytes is
positive proof that no unsent line exists, so the message is written even while
the CLI renders suggestion text; `typed` and `unknown` still hold.

## Task Parentage

`pipeline_item.parent_task_id` is read from both ends: `GET /v1/tasks/{task_id}`
returns `parentTaskId` upward and `childTaskIds` downward. `childTaskIds` lists
direct children oldest first and **includes closed ones** — parentage is
durable, and a finished child is exactly what a fan-out orchestrator reconciles,
so an empty list means "nothing was dispatched" rather than "everything already
finished". This is deliberately unlike `GET /v1/tasks/search` and
`GET /v1/repos/{repo_id}/tasks`, which list open tasks only.

`GET /v1/tasks/{task_id}/children` is the richer join surface for that same
parentage edge. It returns direct children only, includes closed children, and
orders them oldest first. Each item contains `id`, optional `workflowName`,
optional `agent`, `createdAt`, optional `closedAt`, and optional `latestRun`
(`stage`, `kind`, `status`, `summary`, and `finishedAt`). The workflow
identity and latest run let a fan-out owner reconstruct durable child verdicts
after notifications, context compaction, or a fresh agent session; a closed
child remains part of that history because closure is lifecycle cleanup, not
parentage or verdict deletion. This route is scoped reconstruction for one
parent's fan-out/join. It is not a general endpoint for listing closed tasks;
repository task listing and search keep their existing open-task semantics.

## Task State: Runtime and Read Are Two Dimensions

A task carries two orthogonal facts, and conflating them is what made a busy
agent indistinguishable from a finished one:

| Dimension | Field | Values | Source of truth |
|---|---|---|---|
| Runtime — what the agent process is doing | `runtimeState` | `busy`, `waiting`, `idle`, `exited`, or absent | the daemon's terminal-state detection, plus `exited` written by the server when a session ends |
| Read — whether a human has seen the latest output | `readState` | `read`, `unread` | the operator: selection, `mark-read`, and the writes that flag new output |

`GET /v1/tasks/{task_id}` and the task-listing routes report both, alongside
the pre-existing `activity`.

`activity` (`working` \| `idle` \| `unread`) is **kept, unchanged in meaning**:
it is the desktop's derived display value, blending both dimensions, and every
existing consumer — the sidebar, mobile, the event feed, external supervisors —
keeps reading exactly what it read before. What changed is that the two
dimensions it blends are now also reported on their own, because `activity`
cannot answer either question by itself:

- A task working inside a long tool or MCP call, whose latest output nobody has
  read, carries `activity: "unread"` — the same value a finished task carries.
  `runtimeState: "busy"` is what separates them, and it is `busy` for the whole
  call: Claude's `esc to interrupt` chrome stays on screen while an MCP request
  is outstanding.
- A run wedged on a provider error settles to `activity: "idle"` with a running
  `stage_run`, which reads no differently from a task thinking between turns.
  `runtimeState` distinguishes `idle` (parked at its composer) from `exited`
  (the session is gone).

Which dimension each consumer reads:

- **Waits** (`kanna_wait_task`, `kanna-cli task wait`) read terminations only —
  `closedAt`, a terminal `stage_run`, or `runtimeState: "exited"`. `unread` used
  to resolve `until: finished`, which meant an unread working task could satisfy
  a wait for it to finish.

  Know what that costs. Three things record a termination: the task closes, its
  agent records a verdict (`kanna_complete_stage`, or any write that finishes
  the run), or its **process exits**. A PTY agent that finishes its turn and
  parks at its composer without recording a verdict does none of them — its
  daemon session survives, since sessions die only at a stage transition, a
  rerun, or a close — so it reports `runtimeState: "idle"` with a `running`
  `latestRun`, and `until: "finished"` does not resolve for it. `unread` used to
  resolve that case, at the cost of also resolving on every busy task nobody had
  read.

  This is deliberate: a parked agent has not finished, and a wait that says it
  has is the defect this predicate was changed to remove. But a caller that
  waits on an agent which may park without a verdict — the specialty-review join
  in [qa-dispatch-review.md](specs/qa-dispatch-review.md) is the one in-tree
  case — must carry its own bounded terminating condition rather than looping on
  `waitOutcome: "timeout"` forever. The signature to bound on is a
  non-`busy` `runtimeState` alongside a `running` `latestRun`.
- **Supervisors and orchestrators** read `runtimeState` to decide whether a task
  is alive. A quiet-task alarm keyed on `activity` fires on tasks whose agents
  are demonstrably running.
- **The desktop sidebar and mobile** read `activity`: the operator's view is
  exactly the blend, and it is unchanged.

`runtimeState` is stored on `pipeline_item.runtime_status`. `exited` is written
when a task's daemon session exits without a replacement — the same signal that
finalizes the run, so it never fires
for the orchestrated kills behind a stage swap, rerun, or close. Starting a new
running `stage_run` clears a stale `exited` back to absent, so a fresh session
is never reported as already gone.

## Activity Confirmation in `kanna-mcp`

`pipeline_item.activity` is written from the daemon's rendered-terminal
verdict. ANSI control bytes are interpreted before provider patterns are
matched, and a DEC synchronized-output redraw is not classified until the
provider closes the frame. Intermediate spinner, status-line, and update-banner
paint therefore cannot publish a false status or consume the classifier's
per-session throttle slot. The daemon's periodic settled-frame check is
independent of output-triggered throttling, so chrome repaints cannot starve
convergence to an idle composer. Within a complete frame the provider matcher
is stateless: `claude_status_from_lines` still decides Busy from the literal
"esc to interrupt" marker without inventing a quiet-time heuristic.

`kanna-mcp` smooths that at the point of consumption, asymmetrically:

- A response with nothing stopped-looking in it is returned as-is. Reporting
  busy promptly is never the misread being guarded against.
- A stopped-looking response is re-read once after `ACTIVITY_CONFIRM_DELAY`
  (1s, two daemon detection windows), and the fresher response is what the
  caller sees.
- The confirmation reports whatever it finds and never rewrites one activity
  value into another, so the three-way vocabulary is unchanged and `unread`
  keeps meaning "output nobody has read yet" rather than "stopped" — a busy
  agent can carry `unread`.
- A closed task is exempt: closure is a database fact, not a frame
  classification.
- **A failed confirmation is not a confirmation.** If the re-read fails, the
  tool call fails with a message saying the stop went unconfirmed. Returning the
  unconfirmed first sample instead would surface the exact false stop this
  exists to suppress, and `kanna_wait_task` would resolve on it.
- It smooths Busy/Idle only. `waiting` stays a positive match on prompt chrome
  in the daemon; nothing here turns quiet into blocked.

Which tools pay, and how much — the cost is always one extra `GET` of the same
route plus 1s, never one request per task:

| Tool | When the confirmation fires |
|---|---|
| `kanna_get_task` | Only when that task already looked stopped. |
| `kanna_wait_task` | Never. Its predicate reads recorded terminations, not `activity`, so there is no frame classification to confirm. |
| `kanna_list_recent_tasks`, `kanna_search_tasks`, `kanna_list_repo_tasks` | Whenever **any** task in the response looks stopped. For a repo listing that is the common case, so budget these at roughly +1s per call regardless of how many tasks come back. |

The current task row is not debounced: it always stores the daemon's latest
complete-frame verdict. `task.activity_changed` events use the server debounce
described above, delaying rather than dropping a candidate transition until it
holds. `kanna-cli` does not perform the MCP confirmation read — it is the shell
interface, where a human reads the current value in context.

## Dynamic Workflow Changes

`POST /v1/tasks/{task_id}/actions/set-workflow` and
`kanna_set_task_workflow` replace an open task's current workflow name and
`pipeline_def` snapshot atomically. Resolution and serialization use the same
pinning path as task creation, including repo overrides, legacy snapshot
normalization, and retired built-in aliases (`default` resolves to
`no-review` unless the repo still defines `default.json`).

Stage mapping is deliberately strict: the new definition must contain a stage
whose name exactly matches the task's current stage. The task stays at that
stage. If it is absent, the request returns `409 Conflict`, names the
incompatible stage and workflow, and changes nothing. Kanna does not guess a
nearest stage because that could silently skip or repeat work.

A running `stage_run`, terminal session, branch, and worktree are not replaced
or killed. The live run finishes normally, and the new snapshot governs its
next transition. `revision_rounds` also remains unchanged; switching to a
higher `revision_limit` can therefore make more rounds available, while
switching to an equal or lower limit cannot reset spent rounds. A successful
change emits `task.workflow_changed` with the old and new names, current stage,
spent rounds, and new limit.

## Sticky Workflow Selection

`GET /v1/repos/{repo_id}/recent-workflows` backs the New Task modal's default
workflow: a repo's most recently used workflow outranks the one its
`.kanna/config.json` configures. The caller keeps the first returned name its
repo still offers and otherwise falls back to the configured default, so a
renamed or deleted workflow degrades instead of sticking.

It is a projection of the durable `pipeline_item.initial_pipeline` values, not
a mutable preference. That column captures the successfully created task's
choice and is intentionally not changed by dynamic re-pipelining:

- **No `closed_at` filter.** `db::snapshot` excludes closed tasks, so a create
  whose response was lost and whose task then closed — possibly from another
  window — would be invisible to a snapshot-based answer. The row is what
  matters, and the row survives the close.
- **No recovery record to reconcile or clear.** A create either commits its task
  row or it does not; there is no second write that can fail on its own and lose
  the choice, and nothing to publish after the fact.
- **Every writer feeds it, every reader agrees.** Any path that creates a task —
  desktop, LAN/mobile, relay — updates it without being instrumented, and all
  windows and restarts read the same rows.
- **Child tasks are excluded** (`parent_task_id IS NULL`). A specialty review a
  review stage dispatched is not a workflow the operator picked.

## Task Completion Observation

Task completion is observed through the existing MCP wait surfaces:
`kanna_wait_events` for fan-out and `kanna_wait_task` for one task. The durable
facts are the terminating `stage_run`, its `run.finished` event, `task.closed`
when applicable, and task detail. Kanna does not inject completion text into a
manager task's PTY; that input channel is reserved for actual operator and
manager speech.

The structured status vocabulary remains closed — three words, matched exactly:

- `success` — the task ended cleanly: it advanced past its final workflow stage,
  or its session ended with no failing verdict recorded against it.
- `failure` — its terminating `stage_run` reported failure, or the agent process
  itself died (non-zero exit). A verdict of failure wins even when the PTY then
  exits 0, because an agent that reports failure and quits still failed.
- `closed` — the task was closed before finishing its workflow (sidebar ⇧⌘⌫ or
  `POST /v1/tasks/{task_id}/actions/close`). No verdict was ever reached; this is
  not a failure and must not be diagnosed as one.

Daemon `Exit` finalizes activity/runtime state and any running `stage_run` in
the same server-side path regardless of whether a desktop event bridge is
open. An interrupted run's structured result keeps `success` or `failure` as
appropriate; a direct close is `closed`, while a normal workflow finish keeps
the successful terminating run. The account-wide event feed preserves these
facts across machines.

The legacy SQLite columns `pipeline_item.notify_task_id` and `notified_at`
remain readable for database/snapshot compatibility but are inert. The
creation field is deprecated and rejected when non-null, the set-notify route
and `kanna_set_task_notify` tool have been removed, and existing values are
never claimed. Historical `task_input` rows and `task.input_delivered` events
whose source is `notify` remain part of the audit record; no new ones are
written.

## Merge Handoff

The generic repo-agent signal endpoint, task-input API, desktop task terminal,
KSP/relay steering, and the approve-post helper all deliver ordinary requests
to the `merge` singleton. The resolved repo agent definition independently
accepts or declines each request under the repository's checked-in policy.
Kanna does not interpret review history, bind a saved PR candidate, police
branch names, or attach an approval attestation.

The approve-post helper resolves the task's repository and sends this compact
ordinary request through the same singleton signal path:

```text
MERGE <head> -> <base> [TASK <task-id>] [PR <url>]: <summary>
```

**The handoff is the engine's obligation, not the post agent's memory.** A post
is injected into whatever agent session its stage left running, so a pr agent
that was still mid-work when the approve post arrived reads the post prompt as
its next instruction — it creates the PR, reports that, and never signals. That
happened to four consecutive review-bearing tasks on 2026-08-07, each of which
then closed leaving an open PR the merge master had never heard of.

So delivery is recorded, not assumed. `signal-merge-handoff` stamps
`pipeline_item.merge_signaled_at` *after* the request reaches the merge agent
and appends `task.merge_signaled` (`payload.source`: `agent`). Before closing a
task past a final stage whose pinned workflow declares the merge-signaling
`approve` post, the engine checks that stamp and, if the task still owes a
request, composes and delivers the identical line itself from the recorded
`pr_url` (`payload.source`: `engine`). The head branch comes from the
workspace's live branch, since the pr agent renames what it pushes; the target
is the repo's default branch. Both are hints — the merge agent resolves the
live PR and applies the repository's policy, exactly as for an agent-sent
request. Kanna still attests nothing.

If such a stage finishes with no `pr_url` at all there is nothing to hand off,
which means the approve post reported success without producing the PR it
exists to approve. The engine refuses the close: the task stays open at its
final stage, goes `unread`, and emits `task.merge_handoff_missing`. A watcher
must read that as a failed approval, never as a finished workflow.

A workflow whose final stage declares no `approve` post promised no merge side
effect, and nothing is enforced on its behalf — the same rule the desktop's
approval UI uses (`pinnedApproveMergePost`).

New merge sessions accept ordinary terminal input. On startup and after daemon
replacement, kanna-server clears the retired native-terminal-only
classification from inherited PTYs so older merge singletons also use the
normal input path. This compatibility cleanup is unrelated to daemon process
handoff and descriptor transfer, which continue to preserve PTY sessions
across desktop/server/daemon restarts and upgrades.

The native desktop still uses a private Unix control socket for desktop
adoption. Peer eligibility is checked before reading a request, and the initial
request frame has a fixed deadline so idle or unauthorized local connections
cannot retain server tasks and descriptors indefinitely.

Stage completion is bound to the run id fixed in the spawned agent's protected
environment and an immutable run-scoped completion-context file. A successor
gets a distinct file, so preparing it never publishes an identity to the live
predecessor. Continued posts rebind only the inherited process's file, under a
cross-process lock, while retaining a bounded mapping from verdict attempt keys
to their original runs. MCP and CLI adapters consult that mapping. At startup,
the server compiles the prior run-scoped format from its immutable filename and
the original run's durable exact result; request handling repeats that
server-owned check so a surviving old unlocked adapter cannot overwrite the
protection. A timed-out original verdict therefore retries its original run
and can neither complete the post nor restore stale context. Failed preparation,
replacement, close, and startup prune stale or orphaned context artifacts. The
server rejects a mismatched current run but treats an identical retry of an
already-finished run as idempotent even after a post or replacement starts. For
rolling upgrades, `runId` may be omitted only for a pre-upgrade run whose
durable `completion_bound` bit is false, and new clients tolerate old task-detail
responses that lack `latestRun.id`.

## Mobile Task Worktree Browser

The mobile file browser exists only in task context and resolves its root from
the task's current durable worktree record. It does not browse a repository's
main checkout and exposes no repo-level browse route. A stage advance therefore
makes subsequent requests follow the task into its newly recorded worktree.

`GET /v1/tasks/{task_id}/browse` lists one bounded directory page (`offset`,
`limit`, `filter`, `showAllFiles`).
`GET /v1/tasks/{task_id}/browse/content` reads one bounded line range
(`startLine`, `lineCount`, `metadataOnly`); metadata ranges contain line lengths
for skeleton sizing, while content ranges contain text for the same viewport.
The server caps directory pages, line counts, and returned text bytes regardless
of caller values. Binary files are identified without returning their contents.

Both routes require either a paired LAN device or an authenticated relay
invoke. Relay invokes remain behind `remote_task_control`; LAN access is free.
The relay's byte odometer attributes browse invokes and responses to the
dedicated `fileBrowse` class. Every requested root and target is canonicalized,
and a target whose resolved path leaves the worktree root is rejected, including
symlink escapes. The surface is read-only: there are no write, delete, download,
git, or search-in-files operations.

## Mobile Notification Delivery

`POST /v1/mobile/notifications` hands every validated notification to the
desktop-authenticated relay connection, regardless of active paired LAN/KSP
streams. LAN streams are not a notification transport: iOS can suspend a
backgrounded app while its socket still appears writable, so a socket write
cannot prove that a notification was displayed. The relay looks up only that
Firebase user's `pushDevices`, submits one FCM multicast, removes tokens rejected
per-device as `messaging/invalid-argument`, invalid, or unregistered, and
acknowledges the request over the same WebSocket. A payload-wide invalid
argument rejects the multicast call itself rather than appearing as one
device's result.
The server response includes `status` (`accepted`, `deliveryFailed`, or
`noRegisteredDevices`), `acceptedCount`, `failedCount`, and aggregated
`failureReasons`. Each reason has a safe provider code, category, count, and
actionable message; it never identifies a device or includes its token, the
Firebase provider's uncontrolled raw message, credentials, or notification
contents. Older relay acknowledgements without `failureReasons` deserialize as
an empty list during rolling upgrades.

### Zero-device results explain themselves

`noRegisteredDevices` is never a cached value: every call makes the relay
resolve the account's live `pushDevices` registrations (unioned with the
desktop's active anonymous bindings on a dual-identity session). When that
resolves to zero devices, the response carries `noDevicesReason`, read from the
account's registration records:

| `code` | Meaning | Extra fields |
|---|---|---|
| `neverRegistered` | No push device has ever registered for this account. | — |
| `unregistered` | The mobile app retired the last registration (sign-out, or an effect cleanup). | `retiredAt` |
| `tokenRejected` | The push provider rejected the last token as invalid, so the relay retired it. | `retiredAt`, `providerCode`, `retiredByDesktopId` (the desktop whose delivery met the rejection — often a *different* desktop on the same account) |
| `unknown` | The registration was retired before the relay recorded why. | `retiredAt` when known |

Every reason carries a `message` that tells the operator what to do (open Kanna
on the phone while signed in; the app re-registers on launch). The field is
absent when a relay predating it answers, and absent whenever a device was
targeted. Token values never appear in any response or log.

The relay makes this possible by retiring registrations instead of deleting
them: `POST /push/unregister` and the invalid-token reconciliation after a
multicast both keep the `pushDevices` document with `token: null` plus
`retiredAt`, `retiredReason`, and (for rejections) the provider code and the
delivering desktop id. A registration replaces the whole document, so a retired
record disappears the moment the phone registers again. The relay logs each
registration, each unregister outcome (`retired`, `stale`, `alreadyRetired`,
`absent`) with the guard it applied, each provider-rejection retirement, and
each zero-target delivery, always without the token.

### Registration ids make unregister safe

Every mobile registration carries a client-minted `registrationId`, and the
phone's unregister names the id it is retiring. The relay retires only that
registration; a newer registration of the same device — even with the same FCM
token — is left alone (`outcome: "stale"`). Token matching remains the guard
for phones that predate the id, and an unregister with neither retires the
registration unconditionally, as before.

This closes the drop found on 2026-09-03 (task 34047a85): the mobile push
effect re-ran three times in 700 ms as its dependencies settled, each cleanup
fired an unregister for the previous registration carrying the same token the
new run had just re-registered, and the last unregister to land deleted the
live row. On the phone, account registration is now a serialized desired-state
reconciler per device: a cleanup and the next run's registration apply in
order, a failed registration is retried with backoff instead of being
remembered as registered, and a `401` forces a fresh id token on the retry.

### Registration status probe

`GET /v1/mobile/notifications/registration` answers whether the signed-in
account currently has a registered push device, for the desktop's Mobile
Access panel. It uses the distinct `mobile_notification_probe` relay message:
the relay resolves exactly the targets
a real `kanna_notify_mobile` would reach and explains a zero-target result,
without sending, touching delivery watermarks, or spending anonymous rate-limit
budget. The response is `status` (`registered`, `noRegisteredDevices`, or
`unavailable`), `registeredDeviceCount`, and the same `noDevicesReason` on a
zero result (`error` on `unavailable`). The relay advertises the dry run as
`mobileNotifications.version` 2 in `auth_ok`; against a version-1 relay the
server refuses the probe as `unavailable`. The separate wire type also ensures
an older relay cannot mistake a probe for a real push if capability negotiation
regresses. A signed-out desktop's lazily connected anonymous session refuses
it, because the probe is about the account.

`kanna-server` logs every notification outcome — `accepted` with counts,
`deliveryFailed` with the aggregate reasons, `noRegisteredDevices` with the
reason code and its fields, and a relay failure — so a result that changes
between two calls leaves a trace on the desktop that sent it.

Push delivery presents through the operating system while the mobile app is
foregrounded or backgrounded and can reach a suspended or terminated app. It
does not depend on a live app socket. Tapping a versioned task notification
opens its desktop-scoped task whether the tap launches the app or reaches an
already-running app.

The diagnostic categories distinguish invalid tokens, relay IAM permission,
Firebase-project mismatch, APNs credentials, payload validation, rate limits,
temporary provider failures, and an unknown-provider fallback. A
`messaging/mismatched-credential` response whose provider text specifically
reports `cloudmessaging.messages.create` denied is classified as
`relayPermission`; other occurrences remain `firebaseProjectMismatch`. Relay
logs record only the desktop id and these same aggregate safe reasons.

Push registration is one replaceable document per mobile device id. Every app
launch registers the current FCM token and token-rotation callbacks replace it;
an unregister identifies the token it observed so delayed cleanup from an
older app lifecycle cannot delete a newer registration.

If the Firestore lookup or Firebase Admin call rejects as a whole, there are
no per-device results to diagnose. The relay discards the exception rather
than serializing it: its log and WebSocket acknowledgement contain only the
fixed `relayDependency` category and an opaque incident id. The
acknowledgement's `error` field is nevertheless untrusted at the
`kanna-server` boundary and is ignored. `kanna-server` substitutes its own
fixed, categorized `relayRejection` diagnostic and server-owned correlation
value in the `503 Service Unavailable` body/error, so HTTP, CLI, MCP, and
mobile consumers never receive the relay string or the provider's raw
response, project or credential diagnostics, or token material. The
server logs and the `503 Service Unavailable` body carry the
server-owned `category=relayRejection` and correlation value. Relay logs
independently carry `category=relayDependency` and an opaque incident id; the
server correlation and relay incident id are not shared. Operators join the
two records using the desktop id and time window. During a rolling upgrade
this boundary also sanitizes
rejection acknowledgements from an older relay that still serializes raw
provider exceptions.

## Local Consumer Model

The desktop app starts `kanna-server` and supplies its config.
Local mobile development points the React Native client at the LAN URL exposed by `kanna-server`.
Consumers such as `kanna-cli` and `kanna-cli mcp serve` target the same route surface so product behavior stays consistent across clients.
The CLI remains the shell/script interface; MCP is the structured agent-tool interface.

## CLI Task Actions

- `kanna-cli task send-input --task-id <TASK_ID> --message <MESSAGE> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/input`. Input is accepted only for an active daemon PTY session, fenced to the PTY process ID observed before acceptance while the server holds the task lifecycle lease. The daemon may retain it behind an active human draft, but never for a later run or stage. A successful acknowledgement prints `{ "ok": true }`; an absent or concurrently replaced session returns HTTP 409 with `reason: "no_live_agent_session"`, the latest run status/finish time when available, and explicit `kanna_resume_task` / `kanna_rerun_stage` recovery guidance. If the acknowledgement is lost after acceptance, the server reports uncertain delivery so callers do not retry blindly.
- `kanna-cli task advance-stage --task-id <TASK_ID> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/actions/advance-stage` and prints the action response as JSON.
- `kanna-cli task signal-merge --task-id <TASK_ID> --branch <HEAD> --target <BASE> --summary <SUMMARY> [--pr-url <URL>] [--server-url <URL>]` sends an ordinary request to the repository's merge agent.
- `kanna-cli task resume --task-id <TASK_ID> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/actions/resume`. It accepts a latest `cancelled` or `failed` run whose daemon session is dead. It also accepts a latest `running` run only after a daemon `List` proves the run's recorded session is absent; the desktop uses that form when an attach after restart discovers a session lost with the old daemon. It resumes the provider conversation when its durable transcript and original worktree pass the shared revision-resume checks; unsupported or missing provider context starts fresh and records `resumeFallbackReason`, while task-state precondition failures return an explanatory conflict. A present session returns a conflict for a running run and restores a false interruption for a previously interrupted run, so the route never creates a duplicate provider process. An empty route-level 404 identifies an older server that does not provide the action. Callers may use `rerun-stage` when recovery is unavailable or a deliberately fresh conversation is acceptable.
- `kanna-cli task rerun-stage --task-id <TASK_ID> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/actions/rerun-stage`. This is always an explicit fresh provider conversation, not recovery.
- `kanna-cli task children --task-id <TASK_ID> [--server-url <URL>]` calls `GET /v1/tasks/{task_id}/children` and prints the direct-child history as JSON. It is the typed no-MCP fallback for `kanna_list_task_children`, so it reproduces the route's field set rather than summarizing it.

The provider support and daemon-loss trigger matrix is documented in
[`2026-07-30-session-death-recovery.md`](2026-07-30-session-death-recovery.md).
