---
name: pr
description: Creates a GitHub pull request for a completed task branch
agent_provider: claude, codex, copilot, opencode, antigravity
permission_mode: default
---

You are in a worktree branched from the task branch. Your job is to create a GitHub pull request for the work on that branch. This stage's prompt explicitly authorizes pushing the branch and creating the PR.

1. **Confirm the source branch is committed** with `git -C $SOURCE_WORKTREE status --short`. If task-related changes are uncommitted, stop and report that the commit stage did not finish cleanly.
2. **Record the starting identity** before anything rewrites it: `git rev-parse HEAD`, `git rev-parse --abbrev-ref HEAD`, and `git -C $SOURCE_WORKTREE rev-parse --abbrev-ref HEAD`. The rebase in step 4 rewrites the shas and the rename in step 7 discards the branch names; step 6 matches on what you recorded here.
3. **Fetch, then validate the base ref** — see "Validate the base ref" below. It resolves the target branch this PR should land on, which is not automatically `$BASE_REF`.
4. **Rebase onto the validated target.** Use the original task base ref, `$BASE_REF`, when step 3 confirmed it is still live; when step 3 retargeted, rebase with `--onto` as described there. This keeps the PR to the task's own changes rather than reversions from a stale branch point.
5. If the rebase conflicts, resolve only conflicts whose correct resolution is unambiguous from the task's own changes, then `git rebase --continue`. Otherwise `git rebase --abort` and stop, reporting that the branch needs manual rebasing — do not push a half-rebased branch.
6. **Check whether an open PR already covers this work** — see "Reuse an existing PR" below. If one does, update it and skip steps 7-9.
7. **Rename the branch** to something meaningful based on the commits (`git branch -m <new-name>`).
8. **Push the branch**: `git push -u origin HEAD`.
9. **Create the PR** against the validated target from step 3 (`gh pr create --base <target>`), with a clear title and description summarizing the changes. End the body with a `Kanna-Task: $KANNA_TASK_ID` line so a later run can find this PR after the branch has been renamed.

If `gh` CLI commands fail due to sandbox restrictions, disable the sandbox for those commands.

## Validate the base ref

`$BASE_REF` is the base the task was created from, not a promise that the base is still a live path to the default branch. A PR that merges cleanly into an abandoned integration branch looks exactly like a healthy PR — review, checks, and the mergeable state all pass — so the check has to happen here, before the PR exists.

Resolve the default branch with `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, falling back to `git remote show origin`. If `$BASE_REF` is empty, the default branch is the target and nothing below applies. Otherwise strip any `origin/` prefix and ask, in order:

1. **Is the base the default branch?** Then it is the target; stop checking.
2. **Does the base still exist on the remote?** `git ls-remote --heads origin <base>` — no output means it is gone.
3. **Does the base have an open PR of its own?** `gh pr list --state open --head <base> --json number,url,baseRefName`. That PR is what carries a stacked base to the default branch; without one, nothing does. If the parent PR's own base is not the default branch either, ask this same question of it — follow at most three links, and treat a chain that does not reach the default branch as unresolved.
4. **Is the base already contained in the default branch?** `git merge-base --is-ancestor origin/<base> origin/<default>` succeeding means the base has already landed and targeting it adds nothing.

The base is live when it is the default branch, or when the chain of open PRs starting at it reaches the default branch. It is a dead end when it is gone from the remote, has no open PR, or is already contained in the default branch.

**Never retarget unconditionally.** A PR stacked on a live feature branch is a legitimate pattern; moving it to the default branch would drag the parent's commits into this PR or break the stack. When the base is live, keep it and say so in your report, naming the parent PR that carries it.

For a dead-end base, retarget only when the task's own commits replay cleanly onto the default branch:

```
git rebase --onto origin/<default> origin/<base> HEAD
```

Rebasing onto `origin/<base>` as the upstream is what keeps the base branch's own commits out of this PR. Afterwards, confirm `git log --oneline origin/<default>..HEAD` lists only this task's commits. If the rebase conflicts, or the base tip can no longer be resolved (the branch was deleted before you fetched it), `git rebase --abort`, create no PR, and record stage failure asking a human which branch this work should target. **Stopping to ask is a correct outcome; landing the work on a branch nobody will merge is not.**

Do not trigger on how far the base is behind the default branch, how long ago it was last committed to, or what it is named. Long-lived stack parents drift behind and go quiet without being abandoned, and deciding on those signals would break stacking. Mention the distance in your report as context; decide on the questions above.

## Reuse an existing PR

Step 7 renames the branch, so an earlier PR for this task can be sitting on a branch name this worktree no longer has — and an unconditional `gh pr create` then opens a second PR for the same commits. Match on the work, not just the current branch name. List the open PRs once:

```
gh pr list --state open --limit 100 --json number,url,headRefName,headRefOid,baseRefName,isDraft,title
```

A PR covers this work when any of these holds:

- its `headRefOid` equals the sha you recorded in step 2, or the current `HEAD`;
- its `headRefName` is one of this task's branch names — the branch recorded in step 2, the source worktree's branch, or a `task-$KANNA_TASK_ID` branch on the remote (`git ls-remote --heads origin "task-$KANNA_TASK_ID*"`);
- `gh pr list --state open --search "$KANNA_TASK_ID in:body"` returns it — PRs created by step 9 carry that trailer;
- the rebase rewrote your commits and, after fetching that head branch, `git cherry origin/<headRefName> HEAD` marks every one of your commits `-`, meaning it already carries equivalent patches.

When a PR covers this work, update it instead of opening a second one:

1. Do not rename the branch — renaming and pushing a new branch orphans the PR.
2. Confirm you are not about to discard work: `git cherry HEAD origin/<headRefName>` must print no `+` lines. If it does, that branch holds commits you do not have — stop and report instead of force-pushing over them.
3. Push with `git push --force-with-lease origin HEAD:refs/heads/<headRefName>`.
4. If validating the base ref retargeted this work, move the PR too: `gh pr edit <number> --base <target>`.
5. Refresh the title and description if the work changed, adding the `Kanna-Task: $KANNA_TASK_ID` line if the body lacks it, and report that PR's URL as this stage's result.

If you conclude the match belongs to different work and a separate PR is genuinely right, say why in your report. A second PR for the same commits is a defect, not a detail.

## Completion

Report the PR URL so Kanna can link it on the task — in the summary as well as the metadata. Report the URL the same way whether you created the PR or updated an existing one:

```
kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "success", "summary": "Created PR <the PR URL>", "metadata": {"pr_url": "<the PR URL>"}}
```

If you cannot create the PR, or the base ref is a dead end that you could not safely retarget, record `"status": "failure"` with the reason instead.

CLI fallback: `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "Created PR <url>" --metadata '{"pr_url": "<url>"}'`, or `--status failure --summary "<why PR creation is blocked>"`.
