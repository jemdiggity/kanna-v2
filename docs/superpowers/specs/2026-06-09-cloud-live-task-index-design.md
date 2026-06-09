# Cloud Live Task Index Design

## Problem

Kanna currently treats Firestore task documents partly like task state and partly like a remote sidebar index. That ambiguity allowed closed local tasks to remain visible remotely. The concrete failure was `task-8822aa6d`: local SQLite had `stage = done` and `closed_at` set, while Firestore still had the document `5dc89496:8822aa6d` with `closedAt = null`, `stage = review`, and `status = active`.

The local app also used open-only local task lists (`listPipelineItems()`, `store.items`) to suppress stale cloud documents. Those lists intentionally exclude closed rows, so they cannot reliably prove that a matching local task has been closed.

## Principle

SQLite is the source of truth for local task lifecycle and history. Firestore is only a live metadata index for currently open local tasks. Firestore should not store task history, closed task lifecycle state, or durable tombstones.

## Cloud Data Model

The Firestore collection remains:

```text
users/{uid}/tasks/{auto_id}
```

Each document represents exactly one currently open task owned by one desktop. Firestore should generate the document id. Kanna identity lives in fields, not in the document path.

Required fields:

- `localRepoId`: local `repo.id`
- `ownerDesktopId`: current desktop identity
- `ownerLocalTaskId`: local `pipeline_item.id`
- `title`, `promptSnippet`, `displayName`
- `stage`, `activity`
- `repo`: local repo id, name, remote URL/hash, default branch
- `branch`, `baseRef`, PR fields, agent fields
- `createdAt`, `updatedAt`

Closed task fields are not part of the steady-state live index. During migration the reader may tolerate old `closedAt` fields, but the intended state is that closed tasks have no Firestore document.

## Write Contract

When a local task is created or updated while open, publish or replace its Firestore document. The publisher finds an existing document by:

- `ownerDesktopId`
- `localRepoId`
- `ownerLocalTaskId`

If one exists, update it. If none exists, create a new document with an auto-generated id. If multiple exist for the same local task identity, keep the newest valid document and delete the duplicates during reconciliation.

When a local task is closed, delete its Firestore document after the SQLite close succeeds. Close is still durable locally; cloud deletion only removes the remote metadata projection.

Remote close follows the same contract. The remote command closes the owner SQLite row, and the initiating desktop or owner-side close path deletes any Firestore documents matching the owner desktop id, local repo id, and owner local task id.

## Reconciliation

On sign-in/startup and periodic cloud sync:

1. Resolve the current `desktopId`.
2. Load local repos and open local tasks.
3. Publish current open local tasks.
4. Query Firestore documents owned by the current `desktopId`.
5. Delete any owned document whose `{localRepoId}:{ownerLocalTaskId}` is not in the open local set.
6. For duplicate owned documents with the same `{localRepoId}:{ownerLocalTaskId}`, keep the newest valid document and delete the rest.

This makes the system self-healing after crashes, offline closes, app upgrades, or older builds that failed to delete documents.

## Read Contract

The desktop sidebar reads Firestore as a remote live index. It should ignore legacy documents with `closedAt` set while migration is in progress. It should not need closed local rows to suppress owned stale cloud tasks once reconciliation deletes stale owned documents at the source.

Remote tasks should still be grouped with local repos by remote URL hash when possible. Reachability remains derived from relay/LAN presence and `ownerDesktopId`.

## Desktop Identity

The live index depends on stable desktop identity. The publisher and reader must resolve the same `desktopId` source, preferring `mobile_server_status` and falling back consistently to configured transfer identity only when the server is unavailable.

If the desktop id changes, reconciliation can only delete documents owned by the current id. A separate migration or cleanup command may be needed to remove documents from known previous desktop ids, but the steady-state contract must not rely on desktop id changes to hide stale docs.

## Tests

Required coverage:

- Unit tests for publishing open-task snapshots and deleting closed-task snapshots.
- Unit tests for reconciliation deleting owned cloud docs not present in the open local set.
- Workspace/sidebar integration coverage proving a stale owned Firestore document for a closed local task does not appear after cloud refresh.
- E2E coverage for remote close: close a cloud-visible task from a second desktop, clear any local suppression cache, refresh cloud metadata, and assert the task does not reappear.

The E2E is required because this crosses SQLite, Firestore, relay/LAN ownership, desktop id resolution, remote close, and sidebar composition.

## Migration

Existing production Firestore documents with `closedAt = null` but no matching open local task should be removed by reconciliation when their `ownerDesktopId` matches the current desktop. Legacy readers should continue filtering `closedAt != null` until old clients are no longer relevant.
