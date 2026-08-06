# Transfer sidecar re-parent: E2E written, blocked on the harness fault

2026-08-07. Written alongside T5 (Phase 2 of
[2026-08-06-task-transfer-rearchitecture-plan.md](2026-08-06-task-transfer-rearchitecture-plan.md)),
which moves the `kanna-task-transfer` sidecar under `kanna-server`.

## What the E2E asserts

`apps/desktop/tests/e2e/real/local-transfer-first-milestone.test.ts` is written
and committed. Beyond the pre-existing transfer assertion it now covers the
three things this phase can break:

- **Ownership.** After a control call has forced the sidecar to exist, the
  process listening on this instance's `KANNA_TRANSFER_PORT` has `kanna-server`
  as its parent — not `kanna-desktop`, which owned it before. The port is what
  identifies the process: a dev machine runs several Kanna instances side by
  side, so a name or a bare process list matches all of them.
- **Respawn after a crash.** That pid is `SIGKILL`ed, and the control plane has
  to recover on its own — every subsequent attempt either returns peers or
  throws, and one of them must succeed within a bound. A new pid must be
  listening afterwards, again parented to `kanna-server`.
- **A transfer through the respawned sidecar.** A second task is pushed to the
  secondary instance and must reach `status = completed`, so the recovered
  sidecar is proven to carry a real transfer rather than merely answer.

`local-transfer-pair-machine.test.ts` covers pairing, which rides the same
control plane, and gained a failure message that reports the last observed
picker state so a timeout can be told apart from a picker that never opened.

## Why it could not execute

**The desktop E2E harness cannot bring the app's webview up on this machine.**
This is the fault already documented in
[2026-08-06-transfer-visibility-e2e-gap.md](2026-08-06-transfer-visibility-e2e-gap.md),
reproduced here unchanged: `tests/e2e/run.ts` fails in `waitForApp`, so no test
body runs.

    Error: timed out waiting for app at http://127.0.0.1:50568
        at waitForApp (tests/e2e/run.ts:275:9)
        at async startInstances (tests/e2e/run.ts:582:5)

Everything the harness starts is healthy — vite serves, `kanna-desktop`
launches, the daemon spawns and the event bridge subscribes — and the webview
never navigates. That note eliminated leaked instances, an IPv4/IPv6 vite bind
mismatch, a cold-versus-warm build race, and window occlusion; the fault is
machine-level and owned by its own task. Nothing in this change goes near window
creation, the dev URL, or app bootstrap.

One observation worth recording for whoever owns that task, because it narrows
the search and matches the earlier note's account exactly: **the first harness
run of a session did come up.** Both instances started and `vitest` executed
test bodies, exiting non-zero; every run afterwards failed identically in
`waitForApp`, including runs started from a process table verified clean of this
worktree's `kanna-desktop`, `kanna-server`, `kanna-daemon`, vite and tmux. That
first run's assertion output was lost to a truncated capture and could not be
recovered, because the harness has not come up again since. **So the committed
E2E above is written but unverified — one execution of the pairing suite failed
for reasons that were not captured, and it has not been possible to re-run it.**
Treat re-running these two suites on a machine where the harness works as
outstanding work, not as a formality.

## Coverage added meanwhile

The sidecar-death behaviour — the part of the E2E expectation with the most new
risk — is covered at the layer that owns it, in
`crates/kanna-server/src/transfer_sidecar.rs`:

- `a_dead_sidecar_is_replaced_rather_than_left_wedged` drives the real
  `TransferSidecarSupervisor` against a stub binary speaking the same
  newline-JSON stdio protocol. It makes a control call (which lazily spawns the
  child), `SIGKILL`s exactly the pid that child reported, and then asserts every
  further control call completes within a timeout — a hang fails the test rather
  than stalling it — that one of them succeeds, that exactly one replacement
  process was spawned, and that both incarnations' events landed in the single
  event log the desktop polls.
- The event-log tests cover the cursor contract the desktop depends on:
  durable-versus-advisory eviction, backpressure when only durable events
  remain, `missedEvents` reporting, and a cursor issued by a previous server
  process being refused rather than applied.
- `sidecar_env_takes_the_listen_port_from_the_server_config` asserts the
  staging/production port parity the multi-instance rule requires, and
  `transfer_identity_env_*` in `apps/desktop/src-tauri/src/commands/mobile/mod.rs`
  asserts the desktop stays the single owner of peer identity across the hop
  into `kanna-server`.

What none of these prove is the wiring: that a real `kanna-task-transfer` under
`kanna-server` completes a real transfer between two desktops, and that pairing
still works through the relocated control plane. That is exactly what the
unexecuted E2E is for.
