# Terminal Streaming E2E Coverage

`pnpm --dir apps/mobile run test:e2e:smoke` exercises the PTY terminal path in
`specs/smoke/list-detail-back.e2e.ts` only when the run provides a known live
PTY fixture:

- `KANNA_E2E_PTY_TASK_ID` points at an open task whose `agentType` is `pty`.
- `KANNA_E2E_PTY_SENTINEL` is visible in that task's terminal snapshot.
- The same task has a short renamed display title and a distinct multiline prompt
  whose final line contains `PROMPT_END_SENTINEL`.
- The task ID is the complete durable ID expected in the expanded identity panel
  and in the clipboard after the native Copy action.
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
The native journey also taps the selected task's title, verifies the canonical
prompt through its end sentinel, verifies the complete task ID, long-presses the
ID for 1.5 seconds, requires the native iOS `Copy` action, and compares the
decoded WebDriverAgent clipboard with the exact ID. Before the gesture it seeds
and verifies a distinct clipboard sentinel so stale state cannot create a false
positive, and it restores the original clipboard afterward. It then verifies
both the prompt and ID remain mounted, exercises ordinary title-tap collapse and
re-expansion, verifies Back remains exposed, dismisses the panel through the
outside layer, and finally uses Back.

The pinned WebdriverIO/XCUITest stack exposes both native element long press and
the WebDriverAgent clipboard endpoint, so the smoke does not treat a dispatched
gesture as proof of copy behavior. The remaining platform boundary is the edit
menu itself: iOS owns its accessibility tree and localizes the `Copy` item. The
current harness selects the English `Copy` accessibility name and therefore
requires an English simulator/device UI for this assertion. Deterministic
coverage across other locales would require launching the simulator with a
fixed English locale or adding a locale-independent XCUITest edit-menu command;
if the menu item is not exposed, the smoke fails explicitly before reading the
clipboard.

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

For the prompt-expansion revision, `./kd dev up --mobile` successfully started
the assigned desktop server and Metro, and the smoke established a simulator
XCUITest session. The isolated worktree database contained no tasks, so the run
stopped at the intentional `KANNA_E2E_PTY_TASK_ID` guard. A complete execution
requires provisioning the real PTY fixture described above and exporting its id
and terminal sentinel along with `KANNA_E2E_DESKTOP_SERVER_URL`. The narrower
substitutes are the server route tests for full prompt serialization, cloud/LAN
mapping tests, focused `TaskScreen` interaction/accessibility tests, and the
Appium journey contract test using a fake driver.

For the expanded-identity revision, the contract journey models the real
WebDriver protocol boundaries: `longPress`, a separately discoverable native
Copy element, and a base64 clipboard read. The focused component test proves
both text nodes are selectable and carry stable native identifiers. These
narrower tests do not claim that iOS displayed its selection menu; only a smoke
run with the live PTY fixture above can establish that native fact.

The expanded-identity revision also attempted
`pnpm --dir apps/mobile run test:e2e:smoke` in its Kanna worktree. The assigned
Appium and Metro ports were present, but `KANNA_E2E_DESKTOP_SERVER_URL`,
`KANNA_E2E_PTY_TASK_ID`, and `KANNA_E2E_PTY_SENTINEL` were unset, so the runner
stopped at its required desktop-server environment guard before opening an
Appium session. Consequently this revision does not claim that the native menu
was observed in that worktree; the live assertion remains encoded in the smoke
for the next environment with the documented fixture.

The cloud-only full-prompt revision cannot use that smoke as proof of relay
routing. The smoke resolves `KANNA_E2E_PTY_TASK_ID` metadata directly from
`KANNA_E2E_DESKTOP_SERVER_URL`, so its prompt comes from the LAN desktop API
rather than a privacy-bounded Firestore publication. The current fixture tools
cannot create one controlled PTY task that is simultaneously published to the
cloud index, reachable through an authenticated relay owner route, and seeded
with deterministic terminal output. That missing cloud publication + relay
owner fixture prevents a true live Appium E2E without depending on external
Firebase, relay, and agent CLI state.

The narrower integration coverage for this path is intentionally layered:

- `src/appModel.cloudFallback.test.ts` publishes a 500-character cloud-only
  prompt snippet, opens its PTY terminal, verifies the terminal is routed to the
  owner through the relay, verifies authenticated `GET /v1/tasks/{id}` detail
  routing, and observes the mobile store gain the end sentinel beyond character
  500.
- `src/lib/transports/remoteTransport.test.ts` and
  `src/lib/sources/cloudLanClient.test.ts` verify canonical cloud identity and
  hybrid source routing for task detail.
- `src/state/mobileController.test.ts` verifies legacy/error fallback and rejects
  stale detail responses after task navigation.
- `src/screens/TaskScreen.test.tsx` expands a prompt longer than 500 characters
  through its end sentinel.
- `crates/kanna-server/src/cloud_task_publisher.rs` keeps the published snippet
  at 500 characters, while the `/v1/tasks/{id}` route test in
  `crates/kanna-server/src/http_api/tests/core_routes.rs` returns the full prompt
  through the sentinel.

True native gesture E2E for terminal scrolling and composer clearance has the
same fixture constraint plus an Appium/WebView gesture gap: the test must drive
native pan and keyboard input into the WebView while switching contexts to
inspect xterm's public buffer state and rendered geometry. The current smoke can
switch into the WebView and inspect state, but it cannot create a controlled PTY
task or reliably coordinate a native gesture with WebView inspection. Making
that coverage deterministic requires the synthetic terminal-session fixture
path above and a cross-context gesture helper that can issue native pan/input
actions, then assert `buffer.active.viewportY`, the real
`.xterm-scrollable-element` bounds, `data-kanna-bottom-inset`, and rendered
terminal bytes for the same selected task.

The deterministic substitute is the Playwright check in `tests/tui-fidelity`.
It executes `buildTerminalDocument` with the repository's bundled xterm script
and fit addon in Chromium, rather than a DOM stub. It proves clearance for 132,
212, 446, and 526 px obstructions (normal, multiline, keyboard-shifted, and
keyboard-plus-multiline composer layouts), uses a real wheel event to enter
scrollback, verifies append does not move `viewportY` or the top line, and
verifies following resumes near the bottom. Run it directly with:

```bash
pnpm --filter @kanna/tui-fidelity test:terminal-safe-region
```

The simulator-free coverage is:

- `src/screens/terminalSafeArea.test.ts` and `src/screens/TaskScreen.test.tsx`
  for measured normal, multiline, and keyboard-shifted composer geometry.
- `src/screens/TerminalWebView.test.tsx` for resize/inset/snapshot ordering,
  pre-ready inset coalescing, immediate updates, and stable document identity.
- `src/screens/buildTerminalDocument.test.ts` for large newline-delimited
  base64 frame preservation, the actual xterm DOM/public-buffer contract,
  manual scrollback following, dynamic safe-region alignment, the resize
  bridge, executable fallback touch scrolling, pinch scale clamping, and the
  generated terminal script path.
- `tests/tui-fidelity/src/terminalSafeRegion.ts` for the real-browser bundled-
  xterm integration described above.
- `src/state/sessionStore.test.ts` for preserving large base64 frames without
  slicing mid-token.
- `src/state/mobileController.test.ts` for applying ready-event PTY dimensions
  to session store state.
- `e2e/specs/smoke/list-detail-back.test.ts` for Appium WebView context
  switching, exact fixture-row selection, live PTY fixture validation, large
  decoded-byte enforcement, sentinel text checks, expected dimension checks, and
  the prompt expand/end-sentinel/native-long-press/Copy/clipboard/normal-collapse/
  outside-dismiss/Back journey, plus the explicit failure message when WebView
  inspection is unavailable.
