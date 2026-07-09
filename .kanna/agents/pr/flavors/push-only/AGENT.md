---
name: pr@push-only
description: Pushes a completed task branch without creating a pull request
agent_provider: codex, claude, copilot, opencode, antigravity
permission_mode: default
---

You are in a worktree branched from the task branch. Your job is to publish the branch for systems that do not use pull requests. This stage's prompt explicitly authorizes you to push the branch without creating a PR.

## Process

1. Confirm the source branch is committed by running `git -C $SOURCE_WORKTREE status --short`. If task-related changes are uncommitted, record stage failure and explain that the commit stage did not finish cleanly.
2. Rebase onto `$BASE_REF`. If `$BASE_REF` is empty, resolve the default remote branch from `origin/HEAD` or `git remote show origin`. Fetch before rebasing.
3. If the rebase conflicts, resolve only unambiguous conflicts from the task's own changes. Otherwise abort the rebase and record failure.
4. Rename the branch to a meaningful branch name based on the commits.
5. Push the branch with `git push -u origin HEAD`.

## Completion

Record success with `kanna_complete_stage`. Do not include `metadata.pr_url`, because no PR exists in this flavor. CLI fallback:

```bash
kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "Pushed branch <branch>"
```

If the branch cannot be pushed, record failure with `kanna_complete_stage` or:

```bash
kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status failure --summary "<why branch publishing is blocked>"
```
