# Mobile Activity Task Order Design

## Goal

Order the mobile Activity view by attention state so unread tasks appear first,
idle/read tasks appear second, and working/busy tasks appear last.

## Current Behavior

The Activity tab renders the `recentTasks` collection in source order. LAN
results are ordered by most recently updated, cloud results are ordered by
their cloud update timestamp, and hybrid results preserve the cloud projection
before adding unmatched LAN tasks. Activity does not currently affect the
display order.

## Scope and Ordering Contract

The new ordering applies only to the mobile Activity view. The repository Tasks
view, Search results, task APIs, cloud index, and LAN/cloud merge contracts keep
their existing order.

Activity tasks are grouped in this priority:

1. `unread`
2. `idle`, missing, null, or unrecognized activity
3. `working`

Within each group, tasks retain their incoming order. This preserves the
existing recency semantics without requiring the mobile presentation layer to
know whether a task came from LAN, cloud, or a hybrid snapshot.

## Architecture and Data Flow

Add a small pure stable-ordering helper near the Activity presentation. It maps
each task's effective activity to a numeric priority and sorts a copy of the
incoming array by that priority. The original store array is not mutated.

`TasksScreen` applies the helper only when rendering its Activity/Recent mode.
Its normal repository mode continues filtering by selected repository and
passes the filtered tasks through without activity-based reordering.

No new state, persistence, network request, database migration, or transport
behavior is required. When a live task update changes activity, the existing
store publication rerenders the screen and the derived Activity order updates.

## Compatibility and Error Handling

Missing, null, and values outside the recognized mobile activity union degrade
to idle/read priority, matching the existing rendering behavior. Sorting never
rejects a task or changes its contents. Equal-priority tasks retain source
order, so ties are deterministic relative to the accepted collection snapshot.

## Testing

Add focused unit coverage proving that:

- Activity orders unread tasks before idle/read tasks and working/busy tasks;
- multiple tasks in the same activity group preserve their incoming order;
- missing activity is treated as idle/read;
- the repository Tasks view retains its existing filtered source order; and
- the input task array is not mutated.

Run the focused mobile screen tests and the mobile TypeScript typecheck after
implementation.

## Non-Goals

- Changing server, Firestore, or hybrid-source ordering.
- Reordering repository task lists or search results.
- Changing activity lifecycle, mark-read behavior, typography, or labels.
- Adding visible grouping headers or status controls.
