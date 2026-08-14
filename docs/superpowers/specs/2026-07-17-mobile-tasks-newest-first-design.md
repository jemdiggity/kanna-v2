# Mobile Tasks Newest-First Ordering

## Goal

Order tasks in the mobile app's repo-scoped Tasks tab by creation time, newest first. Keep the Recent/activity view and search ordering unchanged. Mobile pinning is outside this change.

## Data contract

Add optional `createdAt` metadata to the mobile `TaskSummary` contract so the app can sort consistently across LAN, relay, and merged task sources while remaining compatible with older peers.

- The SQLite-backed mobile API will copy the existing workflow item's `created_at` value into task summaries.
- The Firestore mobile task parser will preserve the existing `createdAt` document field and the cloud summary mapper will expose it as `createdAt`.
- Existing task merge paths use object spreads and will preserve the field without introducing source-specific ordering rules.

## Presentation behavior

`TasksScreen` will filter tasks to the selected repository as it does today, then sort a copied array by `createdAt` descending before passing it to `TaskList`. It will not mutate store-owned arrays.

Tasks with a valid creation timestamp appear before tasks without one. Tasks with equal timestamps, or tasks that both lack timestamps, retain their source order through the stable JavaScript array sort. This provides predictable compatibility while older desktop peers may omit the new optional summary field.

The same `TasksScreen` component also renders the Recent view, so sorting will be enabled only for the repo-scoped Tasks view. Recent continues to use its activity/update-oriented source order.

## Testing

- Add a focused `TasksScreen` test proving repo-scoped tasks are passed to `TaskList` newest first and the input array is not mutated.
- Preserve the existing Recent test to prove its source order is unchanged.
- Add mobile cloud-index coverage proving `createdAt` is parsed, normalized, and mapped into a task summary.
- Add Rust mobile API coverage proving repo task summaries serialize the existing SQLite creation timestamp as `createdAt`.
- Extend the deterministic relay Appium lane with two cloud-persisted tasks in the same repository. Their activity/update ordering will put the older-created task first at the data-source boundary, while their distinct `createdAt` values require the Tasks screen to render the newer-created task first. The journey explicitly selects the Tasks tab and compares native task-row accessibility IDs in visual order.
- Run the focused mobile and Rust tests, mobile typechecking, and broader relevant checks where practical.

## Non-goals

- Mobile task pinning or mobile-specific pin state.
- Changing desktop task ordering.
- Changing Recent/activity or search ordering.
- Reordering tasks by update time or using task IDs as a creation-time proxy.
