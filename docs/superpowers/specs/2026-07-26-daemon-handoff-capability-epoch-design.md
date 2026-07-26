# Daemon Handoff Capability Epoch Design

## Problem

Kanna's hardened daemon handoff and the deployed legacy handoff both identify
themselves as protocol version 2 even though they provide different guarantees.
The hardened sender seals PTY and agent lifecycle changes around its snapshot,
claims exact session incarnations, owns transferred descriptors through the
acknowledgement, and authenticates descriptor provenance. A deployed v2 sender
does not.

A hardened adopter currently cannot distinguish those senders. It can therefore
acknowledge a legacy snapshot while incorrectly assuming that concurrent
Spawn/Kill operations were fenced or that agent descriptors stayed bound to the
claimed child.

The protocol must identify the hardened guarantee set without requiring users
to terminate existing PTYs during the one-time upgrade from a deployed v2
daemon.

## Goals

- Give the hardened transaction and descriptor guarantees an unambiguous wire
  identity.
- Keep seamless, transactional handoff between hardened daemons.
- Preserve existing PTYs during a deployed v2 to hardened daemon upgrade.
- Treat legacy v2 as an explicit degraded mode rather than silently assigning
  it hardened guarantees.
- Authenticate and validate everything the adopter can verify independently,
  even in legacy mode.
- Exercise a real shipped v2 daemon against the current daemon in both sender
  directions, including PTY and agent Spawn/Kill churn during transfer.

## Non-goals

- Retrofitting a transaction seal into an already-deployed v2 process.
- Guaranteeing the final state of a session whose Spawn or Kill races the
  legacy v2 snapshot. The v2 wire protocol has no operation that can establish
  that boundary.
- Maintaining indefinite compatibility with every historical handoff version.
  The only legacy path retained is v2 to preserve the current install base's
  live sessions. Version 1 fallback is removed.
- Adding a proxy daemon or routing commands between two simultaneously
  authoritative daemons.

## Protocol Epochs

The shared protocol module exposes one source-of-truth constant for the current
handoff epoch:

```rust
pub const HANDOFF_PROTOCOL_VERSION: u32 = 3;
pub const LEGACY_HANDOFF_PROTOCOL_VERSION: u32 = 2;
```

Version 3 is a guarantee bundle. A peer accepting v3 promises all of the
following:

1. PTY and agent lifecycle mutation is fenced before the transfer snapshot.
2. Snapshot entries refer to exact session incarnations, with same-id teardown
   protected from ABA replacement.
3. PTY masters and agent pipes remain owned by the sender through `sendmsg` and
   the adoption acknowledgement.
4. The daemon peer is authenticated against its Unix-socket credentials and a
   pinned process identity.
5. Descriptor counts and ancillary data are validated before acknowledgement;
   PTY and agent-pipe provenance are validated before granting live session
   authority during adoption.
6. `HandoffAdopted { version: 3 }` is the commit point. Failure before that
   point leaves or returns the sender to service.
7. The adopter does not publish its PID file and socket until the sender has
   released its readers and exited.

The `Handoff`, `HandoffReady`, SCM_RIGHTS, and `HandoffAdopted` message sequence
does not otherwise change. Existing optional handoff metadata such as
`child_start` remains advisory; descriptor provenance is authoritative.

## Negotiation

An adopter always requests v3 first.

- A v3 sender accepts and performs the transactional handoff.
- A deployed v2 sender returns an explicit handoff-version-mismatch error.
  Only that explicit, pre-transfer response permits a second connection and a
  v2 request.
- Timeouts, disconnects, malformed responses, partial FD transfer, and all
  other ambiguous failures never trigger a fallback.
- Version 1 is not attempted.

The selected mode is carried as an internal enum rather than inferred later:

```rust
enum HandoffMode {
    TransactionalV3,
    LegacyV2,
}
```

Logs include the selected mode. Functions that decide validation, sender
sealing, and result reporting receive `HandoffMode`, preventing a legacy
transfer from accidentally flowing through code that assumes a v3 peer.

## Transactional v3 Path

The current hardened flow remains the v3 implementation:

1. Authenticate and pin the incumbent daemon.
2. Seal the PTY manager and agent registry.
3. Settle bounded in-flight agent spawn reservations.
4. Snapshot exact PTY handles and agent incarnations.
5. Duplicate all transferred descriptors into owned close-on-exec handles.
6. Send metadata and descriptors.
7. Re-authenticate the peer and validate the descriptor transfer shape.
8. ACK adoption.
9. Keep the sender sealed, stop its readers, broadcast shutdown, and exit.
10. Wait for the authenticated incumbent to exit, validate per-session
    descriptor provenance, and only then publish the adopter.

Every abort before ACK closes temporary descriptors and lifts the sender's
seals.

## Legacy v2 Path

The v2 fallback exists so users do not have to kill live PTYs for the protocol
upgrade.

The adopter:

1. Labels the transfer `LegacyV2` as soon as the explicit v3 mismatch is
   received.
2. Authenticates the incumbent daemon exactly as it does for v3.
3. Parses the v2 metadata and strictly validates FD counts and ancillary data.
4. ACKs only after peer authentication and the metadata/ancillary FD transfer
   shape pass validation.
5. Validates each received PTY master against the claimed terminal child and
   each live agent pipe bundle against the claimed agent child before granting
   signal or live-stream authority.
6. Keeps an unproven PTY usable but permanently non-signalable; closes an
   unproven agent bundle and keeps the logical session resumable from its
   journal.

The adopter does not describe this result as transactional. A warning records
that concurrent legacy Spawn/Kill operations were outside a provable snapshot
boundary.

The unavoidable legacy race is deliberately narrow and visible: sessions that
were stable before the handoff remain the compatibility contract; the result
of a Spawn or Kill issued concurrently with the v2 snapshot is unspecified.
Normal app startup does not issue those lifecycle commands while waiting for
the daemon, but the cross-binary regression stresses the window to ensure the
processes fail safely rather than accepting unauthenticated descriptors,
starting split-brain daemons, or losing the stable sessions.

## Previous-binary Fixture

The regression uses the actual daemon from the shipped
`v0.1.0-staging.1` tag, which speaks protocol v2.

A fixture builder:

1. Resolves the tag to its commit and uses `git archive` to materialize that
   source under `.build/daemon-cross-version/<commit>/source`.
2. Builds `kanna-daemon` with an isolated Cargo target directory under the same
   cache root.
3. Keys the cache directory by commit, host OS, and architecture, and reuses
   the binary at that exact path when present.
4. Uses a filesystem lock and atomic staging rename so concurrent test
   processes cannot observe a partial fixture.

The fixture is a development/test artifact and is never included in release
packaging. The Rust harness prepares it on demand, so focused tests and
`./kd test rust` use the same fixture. CI checks out full history so the fixed
shipped tag is available without a network operation during the test.

## Cross-binary Regression

The integration harness accepts explicit daemon binary paths instead of always
using `CARGO_BIN_EXE_kanna-daemon`. It runs the following real-process cases.

For a deployed-v2 sender and current adopter:

1. Start the previous v2 daemon in an isolated daemon directory.
2. Create stable PTY and agent sessions, prove both are usable, and open a
   dedicated lifecycle-management connection before takeover.
3. Start the current v3 daemon in the same directory with a test-only delay
   immediately before its adoption acknowledgement.
4. Wait for the adopter's delay marker, proving it has received and validated
   the snapshot and descriptors but has not ACKed.
5. Over the pre-existing connection to the deployed sender, require a complete
   PTY Spawn/Kill and agent Spawn/Kill cycle to return its expected successful
   replies during that post-transfer/pre-ACK window. The test proves the race
   really occurred without assigning transactional ordering to its result.
6. Verify the current daemon first requested v3 and reached v2 only after the
   incumbent's explicit mismatch.
7. Verify the incumbent exited, the current daemon alone owns the PID file and
   socket, the stable PTY still accepts input and produces output, and the
   stable agent session can replay its journal and accept another turn.
8. Verify logs identify the transfer as legacy v2.

For a current sender and deployed-v2 adopter, the harness creates stable PTY
and agent sessions under the current daemon, starts the shipped daemon as the
adopter, verifies the current sender accepted legacy-v2 mode and exited, then
proves both adopted sessions remain live through PTY echo and agent steering.
This covers the retained v2 serialization, descriptor transfer, and
acknowledgement path end to end rather than inferring compatibility from unit
types.

Existing current-to-current handoff tests continue to cover successful
transactional transfer. Focused unit tests cover negotiation: v3 success,
explicit mismatch followed by one v2 attempt, and no fallback after any
ambiguous failure.

## Documentation and Invariants

`crates/daemon/SPEC.md` and `CLAUDE.md` describe the two modes explicitly:

- Successful v3 handoffs preserve sessions transactionally.
- The one-time v2 fallback preserves stable live sessions with mandatory
  receiver-side authentication, but cannot promise a concurrent lifecycle
  boundary.
- Failed or ambiguous adoption never permits a newcomer to publish alongside a
  live incumbent.

This refines "sessions survive upgrades" without weakening it silently: v3
defines the durable invariant, while v2 compatibility names its one
unavoidable limitation.
