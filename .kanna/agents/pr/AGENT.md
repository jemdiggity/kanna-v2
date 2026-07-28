---
name: pr
description: Creates a GitHub pull request for a completed task branch
agent_provider: claude, codex, copilot, opencode, antigravity
permission_mode: default
---

You are in a worktree branched from the task branch. Your job is to create a GitHub pull request for the work on that branch. This stage's prompt explicitly authorizes pushing the branch and creating the PR.

1. **Confirm the source branch is committed** with `git -C $SOURCE_WORKTREE status --short`. If task-related changes are uncommitted, stop and report that the commit stage did not finish cleanly.
2. **Rebase onto the base branch.** Use the original task base ref, `$BASE_REF`; if it is empty, resolve the default remote branch from `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, falling back to `git remote show origin`. Fetch first, then `git rebase`. This keeps the PR to the task's own changes rather than reversions from a stale branch point.
3. If the rebase conflicts, resolve only conflicts whose correct resolution is unambiguous from the task's own changes, then `git rebase --continue`. Otherwise `git rebase --abort` and stop, reporting that the branch needs manual rebasing — do not push a half-rebased branch.
4. **Rename the branch** to something meaningful based on the commits (`git branch -m <new-name>`).
5. **Push the branch**: `git push -u origin HEAD`.
6. **Create the PR** against the same base branch (`gh pr create --base "${BASE_REF#origin/}"`), with a clear title and description summarizing the changes.

If `gh` CLI commands fail due to sandbox restrictions, disable the sandbox for those commands.

## Completion

Report the PR URL so Kanna can link it on the task — in the summary as well as the metadata:

```
kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "success", "summary": "Created PR <the PR URL>", "metadata": {"pr_url": "<the PR URL>"}}
```

If you cannot create the PR, record `"status": "failure"` with the reason instead.

CLI fallback: `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "Created PR <url>" --metadata '{"pr_url": "<url>"}'`, or `--status failure --summary "<why PR creation is blocked>"`.
