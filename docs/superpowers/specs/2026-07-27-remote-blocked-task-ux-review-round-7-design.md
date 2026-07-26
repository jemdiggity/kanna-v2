# Remote Blocked Task UX Review Round 7 Design

## Goal

Close the seventh review round by authenticating every privileged direct-LAN
task path, making authenticated request identities restart-unique, bounding the
authenticated replay window without synchronous per-request filesystem work,
and loading v0.0.30 recovery snapshots without fabricating cursor metadata.

## Architecture

### Direct-LAN authorization

Privileged task HTTP handlers accept requests only when they are desktop-local
loopback calls, carry a verified paired-device id and secret, or were
synthesized by an explicitly authenticated relay/KSP dispatch. Direct-LAN KSP
connections choose their authentication mode from the real socket peer:
loopback retains the empty local handshake, while non-loopback clients must send
the paired device id and secret in the first KSP auth frame. Relay tunnel KSP
uses an explicit already-authenticated mode because relay session
authentication happens before KSP frames are forwarded.

The mobile LAN transport supplies the same persisted pairing credentials to
both HTTP and KSP. Unauthenticated non-loopback HTTP and empty-auth LAN KSP fail
before input, advance, close, terminal, or arbitrary tunneled HTTP work reaches
an owner adapter.

### Authenticated request identity and replay

Each task-transfer runtime generates a cryptographically random request
namespace at startup. All request ids contain that namespace before the
monotonic counter, so a restarted requester cannot collide with ids retained by
an owner for the five-minute replay window.

The listener retains a hard-bounded in-memory replay set for every authenticated
operation. Snapshot, observe, terminal input/resize, file read, and mark-read
never write replay files. Close and advance retain crash-durable replay records
because repeating either mutation after an owner crash can be destructive.
Durable writes and cleanup run through Tokio's blocking pool after the replay
slot is reserved, never while holding the shared async mutex. Admission closes
with a backpressure error if the configured replay bound is full.

### v0.0.30 terminal recovery

The historical v0.0.30 snapshot schema had no cursor fields. Both the recovery
sidecar store and daemon fallback loader deserialize those fields as optional.
New snapshots write explicit values; historical snapshots remain explicitly
unknown (`None`) through the load/response boundary. Conversion to the current
daemon terminal protocol uses its compatibility defaults only at the final
boundary that still requires concrete cursor values.

## Testing

- Non-loopback HTTP requests without pairing credentials cannot send input,
  advance, or close; loopback, paired LAN, and authenticated tunnel dispatch
  remain accepted.
- A non-loopback KSP connection rejects an empty auth frame, while the mobile
  LAN client emits its paired-device credential.
- A requester restart produces different ids for snapshot, terminal
  observe/input/resize, file read, mark-read, close, and advance.
- Repeated snapshot/input traffic creates no durable replay records and the
  in-memory window rejects work at its configured bound; close/advance replays
  remain durable across owner restart.
- The exact v0.0.30 JSON fixture loads through both the terminal-recovery store
  and daemon fallback store with unknown cursor metadata.
