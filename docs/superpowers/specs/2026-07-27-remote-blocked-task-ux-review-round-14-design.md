# Remote Blocked Task UX Review Round 14 Design

## Goal

Close the remaining LAN authority, mobile upgrade compatibility, artifact
streaming and cleanup, importer claim, renderer lifecycle, and daemon reconnect
findings without changing the replacement PR's blocked-task or current remote
terminal behavior.

## Desktop-local and authenticated LAN authority

The dedicated cloud-transfer identity mutation is a desktop-internal control:
it accepts only a direct loopback listener request and rejects missing peer
identity, tunneled dispatch, paired LAN devices, and arbitrary non-loopback
clients. The generic setting PUT/DELETE endpoints reject the reserved identity
key so callers cannot bypass validation or authority.

Relay reconnect is an authenticated privileged control. Direct desktop
loopback, verified paired LAN devices, and authenticated relay invocations may
request it; unauthenticated non-loopback and tunnel requests may not. Tests use
a real non-loopback listener in addition to in-process middleware coverage.

## Previous-mobile compatibility

`/v2/stream` remains the authenticated current-client endpoint. The legacy
`/v1/stream` endpoint accepts an empty auth frame from non-loopback clients only
as an explicit read-only compatibility session. It may attach to existing
terminal/agent streams, but rejects terminal input, agent control, companion
events, resize, and tunneled HTTP requests. A paired credential upgrades the
same endpoint to full authority. This preserves a desktop-first upgrade path
for a previously shipped mobile while preventing empty-auth mutation.

## Bounded artifact transport

Artifact fetch becomes a streaming exchange. The source checks async metadata
against the 128 MiB plaintext limit before opening or reading the file, sends
authenticated metadata, and reads fixed-size chunks with Tokio file I/O.
Every chunk is independently authenticated with a sequence-bound nonce and
final marker derived from the transfer identities. The receiver rejects
reordering, truncation, authentication failure, or size mismatch while writing
to an async staging file. No JSON frame or heap buffer scales with the whole
artifact.

## Owned artifact lifecycle

Artifact records distinguish borrowed inputs from owned generated files.
Generated git bundles and session archives are staged as owned; original Codex
rollouts are borrowed; receiver staging files are owned. Owned records are
persisted under the transfer registry so restart reconciliation can remove
orphaned files. Success, explicit failure/nack, TTL pruning, runtime shutdown,
and startup reconciliation all remove owned files and empty staging
directories. Borrowed source files are never deleted.

## Import and renderer ownership

Incoming-transfer failure accepts the importer claim token. A claimed row can
transition to failed only when the token still matches; an unclaimed pending
row can be rejected only without a token. Sidecar cleanup follows only a
successful fenced terminal transition. A takeover test pauses the old importer,
reassigns the claim, and proves the old owner cannot fail or clean the new
owner's transfer.

Renderer lifecycle deliveries use the existing delivery id as the single-flight
token. Handlers renew and revalidate the lease before each irreversible commit
or finalization phase, and delivery-sensitive sidecar commands validate the
lease in Tauri before sending control requests. Owner loss aborts remaining
work, nacks only while still authoritative, and allows the replacement renderer
to redrive the retained event. Tests inject owner loss during both commit and
PTY finalization/archive staging.

## Daemon reconnect

The respawn test treats the atomic snapshot/live boundary correctly: the new
READY marker may arrive in the initial snapshot or subsequent live output.
It still proves the replacement process survives and becomes observable.

## Verification

Each boundary starts with a failing regression and runs its focused suite after
the implementation. Final verification runs the desktop build/typecheck,
focused workspace/frontend tests, canonical practical JavaScript verification,
canonical Rust verification, and a complete diff review against `origin/main`.

