# Mobile alternate-screen terminal scrolling: E2E gap

**Date:** 2026-07-29
**Area:** `apps/mobile/src/screens/buildTerminalDocument.ts` (WebView terminal gestures)

## What was measured

Reported as "vertical scrolling is broken on Claude terminals in the mobile app
on staging". The provider asymmetry is real, and it comes from what each agent
CLI does to the PTY. Captured from real PTYs (`TERM=xterm-256color`, 48 rows):

| CLI | alternate screen | mouse tracking |
|---|---|---|
| `claude` 2.1.220 | `ESC[?1049h` | `ESC[?1000h ESC[?1002h ESC[?1003h ESC[?1006h` |
| `codex` | none | none |

So Codex renders inline in the normal buffer and mobile drags scroll real xterm
scrollback. Claude renders full-screen in the alternate buffer, which has no
scrollback, and takes the `forwardAltScreenDrag` path added in `2b96ff6d`.

That path is a no-op against current Claude. Feeding a live Claude PTY the exact
SGR reports xterm.js emits for a mobile drag:

| input | Claude's response |
|---|---|
| 10x wheel-up (`ESC[<64;20;10M`) | 36 bytes, only re-asserting its own mouse modes |
| 10x wheel-down (`ESC[<65;20;10M`) | 0 bytes |
| 5x PageUp (`ESC[5~`) | 0 bytes |
| 5x arrow-up (`ESC[A`) | 2971 bytes, but it is prompt-history navigation |

Claude enables mouse tracking and then ignores wheel reports. Its transcript is
not scrollable from outside the process, by any byte sequence we can send.

The part that *was* our bug: the grid is rendered at the PTY's row count and the
viewport is force-pinned to the bottom by `alignViewportToSafeRegion()`, while
the vertical gesture branch only ever drove `term.scrollToLine` or the wheel
replay -- never `viewport.scrollTop`. Measured in Chromium at iPhone 15 Pro size
(393x852, composer inset 132) against a 60-row PTY, i.e. any desktop-created
task:

```
rootHeight 900  viewportClientHeight 852  viewportScrollHeight 1032  viewportScrollTop 180
first fully visible row: alt-row-13      (rows 1-12 rendered but unreachable)
```

Rows 1-12 of the live frame were rendered and permanently off-screen. Codex hid
this because its clipped band is stale scrollback that xterm scrolling reveals
anyway. The fix makes an alternate-screen drag pan `viewport.scrollTop` first
and chain only the residual to the existing wheel replay.

## Why there is no E2E test

The mobile Appium/Maestro harness (`apps/mobile/e2e/`) cannot assume a live
alternate-screen agent session:

- Driving Claude Code programmatically is not permitted, so the harness cannot
  stand up the one CLI that reproduces the condition.
- OpenCode, the provider the live-agent specs do use, renders inline in the
  normal buffer, so it never enters the alternate screen and never exercises
  this branch. (Same constraint recorded for `2b96ff6d`.)
- The behavior is a native touch drag inside a `react-native-webview`, so it
  needs a real device gesture on a real alternate-screen frame; a JS-injected
  event would prove the document logic that unit tests already prove, not the
  wiring.

## What was tested instead

- `apps/mobile/src/screens/buildTerminalDocument.test.ts` (happy-dom, executes
  the real generated document): the clipped frame is uncovered before any wheel
  replay; the residual past a fully uncovered frame still reaches the PTY as
  wheel input; an uncovered frame holds position across redraws; dragging back
  down re-pins to the composer safe region; `__replaceTerminalState` re-pins;
  normal-buffer drags still use scrollback and never touch `viewport.scrollTop`.
- `apps/mobile/src/navigation/RootNavigator.terminalInput.integration.test.tsx`
  continues to cover the WebView -> controller -> transport `term_input` path,
  which this change does not alter.
- Out-of-band verification for this change ran the generated document in
  headless Chromium at iPhone 15 Pro size against a synthetic Claude-shaped
  stream (alt screen + SGR tracking + 60 rows): rows 1-12 became reachable, the
  position survived an appended redraw, and dragging back down re-pinned and
  resumed wheel forwarding. That harness is not committed because it needs a
  Playwright browser the repo does not vendor.

## What would make it testable

A committed fixture TUI (a small script that enters the alternate screen,
enables SGR tracking, and renders a numbered frame taller than the phone) that
the mobile E2E harness can spawn as a task's PTY command. That removes the
dependency on any real agent CLI and would let a device-level drag assert both
the uncovered rows and the forwarded wheel bytes.
