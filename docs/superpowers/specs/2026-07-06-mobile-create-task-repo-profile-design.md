# Mobile Create Task Repo Profile Design

## Goal

Make mobile task creation choose the right machine and agent with minimal repeated input. The choice is local to the phone and scoped per repo.

## User Experience

The new task drawer opens for the currently selected repo. By default it shows:

- `New task in <repo name>`
- Prompt input
- `Create` button
- Collapsed `Options` row summarizing the target, such as `Studio Mac - Claude`

If the selected repo has no local creation profile, the drawer expands options automatically. Options include a machine picker and an agent picker. Once the user chooses a machine or agent for that repo, the choice becomes the repo's local default for future task creation.

## Creation Profile

Mobile stores a local profile keyed by repo id:

- `repoId`
- `desktopId`
- `agentProvider`
- `updatedAt`

Profiles are persisted with the existing mobile session persistence. They do not sync through cloud.

## Target Selection Rules

When opening the create drawer:

1. If a local profile exists for the repo, use its machine and agent.
2. Otherwise, if cloud task snapshots show exactly one owner desktop for the repo, preselect that desktop.
3. Otherwise, if LAN/trusted desktop data identifies one desktop that can create for the selected repo, preselect it.
4. Otherwise, leave machine unselected, expand options, and disable Create until a machine is chosen.

Agent defaults to the repo profile when present. If absent, it defaults to Claude.

## Data Flow

The mobile state owns the current composer state:

- selected repo comes from the task screen
- selected machine comes from the repo creation profile or inference
- selected agent comes from the repo creation profile or default
- submitting and error state remain visible inside the drawer

On successful create, mobile stores the selected machine and agent into the local repo profile. Explicit machine or agent changes also update the in-memory composer state immediately and are persisted for the repo.

The create request routes through the selected desktop. Cloud-indexed repo tasks can still infer an owner desktop, but explicit repo profile selection takes precedence.

## UI Details

The drawer remains compact for repeat use. The machine and agent controls live under a collapsible options section:

- collapsed when the repo already has a profile
- expanded when the repo has no profile, the previous machine is unavailable, or create cannot proceed

The agent picker should be more compact than the current full list. Use concise labels and a clear selected state. Machine picker should show desktop name and availability.

## Error Handling

Create is disabled when no repo, no prompt, no machine, or submission is in progress.

Errors are shown in the drawer, not only in a global banner. If the saved machine is unavailable, the drawer expands options and asks the user to choose another machine.

## Testing

Add focused tests for:

- local repo profile persistence
- opening composer uses saved repo machine and agent
- no-profile composer expands options
- create request targets the selected machine
- successful create persists the repo profile
- disabled create when machine is missing
- remote create no longer depends on a global selected desktop when a repo profile supplies the desktop
