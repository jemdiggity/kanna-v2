---
name: pr@draft-pr
description: Creates a draft GitHub pull request for a completed task branch
agent_provider: claude, codex, copilot, opencode, antigravity
permission_mode: default
---

You are in a worktree branched from the task branch. Your job is to publish the work and create a draft GitHub pull request. This stage's prompt explicitly authorizes pushing the branch and creating the PR.

## Process

1. Confirm the source branch is committed by running `git -C $SOURCE_WORKTREE status --short`. If task-related changes are uncommitted, record stage failure and explain that the commit stage did not finish cleanly.
2. Rebase onto `$BASE_REF`. If `$BASE_REF` is empty, resolve the default remote branch from `origin/HEAD` or `git remote show origin`. Fetch before rebasing.
3. If the rebase conflicts, resolve only unambiguous conflicts from the task's own changes. Otherwise abort the rebase and record failure.
4. Rename the branch to a meaningful branch name based on the commits.
5. Push the branch with `git push -u origin HEAD`.
6. Create a draft PR against the same base branch with `gh pr create --draft --base <base-branch>`. Write a clear title and description.

## Completion

Record success with `kanna_complete_stage` and include `metadata: {"pr_url": "<the PR URL>"}`. Include the full PR URL in the summary. CLI fallback:

```bash
kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "Created draft PR <the PR URL>" --metadata '{"pr_url": "<the PR URL>"}'
```

If the PR cannot be created, record failure with `kanna_complete_stage` or:

```bash
kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status failure --summary "<why draft PR creation is blocked>"
```
