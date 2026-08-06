# Claude transcript transfer — E2E gap

Date: 2026-08-06
Scope: T1 of the task-transfer repair plan (ship the Claude transcript as a
transfer artifact and re-key it on the receiver).

## What is covered

`apps/desktop/tests/e2e/real/local-transfer-claude-transcript.test.ts` runs a
real two-instance LAN transfer and asserts **conversation continuity**, not
transfer completion:

- the outgoing payload carries a `session-transcript` artifact even when the
  `~/.claude/tasks/<id>` session archive is absent — the exact shape that used
  to ship `artifacts: []` beside a valid `resume_session_id`;
- the destination transcript exists under the **destination** slug, derived by
  the receiver from its own worktree path, and byte-matches the source;
- the destination task keeps the source session id (`pipeline_item
  .agent_session_id` and the terminating `stage_run.provider_session_id`),
  keyed to the destination worktree (`stage_run.cwd`) — no fresh session;
- the live source transcript is staged in place and never consumed.

The Rust fence (`transfer_artifact.rs`) has unit coverage for the slug
derivation, the receiver-computed destination, the `<uuid>.jsonl` filename
match, symlinked-slug rejection, and destination exclusivity. The renderer's
spawn argv (`--resume <session-id>`) is asserted in
`apps/desktop/src/stores/kannaTransfer.test.ts`.

## What is not covered, and why

**A live Claude agent on both ends.** The end the test cannot reach is the
last one: that the Claude CLI, resumed on the destination, actually renders the
source conversation. That needs a real authenticated Claude PTY session on the
source machine, driven to produce a genuine transcript, and a second one on the
destination — which the E2E harness must not do (the repo's live-agent E2Es use
OpenCode free models for exactly this reason). The test therefore plants a
synthetic transcript at the source slug and asserts Kanna's half of the
contract: locate, ship, re-key, resume the same id.

**Consequence:** if Claude changes where or how it stores transcripts, this
test keeps passing while real transfers silently lose history again — the same
failure mode as the original bug.

## What would close it

Task T4 of the plan: live CLI contract tests under
`tests/cli-contract/tests/live/` (gated on
`KANNA_RUN_LIVE_AGENT_CLI_CONTRACTS=1`, run via `pnpm test:agent-cli-compat`)
pinning the transcript location and slug algorithm, transcript append-while-
running, and `--resume` behaviour when the transcript's recorded `cwd` differs
from the current one. That suite is the canary for the day a provider moves its
layout; this E2E is the wiring check underneath it.

The slug algorithm shipped here was pinned empirically rather than guessed:
across 481 real transcripts under `~/.claude/projects/`, every transcript's
recorded `cwd` matched its directory name under
`[^A-Za-z0-9] → '-'`, including `/`, `.` and `_`.
