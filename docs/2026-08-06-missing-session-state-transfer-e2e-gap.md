# Missing session state on transfer — E2E gap

Date: 2026-08-06
Scope: T2 of the task-transfer repair plan (make a missing session artifact a
loud failure on both sides; make `finalizedCleanly` load-bearing).
Related: [2026-08-06-task-transfer-rearchitecture-plan.md](2026-08-06-task-transfer-rearchitecture-plan.md),
[2026-08-06-claude-transcript-transfer-e2e-gap.md](2026-08-06-claude-transcript-transfer-e2e-gap.md)

## What is covered

`apps/desktop/tests/e2e/real/local-transfer-missing-session-state.test.ts` runs
a real two-instance LAN transfer of a Claude PTY task that carries a
`resume_session_id` and has no transcript on disk — the exact shape that shipped
`artifacts: []` in the incident:

- the push fails visibly on the source (an error toast naming the transcript),
- no transfer row for that task reaches a non-failed state, and no artifact-less
  payload is persisted,
- the source task is intact: open, unclosed, still holding its session id,
- the destination has **no** task at all — a fresh-session import here is the
  data loss the whole change exists to prevent.

## What is not covered, and why

**The receiver refusing a crafted artifact-less payload, end to end.** The
receiver-side fence (`importTransferredResumeState` throws
`MissingTransferSessionArtifactError`; `useAppTaskTransfer` marks the transfer
failed through `fail_pending_incoming_transfer` and releases the sidecar
reservation) exists for payloads produced by a *different* build — a source
still running the pre-fix code, which is what the incident's source was. A
two-instance E2E runs the same build on both ends, and that build's source now
refuses to produce such a payload at all, so the receiver arm is unreachable
from a real transfer.

Injecting one is not reachable either: with `local_task_id` still null,
`approveIncomingTransfer` discards the persisted incoming payload and uses the
one it fetches from the source through `finalize_outgoing_transfer`, so a
payload crafted in the receiver's `task_transfer` row is overwritten before the
import reads it. There is no product seam that hands the receiver a payload the
source did not build.

Covered instead, one layer down:

- `apps/desktop/src/stores/kannaTransfer.test.ts` — for claude, copilot and
  codex, an incoming payload with a resume id and no matching artifact is
  refused, and **no** `pipeline_item` row and no `spawn_session` follow.
- `apps/desktop/src/composables/useAppTaskTransfer.test.ts` — that refusal
  drives the live delivery to `failed` with the claim token and releases the
  sidecar reservation, while an ordinary transient import failure stays
  retryable.
- `crates/kanna-server/src/http_api/tests/core_routes.rs` — the new
  `fail-outgoing` route terminalizes only live outgoing rows.

## What would close it

A cross-version transfer fixture: a receiver-side E2E that speaks the sidecar
peer protocol directly (or against a pinned pre-fix source build) so a real
artifact-less payload arrives from outside. That is natural work for Phase 3 of
the plan, where transfer orchestration moves into `kanna-server` and the import
path becomes callable without a live renderer or a live peer.

## Harness note

The real-E2E harness is unreliable on this machine: `waitForApp` times out
against the secondary instance because vite binds `[::1]:<devPort>` only while
the Tauri webview loads `http://localhost:<devPort>`, leaving the window at
`about:blank` before any app JS runs. Across four attempts here, three died
that way during startup and one reached the test body.

**Do not "clean up" between attempts with `pkill -f <component name>`.** Agent
tasks carry their whole prompt in argv, and prompts here routinely name the
components under discussion, so `pkill -f "kanna-desktop"` matches every agent
whose prompt merely mentions it. Doing that during this task killed two
unrelated live tasks and restarted the staging server. The harness prints what
it owns — `Started tmux session 'kanna-e2e-<worktree>-<pid>-<ts>'` and
`daemon_dir=.../.kanna-daemon-e2e/<pid>-<ts>` — so scope teardown to those.
Leaked instances are also the wrong suspect: the startup timeout is the
IPv6-bind bug above, not leftover processes.

That one run is what corrected this file's E2E: it failed on
`SELECT ... transfer_status FROM pipeline_item`, because `transfer_status` is
JOIN-derived in the snapshot query (`db/snapshot.rs`) and not a column on
`pipeline_item`. The test now reads the `task_transfer` rows for that half.
Assertions edited after that run — the settle-then-seed ordering around the
spawned session's own `agent_session_id`, and the live-transfer filter — have
not themselves been through a green run.
