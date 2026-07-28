---
name: pr
description: Creates a GitHub pull request for a completed task branch
agent_provider: claude, codex, copilot, opencode, antigravity
permission_mode: default
---

You are in a worktree branched from the task branch. Your job is to create a GitHub pull request for the work done on that branch. This stage's prompt explicitly authorizes pushing the branch and creating the PR.

## Process

1. **Confirm the source branch is committed** by running `git -C $SOURCE_WORKTREE status --short`. If there are uncommitted changes, stop and report that the commit stage did not finish cleanly.

2. **Rebase onto the latest base branch**. Use the original task base ref, `$BASE_REF`, without assuming the development branch name:

   ```bash
   BASE_REF="$BASE_REF"
   if [ -z "$BASE_REF" ]; then
     BASE_REF="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD)"
   fi
   if [ -z "$BASE_REF" ]; then
     BASE_REF="$(git remote show origin | sed -n 's/.*HEAD branch: //p' | sed 's#^#origin/#')"
   fi
   git fetch origin
   git rebase "$BASE_REF"
   ```

   This ensures the PR only contains the task's changes, not reversions from a stale branch point.

   If the rebase stops on conflicts, do not force it through blindly. Resolve conflicts only when the correct resolution is unambiguous from the task's own changes, then continue with `git rebase --continue`. If the resolution is unclear or the conflict is in code this task did not touch, run `git rebase --abort` and stop, reporting that the branch needs manual rebasing before a PR can be created — do not push a half-rebased branch.

3. **Rename the branch** to something meaningful based on the commits (use `git branch -m <new-name>`).

4. **Push the branch**: `git push -u origin HEAD`.

5. **Create the PR** against the same base branch used for the rebase:

   ```bash
   BASE_REF="$BASE_REF"
   if [ -z "$BASE_REF" ]; then
     BASE_REF="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD)"
   fi
   if [ -z "$BASE_REF" ]; then
     BASE_REF="$(git remote show origin | sed -n 's/.*HEAD branch: //p' | sed 's#^#origin/#')"
   fi
   BASE_BRANCH="${BASE_REF#origin/}"
   gh pr create --base "$BASE_BRANCH"
   ```

   Write a clear title and description summarizing the changes.

If `gh` CLI commands fail due to sandbox restrictions, disable the sandbox for those commands.

## Completion

Record the stage result so Kanna can advance the pipeline by calling the `kanna_complete_stage` MCP tool (`task_id` is the value of the `KANNA_TASK_ID` env var). Only if MCP tools are unavailable, fall back to `kanna-cli stage-complete`, which takes the same arguments as flags.

After the PR exists on GitHub, report completion with the PR URL so Kanna can link it on the task — always include the full PR URL in the summary as well:

```
kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "success", "summary": "Created PR <the PR URL>", "metadata": {"pr_url": "<the PR URL>"}}
```

(CLI fallback: `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "Created PR <the PR URL>" --metadata '{"pr_url": "<the PR URL>"}'`)

If you cannot create the PR, record failure with the reason:

```
kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "failure", "summary": "<why PR creation is blocked>"}
```

(CLI fallback: `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status failure --summary "<why PR creation is blocked>"`)
