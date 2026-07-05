# Revision resume — test coverage note (2026-07-05)

Revisions now resume the target stage's previous Claude agent session by
default (`kanna_request_revision` → kanna-server → daemon PTY respawn with
`--resume <session-id>` in the previous run's worktree), falling back to the
fresh fork when any precondition fails. Design rationale:
`docs/2026-07-04-revision-context-resurrection-analysis.md`.

## What is covered

Server-boundary tests in `crates/kanna-server/src/task_creator/tests/revision.rs`
drive the real preparation + spawn path against a fake daemon socket and a
real git repo with real worktrees:

- `request_revision_resumes_previous_stage_run_session_in_its_worktree` —
  asserts the exact daemon `Spawn` command (`--resume '<uuid>'`, no
  `--session-id`, cwd = the previous run's worktree, composed message with
  original task prompt + reviewer feedback + completion reminder), plus the
  DB effects: branch moved back to the adopted worktree, the new `stage_run`
  row carrying `provider_session_id`/`cwd`/`resumed_from_run_id`, and
  `pipeline_item.agent_session_id` kept in step. The Claude session store is
  pointed at a test directory via `CLAUDE_CONFIG_DIR` (the same variable the
  CLI honors).
- `request_revision_falls_back_to_fork_when_worktree_tip_diverged` and
  `request_revision_falls_back_to_fork_without_cli_transcript` — assert the
  recorded fallback: fresh fork, `--session-id` (not `--resume`), and the
  composed prompt still carrying the original task prompt.
- `http_api::tests::revision_status` covers the HTTP →
  `execute_stage_transition_detached` wiring end to end against the fake
  daemon, including the composed fresh-path prompt.

Desktop-side recording of the initial run (the resume source for a task's
first revision cycle) is covered by type-checked wiring plus
`packages/db` query tests; `agentCommand.ts` already had `--session-id`
assignment coverage.

## Live validation (2026-07-05)

The fallback lane was exercised live in a worktree dev instance with real
OpenCode free-model agents (`opencode/deepseek-v4-flash-free`, PTY): implement
committed, `request-revision` forked from the committed tip, the agent's TUI
showed the composed message verbatim, the run row recorded feedback/cwd with
`resumed_from_run_id` NULL, and two chained revisions accumulated commits
across forks. The live test caught a real engine bug: revisions re-resolved
the provider from the agent def's priority list (an opencode task's revision
spawned codex — which would also have made the Claude resume gate never
pass). Fixed by inheriting the provider: fresh revisions pin the task's
`agent_provider`, resumed revisions pin the resumed run's; regression test
`request_revision_keeps_the_task_provider_over_agent_def_priority`. It also
surfaced that kanna-server logs went to null stdio — the server now logs to
`kanna-server_*.log` in its daemon data dir (flexi_logger, like the daemon),
so the resume/fallback decision line is durably visible.

Not fixed here (pre-existing, observed live): headless (`agent_type:
"agent"`) OpenCode sessions ignore the spawn cwd and run in the daemon's own
working directory.

## What is not covered end to end, and why

A full desktop E2E (create task → real Claude agent implements → review agent
requests revision → resumed agent addresses feedback) requires the packaged
app/WebDriver harness to deterministically drive two real agent completions,
which needs external Claude credentials and nondeterministic agent behavior —
the same limitation recorded for the completion-notify boundary
(`AGENTS.md`, "Server-side completion notify boundary"). When the E2E harness
can deterministically drive agent completion without external credentials,
add: desktop-created task → `kanna_request_revision` → assert the respawned
PTY command contains `--resume` with the session id recorded at creation.
