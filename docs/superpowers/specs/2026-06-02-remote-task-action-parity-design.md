# Remote Task Action Parity Design

Date: 2026-06-02
Status: Proposed
Scope: Make local, LAN, and cloud workspace tasks expose the same user-facing actions wherever the owner machine can support them

## Summary

Kanna should treat local, LAN, and cloud tasks as one workspace model with one action surface.
The current workspace layer deduplicates task sources and can route terminals, close, and stage advancement, but several actions still assume a local repo path or local Tauri command.
That leaves remote tasks visibly present but functionally partial.

This design introduces a task action gateway and provider-based file, diff, shell, and IDE flows.
The selected task chooses an owner route, and actions execute through that route.
The desktop that owns the worktree remains authoritative for task state, git state, PTY sessions, and lifecycle mutations.

For remote `Cmd+O`, Kanna should not open an IDE on the remote machine and should not pretend the remote task has a local live worktree.
Instead, Kanna should request a filtered owner-side snapshot, unpack it into a local temporary review directory, add a marker file explaining the snapshot semantics, and open that local directory in the user's IDE.
Editing that snapshot is not a sync workflow; taking over work remains an explicit pull or transfer action.

## Goals

- Give reachable remote tasks parity for common shortcuts: terminal, input, resize, close, advance stage, diff, file picker, preview, shell, PR, merge, and IDE review.
- Keep the owner desktop as the source of truth for worktree state and task mutations.
- Remove local-vs-remote branching from UI components and centralize it behind task action clients.
- Make LAN and cloud expose the same action vocabulary where the transport can support it.
- Prefer LAN over cloud when both routes can reach the same owner task.
- Make remote `Cmd+O` useful without creating hidden bidirectional file sync.
- Preserve explicit task transfer as the route for local ownership and real local editing.

## Non-Goals

- Collaborative live editing of one task from multiple machines.
- Syncing edits made inside a remote IDE snapshot back to the owner worktree.
- Making cloud storage authoritative for worktree contents.
- Replacing the daemon as the PTY/session owner.
- Replacing SQLite as the owner-side task database.
- Opening an IDE on another desktop as a hidden side effect of `Cmd+O`.

## Architecture

### Owner-Authoritative Actions

Every task action should be executed by the desktop that owns the task worktree.
For local tasks, the owner is the current desktop.
For LAN and cloud tasks, the current desktop sends an action request to the owner route.

The canonical execution boundary is `kanna-server`:

```text
UI -> WorkspaceTaskActionClient -> local / LAN / cloud route -> owner kanna-server -> DB / daemon / git / filesystem
```

The transfer sidecar and cloud relay should remain transport and trust layers.
They should not duplicate task lifecycle, git, or filesystem business logic.
When a remote action arrives, the owner-side transport should forward it to owner `kanna-server`.

### Task Action Gateway

Add a frontend gateway, for example `WorkspaceTaskActionClient`, with one API per product action:

```ts
taskActions.observeTerminal(task, listener)
taskActions.sendInput(task, data)
taskActions.resizeTerminal(task, cols, rows)
taskActions.close(task)
taskActions.advanceStage(task)
taskActions.makePr(task)
taskActions.mergePr(task)
taskActions.getDiff(task, options)
taskActions.listFiles(task, options)
taskActions.readFile(task, path)
taskActions.openShell(task)
taskActions.openInIde(task)
taskActions.createSnapshot(task, options)
```

The gateway resolves the best route from `WorkspaceTask`:

1. local owner route,
2. trusted LAN owner route,
3. cloud relay owner route.

UI components should call the gateway and provider interfaces.
They should not inspect task source kind except for display copy and diagnostics.

### Generic Remote Action Transport

LAN should move away from one command per action.
Instead of adding `diff_peer_task`, `merge_peer_task`, and similar variants, the sidecar should support a generic request:

```rust
RunPeerTaskAction {
    target_peer_id,
    task_id,
    action,
    args,
}
```

The owner side should forward that to:

```http
POST /v1/tasks/{task_id}/actions/{action}
```

Cloud relay should expose the same logical request shape.
The relay transport can still use HTTP invocation internally, but the frontend should see one action client contract for LAN and cloud.

Terminal streams can keep their specialized streaming protocol because they are long-lived subscriptions, not simple task actions.
Shell sessions may reuse the terminal stream shape after owner `kanna-server` can create scoped shell sessions.

## Capability Model

Capabilities should be advertised by the owner snapshot and merged by the workspace layer.
They should not be inferred only from `source.kind === "local"`.

Each published task snapshot should include an action capability map:

```json
{
  "protocolVersion": 2,
  "actions": {
    "terminal": true,
    "sendInput": true,
    "resizeTerminal": true,
    "close": true,
    "advanceStage": true,
    "makePr": true,
    "mergePr": true,
    "diff": true,
    "listFiles": true,
    "readFile": true,
    "openShell": true,
    "ideSnapshot": true,
    "pullToMachine": true
  }
}
```

`buildWorkspace()` should merge capabilities from attached routes and prefer the best reachable route per action.
Offline snapshots may remain visible but should not advertise mutating or live interaction actions.

The current `WorkspaceCapabilities` can remain as the UI-facing shape, but each flag should be derived from route action availability.
When helpful, split broad flags into clearer provider capabilities, such as `canOpenIdeSnapshot` versus `canOpenLocalIde`.

## Feature Behavior

### Terminal, Input, And Resize

Local tasks use local daemon commands.
Remote tasks stream through the owner route using LAN or cloud terminal transports.
This behavior already mostly exists and should be folded into the action gateway.

### Close, Advance Stage, PR, And Merge

Lifecycle actions execute on the owner desktop.
The owner updates SQLite, daemon sessions, git state, and published snapshots.
The current desktop may optimistically hide or refresh the task after success, then reconcile from the next owner snapshot.

### Diff

Diff UI should become provider-based.
`DiffModal` should accept a diff provider instead of assuming `store.selectedRepo.path`.

Local provider:

- calls existing local git/Tauri commands.

Remote provider:

- requests owner `kanna-server` to compute the selected diff scope;
- returns the same patch/file metadata shape used by local rendering;
- lets the current desktop render the diff locally with the existing diff viewer.

### File Picker, Tree Explorer, And Preview

File browsing should use a file provider.

Local provider:

- lists files and reads content from local git/worktree commands.

Remote provider:

- asks the owner desktop for gitignore-aware file lists and file content;
- enforces path containment on the owner side;
- returns text or explicit binary metadata for preview handling.

### Shell

Remote `Cmd+J` should mean live shell on the owner machine inside the task worktree.
The owner creates a shell session through `kanna-server`, and the current desktop observes it through the same terminal transport family.

Shell at repo root follows the same rule with an owner-side repo-root session.

### Open In IDE

Local task `Cmd+O` keeps the current behavior: open the local worktree in the configured IDE.

Remote task `Cmd+O` creates a local review snapshot:

1. Current desktop requests an owner-side snapshot for the task.
2. Owner packages tracked files, modified files, staged files, and untracked non-ignored files.
3. Owner excludes `.git`, ignored/generated directories, and bulky dependency/build outputs such as `node_modules`, `.build`, `dist`, and target caches.
4. Current desktop unpacks the archive under a local temp/review root:
   `~/Library/Application Support/Kanna/Remote Workspaces/{owner}/{taskId}/{timestamp}/`
5. Kanna writes a marker file such as `Kanna Remote Snapshot.md`.
6. Kanna opens the local snapshot directory with the configured IDE command.

The marker file should state:

- source desktop,
- source repo and branch,
- task id,
- snapshot time,
- that edits in this directory do not affect the remote task,
- that pulling/transferring the task is the route for ownership and real local editing.

Snapshot directories should remain writable by default.
Many IDEs write index, settings, or extension state beside opened files, and OS-level read-only enforcement would create friction without providing real synchronization safety.
The marker file and explicit transfer workflow are the product boundary.
Users can edit the temp files, but Kanna does not sync those edits back.

### Pull Or Transfer For Editing

When users need to make local changes to a remote task, the app should point them to Pull from Machine or task transfer.
That workflow creates or imports a real local worktree and changes ownership semantics explicitly.

## Owner Server API

Extend `kanna-server` around product resources:

- `POST /v1/tasks/{task_id}/actions/{action}` for mutating and lifecycle actions.
- `GET /v1/tasks/{task_id}/diff` for diff data.
- `GET /v1/tasks/{task_id}/files` for file lists.
- `GET /v1/tasks/{task_id}/files/{path}` or a query-encoded path route for file content.
- `POST /v1/tasks/{task_id}/shells` for scoped shell session creation.
- `POST /v1/tasks/{task_id}/snapshots` for IDE review snapshots.

Routes should validate task ownership, path containment, action capability, and trust/auth context before touching filesystem, daemon, git, or DB state.

## Data Flow

Remote `Cmd+D`:

```text
Shortcut -> taskActions.getDiff(task, scope)
  -> LAN/cloud action route
  -> owner kanna-server computes git diff
  -> local DiffModal renders returned diff
```

Remote `Cmd+P` / preview:

```text
File UI -> task file provider
  -> owner list/read file route
  -> local picker/preview renders returned data
```

Remote `Cmd+J`:

```text
Shortcut -> taskActions.openShell(task)
  -> owner creates shell PTY
  -> current desktop observes shell terminal stream
```

Remote `Cmd+O`:

```text
Shortcut -> taskActions.openInIde(task)
  -> owner creates filtered snapshot archive
  -> current desktop unpacks review directory
  -> local IDE opens review directory
```

## Error Handling

Remote actions should distinguish:

- owner unreachable,
- route unsupported by transport,
- action unsupported by owner capability,
- task no longer active,
- auth/trust failure,
- owner filesystem/git/daemon failure.

The UI should keep remote tasks visible after failed actions unless the owner snapshot confirms closure or removal.
Snapshot creation failures should leave no partial review directory, or should mark the directory as incomplete and avoid opening the IDE.

## Testing

Add contract tests for the action gateway so the same behavior is checked for local, LAN, and cloud clients.

Required coverage:

- capability merge prefers local, then LAN, then cloud;
- remote `Cmd+D` requests owner diff and renders it through `DiffModal`;
- remote file picker and preview use the remote file provider;
- remote `Cmd+J` creates and observes an owner shell session;
- remote `Cmd+O` downloads a filtered snapshot, writes the marker file, and invokes the IDE on the local snapshot directory;
- remote lifecycle actions execute through owner `kanna-server`;
- offline remote snapshots disable live and mutating actions;
- LAN generic action transport forwards to owner `kanna-server`;
- cloud relay action transport uses the same action vocabulary.

E2E coverage should include at least one reachable remote task flow for LAN and one relay-backed action flow.
If full relay E2E remains too expensive, keep a relay contract test and document the missing infrastructure.

## Migration Plan

1. Introduce the action gateway and move existing local, LAN, and cloud terminal/close/advance behavior behind it.
2. Add owner-advertised action capabilities to cloud and LAN task snapshots.
3. Replace per-action LAN commands with generic `RunPeerTaskAction`, keeping existing commands as temporary compatibility wrappers.
4. Add owner `kanna-server` routes for diff, files, shell creation, PR, merge, and snapshot creation.
5. Convert `DiffModal`, file picker, tree explorer, preview, and shell modal to consume providers from the selected workspace task.
6. Implement remote `Cmd+O` snapshot packaging and local review-directory opening.
7. Remove UI local-vs-remote checks that are covered by provider capabilities.

## Implementation Decisions

- Snapshot archives use a gzipped tar stream generated by owner `kanna-server`.
  Any new archive dependencies must be Cargo-vendored and statically linked through the normal release build.
- Snapshot creation estimates the total size of included files before packaging.
  If the snapshot is over 250 MB, Kanna prompts before downloading.
  If the snapshot is over 1 GB, Kanna refuses and directs the user to Pull from Machine.
- Snapshot retention keeps the latest 5 snapshots per owner/task and removes snapshots older than 7 days.
- Snapshot directories are writable by default and are treated as review copies, not protected copies.
