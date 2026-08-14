# Mobile Repo Command Palette Design

## Goal

Replace the mobile More tab's mixed workspace/task maintenance commands with a selected-repository command palette. The palette exposes repository-level Kanna automations and factory commands, while task actions, task creation, and machine management remain on their dedicated mobile surfaces.

## Command Ownership

Mobile commands are assigned by the object they require:

| Scope | Commands | Mobile surface |
| --- | --- | --- |
| Task | Rename, Advance Stage, Request Changes, Close, Block/Edit Blockers, Push to Machine | The task view's `+` menu |
| Repository | Merge Master, Ship, repo-defined custom tasks, Create Agent, Create Workflow, Set Up Repository, Create Config, New Custom Task | More tab |
| Machine | Pairing, connection, and machine management | Machines UI |
| Task creation | New Task | Existing global `+` button |

The More tab must not contain duplicate task creation, manual refresh, desktop switching, pairing, task-scoped actions, or app-update diagnostics.

## Coordination With Other Work

This change does not implement the task `+` action menu. Kanna task `019f6d5bc1950000000202d0a5c4be3f` owns that behavior and keeps task commands within the task view.

This change also does not implement machine discovery or management. The separate Machines work owns pairing, connectivity, and machine selection.

## Architecture

The desktop-owning `kanna-server` is authoritative for repository commands because it can resolve the selected repository, read its Kanna definitions, apply built-in defaults, and launch tasks. Mobile renders a server-provided catalog and never duplicates factory prompts or custom-task configuration.

Add a repo-scoped command contract:

- `GET /v1/repos/{repoId}/commands` returns the commands available for that repository.
- `POST /v1/repos/{repoId}/commands/{commandId}/run` executes one command and returns the created or reused task ID.

The catalog and each entry contain:

```ts
interface RepoCommandCatalog {
  repoId: string;
  revision: string;
  commands: RepoCommand[];
}

interface RepoCommand {
  id: string;
  label: string;
  description: string;
  group: "automation" | "configure";
}

interface RunRepoCommandRequest {
  catalogRevision: string;
}

interface RunRepoCommandResponse {
  taskId: string;
  reused: boolean;
}
```

Command identifiers are stable within a repository catalog. Factory commands use fixed identifiers. Custom tasks use a collision-safe identifier derived from their definition path rather than their display name.

The command runner owns all launch details:

- Factory commands use the same prompts and agent definitions as desktop.
- Repo-defined custom tasks preserve their prompt, referenced agent, provider/model overrides, permission mode, tools, execution mode, stage, and setup configuration.
- Singleton automations such as Merge Master return the existing singleton task when one is already active; otherwise the server creates it.
- A successful response includes the task ID mobile should open.

The catalog revision hashes the fixed factory catalog plus the resolved custom-task definition inputs. The run request sends the revision returned by the list request. The API must resolve commands and execute them against that same revision so a changed or removed command cannot silently execute different behavior. If the catalog changed between display and invocation, execution fails with a refreshable conflict instead of falling back to stale client data.

Desktop keeps its task-scoped, machine-scoped, and shortcut commands, but its repository factory and custom-task entries consume this same catalog and run endpoint. This removes the current duplicate factory prompts from the desktop client without changing their visible command-palette behavior.

## Catalog Composition

The catalog has two groups.

### Automations

These entries come from the selected repository's `.kanna/tasks/*/agent.md` definitions, including built-in definitions available to that repository. For Kanna today, this includes:

- Merge Master — Analyze, order, verify, and merge one or more pull requests.
- Ship — Build, sign, notarize, and release Kanna.

Repositories can add, remove, or change these entries without a mobile release.

### Configure Repository

These factory commands are always available for a valid repository:

- Set Up Repository
- Create Config
- Create Agent
- Create Workflow
- New Custom Task

The server is the source of truth for factory labels, descriptions, prompts, and referenced agents. Desktop and mobile should consume the same repo-command definitions rather than maintaining separate prompt copies. Migrating unrelated desktop shortcut commands is outside this change.

## Mobile Experience

The More tab shows:

1. A heading and the selected repository name.
2. A search field that filters labels and descriptions locally.
3. An Automations section.
4. A Configure Repository section.

The selected repository comes from the existing mobile repository selection. If the app has exactly one repository, that repository remains the implicit selection. The repository chip shown in More opens a compact selector backed by the existing repo list and updates the same global selection used by Tasks. It only switches command context; repository creation, import, removal, and other management stay outside More.

Tapping a command starts a single-flight launch:

- The selected row shows progress.
- Other launches remain disabled until the request finishes.
- Repeated taps cannot create duplicate tasks.
- No confirmation modal is required because the command launches an agent task; commands such as Ship gather and confirm consequential choices inside that task.

After a successful launch, mobile refreshes task collections and opens the returned task. The user lands in the normal task experience and can continue the command's conversation there.

Search with no matches shows a compact empty result. A repository with no custom automations still shows Configure Repository commands.

## State and Data Flow

The mobile API client gains methods to list and run repository commands. LAN, relay, and cloud/LAN routing clients route these calls through the desktop that owns the selected repository, using the same repository identity rules as task creation.

The mobile controller owns catalog loading and execution:

1. Resolve the selected repository and its owning desktop.
2. Load its repo-command catalog when More becomes active or the repository changes.
3. Store the catalog, load status, execution status, and error state in the session store.
4. Filter commands in the More presentation layer without additional network calls.
5. Run the selected command through the routed client.
6. Refresh task collections after success.
7. Open the returned task ID.

The current `moreCommands` model is replaced by a repository-command presentation model. `MoreScreen` no longer receives a selected task or task-action callbacks.

## Error Handling

- No selected repository: show a clear prompt to select a repository from Tasks.
- Catalog load failure: retain no stale commands for a different repository, show the error, and offer retry.
- Owning machine offline: explain that the repository's machine must be reachable; do not substitute commands from another repository or machine.
- Unknown, removed, or changed command: return a conflict, reload the catalog, and ask the user to retry.
- Launch failure: keep More open, clear the single-flight state, and show a retryable error.
- Refresh-after-launch failure: open the returned task when it is already present in observed task state; otherwise report that launch succeeded but task loading failed and offer a task refresh.

## Testing

Server tests cover:

- Factory command metadata and grouping.
- Repo-defined custom-task discovery and stable identifiers.
- Built-in and repository override precedence.
- Factory command launch prompts and referenced agents.
- Custom-task launch configuration preservation.
- Merge Master singleton reuse.
- Missing repositories, unknown commands, stale catalog revisions, and launch failures.

Mobile tests cover:

- LAN and relay/cloud transport paths for listing and running commands.
- Routing commands to the desktop that owns the selected repository.
- Controller loading on More activation and repository changes.
- Single-flight execution and duplicate-tap prevention.
- Refreshing and opening the returned task after launch.
- Load, offline, conflict, and launch error states.
- Search and grouping presentation.
- Repository-chip selection updating the existing global repo context and catalog.
- Absence of Create Task, refresh, pairing, desktop switching, update diagnostics, and task-scoped commands from More.

Desktop compatibility tests cover retaining task, machine, and shortcut entries while sourcing repository factory and custom-task entries from the server catalog.

Verification uses:

```bash
pnpm --dir apps/mobile test -- --runInBand
pnpm --dir apps/mobile run typecheck
./kd test rust
```

Physical-device installation or Appium execution is not part of agent verification.

## Non-Goals

- Implementing or revising the task `+` menu.
- Implementing the Machines UI.
- Copying the full desktop shortcut palette to mobile.
- Adding shell, IDE, window, sidebar, or keyboard-shortcut commands to mobile.
- Adding a second task-creation entry point.
- Turning More into settings, account, connection, or update-status UI.
