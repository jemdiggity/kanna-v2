# Mobile Reply Composer Height Reset Design

## Goal

Restore the mobile task reply composer to its one-line height after its draft is
cleared, including after Send, while keeping the software keyboard open and the
input focused.

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

The input will not be remounted and the fix will not call `blur`,
`Keyboard.dismiss`, or change the existing multiline submission props. The
current input instance and software keyboard therefore remain active after
Send.

## Testing

Extend the focused `TaskScreen` component tests to simulate a multiline native
content-size event, verify that the controlled height grows, send the draft,
rerender, and verify that it returns to 40. The test will also assert that the
input remains multiline with `blurOnSubmit: false`, documenting the keyboard
retention contract. Add coverage that deleting the draft manually resets the
height without submitting.

Run the task-screen tests, mobile typecheck, and the broader mobile unit suite.
