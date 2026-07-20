# Desktop Interaction Latency Design

## Context

The v0.0.69 staging line moved repository pipeline and agent definitions to the repository's remote default branch. The New Task flow still waits for all option discovery before mounting the modal, and the new definitions request now runs `git fetch origin`. A pre-existing sequencing problem therefore became a multi-second UI delay.

Task close has the same interaction flaw: the frontend waits for the close endpoint to kill sessions, start teardown or worktree cleanup, notify dependents, and return before it changes the visible task selection. Backend cleanup is allowed to take time, but it must not delay local presentation state.

Definition consumers also do not currently avoid repeated remote work. The frontend revision caches compare values only after requesting them, while each server-side `RepoDefinitions::resolve()` performs another `git fetch origin`.

## Goals

- Mount and focus New Task without awaiting a backend or native command.
- Populate repository-specific task options asynchronously without allowing stale requests to overwrite a newer modal invocation.
- Cache resolved remote definitions in the local server so repeated manifest, pipeline, and agent reads avoid repeated fetches.
- Remove a closing task from the visible UI and select its replacement immediately.
- Restore optimistic close state when the server rejects the close, without overwriting newer user navigation.

## Non-goals

- Do not add a separate frontend definitions cache.
- Do not change the remote default branch as the authoritative definitions source.
- Do not weaken task creation's authoritative pipeline pinning.
- Do not change daemon teardown, worktree cleanup, dependent notification, or close endpoint semantics.

## Design

### Render-first New Task

`openNewTaskModal` will synchronously determine the target repository, reset task-option state, mark options as loading, and set `showNewTaskModal` before its first asynchronous boundary. The mounted modal remains immediately editable and focused. Controls that require discovered options remain disabled or show a loading label until their data is available.

Option discovery will then run asynchronously. Local branch discovery, server definition loading, and provider discovery can remain parallel because none gates modal visibility. Each invocation receives a monotonically increasing generation. Results are applied only if their generation is still current and the modal is still open, preventing a slow response for one repository from overwriting a newer invocation.

The existing post-submit handoff remains a special case: reopening waits for the active submission to finish recording its chosen agent so a second modal cannot race task initialization.

### Server definitions cache

The local server will own the only definitions cache. It will cache the resolved remote definition snapshot used by the manifest, pipeline, and agent definition routes. The cache key includes repository identity, path, and default branch so repository configuration changes cannot reuse an incompatible entry.

Entries have a short bounded freshness interval of 30 seconds. A fresh entry returns without running Git. The first lookup and the first lookup after expiry refresh from `origin`, then replace the cached value. This bounds how long UI metadata can lag a remote definition update while eliminating repeated fetches caused by modal opens, snapshot refreshes, and adjacent definition requests.

Task creation and lifecycle operations that resolve and pin authoritative definitions remain independent of this presentation/API cache. They continue to resolve the current remote definition when correctness requires it. The modal never waits for that authoritative task-creation resolution.

The cache stores successful resolved values only. Resolution errors are returned normally and are not cached. Cache access is synchronized, but Git work is performed outside the shared map lock so one slow repository does not block cached reads for another repository.

### Optimistic task close

The close action will use the store's existing optimistic snapshot-overlay mechanism to project the target task as closed before awaiting the server. If the selected task is closing, replacement selection begins immediately from the pre-close ordering, making the sidebar and main panel react in the same turn.

The close request then continues in the background from the UI's perspective. On success, the authoritative snapshot replaces the overlay and shared-window state is invalidated as today. If the response fails, the frontend checks whether the server committed the close, preserving the existing lost-response protection.

If the task remains open, removing the overlay makes it visible again. The original selection is restored only when no newer selection intent occurred while close was pending. This prevents rollback from stealing focus after the user creates or selects another task.

## Error handling

- New Task option failures leave the modal open and usable where possible, preserve existing toasts/logging, and clear the loading state for the current generation.
- A canceled or superseded modal load may complete, but its result is discarded.
- Definition-cache refresh failures do not poison the cache with an error value.
- A rejected close restores optimistic state and reports the existing close failure toast.
- A lost close response followed by an authoritative closed snapshot is treated as success.

## Testing

- A composable test will hold all New Task option promises unresolved and assert the modal becomes visible immediately.
- A composable test will resolve two modal loads out of order and assert only the newest repository's options are applied.
- Modal tests will cover the loading presentation and disabled option-dependent submission.
- Server cache tests will prove repeated fresh reads perform one remote resolution, expiry causes refresh, and different repository keys do not collide.
- Close-action tests will hold the close request unresolved and assert replacement selection and optimistic task hiding occur first.
- Close-action tests will cover rollback, lost-response success, and preservation of newer selection intent.
- Focused frontend and Rust tests will run before the repository-wide verification commands.

## Alternatives considered

### Frontend cache plus server cache

This could eliminate a loading-state flash on repeated opens, but duplicates authoritative metadata and invalidation logic across processes. The local server cache makes repeated requests cheap, so the extra state is unnecessary.

### Prefetch without changing modal sequencing

Prefetching would improve common cases but would still allow a cold cache or failed refresh to delay modal visibility. Interactive presentation must not depend on prefetch success.

### Optimize or remove `git fetch origin`

This would reduce the symptom but would either retain a blocking interaction or weaken the remote source-of-truth contract. Caching and render-first hydration preserve both responsiveness and correctness.
