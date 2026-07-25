# Revision resume — test coverage note (2026-07-05)

Revisions now resume the target stage's previous provider session by default
(`kanna_request_revision` → kanna-server → daemon respawn with the
provider-native session ID in the previous run's worktree), falling back to a
fresh fork when any precondition fails. Design rationale:
`docs/2026-07-04-revision-context-resurrection-analysis.md` and
`docs/superpowers/specs/2026-07-23-provider-neutral-revision-resume-design.md`.

## What is covered

Server-boundary tests in `crates/kanna-server/src/task_creator/tests/revision.rs`
drive the real preparation + spawn path against a fake daemon socket and a
real git repo with real worktrees:

- `request_revision_resumes_previous_stage_run_session_in_its_worktree`,
  `request_revision_resumes_supported_provider_sessions_in_their_worktree`,
  and `request_revision_resumes_supported_headless_provider_sessions` assert
  the provider-native daemon spawn, previous worktree cwd, composed revision
  message, and DB effects. The new `stage_run` carries
  `provider_session_id`/`cwd`/`resumed_from_run_id`, and
  `pipeline_item.agent_session_id` remains in step.
- `request_revision_falls_back_to_fork_when_worktree_tip_diverged` and
  `request_revision_falls_back_to_fork_without_cli_transcript` — assert the
  recorded fallback: fresh fork, `--session-id` (not `--resume`), and the
  composed prompt still carrying the original task prompt.
- `http_api::tests::revision_status` covers the HTTP →
  `execute_stage_transition_detached` wiring end to end against the fake
  daemon, including the composed fresh-path prompt.

Desktop-side recording of the initial run (the resume source for a task's
first revision cycle) is covered by type-checked wiring plus
stage-run persistence and daemon-event tests.

`apps/desktop/tests/e2e/mock/stage-advance.test.ts` now also drives the
successful review → in-progress interaction through the running app,
app-owned kanna-server, real daemon protocol, real git worktrees, and a
deterministic fake Codex executable. It asserts the durable task id, restored
prior branch/worktree, `codex resume` argv, provider handle, and
`resumed_from_run_id`. The neighboring test retains the numbered-workspace
fallback contract.

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

## Live provider resume contracts (2026-07-23)

`tests/cli-contract/tests/live/provider-resume.test.ts` starts two real CLI
processes per provider. The first turn stores a random nonce in a persisted
conversation; the second uses the provider's native session ID and must return
that nonce. This directly exercises Claude `--resume`, Codex's production PTY
`codex resume` command,
OpenCode `run --session`, Copilot `--resume=`, and Antigravity
`--conversation`.

On 2026-07-23 the installed Claude, Codex, Copilot, and Antigravity CLIs passed.
OpenCode was explicitly skipped because `opencode auth list` showed no
authenticated OpenCode provider; its CLI otherwise exits zero after emitting
only `step_start`, which is not counted as a successful turn. Run
`pnpm test:agent-cli-compat` after authenticating OpenCode to complete that
provider's live gate.

## What is not covered end to end, and why

The remaining packaged-app gap is a single test that creates a task and drives
two real provider completions before revision. The WebDriver harness has no
deterministic provider-response fixture at the CLI protocol boundary, so that
scenario still requires credentials, quota, and nondeterministic model
behavior. Add it when the packaged harness can inject/replay provider protocol
responses (including a stable provider session id) without contacting an
external model. Until then, the app/server/daemon fake-provider interaction
above covers the full Kanna resume journey, and the quota-gated live matrix
independently covers each real provider's persistence contract.
