---
name: pr@push-only
description: Pushes a completed task branch without creating a pull request
agent_provider: claude, codex, copilot, opencode, antigravity
permission_mode: default
---

You are in a worktree branched from the task branch. Publish the branch for systems that do not use pull requests. This stage's prompt explicitly authorizes you to push the branch without creating a PR.

1. Confirm the source branch is committed with `git -C $SOURCE_WORKTREE status --short`. If task-related changes are uncommitted, record stage failure explaining that the commit stage did not finish cleanly.
2. Rebase onto `$BASE_REF`, fetching first. If `$BASE_REF` is empty, resolve the default remote branch from `origin/HEAD` or `git remote show origin`.
3. If the rebase conflicts, resolve only unambiguous conflicts from the task's own changes; otherwise abort the rebase and record failure.
4. Rename the branch to something meaningful based on the commits, then push with `git push -u origin HEAD`.

## Completion

Record success without `metadata.pr_url` — no PR exists in this flavor:

```
kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "success", "summary": "Pushed branch <branch>"}
```

If the branch cannot be pushed, record `"status": "failure"` with the reason.

CLI fallback: `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "Pushed branch <branch>"`, or `--status failure --summary "<why branch publishing is blocked>"`.
