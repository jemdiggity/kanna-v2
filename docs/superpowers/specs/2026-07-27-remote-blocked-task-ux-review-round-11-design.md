# Remote Blocked Task UX Review Round 11 Design

## Goal

Close the remaining authentication, identity, framing, transfer ownership, and
lifecycle-delivery gaps without changing the remote blocked-task UX or current
local/remote terminal behavior.

## Security boundaries

Both `/v1/stream` and `/v2/stream` derive authentication from the socket peer.
Loopback clients may retain empty authentication; every non-loopback client
must present a paired-device credential before any attach, control, request, or
file frame is processed. Relay tunnels remain already authenticated.

Legacy account-scoped device tokens remain valid only for compatibility
routing. They do not receive a cloud task publication generation, do not
advertise snapshot-publication capability, and receive a negative
acknowledgement if they attempt to publish. Desktop-secret sessions remain the
only desktop-scoped snapshot and transfer-identity publishers.

## Bounded peer framing

Peer response reads use `take(limit + 1)` and require a newline within the
limit. Ordinary responses use an explicit bounded limit and retain the existing
request concurrency cap. Artifact fetches use a larger explicit limit sized for
the desktop's 128 MiB compressed archive maximum and a dedicated single-flight
permit, bounding aggregate response allocation. Oversized and unterminated
peers fail with protocol errors.

## Transfer ownership

Incoming transfers gain a durable owner-token lease. A live event can atomically
move only `pending` to `claimed`; startup recovery can additionally take over an
expired lease. Repeated claims, including from the same owner token, do not
create a second worker. The renderer renews the lease while importing and
passes the owner token through state transitions, so a stale worker cannot
finalize the transfer after recovery has taken ownership.

Outgoing transfers gain a partial unique database index on active outgoing
rows by `source_task_id`. The server reports a conflict when a second renderer
tries to insert another active transfer for the same task. Terminal outgoing
states release the key.

## Snapshot sequencing

Each cloud subscription emit captures a monotonically increasing generation.
After asynchronous relay-presence and desktop-ID lookups finish, only the
latest requested generation may map and publish current subscription state.
Older lookups are discarded.

## Lifecycle delivery

State-mutating sidecar events receive stable bridge delivery IDs. The Tauri
bridge retains them after emit, leases one delivery to the authoritative
window, and removes them only after renderer acknowledgement. Nack, window
release, or lease expiry makes the event eligible for redelivery. Renderer
handlers renew leases while doing long-running work.

Bridge retention is bounded by count and serialized bytes and coalesces events
into one ordered in-flight delivery. When full it stops draining sidecar
stdout, providing backpressure instead of dropping work. Sidecar stdout framing
is also bounded. The runtime general event channel is bounded; task-pull
requests have a count cap; finalization state caps waiters and times each waiter
out so disconnects cannot retain unbounded senders.

Incoming-transfer replay and outgoing commit receipts remain durable in their
existing replay store. Task-pull and finalization requests remain safely
reconstructible from peer retries, while their in-process state is coalesced
and bounded.

## Dependency graph

`Cargo.desktop.lock` is regenerated from `Cargo.desktop.toml`, then
`MODULE.bazel.lock` is regenerated through Bazel so `flate2` and `tar` are
direct desktop crate-universe dependencies. The optimized Bazel desktop target
must build.

## Verification

Regression coverage includes:

- hostile non-loopback v1 stream attempts for input, stage advance, close,
  terminal input, and file access;
- a same-account legacy token claiming another desktop ID;
- oversized and unterminated peer responses;
- event-versus-startup import overlap and two-window outgoing-transfer races;
- reverse-completion cloud presence lookups;
- consumer loss between emit and handler acknowledgement, bounded no-renderer
  retention, task-pull overload, and finalization waiter timeout/caps.

Focused frontend, relay, Kanna server, task-transfer, desktop Rust, canonical
JavaScript, and optimized Bazel desktop verification complete the revision.
