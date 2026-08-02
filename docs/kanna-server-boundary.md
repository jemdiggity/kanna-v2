# Kanna Server Boundary

`kanna-server` is the desktop-side service boundary for non-desktop consumers.
Mobile clients and future CLI tools should talk to `kanna-server`, not directly to the daemon protocol, Tauri commands, or desktop UI state.

The desktop frontend itself is planned to become a `kanna-server` client as well; see [2026-07-05-desktop-server-migration-plan.md](2026-07-05-desktop-server-migration-plan.md) for the phased migration off direct SQLite access.

## Responsibility Split

- `kanna-server`: LAN HTTP and WebSocket transport, route validation, task listing and search, task lifecycle actions, pairing state
- daemon: PTY and session ownership, terminal input and output, agent process lifecycle
- SQLite DB: repo and task persistence, task metadata, query backing for server resources

## v1 LAN Surface

- `GET /v1/status`
- `GET /v1/stream` (KSP WebSocket for terminal, agent, and streamed task API frames)
- `GET /v1/desktops`
- `GET /v1/repos`
- `GET /v1/repos/{repo_id}/tasks`
- `GET /v1/repos/{repo_id}/agents` (resolved named agent definitions available to task creation)
- `GET /v1/repos/{repo_id}/recent-pipelines` (pipeline names the repo's tasks were most recently created with, newest first)
- `POST /v1/tasks/{task_id}/actions/set-pipeline` (re-pin an open task to a compatible pipeline definition)
- `GET /v1/tasks/recent`
- `GET /v1/tasks/search?query=...`
- `GET /v1/task-events?taskIds=...|parentTaskId=...|repoId=...&cursor=...&timeoutSecs=...&limit=...` (multi-task event feed; blocks server-side until an event arrives or the window elapses)
- `POST /v1/tasks`
- `POST /v1/tasks/{task_id}/input`
- `POST /v1/tasks/{task_id}/actions/complete-stage`
- `POST /v1/tasks/{task_id}/actions/request-revision`
- `POST /v1/tasks/{task_id}/actions/close`
- `POST /v1/tasks/{task_id}/actions/advance-stage`
- `POST /v1/tasks/{task_id}/actions/rerun-stage`
- `POST /v1/tasks/{task_id}/actions/run-merge-agent`
- `POST /v1/tasks/{task_id}/actions/set-notify`
- `POST /v1/pairing/sessions`

## Agent Definition Discovery

`GET /v1/repos/{repo_id}/agents` and the catalog-backed
`kanna_list_agents` tool list the definitions that the `agent` field of task
creation can run. Names are invokable directory selectors. Descriptions,
default providers, and default models come from the fully resolved definition:
a repo `AGENT.md` wins over a built-in of the same name, then the repo's
`EXTEND.md` is layered on top. `source` is `built_in`, `repo_override`, or
`repo_authored`; extending a built-in counts as a repo override because the
definition that runs is repo-modified.

Task creation uses that same resolution path for any agent role, not only
specialty reviewers. An explicit request provider wins, followed by the
definition's provider candidates, then the configured user default when the
definition declares none. Role-specific agents can still fail their own
preconditions—for example, `pr` needs committed task work to publish—but Kanna
does not reject them as first-stage bindings.

## Task Event Feed

`GET /v1/task-events` is the surface an orchestrating agent watches instead of
polling each child. It is cursor-based, not snapshot-diffed:

- The cursor is `task_event.seq` (`INTEGER PRIMARY KEY AUTOINCREMENT`). SQLite
  allows one writer at a time, so a `seq` cannot be committed out of order and
  `seq > cursor` can never skip an event. Callers pass back the cursor they were
  given; events that fire between two calls arrive on the next one.
- Omitting the cursor returns the scope's retained history (14 days), so a
  watcher that starts after its children does not lose their early events.
- Events are appended by the same DB writes that change the state they describe
  (`pipeline_item`, `stage_run`), inside the caller's transaction where there is
  one — the log cannot drift from the state.
- The wait blocks inside the server, bounded by
  `kanna_tool_catalog::MAX_WAIT_TIMEOUT_SECS`, so `kanna-mcp` and `kanna-cli`
  each issue one plain GET and neither owns a polling loop.
- `task.awaiting_input` comes from the daemon's `Waiting` session status, which
  is a positive match on a prompt the agent CLI rendered. It is deliberately
  never inferred from a session going quiet; see
  [2026-07-29-awaiting-input-detection-e2e-gap.md](2026-07-29-awaiting-input-detection-e2e-gap.md).

Three scopes, in precedence order: `taskIds`, then `parentTaskId`, then
`repoId`. `parentTaskId` exists because the other two do not cover a fan-out
that lost the ids it created — an id list dies with the context that held it,
and a repo scope hands the caller every other task's events to filter.
It is evaluated per query against `pipeline_item.parent_task_id`, not
snapshotted, so a task adopted mid-watch is in scope on the very next call. It
covers direct children only and excludes the parent's own events, which makes it
exactly the set `GET /v1/tasks/{task_id}` reports as `childTaskIds`.

## Task Parentage

`pipeline_item.parent_task_id` is read from both ends: `GET /v1/tasks/{task_id}`
returns `parentTaskId` upward and `childTaskIds` downward. `childTaskIds` lists
direct children oldest first and **includes closed ones** — parentage is
durable, and a finished child is exactly what a fan-out orchestrator reconciles,
so an empty list means "nothing was dispatched" rather than "everything already
finished". This is deliberately unlike `GET /v1/tasks/search` and
`GET /v1/repos/{repo_id}/tasks`, which list open tasks only.

## Activity Confirmation in `kanna-mcp`

`pipeline_item.activity` is written from the daemon's per-frame verdict, and
that classifier is stateless: `claude_status_from_lines` decides Busy from the
literal "esc to interrupt" marker being present in the frame it was handed, with
no hysteresis and no minimum dwell. A frame captured mid-redraw can lose the
marker, fall through to the trailing-prompt test, and classify a mid-turn agent
as idle — which the server correctly stores, because `activity` records the
latest verdict rather than judging it. An orchestrator polling `activity` to
decide whether a child stopped can therefore read a stop that never happened.

`kanna-mcp` smooths that at the point of consumption, asymmetrically:

- A response with nothing stopped-looking in it is returned as-is. Reporting
  busy promptly is never the misread being guarded against.
- A stopped-looking response is re-read once after `ACTIVITY_CONFIRM_DELAY`
  (1s, two daemon detection windows), and the fresher response is what the
  caller sees.
- The confirmation reports whatever it finds and never rewrites one activity
  value into another, so the three-way vocabulary is unchanged and `unread`
  keeps meaning "output nobody has read yet" rather than "stopped" — a busy
  agent can carry `unread`.
- A closed task is exempt: closure is a database fact, not a frame
  classification.
- **A failed confirmation is not a confirmation.** If the re-read fails, the
  tool call fails with a message saying the stop went unconfirmed. Returning the
  unconfirmed first sample instead would surface the exact false stop this
  exists to suppress, and `kanna_wait_task` would resolve on it.
- It smooths Busy/Idle only. `waiting` stays a positive match on prompt chrome
  in the daemon; nothing here turns quiet into blocked.

Which tools pay, and how much — the cost is always one extra `GET` of the same
route plus 1s, never one request per task:

| Tool | When the confirmation fires |
|---|---|
| `kanna_get_task` | Only when that task already looked stopped. |
| `kanna_wait_task` | Once per candidate stop, before resolving `until: finished`. Its deadline can overshoot by up to 1s, inside the 60s of headroom between `MAX_WAIT_TIMEOUT_SECS` and `CLIENT_TOOL_CALL_BUDGET_SECS`. |
| `kanna_list_recent_tasks`, `kanna_search_tasks`, `kanna_list_repo_tasks` | Whenever **any** task in the response looks stopped. For a repo listing that is the common case, so budget these at roughly +1s per call regardless of how many tasks come back. |

The event feed is not debounced: events are appended by the writes that change
the state they describe, and suppressing one would drop it rather than delay it.
`kanna-cli` does not confirm either — it is the shell interface, where a human
reads the value in context.

## Dynamic Pipeline Changes

`POST /v1/tasks/{task_id}/actions/set-pipeline` and
`kanna_set_task_pipeline` replace an open task's current pipeline name and
`pipeline_def` snapshot atomically. Resolution and serialization use the same
pinning path as task creation, including repo overrides, legacy snapshot
normalization, and retired built-in aliases (`default` resolves to
`no-review` unless the repo still defines `default.json`).

Stage mapping is deliberately strict: the new definition must contain a stage
whose name exactly matches the task's current stage. The task stays at that
stage. If it is absent, the request returns `409 Conflict`, names the
incompatible stage and pipeline, and changes nothing. Kanna does not guess a
nearest stage because that could silently skip or repeat work.

A running `stage_run`, terminal session, branch, and worktree are not replaced
or killed. The live run finishes normally, and the new snapshot governs its
next transition. `revision_rounds` also remains unchanged; switching to a
higher `revision_limit` can therefore make more rounds available, while
switching to an equal or lower limit cannot reset spent rounds. A successful
change emits `task.pipeline_changed` with the old and new names, current stage,
spent rounds, and new limit.

## Sticky Pipeline Selection

`GET /v1/repos/{repo_id}/recent-pipelines` backs the New Task modal's default
pipeline: a repo's most recently used pipeline outranks the one its
`.kanna/config.json` configures. The caller keeps the first returned name its
repo still offers and otherwise falls back to the configured default, so a
renamed or deleted pipeline degrades instead of sticking.

It is a projection of the durable `pipeline_item.initial_pipeline` values, not
a mutable preference. That column captures the successfully created task's
choice and is intentionally not changed by dynamic re-pipelining:

- **No `closed_at` filter.** `db::snapshot` excludes closed tasks, so a create
  whose response was lost and whose task then closed — possibly from another
  window — would be invisible to a snapshot-based answer. The row is what
  matters, and the row survives the close.
- **No recovery record to reconcile or clear.** A create either commits its task
  row or it does not; there is no second write that can fail on its own and lose
  the choice, and nothing to publish after the fact.
- **Every writer feeds it, every reader agrees.** Any path that creates a task —
  desktop, LAN/mobile, relay — updates it without being instrumented, and all
  windows and restarts read the same rows.
- **Child tasks are excluded** (`parent_task_id IS NULL`). A specialty review a
  review stage dispatched is not a pipeline the operator picked.

## Task Completion Notification

A task with `notify_task_id` set delivers exactly one message into that task's
terminal when it ends:

```
TASK <child-id> DONE [success|failure|closed]: <title>
```

The status vocabulary is closed — three words, matched exactly. The receiving
agent is expected to act on the payload without re-reading task state, which is
the entire point of `notify_task_id`, so the word has to carry the real outcome:

- `success` — the task ended cleanly: it advanced past its final pipeline stage,
  or its session ended with no failing verdict recorded against it.
- `failure` — its terminating `stage_run` reported failure, or the agent process
  itself died (non-zero exit). A verdict of failure wins even when the PTY then
  exits 0, because an agent that reports failure and quits still failed.
- `closed` — the task was closed before finishing its pipeline (sidebar ⇧⌘⌫ or
  `POST /v1/tasks/{task_id}/actions/close`). No verdict was ever reached; this is
  not a failure and must not be diagnosed as one.

The status is derived server-side from the *trigger* plus the task's terminating
run, never from the daemon `Exit` alone: the agent erroring, the task advancing
past its final stage, and a human closing the task all end the same PTY the same
way. Deriving it from the exit code alone is what made every clean completion —
and every direct close — report `DONE [failure]`.

Delivery is claimed once via `pipeline_item.notified_at` and goes through the
same two-step input helper as `POST /v1/tasks/{task_id}/input`. All of it is
server/daemon-side; it must not depend on the desktop event bridge being open.

## Local Consumer Model

The desktop app starts `kanna-server` and supplies its config.
Local mobile development points the React Native client at the LAN URL exposed by `kanna-server`.
Consumers such as `kanna-cli` and `kanna-cli mcp serve` target the same route surface so product behavior stays consistent across clients.
The CLI remains the shell/script interface; MCP is the structured agent-tool interface.

## CLI Task Actions

- `kanna-cli task send-input --task-id <TASK_ID> --message <MESSAGE> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/input` and prints `{ "ok": true }` as JSON.
- `kanna-cli task advance-stage --task-id <TASK_ID> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/actions/advance-stage` and prints the action response as JSON.
- `kanna-cli task resume --task-id <TASK_ID> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/actions/resume`. It resumes a dead latest run's provider conversation when its durable transcript and original worktree pass the shared revision-resume checks; otherwise the replacement run records `resumeFallbackReason`.
- `kanna-cli task rerun-stage --task-id <TASK_ID> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/actions/rerun-stage`. This is always an explicit fresh provider conversation, not recovery.

The provider support and daemon-loss trigger matrix is documented in
[`2026-07-30-session-death-recovery.md`](2026-07-30-session-death-recovery.md).
