# Mobile terminal Back reliability: remaining native E2E gap

2026-08-04. Written alongside the mobile terminal Back reliability fix in
`apps/mobile/src/screens/TaskScreen.tsx` and
`apps/mobile/src/navigation/RootNavigator.tsx`.

## Behavior and live coverage added

The existing Appium smoke journey now measures the native Back element and
requires a minimum `48x48` frame. After the smoke has proved that a deliberately
large PTY snapshot reached the real xterm WebView, it focuses the real task
composer, waits for the iOS software keyboard, taps Back, and requires both the
task list and keyboard dismissal. The same smoke continues to exercise the iOS
left-edge navigation gesture and origin-preserving Back behavior.

## Why the complete native journey did not run here

This worktree was started with `./kd dev up --mobile`. The assigned desktop
server became healthy at `http://127.0.0.1:48149`, Metro used port `8174`, and
`test:e2e:preflight` passed for the iPhone 17 Pro simulator and XCUITest 9.9.1.
The smoke then launched the app and established a real Appium/XCUITest session,
but stopped at its intentional fixture guard:

```text
KANNA_E2E_PTY_TASK_ID is required. Provide a known live PTY task whose terminal
snapshot contains KANNA_E2E_PTY_SENTINEL; opening an arbitrary task row does not
prove mobile PTY rendering.
```

The isolated worktree has no deterministic live PTY fixture. Creating an
ordinary mobile task would start a real agent CLI and would not guarantee a
stable large snapshot or sentinel. The run therefore cannot honestly claim it
observed the new 48x48 target or keyboard-open Back journey on the simulator.

A second native edge remains nondeterministic even with that fixture: a local
PTY can deliver its snapshot quickly enough that the connecting overlay
disappears before Appium can locate and tap Back. Delaying the stream with a
timer or relying on a race would not prove the product boundary reliably.

## What would make it fully testable

Add a test-only desktop/server fixture that registers a synthetic PTY task
through the normal task list and terminal stream. It must support controlled
connection release and a deterministic large snapshot/sentinel. The Appium
journey could then hold the task in `connecting`, verify Back across that state,
release the snapshot, verify xterm rendering, open the keyboard, and repeat the
Back assertion without invoking a real agent provider.

## Narrower regression coverage

- `TaskScreen.test.tsx` covers connected, connecting, and 20,000-line output;
  verifies the 48x48 target, pressed styling, busy/disabled accessibility state,
  spinner feedback, keyboard dismissal after a registered tap, duplicate-tap
  suppression, and recovery when the navigation boundary cannot pop.
- `RootNavigator.integration.test.tsx` drives the real `TaskScreen` through the
  controller, session store, and stack boundary while connecting and while a
  20,000-line snapshot plus keyboard-open layout is active. It requires return
  to the task list and terminal subscription cleanup.
- `list-detail-back.test.ts` covers the updated Appium journey contract,
  including the native 48x48 size assertion.

Android hardware Back remains owned by React Navigation's native stack, and
iOS edge-back remains enabled and covered by the existing Appium gesture path;
the custom control does not register a competing `BackHandler` or gesture.
