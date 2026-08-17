# Destination restart transfer resume E2E gap (2026-08-17)

`apps/desktop/tests/e2e/real/local-transfer-headless-engine.test.ts` retains a
quarantined case for resuming a transfer whose **destination** `kanna-server` is
SIGKILLed between the recorded incoming row and the completed import.

## Symptom

Roughly one focused run in five, the resumed import never progresses again. The
destination's incoming row stays at:

```json
{"local_task_id": null, "status": "claimed"}
```

for as long as the test waits — no local task, no retry, no `failed` row, and
nothing reported to the operator. Observed on this branch at both the default
120s budget and a widened 240s one (five focused runs of the file: four green,
one wedged at 243.8s), and independently by the round-1 review of task
`d2c4814c` at 123.8s. The other two cases in the file — the no-renderer pull and
the **source**-side restart — pass every run.

## Why it is not a rotted assertion

The assertion is the file's whole point: an interrupted transfer must resume
rather than orphan. Widening the wait does not make it pass, so the transfer is
not merely slow, it is wedged.

`claimed` is set at the top of `run_import`
(`crates/kanna-server/src/transfer_engine/import.rs`), so the import work item
did start after the restart — the engine's startup sweep
(`recover_interrupted_work` → `requeue_interrupted_transfer_work` plus the
`list_pending_incoming_transfers` re-enqueue) is doing its job. A wedged item
with no retry and no failure means the run neither returned nor errored: the
work item is still `running`, so `fail_transfer_work_attempt` and its
`RETRY_BACKOFF_SECONDS` schedule never engage.

The most likely mechanism is an unbounded wait on the sidecar control channel.
`run_import` calls `control::finalize_from_source`, which reaches the transfer
sidecar through `TransferSidecarClient::request`
(`crates/kanna-server/src/transfer_sidecar.rs`), and that ends in a bare
`rx.await` with no timeout. A sidecar respawned by the restarted server that
never answers that request — the old sidecar still owning the transfer listener
is one way to get there — parks the import forever. This is unconfirmed: the
wedged run was not caught with server-side logging attached.

## What would close the gap

A control request that cannot be answered has to become a failed attempt rather
than an indefinite await, so the durable queue can retry it and — after
`MAX_TRANSFER_WORK_ATTEMPTS` — surface a `failed` transfer the operator can see.
That is a change to the server's sidecar RPC lifecycle and to how a respawned
sidecar inherits an in-flight transfer, with its own daemon/sidecar teardown
ordering to prove; it is not a test fix and does not belong to the E2E
rehabilitation this quarantine came out of. Remove the quarantine when a
destination-side restart resumes deterministically, and keep the case verbatim
when doing so — it reproduces the defect as written.

## Coverage that remains

The same file still proves, on every run, that a transfer completes with no
renderer participating at all and that a **source**-side server restart resumes.
`crates/kanna-server/src/db/transfer_work.rs` unit-tests the durable queue's
requeue, phase-claim and backoff semantics directly. Neither substitutes for the
quarantined case: only it exercises destination process death against a live
peer, which is why it is skipped rather than deleted.
