# Mobile Task Creation Provisioning Design

## Goal

Give mobile task creation a technical provisioning experience without allowing
a stalled or lost response to trap the app or a retry to create a second durable
task.

## Correctness Boundary

The desktop inserts the durable task before worktree setup and agent spawn
finish. A LAN fetch or relay invocation can therefore fail or remain unsettled
after the task exists. Mobile must distinguish three outcomes:

- `pending`: the original request has not settled;
- `uncertain`: the request rejected or the app restarted, but mobile cannot
  prove the desktop did not create the task; and
- `idle`: no attempt is unresolved because creation succeeded or a typed error
  proves rejection happened before creation.

Elapsed time must never move `pending` or `uncertain` to `idle`.

## Idempotent Creation Identity

Before submission, `mobileController` generates a high-entropy lowercase-hex
task id and persists it with an immutable snapshot of repo, prompt, desktop,
and agent. Mobile sends that identity through a dedicated idempotent
`PUT /v1/tasks/{taskId}` endpoint. The server validates the path id, uses it
instead of generating one, and treats a replay as an idempotent lookup. A
replay with the same repo and prompt returns the existing task; mismatched reuse
returns `409 Conflict`. Existing `POST /v1/tasks` callers keep server-generated
ids and current behavior. The method/path boundary is deliberate: an older
desktop rejects the unknown PUT without creating anything instead of silently
ignoring a new JSON field and duplicating a task on recovery.

If concurrent requests race between lookup and insert, the losing request
never creates another workspace. An in-process per-id flight guard also keeps a
replay from treating the newly inserted row as settled while the owning request
is still in rollback-sensitive provisioning; that replay receives a fast
in-progress error and remains uncertain. Once the owner exits, a later recovery
returns the settled durable task (or creates it if the owner rolled back).
Recovery can therefore replay only the exact frozen request and id. A lost
response, a 500 after insertion, a concurrent call, or an app restart can never
produce a second durable task.

## Controller and Persistence

The controller owns one ordinary create promise and one explicit recovery
promise. Two synchronous `createTask()` calls return the same promise and issue
one client request. Recovery is separately single-flight because it may need an
independent LAN/relay invocation while the original call is stuck; it always
uses the same idempotent task id.

The pending attempt is part of the existing persisted session context. Store
subscription writes are serialized, and initial submission awaits the exact
attempt's durable write before invoking LAN or relay. A persistence failure is
therefore definitely pre-request. Hydration maps a saved attempt to `uncertain`,
because an in-memory request cannot survive process death. Original and
recovery settlements mutate state only while their task id is still the current
attempt, fencing late responses from older work.

The client error contract includes `TaskCreationError` with `not-created` and
`unknown` outcomes. Unknown is the default. Only a typed `not-created` error
restores the editable composer. The disconnected client and persistence barrier
may use it because no request crossed the creation boundary. Once a LAN fetch
or relay invocation starts, every untyped rejection remains uncertain; status
codes alone are not a durable no-side-effect contract.

## User Experience

Submitting replaces the editable composer with the existing terminal-inspired
panel. Prompt, options, Create, and Cancel are absent while an attempt is
pending, recovering, or uncertain. The backdrop remains inert.

The panel always offers **Continue in background**. Android request-close uses
the same action. This hides the modal without cancelling, clearing the frozen
draft, or enabling a fresh Create. Opening New Task while an attempt is
unresolved reopens that attempt.

For an uncertain outcome, the panel explains that the desktop may already have
created the task and offers **Recover task**. Recovery resends the same
idempotent request. The same action is available for an unusually long pending
request. Failed recovery returns to the uncertain panel and remains dismissible.

If creation succeeds while visible, the composer closes and the task opens. If
the user continued in the background, success updates task collections without
stealing the current view. Definite pre-creation failure restores the original
form and inline error. Ambiguous failure never exposes a fresh Create.

## Store and Component Boundaries

The store exposes `taskCreationPhase`, `pendingTaskCreation`, and a
composer-specific repo id. Composer visibility is independent of creation
phase, and the frozen route stays truthful if the user changes task-list repo in
the background.

`CreateTaskComposer` remains presentation-only. It receives the phase plus
continue-background and recover callbacks. Shared ids cover the provisioning
container and both recovery actions.

## Testing

Rust tests prove a PUT path id creates once, replay returns the same task,
mismatched reuse conflicts, a lookup/insert race cannot duplicate, a concurrent
replay cannot report success before the owner settles, and callers using legacy
POST remain compatible. Transport tests prove the id selects PUT, is encoded in
the path, and is omitted from the request body.

Store/controller tests prove persistence, restart uncertainty, ordinary and
recovery single-flight behavior, safe backgrounding, definite and ambiguous
failures, idempotent recovery, and late-response fencing.

Focused component tests prove mutually exclusive editable/provisioning states,
explicit escape, inert backdrop, request-close behavior, and uncertain copy.
`App.component.test.tsx` mounts the real composer with the real controller/store
and a deferred client to cover the entire request-to-modal boundary.

Appium remains inappropriate until the harness can provide an isolated fake
repo, record requests, suppress agent spawn, and clean up durable task/worktree
state deterministically.

## Alternatives Rejected

- **Blind timeout:** elapsed time cannot prove non-creation.
- **Task-list matching:** prompt/repo metadata is not a unique creation identity
  and local ids can later become cloud-canonical.
- **In-memory backgrounding only:** force-quit would forget ambiguity and permit
  a duplicate retry.
