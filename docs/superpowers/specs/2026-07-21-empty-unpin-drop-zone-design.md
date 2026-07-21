# Empty Unpin Drop Zone Design

## Problem

Pinned and unpinned sidebar tasks are separate connected Sortable lists. Unpinning relies on an unpinned stage list receiving an `added` event. When a repository has two or more pinned tasks and no unpinned stage groups, the sidebar renders no connected receiver below the pin divider, so dragging cannot unpin a task.

## Goal

Allow a pinned task to be dragged below the pin divider and unpinned when no unpinned stage list exists. The target should be visually present only during a relevant drag and should not alter normal sidebar layout outside that interaction.

## Design

`Sidebar.vue` will render an empty draggable receiver below the pin divider when the repository has pinned tasks but no unpinned stage groups. The receiver will use the repository's existing Sortable group, move guard, search disablement, and `onUnpinnedChange` handler.

The draggable receiver will remain mounted at zero height while idle. Keeping it mounted ensures Sortable registers the connected list before a drag begins. When `draggedTaskId` identifies a currently pinned, ready task, a CSS class will expand the receiver to a small, practical drop area. It will collapse again when drag tracking ends. No label or persistent empty-state decoration will be shown.

The existing `onUnpinnedChange` data flow remains authoritative:

1. Sortable adds the pinned task to the empty receiver.
2. `onUnpinnedChange` emits `unpin-item` for the durable task id.
3. It emits the remaining pinned order when any pinned tasks remain.
4. Store invalidation refreshes task state, after which the unpinned task renders in its normal stage list and the empty receiver is no longer needed.

Search continues to disable all task drag mutations. Creating task slots remain rejected by the existing move and ready-task guards.

## Alternatives Rejected

- Making the divider droppable would provide an unnecessarily narrow and surprising target.
- Keeping a permanently expanded catch-all target would add empty space and duplicate normal stage drop targets.
- Mounting the receiver only after drag start risks creating the Sortable instance too late for the active drag.

## Testing

A focused `Sidebar` component regression test will mount two pinned tasks with no unpinned tasks and verify that:

- an empty connected unpin receiver exists;
- it is collapsed before dragging;
- it expands during a pinned-task drag;
- it collapses when the drag ends;
- the receiver routes an added event through the existing unpin handler.

Existing sidebar component tests will be run to catch regressions in pin ordering, search drag disablement, task parenting, and creating-slot guards.
