# Sidebar Remote Task Marker Design

## Summary

Remote-owned workspace tasks should be visually distinct from local tasks in the sidebar without changing task ordering, grouping, or existing activity styling. The sidebar will prefix non-local tasks with a muted monospace `< ` marker before the task title.

## Context

`App.vue` builds sidebar data from `buildWorkspace()`. `WorkspaceTask` already records whether a task is local-owned or remote-owned through `owner.kind`, `sources`, `reachability`, and `terminal.kind`. Today that metadata is flattened into `PipelineItem` props before reaching `Sidebar.vue`, so the sidebar cannot distinguish local and remote tasks.

## Behavior

- Local-owned tasks render exactly as they do today.
- Remote-owned tasks render in the same pinned, stage, or blocked section they already occupy, but their visible title is prefixed with `< `.
- The marker is muted and monospace so it reads as metadata, not part of the task name.
- The marker appears before any task title text, including active post-action titles that already start with `... `.
- The marker should have a discoverable meaning through a title or accessible label such as "Remote task".
- Search, sorting, drag/pin behavior, selection, unread bold, working italic, and teardown styling remain unchanged.

## Architecture

Add a sidebar-only presentation field derived from `WorkspaceTask.owner.kind` before tasks are passed to `Sidebar.vue`. This keeps ownership decisions in the workspace layer and avoids encoding remote detection from task ID prefixes inside the sidebar.

The sidebar component will accept workflow-item-like objects with optional remote presentation metadata. It will use a helper to determine whether to show the marker, then render title content through a shared task-title fragment for pinned, normal, and blocked rows.

## Testing

Add focused component coverage for `Sidebar.vue`:

- remote/non-local tasks render the leading `< ` marker
- local tasks do not render the marker
- the marker does not alter the underlying task title text behavior

Because this is a narrow sidebar presentation change and uses data already covered by workspace tests, component tests are sufficient. No E2E test is required unless the implementation touches workspace merge behavior or remote task selection/routing.
