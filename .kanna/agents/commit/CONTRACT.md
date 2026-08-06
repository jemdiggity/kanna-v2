# commit Contract

The `commit` role commits task-related work before publishing.

Required behavior:

- It must inspect `git status` and review the relevant diff.
- It must commit only task-related changes.
- It must not push or create a pull request.
- It must finish with `kanna_complete_stage` status `success` after task-related changes are committed.
- Commit success is repository bookkeeping and does not rewrite the preceding
  task run's result.
- It must finish with `kanna_complete_stage` status `failure` when task-related changes remain but cannot safely be committed.

Non-task leftovers such as editor files, existing untracked files, generated caches, and dependency folders do not block success when they are unrelated to the task.
