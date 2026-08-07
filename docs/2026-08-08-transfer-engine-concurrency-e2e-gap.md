# Transfer engine concurrency: what no E2E on this machine can show

Date: 2026-08-08
Scope: the reviewer follow-ups to PRs #1028/#1029 — the drain loop's
head-of-line blocking, and the settle window on an `Idle` edge.
Related: [2026-08-06-task-transfer-rearchitecture-plan.md](2026-08-06-task-transfer-rearchitecture-plan.md),
[2026-08-06-agent-tui-injection-e2e-gap.md](2026-08-06-agent-tui-injection-e2e-gap.md),
[2026-08-07-transfer-e2e-suites-note.md](2026-08-07-transfer-e2e-suites-note.md)

## The behaviour

`transfer_engine::drain` now runs up to `MAX_CONCURRENT_WORK` work items at
once, serialized per transfer by `claim_next_transfer_work`'s busy-transfer
exclusion. The bug it fixes is only visible with **two transfers in flight at
the same time**, one of them slow: before, a `finalize` waiting up to 360 s on a
source agent — or an `import` waiting ~615 s on a peer's answer — held the only
drain slot, so every other transfer work item on the machine waited behind it.
Nothing failed; a second transfer just did not start until the first was done,
which reads as "the network is slow" rather than as a queue with one slot.

## Why it has no E2E

The existing transfer E2Es each drive **one** transfer between **two**
instances. Reproducing head-of-line blocking needs, in one run:

1. two independent transfers whose work overlaps in time, which means either
   three instances or two transfers between the same pair, and
2. one of them held open long enough to be distinguishable from ordinary
   latency — which means a real agent that does not go idle, because the whole
   point is that the slow item is slow *legitimately*, and
3. an assertion about *when* the second transfer started, not just that it
   completed.

(2) is the hard one. The wrap-up wait is the thing being held open, and
`docs/2026-08-06-agent-tui-injection-e2e-gap.md` already records that this
repo will not drive an interactive Claude TUI from a test; the real-E2E runner
forces OpenCode (`apps/desktop/tests/e2e/runEnv.ts`), whose free models finish a
wrap-up turn in seconds. Stalling one on purpose means a fault seam inside the
engine, at which point the test is asserting against an injected stall rather
than a real one — which is exactly what the unit tests below already do, more
cheaply and deterministically.

## What would make it testable

- A third instance in the real-E2E harness, plus a supported way to make one
  source agent's wrap-up take a bounded, known-long time (a fixture agent whose
  turn length is a parameter). The harness already runs two instances
  (`local-transfer-accept-import`), so the missing piece is the third instance
  and a slow-by-contract agent, not new machinery for either.
- Failing that, an assertion cheap enough to add to an existing two-instance
  suite: push two tasks from one source in the same run and assert the second
  destination task appears before the first source agent has exited. That is a
  weaker statement (it does not distinguish concurrency from a fast first
  transfer) and would only be meaningful with the slow-by-contract agent above.

## Narrower coverage added meanwhile

- `transfer_engine::tests::a_slow_item_does_not_hold_up_an_unrelated_transfer` —
  drives the real `drain` loop over a real DB, with a scripted executor that
  holds the `finalize` item of one transfer open indefinitely, and asserts an
  unrelated transfer's `import` runs and records its outcome while the first is
  still `running`. Fails against the serial loop (and against
  `MAX_CONCURRENT_WORK = 1`) by timing out.
- `transfer_engine::tests::two_items_of_one_transfer_never_run_at_once` — the
  other half: concurrency stops at the transfer boundary, so a transfer's
  lifecycle steps stay a sequence.
- `db::transfer_work::tests::a_transfer_already_in_flight_is_passed_over_without_spending_an_attempt`
  — the claim skips a busy transfer's rows without touching `attempts` or
  `run_after`, and reports no runnable delay for them, so the drain parks on a
  worker instead of spinning against a row it cannot take.
- `local-transfer-accept-import.test.ts` was run as the regression control: the
  ordinary one-transfer path is unchanged by the concurrency.

## The idle-edge settle window

The same reviewer round added a settle window to the `Idle` **edge** in
`finalize.rs` (`IDLE_EDGE_SETTLE`): an `Idle` published during the wrap-up's own
two-step injection, or between two turns of the daemon's 500 ms-throttled busy
detection, is no longer taken as "the turn is over". Its E2E situation is the one
already recorded in `2026-08-06-agent-tui-injection-e2e-gap.md` and in
`local-transfer-busy-agent-wrapup.test.ts`: the suite proves the wrap-up reaches
the shipped transcript, but it cannot assert *which* `Idle` released the quit,
because it observes the transfer's result rather than the daemon's status stream.
Both new cases are pinned instead against a fake daemon over a real Unix socket,
which is the only place the publish timing is controllable:
`an_idle_published_while_the_wrap_up_is_typed_does_not_release_the_quit` and
`an_idle_edge_that_goes_back_to_busy_is_not_a_finished_turn`.

**Observed while verifying this change (2026-08-08):** that suite currently fails
on this machine, and not for the settle window. It fails at
`expect(opencodeSessionText(conversation, "user")).toContain(WRAP_UP_PHRASE)` with
a conversation carrying only the task's *initial* prompt, after a 13 s run — where
the measurement recorded in `2026-08-08-opencode-live-idle-detection-e2e-gap.md`
took ~5 minutes and did carry the wrap-up and the agent's reply. A 13 s
finalization cannot have waited any of the engine's windows (20 s settle, 300 s
budget), so the source session ended before the live agent answered, and what is
missing is the agent's turn rather than the engine's step. The settle change was
A/B'd against exactly this suite — reverting `wait_for_idle` to returning on the
first `Idle` edge, rebuilding, re-running — and the failure is identical, so the
window is not the cause. `local-transfer-accept-import` (the regression control)
passes. Not diagnosed further here: it is a live-provider/agent-liveness question
in the same family as the note above, and it is not this change's code.
