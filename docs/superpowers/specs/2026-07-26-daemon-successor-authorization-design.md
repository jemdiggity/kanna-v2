# Daemon Successor Authorization Design

## Problem

The daemon's Unix socket is a multipurpose local API. An ordinary client can
currently send `Handoff` and reach the transactional transfer path. On the
sending daemon, that path acquires the daemon-lifecycle write guard, seals PTY
mutation around the PTY and agent snapshot, writes `HandoffReady`, transfers
PTY masters and agent pipes with `SCM_RIGHTS`, and commits when the receiver
acknowledges adoption.

Socket access is not sufficient authority for those operations. The sender must
authenticate a replacement daemon before it acquires lifecycle ownership or
touches either registry.

The implementation is rebased onto main's transactional-v3 handoff at
`7add2d0727d2511f06e3188d87a90ec22d6710e5`. It preserves the existing
daemon-lifecycle ownership fence, PTY seal epoch, commit/abort behavior, and
receiver-side old-daemon PID/start-time recheck. Descriptor provenance
validation and `SCM_RIGHTS` framing are outside this change.

## Trust Root

Kanna already establishes a process relationship suitable for authorization:
the desktop app directly spawns a daemon and remains alive while it waits for
that child's PID file and socket readiness.

Every daemon captures two executable paths at startup, while its direct parent
context is still available:

- its own daemon executable path; and
- its direct parent's executable path, which becomes the trusted app-launcher
  path for the lifetime of that daemon.

The daemon records paths, not the original launcher's PID. The app may restart
while the daemon survives, so the original parent can exit and the daemon can
be reparented without erasing the trust root. A later successor must have a
new, live direct parent whose executable path matches the recorded launcher
path.

Executable paths come from the kernel's process inspection interface rather
than command-line strings. Path identity deliberately permits an in-place app
or sidecar upgrade: the bytes at the installed or build-private path may
change, while the release and development launch topology remains the same.

## Authorization Boundary

The listener constructs one immutable successor authorization policy and passes
it to every connection handler. When a connection sends a supported `Handoff`
request, the sender performs these checks in order:

1. Read the connection's peer PID from the Unix socket with
   `LOCAL_PEERPID`.
2. Read and pin the peer's process start identity and direct parent PID.
3. Require the peer executable path to equal the daemon executable path
   captured at sender startup.
4. Read and pin the live direct parent's PID/start identity.
5. Require that parent's executable path to equal the trusted app-launcher path
   captured at sender startup.
6. Immediately before returning authorization success, re-read both processes:
   the peer must still be the same live PID/start identity with the same direct
   parent PID, and the parent must still be the same live PID/start identity.

Only after all six checks succeed may `handle_handoff` acquire the
daemon-lifecycle write guard and call `seal_for_handoff`. The authorization
policy does not reserve, seal, snapshot, clone, or transfer anything itself.

An unsupported protocol version may still receive the existing version error
without exposing session state. A supported request with failed authorization
receives an explicit handoff-unauthorized error and remains an ordinary client
connection.

## Failure Behavior

Every missing credential, missing process record, dead or zombie process,
start-time mismatch, parent change, executable-path mismatch, or final identity
recheck failure is a closed failure.

On failure:

- no daemon-lifecycle ownership is acquired;
- neither registry is sealed;
- no session snapshot or descriptor clone is attempted;
- no `HandoffReady` event is written;
- no `SCM_RIGHTS` descriptor is written; and
- existing Spawn, Kill, input, and output behavior remains available.

The refusal identifies the failed authorization category for diagnostics but
does not disclose session metadata or descriptors.

## Compatibility

The wire shape of `Handoff` does not change. This preserves both rolling
directions:

- a new successor can still replace an older sender that predates sender-side
  authorization; and
- an older successor daemon spawned directly by the trusted app path can
  replace an authorized sender.

Production upgrades remain compatible because the installed app and sidecar
paths are stable across in-place upgrades. Worktree development remains
compatible because `kd` uses a stable build-private daemon path and launches
the desktop app, which directly spawns the successor. Real-process integration
tests use the same topology: the test executable is the recorded launcher, and
it directly spawns both daemon generations.

Manual replacement from an unrelated shell or helper is intentionally refused.
The documented invariant is that the app always spawns the daemon.

## Components

### Process inspection

`crates/daemon/src/proc_info.rs` gains a kernel-backed executable-path lookup
for a PID. Its existing process records provide PID, parent PID, start time,
and zombie state. Authorization pins those records and uses the existing
identity predicates for final rechecks.

### Successor authorization policy

A focused daemon module owns:

- startup capture of daemon and launcher executable paths;
- socket-peer and direct-parent provenance checks; and
- final peer/parent identity rechecks.

It exposes a small immutable policy plus an authorization method that accepts
only the connected socket FD. It has no registry, session, or descriptor
dependencies.

### Startup and connection plumbing

`run_daemon` captures the policy before attempting to receive a handoff, while
the spawning app or test launcher is necessarily still waiting. The listener
shares the policy with connection handlers. `handle_connection` authorizes a
supported `Handoff` before calling `handle_handoff`.

`handle_handoff` retains ownership of the existing version validation,
daemon-lifecycle fencing, registry seal, snapshot, descriptor transfer,
acknowledgement, and commit/abort transaction.

## Tests

Test-first coverage will prove the boundary at both unit and real-process
levels:

1. Policy tests accept a peer only when daemon path, live direct-parent path,
   and pinned PID/start identities all match.
2. Policy tests reject peer executable mismatch, launcher executable mismatch,
   missing/dead parent, peer identity change, parent identity change, and
   direct-parent change.
3. A real ordinary client sends a supported unauthenticated `Handoff` and
   receives an authorization error rather than `HandoffReady`.
4. That regression then performs normal Spawn/Kill or PTY I/O against the old
   daemon, proving the refusal occurred before either registry seal was armed.
5. The regression inspects the handoff socket and observes no ancillary
   descriptor transfer.
6. Existing real two-daemon handoff tests continue to transfer live sessions,
   proving the app/test-launcher direct-parent topology remains authorized and
   sessions survive upgrades.
7. Compatibility coverage confirms the request wire shape remains unchanged;
   no capability field or protocol-version bump is introduced.
