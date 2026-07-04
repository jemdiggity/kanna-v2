# Daemon Kill Reap E2E Gap

The staging task-creation hang depended on a child process remaining stuck while
the daemon handled `Kill`. That exact state is not currently deterministic to
reproduce in a portable daemon integration test: after `SIGKILL`, normal test
children become reapable immediately, while the problematic case requires the
kernel to keep the child unreapable inside process teardown.

The real-daemon regression coverage is
`crates/daemon/tests/reconnect.rs::kill_keeps_same_management_connection_responsive`.
It drives one Unix socket management connection through `Spawn -> Kill -> List -> Spawn`
with tight timeouts, proving the protocol handler keeps serving later
task-management commands on the same connection after a PTY kill.

The nonblocking reap behavior itself is covered by focused daemon unit tests in
`crates/daemon/src/session.rs`:

- `reap_child_gives_up_when_child_never_becomes_reapable`
- `reap_child_returns_once_child_is_reaped`
- `kill_returns_and_releases_pty_lock_before_child_is_reaped`

A deterministic end-to-end reproduction of the original hang would require a
test seam or fixture that can make the daemon's child reap operation remain
pending after `Kill` while preserving the real Unix socket command loop. A useful
fixture would be a daemon-test-only reaper dependency or child-process shim that
returns the equivalent of repeated `waitpid(..., WNOHANG) == 0` until the test
releases it.
