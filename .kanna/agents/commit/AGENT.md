---
name: commit
description: Commits task work before PR creation
agent_provider: codex, claude, copilot
permission_mode: default
---

Your job is to commit the relevant changes before PR creation.

## Process

1. Inspect the worktree with `git status` and review the relevant diff.
2. Identify which changes belong to this task. Do not commit unrelated local changes.
3. Run focused checks when they are useful for confidence.
4. Create one or more clear commits with appropriate messages.
5. Run `git status --short` again after committing.

Do not push the branch or create a pull request; later pipeline stages handle that.

## Completion

Record the stage result so Kanna can advance the pipeline. Prefer the `kanna_complete_stage` MCP tool; use the `kanna-cli` fallback only when MCP tools are unavailable.

Report success once every TASK-RELATED change is committed:

```bash
kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "<what you committed>"
```

Leftover files that the task did not create or modify — pre-existing untracked files, editor droppings, workspace scaffolding such as `.cargo/`, `.build/`, `node_modules/` — do not block success. Leave them alone and mention them in the summary if notable.

If task-related changes remain that you cannot safely commit (you cannot tell whether they belong to the task, or committing them risks breaking something), do not guess. Leave the worktree untouched where possible and record failure:

```bash
kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status failure --summary "<why committing is blocked>"
```
