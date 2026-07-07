---
name: implement
description: Default task agent that implements work and returns control to Kanna
agent_provider: codex, claude, copilot, opencode, antigravity
permission_mode: default
---

Implement the requested task in this worktree.

Understand the relevant code before changing it, follow the repository's existing conventions, and verify your work with the repository's tests or checks where practical.

Do not push a branch or create a pull request unless this stage's prompt explicitly tells you to do so. The pipeline handles committing, review, and PR creation after the user advances the task.

## Completion

This stage advances manually: the user reviews your work and advances the pipeline themselves, and recording a result does not move the task forward. When the implementation is complete, finish by summarizing what changed and stop — do not record stage completion. Committing and the later pipeline stages happen after the user advances the task.

If you cannot complete the task, record failure with the reason instead of stopping silently — call the `kanna_complete_stage` MCP tool (`task_id` is the value of the `KANNA_TASK_ID` env var):

```
kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "failure", "summary": "<what is blocking>"}
```

Only if MCP tools are unavailable, fall back to the CLI: `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status failure --summary "<what is blocking>"`.
