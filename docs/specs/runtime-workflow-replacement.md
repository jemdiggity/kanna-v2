# Runtime workflow replacement

Implemented 2026-09-08. An operator or manager can edit one open task's durable
`pipeline_def` with `kanna_replace_task_workflow` (CLI `task replace-workflow`).
This is a whole-definition replacement: read `workflowDefinition` from task
detail, edit a copy, and submit both the unchanged `expected_definition` and
the edited `workflow_definition`. The server returns 409 if the expected
snapshot is stale. JSON object key order is immaterial.

```text
kanna-cli task replace-workflow --task-id <id> \
  --expected-definition '<workflowDefinition from task detail>' \
  --workflow-definition '<complete edited definition>' --source operator
```

The HTTP route is `POST /v1/tasks/{task_id}/actions/replace-workflow`, with
camelCase `expectedDefinition`, `workflowDefinition`, and `source` fields.
The tool catalog owns the MCP and generic CLI mapping; the typed CLI delegates
to that same catalog path. Normal task-mutation access checks apply.

## Contract

- Replacement changes only the target task's pinned definition. It preserves
  the selected workflow name, creation-time sticky choice, current stage,
  live session/run, worktree/branch, and spent revision rounds.
- Current and historical main/post names must remain, with the same main/post
  role, post owner, and relative order. Names absent from history and not currently occupied
  may be added, removed, renamed, or reordered. Existing names may have their
  settings edited; this does not rewrite historical run records.
- The next transition reads the new definition. A rerun or recovery reads it
  too. If a stage's agent, provider candidates, prompt, or effective environment
  changed, its existing runs are explicitly superseded as execution templates.
  Their next rerun, recovery, or revision starts a fresh conversation and
  resolves the edited definition through the ordinary precedence chain.
  Recovery/revision records why it could not resume the old conversation.
  A stage that never spawned also releases its creation-request override
  when its execution binding is edited. Once the new run starts, its stamp is
  reproduced normally on later retries.
- Unchanged execution bindings keep their provider/model/effort stamps. A
  future-stage edit does not release the current stage's stamp. Description,
  policy, and revision-limit edits do not require a fresh conversation.
  A live run's stamped completion policy remains in force until it finishes;
  its next run receives the new policy. Posts already running also finish
  under their existing stamps. A post injected into a surviving live session
  uses that session; changing its provider applies when a fresh post session
  must be spawned.
- New submissions satisfy the bundled `.kanna/workflows/schema.json`, the
  existing provider selector parser, and repository agent/environment
  resolution. Named internal agents remain explicitly resolvable. A quota or
  future CLI outage is not statically detectable and is not validation failure.
  Unknown fields, agents, selectors, environments, duplicate stage/post names,
  and history-breaking edits fail without a write. Definitions are limited to
  256 KiB and 32 stages including posts. Errors name the invalid JSON path or
  stage/binding.
- Historical snapshots still compile legacy `post_action` and interleaved
  `execution: continue` into posts. The replacement must use current schema
  syntax; compatibility checks compare against the compiled old definition.
  The unchanged raw old object is still the optimistic-concurrency fence.

## Provenance and implementation boundary

The named `kanna_set_task_workflow` action and inline replacement share the DB's
atomic pin-write path. Named switching retains its existing lifecycle contract
and tests. The inline authoring boundary adds schema/history validation and
explicit execution supersession. Neither changes repository config or files.

The same transaction appends `task.workflow_changed` with full before/after
snapshots, operation (`select` or `replace`), caller-declared source (`operator`,
`manager`, `agent`, or default `unspecified`), current stage, revision budget,
changed execution stages, and superseded run IDs. Workflow change events are
retained beyond the ordinary feed's 14-day pruning window because they are
also durable audit and execution state. The event envelope supplies task ID, sequence and
creation time. Source is attribution, not authenticated identity. Historical
run provider stamps are retained as facts, while the event explicitly says
which cannot govern a new execution. No wall-clock comparison is used.
Identical canonical replacements are no-ops and emit no new event.

This is not another provider-override layer. The existing `agentProviders`,
`config.local.json`, stage selectors, per-advance overrides, and provider/model
coherence rules remain intact. Only an explicit execution edit stops treating
an older run as the execution being reproduced. The same provider chain then
selects the new run, and the new stamp governs subsequent reproductions.

## Choice of surface

Whole-definition replacement supports all ordinary linear workflow settings
and has one validation/concurrency/audit boundary. JSON merge patch would
replace stage arrays wholesale anyway while introducing null/deletion and
nested inheritance semantics. Typed provider-only edits solve the incident but
cannot express the owner's general request. A separate inline tool shares the
existing pin-write implementation without making named workflow selection
ambiguous.

This follows `dynamic-task-workflows.md`'s atomic complete-snapshot design. It
is the operator/manager editing surface, not the future generator self-pin
contract: there is no dynamic bootstrap authorization, generator allowlist,
automatic fallback, or new workflow mode in this change. The generator-specific
proposal remains future work.

The adjacent failure of a provider candidate chain to recover from quota
exhaustion after launch remains a separate issue and is intentionally unchanged.

## Verification

The remote task-actions E2E creates real tasks with deterministic CLI fixtures,
pins a stage to Claude/Fable, runs a fixture that exits with a quota error,
replaces its candidates through the real CLI, then reruns the same task on
Codex/Astra and observes its PTY. It checks the task/worktree identity and an
unrelated task's snapshot and run. HTTP/catalog/DB tests cover stale requests,
invalid definitions, durable audit, supersession isolation, no-ops, and future
stage edits; the existing named-switch suite remains in the gate.
