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

Repository definitions are cached for 30 seconds. On an expired entry, the
cache releases its mutex before loading and provides no per-key single-flight
coordination, so concurrent misses all run `RepoDefinitions::resolve`. That
resolution synchronously executes `git fetch origin` and several Git ref
commands. The HTTP handlers execute this work directly on Tokio runtime worker
threads. A state-change burst can therefore occupy every worker with blocking
Git processes, especially when a fetch is slow or times out.

The same Tokio runtime drives KSP WebSocket input, terminal daemon readers,
outbound WebSocket writers, and HTTP handlers. Once its workers are occupied,
keyboard frames cannot be read, daemon output cannot be drained, and no task's
multiplexed terminal frames can be written. This explains why all terminal
directions freeze together.

## Design

### 1. Keep blocking definition resolution off the async runtime

The repository-definition cache becomes asynchronous at its public boundary.
Cache misses run `RepoDefinitions::resolve` through `tokio::task::spawn_blocking`.
The three HTTP definition endpoints await the cache without executing Git or
filesystem work on a Tokio worker.

Join failures are converted into the existing `DefinitionLookupError::Other`
path and retain the current HTTP status mapping. Successful and failed lookup
semantics otherwise remain unchanged.

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
3. A deliberately blocked definition load does not prevent an unrelated Tokio
   timer from progressing, proving the Git work is off the async workers.
4. Multiple KSP invalidations during one frontend reload produce one active and
   one trailing reload, never one reload per event.
5. Selection preservation still uses the state captured for each actual
   refresh.

Targeted Rust and Vitest suites run first, followed by the canonical relevant
workspace checks as time permits.
