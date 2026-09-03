# Task a08c6fab: resume provider sessions after daemon death

## Goal

When a running PTY task loses its daemon and Kanna restarts, recover the provider conversation instead of silently replaying the original prompt into a fresh session.

## Scope

- Trace the staging incident for Codex task `2967f435` across desktop, server, daemon, persisted run metadata, and provider session storage.
- Route restart-time recovery through the same provider-aware resume rules used by explicit recovery: Codex and OpenCode may discover a cwd-matching session when no ID was recorded; Claude and Copilot use their recorded IDs.
- Record `resumedFromRunId` for a real resume, or an exact `resumeFallbackReason` whenever restart recovery must start fresh.
- Verify Codex and Claude behavior across daemon death/restart with boundary-level coverage. If a true provider-backed E2E cannot be made deterministic in this task, add the required dated E2E-gap note and narrower automated coverage.

## Constraints

- Preserve daemon handoff/reconnect behavior; hard daemon death is the recovery case.
- Do not silently replay an initial prompt after failed provider recovery.
- Keep changes limited to the restart/recovery path and its durable observability.
- Run relevant tests and `./kd test all` before completion.

## Done

After daemon death, restart resumes a running PTY Codex conversation when its session can be resolved, and otherwise records the precise failed precondition on the run. Claude follows the same restart recovery path and is covered by tests. Any unresolved Claude interactive resume-dialog behavior is documented here as an explicit follow-up.

## Incident finding and implementation

The 2026-09-03 staging incident was the desktop attach-error recovery path, not
server startup reconciliation. At 07:57:37 local time the desktop spawned the
stage's initial Codex command after restoring scrollback; the later 07:59
daemon handoff transferred that already-fresh process. The interrupted Codex
rollout `01a065f4-0664-7472-8e46-86ad24ca65f6` had a `session_meta.cwd` exactly
matching task `2967f435`'s worktree, so the server's existing hard-death lookup
could have resumed it. The desktop bypassed that lookup and created rollout
`01a0678f-9fec-77c3-9718-2360b01d1cb4`; because it also reused the existing
stage run, neither resume metadata field changed.

Attach recovery now calls the server's provider-aware resume action. For a
latest `running` run, the server first proves the recorded daemon session is
absent, durably finishes the dead run, and then applies the same transcript,
cwd, worktree, and committed-tip checks as explicit recovery. The replacement
run therefore records `resumedFromRunId` only for a real resume, or the exact
`resumeFallbackReason` before any fresh conversation receives the prompt.

## Claude resume dialog follow-up

The installed Claude CLI 2.1.259 exposes no documented flag that bypasses its
old-session usage warning while retaining PTY resume. Kanna must not
automatically accept a provider usage/cost decision on the operator's behalf,
so this task keeps `claude --resume <id>` unchanged. The daemon already
classifies that positive dialog as `waiting`, which produces the separate
`task.awaiting_input` signal and prompt snippet. If Claude later adds a
supported non-interactive resume policy, or Kanna adds an explicit operator
preference for this warning, adopting it is follow-up work outside this
restart-path fix.
