# Terminal recovery teardown E2E gap (2026-08-31)

The recovery helper lifecycle crosses the desktop, detached daemon, helper
stdio, `kd`, and macOS process reparenting. A deterministic automated E2E for
the exact observed failure would need to SIGKILL a real worktree daemon after
its desktop parent has exited, retain the orphan long enough to inspect it,
then invoke `kd dev down` and prove both exit and CPU-idle behavior. The current
test harness does not expose a safe synchronization point between daemon
sidecar spawn and that crash, and CPU-time assertions are too scheduler-sensitive
for CI.

Narrower regression coverage lands with the fix:

- `tools/kd/tests/process-inventory.test.ts` proves teardown orders the owned
  daemon before its recorded recovery child and leaves a second instance's
  inventory and processes untouched.
- `packages/terminal-recovery/tests/worker_session_id_boundary.rs` launches the
  real helper binary and proves daemon-control EOF makes it exit promptly.
- `packages/terminal-recovery/tests/service.rs` injects a permanently failed
  control channel and proves it is read once, preventing the observed
  immediate-error busy loop.

The gap can close when the daemon integration harness can publish a sidecar
spawn barrier and run `kd` against that harness-owned worktree inventory; the
test should then kill the daemon, confirm the helper remains identifiable by
its recorded PID/start identity, run teardown, and verify another live
instance is unchanged.
