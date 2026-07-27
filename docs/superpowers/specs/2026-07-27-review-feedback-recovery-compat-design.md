# Task Action Recovery Compatibility Design

## Goal

Close the three remaining review gaps without weakening immutable run ownership:
ambiguous Spawn replies must not destroy a potentially live successor's durable
reservation, unrelated legacy sessions must not block recovery of an exactly
owned successor, and pre-upgrade override catalogs must accept current
post-completion capabilities.

## Spawn reconciliation

`reconcile_spawn_acceptance` will classify reconciliation as:

- **Accepted** when `List` contains the exact `(session_id, run_id)`.
- **Rejected** when a successful `List` conclusively contains no such owner
  (including a same-id session with another owner).
- **Indeterminate** when bounded reconnect/List attempts cannot obtain a
  trustworthy list.

Accepted continues landing the reserved run. Rejected uses the existing
failure/rollback path. Indeterminate returns an error to the caller but does
not fail the run, delete the pending action, release its action request, or
remove its prepared workspace. Startup reconciliation remains responsible for
eventually landing or rolling back that durable reservation.

Production reconciliation uses a small fixed attempt bound and per-attempt
deadline. Tests use shorter deadlines. There is no unbounded retry loop.

## Mixed legacy/current recovery

Startup reconciliation will not reject an entire `SessionList` because its
aggregate `immutable_run_ownership` capability is false. It will evaluate every
pending action against its exact expected `(session_id, successor_run_id)`
tuple. An unrelated session with no run id is ignored. A pending successor
without the exact owner is not landed.

This preserves old-daemon safety: legacy sessions cannot accidentally satisfy
an exact current-run reservation.

## Override-catalog compatibility

The MCP and generic CLI resolvers will treat `completion_attempt` as a
forward-compatible completion field. When the loaded completion tool omits
that parameter, the resolver validates and temporarily removes the caller's
string value, resolves the remaining arguments against the old catalog, and
reinjects it into the HTTP body as `completionAttempt`.

Environment-owned `run_id` remains authoritative and is reinjected as `runId`.
Tests use an override with both `run_id` and `completion_attempt` absent.

## Verification

Each fix starts with a regression test that fails on the current branch. Final
verification includes the focused regressions, affected package test suites,
formatting, compile checks, and a clean Git worktree before stage completion.
