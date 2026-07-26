# Review Race Hardening Design

## Goal

Resolve the three review findings from the task revision lifecycle work:

- prevent a stalled agent client socket from blocking unrelated daemon agent operations;
- make legacy relay task mutations share the same task-scoped action flight and ownership checks as HTTP actions; and
- keep generic CLI stage completion compatible with valid pre-upgrade tool-catalog overrides.

## Daemon Agent Event Delivery

The agent journal remains the authoritative, sequence-numbered source of events. Generation validation and journal append must occur atomically under the per-session shared-state lock so output from a replaced child cannot enter the successor's journal.

Attached clients will receive events through byte-budgeted, per-writer mailboxes drained by independent writer tasks, following the daemon's existing PTY fan-out design. Journal append only enqueues a pre-serialized event and never awaits socket progress. Snapshot creation and mailbox registration remain under the same per-session lock, preserving the snapshot-to-live cutover: each event appears either in the snapshot or in the registered live mailbox, never neither. A mailbox that would exceed its byte budget is removed and its socket is shut down, forcing the client to reconnect and replay from the authoritative journal instead of silently missing live events.

The daemon-wide agent registry lock will only validate or mutate session ownership and status. It will not be held while appending to a journal or performing client I/O. For persistent input, the flow is:

1. capture the session identity and generation;
2. revalidate and write to the owned child stdin;
3. append and enqueue the user event without the registry lock;
4. reacquire the registry, revalidate generation, run id, and shared-state identity, then set the status to busy.

If ownership changes at either validation point, the command returns a write failure and does not mutate the replacement session.

The regression test attaches a client that cannot drain its event mailbox, causes delivery to stall for one session, and proves an operation on a different agent session completes within a short timeout.

## Legacy Relay Task Mutations

Legacy relay `close_task` and `advance_stage` invokes will be translated into the corresponding authenticated HTTP action requests:

- `close_task` becomes `POST /v1/tasks/{task_id}/actions/close`;
- `advance_stage` becomes `POST /v1/tasks/{task_id}/actions/advance-stage`.

The translation occurs before opening a short-lived daemon connection. This removes the direct mutation implementations from the legacy command handler and makes both relay protocols use the same `Arc<AppState>`, durable task-id resolution, task-scoped action flight, detached transition execution, session replacement ownership, blocker notification, teardown, and state-change publication.

HTTP status failures are converted to the legacy relay error response. Successful JSON action responses remain legacy relay data; a successful no-content close remains `null`.

The race regression starts an HTTP mutation that holds the task action flight, races the conflicting legacy relay mutation, and asserts that the legacy request receives a conflict without reaching lifecycle or daemon mutation work. The test then releases the HTTP owner and verifies the flight is reusable.

## Generic CLI Catalog Compatibility

The generic CLI will resolve caller-provided arguments against the active catalog before adding process-owned stage-run identity. For `kanna_complete_stage`, a non-empty `KANNA_STAGE_RUN_ID` is inserted as camel-case `runId` into the already resolved HTTP request body. The environment-owned value overrides any caller-supplied catalog argument, matching the MCP implementation and preventing ownership spoofing.

Because the synthetic field is added after validation, a valid old override catalog that does not declare `run_id` continues to resolve. Other unknown caller arguments remain rejected normally.

The contract test writes an old override catalog under a temporary working directory, runs the current `kanna-cli tool call kanna_complete_stage` binary with `KANNA_STAGE_RUN_ID`, and verifies the outgoing HTTP request includes `runId` even though the override schema does not.

## Error Handling and Compatibility

- A full or closed daemon writer mailbox disconnects only that subscriber; it does not block journal persistence or other sessions.
- Generation mismatches remain explicit command failures and cannot change successor status.
- Legacy relay mutation errors retain id-addressed legacy responses while using HTTP status and error text internally.
- Existing HTTP, MCP, typed CLI, and current bundled-catalog behavior remains unchanged.

## Verification

Implementation will proceed test-first with focused regressions for each finding, followed by:

- daemon unit/integration tests covering agent sessions and stalled delivery;
- Kanna server relay dispatch and task-action tests;
- Kanna CLI unit and `tool_call` contract tests; and
- the relevant Rust workspace checks through the repository's canonical `./kd test rust` workflow where practical.
