# Mobile Task Action Menu Design

## Goal

Keep the mobile task detail's `+` control scoped to the visible task. Tapping it must present task actions without navigating away to the global More tab.

## Scope

The menu contains only:

- **Advance Stage** — advances the task through its pinned pipeline by using the existing mobile controller action.
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
- Run the focused mobile test files, then the mobile test suite or repository-level checks practical for the change.
