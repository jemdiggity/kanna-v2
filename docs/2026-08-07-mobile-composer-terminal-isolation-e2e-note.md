# Mobile composer/terminal isolation E2E note (2026-08-07)

## What was reported

Every keystroke typed into the mobile task composer appeared to refresh the
terminal screen.

## What the investigation found

The draft never leaves the composer, so no keystroke reaches `kanna-server`:
`TaskScreen` owns `draftInput` locally and nothing above it observes the draft.
The coupling is a React render coupling, not a data one.

`TaskScreen` renders the reply composer and the fullscreen `TerminalWebView` as
siblings, so a keystroke re-rendered the terminal. That was harmless until
`f74c2014` ("fix mobile terminal output React hot path") moved live output onto
a dedicated `terminalOutputSource` that advances outside React state. From then
on the render-time output props trailed the source, and the terminal's
output-sync effect — whose dependency list contains a per-render closure
(`onMentionedFilesChange`) — re-ran on every keystroke and re-planned a mutation
from those stale props, injecting `__replaceTerminalState` with the older
snapshot. That is the reported refresh: the terminal was rewritten, and rewound,
per keystroke while an agent was streaming.

`b26feab8` ("fix terminal output source authority race", 31 minutes later)
stopped the rewind by returning early from the effect whenever a source is
present. The render coupling itself survived: the terminal still re-rendered on
every keystroke and stayed one prop-identity change away from re-driving the
document. This change removes the coupling — `TerminalWebView` is memoized and
the task screen hands it stable callbacks and a stable `source` object.

Staging has no OTA published for `runtimeVersion` 2.1.4
(`kd mobile ota status --staging` reports no channel pointer), so paired phones
run the JS embedded in their installed staging build. A device installed between
those two commits still carries the rewind.

## Why the fix is not asserted in a mobile E2E lane

The property is "a keystroke must not re-render or re-drive the terminal view".
The Appium lanes can type into the composer and read terminal content through
the E2E inspection hook, but they cannot observe a React re-render, and the
content-level proxy — "streamed output is still present after typing" — only
fails when the source has advanced ahead of React state at the moment of the
keystroke. Reproducing that window on a device needs a live PTY streaming at a
rate the harness does not control, so the assertion would be timing-dependent
and would pass for the wrong reason most runs.

A real-boundary assertion becomes practical if the terminal inspection payload
grows a monotonic replace/append counter that an E2E can sample before and after
typing; the counter would make the property directly observable without racing
the stream.

## Narrower executable coverage added meanwhile

`apps/mobile/src/screens/TaskScreen.composerIsolation.test.tsx` mounts the real
`TaskScreen` and the real `TerminalWebView` against a mocked
`react-native-webview` that records every render and every injected script. With
the output source advanced past the render-time props — the exact state that
produced the report — it proves that typing five characters injects no script,
re-renders the terminal zero times, and calls none of the screen's server-facing
callbacks, while new output emitted by the source still reaches the terminal as
an append. Reverting `TerminalWebView.tsx` to its `f74c2014` content makes that
test fail with the reported symptom: a `__replaceTerminalState` carrying the
stale snapshot.
