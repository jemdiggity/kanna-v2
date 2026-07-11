# Mobile Cloud Created-Task Identity Design

## Goal

Give a cloud-indexed task one stable mobile identity from a successful create or task action through live Firestore publication. Reconciliation must not interpret the desktop-local routing id and the cloud display id as different tasks, navigate away, or tear down the selected terminal or agent stream.

Normal screen behavior remains implicit: a view changes because the user navigates or the task lifecycle requires it, not because two projections of the same task use different ids.

## Root Cause

Desktop task APIs return desktop-local task ids. Firestore projects the same task with either an explicit `cloudTaskId` or the deterministic fallback `cloud:<desktop-id>:<local-repo-id>:<local-task-id>`. If a create, merge-agent, or advance-stage response reaches the controller unchanged, the controller selects the local id. A later Firestore snapshot contains the cloud id, so strict id reconciliation treats the selection as removed and closes its session.

This is a routing/display identity boundary. Mobile state needs the cloud id, while LAN and relay requests still need the owner desktop id, owner-local repo id, and desktop-local task id.

## Invariants

- Cloud-indexed creates and task actions return a canonical mobile-facing task id before Firestore publication.
- Owner desktop, owner-local repo, and desktop-local task ids remain separate route metadata and never leak back into mobile selection as the display id.
- An action that returns the source local task preserves the caller's existing cloud id. An action that returns a new local task receives a new deterministic cloud id immediately.
- The exact new-task summary is used when it can be read from the desktop that performed the action; source-task title, stage, or `agentType` is never copied as invented metadata.
- Authoritative publication replaces provisional routes by canonical id or owner/local route identity without treating the task as removed.
- Strict reconciliation still closes a task that is genuinely absent from authoritative collections.
- Signed-out/direct LAN and remote transports without a cloud task index keep desktop-local ids.

## Architecture

### Shared identity helper

`apps/mobile/src/lib/api/taskIdentity.ts` owns the deterministic fallback id builder. The Firestore task mapper, relay transport, and hybrid cloud/LAN client use the same helper. `canonicalizeTaskActionId` preserves the caller's canonical id when the response local id is unchanged and otherwise builds the new task's canonical id from the executing owner and owner-local repo.

An explicit Firestore `cloudTaskId` remains authoritative. The owner/local tuple lets later publication match that explicit id to a provisional deterministic id safely.

### Relay transport

`remoteTransport` separates display identity from request routing:

1. Resolve the owner desktop and invoke create or a task action with the desktop-local route.
2. For a cloud-indexed create, resolve the visible repo to `{ owner desktop, owner-local repo }`, send only the owner-local repo id on the desktop wire request, then build the canonical id, cache `canonical id -> { desktop, visible repo, local repo, local task }`, and return the visible repo and canonical task id.
3. For advance or merge, translate the source canonical id to the local route before invoking the desktop. Preserve the source canonical id when the response local id is unchanged. For a new response local id, build and cache a new canonical route before returning it.
4. Best-effort read `/v1/tasks/recent` from the same desktop for a newly created action task. If the exact local task is present, attach its canonicalized `TaskSummary` to `TaskActionResponse.task`; if the lookup misses, return the successful canonical action response without inventing session metadata.
5. Terminal, agent, input, close, merge, and advance operations resolve the cached route and send the desktop-local task id on the wire.

Normalization rewrites only task identity and the optional exact task summary; action control fields such as `followTask` remain unchanged.

The transport tracks cloud-read epochs. Only the latest accepted cloud task read replaces `cloudTaskRoutes`. During that replacement it removes a provisional route when the authoritative collection contains either its display id or the same owner/local route identity. A successful close also removes matching provisional routes immediately.

### Hybrid cloud/LAN client

For signed-in production composition, `appModel` always builds the cloud relay client and wraps it with `createCloudLanClient`. Trusted LAN is an optional execution and supplementation source controlled by `isLanEnabled`; it is not a separate identity model.

When LAN executes a cloud-indexed create, `cloudLanClient` validates the endpoint's desktop id, resolves the selected visible repo to that owner's local repo, rewrites only the LAN wire request, then builds the canonical id from the actual owner and returned local repo/task ids. It caches the canonical-to-LAN route and returns the visible repo and canonical task id. The same identity translation applies to LAN merge/advance responses. A new action task is pinned to the desktop that executed the action and receives its own exact summary when that desktop's recent-task list exposes it.

Before Firestore publication, LAN collection rows still contain local ids. `projectProvisionalTaskIdentities` overlays the provisional canonical id and visible repo id onto the matching owner/local LAN row. This prevents an ordinary collection refresh from replacing the selected canonical task with its raw LAN representation.

`cloudLanClient` also tracks monotonically increasing read epochs and accepts only the newest completed merged snapshot. An older deferred LAN read cannot overwrite a newer Firestore-driven refresh. The accepted merged snapshot becomes the complete task/route source used by collection reads and task-scoped operations.

### Live publication and controller state

The signed-in subscription in `appModel` captures Firestore updates, then republishes through the active composed client. In the default `forceCloud: false` composition this means an empty or partial Firestore callback is merged with trusted LAN state before it reaches the controller. The controller never reconciles directly against an incomplete raw Firestore array in that mode.

The controller optimistically inserts a successful create summary under the already-canonical response id. For a new action task it uses `TaskActionResponse.task` when exact metadata is available, refreshes task collections, and opens the canonical response id. It records a pending cloud identity only when the response carries the complete client-resolved owner/local route; raw direct-LAN and non-indexed responses remain subject to ordinary strict removal. Pending owner/local identity metadata lets it migrate to an explicit Firestore `cloudTaskId` if that authoritative id differs from the deterministic fallback, without treating the task as removed.

The session route identity is based on the underlying owner/local route. In the normal fallback-id path, publication keeps the same canonical id and leaves the selected task and active subscription stable. If Firestore supplies a different explicit `cloudTaskId`, the controller retags the selected task and active terminal/agent state when the owner/local route and session type are unchanged; buffered state and the subscription survive, and later events use the authoritative id. A route or session-type change still follows normal reconciliation and rebinds to the correct stream.

## Route Cleanup

Publication cleanup is eager at the accepted snapshot boundary, not lazy on a later task-scoped lookup:

- `remoteTransport` replaces its cloud route map and prunes matching provisional routes when the latest cloud read is accepted.
- `cloudLanClient` replaces its snapshot route map and removes a provisional LAN route when an accepted merged snapshot contains a cloud-backed task with the same owner desktop, owner-local task, and, when known, owner-local repo. A cloud publication also replaces a preserved provisional display alias when the current LAN snapshot is unavailable.
- The resulting authoritative snapshot route may still prefer LAN while that owner is reachable; removing the provisional entry does not require switching physical transport to relay.
- A successful close removes the matching provisional route immediately.

There is no TTL, timer, or client-local release hook. If no accepted authoritative publication or successful close occurs, the in-memory provisional route remains for the lifetime of that app client.

## Error Handling

Identity normalization happens only after a successful desktop response. Create, action, and session failures retain their existing error paths. The exact new-action summary lookup is best effort and cannot turn an already successful action into a failure. A lookup miss supplies no fabricated `agentType`; the controller clears the source task's now-stale session while retaining canonical selection, then later accepted collection metadata determines which result stream to open.

An unavailable owner route reports the existing routing error. Non-cloud-indexed transports keep raw local identity semantics.

## Testing

- Remote transport tests prove cloud-indexed create and new action responses are canonical immediately, route terminal/agent operations to local ids, preserve an existing canonical id for same-task advance, and clean provisional routes on accepted publication or successful close.
- Hybrid source tests prove canonical LAN create/action responses, raw LAN-row projection, exact action metadata, owner pinning, accepted-snapshot cleanup, and stale-read rejection.
- Controller tests prove an exact action result can open its own terminal or agent stream before publication and that genuine removal still closes the selected session.
- `createAppModel` integration tests cover both relay-only and the default signed-in `forceCloud: false` composition with a trusted Bonjour/LAN peer and an initially empty Firestore stream. They drive create/action, publish canonical snapshots, and assert canonical selection, `activeView: "tasks"`, stable subscriptions, and desktop-local LAN/relay calls.
- Verification includes focused mobile tests, mobile typecheck, the full mobile suite, repository tests, and the daemon suite.
