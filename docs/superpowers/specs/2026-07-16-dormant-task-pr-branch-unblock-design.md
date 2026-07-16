# Dormant Task PR-Branch Unblock Design

## Problem

A task created with blockers is intentionally dormant: it has a durable task row and blocker relationships, but no worktree or agent session. Kanna creates its first worktree only after every blocker has resolved.

PR-stage agents rename their final workspace branches. Kanna currently discovers that live name while the blocker's worktree exists but does not persist it. In a multi-blocker sequence, an earlier blocker can close and have its worktree cleaned up before the last blocker resolves. Kanna then falls back to the earlier blocker's stale workspace branch name and fails to create the dependent worktree with `fatal: invalid reference`.

## Required Behavior

- Creating a blocked task must not create a worktree or agent session.
- A blocker parked at `pr` with a PR URL is resolved and can supply its PR branch to dependents.
- When the final blocker resolves, Kanna creates the dormant task's worktree from the blockers' actual PR branches and starts its configured agent.
- An earlier resolved blocker's branch must remain available to this later start even after that blocker's worktree is removed.
- Multiple blocker branches continue to use the existing merge/integration-task behavior.

## Design

When a blocker resolves at the PR stage, the server will resolve the current Git branch from the blocker worktree and persist that live name in a dedicated nullable `pipeline_item.pr_branch` column before cleanup can remove the worktree. `pipeline_item.branch` remains the workspace identity used by existing lifecycle paths, while `pr_branch` is the durable dependency handoff ref. This separation avoids confusing a renamed Git branch with the unchanged worktree directory name.

The existing dormant-start path remains unchanged in shape:

1. The blocked task is created without a worktree.
2. Each blocker resolution is recorded while unresolved blockers keep the task dormant.
3. When no blockers remain unresolved, Kanna reads the persisted blocker PR branches.
4. Kanna creates the dependent worktree from the first PR branch and merges additional PR branches using the existing conflict handling.
5. Kanna starts the dependent agent only after worktree preparation succeeds.

This does not create or retain dormant worktrees early. It only makes the branch metadata durable at the moment the PR branch is known.

## Error Handling

If the blocker worktree cannot reveal a renamed branch, Kanna stores the existing workspace branch as the best available dependency ref. Dormant start errors remain logged and do not undo the blocker close. The fix prevents the known stale-name failure by capturing the live branch during successful PR resolution, when the worktree is still present.

## Testing

Add a server integration regression covering the production sequence:

1. Complete a PR stage with a renamed branch and assert `pr_branch` captures the live name while `branch` retains the workspace identity.
2. Create two blockers with PR-stage worktrees whose Git branches are renamed.
3. Create a dependent task blocked by both and assert it has no worktree.
4. Resolve the first blocker and assert the dependent remains dormant.
5. Remove the first blocker's worktree, matching close cleanup.
6. Resolve the second blocker.
7. Assert the dependent worktree is created successfully from the persisted first PR branch, incorporates both blocker commits, and its agent is spawned once.

Run the focused `kanna-server` integration test, then the relevant Rust test suite and formatting checks.
