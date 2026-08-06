# Consecutive E2E harness runs — startup coverage gap (2026-08-06)

## The behavior

A dev build carried the `build.devUrl` of the run that first compiled it. `tauri dev`
merges `tauri.conf.local.json` into `TAURI_CONFIG` and `tauri::generate_context!()` expands
it at rustc time, so the URL is compiled in; `tauri_build` only asks cargo to rerun the
*build script* when `TAURI_CONFIG` changes, and a rerun whose output is unchanged leaves
the compiled crate alone. The second harness run in a worktree therefore relinked a binary
still pointing at the first run's port.

That URL is also what Tauri's capability ACL treats as `local`, so the failure had two
faces:

- stale port dead → the first navigation is refused, the window sits at `about:blank`, and
  `waitForApp` timed out after ten minutes with nothing to act on;
- stale port still served by a leaked dev server → the page loads but every ACL-scoped
  command is denied (`event.listen not allowed on window "main" … allowed on: [… URL:
  local]`) and the app renders "Kanna couldn't start safely".

Fixed by `apps/desktop/src-tauri/build.rs` (`pin_tauri_config_fingerprint`), which emits
the effective config's fingerprint as build-script output so the crate itself is dirtied
and the context re-expands.

## What is covered

- `apps/desktop/tests/e2e/mock/app-launch.test.ts` — asserts the window's origin is this
  instance's `KANNA_DEV_PORT`, the invariant the stale build broke.
- `apps/desktop/src-tauri/src/dev_url.rs` — unit tests for the mismatch tripwire that names
  the problem in the desktop pane if the build fix ever regresses.
- `apps/desktop/tests/e2e/runStartup.test.ts` — a window stuck on the wrong URL is
  classified and reported instead of silently timing out.
- `apps/desktop/tests/e2e/runPorts.test.ts` — ports come from below the ephemeral range,
  are reserved until start, and are never adjacent (vite HMR is `devPort + 1`).

## What is not covered, and why

**The regression itself only appears across two separate harness invocations.** One
`tests/e2e/run.ts` invocation allocates its ports once and builds once, so no suite inside
it can observe a build carrying a *previous* invocation's port. Reproducing it needs a
second invocation against a warm cargo cache — the harness is the unit under test, not a
suite within it.

No lane runs the harness twice today. Adding one costs two full harness startups (~2–4 min
warm, far more cold), which is why it is not simply appended to the mock lane.

Secondary gap: the harness's own unit tests (`apps/desktop/tests/e2e/*.test.ts`,
`tests/e2e/helpers/*.test.ts`) are in no automated lane — `apps/desktop`'s `test` script
runs `vitest run src`. Wiring them in is blocked by two pre-existing failures unrelated to
startup (`realSuiteNaming.test.ts`, `firebaseEmulators.test.ts`), so the tests listed above
run only when invoked directly.

## What would make it testable

- A `kd test e2e-consecutive` lane that invokes `tests/e2e/run.ts mock/app-launch.test.ts`
  twice in one worktree and asserts both pass — the second invocation is the assertion.
- Fixing the two stale harness unit tests, then extending `apps/desktop`'s `test` script to
  cover `tests/e2e` (excluding `mock/` and `real/`) so the four suites above run in CI.

## Manual verification recorded on 2026-08-06

Run on this machine, in `.kanna-worktrees/task-27d0c5d7`, each line a separate
`pnpm --dir apps/desktop test:e2e` invocation:

| # | Suite | Before the fix | After the fix |
|---|---|---|---|
| 1 | `mock/app-launch.test.ts` (cold build) | 6 passed | — |
| 2 | `mock/app-launch.test.ts` (consecutive) | **timed out — about:blank** | — |
| 3 | `mock/app-launch.test.ts` | — | 7 passed |
| 4 | `mock/app-launch.test.ts` (consecutive) | — | 7 passed |
| 5 | `real/local-transfer-accept-import.test.ts` (two instances) | — | 1 passed |

Before the fix, run 2's binary embedded run 1's port (`http://localhost:53068` against a
config of `http://localhost:53957`) and the webview reported `about:blank`; navigating that
webview to the live dev server by hand loaded the app, which is what identified the cause.
Touching any file in `apps/desktop/src-tauri/src/` before a run has the same effect — the
crate recompiles, so the context re-expands — which is the manual workaround this fix
replaces.

Also verified: `mock/task-lifecycle.test.ts` and `mock/action-bar.test.ts` fail on in-app
assertions (`repository setup task to settle`, `waitForText(".task-header", "Say OK")`) both
with this fix and on unmodified `9bd89b2d` with a forced rebuild. Those failures are
reproducible, unrelated to startup, and out of scope here — the mock lane stops at the
first failing suite, so `mock/` cannot run to completion until they are fixed.
