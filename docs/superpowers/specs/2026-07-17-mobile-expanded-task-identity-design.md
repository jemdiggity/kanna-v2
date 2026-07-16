# Mobile Expanded Task Identity

## Goal

Make the expanded mobile task header useful for identifying and reusing task metadata. When a user expands the compact task title, the panel shows both the available full prompt/title and the durable task ID. Both values can be copied through native text selection.

## Interaction

The collapsed header remains unchanged. Tapping it opens the existing bounded, scrollable expanded panel. The full prompt (falling back to the display title) remains first, followed by a visually subordinate `Task ID` label and the complete `task.id` value.

The prompt/title and task ID use React Native's native selectable text behavior. A long press opens the platform text-selection menu, allowing the user to copy all or part of either value. While expanded, the title chip registers a no-op long-press handler so React Native Pressability does not also dispatch the collapse press when the selection gesture ends. No tap-to-copy action, toast, clipboard package, or new native module is introduced. A normal tap on the header continues to collapse it, and tapping the existing outside-dismiss layer continues to close it.

## Accessibility

The title chip remains a single accessible expand/collapse button so the control does not become a cluster of redundant VoiceOver stops. Its expanded accessibility label includes the stage, full prompt/title, and task ID. The visible prompt/title and ID remain selectable for direct touch interaction.

## Architecture and Compatibility

The change stays inside `TaskScreen`: the ID already exists as `task.id`, and the full prompt/title is already resolved there. No API, database, cloud document, navigation, dependency, native project, or OTA runtime-version change is needed.

Legacy tasks without a prompt continue to show their display title. Task IDs are required by the existing `TaskSummary` contract, so no missing-ID fallback is necessary.

## Testing

Focused `TaskScreen` tests will verify that:

- the expanded panel renders a labeled, complete task ID;
- both the full prompt/title and task ID opt into native selection;
- the collapsed header does not add the ID;
- the expanded accessibility label contains the task ID; and
- existing expand, collapse, scroll-bound, task-switch, and outside-dismiss behavior remains intact.

Verification will run the focused `TaskScreen` test suite, the mobile TypeScript check, and `git diff --check`.

## Out of Scope

- Adding a clipboard dependency or copy-confirmation toast.
- Copying a combined prompt-and-ID payload with one action.
- Showing task IDs in task lists or the collapsed header.
- Changing the existing prompt publication or privacy boundaries.
