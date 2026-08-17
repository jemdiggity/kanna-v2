# Live blocked-task unblock context E2E gap (2026-08-17)

`apps/desktop/tests/e2e/real/blocked-resume-agent-submit.test.ts` is
quarantined. On current `origin/main`, clearing the last blocker through
`POST /v1/tasks/{id}/actions/unblock` removes the blocker edge, but a task whose
agent session is already live receives no blocker context. The real OpenCode
session remains active and never sees the file-writing instruction represented
by the resolved blocker.

This is a product defect, not an assertion-only test failure. The server-owned
unblock action in `crates/kanna-server/src/http_api/task_blockers.rs` starts a
dormant task when appropriate, but has no live-session continuation/input step.
Restoring the behavior correctly requires deciding and implementing the
server/daemon contract for composing and delivering resolved-blocker context;
that crosses the task-action, lifecycle, and PTY boundaries and is outside the
desktop E2E rehabilitation task.

The narrower store and HTTP action tests continue to cover blocker-edge removal
and dormant-task startup. Re-enable the real E2E when the server action also
delivers the unblock context to an existing live session; the quarantined test
already asserts that the resulting instruction is submitted without a manual
Enter.
