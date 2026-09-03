# Task watch self-exclusion E2E gap (2026-09-03)

A repository-scoped `kanna-cli task watch --repo-id` launched from inside a
task session used to wake that session with its own `task.runtime_settled` /
`task.activity_changed` events at the end of every turn (task 7fce7adf on
Kanna 0.3.0-staging.9). The fix crosses four boundaries: the calling process's
`KANNA_TASK_ID`, the shared catalog policy that turns it into
`exclude_task_ids` (`kanna-mcp` and `kanna-cli` both), the `excludeTaskIds`
filter on `GET /v1/task-events` including its aggregate machine legs, and the
agent harness's process-exit wake.

The full loop is not E2E-testable today for the same reason recorded in
[2026-08-26-task-watch-client-server-e2e-gap.md](2026-08-26-task-watch-client-server-e2e-gap.md)
and [2026-08-25-task-session-repo-watch-e2e-gap.md](2026-08-25-task-session-repo-watch-e2e-gap.md):
there is no harness that starts a seeded real `kanna-server`, spawns a task
session whose daemon runtime edges are written by the server's own debounce
loop, launches the real CLI binary with that task's `KANNA_TASK_ID`, and
observes whether the background process exits.

Covered narrowly meanwhile:

- `kanna-server` route tests (`http_api/tests/task_events.rs`) prove the filter
  on the real DB → append → cursor → HTTP wiring for durable and synthetic
  rows, branch-name resolution, unknown ids, cursor continuity across exclusion
  changes, and forwarding to a relay peer in the aggregate wait.
- `kanna-tool-catalog` tests pin the shared self-exclusion policy and that
  `include_self` never reaches the wire.
- `kanna-cli` tests pin the typed policy, the clap surface, typed/catalog query
  parity, that every watch poll carries `excludeTaskIds`, and that
  `kanna-cli tool call kanna_wait_events` from a task session excludes the
  caller.
- `kanna-mcp` stdio tests pin the same default and the `include_self` opt-out
  through the adapter.

Close this gap by extending the agent-client harness proposed in the two
earlier notes: start an isolated server, create a manager task and a sibling
task in one repository, run `kanna-cli task watch --repo-id` from the manager's
session, drive the manager's own runtime busy → idle through the server's
settled-activity debounce, assert the process stays blocked, then settle the
sibling and assert it exits with that task's event and a resumable cursor.
