# approve Contract

The `approve` role runs as a post stage after PR review approval.

Required behavior:

- It must load task context with `kanna_get_task`.
- It must resolve the PR URL from task metadata or the current branch.
- If no PR exists, it must finish with `kanna_complete_stage` status `failure`.
- When a draft PR exists, it must make the PR ready before signaling merge.
- It must build a merge request line in this format:

```text
MERGE <branch> -> <target> [TASK <task_id>] [PR <url>]: <summary>
```

- It must call `kanna_signal_agent` with `agent = "merge"` and the structured merge request line.
- It must finish with `kanna_complete_stage` status `success` after signaling merge, or `failure` when approval is blocked.
