# Remote Companion Review Revision Design

**Goal:** Close the seven remaining ordering, accessibility, end-to-end,
resource-admission, and mixed-version gaps in the remote visual companion.

## Generation ordering

Observer registration assigns a monotonic `u64` epoch. Every companion runtime
event and sidecar IPC event carries both the opaque UI generation string and
that epoch. The runtime latest-frame queue registers the current epoch before a
replacement stream can publish, removes pending older work, and rejects late
older snapshots or unavailable frames. The sidecar IPC latest-frame queue keeps
the highest epoch observed per `(peer_id, task_id)` and rejects lower epochs,
including while an older event is blocked in the writer. Reliable results and
errors remain ordered and are not coalesced.

## Desktop activation and accessibility

The DEV-only E2E hook records a sanitized opener outcome after the real Tauri
opener promise resolves or rejects. The physical-click E2E waits for the second
click's successful opener outcome; Playwright still consumes the separately
captured one-time capability because an externally launched macOS browser
cannot be safely adopted by the headless test.

`CloudTerminalView` exposes a localized native button labeled “Open visual
companion.” The button asks the bridge manager to open the currently
authenticated companion snapshot directly, so keyboard and assistive
technology users do not have to target a link rendered inside xterm. The
manager applies the same ownership, snapshot, listener, opener, and lifecycle
checks as pointer activation.

## Mobile paired-LAN journey

The hybrid Appium mode first seeds the deterministic desktop selection and then
claims a real pairing payload, preserving the issued per-device LAN secret.
After the relay is stopped, it opens the duplicate task through LAN and runs the
existing native companion/WebView journey: open, render, source error,
recovery, LAN server disconnect/reconnect, real choice event delivery,
unavailable, resume, and close. This proves React Native WebSocket credential
headers and the native/WebView boundary together.

## Decode and parse admission

The TypeScript stream client removes the eight-frame admission limit and uses
the existing 64 MiB retained-byte ceiling across active and queued decoder
work. A legal maximum chunk burst therefore fits while an oversized aggregate
still reconnects.

The LAN transfer runtime acquires a shared concurrency permit before buffering
a companion wire frame, reserves its retained bytes in a shared budget, and
moves outer JSON parse, sealed payload decryption, and validation into one
blocking decode closure. Both permits live through validation. Terminal and
control tasks remain schedulable while two maximum frames decode.

## Per-connection capability advertisement

KSP builds `auth_ok.stream_kinds` from the connection's `companion_access`.
Paired LAN and relay connections advertise companion; headerless legacy LAN
connections advertise only agent and terminal. Existing stream clients already
translate a missing companion kind into `onUnavailable` without sending an
unauthorized attach.
