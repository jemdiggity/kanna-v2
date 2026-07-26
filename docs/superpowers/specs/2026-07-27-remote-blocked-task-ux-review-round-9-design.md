# Remote Blocked Task UX Review Round 9 Design

## Goal

Resolve the ninth review round's six security, performance, compatibility, and
concurrency findings without regressing remote blocker projection, terminal
routing, read dwell, file links, or local task behavior.

## Architecture

### KSP ingress and compatibility

Both direct LAN stream epochs use the connection address to select auth:
loopback callers may use empty auth for local integration, while every
non-loopback caller must present a verified paired-device credential. The
status response advertises optional `kspStreamVersion: 2`. Current mobile
records that capability after `getStatus()` and selects `/v2/stream`; absence
means a previous desktop, so mobile uses `/v1/stream`. Both paths send the
paired credential when one is available. This preserves current-mobile /
previous-desktop interoperability without leaving current desktops open.

### Task-transfer listener admission

The mDNS listener owns a hard semaphore before spawning connection work. Each
accepted connection must supply one newline-terminated request within a
pre-auth deadline and within a fixed byte ceiling. Saturated connections and
slow or oversized frames are closed before parsing, pairing, crypto, replay, or
desktop events.

### Snapshot route separation

`list_peers()` continues to merge LAN and registered external cloud routes for
transfer selection. `list_peer_task_snapshots()` instead starts from discovery's
LAN peers only. Cloud task state remains sourced from the Firestore
subscription, so the one-second LAN refresh cannot open relay proxy tunnels.

### Single-consumer lifecycle events

The transfer sidecar continues broadcasting informational pairing events, but
receipt and finalization events are emitted to exactly one authoritative
webview. The root `main` webview is preferred; if it is absent, the
lexicographically first live webview is selected. This prevents multiple
renderer stores from racing destructive lifecycle work.

### Coalesced finalization

Outgoing finalization state is keyed by transfer id. The first request creates
one pending operation and emits one desktop event. Duplicates append waiters to
that operation. Desktop completion atomically replaces pending state with a
cached result and wakes every waiter; later retries receive the cached result
without rerunning finalization. Import commit removes the cache, and expired
reservations prune it.

## Error Handling

Unauthorized KSP streams receive the existing `unauthorized` frame and close.
Listener admission failures close the socket without allocating unbounded
work. Duplicate desktop completion is idempotent once a cached result exists.
All existing user-facing remote lifecycle/action failure paths remain intact.

## Testing

- Real non-loopback `/v1/stream` WebSocket denial plus loopback/current endpoint
  contracts.
- Slowloris, oversized-frame, and connection-cap task-transfer regressions.
- Repeated LAN snapshot polling with a durable-but-cloud-only external route,
  proving the relay proxy receives no connection.
- Mobile status negotiation for current and previous desktop responses.
- Multi-window authoritative lifecycle target selection.
- Slow finalization retry proving one desktop event, joined callers, and cached
  retry response.
- Focused Rust/frontend/mobile suites, desktop build/typecheck, `pnpm test`,
  canonical practical JavaScript verification, formatting, and diff checks.

## Replacement PR Handoff

This branch supersedes GitHub PR #921 (`feat/remote-blocked-task-ux`). The final
handoff will describe the auth boundary, LAN/cloud route separation, stream
epoch negotiation, and lifecycle/finalization serialization decisions, along
with fresh verification evidence.
