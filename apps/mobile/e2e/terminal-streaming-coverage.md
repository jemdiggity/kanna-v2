# Terminal Streaming E2E Coverage

## Relay visual companion

`pnpm --dir apps/mobile run test:e2e:relay` now seeds an active
`.superpowers/brainstorm/mobile-relay-companion` session inside the scripted
task worktree and exercises it through the ordinary authenticated KSP relay
tunnel. The simulator journey waits for the native `Visual companion ready`
action, opens and inspects the real companion WebView, clicks a real
`data-choice` element, and waits for the desktop fixture's `state/events` JSONL
entry. It then overwrites the HTML and observes the new revision, writes the
`server-stopped` marker and observes the ended state, restarts the desktop relay
owner with the session active again, and verifies that reconnect restores the
newest screen before returning to the same task terminal.

The relay harness only mutates files under the fixture worktree. It does not
define a companion-specific relay message, preview HTTP route, public URL, or
cloud persistence path. The simulator run requires the existing Firebase
emulators, relay, Appium, and iOS simulator environment managed by the mobile
E2E runner; it never installs, launches, or automates a physical iPhone.

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
The terminal's native loading node now keeps the existing
`mobile.terminal-overlay` selector present after transport connection until the
WebView acknowledges the current snapshot epoch. Consequently the smoke's
existing `waitForTaskTerminalLive` boundary no longer treats snapshot receipt as
render readiness: with the scripted agent's deliberate 10,050-line history, it
waits for xterm application and a paint opportunity before inspecting the
sentinel.
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
verifies following resumes near the bottom. The same runner also injects 10,050
history lines plus a sentinel through the production WebView hook and proves
that the revision-tagged `terminal-content-ready` bridge message is absent in
the injection task, then arrives only after xterm has drained its writes and
the sentinel is present in the real terminal buffer. Run it directly with:

```bash
pnpm --filter @kanna/tui-fidelity test:terminal-safe-region
```

The simulator-free coverage is:

- `tests/remote-e2e/src/lan-layer.e2e.test.ts` now drives the real mobile
  controller and LAN transport through `kanna-server` and the daemon PTY. Its
  scripted terminal enters `stty -echo` before advertising input readiness,
  accepts one multiline paste containing composed Unicode, emits only a
  redacted authoritative result, and proves a mobile close/reopen replaces the
  retained model from a fresh snapshot without fabricating the submitted
  bytes.
- `src/screens/terminalSafeArea.test.ts` and `src/screens/TaskScreen.test.tsx`
  for measured normal, multiline, and keyboard-shifted composer geometry.
- `src/screens/TerminalWebView.test.tsx` for resize/inset/snapshot ordering,
  pre-ready inset coalescing, immediate updates, stable document identity,
  accessible content-loading feedback, reconnect epochs, stale render
  acknowledgement rejection, and the load-completion/output-effect ordering
  that previously skipped retained bytes until remount.
- `src/screens/buildTerminalDocument.test.ts` for large newline-delimited
  base64 frame preservation, the actual xterm DOM/public-buffer contract,
  manual scrollback following, dynamic safe-region alignment, the resize
  bridge, executable fallback touch scrolling, pinch scale clamping, and the
  generated terminal script path.
- `tests/tui-fidelity/src/terminalSafeRegion.ts` and
  `tests/tui-fidelity/src/terminalInitialContentReadiness.ts` for the
  real-browser bundled-xterm integrations described above.
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

## Terminal text selection coverage and Appium gap

The terminal text-selection revision cannot currently drive the complete native
gesture and OS clipboard journey deterministically in the simulator Appium lane.
The lane can open a known live PTY task, inspect a WebView, and click native
accessibility controls, but it has no controlled PTY fixture that guarantees a
specific selectable line at a known buffer row. It also has no cross-context
gesture helper: the current driver wrapper does not map an xterm buffer cell to
native screen coordinates, switch back to `NATIVE_APP`, issue W3C double-tap and
drag actions against the WKWebView, then return to the same WebView context to
assert `term.getSelection()`. Without those two pieces, an Appium double tap can
land on arbitrary changing TUI output and does not prove the selection gesture.

The Copy/Cancel toolbar is native and therefore Appium-clickable once a selection
exists, but the harness has no E2E-only controlled-selection fixture to make that
toolbar appear without bypassing the gesture under test. It also has no verified
iOS simulator clipboard helper. A complete boundary assertion needs a WebDriver
or WDA clipboard adapter that reads and UTF-8-decodes the simulator pasteboard,
handles platform permission/reset behavior, and compares the exact selected text
after Copy. Inferring clipboard success only because the toolbar disappeared
would not prove its contents.

Making the journey deterministic requires all of the following:

- a desktop/mobile-server fixture endpoint that publishes a synthetic PTY task
  with fixed output, dimensions, and a unique selectable sentinel;
- a cross-context Appium helper that locates that sentinel through xterm's public
  buffer APIs, converts its cells through `.xterm-screen` geometry to native
  coordinates, performs double-tap/drag actions, and re-inspects the selection;
- a simulator pasteboard adapter for exact Copy assertions, plus native toolbar
  checks that Cancel clears without changing the pasteboard and Copy clears only
  after the clipboard write succeeds.

The automated substitutes cover each narrower boundary without pretending to be
that missing Appium journey:

- `src/screens/buildTerminalDocument.test.ts` executes the full first-tap xterm
  link activation, second tap, selection, and cooldown order. It proves a settled
  single tap still opens Markdown while a double tap selects it and emits no
  `terminal-file-link` message.
- `tests/tui-fidelity/src/render.ts` repeats that sequence in Chromium with the
  repository's real bundled xterm/link provider, then extends the range and
  verifies ordinary scrolling returns after clear.
- `src/screens/TerminalWebView.test.tsx` covers WebView `postMessage` to native
  Copy/Cancel controls, exact `expo-clipboard` input, success/failure behavior,
  duplicate Copy suppression, and stale success/failure across both task changes
  and WebView reloads.

Physical-device automation remains prohibited for this lane; human on-device
review can supplement these checks but is not a substitute for the missing
deterministic simulator fixture and helpers above.

## Alternate-screen scroll input (Claude fullscreen TUIs)

Claude Code ≥ 2.1.89 renders on the alternate screen buffer, which has no
scrollback, so mobile touch scrolling is forwarded to the desktop PTY as
terminal input instead of moving local xterm scrollback. Coverage for that
path is layered:

- `tests/tui-fidelity/src/render.ts` (`verifyMobileAltScreenScrollInput`,
  run by `pnpm test:tui-fidelity`) drives the repository's real bundled
  xterm inside a touch-enabled Chromium context. It enters the alternate
  screen with button-event mouse tracking and SGR encoding exactly like
  Claude's fullscreen TUI, performs drags in both directions, and asserts
  the exact `terminal-input` bridge payloads: three identical SGR wheel-down
  reports for a three-cell upward drag, wheel-up reports for the reverse,
  and `ESC[B` arrow-key fallbacks once the TUI disables mouse tracking. It
  also proves alternate-screen drags never touch `scrollToLine` or move the
  xterm viewport, and that after `?1049l` drags return to local scrollback
  scrolling with zero bridge input.
- `src/navigation/RootNavigator.terminalInput.integration.test.tsx` mounts
  the real `TaskDetail` route against a real `mobileController`,
  `createKannaClient`, and `createLanTransport` with a scripted KSP socket.
  It proves the `TaskScreen` `onSendTerminalInput` wiring resolves the
  durable task id, routes through the active terminal subscription, and
  lands on the KSP socket as a `term_input` frame with the exact base64
  payload, ordered after the terminal `attach`; empty payloads are dropped.
- `src/screens/TaskScreen.test.tsx` and `src/screens/TerminalWebView.test.tsx`
  pin the component seams (`onTerminalInput` pass-through and bridge-message
  validation), and `src/lib/transports/{lanTransport,relayClient}.test.ts`
  pin `sendInput` → `term_input` on both transports. The server side of
  `term_input` → daemon PTY input is covered by `crates/kanna-server`'s KSP
  tests and predates this feature (desktop typing uses the same frame).

A committed simulator/device flow for this path is blocked by the same
missing deterministic PTY fixture described above, with one addition: the
fixture must run an *alternate-screen* program with mouse tracking. Driving
a real Claude session from automation is not permitted, and OpenCode's TUI
renders inline (normal buffer), so no permitted real agent exercises the
alternate-screen path deterministically. The flow was validated once
manually during development: an ad-hoc Appium journey against a worktree
dev stack — with the task's daemon session replaced by a scripted
alternate-screen TUI that logs received bytes — showed a native 262px
simulator drag scrolling the TUI by exactly 15 rows and exactly 15 wheel
mouse reports arriving at the desktop PTY. Turning that into committed
coverage needs the test-only synthetic terminal-session fixture path above
(spawn an arbitrary command such as a scripted alt-screen TUI under a
task's daemon session id); once that exists, the smoke can assert the
drag-to-PTY loop end to end without any agent CLI.
