# Dynamic per-task workflows

## Status and scope

This document specifies a design for a task whose first agent chooses and pins
the rest of that task's workflow after reading the task prompt and repository.
It does not add a dynamic stage engine. The generated result is an ordinary,
linear workflow definition stored in the task's existing `pipeline_def`
snapshot, and every later transition uses the existing snapshot-driven path.

This design builds on three existing properties:

- task creation resolves a named workflow and stores a durable JSON snapshot in
  `pipeline_item.pipeline_def`;
- stage transitions fork workspaces and consult that snapshot, while posts
  continue the running session; and
- agents already create runtime task structure through ordinary task tools, as
  the specialized-review dispatcher does, rather than through engine-owned
  fan-out or join semantics.

The implementation of the pin surface, generator agent, bootstrap workflow,
and user interface is future work. Provider selection on stage advance is also
out of scope; it is tracked separately by task `88ad16da`.

## Decision

Add a public built-in workflow named `dynamic`. Its first and only bootstrap
stage is `in progress`, bound to a purpose-built workflow-planning agent. The
agent reads the prompt, durable delivered directives, repository conventions,
and the relevant code. It then submits a complete one-off workflow definition
for its own task. A successful submission atomically replaces the bootstrap
`pipeline_def`; completing `in progress` then follows the newly pinned
definition.

The generated definition must retain `in progress` as its first stage. The
stage name preserves compatibility with standard fallback workflows; its
agent and prompt make its planning role clear. The definition normally
continues with `build`, selects either a single `review` agent or the existing
`qa-dispatcher`, and ends at `pr`. It may omit review for genuinely mechanical
work or introduce additional build stages when the work has independently
committable phases. It may use the compact provider selectors introduced by
task `7cbd033e`, for example `claude`, `codex-sol`, or `codex-astra-lo`, on a
stage or post.

The pin is a replacement, not a patch. A complete document has one validation
and provenance boundary and leaves no ambiguity about inherited bootstrap
fields. The bootstrap snapshot remains unchanged unless the entire generated
definition validates and the atomic write succeeds.

Example generated shape (illustrative; the selector schema from `7cbd033e` is
authoritative):

```json
{
  "name": "dynamic/61ff7b2d",
  "visibility": "internal",
  "revision_limit": 5,
  "stages": [
    {
      "name": "in progress",
      "agent": "plan",
      "agent_provider": "claude-fable-hi",
      "prompt": "$TASK_PROMPT",
      "policy": { "transition": "manual" }
    },
    {
      "name": "build",
      "agent": "implement",
      "agent_provider": "codex-astra-lo",
      "prompt": "Implement the accepted plan. $PREV_RESULT",
      "policy": { "transition": "manual", "revision_transition": "auto" },
      "post": {
        "name": "commit",
        "agent": "commit",
        "prompt": "Commit the relevant work. $PREV_MAIN_RESULT"
      }
    },
    {
      "name": "review",
      "agent": "qa-dispatcher",
      "agent_provider": "claude-fable-hi",
      "prompt": "Review the completed work. $PREV_RESULT",
      "policy": { "transition": "auto" }
    },
    {
      "name": "pr",
      "agent": "pr",
      "policy": { "transition": "manual" },
      "post": {
        "name": "approve",
        "agent": "approve",
        "prompt": "Approve the PR and signal the merge master. $PREV_RESULT"
      }
    }
  ]
}
```

## Pin surface

### Agent tool

Expose a narrow tool, `kanna_pin_generated_workflow`, rather than widening
`kanna_set_task_workflow`:

```text
kanna_pin_generated_workflow {
  workflow_definition: object,
  expected_stage_run_id: string
}
```

The target is deliberately implicit: it is `KANNA_TASK_ID`, supplied to the
MCP process by the task session. The catalog must not accept an arbitrary task
id. The corresponding server route is:

```text
POST /v1/tasks/{task_id}/actions/pin-generated-workflow
{
  "workflowDefinition": { ... },
  "expectedStageRunId": "..."
}
```

The route uses the same local-process/browser trust classification as other
task actions. In addition, the server authorizes the state transition only
when all of these are true:

1. the task is open and its current pinned workflow is the `dynamic`
   bootstrap (not merely a workflow whose display name happens to be
   `dynamic`);
2. the named stage run is the task's currently running first-stage main run;
3. that run is the bootstrap generator run; and
4. no generated definition has already been accepted for the task.

The expected run id is an optimistic-concurrency fence, not a bearer secret.
Kanna's local-process boundary already grants processes running as the user
control authority; the state checks prevent an ordinary later-stage agent from
rewriting its rail accidentally. The MCP tool additionally refuses when its
environment task id and route task id differ. Remote browser callers still
need the normal desktop control or paired-device credential.

`kanna_set_task_workflow` remains the operator/manager surface for selecting a
named resolved definition on any compatible current stage. It cannot accept
inline JSON and is not the generator contract: it has broader lifecycle intent,
different provenance, and changes `pipeline` to a named choice.

### Atomic behavior

The server validates and normalizes the submitted object, serializes the
canonical snapshot, then updates the task in one transaction. The write:

- replaces `pipeline_def` with the canonical generated snapshot;
- sets `pipeline` to `dynamic` so external surfaces retain the user's selected
  mode (the one-off definition's unique `name` remains inside the snapshot);
- leaves `initial_pipeline`, current stage/run, session, branch, worktree, and
  `revision_rounds` unchanged; and
- appends `task.workflow_generated` in the same transaction.

The current `in progress` run is not killed or restarted. The accepted
definition must contain `in progress` at index zero, so the existing
stage-completion path can advance from it without inventing stage mapping. A
repeated request after a successful pin returns `409 already_generated`; it
never overwrites the first accepted plan. A stale run id also returns `409`,
with no write.

The response contains the canonical definition, its SHA-256 digest, effective
revision limit, and a concise stage summary so the generator can verify what
was accepted before recording stage success.

### Provenance

The event is the durable audit record. `task.workflow_generated` contains:

- task id, current stage, and stage-run id;
- the resolved generator agent name, provider, model, and effort stamped on
  that run;
- the generated definition name and SHA-256 digest;
- generation time, prior snapshot digest, stage names, review strategy, and
  effective revision limit; and
- provenance source `agent` (leaving room for a future operator-authored
  source without conflating it with this tool).

The full definition already lives durably in `pipeline_def`; the event should
not duplicate arbitrarily large JSON. Task detail should expose the generated
provenance summary and digest alongside the pinned workflow so desktop, mobile,
transfer diagnostics, and review tools do not need to infer authorship from a
task log. Recording the active run's stamped identity is attribution to the
agent execution, not a claim that the model cryptographically signed the JSON.

## Validation and guardrails

Pin-time validation is stricter than merely deserializing a historical
snapshot. The server is authoritative. `packages/core` and the published JSON
schema must implement the same rules for authoring feedback, but disagreement
fails closed at the server.

### Structural validation

The submitted definition must satisfy the current workflow schema and Rust
definition loader: known top-level and stage fields only, a non-empty name and
stage array, unique non-empty stage/post names, valid policies, valid
environment references, valid prompt/provider-selector values, and a
non-negative integer `revision_limit` when present. The selector parser from
task `7cbd033e`, rather than a second dynamic-only parser, is used everywhere.

Generated definitions use current syntax only. Legacy `transition`, `mode`,
`post_action`, and interleaved `execution: continue` forms remain readable in
old pinned snapshots but are rejected on this new write surface. This keeps a
new snapshot canonical while preserving existing compatibility reads.

Apply bounded input limits before parsing: at most 32 stages including posts,
256 KiB of JSON, and the existing task-input/prompt field limits. These are
safety ceilings, not recommendations; a normal generated rail should remain
small and reviewable.

### Stage and agent policy

The first stage must be exactly the current `in progress` stage and must
preserve its generator agent binding and manual transition. Later main-stage
names are limited initially to `build`, numbered `build-<n>` phases, `review`,
and `pr`; posts are limited to `commit` and `approve`. A generator cannot
create a new lifecycle concept merely by spelling one in JSON. Repeated
main-stage names or a post name colliding with any main/post name are rejected.

Every referenced agent must resolve from the task's repository definitions at
pin time. Public resolved agents are allowed. Internal agents are denied as
main stages unless explicitly allowlisted for system composition; initially
that allowlist is `qa-dispatcher` for `review`. Internal post agents are limited
to the existing lifecycle bindings `commit` and `approve`, in their usual
positions. `specialty-review` and `architect-consultation` remain explicit
child-task workflows, not stages a generator can splice into a parent rail.
This retains the visibility contract: internal means resolvable by an
intentional Kanna composition, not generally selectable.

The last main stage must be `pr`, with the normal `approve` post. Review, when
present, precedes it. A `qa-dispatcher` review keeps all fan-out and join rules
from `qa-dispatch-review.md`; the generated snapshot selects that existing
agent but does not encode child tasks or specialties. A simple review binds the
ordinary `review` agent. A no-review choice must be represented by omitting the
review stage, not by inventing a pass-through agent.

Generated definitions must declare `"visibility": "internal"`. Snapshot
visibility never adds the one-off name to repo manifests or pickers; listings
continue to show the public bootstrap choice `dynamic`. The unique name should
be `dynamic/<task-id>` for diagnostics and must not resolve as a named repo
workflow.

### Revision budget

Omitting `revision_limit` has exactly the established meaning: its effective
value is the product default of 5. The generator should normally emit 5
explicitly so the plan is self-describing. `0` retains its existing meaning
of no cap but is rejected for generated workflows; an agent may choose a
smaller positive bound, not remove the human-safety limit. Already spent
`revision_rounds` are never reset by pinning.

### Failure behavior

Malformed, unsupported, incompatible, stale, or unauthorized definitions
return a structured `4xx` validation response and do not change either
`pipeline_def` or task state. Errors identify JSON paths and all independently
detectable violations so the still-running generator can correct and retry.
Pin failure does not complete, fail, or advance the run.

If the generator records success or exits successfully without an accepted
pin, the server does not attempt to interpret terminal output. Instead it
atomically pins the bundled internal `dynamic-fallback` definition and advances
through the normal completion path, appending
`task.workflow_generation_fallback` with the run id and reason `missing_pin`.
That definition retains the completed `in progress` generator stage, then uses
the standard `build` → single `review` → `pr` shape and lifecycle posts. Thus
fallback has single-reviewer depth without accidentally treating planning as
implementation and advancing straight into review. A generator-reported
failure, process failure, or exhausted retry remains a failed/parked
`in progress` run for the human; it does not silently turn implementation
failure into work on a guessed plan. The task detail offers an operator action
to apply the same fallback and retry the transition. Thus bad JSON cannot wedge
the task, while genuine analysis failure remains visible.

Fallback resolution uses Kanna's bundled internal definition, not a repo file
shadowing `single-reviewer` or `dynamic-fallback`: it must be available even
when repository definitions are the source of the generation error. Its
pinned snapshot is ordinary and transfers like any other. The internal
definition is a bundled resource, not a TypeScript or Rust string constant.

## New-task UX and configuration

`dynamic` is a public built-in definition and appears as **Dynamic** in the
New Task workflow picker, with copy explaining that a planning agent chooses
the build stages and review depth. The task card/detail initially shows
`Dynamic · planning`; after pinning it shows `Dynamic · <stage summary>` and
the generated provenance. The one-off `dynamic/<task-id>` name is diagnostic,
not another picker entry.

Repositories opt in with the existing key:

```json
{ "workflow": "dynamic" }
```

No new config shape or embedded JSON is introduced. Recent-workflow stickiness
continues to operate on `initial_pipeline = dynamic`, so generated snapshot
names never become sticky choices.

Existing built-ins remain the product default at launch. Specifically, a repo
with no `workflow` keeps the existing `no-review` fallback, and existing repo
configuration is unchanged. A repo may make `dynamic` its default, and a user
may select it explicitly. Making dynamic the global default is a later product
decision after generation quality and fallback rates are observable; it does
not require another engine design.

## Plan-build-review interaction

Task `e463e67e` introduces the fixed `plan-build-review` rail: plan → build →
review → pr, with plan/review provider choices and a plan agent whose output
ends in a builder-tier recommendation. Dynamic mode should reuse that planning
contract and vocabulary rather than create a competing notion of task
complexity. The difference is ownership of structure:

- `plan-build-review` is a stable named workflow selected before creation;
- `dynamic` begins with the same kind of plan, then pins a task-local rail that
  may vary build stages and review depth.

The generator may encode a provider selector directly in the generated build
stage. Acting on a builder-tier recommendation at the moment a human or agent
advances an already-fixed plan stage is the separate stage-advance override
slice in task `88ad16da`. This spec neither defines that request field nor its
provider/model/effort precedence.

## Transfer and version compatibility

A generated definition is part of the task snapshot and therefore travels in
the existing task-transfer artifact with its provenance summary/event. The
destination must validate support before accepting ownership, not discover an
unknown selector after the source task has shut down.

Compact provider selectors from task `7cbd033e` parse only on upgraded servers.
Accordingly, transfer negotiation must advertise a workflow-definition format
capability (or minimum server version) that includes selector support. If the
snapshot contains compact selectors and the destination lacks that capability,
the transfer is rejected before finalization with
`incompatible_workflow_definition`; the source task remains open and runnable.
Kanna does not strip selector suffixes, substitute providers, or downgrade the
snapshot, because that would change the authored execution plan.

The same posture applies to future generated-definition syntax: snapshots are
portable only to a server that declares it can parse every feature they use.
Definitions using only the older provider vocabulary may transfer to older
servers if their existing artifact/version checks otherwise allow it. Dynamic
generation itself need not be available on the destination once a compatible
ordinary snapshot has been pinned.

## Rejected alternatives

### Let the engine ask an agent before every transition

Rejected because it creates a second, nondeterministic transition engine and
makes resume, transfer, and revision behavior depend on fresh model output.
One planning run followed by an immutable snapshot preserves current lifecycle
semantics.

### Write `.kanna/workflows/<task>.json`

Rejected because the definition is task state, not repository configuration.
It would dirty the worktree, leak a temporary choice into commits and listings,
and disappear across stage worktree forks unless committed. `pipeline_def` is
already the durable boundary designed for this data.

### Add inline JSON to `kanna_set_task_workflow`

Rejected because the existing tool is a broad operator/manager action that
resolves a named definition and requires current-stage compatibility. Mixing
it with generator-only self mutation weakens authorization and makes
provenance ambiguous.

### Patch or append stages to the bootstrap snapshot

Rejected because merge semantics for policies, posts, environments, and
revision limits would become another workflow language. A complete replacement
is easier to validate, hash, display, transfer, and audit.

### Fall back after every rejected pin

Rejected because a validation error is recoverable while the generator is
still running. Automatic fallback occurs only when a successful generator run
ends without a pin; actual generator failures stay visible for human recovery.

## Implementation and verification outline

Implementation should cover the whole boundary rather than only the database
write:

1. add the bundled `dynamic` workflow and generator/plan agent, plus schema and
   definition-loader guardrails in Rust and `packages/core`;
2. add the catalog/MCP/CLI route, atomic DB mutation, provenance event, task
   detail fields, and fallback at stage completion;
3. carry the new snapshot/provenance capability through transfer negotiation;
4. add desktop and mobile presentation for bootstrap, generated, rejected, and
   fallback states; and
5. add an end-to-end test that creates a dynamic task, pins a definition from
   its live first run, advances into the selected build/review rail, and proves
   persistence across server restart. Add transfer E2E coverage for compatible
   and incompatible selector snapshots.

Unit/contract coverage must also prove that invalid input leaves the original
snapshot byte-for-byte unchanged, stale/concurrent calls lose safely, hidden
agents cannot be smuggled into generated main stages, revision rounds survive,
success-without-pin selects the bundled fallback, listings never expose the
one-off name, and Rust/schema/TypeScript accept the same selector vocabulary.
