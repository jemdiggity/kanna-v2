# Session death recovery

Kanna distinguishes an explicit stage restart from recovery:

- `kanna_rerun_stage` always starts a fresh provider conversation in the
  current worktree.
- `kanna_resume_task` is for a latest `cancelled` or `failed` run whose daemon
  session is dead. It starts the same stage in the same worktree and prefers
  the previous provider conversation.

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
