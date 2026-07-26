# Retryable Handoff Sealed-Window Contract

## Goal

Give daemon producers and their desktop and `kanna-server` consumers one
coherent contract for commands refused while the old daemon is sealed for
handoff. A refused command waits for successor publication and is replayed
byte-for-byte at most once, without weakening session-incarnation ownership or
publishing duplicate terminal events.

## Scope

This change is rebased onto `origin/main` at `7add2d07`. It consumes the
existing daemon-wide `DaemonLifecycle` read/write fence, the PTY manager's
handoff epoch, and the agent runtime's process-global handoff seal. It does not
change lifecycle ownership, handoff epochs, descriptor authentication or
provenance, session-id validation, child ownership, exact-incarnation teardown,
or Exit publication ownership.

The commands covered are:

- PTY `Spawn`
- PTY and agent `Kill`
- `SpawnAgent`, including an initial child whose installer loses to the seal
- `AgentInput`, including a per-turn resume child whose installer loses to the
  seal

## Protocol Contract

Add `ErrorCode::RetryOnSuccessor`, serialized as `retry_on_successor`.

The daemon emits this error only after it verifies, under an existing
synchronization boundary, that the command has lost to the handoff before the
command's externally visible effect. The primary public-command boundary is
the daemon lifecycle lock: handoff holds its write guard through transfer and
commit, while Spawn, SpawnAgent, Kill, and AgentInput hold read guards through
their complete operation. A command therefore either finishes while the daemon
is still `Running`, or acquires the guard after commit and is refused before
side effects. A later installer failure after child creation or initial
provider input is deliberately not retryable. The error means:

1. The old daemon did not accept the requested state transition.
2. The client may discard the old connection.
3. The client must wait until `daemon.pid` publishes a PID different from the
   PID associated with its current connection and the daemon socket is
   connectable.
4. The client may then replay the identical serialized command once.

Transport failures, timeouts, unexpected responses, and failures after a
command may have taken effect are not mapped to `retry_on_successor`.

Existing errors retain their meaning. Duplicate IDs and teardown tombstones use
`session_already_exists`; missing sessions use `session_not_found`; process
spawn failures retain their spawn-specific codes; handoff protocol failures
retain `handoff_lost`.

## Producer Behavior

PTY `Spawn` validates the session id first, then acquires the daemon lifecycle
read guard. If handoff is committed, it emits `retry_on_successor` before
process creation. If the daemon is `Running`, the read guard stays held through
spawn and installation, preventing handoff commit from interleaving. The
existing defensive manager-seal and teardown checks after process creation
retain non-retryable spawn failures after killing and reaping an uninstalled
child. They never insert a session or publish `SessionCreated`.

`SpawnAgent` acquires the same lifecycle read guard at dispatch. A committed
handoff emits `retry_on_successor` before adapter or child work. Its existing
agent-seal check, performed atomically with the reservation and before
journaling the initiating prompt, emits the same code. Duplicate IDs and
teardown tombstones remain distinct. If a child was already spawned before an
installer failure, the exact-incarnation installer removes or rolls back only
its own reservation, terminates the uninstalled child, and returns a
non-retryable failure because child creation and initial provider input may
already have occurred. It does not publish a successful creation.

`AgentInput` acquires the lifecycle read guard before planning, journaling, or
writing input. A committed lifecycle emits `retry_on_successor`. For a
per-turn resume whose child was spawned before an installer failure, the
exact-incarnation installer terminates the uninstalled child and reports a
non-retryable failure because the resumed provider may already have consumed
its initial input. No successful input acknowledgement is emitted from the old
daemon.

PTY and agent `Kill` first acquire the lifecycle read guard, then keep their
existing atomic seal-check-and-claim boundaries. A committed or sealed refusal
leaves the exact incarnation registered for transfer, emits no `Exit`, and
returns `retry_on_successor`. Only a successful successor Kill claims the
incarnation and runs the existing single-publication Exit path.

## Consumer Behavior

Each daemon client records the PID serving its connected Unix socket when the
connection is established. `daemon.pid` remains the successor publication
boundary. A retryable response carries its semantics through the typed error
code; it does not add successor identity to the handoff registries.

The desktop factors its existing readiness boundary into a reusable helper:
wait for the PID file to contain a PID other than the connection PID and for a
fresh socket connection to succeed. Spawn responses and ordinary
acknowledgements use the same one-retry executor. The executor serializes the
command once, preserves those bytes for both sends, clears the stale client on
`retry_on_successor`, waits for publication, reconnects, and replays once.

`kanna-server` retains the daemon directory and connected PID in
`DaemonClient`. Its task lifecycle Spawn and replacement Kill paths use the
same policy: on `retry_on_successor`, wait for publication, reconnect the
existing mutable client, and replay the same `DaemonCommand` once.

`SessionReplacements::begin` remains active across a sealed Kill refusal and
its retry. It is cancelled only when the final outcome is not-found or a
terminal error. This lets the one successful successor Kill produce one Exit
that is classified as the expected replacement.

Both consumers cap the sealed-window replay at one. If the successor also
returns `retry_on_successor`, the error is surfaced rather than starting an
unbounded chain.

## Testing

Daemon producer contract tests commit the daemon lifecycle or seal the relevant
defensive registry boundary and exercise each early command response. They
assert `retry_on_successor`, absence of successful creation/acknowledgement,
preservation or cleanup of the exact incarnation as appropriate, and no
old-daemon Exit. Installer-race tests assert that SpawnAgent and AgentInput
resume failures after child creation remain non-retryable. Successful retry
coverage asserts one resulting session and one Exit publication.

Desktop consumer tests use real Unix socket pairs or listeners and a test PID
file. The first daemon returns `retry_on_successor`; the test then publishes a
different PID and replacement socket. The helper must reconnect and send the
same serialized command exactly once to each daemon. Tests also prove that
ambiguous read failures are not replayed and that a second retryable response
is surfaced.

`kanna-server` task lifecycle tests use sequential fake daemons around the same
PID publication boundary. Spawn tests assert one refused attempt and one
successful `SessionCreated`. Kill tests assert the replacement registration
survives the refusal, the identical Kill is replayed once, and final
not-found/error paths cancel bookkeeping correctly.

Focused Rust tests run before the canonical `./kd test rust` suite.
