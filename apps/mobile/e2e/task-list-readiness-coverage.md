# Mobile Startup and Task-List Readiness E2E Coverage

The mobile Appium harness cannot currently hold app initialization or task
collection publication at a deterministic boundary, so it cannot reliably
assert the startup and task-list loading states.

The existing `mobile.app-startup-loading` selector exposes the startup label,
but Appium attaches to the native app before the Expo development client opens
the JavaScript bundle. `waitForExpoAppReady` also dismisses native/Expo startup
overlays and waits for `mobile.app-shell`; by the time Appium can query the
React Native accessibility tree, `App.initialize()` can already have completed.
A smoke that merely races that selector would therefore pass or fail based on
machine and Metro timing rather than product behavior.

The E2E trust-seed surface does not solve this. The `kanna://e2e-trust` deep link
can persist a desktop identity and trigger a reload only after the app's link
handler is installed. It cannot:

- pause persistence hydration or `App.initialize()` before the startup label is
  replaced by `RootNavigator`;
- defer, reject, or release the initial `listRecentTasks`/`listRepoTasks` read;
- hold and release an authoritative cloud task publication;
- trigger a later refresh while retaining a known last-good task collection;
- reset those gates between Appium assertions.

Deterministic Appium coverage needs an E2E-only fixture controller available
before initialization begins. It should provide independently releasable gates
for session hydration and the first task collection, select the collection's
empty/task/error result, publish a later refresh on command, expose readiness to
the runner, and reset all state before relaunch. The Metro environment used by
`ensureExpoServer` must opt into the controller so production and ordinary dev
launches never wait on test infrastructure. With those controls, a smoke can:

1. launch with hydration held and assert `mobile.app-startup-loading`;
2. release hydration while holding the first collection and assert the task
   loading accessibility node;
3. publish empty, populated, and failed initial results in isolated relaunches;
4. start a delayed refresh from populated state and assert the existing task
   row remains visible until release.

Until that fixture exists, the deterministic automated coverage is:

- `src/navigation/RootNavigator.integration.test.tsx` renders the real
  `RootNavigator -> TasksScreen -> TaskList -> LoadingText` path with a real
  session store and mobile controller. It proves loading before the initial
  read, genuine empty and populated content after authoritative reads, a static
  initial error, and preservation of existing task content during a deferred
  later refresh.
- `src/App.component.test.tsx` covers the `App.initialize()` startup switch and
  the stable `mobile.app-startup-loading` selector at the component seam.
- `src/components/LoadingText.test.tsx` proves the visible ellipsis advances and
  retains loading accessibility semantics.
- `src/state/mobileController.test.ts` and `src/state/sessionStore.test.ts`
  cover readiness transitions for polling, authoritative cloud publication,
  subscription failure, and refresh settlement.

`create-task-coverage.md` is intentionally separate: it documents optimistic
task creation and recovery boundaries, not startup or task-list readiness.
