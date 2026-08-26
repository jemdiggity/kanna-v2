# Cross-machine event waiting: remaining E2E and protocol gaps

2026-08-16. Written with the server-side multi-machine
`GET /v1/task-events` aggregation.

The implemented path makes the connected `kanna-server` the event boundary.
It fans native cursor waits through the existing desktop-authenticated relay
session, tags peer events with `machineId`, maps repositories by
`remote_url_hash`, retains per-machine cursors across disconnects, and reports
known unreachable peers in `machineErrors` without advancing their cursors.
The task-manager's direct background HTTP watcher can therefore observe peer
work without owning a relay credential or waking the model on empty polls. A
local owner-only credential file explicitly authorizes that aggregated read;
loopback addressing and browser metadata do not grant cross-machine access.

## Account inventory gap

The relay's `list_active_desktops` command returns live sockets, not the
account's durable desktop registry. A `ks1.` cursor remembers every machine it
has observed and can report one of those machines stale after it disconnects.
On a brand-new cursor started while a sibling is already offline, however, the
server cannot name that never-observed sibling. It still returns a
relay-unavailable error when discovery itself is down, but it cannot produce a
per-machine error for an identity the current relay protocol did not reveal.

Closing this gap requires a versioned relay capability that lists the
authenticated user's registered desktop ids plus live/offline state. It must
use the existing desktop-secret account boundary; no Firebase credential or
new cross-account authority should enter `kanna-server`. Once available, the
server can seed `ks1.machineIds` from that durable inventory and report every
offline desktop on the first call.

## Completion observation

2026-08-26 — The same-machine completion-input mechanism described by the
original note was retired. Managers observe local and remote child completion
through the aggregated durable task-event feed; Kanna no longer injects
`TASK <id> DONE [...]` text into a manager's PTY. The legacy
`notify_task_id`/`notified_at` columns remain inert for database compatibility.

## Coverage added and full-system remainder

`kanna-server`'s two-state HTTP integration tests connect two independent
SQLite-backed `AppState` instances through the real desktop-relay request
queue and authenticated tunneled HTTP dispatcher. They prove:

- explicit task and parent scopes find a task that exists only on the peer;
- repo scope matches equal remote URL hashes across different repo ids;
- peer events emerge from the source server with the peer `machineId`;
- a peer event created while disconnected is delivered after reconnect from
  the retained native cursor;
- the stale interval produces a visible per-machine error; and
- aggregate output exactly equals the peer's native feed with no duplicate or
  missing events.

Narrower regressions also run the documented Node `fetch` watcher against a
live HTTP listener with the mode-0600 credential, prove requests with no
browser headers or same-origin metadata remain local-only without it, model a
peer's one-permit long-poll budget across aggregate limit changes, and verify
an oversized peer batch advances its cursor only through the events actually
emitted.

This is causal cross-boundary coverage inside the server process, but it does
not boot two signed-in `kanna-server` binaries against the relay emulator. The
existing remote-E2E harness still models one desktop plus a mobile-shaped
client. A final process-level test needs the harness to register two desktop
secrets under one emulator user, boot two isolated server/daemon/DB/port roots,
disconnect and reconnect one real relay WebSocket, and drive the source's LAN
`/v1/task-events` endpoint. When the durable desktop-inventory capability
exists, that test must also begin while the second desktop is already offline
and assert its identity appears as stale on the first cursor-less response.

## Known limitation: legacy-p1 continuation vs deployed peers

2026-08-16 — Finding: a truncated remote p1 continuation is unreadable by an
already-deployed peer; Compatibility FAIL, review child 4cfd4046, round 6.
Jeremy accepted this limitation for the current single-operator fleet because
the error is visible and fail-closed, with duplicate wake-ups as the worst
case. If the user base grows, drain legacy-p1 legs fully within the bounded
batch instead of truncating them, eliminating the continuation artifact.
