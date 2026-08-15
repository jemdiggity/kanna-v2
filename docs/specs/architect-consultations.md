# Architect Consultations

Kanna's canonical architect is a bounded, on-demand advisor for approach-level decisions. It is separate from the long-running task manager: the manager owns scope, dependencies, budgets, holds, escalation, review coverage, and merge handoff; the architect independently verifies one problem and returns one advisory verdict.

## Invocation contract

The manager creates a consultation with the existing task primitives:

```text
kanna_create_task {
  display_name: "Architect consultation: <decision>",
  prompt: <objective, exact decision, evidence, constraints, affected surfaces>,
  workflow_name: "architect-consultation",
  base_ref: <assessed work item's committed branch>,
  parent_task_id: <assessed durable work item id>,
  notify_task_id: <manager task id>
}
```

`parent_task_id` expresses semantic hierarchy: the consultation exists only to assess that durable work item. The manager is not an owner bucket, so it is not the parent unless its own durable work is genuinely what is being assessed. `notify_task_id` is independent and routes the completion wake-up to the manager. Forking from the assessed branch gives the architect the actual committed implementation and history to inspect rather than the manager's unrelated worktree.

The prompt must name the assessed task id, its original objective, one exact decision, evidence already verified, constraints and explicit human decisions, known affected or disputed surfaces, and whether a design/spec artifact is explicitly requested. Omitting the artifact request means advisory output only.

The internal `architect-consultation` workflow binds `architect` itself. Callers must not add an `agent` override: the fixed binding is part of the attribution and lifecycle contract. Its only stage is manual, so all three verdicts park uniformly until the manager reads `latestRun.summary` and closes the child. `APPROVE` records a successful run; `REVISE` and `STOP-and-escalate` record failed runs, matching the existing positive/negative advisory pattern used by specialty review children. The completion notification's closed three-word status is only a wake-up; the manager reads the structured verdict before acting.

## Role boundary

The architect is invoked for changes across process/component boundaries; protocols, persistence, security, native/release lifecycle, or migrations; disputed sources of truth; uncertain premises; unexpected scope growth; and repeated findings that show an approach is structurally wrong.

It must independently verify the original objective and problem evidence, trace producers, consumers, persisted forms, versioned peers, and lifecycle owners, identify invariants and failure modes, compare viable alternatives, and return one of:

- `APPROVE`: the approach is structurally sound, with bounded acceptance criteria.
- `REVISE`: the objective remains valid, but the approach needs the named bounded changes.
- `STOP-and-escalate`: evidence, scope, irreversibility, or an explicit human product choice prevents a responsible decision.

Every verdict includes required E2E coverage. The architect neither implements its recommendation nor supervises work. It cannot merge, publish, deploy, release, create follow-up tasks, silently widen scope, or overrule an explicit human decision. It may write a design/spec only when the invoking prompt explicitly requests that artifact.

## Visibility decision

Both definitions are `internal`. In Kanna, internal means unlisted, not inaccessible: explicit workflow resolution and workflow-bound agent resolution still work. Public agents and workflows are operator choices that can sensibly start an ordinary product-work task. This pair is instead a purpose-built child lifecycle: selecting the architect with `single-reviewer`, for example, would incorrectly append commit, review, and PR stages to advisory work. Keeping the pair internal prevents that invalid combination while the canonical task-manager instructions provide the exact explicit invocation.

This does not introduce a singleton or a second event loop. Each consultation is a normal finite child task, and the existing server-owned stage completion, durable run result, parent relation, and completion notification boundaries remain the only orchestration mechanisms.

## Executable coverage

- `crates/kanna-server` definition tests prove both definitions resolve from compiled resources, remain absent from public listings, and the internal workflow binds the architect.
- The task-creator integration test prepares the manager-shaped request and verifies the resulting manual consultation run, parent/notify persistence, and architect prompt binding.
- The desktop packaging test verifies Tauri bundles the `.kanna/agents` and `.kanna/workflows` trees containing the two canonical source files.
