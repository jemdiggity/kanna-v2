# Mobile Task Action Sheet Responsiveness

## Problem

On iOS, pressing the task screen's `+` button briefly shows the native task action sheet, then the sheet dismisses itself and the app stops responding to touches.

The canonical-navigation migration changed this interaction from presenting `ActionSheetIOS` directly on the task screen to first pushing a full-screen transparent `TaskMore` native-stack route. The route presents the action sheet from a focus effect and only pops itself through the sheet's selection or dismissal callback. If iOS dismisses the sheet while the transparent route is transitioning, that callback is not guaranteed to remove the route. The invisible route then remains above `TaskDetail` and intercepts input.

## Design

The native action sheet will again be presented directly from `TaskScreen`. `ActionSheetIOS` already provides the modal interaction and dismissal behavior, so the action sheet does not need a parallel navigation route.

`TaskDetailRoute` will continue to supply `onAdvanceTaskStage` and `onCloseTask` callbacks. It will stop overriding `TaskScreen`'s action-menu opener. Pressing `+` will therefore use the existing in-place `showTaskActionMenu` path, and selecting an action will call the supplied task callback without changing navigation state.

The obsolete `TaskMore` route will be removed from:

- the root stack parameter list and route registry;
- the native-stack screen declarations;
- navigation context and push helpers;
- active-view projection handling; and
- task-action route component and transparent-route styles.

No native code, native configuration, or dependency changes are required. This remains a JavaScript-only mobile change and does not require an OTA runtime-version bump.

## Behavior

- Pressing `+` presents `Task Actions` with `Advance Stage`, `Close Task`, and `Cancel`.
- Selecting `Advance Stage` invokes the existing advance callback once.
- Selecting `Close Task` invokes the existing close callback once.
- Selecting `Cancel` dismisses the sheet and leaves the task screen interactive.
- Opening or dismissing the action sheet does not push, pop, or otherwise mutate the navigation stack.

## Error Handling

Task operation errors continue through the existing controller and session-state error paths. The action menu adds no asynchronous state and no invisible fallback layer. If the native sheet dismisses unexpectedly, the underlying task screen remains the active route and stays interactive.

## Testing

Focused regression tests will verify that:

- the root navigator no longer registers or pushes `TaskMore`;
- the task `+` button uses the direct action-sheet path when rendered by `TaskDetailRoute`;
- action-sheet selections still invoke the existing task callbacks; and
- cancellation does not invoke a task action.

Verification will run the focused mobile navigation and task-screen tests, the mobile typecheck, and the broader mobile test suite when practical.
