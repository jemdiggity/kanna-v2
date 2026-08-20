# Revision fork lineage: what the real E2E suite cannot drive yet

Date: 2026-08-21
Related: `docs/task-specs/48a0da30.md`,
`crates/kanna-server/src/task_creator/work_tip.rs`,
`apps/desktop/tests/e2e/real/stage-workflow.test.ts`

## Why this note exists

Task `7a38cc18` burned three revision rounds without converging: each review
fork was cut from a base that predated the previous round's commit, so every
reviewer re-raised the identical finding. The fix makes every stage fork cut
from the task's latest committed tip across all of its workspaces, and moves
`pipeline_item.branch` onto the branch holding it.

The forward half of that boundary is already proven end to end.
`apps/desktop/tests/e2e/real/stage-workflow.test.ts` runs a real desktop, real
server, real daemon and real git through `in progress → commit → review → pr`
and asserts that the commit made in one stage's fork is readable in the final
stage's worktree. What has no real-E2E coverage is the **backward** half: the
revision loop that returns a task to an earlier stage and then forks forward
again, round after round.

## What blocks it

1. **Rounds cost live agent time.** The existing stage-workflow E2E already
   takes ~240 s for two auto transitions against OpenCode's free model. A
   faithful reproduction needs at least two review→revision→commit→review
   cycles — six more live stage runs — and the harness has no way to shorten a
   live stage.
2. **The interesting shape depends on an agent going off-worktree.** The
   observed defect needed the revision agent, whose PTY cwd was the resumed
   implement worktree, to work and commit in the reviewer's worktree instead. A
   scripted agent can be told to do that, but pinning a *live* agent's choice of
   directory is not a behaviour the suite can assert; scripting it makes the
   test a fixture exercise wearing an E2E's cost.
3. **`request_revision` has no real-E2E driver.** The real tier reaches stage
   advance through the ⌘S shortcut helper; there is no equivalent for a review
   agent's revision request, so the loop would have to be driven through raw
   `tauriInvoke` calls, which is the integration layer with a desktop attached.

## What would make it testable

A real-E2E fixture agent whose stage runs complete in seconds without a model
call — the same idea as the mock tier's scripted completions, but spawned
through the real daemon so the fork/worktree/DB path stays real. With that, a
revision-loop file could run three rounds inside the current per-file budget.
It belongs with the next rework of the real-tier fixture agents rather than
riding along with this fix.

## What covers it meanwhile

`crates/kanna-server/src/task_creator/tests/work_tip.rs` — real git repositories
and worktrees, the real transition and revision preparation code, and a fake
daemon socket. They differ from an E2E in that the daemon and the agent are
simulated; every git operation, worktree fork and DB write is real.

| Test | Pins |
|---|---|
| `each_review_fork_carries_every_previous_revision_round_commit` | two full rounds of review-fail → revision → commit → review-fork; each fork contains every commit landed so far |
| `resumed_revision_committing_in_another_workspace_reconciles_the_task_branch` | the exact `7a38cc18` shape: a resumed revision rewinds the branch field, the commit lands in the reviewer's workspace, and the next fork still carries it |
| `diverged_sibling_workspaces_leave_the_task_branch_alone` | siblings that each hold work the other lacks are reported, not guessed between |
| `a_renamed_branch_in_the_same_workspace_is_not_a_reconcile` | the PR agent's `git branch -m` is not a workspace move |
| `equal_tips_keep_the_task_on_its_own_branch` | the ordinary post-fork state is a no-op |

What these cannot prove, and what the E2E above would: that a live agent
session ended by a real revision request, in a real worktree, leaves the task on
the branch the next real fork reads.
