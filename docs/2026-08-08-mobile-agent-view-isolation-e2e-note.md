# Mobile composer/agent-view isolation E2E note (2026-08-08)

Follow-up to `docs/2026-08-07-mobile-composer-terminal-isolation-e2e-note.md`,
which recorded the same property for the pty path.

## What was left open

The 2026-08-07 fix (PR #1021) memoized `TerminalWebView` and gave it stable
callbacks, so a composer keystroke no longer re-renders the terminal. It left
the `agentType === "agent"` twin in place: `TaskScreen` renders
`AgentMessageView` and the reply composer as siblings, and the transcript was
not memoized, so every keystroke re-rendered it — re-filtering the whole event
list three times and rebuilding every bubble, tool card, and permission prompt,
on a list that only grows while an agent streams.

The consequence is narrower than the terminal's was. The agent transcript has no
imperative document and no out-of-band output source: `taskAgentEvents` lives in
`sessionStore` React state and reaches the view as a prop, so a stale render
could not rewind the screen the way `__replaceTerminalState` did. What is left
is wasted render work on the screen the operator is typing into. No keystroke
reaches `kanna-server` on this path either — the draft is local to `TaskScreen`
and nothing above it observes it.

`AgentMessageView` is now memoized (implementation exported as
`AgentMessageViewComponent` for the existing unit harness, mirroring
`TerminalWebViewComponent`). `TaskScreen` creates no closures for it — all five
props are passed straight through from its own props — so there was nothing to
stabilize on the screen side, and no ref-held callback was added.

## Why the fix is not asserted in a mobile E2E lane

Unchanged from the 2026-08-07 note: the property is "a keystroke must not
re-render the transcript view", and the Appium lanes cannot observe a React
re-render. The agent path has even less of a content-level proxy than the
terminal did — the transcript renders the same events either way, so a device
run cannot tell a memoized view from an unmemoized one. It becomes observable if
the agent view grows an E2E-only render counter in its accessibility payload
that a lane can sample before and after typing.

## Narrower executable coverage added meanwhile

`apps/mobile/src/screens/TaskScreen.agentComposerIsolation.test.tsx` mounts the
real `TaskScreen` for an agent task with the real `AgentMessageView`, against a
`react-native` mock whose `ScrollView` records every render of the transcript
list. It proves that typing five characters re-renders the transcript zero
times and calls none of the screen's server-facing or agent-facing callbacks,
while a newly streamed event still re-renders the transcript and appears in it.
Replacing `React.memo(AgentMessageViewComponent)` with the bare component makes
that test fail with six transcript renders where one is expected.
