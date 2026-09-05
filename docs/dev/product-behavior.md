# Product Behavior

The user-facing surface of Kanna: task workflows, close semantics, sidebar
state, the diff viewer, keyboard shortcuts, and preferences. Read this when
changing UI flows or task lifecycle behavior.

The *contracts* an agent must not break — core concepts, workflow and stage
semantics, and the MCP task-management rule — stay in the repo-root
[`AGENTS.md`](../../AGENTS.md).

### Workflows

**Create a task:**
1. ⇧⌘N → enter prompt (choose an available agent provider)
2. The frontend calls `kanna-server`, which creates the git worktree
   (`{repo}/.kanna-worktrees/task-{uuid}`)
3. …runs `.kanna/config.json` setup scripts if present (e.g., `pnpm install`)
4. …and asks the daemon to spawn the agent CLI in the worktree
5. Agent starts working. User watches in real-time terminal.

**Review and merge:**
1. Agent finishes → task marked as unread (bold in sidebar)
2. User selects task, presses Cmd+D → diff modal shows all branch changes
3. Optionally Cmd+P → file picker → preview, Cmd+O → open in IDE, or Cmd+J → shell in worktree
4. Cmd+S → advance the workflow (commit post runs in-session; the pr-stage agent creates the GitHub PR and reports its URL)
5. Human reviews the PR, then Cmd+S (or the diff modal's approve button) advances the pr stage: when the task's pinned workflow ships the `approve` post, the button reads "Approve & Merge" and the post signals the merge master, which merges it; pinned workflows without the post get a plain "Approve" that only advances. Approval is single-flight: while the post runs the button is disabled and repeated Cmd+S is ignored — only the post's completion closes the task. Shift+Cmd+S in the diff modal sends the task back to `in progress` for revisions instead.

**Revisions.** Sending a task back for revision follows these contracts
(engine code: `crates/kanna-server/src/task_creator/{stages,resume}.rs`):

- *Feedback is required — for every caller.* An agent-originated request with
  an empty prompt is refused (400) at the API boundary, before a revision
  round is spent or the review run is closed, so the reviewer can resend its
  findings. Every other caller — the human path included — falls back to the
  terminating run's recorded `feedback`, then to its result `summary`; if
  neither holds anything to act on, preparation is refused rather than
  started empty (and any claimed round is handed back).
- *Agent verdicts are bound to their review run.* The request adapter injects
  the immutable `stage_run` id stamped into the reviewer's spawn context.
  The server refuses a task/run mismatch, a stale or already-finished review
  run, or a missing id on a newly bound run before it closes a review or
  spends a revision round. Pre-binding legacy runs keep their compatibility
  path; the desktop's human revision action remains usable for recovery.
- *Revisions resume by default, provider-neutrally.* `request_revision`
  reopens the target stage's previous PTY agent session in that run's **own
  worktree** — Claude, Copilot, Codex, and OpenCode all resume when their
  recorded session/transcript preconditions hold (each CLI keys transcripts
  differently; the engine checks the recorded session id against the
  provider's own store and the run's cwd). Antigravity and headless SDK
  sessions cannot resume, and any failed precondition (missing transcript,
  worktree gone, tip diverged from the committed one) falls back to a fresh
  fork — with the reason recorded durably on the replacement run
  (`stage_run.resume_fallback_reason`).
- *Rounds are budgeted.* A workflow's `revision_limit` defaults to **5**
  (`0` = unlimited) and counts only *agent-requested* revisions. Once spent,
  an agent's `request_revision` starts nothing: the review verdict is still
  recorded, the task parks `unread` at its current stage, and the response
  carries `revisionBudget.exhausted: true`. A *human* revision bypasses the
  budget and **resets** the count — but only the budget: it is still subject
  to feedback resolution and every other preparation precondition.
  This is also the documented recovery when a human decides a task should get
  another pass after an automatic round was consumed incorrectly; no separate
  counter-repair operation exists.
- *The task's terms live in its committed spec* —
  `docs/task-specs/<task-id>.md`, written by the implement agent, updated in
  the same commits as the work, and judged by later review stages
  ([`docs/specs/task-spec-artifact.md`](../specs/task-spec-artifact.md)).
  Reviewer feedback and scope decisions land there, so a revision round
  changes the spec as well as the code.

**Manual intervention:**
1. Cmd+J → shell modal opens in the task's worktree
2. Run tests, inspect files, debug
3. Close shell → focus returns to agent terminal
4. Type in agent terminal to send input to Claude

**Multi-repo:** Import repos via sidebar. Each repo has its own task list. Cmd+Opt+Up/Down navigates tasks in sidebar order.

### Closing a task (⇧⌘⌫)

Close is refused (409) while the task has open subtasks — close or detach them
first. Otherwise:

1. Kills the agent PTY session and shell session in the daemon
2. Runs workspace teardown commands best-effort when configured
3. Sets `closed_at` in the DB
4. Snapshots dirty state in each of the task's worktrees with a local `WIP at task close` commit, then removes those worktrees with `git worktree remove --force --force` and prunes worktree registrations
5. Deletes the task's `worktree` table rows but keeps the task row and all branches. Branches are never deleted by close.
6. Selects the next task in the sidebar
7. Tasks with `closed_at` are hidden from the sidebar. The sidebar shows tasks whose `closed_at` is null.

Close also delivers blocker-close instructions to dependent tasks' sessions
and starts dependents the close unblocked. Managers observe the durable
`task.closed` event through `kanna_wait_events`; close does not inject input
into another task's terminal.

On server startup, Kanna reconciles leftovers across all repos, including hidden repos: closed-task worktrees are snapshotted and removed, stale registrations are pruned, and young orphan `task-*` directories without a task row are spared. This bounds registered worktrees by construction to roughly the number of open tasks. The bound matters because each registered git worktree expands sandboxed agent shell spawn profiles; unbounded worktrees can overflow macOS `ARG_MAX` and cause sandboxed shell launches to fail with `E2BIG`.

### Task activity

`activity` is a *display* value that blends two independent dimensions —
what the agent process is doing (`runtimeState`: `busy` | `waiting` | `idle` |
`exited`, the daemon's terminal-state verdict) and whether the latest output
has been read (`readState`: `read` | `unread`). Task detail reports all three;
supervision reads `runtimeState`, because a busy task nobody has read carries
`unread` exactly like a finished one.

| Activity | Meaning | Sidebar display |
|-------|---------|-----------------|
| `working` | The daemon judges the session busy | italic |
| `idle` | Stopped, and read (or selected) | normal |
| `unread` | Latest output not yet read — finished *or* still busy | bold |

Sidebar order: pinned (manual `pin_order`) → unpinned unblocked tasks grouped
by workflow stage in the repo's `stage_order` (default `pr` → `review` →
`in progress`; unknown stages last), newest first within each group → blocked
(newest first). Subtasks nest under their parents (suppressed while
searching).

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
| ⌘N / ⌘W | New window / close window |
| ⌘D | Diff modal |
| ⇧⌘S | Request changes (diff modal — send back for revision) |
| ⌘J | Shell modal |
| ⇧⌘J | Shell at repo root |
| ⌘P | File picker |
| ⌥⌘P | Toggle file preview |
| ⌘O | Open in IDE |
| ⌘L | Open latest file link |
| ⌘S | Advance stage / approve (runs the stage's post first; blocked while a post is running) |
| ⇧⌘⌫ | Close task |
| ⌥⌘↑/↓ | Navigate tasks |
| ⇧⌘↑/↓ | Navigate repos |
| ⌘U / ⇧⌘U | Oldest unread task (repo / all repos) |
| ⌘R / ⇧⌘R | Oldest read task (repo / all repos) |
| ⌘F | Focus search |
| ⌘I / ⇧⌘I | Create repo / import repo |
| ⌘B | Toggle sidebar |
| ⌘G | Commit graph |
| ⇧⌘P | Command palette |
| ⇧⌘E | Tree explorer |
| ⇧⌘Enter | Toggle maximize |
| ⇧⌘A | Analytics |
| ⌘/ | Keyboard shortcuts |
| ⌘, | Preferences |
| Ctrl+- / Ctrl+Shift+- | Back / Forward |
| Escape | Dismiss modal |

The registry in `apps/desktop/src/composables/useKeyboardShortcuts.ts` is the
single source of truth. Shortcuts are context-scoped (most to the main view,
some to the diff or other modals); within its context a shortcut also works
while the terminal has focus.

### Preferences

| Setting | Default |
|---------|---------|
| Suspend After (minutes) | 5 |
| Kill After (minutes) | 30 |
| IDE Command | code |
| Locale | en |
| Default Agent Provider | claude |

Stored in SQLite `settings` table.

## Mobile app

The connection model and data paths are in
[Architecture](architecture.md#mobile-app--appsmobile--packagesstream-client);
this is the user-facing surface.

**Structure.** Three tabs — **Tasks** (repo-scoped, with a repo chip row),
**Activity** (unread, not-locally-dismissed tasks across repos), and **More**
(repo commands) — behind a floating toolbar that also carries Search and
"Add task". Tapping a row opens the full-screen task detail: agent view or
terminal, a composer with quick replies and photo attachment, and file/diff
previews. Account, the Machines list, and the Quick Replies editor live in a
modal account sheet; there is no settings tab.

**Task cards** are tinted by workflow stage from the app-icon palette
(`in progress` orange, `review` purple, `pr` green, `consultation` blue;
custom stages hash onto a fixed sub-palette; blocked is a rose badge on top of
the stage color). A short task id sits beside the truncating title; unusually
long IDs middle-ellipsize in their bounded metadata column so the title remains
legible. Up to three lines of the task's latest output snippet render on the card — live via
the KSP task-summary stream while connected, falling back to the resting
(Firestore) snippet on disconnect.

**Pins and dismissals are phone-local.** Swiping a row left and releasing past
the threshold commits the action (pin/unpin in Tasks, dismiss in Activity);
releasing inside the threshold cancels — there is no revealed-button state.
Pins order to the top of the repo list; a dismissal hides the task from
Activity until newer activity arrives. Neither is published to the desktop,
and a mobile dismiss never marks the task read for the desktop or
supervisors.

**Pairing.** A desktop is added by scanning its QR code (or typing the 6-char
code): the phone finds the desktop via Bonjour on the LAN and claims the
pairing session over HTTP, receiving a device credential that is independent
of the signed-in account (manually paired machines survive sign-out; signing
out does drop the account's machines). After pairing, the app immediately
loads the new machine's work and shows the wait. Machines shows every desktop
merged from the account, manual pairing, and live LAN discovery, grouped by
availability.

**Photo attachments.** The composer can attach one photo (library or camera)
to a task input; images are resized/re-encoded to JPEG within a 3 MiB budget.
The control appears only when the task's own desktop advertises attachment
support (asked once per task and route), and permission denials explain
whether to retry or open Settings. The desktop stores the image outside the
worktree and appends `[Attached image: <path>]` to the injected input.
