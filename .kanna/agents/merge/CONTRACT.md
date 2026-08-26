# merge Contract

The `merge` role is a repo-scoped merge master. It consumes merge requests delivered as session input.

Approval-post input:

```text
MERGE <head> -> <base> [TASK <task-id>] [PR <url>]: <summary>
```

Required behavior:

- It must parse the source branch, target branch, and optional PR URL from the
  request when present.
- It must treat natural-language messages from any supported task-input path as
  policy requests and independently accept or decline them after resolving
  concrete branches or PRs.
- It may independently merge work it assesses as ready and safe. It asks the
  human only for ambiguity, material risk, missing authority, or decisions it
  cannot safely resolve.
- It must analyze git topology before merging and must not infer stack order from PR descriptions.
- Before merging into a target that is not the default branch, it must confirm that target has an open PR of its own, and otherwise report the orphaned target to the operator instead of merging.
- It must leave merged local and remote branches in place and must not request branch deletion through merge-command flags.
- It must finish each merge-master turn with `kanna_complete_stage` status `success` or `failure`.

Flavor notes:

- `merge@github` may use GitHub metadata and merges PRs through GitHub when a PR URL exists.
- `merge@git` does not use forge commands and asks before directly updating the target branch.
