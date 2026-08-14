# Automatic Revision Transitions

**Date:** 2026-07-17

## Goal

Keep the first implementation handoff in the default workflow human-gated, then let implementer/reviewer revision loops transition automatically. Preserve workflow customization so any stage can keep revisions manual.

## Workflow Policy

Add an optional `revision_transition` value to each stage policy:

```json
{
  "policy": {
    "transition": "manual",
    "revision_transition": "auto"
  }
}
```

- `transition` controls completion of an ordinary stage run.
- `revision_transition` controls completion of a main run entered through `request_revision`.
- Both values accept `"manual"` or `"auto"`.
- When `revision_transition` is absent, it falls back to `transition`. Existing custom and pinned workflow definitions therefore retain their current behavior.
- Post runs keep their existing behavior: their completion performs the transition whose gate was passed when the post started.

The bundled default workflow sets the `in progress` stage to `transition: "manual"` and `revision_transition: "auto"`. Its initial implementation run still waits for the user. A later implementation revision completes automatically, runs the implement stage's commit post, and returns to the automatic review stage. Users can set `revision_transition: "manual"` or omit it to retain a human gate.

## Runtime Model

Each stage run records the effective completion transition chosen when the run is prepared. Ordinary main runs use `transition`; revision main runs use `revision_transition` with the fallback above. Persisting the effective value on `stage_run` gives prompting and completion handling one durable source of truth and avoids reconstructing revision intent from mutable fields such as feedback or the current task stage.

Existing stage-run rows created before the new field are handled by falling back to the pinned stage policy during completion. No task's pinned workflow definition is rewritten.

The effective transition is used in both places that must agree:

1. Kanna's generated task environment tells the running agent whether successful completion should be recorded.
2. The server's stage-completion handler decides whether success parks the task or dispatches its post/next stage.

Fresh revision spawns and resumed revision sessions receive the same effective transition. The bundled implement agent instructions become policy-neutral so they do not contradict Kanna's dynamically generated completion guidance.

## Data Flow

1. A new default-workflow task starts `in progress` with effective transition `manual`.
2. The agent finishes without recording success; the user manually advances.
3. The commit post runs, then Kanna starts `review`.
4. Review either succeeds and auto-advances toward PR, or calls `request_revision` targeting `in progress`.
5. Kanna prepares the revision run with effective transition `auto` and includes automatic-completion guidance in its prompt.
6. The implementer records success after addressing feedback.
7. Kanna automatically runs the commit post and returns to `review`.
8. Steps 4–7 repeat without another human stage advance until review succeeds or an agent reports failure.

For a custom stage whose effective revision transition is `manual`, step 6 instead parks for human advancement exactly as it does today.

## Validation and Compatibility

The TypeScript and Rust workflow loaders validate `revision_transition` with the same accepted values and error style as `transition`. The JSON schema and workflow-factory documentation expose the new field. Normalized and pinned workflow JSON retains it.

Legacy flat stage definitions remain supported as they are today. The new setting belongs inside `policy`; no new flat alias is introduced.

Invalid `revision_transition` values reject the workflow definition rather than silently reverting to another behavior.

## Testing

Coverage will include:

- TypeScript parsing, normalization, validation, and omission fallback.
- Rust parsing and pinned-definition serialization.
- Initial default implementation runs remaining manual.
- Default revision runs receiving automatic completion guidance.
- Successful default revisions dispatching the commit post and returning to review automatically.
- A custom `revision_transition: "manual"` revision parking for human advancement.
- Existing workflow definitions without `revision_transition` retaining their current semantics.
- Fresh and resumed revision paths using the same effective transition.

A server-boundary test should exercise revision preparation through completion so the persisted run policy, prompt, and transition execution are proven together rather than only through isolated helpers.

## Non-goals

- Automatically advancing the initial implementation run.
- Removing the manual PR approval gate.
- Changing review verdict semantics or revision targeting.
- Rewriting existing tasks' pinned workflow definitions.
- Adding a global preference that overrides per-workflow policy.
