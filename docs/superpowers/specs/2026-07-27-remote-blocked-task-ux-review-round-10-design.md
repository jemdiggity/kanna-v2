# Remote Blocked Task UX Review Round 10 Design

## Goal

Resolve the tenth review round's transfer filesystem, setup-lifetime,
multi-window ownership, listener-readiness, and deployed-mobile compatibility
findings without regressing remote blocker behavior or the current local and
remote task experience.

## Architecture

### Validated transfer payloads and provider-owned destinations

The renderer will parse the complete incoming transfer payload instead of
casting peer JSON to `OutgoingTransferPayload`. Artifact metadata must agree
with the authenticated task provider and resume session. `home_rel_path` is
validated only as a compatibility assertion; it is never used to choose a
destination.

Session artifacts are materialized by one dedicated Rust command. Its inputs
are the fetched artifact path, provider, authenticated resume session id, and
validated filename/materialization metadata. Rust derives the destination:

- Claude: `$HOME/.claude/tasks/<session-id>`
- Copilot: `$HOME/.copilot/session-state/<session-id>`
- Codex: `$HOME/.codex/sessions/YYYY/MM/DD/<validated-rollout-filename>`

Every destination component is opened or created relative to an already-open
home directory descriptor with no-follow semantics. Existing symlinks are
rejected. Codex files are created exclusively. Tar archives are decoded in
process, accept only regular files and directories beneath the one expected
session-id root, reject links and special entries, enforce entry and expanded
byte limits, extract into a private sibling directory, and atomically rename
the completed session without replacing an existing entry.

### Bounded cloud tunnel setup

Each cloud proxy listener owns a fixed semaphore. A permit is acquired before
connection work is spawned. The WebSocket connect, auth response, and
`tunnel_ready` response share a setup deadline. During every setup phase the
proxy also watches the accepted local socket; EOF cancels the relay connection
immediately. Listener shutdown cancels all setup and bridge work.

Relay pending tunnel records own an expiry timer. Attaching, client close,
desktop close, or timeout removes the record and clears its timer. Expiry
closes the requester socket so proxy and relay resources cannot remain
reachable indefinitely.

### One ready renderer owns lifecycle mutation

The backend maintains a transfer-event consumer state containing one active
ready webview label, ordered ready standbys, and an ordered queue of
undelivered state-mutating events.
After all four lifecycle listeners are registered, a renderer claims
authority. The first live ready renderer wins; a stale claim can be replaced.
Only the authoritative renderer receives transfer requests, task-pull
requests, commit receipts, and finalization requests. Informational pairing
and terminal events remain broadcasts.

If there is no claimed live renderer or `emit_to` fails, the event remains in
the backend queue. Claiming readiness flushes queued events in order and keeps
the first failed event plus its tail queued. LAN/cloud sidecar warmup starts
only after the readiness command returns, eliminating startup delivery loss.
Renderer unmount releases its registration, promoting the next ready standby;
unexpected window loss is detected on the next dispatch or claim. Each ready
renderer retains its own read-only LAN snapshot sync, while only the active
owner performs pending transfer import.

### KSP rollout compatibility

`/v1/stream` retains its deployed contract and accepts empty stream auth.
`/v2/stream` requires paired-device auth for every non-loopback client while
retaining local empty-auth integration behavior. Current mobile reads
`kspStreamVersion: 2`, sends its paired credential, and uses v2. Older mobile
continues opening v1 without credentials against a current desktop.

## Error Handling

Invalid artifact metadata disables transferred resume state and falls back to
a fresh provider launch; it never reaches filesystem mutation. Rust
materialization returns a non-import result when the derived destination
already exists and an error for traversal, symlink, archive, or containment
violations. Proxy setup errors close both local and relay sides. Expired relay
tunnels close with an explicit timeout reason. Undelivered lifecycle events
remain queued until a ready renderer claims them.

## Testing

- Payload parsing rejects traversal, absolute paths, provider mismatches, and
  incompatible artifact kinds while accepting canonical legacy metadata.
- Rust filesystem tests cover symlinked provider roots, symlinked intermediate
  directories, traversal/link archive entries, wrong archive roots, existing
  destinations, and successful Codex/Claude/Copilot materialization.
- Proxy tests cover stalled auth, stalled tunnel-ready, local EOF during both
  phases, and connection-cap admission.
- Relay tests use fake timers to prove pending tunnel expiry and requester
  disconnect cleanup.
- Backend lifecycle tests cover one ready owner across multiple windows,
  queued no-window delivery, stale claims, and failed emit requeue.
- App lifecycle tests prove every listener registers before the readiness
  claim and sidecar/LAN startup.
- KSP tests prove old-mobile/new-desktop v1 compatibility and v2 non-loopback
  authentication.

## Replacement PR Handoff

This branch supersedes GitHub PR #921 (`feat/remote-blocked-task-ux`). The final
handoff will summarize these conflict-resolution and hardening decisions plus
fresh focused, desktop build/typecheck, canonical JavaScript, and practical
repository verification evidence.
