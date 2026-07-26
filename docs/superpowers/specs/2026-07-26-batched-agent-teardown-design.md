# Batched Agent Teardown Design

## Context

Agent `Kill` currently removes the session record, then runs
`kill_agent_group_verified` in a fresh `tokio::task::spawn_blocking` job.
Moving the process-table walk off the Tokio worker fixed runtime starvation,
but a burst of N task closes still creates N blocking jobs and performs N
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
- Combine unrelated lifecycle work across ordering boundaries.

## Architecture

### Typed lifecycle jobs

The lifecycle executor will queue an enum rather than only opaque closures:

- ordinary teardown work keeps the existing closure form;
- agent group teardown carries the agent pid, recorded start identity, and a
  one-shot completion sender.

The existing `LIFECYCLE_QUEUE_CAP` remains the admission bound. Ordinary
synchronous callers retain their existing fallback behavior. The new async
agent API waits asynchronously for queue capacity when saturated, so it never
runs a rejected scan inline on a Tokio worker and never grows an unbounded
side queue.

When the lifecycle thread reaches an agent teardown, it gathers the contiguous
agent teardown requests already queued behind it and executes them as one
batch. A short coalescing window lets requests from the same concurrent close
burst reach the queue before the batch is taken. Ordinary jobs retain FIFO
ordering relative to the batch.

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

`kill_agent_session` will replace its ad-hoc `spawn_blocking` call with the
typed `run_agent_teardown_and_wait` API. It still removes the record before
awaiting teardown, holds no registry/shared-state lock during the wait, kills
the owned child directly as a fallback, hands the child to the central reaper,
and performs the existing journal/fanout/`Exit` work after teardown completes.

If the lifecycle executor terminates without returning a result, the session
kill logs that infrastructure failure and continues the existing owned-child
cleanup path.

## Boundedness and ordering

The lifecycle queue contains at most `LIFECYCLE_QUEUE_CAP` admitted jobs.
Additional async agent requests wait for capacity through a notification
boundary; waiting consumes neither a blocking thread nor an additional queued
job. The single lifecycle thread makes full-scan concurrency exactly one.

Batching contiguous requests preserves lifecycle FIFO boundaries: an ordinary
teardown queued between two agent kills is not overtaken. A large concurrent
agent burst may become two batches if the worker starts the first request
before the rest arrive, but it cannot become one blocking job per request.

## Testing

The existing `concurrent_agent_kills_keep_the_runtime_responsive` test will
continue to spawn many real agent children and run a Tokio heartbeat. Lifecycle
test counters will record admitted agent requests and executed agent batches.
The test will hold the lifecycle worker behind a test gate while all kills are
admitted, release it, then assert:

- every kill returns `AgentKillOutcome::Killed`;
- the heartbeat advanced while teardown ran;
- the request delta equals the session count;
- the batch delta is strictly smaller than the request delta (and is one for
  the gated burst);
- every child is eventually dead/reaped.

Focused unit coverage will also verify that batch results preserve input order
and that invalid identities fail independently without preventing valid
members of the same batch from being killed.

This is daemon process-lifecycle wiring, so the real-child daemon test is the
narrowest reliable end-to-end boundary. A packaged desktop E2E would add no
additional evidence for scan batching because the relevant observability
exists only inside the daemon lifecycle executor.
