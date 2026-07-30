# Daemon restart failure reporting: desktop E2E gap

The daemon integration suite can deterministically wedge an incumbent after it
accepts a handoff connection, shorten the successor response deadline, and
prove all three safety properties against real daemon processes and a real
PTY:

- the successor exits non-zero rather than publishing an empty daemon;
- the incumbent remains the published socket owner and its pre-existing PTY
  remains usable before and after the failed attempt;
- the stable lifecycle audit records the timeout and that the incumbent
  retained ownership.

The desktop real E2E suite already exercises the successful production
app-spawned successor topology and verifies PTY I/O after replacement. It does
not yet exercise the wedged-incumbent branch because the response-delay and
short-deadline controls are process-start environment hooks. The desktop E2E
runner starts the first daemon before an individual test can select those
hooks, while applying them to the whole runner would make suite bootstrap
itself fail.

A full desktop restart failure test becomes practical when the debug-only
replacement command can pass one-shot handoff fault injection to the incumbent
without changing production protocol or when the real E2E runner supports
per-test app relaunch environments. At that point the test should assert the
same incumbent pid remains connectable and that the operator-visible daemon
diagnostic reads the lifecycle audit reason.

Narrower coverage in the meantime:

- `crates/daemon/tests/handoff.rs`:
  `test_handoff_unresponsive_incumbent_keeps_sessions_and_audits_failure`;
- the existing desktop real E2E PTY replacement test in
  `apps/desktop/tests/e2e/real/pty-session.test.ts`;
- existing ambiguous disconnect and partial-fd-transfer fail-closed daemon
  integration tests.
