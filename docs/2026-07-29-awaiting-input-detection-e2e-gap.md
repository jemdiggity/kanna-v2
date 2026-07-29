# `task.awaiting_input`: what it detects, and what it cannot

2026-07-29. Written alongside the task event feed (`GET /v1/task-events`,
`kanna_wait_events`).

## Why this event exists

An agent parked on an interactive prompt was invisible to every API surface.
`activity` cannot express it: `activity_for_runtime_status` maps both `idle` and
`waiting` to the same values, because activity answers "does the human need to
look at this" and not "is this task blocked". So a task sitting on an
AskUserQuestion menu looked exactly like a task that had finished talking, and
the only way to find it was to read raw terminal scrollback.

## Where the signal comes from

The daemon already classifies each PTY session as `Busy`, `Waiting`, or `Idle`
(`crates/daemon/src/headless_terminal.rs`). `Waiting` is a **positive match on
chrome the agent CLI rendered** — the permission-prompt wording, or (added with
this change) a caret sitting on a numbered menu option. It is never inferred
from a session going quiet or from elapsed idle time.

`kanna-server` now persists that verdict on `pipeline_item.runtime_status` and
appends `task.awaiting_input` on the edge into `waiting`, once per block.

## The reliability claim, precisely

**False positives are the thing that would make the event worse than useless** —
an orchestrator that abandons a task mid-`cargo build` because the feed called
it blocked is worse off than one that polls. The design forecloses them: a
running build renders `esc to interrupt` (or a subagent footer) and never
matches, and no rule fires on silence. `claude_running_build_output_is_never_waiting`
holds that line.

**False negatives remain.** The detection is still per-provider terminal-byte
matching, so an agent CLI can render a prompt in a shape no rule recognizes and
the task stays silently blocked. Known coverage today:

| Prompt shape | Detected |
|---|---|
| Claude/Codex/Copilot/opencode permission prompt (`do you want to allow`) | yes |
| Claude AskUserQuestion / select menu (caret on a numbered option) | yes (new) |
| Codex/opencode/antigravity select menus that are not permission prompts | no |
| A custom prompt an agent prints itself and waits on | no |
| SDK-mode (`agent_type: agent`) permission requests | yes, structurally — `AgentEvent::PermissionRequest` maps to `Waiting` without any byte matching |

## What would make it fully reliable

Only a structured signal from the agent CLI can close the gap for PTY mode. For
Claude that is the `Notification` hook, which fires when the CLI needs
permission or has been waiting on input; Kanna does not install hooks into task
worktrees today, and doing so is a separate change with its own lifecycle
questions (where the settings file lives, how it survives a stage fork, what
happens when the repo has its own hooks). Until then the byte matching above is
the ceiling, and the table is the honest statement of coverage.

## Test coverage and its limit

Covered by unit and integration tests:

- `crates/daemon/src/headless_terminal.rs` — menu detection, the question
  snippet, and the negative cases (running build, empty input box).
- `crates/kanna-server/src/terminal_watcher.rs` —
  `watcher_records_waiting_status_and_emits_awaiting_input` drives a real daemon
  socket and asserts both the persisted status and the appended event.
- `crates/kanna-server/src/http_api/tests/task_events.rs` —
  `a_task_parked_on_a_prompt_emits_awaiting_input_once_per_block`.

**Not covered end-to-end:** a live Claude CLI actually rendering an
AskUserQuestion menu into a real PTY. The repo's live-agent tests use opencode
free models precisely because driving Claude programmatically is not something
we do, and opencode does not render Claude's menu chrome. The daemon tests
therefore replay captured terminal output rather than producing it. What would
make it testable: a recorded PTY byte stream fixture from a real Claude session
parked on a menu, replayed through `HeadlessTerminal` in a daemon integration
test. That fixture has to be captured by hand from a human's session.
