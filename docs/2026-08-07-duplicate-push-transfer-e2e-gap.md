# Duplicate outgoing push — E2E gap

Date: 2026-08-07
Scope: T3 of the task-transfer repair plan (make a duplicate outgoing push
idempotent instead of a 500 with a leaked reservation).
Related: [2026-08-06-task-transfer-rearchitecture-plan.md](2026-08-06-task-transfer-rearchitecture-plan.md),
[2026-08-06-missing-session-state-transfer-e2e-gap.md](2026-08-06-missing-session-state-transfer-e2e-gap.md)

## What the change is

Three pieces, across three processes:

- `kanna-server` maps the `idx_task_transfer_active_outgoing_source` violation
  on `POST /v1/transfers` to **409** with
  `{"error":"active_outgoing_transfer_exists","sourceTaskId":…,"transferId":…}`,
  and serves `GET /v1/transfers/outgoing/active/{source_task_id}` — the
  authoritative eligibility read, which the renderer's snapshot could never be.
- `pushTaskToPeer` reads that route before starting work, and on a 409 resolves
  as success-without-new-work instead of throwing, so the pull requester's
  retry loop does not treat the race as a dropped delivery.
- The losing push releases its preflight reservation through the new sidecar
  `abandon_outgoing_transfer` control request (durable registry entry + staged
  artifacts). A release that fails is surfaced to the operator, not swallowed.

### Follow-up landed in T6: the destination half of the release

T3 released only the *source* reservation. A preflight also writes
`incoming-reservations/<transfer_id>.json` on the destination
(`crates/task-transfer/src/runtime/listener.rs`), and until T6 nothing but the
TTL sweeper ever removed it — so a losing duplicate push left the destination
holding a reservation against its own admission cap.

`abandon_outgoing_transfer` now releases both. A new authenticated
`PeerRequest::AbandonTransfer` (sealed with `source_peer_id`, `transfer_id`,
and `reserved_target_peer_id`, exactly as `prepare_transfer`/`finalize_transfer`
are) asks the destination to drop its reservation. The handler refuses a source
that did not reserve the transfer and a reservation that has already committed —
a committed one is an incoming transfer the destination has been told about, and
releasing it would strand a transfer the operator can see — while staying
idempotent for an id it does not hold, which is what makes a half-failed release
retriable. The remote leg runs *before* any local state is dropped: the local
reservation is the only record of which peer holds the matching incoming one, so
a failed remote leg keeps it for the retry.

## What is covered, and where

- `crates/kanna-server/src/http_api/tests/transfers.rs` — the 409 body and its
  `transferId`; a same-id reinsert still succeeding (so a retried request is not
  mistaken for the race); and the active-outgoing read agreeing with the index
  exactly, including freeing the task once the transfer reaches `failed`.
- `crates/task-transfer/tests/runtime.rs` — abandoning clears both the durable
  reservation and its owned artifacts, and is a no-op for an unknown transfer id
  (the caller must be able to guarantee nothing is left, not that something
  was). Two live runtimes also cover the destination half: a release clears the
  destination's `incoming-reservations` entry, an unknown id still settles, a
  peer that did not reserve the transfer is refused, a committed reservation is
  refused, and a refused remote leg leaves the source reservation in place so
  the retry can still resolve the peer.
- `apps/desktop/src/stores/kannaTransfer.test.ts` — two concurrent pushes that
  both clear the snapshot and in-flight guards produce **one** `task_transfer`
  row, no throw, and exactly one released reservation (the loser's); a fresh
  store with the row already present skips the push entirely without a preflight
  (the app-restart case the in-memory guards can never cover); and a release
  that fails reaches the user.
- `apps/desktop/src/composables/useAppLifecycle.test.ts` — a second delivery the
  stale snapshot could not filter out still settles `delivered`, with no
  operational error reported.

## What is not covered, and why

**Two real `task-pull-requested` deliveries racing across two live instances.**
The race is between a renderer snapshot reload and a DB write, both of which the
E2E harness drives only indirectly; there is no product seam that holds one
delivery at its preflight while the other commits, which is what makes the
window reproducible at all. The store-level test above does hold that seam open
(both pushes are released from preflight together), so the property under test —
one row, zero 500s, zero leaked reservations — is asserted against the real
`pushTaskToPeer`, the real conflict-detection path, and the real release call;
what is mocked is the sidecar and the HTTP hop.

**The real-E2E harness is not currently safe to run on this machine.** A bare
`vitest run` from `apps/desktop` (rather than the package's own `pnpm test`,
which scopes to `src`) picks up `tests/e2e/real/**`. Doing that here deleted the
entire `apps/desktop` directory — tracked files included — via
`cleanupFixtureRepos` (`apps/desktop/tests/e2e/helpers/fixture-repo.ts`), which
calls `rm(resolve(repoPath), { recursive: true })` with no guard that
`repoPath` is non-empty or inside a fixture root; `resolve("")` is the current
working directory. That is a separate defect from this task and is left for its
own task, but it is why no real-E2E run was attempted here.

## What would close it

Phase 3 of the plan, where transfer orchestration moves into `kanna-server`:
once the push is a server-side operation, two concurrent pushes for one source
task are two concurrent requests, and the race becomes directly expressible in
an integration test against a real DB — no renderer, no live peer, and no
dependence on snapshot timing.
