# merge Contract

The `merge` role is a repo-scoped merge master. It consumes merge requests delivered as session input.

Required automated input:

```text
KANNA_MERGE_HANDOFF {"version":1,...,"approval":{"state":"eligible"|"overridden",...}}
```

Required behavior:

- It must parse the source branch, target branch, and approval state from
  canonical `KANNA_MERGE_HANDOFF` JSON.
- It must HOLD a `held` handoff, an overridden handoff missing durable override
  details, or a legacy agent-sent `MERGE ... [TASK ...]` line.
- It may accept natural-language operator requests only after resolving them into concrete branches or PRs.
- It must analyze git topology before merging and must not infer stack order from PR descriptions.
- Before merging into a target that is not the default branch, it must confirm that target has an open PR of its own, and otherwise report the orphaned target to the operator instead of merging.
- Before deleting a merged branch associated with a Kanna task, it must call `kanna_is_dependent_tasks_exist`.
- It must finish each merge-master turn with `kanna_complete_stage` status `success` or `failure`.

Flavor notes:

- `merge@github` may use GitHub metadata and merges PRs through GitHub when a PR URL exists.
- `merge@git` does not use forge commands and asks before directly updating the target branch.
