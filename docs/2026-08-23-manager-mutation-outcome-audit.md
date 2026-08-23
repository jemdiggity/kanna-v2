# Manager mutation outcome audit (2026-08-23)

Audited manager-facing mutations: stage advance, close, revision request, and task input.

- Close commits `closed_at` only after fallible daemon shutdown and worktree snapshot work succeeds. Completion notification and dependent wake-up happen after commit through best-effort paths, so their failure is logged and cannot produce the historical false 500 for a close that landed.
- Task input fences delivery to the observed live PTY. Definite rejection records no delivered input. `delivery_uncertain` explicitly says the daemon may have accepted it and forbids blind retry; `input_held_by_draft` explicitly says the message is queued but not delivered. Durable input recording after accepted delivery is best-effort and cannot turn delivery into a false failure.
- Advance and non-exhausted revision responses are acceptance/scheduling responses because daemon/git execution continues under the server's serialized task-mutation lease. Tool descriptions now state that distinction and direct managers to durable run/stage/close events for the outcome; detached failures are recorded on the task rather than returned as a synchronous false success/failure claim.
- Revision budget-resolution and preparation failures previously could close the current review run before returning an error. The handler now leaves the run untouched until revision preparation succeeds and releases a claimed automatic round when preparation fails.

Remaining architectural follow-up: revision acceptance still coordinates SQLite state with fallible git/worktree preparation, so it cannot be one cross-resource ACID transaction. A future operation ledger could expose a durable operation id and terminal outcome for every detached mutation. This is not required to make current responses truthful: today they explicitly mean accepted/scheduled, and task events carry the durable result.
