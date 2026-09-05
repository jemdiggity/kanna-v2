# Native Review (retired)

The former in-app PR review surface is retired. Kanna no longer exposes
line-level review comments, the review comment drawer/composer, request-changes
controls, or approval controls from the desktop diff viewer. Its review
experience is under rethink — see
[pr-review-surface.md](./pr-review-surface.md), a proposed design that would
supersede the review half of this spec on acceptance.

This removal is intentional while task 231ad8fc designs the replacement review
experience. The general desktop and mobile diff/file viewers remain available,
as do PR links and ordinary workflow stage advancement. Advancing a task at a
PR stage still runs that workflow's configured `approve` post, including the
post that hands approved work to the merge queue/master.
