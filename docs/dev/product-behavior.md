# Product Behavior

The user-facing surface of Kanna: task workflows, close semantics, sidebar
state, the diff viewer, keyboard shortcuts, and preferences. Read this when
changing UI flows or task lifecycle behavior.

The *contracts* an agent must not break — core concepts, pipeline and stage
semantics, and the MCP task-management rule — stay in the repo-root
[`AGENTS.md`](../../AGENTS.md).

### Workflows

**Create a task:**
1. Cmd+N → enter prompt (choose an available agent provider)
2. App creates git worktree (`{repo}/.kanna-worktrees/task-{uuid}`)
3. Runs `.kanna/config.json` setup scripts if present (e.g., `pnpm install`)
4. Spawns agent CLI in the worktree via daemon
5. Agent starts working. User watches in real-time terminal.

**Review and merge:**
1. Agent finishes → task marked as unread (bold in sidebar)
2. User selects task, presses Cmd+D → diff modal shows all branch changes
3. Optionally Cmd+P → file picker → preview, Cmd+O → open in IDE, or Cmd+J → shell in worktree
4. Cmd+S → advance the pipeline (commit post runs in-session; the pr-stage agent creates the GitHub PR and reports its URL)
5. Human reviews the PR, then Cmd+S (or the diff modal's approve button) advances the pr stage: when the task's pinned pipeline ships the `approve` post, the button reads "Approve & Merge" and the post signals the merge master, which merges it; pinned pipelines without the post get a plain "Approve" that only advances. Approval is single-flight: while the post runs the button is disabled and repeated Cmd+S is ignored — only the post's completion closes the task. Shift+Cmd+S in the diff modal sends the task back to `in progress` for revisions instead.

**Manual intervention:**
1. Cmd+J → shell modal opens in the task's worktree
2. Run tests, inspect files, debug
3. Close shell → focus returns to agent terminal
4. Type in agent terminal to send input to Claude

**Multi-repo:** Import repos via sidebar. Each repo has its own task list. Cmd+Opt+Up/Down navigates tasks in sidebar order.

### Closing a task (Cmd+Delete)

1. Kills the agent PTY session and shell session in the daemon
2. Runs workspace teardown commands best-effort when configured
3. Sets `closed_at` in the DB
4. Snapshots dirty state in each of the task's worktrees with a local `WIP at task close` commit, then removes those worktrees with `git worktree remove --force --force` and prunes worktree registrations
5. Deletes the task's `worktree` table rows but keeps the task row and all branches. Branches are never deleted by close.
6. Selects the next task in the sidebar
7. Tasks with `closed_at` are hidden from the sidebar. The sidebar shows tasks whose `closed_at` is null.

On server startup, Kanna reconciles leftovers across all repos, including hidden repos: closed-task worktrees are snapshotted and removed, stale registrations are pruned, and young orphan `task-*` directories without a task row are spared. This bounds registered worktrees by construction to roughly the number of open tasks. The bound matters because each registered git worktree expands sandboxed agent shell spawn profiles; unbounded worktrees can overflow macOS `ARG_MAX` and cause sandboxed shell launches to fail with `E2BIG`.

### Task activity

| State | Meaning | Sidebar display |
|-------|---------|-----------------|
| `idle` | No recent activity | normal |
| `working` | Agent actively running (PostToolUse hook) | italic |
| `unread` | Agent finished, user hasn't looked | bold |

Sorted in sidebar: pinned (manual order) → merge → pr → active (by created_at desc) → blocked.

### Pinned tasks

Tasks can be pinned to the top of their repo's task list by dragging above the pin divider. Per-repo scope. Closed tasks disappear regardless of pin state.

### Diff viewer

- Modal (Cmd+D), not a tab
- Scopes: Branch (all changes since merge-base with default branch), Last Commit, Working (uncommitted)
- Staged toggle to filter staged-only changes
- Scope remembered per task
- Rendered by `@pierre/diffs` with shadow DOM, syntax highlighting via worker pool

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| ⇧⌘N | New task |
| ⌘D | Diff modal |
| ⌘J | Shell modal |
| ⇧⌘J | Shell at repo root |
| ⌘P | File picker |
| ⌘O | Open in IDE |
| ⌘S | Advance stage / approve (runs the stage's post first; blocked while a post is running) |
| ⇧⌘Delete | Close task |
| ⌘Z | Undo close |
| ⌘Opt+Up/Down | Navigate tasks |
| ⌘B | Toggle sidebar |
| ⇧⌘P | Command palette |
| ⇧⌘E | Tree explorer |
| ⇧⌘Enter | Toggle maximize |
| ⇧⌘A | Analytics |
| ⌘/ | Keyboard shortcuts |
| ⌘, | Preferences |
| Ctrl+- / Ctrl+Shift+- | Back / Forward |
| Escape | Dismiss modal |

All shortcuts work even when the terminal has focus.

### Preferences

| Setting | Default |
|---------|---------|
| Suspend After (minutes) | 5 |
| Kill After (minutes) | 30 |
| IDE Command | code |
| Locale | en |
| Default Agent Provider | claude |

Stored in SQLite `settings` table.
