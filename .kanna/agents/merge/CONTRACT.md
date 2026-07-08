# merge Contract

The `merge` role is a repo-scoped merge master. It consumes merge requests delivered as session input.

Required input:

```text
MERGE <branch> -> <target> [TASK <task_id>] [PR <url>]: <summary>
```

Required behavior:

- It must parse the source branch and target branch from structured `MERGE` lines.
- It may accept natural-language operator requests only after resolving them into concrete branches or PRs.
- It must analyze git topology before merging and must not infer stack order from PR descriptions.
- Before deleting a merged branch associated with a Kanna task, it must call `kanna_is_dependent_tasks_exist`.
- It must finish each merge-master turn with `kanna_complete_stage` status `success` or `failure`.

Flavor notes:

- `merge@github` may use GitHub metadata and merges PRs through GitHub when a PR URL exists.
- `merge@git` does not use forge commands and asks before directly updating the target branch.
