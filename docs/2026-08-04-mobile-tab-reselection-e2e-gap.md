# Mobile active-tab reselection: native E2E gap

**Date:** 2026-08-04
**Area:** bottom-tab reselection to the active React Native scroll owner

## Intended Appium journey

`apps/mobile/e2e/specs/smoke/tab-reselection.e2e.ts` contains a targeted,
fixture-independent native journey. It opens More, records the native `y`
coordinate of the top heading, deliberately scrolls the always-present build
information control into view until the heading is offscreen, and taps the
already-selected More tab. The assertion requires the heading to return within
two points of its original coordinate, so merely stopping at a stale content
inset does not pass. The journey then focuses the command search input and taps
More again at the top, requiring the keyboard to close while the heading stays
at the same coordinate.

The journey is registered as `test:e2e:tab-reselection`, as the
`tab-reselection` smoke-runner mode, and in the full smoke lane.

## Exact blocker in this worktree

The canonical mobile environment was started twice with:

```text
./kd dev up --mobile
Started tmux session 'kanna-task-f84e905d'.
```

Metro started successfully on the assigned port `8166`, but the kd-managed
desktop/server pane failed while building its bundled Rust dependencies. The
first attempt ended with:

```text
error: failed to write to `.../.build/cargo-build/aarch64-apple-darwin/debug/deps/rmetaRKAsFI/full.rmeta`: No space left on device (os error 28)
```

The second attempt failed at the same boundary for several independent crate
fingerprints, including:

```text
error: failed to write `.../.build/cargo-build/debug/.fingerprint/quote-5858f6a442f98f3f/invoked.timestamp`
Caused by:
  No space left on device (os error 28)
```

This worktree's generated `.build` directory was only about 280 KiB, so it had
no material private artifacts to reclaim. The host subsequently reported 78 GiB
available through `df`, but a fresh kd build still received `ENOSPC` on each
new fingerprint write. No unrelated task, shared cache, or user data was
deleted.

Preflight therefore stopped at its healthy guard before Appium startup:

```text
KANNA_E2E_DESKTOP_SERVER_URL=http://127.0.0.1:48141 pnpm --dir apps/mobile run test:e2e:preflight
Desktop mobile server check failed for http://127.0.0.1:48141/v1/status
```

Without the worktree-isolated `kanna-server`, the app cannot load the More tab
through the supported mobile workflow. Pointing the test at another checkout's
server would violate task isolation and would not prove this worktree's bundle.

## Narrower executable coverage

- `useTabReselectionScrollToTop.test.tsx` proves one reselection call dismisses
  the keyboard and invokes the mounted owner with exactly
  `{ animated: true, x: 0, y: 0 }`, while a missing/non-scroll owner safely
  no-ops.
- `FloatingToolbar.test.tsx` proves an already-active tab emits `tabPress`
  without navigating or recreating navigation state.
- `RootNavigator.integration.test.tsx` drives the toolbar through the tab
  navigator into the real outer `ScrollView` refs for Tasks, Activity, and
  More. It proves different-tab taps do not scroll, active taps do, More query
  state survives, and the same owners remain wired across loading, empty,
  error, 100-task, and 100-command states.
- `tab-reselection.test.ts` executes the Appium journey contract against a
  deterministic fake native UI, including the deliberate scroll-away, exact
  top restoration, repeated top tap, and keyboard dismissal.
- `./kd mobile test` passed all 1,374 executed mobile tests (one unrelated test
  was already skipped), and `pnpm --filter @kanna/mobile typecheck` passed.

## What will close the gap

Restore reliable writable capacity for the host's APFS build volume, rerun
`./kd dev up --mobile`, require `/v1/status` on the assigned mobile-server port
to become healthy, then run:

```text
KANNA_E2E_DESKTOP_SERVER_URL=http://127.0.0.1:48141 pnpm --dir apps/mobile run test:e2e:preflight
KANNA_E2E_DESKTOP_SERVER_URL=http://127.0.0.1:48141 pnpm --dir apps/mobile run test:e2e:tab-reselection
```
