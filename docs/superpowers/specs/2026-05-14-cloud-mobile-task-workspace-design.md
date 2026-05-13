# Cloud Mobile Task Workspace Design

Date: 2026-05-14
Status: Proposed
Scope: Signed-in mobile cloud access to a user-level task workspace across desktop-owned Kanna apps

## Summary

Kanna should expose a user-level cloud task workspace.
After sign-in, mobile shows the user's Kanna tasks across all signed-in desktop apps.
The user should not need to choose a machine for ordinary task browsing or task actions.

Execution remains desktop-owned.
A task has exactly one current owner desktop at a time.
That desktop owns the local database row, git worktree, agent process, daemon session, terminal state, and task transfer lifecycle.
Cloud is a task index, identity layer, routing layer, and transfer coordinator.
It does not run agents and does not store local working directories.

Desktop-to-desktop movement should preserve the semantics of the existing Push to Machine flow:
the source prepares a transfer payload, the destination imports the task into a local worktree, the destination acknowledges import, and the source finalizes and closes the original task.
Cloud brokers the flow and records task ownership after the handoff succeeds.

## Goals

- Let users sign in on mobile and see tasks from Kanna desktop apps signed in on other machines.
- Make mobile work through cloud by default after sign-in, not only through LAN.
- Keep desktop task execution and local state authoritative.
- Let mobile route task actions to the task's current owner desktop without requiring a machine-first UI.
- Preserve explicit machine selection for desktop task transfer.
- Support both Push to Machine and Pull from Machine over the cloud path.
- Keep LAN access as a local development/direct-access path, not the main signed-in mobile product path.

## Non-Goals

- Cloud-hosted agent execution.
- Cloud storage of full worktrees, terminal scrollback, local filesystem paths, secrets, or environment values.
- Automatic selection of transfer target machines.
- Offline mutation queuing in the first version.
- Full task conflict resolution between multiple active owners.
- Teams, orgs, sharing, billing, or entitlement logic.

## Product Boundary

Kanna Cloud gives users one task workspace across signed-in Kanna desktops.
Machine identity is metadata, not the primary navigation model.
Mobile lists tasks and opens task detail by task, while routing requests to the current owner desktop internally.

Machine choice appears only when it matters:

- transfer between desktops
- owner desktop offline state
- troubleshooting or diagnostics

Task transfer target choice remains explicit:

- **Push to Machine:** the current desktop is the source, and the user chooses the destination machine.
- **Pull from Machine:** the current desktop is the destination, and the user chooses the source machine and task.

Cloud may list eligible signed-in desktops and broker transfer messages, but it must not silently choose where a task moves.

## Architecture

Recommended architecture:

`mobile -> Firebase task index / relay -> owner desktop kanna-server -> local DB / daemon`

`desktop source -> cloud transfer coordinator / relay -> desktop destination`

Firebase provides identity, durable desktop registry state, task index state, and transfer coordination records.
The relay provides request/response routing to online desktops.
The desktop-side `kanna-server` remains the API boundary for task actions.

The cloud task index is read-through:

- Desktop local DB is authoritative for owned tasks.
- Desktops publish snapshots for tasks they own.
- Mobile reads snapshots from cloud.
- Mobile mutations route to the owner desktop.
- The owner desktop updates local state first, then publishes a refreshed snapshot.

## Data Model

### `users/{uid}/desktops/{desktopId}`

Purpose: signed-in desktop registry.

Fields:

- `desktopId`
- `displayName`
- `platform`
- `appVersion`
- `protocolVersion`
- `registeredAt`
- `lastSeenAt`
- `lastHeartbeatAt`
- `presence.online`
- `presence.reachableViaRelay`
- `presence.lastRelaySeenAt`
- `revokedAt`

### `users/{uid}/tasks/{cloudTaskId}`

Purpose: lightweight cloud-readable task snapshot.

The snapshot should contain enough data for mobile lists, task detail, routing, and transfer decisions.
It should not include terminal scrollback, full prompts by default, local filesystem paths, environment values, daemon/session internals, secrets, or raw DB rows.

Fields:

- `cloudTaskId`
- `ownerDesktopId`
- `ownerLocalTaskId`
- `title`
- `promptSnippet`
- `displayName`
- `stage`
- `activity` with values `idle`, `working`, `unread`
- `status` with values such as `active`, `blocked`, `pr`, `merge`, `done`, `transferring`
- `repo.cloudRepoId`
- `repo.name`
- `repo.remoteUrlHash`
- `repo.defaultBranch`
- `branch`
- `baseRef`
- `prNumber`
- `prUrl`
- `agent.provider`
- `agent.type`
- `transfer.state`
- `transfer.transferId`
- `transfer.sourceDesktopId`
- `transfer.destinationDesktopId`
- `blockedByTaskIds`
- `createdAt`
- `updatedAt`
- `closedAt`

`cloudTaskId` is the stable user-facing cloud identity.
It survives transfer even though the local task id changes on the destination desktop.
`ownerDesktopId` and `ownerLocalTaskId` are the routing keys for mobile actions.

`promptSnippet` should be short in the first version, for example the first 200-500 characters.
Syncing full prompts should wait for a deliberate privacy decision.

### `users/{uid}/transfers/{transferId}`

Purpose: cloud-brokered task transfer coordination.

Fields:

- `transferId`
- `cloudTaskId`
- `sourceDesktopId`
- `destinationDesktopId`
- `sourceLocalTaskId`
- `destinationLocalTaskId`
- `status` with values `pending`, `preflighted`, `importing`, `imported`, `finalization_pending`, `completed`, `failed`, `cancelled`
- `error`
- `createdAt`
- `updatedAt`
- `completedAt`

The transfer payload itself can continue to use the existing Kanna transfer payload shape.
Large artifacts, such as repo bundles or session archives, should remain outside Firestore documents and be transferred through the existing transfer artifact mechanism or a bounded cloud artifact path designed for this purpose.

### `users/{uid}/taskEvents/{eventId}`

Purpose: optional append-only audit/debug stream.

This can record notable cloud sync and transfer events without making the event log the source of truth.
It is useful for diagnosing stale snapshots, relay failures, and transfer finalization failures.

## Sync Rules

- A desktop may publish snapshots only for tasks it currently owns.
- Cloud accepts owner changes only through an explicit transfer handoff.
- A task has one current `ownerDesktopId`.
- Desktop snapshots update cloud when tasks are created, updated, closed, transferred in, or transferred out.
- Mobile lists tasks from cloud and routes actions to `ownerDesktopId`.
- If the owner desktop is offline, mobile may show the last snapshot but must disable mutating actions in the first version.
- Task transfer ownership changes only after destination import succeeds and source finalization acknowledges.

## Core Flows

### Sign-In And Desktop Registration

Desktop and mobile sign in with the same user account.
Each desktop registers a durable `desktopId` under the user and keeps a local desktop credential for relay authentication.
The desktop publishes relay presence and refreshes cloud task snapshots from its local DB.

### Mobile Task List

Mobile defaults to cloud mode after sign-in.
It reads `users/{uid}/tasks` and shows tasks across all signed-in desktops in one list.
The owner desktop can appear as secondary metadata when useful, but it is not the primary grouping.

### Mobile Task Actions

When mobile opens or acts on a task, it uses `ownerDesktopId` and routes the request through the relay to that desktop's `kanna-server`.
The owner desktop updates its local DB and then publishes a refreshed task snapshot.
Mobile can refresh the cloud list after the action returns, but cloud is not the mutating authority for task execution state.

### Push To Machine

The current desktop is the source.
The user chooses the destination desktop explicitly.

Flow:

1. Source prepares transfer preflight and payload.
2. Destination imports the task, repo/worktree, recovery state, and artifacts.
3. Destination acknowledges import.
4. Source finalizes and closes the original task.
5. Cloud marks the transfer completed and updates the task's `ownerDesktopId` and `ownerLocalTaskId`.

### Pull From Machine

The current desktop is the destination.
The user chooses the source desktop and source task explicitly.

The same transfer phases apply.
Only the UI framing changes: the destination initiates a request for the source to prepare and send the selected task.

## Offline And Failure Behavior

- Mobile can read stale cloud-indexed tasks when an owner desktop is offline.
- Mobile mutating actions are unavailable when the owner desktop is offline.
- Cloud-backed Push/Pull requires both source and destination desktops online in the first version.
- If destination import succeeds but source finalization fails, the transfer remains in `finalization_pending`.
- A `finalization_pending` transfer should be recoverable without duplicating ownership silently.
- If cloud or relay is unavailable, desktop local task execution continues unaffected.
- Cloud sync, mobile cloud access, and cross-machine transfer may degrade while cloud services are unavailable.

## Components

### Firebase Functions

- Register desktops for authenticated users.
- Accept desktop task snapshot writes with authorization checks.
- Coordinate transfer records and state transitions.
- Validate that owner changes happen only through explicit transfer completion.

### Firestore Rules

- Users can read their own desktops, tasks, and transfers.
- Mobile clients cannot spoof task ownership.
- Desktop writes require a desktop credential or function-mediated privileged path.
- Transfer state changes must be constrained to valid actors and valid transitions.

### Relay

- Route mobile task actions to the `ownerDesktopId`.
- Route desktop-to-desktop transfer messages by user and desktop id.
- Preserve isolation across users and across desktops under the same user.
- Report relay presence into desktop registry state.

### Desktop

- Add signed-in cloud registration and credential storage.
- Publish task snapshots for owned local tasks.
- Consume cloud/relay transfer requests.
- Reuse existing transfer import/finalize behavior for cloud-brokered Push/Pull.
- Keep local DB and daemon behavior unchanged for task execution.

### Mobile

- Use cloud transport as the signed-in default.
- List cloud-indexed tasks across desktops.
- Route task actions to the owner desktop through relay.
- Show offline owner state and disable unavailable actions.
- Avoid machine-first navigation for ordinary task browsing.

## Testing

- Firebase emulator tests for task snapshot authorization, desktop registry access, and transfer state transitions.
- Firestore rules tests ensuring users cannot read another user's tasks or spoof owner changes.
- Relay integration tests for mobile action routing and desktop-to-desktop transfer message isolation by user and desktop.
- Desktop unit/store tests for snapshot publishing and transfer ownership updates.
- Mobile tests for cloud-mode task listing, offline owner disabled actions, and task-first navigation.
- An end-to-end or integration path for cloud-backed Push/Pull once emulator plus relay startup is wired into `kd dev up --emulators`.

## Open Implementation Notes

- The first implementation should avoid queueing offline mutations.
- Full prompt sync should remain out of scope unless a privacy setting is added.
- Cloud artifact storage for repo bundles or session archives should be designed separately if existing transfer artifact transport is not sufficient over the cloud path.
- The first cloud task list can be eventually consistent; the desktop remains the source of truth for precise live state.
