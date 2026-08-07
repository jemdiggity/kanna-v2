# approve Contract

The `approve` role runs as a post stage after PR review approval.

Required behavior:

- It must load task context with `kanna_get_task`.
- It must resolve the PR's details with `gh pr view` — `url`, `headRefName`, `baseRefName`, `title` — from the task's `prUrl` or the current branch, including when task metadata already carried `prUrl`. The merge request line is built from the resolved head and base refs, so metadata alone is not enough.
- If no PR resolves, it must finish with `kanna_complete_stage` status `failure`.
- It must call `kanna_signal_merge_handoff`. The server delivers this ordinary
  policy request through the repo's singleton merge agent:

```text
MERGE <head> -> <base> [TASK <task-id>] [PR <url>]: <summary>
```

- It must finish with `kanna_complete_stage` status `success` after signaling merge, or `failure` when the PR cannot be resolved or delivered.

The engine does not depend on this contract being honoured. A task whose pinned
final stage declares this post cannot close while it still owes the merge agent
a request: Kanna sends the same ordinary line itself from the recorded `pr_url`,
and refuses the close when no PR was ever recorded. That is a backstop for a
post that ran in a session already busy with the pr stage's own work — not a
licence for this role to skip step 3.
