# Blocker Task State Snapshot Design

## Problem

The desktop snapshot contains every `task_blocker` relationship but includes only open tasks from visible repositories in `entries[].items`. When a blocker closes, its relationship remains while its task disappears from the visible item collection. The sidebar treats an absent blocker as unresolved, so a dependent that was correctly unblocked when the blocker reached PR appears blocked again after that blocker closes.

The server already derives blocker resolution from the blocking task: a blocker is resolved when `closed_at` is set or when it is parked at `pr` with a PR URL. That task state must remain the source of truth.

## Design

Extend the UI snapshot with a `blockerTaskStates` map keyed by blocker task ID. Each value carries only the fields required by the shared resolution predicate:

- `closed_at`
- `stage`
- `pr_url`

The server builds this map by joining the blocker relationships to their `pipeline_item` rows. It includes referenced blockers regardless of whether they are closed, belong to a hidden repository, or otherwise do not appear in `entries[].items`. No resolution flag is stored in SQLite or persisted separately.

The existing `taskBlockers` collection remains the durable relationship graph. Desktop consumers resolve each relationship by looking up its blocking task in `blockerTaskStates` and applying `isBlockerResolved`. A missing state is treated conservatively as unresolved because it indicates corrupt, incomplete, or version-skewed snapshot data.

## Data Flow

1. SQLite `pipeline_item` remains authoritative for blocker lifecycle state.
2. `Db::ui_snapshot` selects minimal states for task IDs referenced as blockers.
3. The desktop snapshot client stores `blockerTaskStates` alongside `taskBlockers`.
4. Sidebar ordering and navigation use the shared resolution predicate against the map.
5. LAN/cloud task publication omits resolved relationships from `blockedByTaskIds`, so mobile status matches desktop status.

## Compatibility

Frontend snapshot fixtures may omit `blockerTaskStates` while migrating. Consumers fall back to visible task lookup for those fixtures, preserving the current conservative behavior when neither source contains the blocker. The production server always emits the new map.

## Testing

- Server snapshot test: a closed blocker is absent from visible items but present in `blockerTaskStates` with `closed_at`.
- Sidebar regression test: a dependent is not grouped as blocked when its blocker is absent from visible items but its snapshot state is closed.
- Conservative test: a relationship with no blocker task state remains blocked.
- LAN/cloud projection test: resolved blocker relationships are not published as active blockers.
- Existing focused Rust and desktop unit suites must remain green.

## Non-goals

- Removing blocker relationships when blockers resolve.
- Showing closed or hidden blockers in the normal sidebar task collection.
- Changing when dependents start or how blocker branches are inherited.
