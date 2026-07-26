# Remote Blocked Task UX Design

Date: 2026-07-25
Status: Approved
Scope: Give remote tasks the same blocked-task presentation and stage-action error behavior as local tasks

## Summary

Remote tasks should preserve the owner's blocker graph instead of appearing as ordinary
interactive tasks. A blocked remote task belongs in the sidebar's **Blocked** section.
Selecting it should render the existing blocked-task panel, including the tasks that block
it, instead of mounting the remote agent terminal.

The owner remains authoritative for blocker state. The observing desktop projects the
owner's published blocker IDs into its unified workspace for presentation only; it does
not create synthetic local database records. Remote lifecycle actions must also surface
non-success owner responses so stale snapshots and other server failures do not fail
silently.

## Goals

- Match the existing local blocked-task experience for reachable remote tasks.
- List remote blocked tasks under the sidebar's **Blocked** section.
- Show `Blocked by <task>` using the best available blocker task name.
- Replace the selected task's terminal with the existing blocker list panel.
- Preserve owner authority and avoid inserting remote blocker rows into the local store.
- Surface remote stage-transition failures returned by the owner.
- Keep LAN and cloud representations consistent when both describe the same task.

## Non-Goals

- Changing how blockers are created, removed, or resolved.
- Making blocker rows editable from an observing desktop.
- Allowing the terminal to remain visible behind the blocked-task panel.
- Changing local blocked-task behavior.
- Changing owner-side stage-transition validation.
- Adding navigation from a blocker name to the blocking task in this change.

## Current Behavior And Root Cause

The owner snapshot already publishes `blockedByTaskIds` and derives a snapshot status of
`blocked` when that array is non-empty. The observing desktop currently drops the blocker
IDs while mapping cloud task snapshots into the workspace model.

The local UI obtains blocker state from the local database-backed store:

- sidebar ordering uses local blocker edges to move tasks into **Blocked**;
- blocker names come from local task records;
- `MainPanel` receives `blocked` and a blocker list from local-only computed state;
- remote tasks are explicitly treated as unblocked by those computations.

As a result, a remote blocked task remains in its pipeline stage group and mounts
`CloudTerminalView`. Attempting to advance it reaches the owner, which correctly rejects
the transition, but the cloud relay action helper resolves HTTP error responses instead
of throwing them. The caller's existing error toast therefore never runs.

## Data Model

### Preserve Owner Blocker IDs

Add blocker IDs to the remote snapshot and workspace source shapes:

```ts
interface DesktopCloudTaskSnapshot {
  // existing fields
  blockedByTaskIds?: string[]
}

interface WorkspaceTaskSource {
  // existing fields
  blockedByTaskIds: string[]
}
```

Missing blocker metadata from older publishers is treated as an empty array. Published
task IDs are owner task IDs and must be normalized through the same source identity
mapping used to deduplicate LAN and cloud observations.

### Unified Presentation Projection

Build a presentation-only blocker projection from the final unified workspace:

```ts
interface WorkspaceTaskBlocker {
  blockedWorkspaceTaskId: string
  blockerWorkspaceTaskId: string
  blockerName: string
}
```

For each remote-owned workspace task:

1. collect blocker IDs from its attached remote sources;
2. deduplicate repeated LAN/cloud edges;
3. resolve each owner task ID to the matching unified workspace task;
4. use that task's visible title as the blocker name;
5. retain an unresolved edge with a stable fallback label when the blocker snapshot is
   temporarily absent.

The fallback should identify the task without exposing transport-specific compound IDs,
for example `Task 3c45beea`.

Local blocker edges remain sourced from the local store. The UI-facing projection merges
local and remote edges without writing remote edges into local Pinia or SQLite state.

## UI Behavior

### Sidebar

Sidebar ordering receives the merged blocker projection:

- a remote task with one or more unresolved blockers is placed in **Blocked**;
- its row shows `Blocked by <name>` using the existing local styling;
- remote ownership markers and existing activity styling remain unchanged;
- resolving the final blocker returns the task to its normal pipeline-stage group after
  the next workspace refresh.

### Main Panel

The selected remote task receives the same `blocked` boolean and blocker item list as a
local task. `MainPanel`'s existing blocked branch renders before its terminal branches,
so the remote terminal is not mounted while the task is blocked.

The blocker list is informational in this change, matching the current local blocked
panel. It does not implicitly open or transfer another remote task.

### Stage Advancement

The known blocked state should prevent an attempted advance through the existing UI
guard and show the same blocked feedback as a local task.

Owner validation remains mandatory because the snapshot may be stale. Remote action
clients must inspect relay response status and throw a useful error for non-2xx
responses, including the owner's response body when safe. Existing composable error
handling can then display the error toast. Successful 2xx behavior remains unchanged.

## Source Precedence And Consistency

The workspace continues to prefer the best reachable route for actions and terminal
transport. Blocker metadata is owner state rather than route capability, so identical
LAN and cloud edges are unioned and deduplicated.

If two current sources for the same owner task disagree during propagation, a reported
blocker is retained until a newer authoritative workspace refresh removes it. This
fail-closed presentation prevents briefly exposing a terminal or stage action that the
owner will reject. Snapshot freshness ordering should be used where it is already
available; this change does not add a second synchronization protocol.

## Error Handling

- Missing `blockedByTaskIds`: treat as no published blocker metadata for compatibility.
- Missing blocker task snapshot: keep the task blocked and show the fallback task label.
- Duplicate blocker IDs across routes: render one blocker.
- Relay non-2xx lifecycle response: reject with the owner message and show a toast.
- Transport failure: preserve the existing remote action error path.
- Snapshot refresh after blocker resolution: remove the edge and restore ordinary task
  access.

## Testing

Implementation should follow test-driven development with focused failing tests first:

1. Cloud snapshot mapping retains `blockedByTaskIds`.
2. Workspace construction normalizes and deduplicates blocker IDs across LAN/cloud
   sources.
3. An unresolved blocker remains visible with a stable fallback label.
4. Sidebar ordering places a remote blocked task in **Blocked** and renders its blocker
   name.
5. Selecting a remote blocked task renders the blocker panel and does not mount the
   remote terminal.
6. A remote blocked task cannot invoke stage advancement through the keyboard/action
   path.
7. Cloud relay task actions reject HTTP 409 and preserve the owner's useful error text.
8. A remote task whose blockers resolve returns to ordinary stage and terminal behavior.

Run the focused desktop tests during development, followed by the repository's relevant
frontend test suite and typecheck before completion.

### Review Revision: Interaction And Concurrency Boundaries

The review revision extends the approved design at four integration boundaries:

1. The browser-level App test must mount the real `Sidebar` and `MainPanel` components
   for the remote blocked-task journey. It should prove Blocked section placement,
   blocker-panel rendering, keyboard suppression, owner error toast behavior, and
   terminal restoration after an authoritative unblock snapshot. Component-only and
   projection-only tests remain useful but do not substitute for this interaction test.
2. LAN mark-read must have a deadline below the renderer. The desktop-to-sidecar client
   must multiplex requests without holding the shared service mutex for the duration of
   peer I/O, and the sidecar control loop must execute independent requests concurrently.
   A timed-out request must remove its pending response entry so late responses cannot
   retain abandoned work. LAN polling must also be single-flight so a slow refresh cannot
   build a one-second interval backlog.
3. Relay mark-read must validate the resolved response status and body through the same
   task-action validator used by relay close and advance.
4. Remote advance must be single-flight per owner/task in each viewer, skip when the
   latest snapshot reports `has_running_post`, and be serialized per task by the owner.
   A duplicate owner request while the first transition is being detached is an
   idempotent success. A request arriving after the post run is recorded is also an
   idempotent success rather than the historical running-post override.

The regression suite must include a stalled-peer control-path test, relay mark-read
negative statuses, immediate duplicate advances, and a running-post snapshot.

## Alternatives Considered

### Synthetic Remote Rows In The Local Blocker Store

This would maximize reuse of current computed state, but it would mix replicated remote
presentation data with local database-authoritative records. Store mutations, blocker
editing, and lifecycle operations could then target records the local desktop does not
own. This approach is rejected.

### Snapshot Status Only

Using only `status: "blocked"` would be a smaller patch, but it cannot name blockers,
resolve their state, or provide the existing local experience. It would also preserve
parallel blocker representations. This approach is rejected.

### Generic Error Toast Without Blocker Projection

Surfacing the owner's HTTP 409 would improve diagnostics but would leave the task in the
wrong sidebar section and keep its terminal accessible. It is useful as a defensive
layer, not as the primary UX. This approach is included only alongside the blocker
projection.
