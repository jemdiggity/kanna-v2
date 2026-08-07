# Transfer E2E suites after the orchestration move

Date: 2026-08-07
Scope: observed while landing T6 of the task-transfer repair plan (transfer
orchestration moves into `kanna-server`).
Related: [2026-08-06-task-transfer-rearchitecture-plan.md](2026-08-06-task-transfer-rearchitecture-plan.md)

## Suites this change removed or rewrote

The window-election machinery T6 deletes had E2E coverage of its own, and the
suites that drove it through renderer seams could not survive it:

- `apps/desktop/tests/e2e/mock/transfer-lifecycle-consumer.test.ts` — **deleted**.
  It exercised `claim_transfer_event_consumer`, the delivery lease, ack/nack,
  lease renewal and phase claims. Every one of those Tauri commands is gone, and
  there is nothing to rewrite it into: the point of the change is that no window
  is elected. `pnpm --dir apps/desktop test:e2e` enumerates all of `mock/`, so
  leaving it would have failed the default suite deterministically.
- `apps/desktop/tests/e2e/real/cloud-task-transfer.test.ts` — **rewritten in
  part**. Its LAN-to-cloud fallback test asserted two `prepare_outgoing_transfer`
  renderer invokes; preflight is the engine's now, so it asserts the outcome the
  fallback exists for (one durable transfer, completed) and leaves *which*
  failures are eligible for a fallback to `transfer_engine::control`'s own test.
  Two tests were removed with their fault seams — an interrupted destination
  acknowledgment, and the source staying open through a failed destination
  import — because both injected faults by replacing
  `store.approveIncomingTransfer` or failing the
  `acknowledge_incoming_transfer_commit` invoke in the destination *renderer*.
  Those properties are still covered: the acknowledgment is single-flight per
  work item and a failed one releases its claim so the retry re-attempts
  (`a_released_phase_is_reclaimable_by_the_retry`), and the source staying open
  through a failed destination import is asserted end to end against a real seam
  — a repository the destination cannot acquire — in
  `local-transfer-source-handoff-failure.test.ts`.

## Suites that fail for reasons this change does not explain

Two real-E2E suites fail on this machine, reproducibly (three consecutive runs,
each from a fresh instance restart):

- `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts` — all three
  tests. The secondary never observes the primary's task over LAN: no terminal
  text, no remote stage advance, no remote-only sidebar row.
- `apps/desktop/tests/e2e/real/local-transfer-pair-machine.test.ts` — one test,
  at `waitForPairPickerReady` with `mode=null visible=true loading=null`.

## Why they are recorded rather than fixed here

**They are not this task's code.** `git diff origin/main --name-only` touches
none of the LAN-sync path: `useAppCloudWorkspace.ts` (which owns
`initializeDesktopLanTaskSync` and the 1 Hz refresh),
`services/desktopLanTaskIndex.ts` (which publishes this desktop's snapshot),
`services/desktopTransferMachines.ts`, or the sidecar control operations
(`set-task-snapshot`, `list-task-snapshots`, `observe-peer-session`) they use.
T6 moved transfer *orchestration*; LAN task visibility is a different feature
that shares only the sidecar.

**The one shared surface is provably healthy.** T6 added `transfer_error` to the
snapshot projection, which `refreshLanTasks` reads via `/v1/snapshot`. Seven
other real transfer E2Es — `claude-transcript`, `accept-import`,
`repo-acquisition`, `first-milestone`, `missing-session-state`,
`source-handoff-failure`, `headless-engine` — all render and assert against that
same snapshot and pass, so it is not returning a body the frontend cannot read.

**Pair Machine cannot pass as written, on any commit.** `waitForPairPickerReady`
reads `getVueState(primary, "peerPickerMode")`, which resolves
`setupState.peerPickerMode` then `setupState.store.peerPickerMode`.
`peerPickerMode` is neither: it is a property of the `appTaskTransfer` object
App.vue holds, and `<script setup>` exposes only top-level bindings. The test,
its helper, `AppModalLayer.vue` and App.vue's picker wiring are byte-identical
to `origin/main`, so this is a stale test rather than a regression — and pairing
itself demonstrably works, because the seven suites above all pair through the
same `pairWithPeerThroughUi` flow first.

## What would settle the task-sync one

A baseline run of `local-transfer-task-sync` on `origin/main` on this machine.
That was not done here: it needs a second full desktop build in a separate
worktree, and the only `origin/main` worktree available belongs to another task.
Everything cheaper than that has been ruled out above, which is why this is a
note rather than a fix — attributing it to T6 without that measurement would be
a guess, and fixing a feature this task did not touch would be scope the task
did not ask for.

## What is covered meanwhile

The transfer behaviour T6 is responsible for is covered end to end and green:
conversation continuity across a machine transfer, a pull that completes with
**no renderer participating on the source**, a `kanna-server` restart mid-transfer
in each direction, repo acquisition in all three modes, a refused transfer that
stays visible, and a destination import failure that leaves the source open.

`cloud-task-transfer.test.ts` needs cloud credentials and does not run on this
machine, so its rewrite is compile- and parse-checked but not executed here.
