# Mobile Reply Composer Height Reset Design

## Goal

Restore the mobile task reply composer to its one-line height after its draft is
cleared. After Send, dismiss the software keyboard and release the composer's
focus so interaction returns to the agent terminal.

## Root Cause

The task screen lets the native multiline `TextInput` determine its own height
between the existing 40-point minimum and 120-point maximum. After the Expo SDK
57 / React Native 0.86 native-runtime upgrade, clearing the controlled `value`
does not reliably shrink a text input that previously measured multiple lines.
The JavaScript draft becomes empty, but the native content height remains
expanded.

## Design

The task screen will own the reply input's rendered height.

- Initialize the height at the existing 40-point minimum.
- Update it from `TextInput.onContentSizeChange`, clamped to the existing
  40–120-point range.
- Reset it to 40 whenever the draft is cleared after Send or a quick reply.
- Also reset it when editing changes the draft to an empty string, so deleting
  multiline text manually cannot leave sticky height behind.
- Apply the controlled height to the input style. Keep the existing minimum and
  maximum style constraints as defensive layout bounds.
- On a successful normal or quick-reply submission, call `Keyboard.dismiss()`
  after handing the message to the task. React Native then blurs the focused
  text input and reveals the terminal canvas without remounting either view.
- Empty or disabled submission attempts do not dismiss the keyboard because no
  focus handoff occurred.

The input will not be remounted and the fix will not inject focus into the
terminal WebView. The mobile terminal is a display and gesture surface rather
than a native keyboard-input bridge, so dismissing the active native input is
the focus handoff needed here.

## Testing

Extend the focused `TaskScreen` component tests to simulate a multiline native
content-size event, verify that the controlled height grows, send the draft,
rerender, and verify that it returns to 40. Assert that successful normal and
quick-reply submissions dismiss the keyboard, while empty submissions do not.
Add coverage that deleting the draft manually resets the height without
submitting or dismissing the keyboard.

Run the task-screen tests, mobile typecheck, and the broader mobile unit suite.

### Native relay boundary

The relay Appium task flow will include a focused normal-Send journey before
the existing quick-reply journey. It will use the shared task input and Send
selectors rather than introduce new accessibility IDs.

The journey will:

1. Record the real native input's initial one-line height.
2. Focus the input, enter a multiline draft, and wait for both the software
   keyboard and a native height larger than the initial height.
3. Capture that expanded height and submit through the real Send button.
4. Wait for the controlled draft to clear, the native input to return to the
   initial one-line height (and therefore become smaller than the captured
   expanded height), and the software keyboard to disappear.

The helper-level relay test will model those native state transitions and fail
when submission leaves either the expanded height or keyboard behind. The
existing quick-reply and transport assertions remain separate, so failures
identify whether normal Send reset behavior or quick-reply behavior regressed.

Verification will run the focused relay helper, composer clamp, and task-screen
tests; mobile typecheck; and the canonical relay simulator lane. If simulator
execution is blocked by an external prerequisite, the result will identify the
specific prerequisite and retain the helper test as the narrower boundary
substitute rather than representing it as equivalent native coverage.
