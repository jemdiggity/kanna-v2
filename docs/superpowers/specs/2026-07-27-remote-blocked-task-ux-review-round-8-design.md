# Remote Blocked Task UX Review Round 8 Design

## Goal

Close the eighth review round without weakening the blocked-task UX, local task
behavior, terminal routing, task read-dwell, file links, or ownership transfer
recovery.

## Architecture

### Rendered cloud journey

The existing development-only remote snapshot injection already writes the
production cloud snapshot ref and advances its authoritative generation. The
WebDriver journey will run once with a LAN snapshot and once with a cloud
snapshot. Both variants verify Blocked placement, blocker detail, Cmd+S
suppression, unblock, and a surfaced owner-action failure. A development-only
one-shot action failure seam supplies the cloud relay rejection without
requiring Firebase credentials or a live relay; the production projection,
keyboard guard, action selection, and toast path remain real.

### Restart-bound privileged requests

Each task-transfer owner runtime generates a random authenticated-request epoch
at startup. Before sealing a privileged operation, the requester obtains that
epoch through a live, request-id-correlated owner challenge. Every sealed
snapshot, terminal-observe/input/resize, close, advance, task-file-read, and
mark-read payload binds the returned epoch. The listener compares that value
with its in-memory epoch before reserving replay state or invoking an adapter.
A sealed request captured before an owner restart therefore cannot run after
restart even though the owner's long-lived encryption identity persists. The
challenge is fetched per operation, so stale discovery metadata cannot
re-authorize a replay and no per-keystroke durable write is needed. Observer
leases are rechecked before the challenge round trip so displaced observers
still never reach the peer. The existing memory-only bounded replay window
remains sufficient for high-frequency traffic and close/advance retain their
durable duplicate records.

### Relay binary backpressure

Task-transfer tunnel directions maintain bounded forwarding state. When the
destination WebSocket crosses a high-water mark, the relay pauses the source;
it resumes only after send callbacks observe the low-water mark. Before every
send, `bufferedAmount + frameBytes` is checked against a hard cap. Overflow or
send failure closes both tunnel halves with an overload error. KSP routing keeps
its existing message behavior. A real-WebSocket slow-consumer regression
records the destination queue high-water and proves it never exceeds the cap.

### Coherent remote authority

Cloud documents are grouped by stable cloud task id before mapping. One winner
supplies the item, owner, terminal ref, revisions, blocker set, and transfer
metadata; no map written by a losing duplicate can overwrite it. Transfer phase
orders destination `finalization_pending`/`incoming` over source `outgoing`,
then freshness and deterministic identity break ties.

Workspace projection similarly chooses one candidate. Local ownership always
wins. For equally fresh publications of the same owner task, LAN remains
preferred to cloud. A newer activity/blocker/transition revision wins as one
unit, including its route. When owner task identity changes during transfer,
the newer/advanced authority wins regardless of route, and equal-route
candidates replace an older displaced owner. Sources remain attached only for
diagnostics and remote-id lookup; rendered and action fields all come from the
selected authority.

### Durable lifecycle serialization

Authenticated LAN close delegates to the Kanna server
`/v1/tasks/{id}/actions/close` endpoint. Close therefore shares the durable-id
mutation lease with advance, block/unblock, complete, and session replacement,
and uses the canonical teardown/notification/dependent-unblock flow.

Outgoing import-commit receipts gain an explicit delivery-in-flight state.
Dequeuing an event claims its transfer id; the retry ticker cannot queue it
again until the desktop explicitly applies or nacks it. The desktop listener
applies only after close and transfer completion finish, and nacks on failure.
Nack releases the claim without immediately requeueing; the bounded retry
ticker schedules the next delivery. In-flight state is intentionally
memory-only so a sidecar crash replays durable unapplied work.

### Staged compatibility and capability negotiation

Legacy device-token server connections receive publication generation leases
after their token is revalidated against the same account. This compatibility
mode is advertised in `auth_ok`, uses the same generation fencing and snapshot
validation as desktop-secret publication, and can be removed after the
desktop-secret migration window.

Direct LAN KSP uses endpoint epochs: `/v1/stream` remains the legacy empty-auth
endpoint for deployed mobile clients, while current mobile clients use
`/v2/stream`, which requires paired-device credentials. Relay KSP remains
explicitly authenticated out of band.

Relay `auth_ok` advertises supported tunnel services. The cloud transfer proxy
requires an advertised `task-transfer` service before sending a tunnel request.
A previous relay whose `auth_ok` omits capabilities is rejected before any KSP
tunnel can be misused as task transfer.

## Error Handling

Epoch mismatch, unavailable task-transfer service, relay queue overflow, and
receipt nacks return explicit retryable errors. Legacy publication remains
account-scoped and generation-fenced. Compatibility endpoints do not change
the authenticated current-client path.

## Testing

- LAN and cloud WebDriver blocked-task journeys.
- Hostile owner-restart replay of snapshot, observe/input/resize, file read,
  mark-read, close, and advance.
- Slow relay task-transfer consumer with a capped queued-byte high-water.
- Overlapping outgoing/incoming cloud documents and cloud/LAN workspace
  advertisements with displaced ownership.
- LAN close delegated to the server plus durable-id lease races.
- Delayed close exceeding the receipt retry interval with one completion.
- Previous server/current relay publication.
- Previous mobile/current server KSP.
- Current cloud proxy/previous relay capability contract.
- Focused frontend/Rust/relay suites, desktop build/typecheck, `pnpm test`,
  canonical practical JavaScript verification, formatting, and diff checks.

## Replacement PR Handoff

This branch supersedes GitHub PR #921 (`feat/remote-blocked-task-ux`). It keeps
the blocked-task UX while resolving the newer cloud snapshot, task-transfer,
workspace authority, lifecycle serialization, and compatibility boundaries
listed above. Verification evidence for the replacement branch includes:

- `pnpm test` (all 14 workspace tasks passed; desktop 1405, mobile 1291, relay
  90 tests);
- desktop production build/typecheck;
- LAN and cloud WebDriver blocked-task journeys (2 passed);
- the full `kanna-task-transfer` test suite (79 runtime tests plus protocol and
  sidecar contracts);
- focused Kanna-server mutation/KSP, desktop relay compatibility, relay
  integration/backpressure, mobile LAN transport, frontend workspace/App/store,
  formatting, and diff checks.
