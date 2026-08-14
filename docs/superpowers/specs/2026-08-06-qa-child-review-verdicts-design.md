# Durable QA Child Review Verdicts

## Goal

Let every `qa-dispatcher` review round read the recorded verdicts of its
task's earlier specialty-review children, including children that the
dispatcher already closed. A specialty's most recent recorded verdict remains
authoritative until that specialty is reviewed again, so an earlier failure
cannot be mistaken for a resolved finding merely because a later round did not
touch that surface.

## Chosen boundary

Add a read-only `kanna_list_task_children` catalog tool backed by
`GET /v1/tasks/{task_id}/children`. The route returns only the requested
task's direct children. Unlike the general task-list and search routes, it
includes closed children because closed specialty tasks are the durable review
record the dispatcher needs to join.

Each child record contains:

- its stable task id;
- its workflow name, which distinguishes `specialty-review` history from
  unrelated direct subtasks;
- the stage-run agent name, which identifies the specialty;
- creation and closure timestamps; and
- its latest run's stage, kind, status, summary, and finish timestamp.

The result is ordered by child creation time and then id. This makes repeated
reviews of one specialty deterministic: the last child for that specialty is
its carried-forward verdict. Only `specialty-review` children enter that
ledger. A specialty-review child without a valid reviewer identity or terminal
run is unresolved evidence and is not treated as a pass; unrelated child
workflows do not affect QA aggregation.

This endpoint deliberately does not list arbitrary closed tasks, recurse into
descendants, or add child history to every `TaskDetail` response. It exposes
only the existing `parent_task_id` relationship needed by the dispatcher's
join. The existing database schema already retains task rows, parent links,
and stage runs after close, so no migration or duplicate aggregate table is
needed.

## Dispatcher behavior

At the start of each review, the dispatcher calls
`kanna_list_task_children` for `$KANNA_TASK_ID` and reduces prior
specialty-review children to the latest verdict per specialty. Range selection
still follows the existing ancestor, `git range-diff`, and full-branch
fallbacks.

Specialties touched by this round are dispatched normally. For an untouched
specialty, the dispatcher carries forward and cites its latest recorded PASS
or FAIL. A carried FAIL remains blocking unless a later recorded review for
that specialty passes; `$PREV_MAIN_RESULT` remains a separate fallback for
explicitly declined findings. Missing or malformed prior verdicts fail closed
rather than being described as an earlier pass.

The aggregate success summary names both newly collected and carried-forward
verdicts. A revision summary includes unresolved carried failures alongside
new blocking findings, still subject to the existing scope bar and five-item
closed-list cap.

## Alternatives rejected

Adding children to `TaskDetail` would make every detail request load historical
subtasks even though only orchestrators need them. Persisting a parent-level
aggregate would duplicate child `stage_run` truth and require synchronization.
Embedding child ids in dispatcher summaries would make prompt output, rather
than the task graph, responsible for durable orchestration state.

## Verification

Server tests exercise the real Axum router and SQLite database, proving that
the endpoint returns direct open and closed children, excludes unrelated and
grandchild tasks, preserves ordering, and maps verdict summaries. Catalog
tests prove the shipped tool resolves to the endpoint and remains read-only.
The shipped-agent asset tests pin the dispatcher rules for querying prior
verdicts, carrying the latest verdict per specialty, and refusing to infer
that an unreviewed earlier failure was resolved.
