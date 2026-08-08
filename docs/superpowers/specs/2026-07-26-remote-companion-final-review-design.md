# Remote Companion Final Review Design

**Goal:** Close the remaining lifecycle, localization, authorization, memory,
and stale-work races in the remote desktop visual companion without changing
its LAN/relay user contract.

## Boundaries

The browser document owns immediate interaction safety. It checks availability
before changing selection classes, makes the companion content inert while the
transport is reconnecting, and replaces live companion content with a localized
lifecycle surface on terminal states. A later available state reloads the
authoritative document instead of reviving removed controls.

All browser-owned copy comes from the desktop app's en/ja/ko catalog. The shared
document package accepts an explicit string bundle and embeds only JSON-escaped
values. The Rust loopback bridge stores the app-provided localized ended/error
page strings with the companion bundle, HTML-escapes them, and serves those
pages whenever a new root request arrives after a terminal lifecycle state.

Direct-LAN KSP connections remain usable for the existing unauthenticated
terminal/task surface, but companion attachment and event capabilities are
granted only when the WebSocket upgrade carries a valid paired-device identity.
Relay tunnel connections retain their independently authenticated companion
capability. The server enforces the capability regardless of `include_assets`.

Companion peer requests use a 64 KiB outer ingress ceiling even though other
peer requests retain their existing larger compatibility limits. Decrypted
proofs validate bounded identifiers and canonical 24-byte base64url nonces
before any replay-cache or observer-state allocation.

KSP fan-out retains one shared immutable source frame. Each attachment retains
its logical byte charge from admission through blocking preparation and final
delivery, and every pending/preparing/active value carries the attachment
generation. Detach or replacement invalidates late preparation before it can
emit.

LAN owner delivery escapes sealed wire chunks through a bounded blocking-worker
producer, holds bounded delivery admission until the final byte is written, and
writes with timeout and cancellation awareness. A non-reading observer
therefore cannot retain a maximum bundle or an owner task indefinitely.

The TypeScript stream decoder records the current attachment-generation fence
when companion ingress is queued. Completed decode work is accepted only by an
attachment that existed at that fence. The transfer sidecar adds its
incarnation to every forwarded event, and terminal observers bind their
successful observe response and subsequent events to the same incarnation.

Markerless legacy event logs are repaired while holding the existing file lock:
complete newline-terminated legacy records are preserved byte-for-byte, only
the incomplete tail is truncated and synced, and the new marker transaction
starts at the repaired end.

## Verification

Focused unit and integration tests cover each boundary. The real external
browser journey asserts reconnecting content is inert, terminal lifecycle pages
contain no stale choices or selection markers, and relay recovery reaches a
fresh available revision. The canonical relay-restart E2E is run repeatedly to
check the intended recovery bound.
