# Session death recovery

Kanna distinguishes an explicit stage restart from recovery:

- `kanna_rerun_stage` always starts a fresh provider conversation in the
  current worktree.
- `kanna_resume_task` is for a latest `cancelled` or `failed` run whose daemon
  session is dead. It starts the same stage in the same worktree and prefers
  the previous provider conversation. The same action accepts a latest
  `running` run only when daemon `List` proves its recorded session is absent;
  this is how desktop attach recovery closes a run whose daemon died before an
  `Exit` could reach the server.

If the task is not in that resumable state, the action returns an explanatory
conflict rather than treating the task as missing. Provider-context failures
are different: an unsupported provider resume, absent provider id or
transcript, missing worktree, or divergent tip deliberately starts a fresh
conversation and records the reason in `latestRun.resumeFallbackReason`.
Callers that cannot use recovery, or explicitly want a fresh conversation,
should use `kanna_rerun_stage`. An empty 404 from the resume route means the
connected server predates the route; `kanna_info` reports the actual server and
its advertised agent API surface.

Revision resume and death recovery share the same provider, transcript,
worktree, and committed-tip checks. A successful resume records
`stage_run.resumed_from_run_id`. If any check fails, Kanna starts a fresh
conversation and records the exact reason in
`stage_run.resume_fallback_reason`. The task API exposes both fields on
`latestRun`; a fresh spawn is therefore never reported as a resume.

## Provider matrix

| Provider | Native resume | Session reference at spawn | Kanna recovery |
|---|---|---|---|
| Claude | `claude --resume <uuid>` | Kanna assigns `--session-id <uuid>` | PTY runs resume when the cwd-keyed JSONL transcript and original worktree are present. |
| Copilot | `copilot --resume=<id>` | Kanna assigns `--session-id=<id>` | PTY runs resume when the assigned ID exists in Copilot's `data.db`. |
| Codex | `codex resume <uuid> [prompt]` (`--last` also exists) | Codex has no assign-ID flag | PTY runs resume using a footer ID captured on normal exit, or the newest Codex `session_meta` transcript whose cwd matches the run after a hard death. |
| OpenCode | `opencode run --session <id>` (`--continue` also exists) | OpenCode has no assign-ID flag | PTY runs resume using a recorded ID or the newest session in `opencode.db` whose directory matches the run. |
| Antigravity (`agy`) | `agy --conversation <id>` (`--continue` also exists) | The CLI exposes no assign-ID flag or stable conversation-ID capture surface | Recovery is forced fresh and records that reason. |

Headless agent sessions currently use provider adapters rather than the PTY
command path and are forced fresh with a recorded reason. Provider stores are
validated before Kanna invokes a resume command; a missing provider store,
missing worktree, detached worktree, or divergent committed tip also forces a
recorded fresh fallback.

## Detection and default flow

The server's daemon subscriber handles an unexpected provider `Exit`. Before
marking the latest running stage run `cancelled` (exit 0) or `failed`
(non-zero), it persists any provider session ID extracted by the daemon (for
example the Codex resume footer). Orchestrated kills used for stage swaps,
reruns, and close remain excluded.

On every subscriber connection, the server reconciles the daemon's initial
`List` before trusting a cancellation record. If an open task's named session
is still alive, Kanna restores its own interruption marker or a legacy bare
cancellation to `running`; it never reopens a genuine failure verdict. This
repairs misleading restart-time records without spawning anything.

A committed daemon replacement can report a named session that it could not
reconstruct through the existing structured surface:

`AttachSnapshot -> Error { code: "handoff_lost", message: ... }`

The KSP terminal attach path records that running task as interrupted, making
it eligible for the same recovery operation. A successful handoff emits no
loss signal. An ambiguous or unresponsive incumbent also emits no loss signal:
handoff fails closed, the successor exits, and the incumbent remains
authoritative with its sessions.

When requested-ID task creation repairs an existing task whose latest run was
marked `cancelled` or `failed`, it uses the resume preparation path by default.
Both this automatic path and `kanna_resume_task` first issue a daemon `List`.
An absent session permits recovery, an unknown daemon state refuses it, and a
present session prevents a second provider process from being spawned. If the
present session's run was marked by Kanna's own no-verdict interruption path,
or is a legacy bare cancellation with no verdict, Kanna restores that run to
`running`. It does not reopen an agent's genuine failure verdict. The explicit
rerun endpoint retains its fresh-start contract.

The server integration tests execute a fake provider through the daemon
protocol, mark the prior run through the real terminal-state handler, and
require the replacement process to read a value that exists only in the prior
Claude transcript. Separate tests remove the transcript and assert the durable
fallback reason, and prove that a daemon-listed live session restores the
interrupted run without spawning a replacement.

The desktop follows the same boundary. An attach failure with recoverable
scrollback calls `POST /v1/tasks/{task_id}/actions/resume`; it never rebuilds a
provider command or replays the initial prompt itself. For a still-`running`
run, the server proves the recorded daemon session is absent, finishes that
dead run without emitting a transient `task.awaiting_advance`, and passes the
run to the shared provider-aware preparation. The desktop waits until daemon
`List` exposes the detached replacement before reconnecting its terminal.
Consequently, a fresh provider conversation can appear only with
`resumeFallbackReason`, and a genuine provider resume carries
`resumedFromRunId`.

The restart-recovery integration coverage begins with a `running` run and an
absent daemon session. It proves Claude uses its assigned session id, Codex
discovers a cwd-matching rollout when no id was captured, and a missing Codex
rollout produces the exact durable fallback reason. Desktop store coverage
proves attach recovery invokes the server action and cannot invoke its former
local spawn path. The remaining full-process daemon-kill harness gap is tracked
in `docs/2026-09-03-provider-resume-after-daemon-death-e2e-gap.md`.
