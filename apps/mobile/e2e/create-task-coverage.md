# Mobile Create Task E2E Coverage

The mobile create-task composer path is not currently practical to cover with a
deterministic Appium E2E test.

The existing mobile E2E harness launches the real Expo app against a real
desktop/mobile server and verifies visible app behavior through Appium. The
normal create-task API is not a dry-run API: submitting the composer creates a
durable Kanna task, worktree, and agent session on the selected desktop. The
provisioning behavior also needs deterministic control over a request whose
server result is delayed or lost so the test can distinguish a still-pending
request, an ambiguous result, an idempotent recovery, and a definite rejection.
The current Appium harness cannot inject those boundaries or observe the
idempotency identity. Exercising them against a real server would depend on a
real repo and agent CLI and would leave durable task/worktree/branch side
effects.

Making this testable end to end requires a fixture surface with:

- an isolated fake repo and a no-spawn agent provider;
- request recording that exposes the client-generated task id;
- deterministic controls to defer a response, lose it after durable creation,
  return an explicit pre-creation rejection, and release recovery;
- cleanup APIs for every created task, worktree, and branch.

The narrower coverage for this branch is:

- `src/App.component.test.tsx` mounts the real composer through `App` with the
  real controller/store and a deferred client. It proves that the provisioning
  panel replaces prompt/submit/cancel while pending, that the composer can be
  sent to the background without issuing another create, that late success
  closes the composer and opens the created task, that an ambiguous response
  stays non-editable and recovers with the same durable task id, and that a
  definite pre-creation failure restores the exact editable draft.
- `src/components/CreateTaskComposer.test.tsx` covers the provisioning panel's
  pending, background, uncertain, and recovering controls and its dismissal
  rules.
- `src/state/mobileController.test.ts` and
  `src/appModel.taskCreation.test.ts` cover controller single-flight behavior,
  persistence-before-dispatch, background completion, exact-id recovery,
  stale-response fencing, hydration, and serialized durable state writes.
- Client and transport tests cover typed ambiguous/definite failures and the
  version-safe idempotent `PUT /v1/tasks/{taskId}` request boundary.

Run the focused coverage with:

```bash
pnpm --dir apps/mobile test -- src/App.component.test.tsx src/components/CreateTaskComposer.test.tsx src/state/mobileController.test.ts src/e2eTestIds.test.ts
```
