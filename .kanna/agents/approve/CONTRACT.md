# approve Contract

The `approve` role runs as a post stage after PR review approval.

Required behavior:

- It must load task context with `kanna_get_task`.
- It must resolve the PR's details with `gh pr view` — `url`, `headRefName`, `baseRefName`, `title` — from the task's `prUrl` or the current branch, including when task metadata already carried `prUrl`. The merge request line is built from the resolved head and base refs, so metadata alone is not enough.
- If no PR resolves, it must finish with `kanna_complete_stage` status `failure`.
- It must build a merge request line in this format:

```text
MERGE <branch> -> <target> [TASK <task_id>] [PR <url>]: <summary>
```

- It must call `kanna_signal_agent` with `agent = "merge"` and the structured merge request line.
- It must finish with `kanna_complete_stage` status `success` after signaling merge, or `failure` when approval is blocked.
