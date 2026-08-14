# Conflict-aware blocker integration — E2E note

## What changed

When a dormant dependent becomes unblocked by multiple same-repo blocker
branches, Kanna still tries the direct in-engine merge first. If that merge is
clean, the dependent starts exactly as before: based on the first blocker
branch, with the remaining blocker branches merged into its worktree before the
agent starts.

If a remaining blocker branch conflicts, Kanna now aborts the merge, removes the
dependent's prepared worktree and branch, and creates an integration task
instead. The integration task:

- starts from the first blocker branch,
- asks the inherited agent provider to merge the remaining blocker branches,
  resolve conflicts preserving both sides' intent, run checks, and commit,
- uses a one-stage auto workflow with a `commit` post, so successful completion
  closes the integration task without creating a PR, and
- replaces the dependent's blocker rows, leaving the dependent dormant and
  blocked only on the integration task.

When the integration task closes, the existing blocker-close path starts the
dependent from the integration task's reconciled branch. Integration tasks have
no blockers of their own, so they do not recursively trigger integration-task
creation.

## E2E status

Server-boundary coverage in
`crates/kanna-server/src/http_api/tests/actions.rs` uses real git repositories
and a fake daemon:

- conflicting sibling blockers create and spawn an integration task, re-point
  the dependent's blockers, and leave no dependent worktree or branch debris;
- closing the integration task starts the dependent from the reconciled
  integration branch;
- non-conflicting multi-blocker merges keep the existing direct-start behavior.

A full desktop E2E still needs deterministic agent conflict resolution under a
running app: two sibling blocker tasks close, the inserted integration task's
real agent resolves conflicts and commits, then the dependent visibly starts
after the integration task closes. That remains outside the current automated
surface for the same reason as the optimistic-unblock note: it requires a
packaged app plus controllable agent-stage completion without external account
dependencies.
