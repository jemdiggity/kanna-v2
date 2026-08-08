# Remote Companion Review Round 3 Design

**Goal:** Close the remaining accessibility, event-validation latency,
desktop-first rollout, and attachment replacement gaps in the remote visual
companion.

## Mobile unread accessibility

The visual-companion `Pressable` is the single accessibility element for the
action. When an available companion has an unread revision, its label and text
value announce the new update. Opening the companion continues to call the
existing lifecycle callback, whose owner marks the revision viewed; the next
render removes the unread semantics. The visual dot remains a testable styling
element but is hidden from the accessibility tree.

## Descriptor-only event validation

Companion revisions become hashes of the descriptor-relative identity that
selects and represents the active bundle: session and file names, document and
direct-content entry metadata, active-state marker metadata, and relevant
directory identities. Materialization still reads and hashes asset bytes to
produce asset digests and base64 payloads, but those payload operations are no
longer needed to reproduce the bundle revision.

`append_event` keeps all three existing fences: initial validation, validation
after opening the target session state, and authoritative post-append
validation. Each fence uses the same no-follow descriptor traversal and
metadata revision calculation without reading document or asset payloads. A
maximum-asset regression injects bounded materialization delay and proves event
latency no longer scales with asset payload count.

## Previous-mobile LAN authentication

The paired LAN middleware accepts the existing device-id/device-secret headers.
After a successful authenticated REST request, it returns a short-lived,
HttpOnly, SameSite-strict compatibility cookie scoped to `/v1/stream`. The
cookie contains the already-issued paired-device credential in a cookie-safe
encoding and is revalidated against the pairing store on every WebSocket
upgrade. This works with the previous React Native release, whose fetch and
WebSocket implementations share native cookie storage even though that release
does not add custom WebSocket headers.

Current mobile continues to send explicit WebSocket headers. Headerless and
cookieless LAN connections remain untrusted and receive only agent and terminal
capabilities. Tests cover cookie issuance, authenticated cookie upgrade, and
rejection of malformed or stale credentials.

## Attachment-epoch negotiation and legacy replacement

`auth_ok` advertises an explicit `companion_attachment_epoch` protocol
capability. New servers continue reflecting the client attachment epoch on
attachment-owned companion frames, and new clients require exact epoch matches
when that capability is present.

If a companion is detached and replaced on a server that advertises companion
streaming but not attachment epochs, the client retires the current WebSocket
and reconnects before attaching the replacement. Socket identity already fences
all inbound frames, so a late frame from the previous server socket cannot
reach either handler. Other multiplexed streams reattach through their existing
resume behavior. A new-client/previous-server regression delivers a late old
frame after replacement and proves only frames from the fresh socket reach the
new handler.

## Verification

Each change starts with a focused failing regression. Verification includes the
mobile screen and LAN transport suites, visual-companion and KSP Rust suites,
the stream-client suite, protocol mirror freshness, formatting, type checks,
and `git diff --check`.
