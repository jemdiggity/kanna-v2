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
- `GET /v1/tasks/recent`
- `GET /v1/tasks/search?query=...`
- `GET /v1/task-events?taskIds=...|repoId=...&cursor=...&timeoutSecs=...&limit=...` (multi-task event feed; blocks server-side until an event arrives or the window elapses)
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
