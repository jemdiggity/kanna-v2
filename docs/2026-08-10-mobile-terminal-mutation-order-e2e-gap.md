# Mobile terminal mutation ordering E2E gap (2026-08-10)

## Behavior at risk

The mobile terminal replays an attached PTY snapshot into xterm and then applies
live output received through KSP. A live frame must not be written until every
chunk of the preceding snapshot has finished. Otherwise xterm can apply the
live user input and agent response between older snapshot chunks, after which
the remainder of the snapshot redraws over that new content. Leaving and
reopening the task hides the failure because the next attachment replays one
new, complete snapshot.

The terminal document now serializes replacement and append mutations through
their xterm write callbacks, preserving stream order across the native-to-WebView
bridge.

## Why a live mobile E2E is not run here

The existing Appium smoke can inspect a pre-provisioned PTY task, but this
worktree has none of its required `KANNA_E2E_PTY_*` fixture variables. More
importantly, that fixture cannot pause xterm halfway through a multi-chunk
snapshot and inject controlled live output at that exact boundary. An ordinary
send-and-observe journey would usually execute after the initial snapshot has
settled and would pass with the broken implementation.

A deterministic native E2E needs a test-only PTY/WebView fixture that can hold
an xterm write callback, emit a live frame through the normal KSP path, and then
release the remaining snapshot chunks. The journey can then assert that the
rendered rows end with the input and response without reopening the task.

## Narrower executable coverage

`apps/mobile/src/screens/TerminalWebView.test.tsx` evaluates the generated
terminal document and the same scripts injected by `react-native-webview`
against a controllable xterm implementation. Its regression test pauses the
first snapshot write, injects live user input and agent output, and proves no
live write starts until the complete snapshot finishes. The test fails against
the previous overlapping mutation implementation.

The existing remote terminal E2E tests separately prove that mobile composer
input reaches the real PTY and that its response returns over the terminal
stream; the missing assertion is specifically the native WebView's rendering
order under a deliberately stalled snapshot.
