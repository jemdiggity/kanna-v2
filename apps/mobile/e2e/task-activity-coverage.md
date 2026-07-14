# Mobile Task Activity E2E Coverage

The relay Appium lane seeds a cloud task with `status: active` and
`activity: working`, then PATCHes only the Firestore `activity` field. The app's
live Firestore listener must update the existing rendered task card through
`working`, `unread`, and `idle` before the flow opens the task and continues its
terminal/input checks.

The same lane then makes the owner-server task unread through its runtime-status
route, PATCHes the cloud fixture to unread, and opens it on mobile. The harness
waits for the owner server's activity to become idle through the real relay
`POST /v1/tasks/{task_id}/actions/mark-read` path, returns to the list, and
first requires the selected detail title's activity value to be idle so owner
mutation cannot race ahead of response application. It then returns to the list
and requires the rendered row's accessibility value to be idle. This separates the
activity-only Firestore subscription assertion from the mark-read routing and
debounce assertion while keeping both in one deterministic fixture.

`TaskCard` exposes the effective activity through the existing accessible task
row's native `accessibilityValue`. Appium reacquires that row and reads its
`value` attribute for every poll. This stable probe proves the activity-only
Firestore update crossed the live subscription, controller/store, and React
Native render boundaries.

The iOS Appium lane uses XCUITest's native accessibility tree. That tree exposes
the row's identifier, label, and value, but it does not expose the resolved React
Native `Text` properties `fontWeight` or `fontStyle`. `getCSSProperty` is not an
option because the task card is a native React Native view, not content in the
terminal WebView.

An end-to-end typography assertion would require one of these additional probes:

- a pinned-simulator screenshot with a cropped task-title baseline and image
  comparison; or
- a test-only native view probe that reports the rendered title's
  `UIFontDescriptor` weight and italic symbolic trait.

Until such a probe exists, `src/components/TaskCard.test.tsx` is the narrower
exact style test. It flattens the real component's title styles and asserts bold
non-italic unread text, normal-weight italic working text, and normal idle text.
The Appium accessibility value complements that test by proving which activity
state reached the rendered card end to end.
