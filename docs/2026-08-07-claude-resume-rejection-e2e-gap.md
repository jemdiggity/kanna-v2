# Rejected Claude resume recovery: what is not covered end to end

**Date:** 2026-08-07
**Area:** `kanna-server` resume recovery (`http_api/resume_recovery.rs`,
`task_creator::stages::prepare_stage_restart`)

## What landed

A Claude resume can fail in two places. Kanna already handled the first: the
preflight in `task_creator::resume` looks for the transcript and, when it is
absent, prepares a fresh conversation and records why on the replacement run.
The second place is the CLI itself — `claude --resume <id>` starts, reads its
own store, prints `No conversation found with session ID: …` and exits. To the
daemon that is indistinguishable from an agent dying, so the run was recorded
failed, a completion notification fired, and the task was left with a dead
session and a transcript that will never come back (the 2026-08-06 incident,
where `CLAUDE_CODE_CHILD_SESSION=1` had disabled transcript saving for two
externally SIGTERMed tasks).

`recover_rejected_claude_resume` now classifies exactly that case from the
exited session's terminal output and relaunches the same stage, in the same
worktree, once, without `--resume`.

## Tests that exist

`crates/kanna-server/src/task_creator/tests/recovery.rs`:

- `rejected_claude_resume_relaunches_the_stage_with_a_fresh_conversation` —
  drives the real server path (`handle_task_terminal_state` → classifier →
  `prepare_fresh_restart_after_rejected_resume` → `spawn_prepared_stage_run_for_api`)
  against a fake daemon that serves the rejection screen as a `Snapshot` and
  then *executes the spawned command line* through a stub `claude`. Asserts no
  `--resume`, the model override survives, the revision feedback survives, the
  fallback reason lands on the run, no completion notification fires, and a
  second identical exit is not retried again.
- `failed_fresh_relaunch_reports_the_original_agent_failure` — the daemon
  refuses the replacement spawn; the exit is reported as `DONE [failure]`.
- `ordinary_agent_failure_in_a_resumed_run_is_not_retried_fresh` — a resumed
  run that dies without the rejection wording keeps the interrupted-session
  reporting.
- `resume_fallback_records_why_the_provider_context_was_not_restored` and
  `killed_task_resume_restores_the_provider_transcript_context` cover the
  preflight fallback and the successful resume, including model propagation.

## The gap

Nothing in CI runs the **real** Claude CLI against a missing session. Two
consequences:

1. **The rejection wording is a fixture, not an observation.** The classifier
   matches a small list of phrases (`CLAUDE_RESUME_REJECTION_MARKERS`). If the
   CLI reworded its error, every test above would still pass while production
   silently stopped recovering — the failure mode would be the pre-fix
   behaviour (task parked as failed), not a wrong retry.
2. **The daemon's terminal snapshot of a just-exited session is faked.** The
   tests answer `Command::Snapshot` themselves; they do not prove the real
   daemon still serves a snapshot for a session that has already exited, only
   that the server asks for one.

## What would make it testable

A live-CLI lifecycle test would need a provider whose session store can be
emptied deterministically and which is legitimate to drive programmatically —
the same constraint recorded for other live-agent tests, which use `opencode`
free models rather than Claude. Two paths, neither taken here:

- Extend the runtime fallback beyond Claude (explicitly out of scope for this
  change) and cover it with an `opencode` lifecycle test that deletes the
  session row before the resume.
- Add a daemon-level test that spawns a trivial process, lets it exit, and
  asserts `Command::Snapshot` still returns its output. That would close (2)
  without touching any provider CLI, and is the cheaper of the two.

Until then, treat `CLAUDE_RESUME_REJECTION_MARKERS` as a contract with an
external tool: when Claude CLI upgrades change resume error text, this list is
what needs updating.
