# Optimistic blocker resolution — semantics and E2E note

## What changed

Blocked tasks no longer wait for the human review/merge loop. A blocker
resolves when either:

- it **closed** (previous behavior), or
- it is **parked at the `pr` stage with a PR created** — the pr-stage agent
  has committed, review-passed, rebased, renamed, and pushed the branch and
  signaled completion via `kanna-cli stage-complete` / `kanna-mcp`. That is
  the earliest point the branch is stable enough for dependents to stack on
  (forking before the pr agent's rebase/rename would build on commits that
  get rewritten).

The predicate lives in three places that must stay in sync (a known
migration-plan bucket-1 tax until Phase 2 collapses the frontend copy):

- `count_open_task_blockers` — crates/kanna-server/src/db/blockers.rs (SQL)
- `isBlockerResolved` + `getUnblockedItems` — packages/db/src/queries.ts
- consumers: sidebar blocked section (`sidebarOrdering.ts`), MainPanel
  blocked placeholder, task navigation, `checkUnblocked`

Trigger: `complete_stage` success that parks a task at a manual-transition
`pr` stage with a `pr_url` now runs the same dependent-start path as close
(`unblock_dependents_of_pr_resolved_blocker` in http_api/task_actions.rs):
dormant dependents whose blockers are all resolved start immediately, based
on the blocker's worktree-HEAD-resolved branch; dependents with a live
workspace get a session message ("opened a PR awaiting human review", with
the resolved branch and PR URL). When the blocker later merges and closes,
the close path delivers the "closed" variant as a catch-up — the wording is
selected by an explicit `BlockerResolution` parameter because the close
paths collect instructions before `closed_at` is written.

A completion without a PR URL (or a failed pr run) resolves nothing; a
revision that moves the blocker's stage back off `pr` un-resolves it for
dependents that have not started yet (the predicate requires
`stage = 'pr'`, not just a non-null `pr_url`).

## E2E status

Server-boundary coverage (real git repo, renamed blocker branch, fake
daemon) in `crates/kanna-server/src/http_api/tests/actions.rs`:

- `complete_pr_stage_with_pr_url_starts_dormant_dependent_optimistically` —
  the pr-stage `stage-complete` signal starts the dormant dependent on the
  renamed branch while the blocker stays open at `pr`.
- `complete_pr_stage_without_pr_url_leaves_dormant_dependent_unstarted` —
  no PR, no resolution.
- Pre-existing close-driven tests keep covering the close trigger and the
  "closed" message variant.
- `count_open_task_blockers_treats_pr_stage_with_pr_url_as_resolved` (db
  unit) pins the SQL predicate, including the revision case.

Frontend coverage (vitest): `isBlockerResolved` unit matrix
(packages/db/src/queries.test.ts), sidebar blocked-section exit
(`sidebarOrdering.test.ts`), and `checkUnblocked` optimistic restore plus
its negative (`taskBlockedActions.test.ts`).

A full desktop E2E (blocker workflow runs to PR under the packaged app →
dependent visibly starts) still needs deterministic agent-stage completion
without external credentials — same gap as
[2026-07-05-blocked-task-unblock-e2e-note.md](2026-07-05-blocked-task-unblock-e2e-note.md).

## Catch-up for already-parked blockers

The trigger is event-driven; a blocker already parked at `pr` with a PR at
upgrade time fires no new `complete_stage`. Two built-in catch-ups: app
start (frontend `getUnblockedItems` uses the new predicate and restores
ready dependents through the blocked-task restore path), or a manual
`unblock` action on the dependent.
