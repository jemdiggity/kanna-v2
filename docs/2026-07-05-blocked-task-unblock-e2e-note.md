# Blocked-task unblock: branch handoff and dormant-task survival — E2E note

## What changed

Closing a blocker must hand its *current* branch to dependents — the PR
stage usually renames the branch (`git branch -m`), so the stored
`pipeline_item.branch` goes stale. Two dependent shapes exist:

1. **Workspace already initialized** (user created the task, then blocked
   it): on blocker close at the `pr` stage, kanna-server now injects a
   session message naming the branch resolved from the blocker's worktree
   HEAD (plus PR URL), replacing the old message that falsely claimed the
   branch "has merged" and named the stale fork branch. Delivery failures
   are logged, never fail the close.
2. **Dormant** (agent-created with `blocker_task_ids`, no workspace yet):
   the close-driven start already based the fresh worktree on the resolved
   blocker branch (main); this change makes the start path loud —
   per-dependent error logging instead of a swallowed failure that left
   tasks permanently dormant — and adds bounded retry for transient git
   lock contention in `create_worktree` (the main checkout is shared with
   the frontend's git polling).

Frontend (still the owner of UI-driven close/unblock until the
desktop→kanna-server migration moves those writes):

- The startup "orphaned task" sweep (`stores/init.ts`) now keys on the
  `worktree` DB row instead of deriving a path from the branch name.
  Dormant tasks (branch reserved, workspace never initialized) previously
  matched the missing-directory check and were all closed on every app
  restart.
- `taskBlockedActions.ts` resolves each blocker's live branch via
  `git_current_branch` on the blocker's worktree (same fallback semantics
  as the server's `resolve_current_source_worktree_branch`), uses it in
  both resume/start prompts, and bases a dormant dependent's fresh worktree
  on the first live blocker branch instead of always `origin/<default>`.

## E2E status

Server-boundary coverage is in Rust integration tests with a real git repo
and a fake daemon (`crates/kanna-server/src/http_api/tests/actions.rs`):

- `close_pr_task_sends_blocker_close_instruction_with_renamed_branch_to_running_dependents`
  builds a blocker worktree, renames its branch, and asserts the dependent
  session receives the renamed branch (and not the stale fork name).
- `close_last_blocker_starts_dormant_dependent_from_blocker_branch`
  (pre-existing) covers the dormant fork-from-renamed-branch path.

Frontend coverage is in vitest store tests (`init.test.ts`,
`taskBlockedActions.test.ts`): dormant tasks survive the startup sweep,
initialized-but-missing worktrees still close, and both blocked-task
prompts carry the resolved branch.

A full desktop E2E (create dormant chain → restart the packaged app →
assert survival → close blocker → assert dependent starts on the renamed
branch) is not yet feasible: the WebDriver harness has no app-restart
primitive, and driving a real blocker workflow to close deterministically
requires agent completion without external Claude/Codex credentials. Add
that flow when the E2E harness can restart the app under test and
deterministically complete an agent stage.

## Known remaining gap

The frontend still has its own unblock/spawn duplicate (`checkUnblocked`,
`restoreUnblockedTask`) that can race the server's close-driven start when
a close is initiated from the UI. That duplication is scheduled to be
removed by Phase 2 of the desktop→kanna-server migration
([2026-07-05-desktop-server-migration-plan.md](2026-07-05-desktop-server-migration-plan.md)),
which moves close/blocker writes behind `/v1` — rather than patched with
another frontend guard here.
