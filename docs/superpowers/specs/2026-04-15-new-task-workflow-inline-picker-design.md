# New Task Workflow Inline Picker

## Summary

Change the workflow control in the new-task modal from a full-width native `select` to the same lightweight inline pattern used by the base-branch row: current value rendered as text plus a subtle `change` action that expands an option list below the row.

The goal is visual consistency inside `NewTaskModal.vue`, not a broader modal redesign. Submit behavior and workflow value handling remain unchanged.

## Goals

- Make the workflow row visually match the existing base-branch row.
- Keep the common case lightweight by showing only the selected workflow until the user asks to change it.
- Preserve existing task-creation behavior and emitted workflow values.
- Limit the implementation to the modal and its tests unless a shared abstraction becomes clearly necessary.

## Non-Goals

- Changing how workflows are loaded or stored.
- Adding search for workflows.
- Refactoring the base-branch picker into a shared component.
- Changing keyboard shortcuts or task creation semantics.

## Current State

`NewTaskModal.vue` currently presents:

- `Workflow` as a native `select`
- `Base branch` as an inline value with a low-emphasis `change` link that toggles a picker

That creates a visual mismatch inside the same compact modal. The user asked for the workflow control to look similar to the subtle base-branch style and explicitly chose the inline-value-plus-change interaction pattern rather than a restyled native select.

## Requirements

### Functional

1. The modal shows the currently selected workflow inline when collapsed.
2. Clicking `change` toggles a workflow picker below the row.
3. Selecting an option updates the selected workflow and closes the picker.
4. If no workflows are provided, the picker still exposes `default`.
5. Submitting the modal continues to emit the selected workflow name unchanged.

### UX

1. The collapsed workflow row should reuse the same visual language as the base-branch row.
2. The picker should feel lightweight, using simple option buttons rather than a heavy custom menu.
3. The selected option should be visually highlighted in the expanded list.

## 1. Modal UI

Replace the `select` element in `NewTaskModal.vue` with:

- the existing `workflow-row` label
- a compact inline value showing the current workflow
- the existing `change-link` affordance

Below that row, conditionally render a `workflow-picker` when expanded. The picker uses the same structure as the base-branch picker, but without a search input:

- one button per workflow option
- selected option highlighted with the existing selected-state treatment

## 2. State

Add a local `showWorkflowPicker` boolean and a computed `workflowOptions` list:

- use `props.workflows` when available and non-empty
- otherwise fall back to `["default"]`

`selectedWorkflow` remains the source of truth for submit behavior.

## 3. Styling

Reuse the base-branch styling vocabulary where practical:

- inline monospace-ish value text for the current selection
- `change-link` for the low-emphasis action
- stacked button list below the row

Introduce workflow-specific classes only where the existing base-branch classes would be misleading or too tightly coupled to branch semantics.

## Error Handling

- No new async behavior is introduced.
- If the provided workflows list is empty, the UI falls back to `default` exactly as the current `select` does.

## Testing

Update `apps/desktop/src/components/__tests__/NewTaskModal.test.ts` to cover:

- inline display of the selected workflow before the picker opens
- toggling the workflow picker
- selecting a workflow option and submitting the new value
- preserving the `default` fallback when no workflows are provided

Run focused component tests plus TypeScript verification after the implementation.

## Files Expected To Change

- `apps/desktop/src/components/NewTaskModal.vue`
- `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`

## Open Decisions Resolved

- Interaction pattern: inline current value plus `change` link
- Picker behavior: simple inline options, no search
- Scope: modal-local implementation, no shared picker abstraction
