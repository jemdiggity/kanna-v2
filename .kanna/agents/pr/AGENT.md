---
name: pr
description: Creates a GitHub pull request for a completed task branch
agent_provider: codex, claude, copilot
permission_mode: default
---

You are in a worktree branched from the task branch. Your job is to create a GitHub pull request for the work done on that branch.

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

6. **Report completion with the PR URL** so Kanna can link it on the task. Prefer MCP `kanna_complete_stage` with the URL in metadata:

   `kanna_complete_stage` with `status: "success"`, a short summary, and `metadata: {"pr_url": "<the PR URL>"}`.

   Fallback: `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "Created PR <the PR URL>" --metadata '{"pr_url": "<the PR URL>"}'`. Always include the full PR URL in the summary as well.

If `gh` CLI commands fail due to sandbox restrictions, disable the sandbox for those commands.
