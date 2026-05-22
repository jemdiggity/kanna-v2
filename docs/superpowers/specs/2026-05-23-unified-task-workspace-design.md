# Unified Task Workspace Design

Date: 2026-05-23
Status: Proposed
Scope: Desktop task model unification for local, cloud, and LAN tasks

## Summary

Kanna should present one coherent task workspace across local tasks, signed-in cloud tasks, and trusted LAN tasks.
The user should interact with tasks first, not machines first.
Machine identity matters for ownership, reachability, diagnostics, and explicit transfer targets, but it should not drive ordinary browsing or task selection.

The current implementation stitches local, cloud, and LAN task lists together in `App.vue`.
That has produced duplicate sidebar tasks, special-case keyboard navigation, and fragile terminal routing.
The longer-term goal is to introduce a workspace task model below the UI that normalizes all task sources into one list of task view models with explicit ownership, reachability, capabilities, and terminal routing metadata.

## Goals

- Show each logical task once in the sidebar, even if it exists in both local DB state and a cloud or LAN snapshot.
- Group tasks from the same repository together, regardless of whether the task is local, cloud-backed, or LAN-backed.
- Make local tasks and remote tasks share the same selection, navigation, and task detail model.
- Keep desktop task execution locally authoritative.
- Keep explicit machine selection for Push to Machine and Pull from Machine.
- Support signed-in cloud task visibility and trusted LAN task visibility without making either transport the UI source of truth.
- Provide a clear foundation for mobile parity and cloud transfer work after desktop semantics are stable.

## Non-Goals

- Cloud-hosted agent execution.
- Making Firestore the authoritative task database for local desktop execution.
- Automatic selection of task transfer destinations.
- Teams, orgs, sharing, billing, or entitlement logic.
- Replacing the existing SQLite schema in this phase.
- Solving all task transfer artifact movement in this design.

## Product Model

The workspace is task-first.

Each task in the UI has:

- a stable workspace task id,
- a repository identity,
- an owner identity,
- a source set describing where Kanna learned about it,
- reachability state,
- capability flags,
- transport references for terminal and actions.

Local tasks are tasks whose owner is the current desktop.
Cloud tasks are tasks published by a signed-in desktop and discovered through the cloud index.
LAN tasks are tasks published by a trusted peer on the local network.

The user should usually see only the task title, repo grouping, stage, activity, and any owner/reachability hint needed to explain limitations.
The owner machine should not be primary UI chrome unless the task is offline, transferring, or the user is choosing a transfer target.

## Workspace Task Model

Introduce a normalized workspace layer, likely under `apps/desktop/src/workspace/`.

### `WorkspaceTask`

Fields:

- `id`: stable UI id for selection and navigation.
- `logicalTaskKey`: source-independent key used for dedupe.
- `localTaskId`: local `pipeline_item.id` when present.
- `remoteTaskIds`: cloud or LAN ids associated with the same logical task.
- `repoKey`: stable repository grouping key.
- `repo`: normalized repo view data.
- `title`, `prompt`, `displayName`, `branch`, `baseRef`.
- `stage`, `activity`, `closedAt`, `createdAt`, `updatedAt`.
- `owner`: current owner desktop or peer.
- `sources`: local, cloud, LAN, with raw ids and timestamps.
- `reachability`: local, reachable, offline, unknown, stale.
- `capabilities`: action flags.
- `terminal`: local daemon ref, cloud relay ref, or LAN terminal ref.

### `WorkspaceRepo`

Fields:

- `key`: stable repo grouping key.
- `localRepoId`: local DB repo id when present.
- `remoteRepoIds`: cloud or LAN repo ids.
- `name`, `path`, `remoteUrl`, `remoteUrlHash`, `defaultBranch`.
- `source`: local-only, remote-only, or mixed.

### Dedupe Rules

The workspace layer should collapse task records into one `WorkspaceTask` when they refer to the same logical task.

Primary matches:

- local repo remote hash equals snapshot repo remote hash, and local task id equals snapshot owner local task id;
- local repo remote hash equals snapshot repo remote hash, and branch names match exactly;
- cloud and LAN snapshots share the same owner and owner-local task id.

When a local task and remote snapshot match, the local task wins for UI identity and action routing.
The remote snapshot remains attached as a source for diagnostics and sync state but is not shown as a separate task.

When a task has only remote sources, the remote task is shown once under the best matching repo group.
If no local repo matches, the workspace creates a remote-only repo group.

Closed local tasks suppress matching stale open remote snapshots.
Closed remote snapshots are not shown in active task lists.

## Capabilities

Task actions should be gated by capability flags instead of ad hoc `local` versus `remote` checks in components.

Examples:

- `canOpenTerminal`: task has a reachable local, cloud, or LAN terminal route.
- `canSendInput`: task has an interactive terminal route.
- `canClose`: owner is local, or a reachable remote action route supports close.
- `canCreateSiblingTask`: repo can be resolved locally or cloned from a remote URL.
- `canPushToMachine`: task is locally owned and transferable.
- `canPullFromMachine`: task is remotely owned and the current desktop can import it.
- `canOpenDiff`: local worktree exists.
- `canOpenInIde`: local worktree exists.

Components should render disabled states or alternate flows from these flags.
They should not need to know whether a task came from SQLite, Firestore, or LAN discovery.

## Data Flow

Inputs:

- Local SQLite repos and tasks from the Pinia store.
- Cloud task snapshots from Firestore.
- LAN task snapshots from the transfer sidecar.
- Relay and LAN presence/reachability.
- Local repo remote URL hashes.

Workspace build flow:

1. Collect local repos/tasks.
2. Collect cloud and LAN snapshots.
3. Normalize repo identities.
4. Normalize task candidates.
5. Dedupe candidates into workspace tasks.
6. Compute owner, reachability, terminal route, and capabilities.
7. Emit sorted repos and tasks for UI consumption.

Outputs:

- `workspaceRepos`
- `workspaceTasks`
- `selectedWorkspaceTask`
- `selectedWorkspaceRepo`
- action helpers that resolve a workspace task to local or remote execution.

## UI Integration

The following UI surfaces should consume the workspace layer:

- `Sidebar`
- `MainPanel`
- terminal selection and attach
- keyboard task and repo navigation
- activity shortcuts
- New Task modal
- Push/Pull task flows
- close/advance task actions

`App.vue` should stop owning merge and dedupe rules.
It should wire state, call workspace actions, and pass normalized view models to components.

Remote task support should not require every component to understand cloud and LAN separately.
The terminal view may still branch internally on terminal route type, but it should receive a normalized route object.

## Error Handling

The workspace layer should classify remote task problems explicitly:

- owner offline,
- relay unreachable,
- LAN peer unavailable,
- terminal session missing,
- stale snapshot,
- repo unavailable,
- action unsupported by route.

The sidebar should hide stale duplicates, but the task detail can show actionable errors for a selected remote-only task.
Stale snapshots that match locally closed tasks should be suppressed from active lists.
Remote-only tasks whose owner is offline may remain visible with mutating actions disabled.

## Testing Strategy

Add focused unit tests for the workspace builder:

- local-only task appears once;
- cloud-only task appears once;
- LAN-only task appears once;
- local plus cloud copy dedupes to one local-owned task;
- local plus LAN copy dedupes to one local-owned task;
- cloud plus LAN copy dedupes by owner and owner-local task id;
- stale open remote snapshot matching a locally closed task is hidden;
- remote tasks group under matching local repos by remote URL hash;
- remote-only repos are created when no local repo matches;
- capabilities differ correctly for local, reachable remote, offline remote, and repo-unavailable tasks.

Add E2E sanity suites for real wiring:

- two signed-in desktop apps: create task on one desktop, it appears once locally and once remotely;
- remote desktop does not create local DB rows just by viewing cloud tasks;
- closing local task removes or hides it remotely;
- stale offline cloud snapshot does not appear;
- two trusted LAN desktops: create task on one desktop, it appears once locally and once remotely;
- LAN remote terminal can stream;
- keyboard navigation reaches remote tasks exactly once;
- New Task modal works from a remote-only repo by listing base branches and cloning/importing before creation.

## Migration Plan

### Phase 1: Extract Workspace Builder

Create pure workspace builder functions and tests.
Keep existing UI behavior but replace ad hoc sidebar item construction with builder output.

### Phase 2: Selection And Navigation

Move task and repo selection to workspace ids.
Ensure back/forward history, keyboard navigation, and activity shortcuts operate on workspace tasks.

### Phase 3: Capability-Driven Actions

Route close, terminal, New Task, push, pull, diff, shell, and IDE actions through capability checks.
Keep local implementations behind action adapters.

### Phase 4: Remote Terminal And Action Stability

Normalize terminal route handling for local daemon, cloud relay, and LAN transport.
Make missing sessions and offline owners produce structured workspace errors.

### Phase 5: Cloud/LAN Transfer Expansion

After workspace semantics are stable, build richer cloud transfer and mobile parity on top of the same task model.

## Success Criteria

- A task created locally while signed in appears once in the owner desktop sidebar.
- The same task appears once in another signed-in desktop sidebar.
- A task discovered by trusted LAN appears once in the peer sidebar.
- Local and remote tasks from the same repo group together.
- Keyboard navigation, task selection, and terminal opening work across local and remote tasks.
- Task actions are enabled or disabled from capabilities, not transport-specific component checks.
- E2E tests cover cloud and LAN sanity paths and prevent duplicate sidebar regressions.
- `App.vue` no longer owns task-source merge and dedupe policy.

