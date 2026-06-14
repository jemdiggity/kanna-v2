# Mobile cloud agent routing E2E coverage note

This fix crosses Firestore task indexing, mobile controller task-view selection,
and KSP relay stream/input routing. A full mobile cloud E2E for this path is not
feasible in the current automation harness because it would need all of the
following in one repeatable run:

- a signed-in mobile app session backed by Firebase Auth
- seeded Firestore cloud task snapshots with `agent.type = "agent"` and owner
  route fields
- a relay-visible desktop owner serving the matching local task id
- a live KSP `observeTaskAgent` stream plus command/input channel
- Appium/Metro/native mobile orchestration with safe cleanup of cloud state

The current `apps/mobile/e2e` cloud mode can launch the force-cloud mobile shell
when credentials are provided, but it does not provision this end-to-end
Firestore plus relay owner fixture hermetically for CI or local agent runs.

Narrower regression coverage added instead:

- `apps/mobile/src/lib/firebase/taskIndex.test.ts` verifies
  `mapCloudTaskSnapshot` preserves `agent.type` as `TaskSummary.agentType`.
- `apps/mobile/src/lib/transports/remoteTransport.test.ts` verifies uncached
  `observeTaskAgent` cloud routes resolve through `listCloudTasks()` to
  `{ desktopId: ownerDesktopId, taskId: ownerLocalTaskId }`.
- `apps/mobile/src/state/mobileController.test.ts` verifies a signed-in live
  cloud task with `agentType: "agent"` opens through `observeTaskAgent` rather
  than the PTY terminal stream.
