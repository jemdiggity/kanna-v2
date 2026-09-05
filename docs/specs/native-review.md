# Native Review (retired)

The former in-app PR review surface is retired. Kanna no longer exposes
line-level review comments, the review comment drawer/composer, request-changes
controls, or approval controls from the desktop diff viewer. This spec's loop is
unchanged by [pr-review-dispatch.md](./pr-review-dispatch.md), which proposes a
separate activity — reviewing open PRs as a dispatched task tree — rather than
a replacement for reviewing a task's branch inside its own workflow.

This removal is intentional while task 231ad8fc designs the replacement review
experience. The general desktop and mobile diff/file viewers remain available,
as do PR links and ordinary workflow stage advancement. Advancing a task at a
PR stage still runs that workflow's configured `approve` post, including the
post that hands approved work to the merge queue/master.
