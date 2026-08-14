# Mobile Task Action Menu Design

## Goal

Keep the mobile task detail's `+` control scoped to the visible task. Tapping it must present task actions without navigating away to the global More tab.

## Scope

The menu contains only:

- **Advance Stage** — advances the task through its pinned workflow by using the existing mobile controller action.
- **Close Task** — closes the task through the existing mobile controller action and is presented as destructive.
- **Cancel** — dismisses the menu without changing the task.

Request Revision is intentionally excluded until mobile has a meaningful PR-review workflow. Run Merge Agent and global More commands are also excluded because they are not part of the requested task-local interaction.

## Interaction Design

The existing `+` button remains in the task composer. It opens a native action sheet on iOS and the equivalent alert action list on other supported platforms, following the established quick-reply menu pattern. The task detail remains visible behind the menu.

The menu acts on the task that opened it. Selecting Advance Stage invokes the existing stage-advance controller operation for that task. Selecting Close Task invokes the existing close controller operation for that task. The Close Task option uses the platform's destructive styling; Cancel uses cancel styling.

## Code Boundaries

- Add a focused task-action menu helper beside the existing mobile screen helpers. It owns platform presentation and converts a selected menu item into a small action identifier.
- Replace `TaskScreen`'s `onOpenMore` contract with explicit advance and close callbacks. The screen opens the action menu and dispatches its selection to those callbacks.
- In `App`, bind both callbacks to the currently rendered task id and reuse `advanceDesktopTaskStage` and `closeDesktopTask`.
- Leave the global More screen and its command palette unchanged; this task only removes the task detail's navigation into it.

## Error Handling

The new menu does not introduce another action state or transport path. Existing controller behavior continues to own request routing, follow-task selection, refreshes, and error publication. Cancel and unknown/out-of-range platform selections are no-ops.

## Testing

- Unit-test the task-action helper on iOS and non-iOS, including labels, destructive/cancel indices, and dispatch.
- Extend `TaskScreen` tests to prove `+` opens the task action menu and routes each selection to the corresponding callback.
- Extend the app component test to prove the callbacks use the selected task id and no longer call `showView("more")`.
- Extend the relay-backed Appium task journey to open a specific task, tap `mobile.task-more-button`, observe the native `Task Actions` sheet with Advance Stage, Close Task, and Cancel, dismiss it with Cancel, and verify the same task detail remains displayed. The journey observes but does not invoke the mutating task actions so the existing relay fixture can continue through its terminal, file-preview, and quick-reply assertions.
- Run the focused mobile test files, then the mobile test suite or repository-level checks practical for the change.

## Revision: Appium Alert Ownership

The relay Appium lane must leave native alerts under test control. Its captured
iOS accessibility lifecycle proves that `Task Actions` reaches
`UIAlertController.ViewDidAppear`, after which Appium's session-wide
`autoDismissAlerts` policy taps outside the sheet and produces
`UIAlertController.ViewDidDisappear` before the title lookup. The product
handler and action-sheet presentation are therefore working; the E2E session
is dismissing the UI it intends to inspect.

Simulator alert handling is explicit per lane: hybrid automatically accepts
the Local Network permission prompt, relay handles alerts manually so it can
inspect and cancel the task action sheet, and other lanes preserve automatic
dismissal of incidental system prompts. The product menu and its selectors do
not change. Relay setup already dismisses known first-launch and password
prompts explicitly.

With native alerts preserved, the lane proceeds through the task action menu
and exposes the existing quick-reply assertion to current XCUITest semantics:
after submission the cleared `TextInput` has no `value` attribute and exposes
its `Reply…` placeholder as `label`. The E2E considers either an empty/value
placeholder or the evidenced label placeholder to be cleared, while the relay
harness continues to verify the exact submitted input separately.
