# KSP PTY Runtime Status E2E Gap

The desktop E2E harness cannot currently prove that KSP is the authoritative
runtime-status channel for an attached PTY session. Its mock agent executables
can produce terminal bytes, but the daemon's PTY status detector depends on
provider-specific TUI state and timing; the harness has no supported command or
fixture for forcing a live daemon session through a deterministic
`busy`/`waiting`/`idle` transition. More importantly, the legacy Tauri
`status_changed` subscription and `list_sessions` reconciliation poll remain
enabled by design for unattached sessions, so a sidebar assertion could pass
through either fallback even if KSP terminal status forwarding were removed.

A meaningful desktop E2E becomes practical when the harness has a daemon test
fixture that can set a named PTY session's runtime status (or feed a stable,
versioned provider-TUI transcript into the detector) and can temporarily disable
the legacy Tauri status listener and poll. The test can then mount the task
terminal, drive `busy`, assert the sidebar task becomes `working`, drive `idle`,
and assert selected tasks become `idle` while unselected tasks become `unread`.

Narrower deterministic coverage added instead:

- `crates/kanna-server/src/ksp.rs` drives `stream_terminal_once` against a fake
  daemon and verifies initial snapshot status, matching mid-stream status, and
  filtering of another session's status.
- `crates/daemon/src/protocol.rs` verifies terminal snapshot status round-trip
  and mixed-version defaulting, while live snapshots copy the locked session
  status.
- `packages/stream-client/src/stream-client.test.ts` verifies terminal and agent
  attachment routing, optional-handler safety, and unattached-task behavior.
- `apps/desktop/src/composables/useTerminal.test.ts` verifies terminal lifecycle
  forwarding into the store-registered sink.
- `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts` verifies working,
  selected idle, unselected unread, setup/closed guards, and duplicate KSP plus
  legacy delivery without a second reload.
