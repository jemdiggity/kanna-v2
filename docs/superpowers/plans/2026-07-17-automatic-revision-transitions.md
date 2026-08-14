# Automatic Revision Transitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the default workflow's first implementation advance manual while automatically returning successful reviewer-requested revisions to review, with a per-stage manual/auto override.

**Architecture:** Add optional `policy.revision_transition` to both workflow loaders and persist the effective completion transition on each stage run. Stage preparation chooses ordinary versus revision policy once; prompt generation and completion handling consume that persisted value, with pinned-policy fallback for legacy rows.

**Tech Stack:** TypeScript, Vitest, JSON Schema, Rust, Serde, rusqlite/SQLite, Tokio/Axum integration tests

---

## File map

- `packages/core/src/workflow/workflow-types.ts` — public TypeScript stage-policy shape.
- `packages/core/src/workflow/workflow-loader.ts` — TypeScript validation and normalization.
- `packages/core/src/workflow/workflow-loader.test.ts` — parser compatibility and validation tests.
- `.kanna/workflows/schema.json` — authoring schema for workflow files.
- `.kanna/workflows/default.json` — shipped default behavior.
- `.kanna/agents/workflow-factory/AGENT.md` — user-facing workflow authoring guidance.
- `.kanna/agents/implement/AGENT.md` — policy-neutral implementer completion instructions.
- `packages/core/src/workflow/qa-assets.test.ts` — shipped asset contract tests.
- `crates/kanna-server/src/task_creator/definitions.rs` — Rust policy parsing, normalization, serialization, and effective-policy helper.
- `crates/kanna-server/src/task_creator/types.rs` — prepared run objects carrying effective transition.
- `crates/kanna-server/src/task_creator/mod.rs` — initial/rerun preparation and generated task preamble input.
- `crates/kanna-server/src/task_creator/stages.rs` — revision preparation and completion routing.
- `crates/kanna-server/src/task_creator/prompt.rs` — resumed-revision completion reminder.
- `crates/kanna-server/src/task_creator/lifecycle.rs` — stage-run persistence when a prepared run starts.
- `crates/kanna-server/src/db/mod.rs` — migration and stage-run data structures.
- `crates/kanna-server/src/db/stage_runs.rs` — transition-aware stage-run inserts, reads, and finished-run identity.
- `crates/kanna-server/src/db/test_support.rs` — current test schema.
- `crates/kanna-server/src/db/tests.rs` — migration and persistence coverage.
- `crates/kanna-server/src/task_creator/tests/core.rs` — Rust workflow-definition coverage.
- `crates/kanna-server/src/task_creator/tests/revision.rs` — fresh/resumed revision prompt and run-policy coverage.
- `crates/kanna-server/src/task_creator/tests/stage.rs` — completion-routing coverage.
- `crates/kanna-server/src/http_api/tests/revision_status.rs` — server-boundary revision-loop coverage.

### Task 1: Add the configurable workflow policy to the TypeScript surface and shipped assets

**Files:**
- Modify: `packages/core/src/workflow/workflow-types.ts`
- Modify: `packages/core/src/workflow/workflow-loader.ts`
- Test: `packages/core/src/workflow/workflow-loader.test.ts`
- Modify: `.kanna/workflows/schema.json`
- Modify: `.kanna/workflows/default.json`
- Modify: `.kanna/agents/workflow-factory/AGENT.md`
- Test: `packages/core/src/workflow/qa-assets.test.ts`

- [ ] **Step 1: Write failing TypeScript parser and asset tests**

Add parser cases that prove preservation, omission compatibility, and validation:

```ts
it("parses an optional revision transition", () => {
  const result = parseWorkflowJson(JSON.stringify({
    name: "Revision loop",
    stages: [{
      name: "in progress",
      policy: { transition: "manual", revision_transition: "auto" },
    }],
  }));

  expect(result.stages[0].policy).toEqual({
    transition: "manual",
    revision_transition: "auto",
  });
});

it("leaves revision transition absent for existing policies", () => {
  const result = parseWorkflowJson(JSON.stringify({
    name: "Existing",
    stages: [{ name: "in progress", policy: { transition: "manual" } }],
  }));

  expect(result.stages[0].policy).toEqual({ transition: "manual" });
});

it("rejects an invalid revision transition", () => {
  const json = JSON.stringify({
    name: "Invalid",
    stages: [{
      name: "in progress",
      policy: { transition: "manual", revision_transition: "sometimes" },
    }],
  });

  expect(() => parseWorkflowJson(json)).toThrow(
    /invalid policy\.revision_transition "sometimes"; must be "manual" or "auto"/
  );
});
```

Add a shipped-asset contract:

```ts
it("automates default implement revisions without automating the initial handoff", () => {
  const parsed = parseWorkflowJson(readRepoFile(".kanna/workflows/default.json"));
  const implement = parsed.stages.find((stage) => stage.name === "in progress");

  expect(implement?.policy).toEqual({
    transition: "manual",
    revision_transition: "auto",
  });
});

it("publishes revision transition values in the workflow schema", () => {
  const schema = JSON.parse(readRepoFile(".kanna/workflows/schema.json"));
  const revisionTransition =
    schema.properties.stages.items.properties.policy
      .properties.revision_transition;

  expect(revisionTransition.enum).toEqual(["manual", "auto"]);
});
```

- [ ] **Step 2: Run the focused tests and verify the new expectations fail**

Run:

```bash
pnpm --dir packages/core test -- src/workflow/workflow-loader.test.ts src/workflow/qa-assets.test.ts
```

Expected: FAIL because `revision_transition` is not represented or preserved and the default asset lacks it.

- [ ] **Step 3: Implement TypeScript parsing and update assets/schema/docs**

Extend the policy type:

```ts
export interface WorkflowStagePolicy {
  transition: "manual" | "auto";
  revision_transition?: "manual" | "auto";
}
```

In `parseStagePolicy`, validate the optional value without materializing it when absent:

```ts
const revisionTransition = p["revision_transition"] === undefined
  ? undefined
  : parseTransition(
      p["revision_transition"],
      (value) =>
        `Stage "${stageName}" has invalid policy.revision_transition "${value}"; must be "manual" or "auto"`
    );

return {
  policy: {
    transition: parseTransition(
      p["transition"],
      (value) =>
        `Stage "${stageName}" has invalid policy.transition "${value}"; must be "manual" or "auto"`
    ),
    ...(revisionTransition === undefined
      ? {}
      : { revision_transition: revisionTransition }),
  },
  legacyContinue: parseLegacyContinueMarker(p["execution"], stageName),
};
```

Add this JSON Schema property next to `transition`:

```json
"revision_transition": {
  "description": "Completion policy for main runs entered through a revision request. Defaults to transition when omitted.",
  "enum": ["manual", "auto"]
}
```

Update the default implement stage:

```json
"policy": {
  "transition": "manual",
  "revision_transition": "auto"
}
```

Document both keys and their fallback in the workflow factory's stage-policy field table and example.

- [ ] **Step 4: Run focused TypeScript tests**

Run:

```bash
pnpm --dir packages/core test -- src/workflow/workflow-loader.test.ts src/workflow/qa-assets.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the workflow surface**

```bash
git add packages/core/src/workflow/workflow-types.ts packages/core/src/workflow/workflow-loader.ts packages/core/src/workflow/workflow-loader.test.ts packages/core/src/workflow/qa-assets.test.ts .kanna/workflows/schema.json .kanna/workflows/default.json .kanna/agents/workflow-factory/AGENT.md
git commit -m "feat(workflow): configure revision transitions"
```

### Task 2: Parse and resolve revision policy in the Rust workflow model

**Files:**
- Modify: `crates/kanna-server/src/task_creator/definitions.rs`
- Test: `crates/kanna-server/src/task_creator/tests/core.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/merge.rs`

- [ ] **Step 1: Write failing Rust definition tests**

Add a test that resolves and reserializes a policy with a revision override, plus a direct fallback assertion:

```rust
#[test]
fn workflow_stage_policy_resolves_revision_transition_with_fallback() {
    let explicit: WorkflowDefinition = serde_json::from_str(
        r#"{
          "stages": [{
            "name": "in progress",
            "policy": {"transition": "manual", "revision_transition": "auto"}
          }]
        }"#,
    )
    .unwrap();
    let explicit_policy = &explicit.stages[0].policy;
    assert_eq!(explicit_policy.transition, WorkflowStageTransition::Manual);
    assert_eq!(
        explicit_policy.revision_transition(),
        WorkflowStageTransition::Auto
    );
    assert!(serde_json::to_string(&explicit).unwrap().contains("revision_transition"));

    let inherited: WorkflowDefinition = serde_json::from_str(
        r#"{
          "stages": [{
            "name": "in progress",
            "policy": {"transition": "manual"}
          }]
        }"#,
    )
    .unwrap();
    assert_eq!(
        inherited.stages[0].policy.revision_transition(),
        WorkflowStageTransition::Manual
    );

    let invalid = serde_json::from_str::<WorkflowDefinition>(
        r#"{
          "stages": [{
            "name": "in progress",
            "policy": {"transition": "manual", "revision_transition": "sometimes"}
          }]
        }"#,
    );
    assert!(invalid.is_err());
}
```

- [ ] **Step 2: Run the focused Rust test and verify it fails**

Run:

```bash
cargo test -p kanna-server workflow_stage_policy_resolves_revision_transition_with_fallback
```

Expected: FAIL because `WorkflowStagePolicy` has no revision field or resolver.

- [ ] **Step 3: Implement the Rust policy field and helper**

Use an optional serialized field so pinned definitions preserve explicit customization without rewriting old snapshots:

```rust
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct WorkflowStagePolicy {
    pub(super) transition: WorkflowStageTransition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) revision_transition: Option<WorkflowStageTransition>,
}

impl WorkflowStagePolicy {
    pub(super) fn revision_transition(&self) -> WorkflowStageTransition {
        self.revision_transition.unwrap_or(self.transition)
    }
}
```

Add `revision_transition: Option<WorkflowStageTransition>` to `RawWorkflowStagePolicy`, carry it through normalization, and set `revision_transition: None` in programmatically constructed singleton, integration, and merge policies.

- [ ] **Step 4: Run the focused Rust definition tests**

Run:

```bash
cargo test -p kanna-server workflow_stage_policy_resolves_revision_transition_with_fallback
cargo test -p kanna-server task_creator::tests::core
```

Expected: PASS.

- [ ] **Step 5: Commit the Rust policy model**

```bash
git add crates/kanna-server/src/task_creator/definitions.rs crates/kanna-server/src/task_creator/tests/core.rs crates/kanna-server/src/task_creator/mod.rs crates/kanna-server/src/task_creator/merge.rs
git commit -m "feat(server): resolve revision transition policy"
```

### Task 3: Persist each run's effective completion transition

**Files:**
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/stage_runs.rs`
- Modify: `crates/kanna-server/src/db/test_support.rs`
- Test: `crates/kanna-server/src/db/tests.rs`

- [ ] **Step 1: Write failing database migration and lifecycle tests**

Extend the fresh-profile migration assertion:

```rust
assert_eq!(latest_migration, "028_stage_run_completion_transition");
assert!(stage_run_sql.contains("completion_transition"));
```

Add a round-trip test using a transition-aware insert:

```rust
#[test]
fn stage_run_persists_completion_transition() {
    let db = Db::open_for_tests(&Db::test_db_path("stage-run-transition")).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Task",
        Some("Task"),
        "in progress",
        "2026-07-17 00:00:00",
    )
    .unwrap();
    db.insert_stage_run_with_completion_transition(
        NewStageRun {
            id: "run-1",
            task_id: "task-1",
            stage: "in progress",
            kind: "main",
            agent: Some("implement"),
            agent_provider: Some("codex"),
            model: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-1"),
            provider_session_id: None,
            cwd: Some("/tmp/worktree"),
            resumed_from_run_id: None,
        },
        Some("auto"),
    )
    .unwrap();

    let run = db.latest_stage_run("task-1").unwrap().unwrap();
    assert_eq!(run.completion_transition.as_deref(), Some("auto"));
}
```

- [ ] **Step 2: Run database tests and verify they fail**

Run:

```bash
cargo test -p kanna-server db::tests::open_creates_and_migrates_fresh_profile_database
cargo test -p kanna-server stage_run_persists_completion_transition
```

Expected: FAIL because migration 028 and the transition-aware insert do not exist.

- [ ] **Step 3: Add migration 028 and transition-aware DB APIs**

Append the migration id and add the nullable checked column:

```rust
"028_stage_run_completion_transition",
```

```rust
run_migration(conn, "028_stage_run_completion_transition", |conn| {
    add_column(
        conn,
        "stage_run",
        "completion_transition",
        "TEXT CHECK (completion_transition IN ('manual', 'auto'))",
    );
    Ok(())
})?;
```

Include the same column in fresh and test schemas. Add `completion_transition: Option<String>` to `StageRun` and `FinishedStageRun`. Keep existing callers source-compatible by delegating:

```rust
pub fn insert_stage_run(&self, run: NewStageRun<'_>) -> Result<(), rusqlite::Error> {
    self.insert_stage_run_with_completion_transition(run, None)
}

pub fn insert_stage_run_with_completion_transition(
    &self,
    run: NewStageRun<'_>,
    completion_transition: Option<&str>,
) -> Result<(), rusqlite::Error> {
    self.conn.execute(
        "INSERT INTO stage_run
         (id, task_id, stage, kind, agent, agent_provider, model, status, result, feedback,
          session_id, provider_session_id, cwd, resumed_from_run_id, completion_transition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            run.id,
            run.task_id,
            run.stage,
            run.kind,
            run.agent,
            run.agent_provider,
            run.model,
            run.status,
            run.result,
            run.feedback,
            run.session_id,
            run.provider_session_id,
            run.cwd,
            run.resumed_from_run_id,
            completion_transition,
        ),
    )?;
    Ok(())
}
```

Select the column in every `StageRun` query. In `finish_latest_running_stage_run` and `refinish_latest_stage_run`, select and return it alongside `kind` before writing the verdict.

- [ ] **Step 4: Run database tests**

Run:

```bash
cargo test -p kanna-server db::tests
```

Expected: PASS.

- [ ] **Step 5: Commit durable run policy**

```bash
git add crates/kanna-server/src/db/mod.rs crates/kanna-server/src/db/stage_runs.rs crates/kanna-server/src/db/test_support.rs crates/kanna-server/src/db/tests.rs
git commit -m "feat(db): persist stage completion transitions"
```

### Task 4: Use the effective policy in ordinary and revision prompts

**Files:**
- Modify: `crates/kanna-server/src/task_creator/types.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/stages.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Test: `crates/kanna-server/src/task_creator/tests/revision.rs`
- Test: `crates/kanna-server/src/task_creator/tests/spawn.rs`

- [ ] **Step 1: Write failing fresh and resumed revision tests**

Change the revision fixture to use an initially manual stage with an automatic revision override:

```json
{
  "name": "in progress",
  "agent": "implement",
  "policy": {
    "transition": "manual",
    "revision_transition": "auto"
  }
}
```

Assert both paths expose and persist the effective value:

```rust
assert_eq!(prepared.completion_transition, WorkflowStageTransition::Auto);
match &prepared.session {
    PreparedSessionSpawn::Agent { system_prompt, .. } => {
        assert!(system_prompt.contains("(transition: `auto`)"));
        assert!(system_prompt.contains("record completion so Kanna can advance"));
    }
    PreparedSessionSpawn::Pty { args, .. } => {
        let command = args.join(" ");
        assert!(command.contains("transition: `auto`"));
    }
}
```

For the resumed path, assert the sent message includes `record stage completion` and excludes `do not record stage completion` even though the ordinary stage transition is manual.

- [ ] **Step 2: Run focused revision tests and verify they fail**

Run:

```bash
cargo test -p kanna-server task_creator::tests::revision
```

Expected: FAIL because revision preparation still uses `policy.transition`.

- [ ] **Step 3: Carry effective transition through prepared runs**

Add `completion_transition: WorkflowStageTransition` to `ResolvedTaskSpawn`, `PreparedTaskSpawn`, `PreparedStageRunSpawn`, and `PreparedStageRerun`. Add an explicit `completion_transition` argument to `prepare_stage_run_spawn` and pass its string to `build_prepared_session`:

```rust
Some(completion_transition.as_str())
```

Ordinary creation, swaps, and reruns pass `target_stage.policy.transition`. Revision preparation computes once:

```rust
let completion_transition = target_stage.policy.revision_transition();
```

Pass that value to both `build_revision_resume_message` and fresh revision preparation. Store the value on the prepared run.

When recording an initial, rerun, post, or transitioned stage run, call `insert_stage_run_with_completion_transition` and pass:

```rust
Some(prepared.completion_transition.as_str())
```

Post runs use `WorkflowStageTransition::Auto` because a completed post always performs its already-approved transition.

- [ ] **Step 4: Run revision and spawn tests**

Run:

```bash
cargo test -p kanna-server task_creator::tests::revision
cargo test -p kanna-server task_creator::tests::spawn
```

Expected: PASS.

- [ ] **Step 5: Commit prompt/run-policy propagation**

```bash
git add crates/kanna-server/src/task_creator/types.rs crates/kanna-server/src/task_creator/mod.rs crates/kanna-server/src/task_creator/stages.rs crates/kanna-server/src/task_creator/lifecycle.rs crates/kanna-server/src/task_creator/tests/revision.rs crates/kanna-server/src/task_creator/tests/spawn.rs
git commit -m "feat(server): apply revision policy to agent runs"
```

### Task 5: Route successful completion using the persisted run policy

**Files:**
- Modify: `crates/kanna-server/src/task_creator/stages.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Test: `crates/kanna-server/src/task_creator/tests/stage.rs`
- Test: `crates/kanna-server/src/http_api/tests/revision_status.rs`

- [ ] **Step 1: Write failing completion-routing unit tests**

Extend stage completion setup with a manual stage that has an automatic revision override. Record a successful main revision run with `completion_transition = "auto"`, then assert it dispatches the stage's commit post:

```rust
let prepared = prepare_stage_completion_for_api(
    &db,
    &config,
    "task-1",
    Some("main"),
    Some("auto"),
)
.unwrap();

assert!(matches!(prepared, Some(PreparedStageTransition::Post(_))));
```

Add the inverse legacy/custom assertion with `Some("manual")` and expect `None`. Keep the existing test passing `None` to prove old rows fall back to pinned `policy.transition`.

- [ ] **Step 2: Run focused stage tests and verify they fail**

Run:

```bash
cargo test -p kanna-server task_creator::tests::stage::prepare_revision_completion
```

Expected: FAIL because completion routing does not accept or honor a run-level transition.

- [ ] **Step 3: Implement completion routing with legacy fallback**

Extend `prepare_stage_completion_for_api`:

```rust
pub(crate) fn prepare_stage_completion_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
    finished_run_kind: Option<&str>,
    completion_transition: Option<&str>,
) -> Result<Option<PreparedStageTransition>, String>
```

For main runs, resolve the effective value with strict persisted-value parsing and policy fallback:

```rust
let transition = match completion_transition {
    Some("manual") => WorkflowStageTransition::Manual,
    Some("auto") => WorkflowStageTransition::Auto,
    Some(value) => return Err(format!("invalid stage run completion transition: {value}")),
    None => stage.policy.transition,
};
if transition != WorkflowStageTransition::Auto {
    return Ok(None);
}
```

In the HTTP completion handler, pass both fields captured from `FinishedStageRun`:

```rust
finished_run.as_ref().map(|run| run.kind.as_str()),
finished_run
    .as_ref()
    .and_then(|run| run.completion_transition.as_deref()),
```

- [ ] **Step 4: Add a server-boundary revision-loop test**

In the existing HTTP revision fixture, use `transition: "manual"`, `revision_transition: "auto"`, and a commit post. After requesting revision, assert the new run stores `completion_transition = "auto"`; submit a successful stage completion; then assert the detached transition starts the commit post (or next review stage after the fake post completion) without calling the manual advance route.

The decisive assertions are:

```rust
let revision_run = db.latest_stage_run(task_id).unwrap().unwrap();
assert_eq!(revision_run.stage, "in progress");
assert_eq!(revision_run.completion_transition.as_deref(), Some("auto"));

let item = db.get_pipeline_item(task_id).unwrap().unwrap();
assert_ne!(item.activity.as_deref(), Some("unread"));
```

Use the existing fake-daemon synchronization channel before reading final task state so the detached transition has landed.

- [ ] **Step 5: Run focused server tests**

Run:

```bash
cargo test -p kanna-server task_creator::tests::stage
cargo test -p kanna-server http_api::tests::revision_status
```

Expected: PASS.

- [ ] **Step 6: Commit completion routing**

```bash
git add crates/kanna-server/src/task_creator/stages.rs crates/kanna-server/src/http_api/task_actions.rs crates/kanna-server/src/task_creator/tests/stage.rs crates/kanna-server/src/http_api/tests/revision_status.rs
git commit -m "feat(server): auto-advance successful revisions"
```

### Task 6: Make implementer guidance policy-neutral and verify the complete change

**Files:**
- Modify: `.kanna/agents/implement/AGENT.md`
- Test: `packages/core/src/workflow/qa-assets.test.ts`
- Modify: `docs/superpowers/plans/2026-07-17-automatic-revision-transitions.md` (checkbox tracking only)

- [ ] **Step 1: Update the asset test to reject hard-coded manual guidance**

Replace the implement-specific manual-stage assertions with policy-neutral ones:

```ts
if (name === "implement") {
  expect(agent).toContain("Follow the Kanna Task Environment completion instructions");
  expect(agent).not.toContain("This stage advances manually");
  expect(agent).not.toContain("do not record stage completion");
} else {
  expect(agent).toContain(
    'kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "success"'
  );
}
```

Keep the common MCP-first failure and quoted task-id assertions.

- [ ] **Step 2: Run the asset test and verify it fails**

Run:

```bash
pnpm --dir packages/core test -- src/workflow/qa-assets.test.ts
```

Expected: FAIL because the implement agent still says every run advances manually.

- [ ] **Step 3: Replace static manual wording with dynamic-policy guidance**

Use this completion section in `.kanna/agents/implement/AGENT.md`:

````markdown
## Completion

Follow the Kanna Task Environment completion instructions for this run's transition policy. Initial implementation and reviewer-requested revision runs can intentionally use different policies.

If you cannot complete the task, record failure with the reason instead of stopping silently — call the `kanna_complete_stage` MCP tool (`task_id` is the value of the `KANNA_TASK_ID` env var):

```json
kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "failure", "summary": "<what is blocking>"}
```

Only if MCP tools are unavailable, fall back to the CLI: `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status failure --summary "<what is blocking>"`.
````

- [ ] **Step 4: Run focused TypeScript and Rust suites**

Run:

```bash
pnpm --dir packages/core test -- src/workflow/workflow-loader.test.ts src/workflow/qa-assets.test.ts
cargo test -p kanna-server db::tests
cargo test -p kanna-server task_creator::tests
cargo test -p kanna-server http_api::tests::revision_status
```

Expected: PASS.

- [ ] **Step 5: Run canonical repository verification**

Run:

```bash
pnpm test
./kd test rust
```

Expected: both commands exit 0. If a failure is unrelated and pre-existing, capture its exact test name and output in the final handoff; do not weaken tests.

- [ ] **Step 6: Inspect the final diff and commit**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~5..HEAD
```

Expected: no whitespace errors; only planned files are changed.

```bash
git add .kanna/agents/implement/AGENT.md packages/core/src/workflow/qa-assets.test.ts docs/superpowers/plans/2026-07-17-automatic-revision-transitions.md
git commit -m "docs(agent): follow effective transition policy"
```
