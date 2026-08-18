# Mobile Create Task E2E Coverage

The mobile create-task journey is not currently practical to cover with a
deterministic Appium E2E test.

After submission, the composer closes immediately and the app opens a normal
task-shaped optimistic workspace backed by a stable local UI slot. A successful
create acknowledges the durable task in that slot without replacing the visible
workspace, then starts its terminal. An ambiguous result keeps the workspace's
creation-specific task action menu available with a destructive Close Task
action, alongside exact-id recovery. Closing aborts creation with the reserved
task id on the frozen owning desktop; while that abort is in flight, both
recovery and duplicate task actions are disabled. A definite pre-creation
failure removes the optimistic workspace and preserves the draft for a later
retry.

The existing mobile E2E harness launches the real Expo app against a real
desktop/mobile server and verifies visible behavior through Appium. The normal
create API is not a dry-run boundary: it persists a durable task, creates a
worktree and branch, starts an agent session, and proceeds into terminal startup
on the selected desktop. Deterministically distinguishing a request that is
still pending, a response lost after durable creation, an idempotent recovery,
a user-requested abort that races either create outcome, a definite rejection,
and a terminal-startup failure requires control between those boundaries. In
particular, an abort E2E must hold creation in a known pending or response-lost
state long enough for Appium to open its menu, then observe the exact reserved
task id and frozen desktop sent by Close Task before releasing server-side
creation. The current harness cannot inject or pause those outcomes, inspect the
client-generated task identity, redirect the owning desktop after submission,
control authoritative task publication or terminal startup, or reset all
resulting state. Running the case against an ordinary desktop would also depend
on a real repo and agent CLI while leaving durable task, worktree, branch, and
session side effects.

Making this journey testable through Appium requires a fixture surface with:

- an isolated fake repo plus a no-spawn agent provider or controllable fake
  terminal session;
- request recording that exposes the client-generated task id and replayed
  payload;
- deterministic controls to defer creation, lose the response after durable
  creation, hold and inspect an abort request, return an explicit pre-creation
  rejection, and independently release creation, exact-id recovery, or abort;
- at least two fixture desktop identities so the test can change the currently
  selected desktop after submission and verify abort still targets the
  attempt's frozen owner;
- controls for authoritative task publication and terminal startup success,
  delay, or failure after acknowledgement;
- reset and cleanup APIs for every created task, worktree, branch, and session.

The narrower automated coverage is:

- `src/App.component.test.tsx` mounts `App` with the real controller/store and a
  deferred client. It covers the immediate optimistic workspace, in-place
  durable-task acknowledgement, an empty collection publication followed by
  authoritative hydration without replacing the selected `TaskScreen` or its
  stable list slot, exact-id recovery, and exact draft restoration after a
  definite pre-creation failure.
- `src/navigation/RootNavigator.integration.test.tsx`,
  `src/screens/TaskScreen.test.tsx`, and `src/screens/taskActionMenu.test.ts`
  cover the uncertain workspace's creation-specific Close Task menu, routing
  from the selected local slot into `abortTaskCreation(slotId)`, and the
  ordinary ready-task path into `closeDesktopTask(durableTaskId)`. They also
  verify the abort request uses the reserved task id and frozen owning desktop,
  and that the busy presentation blocks Recover, duplicate menu opens, and
  duplicate actions until the abort settles. The navigation integration test
  additionally holds aborts for two unresolved attempts at once and verifies
  that each route owns its busy state and error text while both frozen-desktop
  requests dispatch independently. `src/screens/TasksScreen.test.tsx` verifies
  that task rows continue to open through the stable UI slot after
  acknowledgement.
- `src/state/mobileController.test.ts` covers persist-before-dispatch and
  single-flight creation, the pre-dispatch persistence/abort race that suppresses
  both original and waiting-recovery requests, optimistic slot selection,
  exact-id recovery and response fencing, definite-failure slot removal,
  authoritative canonicalization, non-authoritative and first-authoritative
  publication gaps, in-place authoritative hydration, exact-attempt abort
  routing, concurrent per-attempt abort dispatch and failure isolation,
  create/abort response races, failed-abort recovery preservation,
  duplicate-action single-flight behavior, eventual removal after
  authoritative deletion, and keeping the acknowledged task visible when
  terminal startup fails.
- `src/lib/transports/lanTransport.test.ts`,
  `src/lib/transports/remoteTransport.test.ts`, and
  `src/lib/sources/cloudLanClient.test.ts` cover the LAN and relay abort request
  shapes plus owner-desktop routing. The server tests
  `http_api::tests::actions::abort_task_creation` and
  `http_api::tests::create_task::abort_waits_for_requested_creation` cover the
  desktop HTTP boundary and the race where abort waits for the requested
  creation before closing it.
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
pnpm --dir apps/mobile test -- src/App.component.test.tsx src/appModel.cloudFallback.test.ts src/components/CreateTaskComposer.test.tsx src/navigation/RootNavigator.integration.test.tsx src/navigation/RootNavigator.component.test.tsx src/screens/TaskScreen.test.tsx src/screens/TasksScreen.test.tsx src/screens/taskActionMenu.test.ts src/state/mobileController.test.ts src/state/sessionPersistence.test.ts src/state/sessionStore.test.ts src/state/taskUiSlots.test.ts src/lib/transports/lanTransport.test.ts src/lib/transports/remoteTransport.test.ts src/lib/sources/cloudLanClient.test.ts src/e2eTestIds.test.ts
```

## Agent provider options

The composer's *agent* choices are covered end to end by
`e2e/agentProviderInventory.integration.test.tsx`, which does not need Appium: it
runs a real `kanna-daemon` and `kanna-server` on an isolated PATH holding exactly
one agent CLI, then drives the app's real LAN transport, client, session store,
controller, and `CreateTaskComposer` against it. It asserts that the desktop
reports only the installed provider, that the composer defaults to it instead of
a constant, and that the providers the machine cannot run have no option in the
rendered sheet.

It is opt-in because it needs Rust binaries built first:

```
cargo build -p kanna-server -p kanna-daemon
pnpm --dir apps/mobile run test:integration:agent-provider-inventory
```

The server side of the same contract runs in the ordinary Rust test suite
(`crates/kanna-server/tests/agent_provider_inventory_http.rs`), which boots the
real server process against a restricted PATH and asserts what `/v1/status` and
`/v1/desktops` report.

Both of those cover the LAN path. The relay path — a phone off the LAN, which is
how App Review reached the machine — is covered in `tests/remote-e2e`
(`pnpm test:remote-e2e`), whose harness runs a real `kanna-server`, the real
relay, and the Firebase emulators. `src/cloud-pairing-auth-discovery.e2e.test.ts`
follows one desktop's real inventory from the snapshot the server publishes,
through relay validation, into the Firestore desktop record the phone reads, and
on into the composer's agent options; `src/lan-layer.e2e.test.ts` asserts the
same inventory on the LAN desktop listing. Both rely on `serverProviderPath` in
the harness, which strips the host's own agent CLIs from the PATH the harness
server inherits so the reported inventory is the fixture's rather than the
developer machine's.
