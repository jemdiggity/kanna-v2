# Origin-Default Kanna Definitions Design

## Summary

Kanna will load repository-owned orchestration configuration from the repository's fetched remote default branch instead of from the imported repository's checked-out files. For a repository whose configured default branch is `main`, the source is `origin/main`; for a repository whose default branch is `dev`, the source is `origin/dev`.

Each orchestration operation resolves that remote-tracking ref to one immutable commit and reads all relevant `.kanna` resources from the commit. This prevents a stale, dirty, or otherwise neglected local default branch from supplying a workflow, agent, or configuration value that disagrees with the code available on the remote default branch.

## Problem

The server currently reads these files directly beneath the imported repository path:

- `.kanna/config.json`
- `.kanna/workflows/<name>.json`
- `.kanna/agents/<role>/AGENT.md`
- `.kanna/agents/<role>/EXTEND.md`

The desktop also reads the local workflow directory, config file, and agent files when it prepares task-creation choices or resolves agent metadata. The repository path is normally the main checkout, but Kanna does not keep that checkout's local default branch synchronized. As a result:

- task code can start from a freshly fetched `origin/main` while its workflow and prompt came from stale local `main`;
- uncommitted local `.kanna` edits can affect task execution unexpectedly;
- the desktop can display or submit a local workflow choice that differs from what the server should execute;
- config fields can be mixed across sources even if agents and workflows move to the remote ref independently.

## Goals

1. Fetch `origin` before resolving repository-owned Kanna definitions.
2. Resolve `origin/<repo.default_branch>` once per orchestration operation and pin reads to its commit id.
3. Read every field in `.kanna/config.json`, workflow definitions, agent definitions, and agent extensions from that same commit.
4. Ensure desktop discovery and server execution use the same remote-backed source semantics.
5. Continue to support offline operation when a cached remote-tracking ref exists.
6. Keep bundled workflows and agents as the fallback for repositories without the corresponding remote file.
7. Avoid checking out, modifying, or fast-forwarding the user's local default branch.

## Non-goals

- Changing the branch or ref selected as a task's code base.
- Making task branches follow the remote default branch after task creation.
- Replacing the durable workflow JSON snapshot already stored on a task.
- Loading uncommitted `.kanna` changes from the imported checkout or a task worktree.
- Changing the schema or behavior of workflow, agent, or repo-config fields.
- Moving custom task-template discovery from `.kanna/tasks/` in this change.

## Approaches Considered

### 1. Read Git objects from an immutable remote commit (selected)

Run a best-effort fetch, resolve the remote default ref to a commit id, and use Git object reads such as `git show <commit>:.kanna/config.json` and `git ls-tree` for discovery. This provides an atomic source without touching a checkout and has no cleanup lifecycle.

### 2. Create a temporary worktree at the remote default ref

This would allow ordinary filesystem reads, but every resolution would need worktree registration, unique paths, concurrency handling, and cleanup. It adds exactly the worktree pressure Kanna otherwise works to bound.

### 3. Fast-forward the local default branch before reading

This would preserve existing filesystem readers but would mutate a user-owned checkout. It also fails when the branch is dirty, diverged, or checked out elsewhere. Kanna must not make task configuration depend on repairing the user's local branch.

## Architecture

### Remote definition snapshot

The server will introduce a focused definition-source abstraction, conceptually:

```text
RepoDefinitionSnapshot
  repo_path
  ref_name       = origin/<default_branch>
  commit_id      = immutable resolved commit
```

Creating a snapshot performs these steps:

1. Determine the default branch from the repository record, falling back to `main` only when the record has no value.
2. Run `git fetch origin` as a best-effort refresh.
3. Resolve `refs/remotes/origin/<default_branch>^{commit}`.
4. If fetch failed but the ref resolves, continue with the cached commit and log the fetch failure.
5. If the ref does not resolve, create a bundled-only source rather than reading the local checkout.

All Git commands use argument arrays rather than a shell. The resolved commit id, not the moving remote-tracking ref name, is used for subsequent reads so concurrent fetches cannot mix files from two remote revisions.

The abstraction exposes only the operations definition loading needs:

- read an optional UTF-8 file at a repository-relative path;
- list direct entries under a repository-relative tree;
- report the resolved ref name and commit id for diagnostics and API cache keys.

### Definition loading

The existing repo-config, workflow, agent, and extension parsers remain the validation source of truth. Their input changes from a filesystem path to a `RepoDefinitionSnapshot`.

Source behavior is uniform:

| Resource | Remote path exists | Remote path missing or no remote snapshot |
|---|---|---|
| `.kanna/config.json` | Parse the complete remote file | Use an empty/default repo config |
| Named workflow | Parse the remote file | Try the matching bundled workflow, then return the existing not-found error |
| Named agent role | Parse the remote role override | Resolve the configured/explicit bundled flavor, then the bundled base role |
| Agent `EXTEND.md` | Apply the remote extension | Apply no extension |

There is no fallback to local filesystem files. A malformed remote resource remains an error; Kanna must not hide it by silently using a local or bundled alternative.

All `.kanna/config.json` fields use the snapshot, including:

- default workflow selection;
- agent flavors and prompt variables;
- setup and teardown commands;
- port declarations and reserved port settings;
- workspace PATH configuration.

Top-level task operations create one snapshot and pass it through provider resolution, prompt construction, port allocation, setup/teardown resolution, and agent/workflow loading. Helpers must not independently re-resolve the moving remote ref during the same operation.

### Durable tasks

Task creation continues to serialize the normalized workflow definition into `pipeline_def`. Later stage transitions continue to use that stored workflow snapshot, preserving the task's pinned stage topology and policies.

When a later operation needs current repo configuration or an agent body that is not stored on the task, it resolves a fresh remote snapshot for that operation. Every such read still comes from the remote default branch, and all reads within the operation use one commit.

### Desktop API boundary

The server is the source of truth for remote-backed Kanna definitions. The desktop will stop reading `.kanna/config.json`, `.kanna/workflows`, `AGENT.md`, and `EXTEND.md` directly for orchestration-related UI.

Repository definition endpoints will be:

- `GET /v1/repos/{repo_id}/kanna-definitions` returns `{ revision, refName, config, defaultWorkflow, workflows }`;
- `GET /v1/repos/{repo_id}/kanna-definitions/workflows/{workflow_name}` returns `{ revision, definition }`;
- `GET /v1/repos/{repo_id}/kanna-definitions/agents/{agent_selector}` returns `{ revision, definition }`.

`revision` is the resolved commit id or `null` for a bundled-only source. `refName` is the attempted remote-tracking ref such as `origin/main`. `config` is the complete parsed remote repo config, or `{}` for a bundled-only source. `workflows` is the deduplicated, sorted union of remote workflow names and bundled workflow names; a remote file overrides a bundled definition with the same name. Path parameters are percent-encoded by the client and validated as definition names by the server.

Responses include the resolved commit id so desktop workflow and agent caches can be keyed or invalidated by revision rather than only by repository path and definition name.

The new-task modal uses the manifest for workflow choices and default selection. Desktop stage-order caching, task-session recovery, and worktree shell environment construction use the manifest's complete config instead of reading a checkout. Setup-agent and merge-agent preparation use the server-resolved agent endpoint. Optimistic stage projections use the server-resolved workflow endpoint. Actual task execution remains authoritative if the remote changes between displaying the modal and submitting the task.

## Data Flow

```text
Task/config request
  -> best-effort git fetch origin
  -> resolve origin/<default_branch> to commit id
  -> create RepoDefinitionSnapshot(commit id)
  -> read config + workflow + agent resources from that commit
  -> parse with existing validators
  -> create worktree / prompt / session using the resolved values
```

Task code-base selection remains independent. An explicitly selected feature branch can supply the task's code while Kanna orchestration definitions still come from the remote default branch.

## Error Handling

- A failed fetch is non-fatal when the cached remote-tracking ref resolves. Kanna logs that it used the cached commit.
- A failed fetch with no cached ref produces a bundled-only source. Default configuration and bundled agents/workflows remain usable; a requested custom definition returns a clear not-found error.
- An invalid remote config, workflow, agent, or extension reports the remote ref/commit and resource path in the error.
- Non-UTF-8 definition files fail clearly as invalid text resources.
- Concurrent operations may fetch independently, but each operation reads through its own immutable commit id.
- Local dirty files, local branch divergence, and local branch absence do not affect resolution.

## Testing

### Definition-source tests

Use a temporary bare origin and a clone whose local `main` deliberately differs from `origin/main`:

- local config, workflow, agent, and extension contain sentinel values that must never appear;
- remote config exercises workflow, flavors, vars, ports, setup, teardown, and workspace PATH fields;
- every loader returns the remote values from one commit;
- dirty local edits do not alter results.

Add refresh and fallback coverage:

- advancing origin after the clone causes the next snapshot to use the new remote commit;
- an unreachable origin with a cached `origin/main` uses the cached commit;
- no resolvable remote ref produces default config and bundled definitions, never local custom files;
- malformed remote files fail instead of falling back.

### Task orchestration tests

Create a task from a stale-local/fresh-remote fixture and verify:

- the selected/default workflow comes from remote config;
- provider, model, permission mode, allowed tools, agent body, extension, and prompt variables come from the remote agent/config;
- port and workspace setup values come from remote config;
- the stored workflow snapshot matches the remote workflow;
- the task worktree behavior remains governed by the separately selected code base.

Stage, revision, rerun, merge-agent, setup, and teardown tests should prove their config/agent reads use a snapshot rather than the repository or worktree filesystem.

### Desktop and HTTP tests

- repository definition endpoints return remote-backed manifest, workflow, and agent responses with a commit id;
- the new-task modal uses the remote workflow list and default;
- stage ordering, recovered task sessions, and task worktree shells use the remote config returned by the manifest;
- agent and workflow caches change when the returned commit id changes;
- setup and merge flows do not call direct filesystem readers for definitions;
- an API error is surfaced through the existing task-creation or action error UI.

### Verification

- focused Rust tests for the definition source and task creator;
- focused desktop Vitest suites for task creation and workflow/agent loading;
- `./kd test rust`;
- `pnpm test` when focused suites are green.

## Expected Files

The implementation is expected to touch:

- `crates/kanna-server/src/task_creator/definitions.rs` and its tests;
- task-creator call sites that currently pass repository/worktree paths to definition loaders;
- `crates/kanna-server/src/http_api/repos.rs`, routing, and route tests;
- `apps/desktop/src/services/desktopServerClient.ts`;
- `apps/desktop/src/composables/useAppTaskCreation.ts`;
- `apps/desktop/src/stores/workflow.ts` and related tests.

A small dedicated Rust module for the Git-backed snapshot is preferred if keeping it inside `definitions.rs` would mix Git transport concerns with parsing concerns.
