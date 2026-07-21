# Terminal Transport Runtime Starvation Design

## Problem

The daemon terminal fanout now isolates PTY ingestion from a slow daemon
subscriber, but the desktop still experiences transport-wide freezes: the
selected terminal stops echoing input, attached terminals stop rendering, and
unattached tasks stop receiving terminal updates for roughly 10–14 seconds.

Production diagnostics show that the daemon keeps producing terminal output
during these incidents, but the `kanna-server` attachment stops draining its
Unix socket. At the same time, desktop snapshot HTTP requests and the shared
KSP WebSocket stop progressing while the WebView event loop remains responsive.
The stall is therefore inside the shared server runtime, after the daemon
fanout boundary and before the desktop terminal consumer.

## Root cause

Task lifecycle and activity mutations publish KSP `state_changed` frames. The
desktop listener starts an independent full `reloadSnapshot()` for every frame.
Each reload fetches the snapshot and then fetches Kanna definitions for every
visible repository, regardless of the invalidation scope.

Repository definitions are cached for 30 seconds. The Cmd+N modal requests
both the repository manifest and available agent providers in parallel. The
provider route historically resolved definitions directly, bypassing the
shared cache. On an expired entry, the cached manifest path also released its
mutex before loading and provided no per-key single-flight coordination, so
concurrent misses all ran `RepoDefinitions::resolve`. That resolution
synchronously executes `git fetch origin` and several Git ref commands. The
HTTP handlers executed this work directly on Tokio runtime worker threads. A
state-change burst or modal open could therefore occupy workers with blocking
Git processes, especially when a fetch was slow or timed out.

The same Tokio runtime drives KSP WebSocket input, terminal daemon readers,
outbound WebSocket writers, and HTTP handlers. Once its workers are occupied,
keyboard frames cannot be read, daemon output cannot be drained, and no task's
multiplexed terminal frames can be written. This explains why all terminal
directions freeze together.

## Design

### 1. Keep blocking definition resolution off the async runtime

The three repository-definition HTTP endpoints and the available-provider
endpoint run their complete lookup through `tokio::task::spawn_blocking`. This
includes the SQLite repository lookup, cache access,
`RepoDefinitions::resolve`, definition reads, and executable discovery, all of
which can execute synchronous Git, shell, or filesystem operations. The
endpoint handlers await the blocking task without executing that work on a
Tokio worker.

Available-provider resolution uses the same repository-definition cache as
the manifest, pipeline, and agent endpoints. Parallel Cmd+N requests therefore
join one per-repository definition load and read one resolved snapshot.

The cache remains synchronous because every HTTP use of it is inside this
blocking boundary. Keeping the entire definition operation together also
protects cache hits whose requested pipeline or agent definition still needs
to read data from Git objects.

Loader panics are converted into the existing `DefinitionLookupError::Other`
path, while blocking-task join failures map directly to the endpoint's internal
server error response. Successful and failed lookup semantics otherwise remain
unchanged.

### 2. Single-flight cache misses per repository

The cache tracks a shared in-flight load per `RepoDefinitionCacheKey` in
addition to fresh completed entries. The first caller after expiry starts the
blocking load. Concurrent callers await that same result instead of launching
additional Git processes. Different repository keys remain independent.

Successful results replace the cached entry and start a fresh 30-second TTL.
Failures are returned to every current waiter but are not cached, allowing the
next request to retry. No mutex is held across Git work or an async await.

### 3. Coalesce frontend invalidation bursts

The KSP `state_changed` listener uses a small refresh coordinator. At most one
external snapshot refresh runs at a time. If one or more invalidations arrive
while it is running, they set a dirty flag; completion starts exactly one
trailing refresh using the latest state. Further invalidations during that
trailing refresh repeat the same rule.

This coordinator applies only to externally driven KSP invalidations. Explicit
user actions that await `reloadSnapshot()` retain their existing completion
semantics. Focus preservation runs for every actual coordinated refresh, using
the selection captured immediately before that refresh.

The existing snapshot run-id protection remains as defense against other
concurrent explicit reloads. Definition fetching remains part of snapshot
reload in this change; server-side isolation and single-flight make it safe,
while coalescing removes redundant traffic at its source.

## Error handling and observability

- A blocking-task panic or cancellation is surfaced as an internal definition
  lookup error rather than panicking the server.
- An in-flight failed definition load is removed before waiters return, so the
  cache cannot remain permanently wedged.
- Existing warnings for failed `git fetch origin` remain intact.
- Existing terminal performance diagnostics continue to prove whether the
  server drains daemon attachments during future incidents; no protocol change
  is required.

## Verification

Tests are added before implementation:

1. Concurrent cache misses for one key invoke the loader once and return the
   same value to all callers.
2. A failed shared load reaches all waiters and a later request retries.
3. A deliberately blocked definition load through the actual
   available-provider route does not prevent its current-thread Tokio runtime
   from progressing, proving the route uses both the shared cache and the
   blocking boundary.
4. Multiple KSP invalidations during one frontend reload produce one active and
   one trailing reload, never one reload per event.
5. Selection preservation still uses the state captured for each actual
   refresh.

Targeted Rust and Vitest suites run first, followed by the canonical relevant
workspace checks as time permits.
