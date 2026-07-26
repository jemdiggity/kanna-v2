# Batched Agent Teardown Design

## Context

Agent `Kill` currently removes the session record, then submits
`kill_agent_group_verified` through
`kanna_daemon::reaper::run_teardown_and_wait`. That central lifecycle executor
keeps the process-table walk off Tokio workers and bounds admitted work, but a
burst of N task closes still creates N lifecycle jobs and performs N
independent host process-table scans.

PTY teardown already avoids both failure modes. It admits process lifecycle
work to the daemon's single bounded lifecycle executor and uses
`proc_info::freeze_many` to share each process-table snapshot across a batch of
kill plans.

## Goals

- Admit every live agent teardown through the central bounded lifecycle
  executor.
- Coalesce concurrent agent kills so one lifecycle batch shares each
  process-table snapshot across the batch.
- Keep all process-table enumeration and destructive signaling off Tokio
  workers and outside agent-registry/shared-state locks.
- Preserve per-session completion, identity verification, descendant cleanup,
  exactly-one `Exit`, and prompt client responses.
- Add deterministic coverage proving that concurrent requests are executed in
  fewer lifecycle batches than requests while the runtime heartbeat continues.

## Non-goals

- Change PTY teardown behavior.
- Change agent `Kill` protocol responses or handoff-seal semantics.
- Add a time-based process snapshot cache. A snapshot taken before leaders are
  frozen can miss descendants and is not a safe teardown boundary.

## Architecture

### Agent batching above the lifecycle executor

The checkpoint is retargeted above the finalized agent-incarnation prerequisite
at `4f10ee48`. Its finalized central lifecycle/reaper implementation from
`541717e2` remains the sole bounded executor and is not modified by this task.
An agent-specific coalescer in `agent.rs` holds pending pid/start identities
and per-request one-shot completion senders.

The first request in a burst schedules one opaque `TeardownJob` through
`try_run_teardown`; if the lifecycle cap is full, that same owned job follows
the executor's async `run_teardown` backpressure path. Later concurrent
requests join the pending agent batch instead of admitting more lifecycle
jobs.

When the lifecycle owner runs the agent job, a short coalescing window lets
the rest of the close burst arrive. It drains the pending requests, performs
one batched verified kill, sends each result to its original caller, and
continues draining requests that arrived during the scan before relinquishing
the scheduled slot. No process scan or destructive signal runs on a Tokio
worker.

### Batched verified agent kill

`agent.rs` will expose a batch implementation alongside the existing
single-agent API:

1. Validate each raw pid and start-time identity.
2. Freeze each leader with `stop_verified`. Failed leaders receive an
   individual error and are excluded from destructive signaling.
3. Pass every successfully frozen leader to `freeze_many` with no controlling
   terminal, sharing one process-table snapshot per discovery round.
4. Strike each verified process group, kill its frozen descendants through
   `signal_verified`, and preserve the current direct-pid fallback.
5. Return results in request order.

The single-agent function delegates to the same plan/strike logic so the
identity and error behavior have one implementation.

### Agent session lifecycle

`kill_agent_session` will replace its per-kill `run_teardown_and_wait` closure
with `agent::kill_agent_group_batched`. It still removes the record before
awaiting teardown, holds no registry/shared-state lock during the wait, kills
the owned child directly as a fallback, hands the child to the central reaper,
and performs the existing journal/fanout/`Exit` work after teardown completes.

If the lifecycle executor terminates without returning a result, the session
kill logs that infrastructure failure and continues the existing owned-child
cleanup path.

## Boundedness and ordering

The central lifecycle cap counts queued and in-flight jobs. A concurrent agent
burst contributes one such job; additional agent requests occupy the bounded
session registry plus the coalescer's pending queue, not lifecycle slots or
blocking threads. The single lifecycle owner makes full-scan concurrency
exactly one.

A large or sustained burst may require more than one shared process-snapshot
batch if requests arrive while an earlier scan is executing, but it still
uses one lifecycle job until the coalescer becomes idle.

## Testing

`concurrent_agent_kills_share_one_lifecycle_job_and_snapshot_batch` spawns many
real agent children and runs a Tokio heartbeat. Agent teardown diagnostics
record requests, executed process-snapshot batches, and lifecycle jobs.
The test will hold the lifecycle worker behind a test gate while all kills are
admitted, release it, then assert:

- every kill succeeds;
- the heartbeat advanced while teardown ran;
- the request delta equals the session count;
- the lifecycle-job delta is one;
- the process-snapshot batch delta is one for the gated burst;
- every child is eventually dead/reaped.

Focused unit coverage will also verify that batch results preserve input order
and that invalid identities fail independently without preventing valid
members of the same batch from being killed.

This is daemon process-lifecycle wiring, so the real-child daemon test is the
narrowest reliable end-to-end boundary. A packaged desktop E2E would add no
additional evidence for scan batching because the relevant observability
exists only inside the daemon lifecycle executor.
