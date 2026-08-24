# Task-session repository watch E2E gap (2026-08-25)

Repository inference now crosses the CLI/MCP adapter, task-detail HTTP read, shared catalog resolution, and task-event server route. The repository currently has no integration harness that seeds a task/repository in a real `kanna-server`, launches both thin clients with `KANNA_TASK_ID`, and drives their catalog calls against that process.

This change instead covers each wire boundary narrowly: CLI and MCP process/HTTP tests assert the task-detail lookup and inferred request, catalog tests pin shared scope precedence and the new parameter, and server route tests pin tail-start, retained-history replay, level-triggered current state, and pages above 100 rows.

Close this gap by adding a reusable agent-client harness that starts a seeded real server and invokes both the `kanna-mcp` stdio process and `kanna-cli tool call` against its advertised URL. The E2E should open `kanna_wait_events { from: "now", include_current_activity: true }` without `repo_id`, prove an existing settled task is reconciled, create another task in the same repo, and prove its next event arrives through the original repository cursor.
