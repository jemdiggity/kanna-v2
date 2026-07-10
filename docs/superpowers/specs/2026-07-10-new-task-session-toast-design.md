# New Task UI Initialization Lifecycle

## Problem

Creating a PTY task currently constructs an optimistic `PipelineItem` with a client-generated id. The UI selects that item immediately while the server prepares the durable task, worktree, and agent session.

The server independently assigns the real task id. During the handoff, the optimistic item's pending marker is cleared before selection moves to the server-created task. `MainPanel` therefore interprets the client-generated item id as a daemon session id, attempts to attach, receives `session not found`, and shows a recovery toast even though task creation succeeds.

The root modeling error is that one field is serving two unrelated identities:

- the identity of an item that already exists in the UI; and
- the durable task id used by the server, database, task actions, and daemon session.

## Decision

Represent task creation as initialization of a UI-only item. The item has its own structurally distinct identity immediately. After the server creates the durable task and a refreshed snapshot contains it, the UI atomically hands selection to the normal ready-task projection and removes the initializing item.

The database model does not change. `PipelineItem.id` remains the durable task id. An initializing UI item is not a `PipelineItem` and must never be passed to task or terminal APIs.

## UI Model

Use the existing workspace/UI projection as the identity boundary and make initialization explicit with a discriminated state:

```ts
type TaskUiItem = InitializingTaskUiItem | ReadyTaskUiItem;

interface InitializingTaskUiItem {
  id: string;                 // prefixed UI-only identity (`create:<uuid>`)
  state: "initializing";
  taskId: string | null;      // populated after server acknowledgement
  repoId: string;
  prompt: string;
  displayName: string | null;
  agentType: AgentExecutionType;
}

interface ReadyTaskUiItem {
  id: string;                 // ready projection identity
  state: "ready";
  taskId: string;             // durable PipelineItem.id
  task: PipelineItem;
}
```

Introduce this `TaskUiItem` union at the main-panel boundary. Ready items wrap the existing `WorkspaceTask`/`PipelineItem` projection; initializing items are held separately from `PipelineItem[]` and carry only the display fields required by the sidebar and setup panel. Existing local ready projections conventionally use the durable task id as their row identity, but terminal consumers receive the explicit `taskId` field rather than inferring a session id from `id`. No second persisted id is added.

The important invariants are:

- While creation is pending, UI lists, row keys, and in-memory selection use the prefixed UI-only item id.
- Initializing items have no terminal route or task capabilities, including after server acknowledgement populates `taskId` but before the real snapshot arrives.
- `ReadyTaskUiItem.taskId` is populated from the ready workspace task's `localTaskId` and is the only id passed to local task and terminal APIs.
- Terminal attachment and task actions require a non-null durable task id. They never infer it from the UI item id.
- The successful handoff replaces the initializing selection and row before removing the UI-only lookup, so no frame can mount a terminal with the UI-only id and no duplicate rows remain during slow persistence.

## Creation Flow

1. Generate a UI item id and add an initializing item to UI state.
2. Select that UI item so the new task appears immediately in the sidebar and main panel.
3. Render the existing “Setting up…” state. Do not construct a fake `PipelineItem`, terminal route, or daemon session id.
4. Send the create request to the server.
5. After the server returns the durable task id, reload the task snapshot and locate its real `PipelineItem`.
6. Record the durable task id on the initializing item, then atomically hand selection to the ready projection once the persisted task data is present.
7. Attach the terminal exactly once using the durable task id.

The transition from initializing to ready must be atomic from terminal consumers' perspective: there is no state in which terminal capability is enabled while the durable task id is null.

Background creation with `selectOnCreate: false` uses the same model but does not change the current UI selection.

## Selection and Persistence

An initializing selection is local UI state and must not be persisted as though it were a task id. Before server acknowledgement it persists as `null`; after acknowledgement it projects to the returned durable task id. Once snapshot hydration succeeds, selection uses the normal ready projection and persists the real task id.

Maintain an explicit lookup for active initializing items keyed by their prefixed UI id. Selection persistence consults this lookup and never forwards the UI id. Ready entries use the existing workspace projection and expose an explicit `taskId` to terminal consumers. Restore continues to resolve the persisted durable id through the normal ready-task snapshot.

## Failure Handling

If preparation or spawning fails:

1. Keep terminal and task capabilities disabled.
2. Remove the initializing item and run the existing replacement-selection behavior when it was selected.
3. Surface the actual creation failure through the existing create-task error path.

Terminal recovery is not involved because no terminal session existed for the initializing UI item. Existing recovery output and warning toasts remain unchanged for ready tasks whose real sessions disappear.

## Alternatives Considered

### Reorder pending-state cleanup

Keeping the placeholder pending until selection moves to the real task would remove the observed race with a small patch. It would leave a fake `PipelineItem.id` in the UI model, so another consumer could make the same identity mistake later.

### Add a second persisted database id

Persisting a separate item id would make the distinction global, but UI initialization identity has no durable product meaning. It would add schema, API, migration, and synchronization work without improving task durability.

### Let the client assign the durable task id

Passing the optimistic id to the server would collapse the two identities rather than separate them. It would also move canonical task-id ownership into every client and expand the public API contract.

## Testing

Add focused tests around the UI creation lifecycle:

- an initializing item appears and is selected immediately;
- its UI id is present while its durable task id remains null;
- no terminal component or attach call is created for the initializing item;
- no task action can run without a durable task id;
- successful creation initializes the item from the real snapshot;
- the terminal attaches exactly once with the server-returned task id;
- creation failure removes the initializing item, selects the existing replacement, and does not show a session-recovery toast; and
- genuine missing-session recovery for ready tasks remains covered by the existing terminal tests.

Run the focused store/workspace/component tests first, followed by the desktop unit suite and TypeScript build checks.

## Non-goals

- Changing the SQLite schema or server task-id format.
- Changing daemon session identity.
- Suppressing legitimate terminal recovery errors.
- Refactoring unrelated task, cloud, or navigation behavior beyond what is required to enforce the item/task identity boundary.
