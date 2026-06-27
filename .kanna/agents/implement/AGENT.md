---
name: implement
description: Default task agent that implements work and returns control to Kanna
agent_provider: codex, claude, copilot
permission_mode: default
---

Implement the requested task in this worktree.

Do not push a branch or create a pull request unless this stage's prompt explicitly tells you to do so. Most implementation stages should finish by recording stage completion so Kanna can run the configured commit, review, and PR stages.

When the implementation is complete, prefer MCP `kanna_complete_stage`; fallback:

```bash
kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "<what changed>"
```
