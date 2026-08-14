# Transfer Phase 1 Local Import Design

## Goal

Complete the next real transfer milestone after pending incoming requests: a destination instance can approve an incoming transfer on the same machine, reconstruct a new local task/worktree/session from the transferred metadata, and record provenance locally. This phase intentionally stops short of source-side ownership handoff, Bonjour discovery, pairing, encryption, or cross-machine repo acquisition.

## Remaining Feature Roadmap

The unfinished feature naturally decomposes into three phases:

1. **Phase 1: Local accept/import**
   - Destination persists the full incoming payload.
   - User can approve or reject the request.
   - Approval reconstructs a new local task/worktree/session on the destination.
   - Provenance and transfer status update locally.
2. **Phase 2: Ownership handoff**
   - After destination import succeeds, the source marks the original task transferred/closed.
   - Both sides finalize transfer state and provenance.
3. **Phase 3: Real LAN transfer**
   - Bonjour discovery, pairing/trust, encrypted transport, remote clone/bundle fallback, and provider-aware resume semantics.

This design covers phase 1 and leaves phases 2 and 3 as explicit follow-on work.

## Current Constraints

The current branch already proves:

- source -> destination peer listing,
- real preflight and commit sidecar RPCs,
- destination-side pending transfer persistence,
- live incoming transfer modal rendering,
- two visible app instances on one machine.

The current branch does **not** retain enough data to import after approval:

- the sidecar event only emits `transfer_id`, `source_peer_id`, `source_task_id`, and `source_name`,
- the destination DB stores only a pending `task_transfer` row,
- the incoming modal has no transfer identity or approve/reject behavior beyond dismissing itself.

## Approaches Considered

### 1. Frontend-only import

Expand the incoming event to carry the full payload, persist it in the desktop DB, and let the store orchestrate approval/import with existing task bootstrap helpers.

Pros:
- reuses the mature `createItem`/worktree/session setup path,
- keeps this slice small and testable,
- avoids duplicating task-creation behavior in Rust.

Cons:
- import logic remains split between desktop store and Tauri.

### 2. Hybrid boundary

The sidecar/Tauri layer owns incoming payload retention and approval state, but the desktop store still performs destination repo/task/worktree reconstruction.

Pros:
- cleaner transport boundary than frontend-only,
- still reuses store bootstrap logic.

Cons:
- requires extra Rust commands and duplicated state transitions.

### 3. Backend-centric import

Tauri owns the entire import flow and returns only a new local task id to the frontend.

Pros:
- strongest long-term boundary.

Cons:
- too large for this phase because current task creation/bootstrap logic lives in the store.

## Recommendation

Use **approach 1** for phase 1.

Transport still remains owned by the sidecar because the source/destination exchange ends at the incoming event. After that point the destination is performing local reconstruction work, and the desktop store already owns task bootstrap, repo reuse, worktree creation, and session spawn. Persisting the full incoming payload in the local DB gives the destination a stable approval boundary without adding speculative Rust orchestration that would likely be rewritten during phase 3.

## Phase 1 Architecture

### Incoming payload retention

The destination must retain the full incoming payload needed to reconstruct the task after approval. The simplest stable boundary is:

- sidecar commit receives the full payload,
- sidecar event includes that full payload,
- desktop store persists it into the existing `task_transfer` record.

This phase adds `payload_json` to `task_transfer`. The DB row remains the source of truth for pending incoming transfers.

### Approve/reject model

Approval and rejection are local state transitions in this phase.

- **Approve**: parse the stored payload, ensure the destination repo exists locally, create a new local task/worktree/session, insert provenance, and update the transfer row to point at the new local task.
- **Reject**: mark the transfer rejected locally and dismiss the modal.

No source-side acknowledgment or source task closure happens in phase 1.

### Repo handling

Phase 1 remains same-machine only, so it can rely on a local repo path hint in the transferred payload.

The outgoing payload must therefore grow to include:

- repo path,
- repo display name,
- repo default branch,
- remote URL when available.

Destination repo resolution order:

1. Reuse an already-imported repo record by path.
2. Import the repo by the provided local path if that path exists locally.
3. Fail the approval if no usable local repo path exists.

Remote clone and repo bundle fallback remain phase 3 work.

### Destination task reconstruction

Destination reconstruction should reuse the existing store bootstrap path rather than inventing a second creation workflow.

The imported task becomes a fresh local task with:

- a new `pipeline_item.id`,
- a new branch name (`task-{newId}`),
- a new worktree path,
- the source task prompt/stage/workflow/display name/provider,
- the source branch used as the worktree start point,
- a new local PTY or SDK session created through the normal bootstrap path.

This phase does **not** attempt provider session resume. It creates a new local task/session from the imported metadata.

### Provenance and transfer status

On successful import:

- `task_transfer.local_task_id` points at the new local task,
- `task_transfer.status` becomes `completed`,
- `task_transfer.completed_at` is set,
- `task_transfer_provenance` stores the source peer id, source task id, and source branch label.

On rejection:

- `task_transfer.status` becomes `rejected`,
- `task_transfer.completed_at` is set.

## UI Behavior

The incoming modal needs to know which transfer is active, not just the source name.

App state should therefore track:

- current incoming transfer id,
- current incoming source label.

Approve/reject buttons invoke store actions using that transfer id. Modal dismissal by Escape or outside-click should behave like rejection in this phase.

## Testing

### Unit tests

Add focused coverage for:

- parsing incoming payloads that include the full transfer payload,
- storing pending incoming transfer payload JSON,
- approving an incoming transfer into a new local task and provenance row,
- rejecting an incoming transfer,
- same-machine repo reuse/import fallback by local path.

### E2E

Add a real two-instance acceptance/import test that:

1. creates a task on the primary,
2. pushes it to the secondary,
3. verifies pending incoming state on the secondary,
4. approves the transfer on the secondary,
5. verifies a new local task appears on the secondary,
6. verifies the transfer row now points at the imported task and provenance exists.

## Out Of Scope

Phase 1 explicitly does not include:

- source task closure,
- source-side final status transitions,
- cancel/rollback acknowledgments to the source,
- Bonjour discovery,
- peer trust or pairing,
- encrypted transport,
- repo clone/bundle fallback,
- provider session resume.
