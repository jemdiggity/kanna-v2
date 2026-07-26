# Remote Blocked Task UX Review Round 6 Design

## Goal

Close the sixth review round by proving possession of a paired peer's private
key for every privileged LAN task/terminal request and by preventing Firebase
ID tokens from crossing plaintext non-local WebSocket connections.

## Architecture

### Authenticated LAN action boundary

The task-transfer listener will be the single authentication boundary for
privileged task and terminal operations. Each request will carry a sealed JSON
payload containing the action name, outer request id, issuance timestamp, and
every operation argument. The listener will open the payload with the paired
peer's stored public key, reject action/request/argument mismatches, reject
payloads outside the configured freshness window, and reject a repeated
peer/action/request tuple before invoking daemon or Kanna-server adapters.

Snapshot, terminal observe/input/resize, close, advance, file read, and mark-read
will all use the same verifier. Daemon and local HTTP helpers will no longer
pretend that discovery plus a caller-supplied peer id authenticates a request;
they receive only arguments that crossed the listener's authenticated boundary.
Legacy peers that do not send authenticated payloads fail closed with an
upgrade/re-pair error.

### Relay transport admission

Cloud transfer proxy URL validation will parse the WebSocket URI before opening
the relay connection. `wss://` is accepted for any valid authority. `ws://` is
accepted only when the host is `localhost`, a subdomain of `localhost`, or a
literal loopback IP address. Plaintext URLs with any other hostname or IP are
rejected before a proxy listener is created or an ID token can be sent.

## Error Handling

Authentication failures remain `PeerResponse::Error` values tied to the outer
request id. Missing envelopes, forged ciphertext, stale/future timestamps,
argument mismatches, and replays have distinct protocol messages. Relay URL
errors explicitly require `wss://` for non-loopback hosts.

## Testing

Direct TCP tests connect to the owner task-transfer socket without using the
runtime client. They prove that spoofed privileged operations never reach the
daemon/Kanna server, that replaying one authentic sealed request invokes the
owner operation only once, and that a stale authentic request is rejected.
Focused proxy tests reject public/private non-loopback `ws://` URLs while
retaining loopback emulator URLs and `wss://`.

Final verification includes task-transfer protocol/runtime tests, the desktop
Rust test target containing the proxy, formatting, repository JavaScript
verification, and a diff review against `origin/main`.
