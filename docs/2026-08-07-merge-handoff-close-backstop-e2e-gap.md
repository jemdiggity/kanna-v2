# Merge handoff on close — E2E gap

Date: 2026-08-07
Scope: making the pr-stage merge-master handoff structural instead of
prompt-dependent.
Related: [specs/merge-master.md](specs/merge-master.md),
[kanna-server-boundary.md](kanna-server-boundary.md)

## The incident this fixes

On 2026-08-07 five tasks in one shepherded session reached the `pr` stage of a
review-bearing workflow (`single-reviewer` / `specialized-reviewers`). In every
one of them the pr stage's **main** run finished in 1–2 seconds with a `NULL`
result and the approve **post** ran immediately afterwards:

```
run-0e282189-…|pr     |main|succeeded|manual|<null>            |01:25:46|01:25:48
run-0e282189-…|approve|post|succeeded|auto  |{"…pr_url":"…1015"}|01:25:48|01:27:50
```

`dispatch_prepared_post_for_api` closes the stage's running main run as
`succeeded` with no result when it injects the post, so that pattern is the
signature of an advance arriving while the pr agent was still starting up. The
post message therefore landed in a **pr** agent that had not created the PR yet
— visible in the `run.started` payload, which records `"agent":"pr"` for the
approve post because a post inherits whatever agent the live session is running.
That agent read the post prompt as its next instruction, created the PR,
reported `Created PR https://…`, and never approved or signalled. Each task then
closed, and each PR sat unmerged until the operator called
`kanna_signal_merge_handoff` by hand. The `no-review` control task the same day
(6d1be758, PR #1012) worked, because there the pr agent had finished and was
idle when the post arrived.

The prompt was never the guarantee. A post is delivered into a session the
engine does not control the state of, so the handoff had to move to the engine.

## What the change is

- `pipeline_item.merge_signaled_at` (migration `048`) is stamped **after** a
  merge request reaches the repo's merge agent, alongside a `task.merge_signaled`
  event carrying `source: "agent" | "engine"`. It is one timestamp, not the
  delivery-binding table migration `047` deleted: Kanna still attests nothing
  about the merge itself.
- `close_task_after_final_stage` calls `ensure_merge_handoff_before_close`
  first. When the task's pinned current stage declares the merge-signaling
  `approve` post and the task still owes a request, the engine composes and
  sends the identical `MERGE … [PR …]` line from the recorded `pr_url`, the
  workspace's live branch (the pr agent renames what it pushes), and the repo's
  default branch. The merge agent resolves the live PR and applies repo policy,
  exactly as for an agent-sent request.
- If such a stage finishes with no `pr_url` at all, the close is **refused**:
  the task stays open at its final stage, goes `unread`, and emits
  `task.merge_handoff_missing`. A promised handoff with nothing to hand off is a
  failed approval, not a finished workflow.
- Workflows whose final stage declares no `approve` post promise no merge side
  effect and are untouched.

## What is covered, and where

`crates/kanna-server/src/http_api/tests/input.rs`, module
`merge_handoff_on_close`. These drive the real `complete-stage` and
`advance-stage` routes, the real close path, and a real daemon Unix socket with
a resident merge singleton — not the derivation in isolation:

- `engine_signals_the_merge_master_when_the_approve_post_did_not` — the
  incident, reproduced: review-bearing pinned workflow, approve post reports
  `Created PR …` and signals nothing. The merge session receives exactly one
  `MERGE … [TASK …] [PR …]` line, the task closes, and the event records
  `source: engine`.
- `a_post_that_signalled_for_itself_is_not_signalled_again` — the `no-review`
  control: the post signals through the route first, and closing sends nothing
  further. One line total, `source: agent`.
- `a_workflow_without_the_approve_post_closes_without_signalling` — a final
  stage with no post closes silently, with `merge_signaled_at` still null.
- `a_promised_handoff_with_no_pr_refuses_to_close_the_task` — the task stays
  open at `pr`, `unread`, with `task.merge_handoff_missing` on the feed and no
  merge input sent.

## What is not covered, and why

**A live workflow walking implement → review → pr → approve with real agent
CLIs.** The failure needed a real agent to be mid-turn when the post arrived,
which is a property of the agent process, not of anything the harness can
schedule. The desktop E2E suites (`apps/desktop/tests/e2e/{mock,real}`) can seed
the *state* the post completes into — that is exactly what the integration tests
above do, over the same routes — but they cannot reproduce the timing that
produced it, and the assertion that matters (the merge singleton received the
PR without operator intervention) does not depend on that timing.

**No desktop E2E run was attempted here.** This worktree has no Tauri debug
build, and the mock harness has a known unresolved `timed out waiting for app`
failure on this machine (see
[2026-08-06-consecutive-e2e-run-startup-e2e-gap.md](2026-08-06-consecutive-e2e-run-startup-e2e-gap.md)).
Landing a UI-level test that could not be run once would assert less than the
integration tests above, not more.

## What would close it

A mock-suite E2E that seeds a resident merge singleton on a real PTY (the
pattern in `apps/desktop/tests/e2e/real/approval-native-control.test.ts`), seeds
a source task parked at `pr` with a review-bearing pinned `pipeline_def` and a
running approve post, completes that post through the normal desktop path, and
asserts the merge session's terminal buffer contains the `MERGE … [PR …]` line
and the source task closed. That is writable today against the existing helpers;
it needs a machine where the mock harness starts reliably.

## The root cause left standing

The engine backstop makes the handoff unconditional, but it does not fix why the
pr stage's main prompt was discarded. `prepare_advance_stage_for_api` refuses to
dispatch a post while a *post* is running, and has no equivalent guard for a
main run that is still working: any advance at a stage with a post converts that
in-flight main run into `succeeded`/no-result and injects the post prompt into an
agent mid-turn. That is correct for the nudge-and-advance flow an idle agent is
meant to be moved along with, and wrong for an agent that started seconds ago.
Distinguishing the two needs the daemon's session status at the advance, which is
a change to advance semantics and belongs to its own task.
