# KSP Stream Capability Negotiation Design

## Problem

The mobile visual-companion client unconditionally sends an
`attach(kind: "companion")` frame. A desktop server that predates the companion
stream cannot deserialize that frame and replies with an unscoped `bad_frame`.
Relay PTY and companion attachments currently share a `StreamClient`, so the
unscoped error reaches the PTY handler and makes an otherwise healthy terminal
unavailable.

Unit tests exercise matching client and server protocol definitions. The mobile
relay E2E harness also implements the new protocol directly. Neither boundary
detects a stale or mismatched `kanna-server` sidecar.

## Compatibility Contract

KSP authentication advertises the stream kinds supported by the server. The
`auth_ok` frame gains an optional `stream_kinds` field containing `agent`,
`terminal`, and `companion` for the current server.

The field is optional on the wire for backward compatibility. A new client
connected to an old server receives no field and must treat companion streaming
as unsupported. Agent and terminal streams remain available. Existing clients
ignore the additional field from a new server.

When companion streaming is unsupported, `StreamClient` keeps the logical
companion attachment so a later reconnect to an upgraded server can activate
it, but it does not transmit companion attach/detach/event frames. It reports
the companion as unavailable, which keeps the visual-companion control hidden
without turning the task or terminal into an error state.

## Protocol and Client Flow

1. The server authenticates a KSP connection and sends `auth_ok` with its
   supported stream kinds.
2. `StreamClient` records the advertised kinds for that connection.
3. Agent and terminal attachments are restored as before.
4. Companion attachments are restored only when `companion` was advertised.
5. If `companion` was not advertised, the companion handler receives
   `onUnavailable` and no unsupported frame crosses the wire.
6. Disconnect clears negotiated capabilities. A later authenticated reconnect
   negotiates them again, allowing an upgraded server to enable the existing
   logical attachment.

## Error Handling

Capability negotiation prevents the known mixed-version parse error at its
source. Existing task-scoped and connection-scoped KSP error routing remains
unchanged because authentication, authorization, and transport failures still
need to reach active handlers.

Companion event submission returns `false` unless the connection is
authenticated and advertises companion support. Detaching an unsupported
companion removes local attachment state without sending a frame the server
cannot parse.

## Verification

Focused protocol and stream-client tests cover:

- `auth_ok` serialization with all supported stream kinds;
- an old-style `auth_ok` without `stream_kinds` suppressing companion wire
  frames while terminal frames continue normally;
- a reconnect that begins without companion support and later advertises it;
- companion event and detach suppression on an unsupported server.

A desktop real E2E test uses the `kanna-server` sidecar launched by the running
Tauri app. It authenticates over `/v1/stream`, asserts that the shipped sidecar
advertises companion support, sends a companion attach, and fails on
`bad_frame`. This catches frontend/protocol/sidecar skew before release.

## Scope

This change does not alter companion documents, event validation, terminal
rendering, relay framing, or mobile OTA runtime compatibility. It adds a
backward-compatible KSP handshake field, client gating, and regression coverage.
