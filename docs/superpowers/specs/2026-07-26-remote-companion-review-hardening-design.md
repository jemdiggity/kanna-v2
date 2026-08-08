# Remote Companion Review Hardening Design

## Goal

Close the remaining lifecycle, resource-bound, IPC-latency, decoder-isolation, and terminal-ordering gaps in the remote visual companion implementation.

## Architecture

Relay recovery is snapshot-gated. A disconnect invalidates the cached transport snapshot for availability decisions while retaining the already-served bridge bundle. Reauthentication reports that the transport is connected, but the bridge remains `reconnecting` until the reattached companion stream supplies an authoritative snapshot. That snapshot is upserted before the bridge returns to `available`.

The KSP companion event limiter allocates state only after the event has passed task/session/revision validation and has been appended. Before every lookup it prunes timestamps outside the window and removes empty keys. A connection retains at most 64 active task/session keys; a new key at the bound is rejected without allocation.

LAN companion bundles use a dedicated length-prefixed IPC stream from `task-transfer` to the desktop. Runtime companion snapshots remain latest-value coalesced by peer/task. The sidecar hands companion frames to a bounded writer that coalesces replaceable snapshot/unavailable state without dropping reliable event results, serializes them on a blocking worker, and writes them independently from stdout. The desktop reads bounded frames and parses JSON on a blocking worker before emitting the existing Tauri event. Terminal events, request responses, and lifecycle events remain on stdout.

Desktop stream decoding is owned per `StreamClient`; closing or overflowing one client terminates only that client's worker and rejects only its work. Inside `StreamClient`, async ingress is split into terminal, companion, and control lanes. Terminal output is parsed immediately but enters the terminal dispatch lane, so it cannot overtake an earlier asynchronously decoded snapshot. Companion decoding runs independently and therefore cannot delay terminal frames.

## Failure Handling and Bounds

- Relay transport connection alone is not authoritative companion availability.
- Invalid event identities do not consume limiter keys.
- Expired limiter keys are removed; retained active keys never exceed 64.
- Companion IPC frames have an explicit maximum length and malformed/oversized frames are rejected without unbounded allocation.
- A closed companion IPC stream marks the sidecar dead through the existing lifecycle path.
- Decode overflow reconnects only the owning stream client.
- Stale decoded frames from replaced sockets or cancelled generations are discarded.

## Verification

Regression coverage will prove:

1. reconnect remains `reconnecting` until a fresh revision is received and upserted;
2. distinct invalid identities cannot grow limiter state;
3. a maximum companion bundle blocked by a slow reader does not delay terminal/control output;
4. cancelling one decoder owner does not reject another owner's in-flight decode or trigger its reconnect;
5. delayed terminal snapshot decoding still dispatches snapshot before subsequent output while companion decoding remains independent.
