# Mobile Create Task E2E Coverage

The mobile create-task journey is not currently practical to cover with a
deterministic Appium E2E test.

After submission, the composer closes immediately and the app opens a normal
task-shaped optimistic workspace backed by a stable local UI slot. A successful
create acknowledges the durable task in that slot without replacing the visible
workspace, then starts its terminal. An ambiguous result keeps the workspace's
task action disabled and offers exact-id recovery; a definite pre-creation
failure removes the optimistic workspace and preserves the draft for a later
retry.

The existing mobile E2E harness launches the real Expo app against a real
desktop/mobile server and verifies visible behavior through Appium. The normal
create API is not a dry-run boundary: it persists a durable task, creates a
worktree and branch, starts an agent session, and proceeds into terminal startup
on the selected desktop. Deterministically distinguishing a request that is
still pending, a response lost after durable creation, an idempotent recovery,
a definite rejection, and a terminal-startup failure requires control between
those boundaries. The current harness cannot inject those outcomes, inspect the
client-generated task identity, control authoritative task publication or
terminal startup, or reset all resulting state. Running the cases against an
ordinary desktop would also depend on a real repo and agent CLI while leaving
durable task, worktree, branch, and session side effects.

Making this journey testable through Appium requires a fixture surface with:

- an isolated fake repo plus a no-spawn agent provider or controllable fake
  terminal session;
- request recording that exposes the client-generated task id and replayed
  payload;
- deterministic controls to defer creation, lose the response after durable
  creation, return an explicit pre-creation rejection, and release exact-id
  recovery;
- controls for authoritative task publication and terminal startup success,
  delay, or failure after acknowledgement;
- reset and cleanup APIs for every created task, worktree, branch, and session.

The narrower automated coverage is:

- `src/App.component.test.tsx` mounts `App` with the real controller/store and a
  deferred client. It covers the immediate optimistic workspace, in-place
  durable-task acknowledgement, an empty collection publication followed by
  authoritative hydration without replacing the selected `TaskScreen` or its
  stable list slot, unavailable creation controls during ambiguity, exact-id
  recovery, and exact draft restoration after a definite pre-creation failure.
- `src/screens/TaskScreen.test.tsx` covers pending and uncertain creation inside
  the task workspace, including a disabled task action and recovery being
  offered only for an uncertain result. `src/screens/TasksScreen.test.tsx`
  verifies that task rows continue to open through the stable UI slot after
  acknowledgement.
- `src/state/mobileController.test.ts` covers persist-before-dispatch and
  single-flight creation, optimistic slot selection, exact-id recovery and
  response fencing, definite-failure slot removal, authoritative
  canonicalization, non-authoritative and first-authoritative publication gaps,
  in-place authoritative hydration, eventual removal after authoritative
  deletion, and keeping the acknowledged task visible when terminal startup
  fails.
- `src/state/sessionPersistence.test.ts` and `src/state/sessionStore.test.ts`
  cover durable attempt validation and round-tripping, legacy slot migration,
  restart hydration as a closed uncertain workspace, draft restoration, and a
  slot lifecycle independent from durable task identity, including collection
  reconciliation owned by the store.
- `src/state/taskUiSlots.test.ts` covers normal task-shaped projection while
  creating, stable presentation identity during acknowledgement, survival
  across non-authoritative and first-authoritative publication gaps, hydration
  into the same slot, bounded miss grace, authoritative deletion, and targeted
  slot removal.
- `src/appModel.cloudFallback.test.ts` verifies that a late LAN supplement is
  part of its primary cloud read rather than a second authoritative miss, so a
  single logical refresh cannot exhaust the acknowledged slot's grace window.

Keyboard interaction with the composer sheet (focusing the prompt input and
scrolling the rest of the sheet while the software keyboard is up) has the same
harness gap: it additionally needs a real simulator/device keyboard, which the
current local-only Appium smoke does not drive deterministically. The sheet's
scroll container carries the stable selector
`mobile.create-task.sheet-scroll` so a future device smoke can scroll it, and
`src/components/CreateTaskComposer.test.tsx` covers the structural contract in
the meantime: the sheet is height-capped and its content lives in a
`ScrollView` with `keyboardShouldPersistTaps="handled"`.

The focused command also retains the editable drawer coverage in
`src/components/CreateTaskComposer.test.tsx` and the stable recovery selector in
`src/e2eTestIds.test.ts`:

```bash
pnpm --dir apps/mobile test -- src/App.component.test.tsx src/appModel.cloudFallback.test.ts src/components/CreateTaskComposer.test.tsx src/screens/TaskScreen.test.tsx src/screens/TasksScreen.test.tsx src/state/mobileController.test.ts src/state/sessionPersistence.test.ts src/state/sessionStore.test.ts src/state/taskUiSlots.test.ts src/e2eTestIds.test.ts
```
