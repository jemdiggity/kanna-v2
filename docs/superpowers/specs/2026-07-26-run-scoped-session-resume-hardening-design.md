# Run-Scoped Session Resume Hardening Design

## Goal

Restore reliable revision resumption without coupling a durable task, a stage
run, and a provider conversation to the same daemon session identifier.

The implementation must also resolve the four current review findings:

- active Codex/OpenCode turns must not make agent control commands unresponsive;
- retrying a revision after response loss or server restart must not accept a
  second revision;
- an old process exit must never be attributed to a successor run; and
- resumed-workspace setup and provider spawn must not continue unless the
  blocking teardown is confirmed stopped.

## Identity Model

Kanna will treat the relevant identities as separate:

- **Task ID** identifies the durable product task across every pipeline stage.
- **Stage run ID** identifies one immutable execution attempt.
- **Daemon session ID** identifies one local process/terminal lifetime and is
  unique per stage run.
- **Provider session ID** identifies the provider-native conversation that can
  be resumed across daemon sessions and stage runs.
- **Workspace ID** identifies the branch/worktree used by one stage run.

Claude and Copilot can receive a provider session ID at initial launch. Codex
and OpenCode can publish their provider session ID after launch or at process
exit. That difference affects only how `provider_session_id` is populated; it
does not require reusing the daemon session ID.

Every newly prepared stage run will receive a fresh daemon session ID derived
from its immutable run ID. `stage_run.session_id` remains the authoritative
binding. `stage_run.provider_session_id` remains the provider resume handle.
When a revision resumes a conversation, the successor gets a new daemon
session ID and passes the recorded provider session ID to the provider's resume
command.

Task-facing terminal and KSP operations continue accepting a task ID. They
resolve that task to its current running stage run and then address that run's
daemon session ID. No caller needs to know or preserve a stable daemon session
ID.

## Stage Transition Flow

A revision transition will use the following order:

1. Resolve the exact source run and the target workspace.
2. Allocate the successor run ID and its unique daemon session ID.
3. Durably reserve the successor and its workspace transition.
4. Kill the source run by its recorded daemon session ID and immutable run ID.
5. If resuming an existing workspace, kill the workspace's blocking teardown
   session and wait for an unambiguous stopped/not-found result.
6. Only after both required kills are confirmed, run deferred workspace setup.
7. Spawn the successor under its new daemon session ID, passing the provider
   session ID only as the provider resume binding.
8. Atomically land the reserved run and point task-facing resolution at it.

Failure or ambiguous transport loss at either required kill aborts before setup
or spawn. The pending successor is rolled back and the source task state is
restored. A later user retry repeats ownership checks and must confirm that the
old session and teardown are absent or kill them successfully before
continuing.

Because source and successor daemon session IDs differ, delayed source events
cannot match the successor. Replacement bookkeeping, where still needed to
classify an orchestrated kill as non-completion, is keyed by the source daemon
session and immutable source run. It is never transferred to or consumed by a
successor.

## Active Per-Turn Input

Codex and OpenCode use per-turn child processes. While one child is still
active or being reaped, a second `AgentInput` cannot safely reserve or start a
successor child.

The daemon will return an immediate, explicit busy error for that second input.
It will not poll the global `AgentSessions` mutex. Once EOF bookkeeping marks
the child exited, a later input can reserve and spawn the next turn normally.

The immediate response is important because KSP deliberately maintains an
ordered control connection. An unbounded `AgentInput` handler blocks every
later command on that connection even if the global mutex itself is released
between polls. Returning busy allows permission decisions, interrupts, model
updates, and commands for other tasks to remain responsive.

## Revision Request Idempotency

The desktop will assign one stable idempotency key to each user-initiated
revision action and reuse it for every HTTP retry of that action.

The server will persist a revision-action ledger containing:

- idempotency key;
- durable task ID;
- action kind;
- serialized request payload;
- pending successor run ID when one has been reserved;
- terminal result state;
- HTTP status and serialized response body; and
- creation/update timestamps.

Claiming a new key is atomic. Reusing a key with different task, action, or
payload returns a conflict. Reusing a completed key returns the stored response
without preparing or spawning another revision.

The ledger is linked to the durable pending stage action. Reserving a successor
records its run ID on the ledger in the same database transaction. Landing or
rolling back the pending stage action finalizes the ledger result in the same
transaction. This closes the crash window between committing the transition
and recording the HTTP result.

On startup, pending stage-action reconciliation runs before HTTP serving. It
also finalizes linked request records:

- a live accepted successor is landed and recorded as success;
- an unaccepted successor is rolled back and recorded as failure; and
- a claimed request with no successor reservation is recorded as interrupted
  failure.

An in-process duplicate of a pending key receives a retryable conflict rather
than executing concurrently. The desktop retries that response with the same
key within its existing bounded request deadline. Existing callers that do not
send an idempotency key remain source-compatible. Other clients can adopt the
same replay guarantee by supplying a stable key for their own retries.

## Exit and Replacement Semantics

A successful daemon kill continues to emit a killed `Exit` for the exact
daemon session and run it removed. Already-exited persistent agents are covered
as well: removing their retained record emits the expected killed
acknowledgment before the kill reply.

Run-scoped daemon session IDs make this acknowledgment safe and local. Even if
the watcher processes it late, it can only classify the source run's
termination; it cannot consume or complete a successor with another session
ID. Mixed-version ownership fallback remains limited to old sessions that lack
immutable run IDs.

## Compatibility and Migration

The SQLite schema change is additive. Existing stage runs keep their recorded
daemon session IDs. New runs use run-scoped IDs; resolution already prefers the
current running stage run, so old tasks continue working during the transition.

Provider resume behavior is unchanged:

- fresh Claude/Copilot sessions keep their caller-assigned provider UUIDs;
- resumed Claude/Copilot sessions use their recorded provider UUIDs;
- Codex/OpenCode persist discovered provider IDs on provider-change or exit
  events; and
- successors pass the provider ID to the existing resume command or adapter.

No release dependency or external runtime library is introduced.

## Verification

Implementation proceeds test-first with regressions for:

- a long-running Codex and OpenCode turn receiving a second input while
  permission, interrupt, model, and other-task commands complete within bounded
  time;
- a revision response being lost after commit and replayed from the durable
  ledger without another run/workspace;
- a server restart at each pending revision boundary followed by deterministic
  success or failure replay;
- a completed persistent Claude process being killed, followed by a new
  run-scoped session whose natural exit is not swallowed;
- failed and response-lost blocking teardown kills proving setup and provider
  spawn never occur; and
- task/KSP resolution following the newly landed run-scoped daemon session.

Focused daemon, Kanna server, desktop store, database migration, and task
creator tests will run before the canonical repository checks.

## Review Revision: Task-Facing Routing and Recovery Bounds

The review pass exposed five remaining places where durable task identity and
run-scoped process identity were still conflated.

Task input will continue accepting a durable task ID or branch, but the HTTP
route will resolve that alias through `Db::resolve_task_terminal_session_id`
before writing to the daemon. Unknown task aliases fail before daemon I/O.

Close paths need more information than input routing. The database will expose
the latest process binding as a daemon session ID plus an optional immutable
owner run ID. Current ownership-version rows may supply this binding even after
the final main or injected post run has succeeded, because the provider process
can remain alive at its prompt. For a post row, the immutable process owner is
`resumed_from_run_id`; for a main row, it is the run's own ID. Both explicit
close and final-stage close will kill this binding with
`kill_session_replacing_if_owned`, then independently clean up the workspace
shell and teardown sessions.

Migration-023-era rows are not trusted as daemon ownership merely because they
are marked running. Those rows can store the provider CLI UUID in
`stage_run.session_id`, have a null `provider_session_id`, and retain ownership
version zero after migration 030. Read-time routing will therefore use stage-run
session IDs only for current ownership-version rows. Ownershipless rows fall
back to the existing `terminal_session` mapping, avoiding a speculative
database backfill.

Successor reservation changes task activity to `working`. The same transaction
will increment `activity_revision` only when the prior activity differs from
`working`, preserving the compare-and-set contract used by mark-read clients
without inventing revisions for no-op writes.

Startup pending-action recovery remains fail-closed, but every daemon response
needed before HTTP serving will be deadline-bounded. Subscription
acknowledgement and `List` each receive an explicit response timeout. A timeout
returns an error without landing or rolling back the pending action; the server
startup path exits, leaving durable state intact for the next supervised
startup attempt.

The revision is verified with route-level fake-daemon tests for input and both
close variants, a legacy database fixture, activity-revision coverage through
both successor reservation APIs, and a connected daemon that accepts startup
connections but never responds.
