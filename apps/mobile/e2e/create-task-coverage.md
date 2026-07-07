# Mobile Create Task E2E Coverage

The mobile create-task composer path is not currently practical to cover with a
deterministic Appium E2E test.

The existing mobile E2E harness launches the real Expo app against a real
desktop/mobile server and verifies visible app behavior through Appium. The
normal create-task API is not a dry-run API: submitting the composer creates a
real Kanna task and starts the selected configured agent provider on the
selected desktop. That means an Appium test for this path would depend on a real
repo, real desktop routing, and a real agent CLI session, and it would leave
durable task/worktree side effects. It also cannot currently assert the selected
`desktopId` at the API boundary without instrumenting or replacing the mobile
server.

Making this testable end to end requires one of these fixture surfaces:

- a desktop/mobile-server test mode that exposes an isolated fake repo and
  records create-task requests without spawning an agent, or
- a deterministic fake agent provider plus test-only task cleanup APIs that the
  E2E runner can call after submission.

The narrower coverage for this branch is:

- `src/state/mobileController.test.ts` covers stale saved repo profile desktop
  ids, validates that absent desktops are treated as no selected machine, and
  asserts no `client.createTask` call is made until a valid listed desktop is
  selected.
- `src/components/CreateTaskComposer.test.tsx` covers stale selected desktop ids
  in the UI, disabled Create behavior, missing-machine helper text, and visible
  online/offline machine availability.

Run the focused coverage with:

```bash
pnpm --dir apps/mobile test src/state/mobileController.test.ts src/components/CreateTaskComposer.test.tsx
```
