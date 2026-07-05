# Terminal Streaming E2E Coverage

`pnpm --dir apps/mobile run test:e2e:smoke` exercises the PTY terminal path in
`specs/smoke/list-detail-back.e2e.ts` only when the run provides a known live
PTY fixture:

- `KANNA_E2E_PTY_TASK_ID` points at an open task whose `agentType` is `pty`.
- `KANNA_E2E_PTY_SENTINEL` is visible in that task's terminal snapshot.
- `KANNA_E2E_PTY_EXPECTED_COLS` and `KANNA_E2E_PTY_EXPECTED_ROWS` optionally
  override the default fixture size of `80x24`.
- `KANNA_E2E_PTY_MIN_DECODED_BYTES` optionally overrides the default minimum of
  `16384` decoded bytes.

The smoke validates the fixture through the desktop mobile API, opens the exact
task row by id, switches Appium into the WebView, and checks that decoded
terminal bytes reached xterm, the rendered text is nonblank and contains the
sentinel, and the terminal root received the expected desktop PTY dimensions
through `data-kanna-cols` and `data-kanna-rows`. The 16 KiB decoded-byte default
is intentionally above the old 12,000-character base64 cap failure mode, which
could only decode to about 9 KiB and could leave the rendered terminal blank.

This is only testable end to end when the mobile dev stack is running with
`./kd dev up --mobile` and the shell has the generated E2E environment, including
`KANNA_E2E_DESKTOP_SERVER_URL`, `KANNA_APPIUM_PORT`, and an installed simulator
or device build. Without that environment, Appium cannot open the app or inspect
the WebView. Without the PTY fixture environment above, the smoke fails before
opening a task because opening the first visible task row can select an arbitrary
agent task and does not prove PTY terminal rendering.

A fully deterministic mobile/WebView E2E that creates its own PTY fixture is not
available yet. The mobile create-task API starts a real configured agent
provider, so the test cannot currently force stable terminal bytes or a sentinel
without depending on a real CLI's TUI behavior. Making that feasible requires a
test-only desktop/mobile-server fixture path that can spawn a fake PTY command or
register a synthetic terminal session with controlled output and dimensions, then
surface that task through the normal `/v1/tasks` list and KSP terminal stream.

True gesture E2E for mobile terminal pinch zoom and bidirectional scrolling has
the same fixture constraint plus an Appium/WebView gesture gap: the test must
drive native two-finger pinch and pan input into the WebView while inspecting the
xterm DOM state after each gesture. The current smoke can switch into the
WebView and inspect state, but it does not have a stable terminal fixture or a
cross-driver helper that reliably injects multi-touch gestures into the embedded
WebView. Making that coverage deterministic requires the fixture path above and
a gesture helper that can issue native pinch/pan actions, then assert
`#viewport.scrollLeft`, `.xterm-viewport.scrollTop`, `data-kanna-font-scale`,
and rendered terminal bytes in the same selected task.

The simulator-free coverage is:

- `src/screens/TerminalWebView.test.tsx` for pending resize-before-snapshot
  script ordering.
- `src/screens/buildTerminalDocument.test.ts` for large newline-delimited
  base64 frame preservation, the resize bridge, executable fallback touch
  scrolling, pinch scale clamping, and the generated terminal script path.
- `src/state/sessionStore.test.ts` for preserving large base64 frames without
  slicing mid-token.
- `src/state/mobileController.test.ts` for applying ready-event PTY dimensions
  to session store state.
- `e2e/specs/smoke/list-detail-back.test.ts` for Appium WebView context
  switching, exact fixture-row selection, live PTY fixture validation, large
  decoded-byte enforcement, sentinel text checks, expected dimension checks, and
  the explicit failure message when WebView inspection is unavailable.
