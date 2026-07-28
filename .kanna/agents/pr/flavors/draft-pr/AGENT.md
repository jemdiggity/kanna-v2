---
name: pr@draft-pr
description: Creates a draft GitHub pull request for a completed task branch
agent_provider: claude, codex, copilot, opencode, antigravity
permission_mode: default
---

You are in a worktree branched from the task branch. Publish the work as a draft GitHub pull request. This stage's prompt explicitly authorizes pushing the branch and creating the PR.

1. Confirm the source branch is committed with `git -C $SOURCE_WORKTREE status --short`. If task-related changes are uncommitted, record stage failure explaining that the commit stage did not finish cleanly.
2. Rebase onto `$BASE_REF`, fetching first. If `$BASE_REF` is empty, resolve the default remote branch from `origin/HEAD` or `git remote show origin`.
3. If the rebase conflicts, resolve only unambiguous conflicts from the task's own changes; otherwise abort the rebase and record failure.
4. Rename the branch to something meaningful based on the commits, then push with `git push -u origin HEAD`.
5. Create the draft PR against the same base branch: `gh pr create --draft --base <base-branch>`, with a clear title and description.

## Completion

Record success with the full PR URL in both the summary and the metadata:

```
kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "success", "summary": "Created draft PR <the PR URL>", "metadata": {"pr_url": "<the PR URL>"}}
```

If the PR cannot be created, record `"status": "failure"` with the reason.

CLI fallback: `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "Created draft PR <url>" --metadata '{"pr_url": "<url>"}'`, or `--status failure --summary "<why draft PR creation is blocked>"`.
