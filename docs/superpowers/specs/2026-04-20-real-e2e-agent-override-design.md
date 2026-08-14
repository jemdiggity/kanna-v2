# Real E2E Agent Override Design

## Goal

Allow real desktop E2E tests to run against a cheap authenticated agent configuration without requiring Claude access and without baking provider or model choices into each individual test.

## Problem

The current real E2E tests create PTY tasks through the same application flow that production users use. That is correct, but it means the tests inherit the default agent selection path. In practice, that currently points at Claude-oriented behavior in many flows, which is not usable in environments where Claude authentication is unavailable.

We need a test-only override that:

- lets real E2E runs choose a different provider and model
- keeps the application's database state and spawned runtime in sync
- avoids copying provider/model overrides into each real E2E spec
- preserves normal application behavior outside the real E2E harness

## Recommended Approach

Use test-only environment variables injected by the real E2E harness, and resolve them in the desktop app's PTY task creation path.

This keeps the override at the correct boundary:

- the test harness defines test policy
- the app remains the source of truth for task creation
- the spawned PTY session uses the same resolved provider/model that the task record stores

## Alternatives Considered

### 1. Per-test explicit provider/model selection

Each real E2E test would call `handleNewTaskSubmit` or `store.createItem` with explicit provider and model arguments.

Pros:

- no app-side test branching

Cons:

- repetitive
- easy to forget in new tests
- spreads real-E2E policy across the suite

### 2. Spawn-time rewrite only

The daemon/session spawn path would rewrite provider or model only when running under E2E.

Pros:

- minimal test changes

Cons:

- wrong source of truth
- task DB state could disagree with the actual runtime provider/model
- violates the repo preference for fixing architecture at the correct boundary

### 3. Recommended: app-level task creation override driven by harness env

The real E2E harness injects override env vars, and the task creation path resolves them only when the caller did not explicitly request a provider or model.

Pros:

- centralized
- truthful DB/runtime behavior
- easy to verify
- preserves explicit test choices

Cons:

- introduces a small amount of test-mode logic in app code

## Configuration Contract

The real E2E harness will set these environment variables for launched app instances:

- `KANNA_E2E_REAL_AGENT_PROVIDER`
- `KANNA_E2E_REAL_AGENT_MODEL`

Default real-E2E values:

- provider: `codex`
- model: `gpt-5.4-mini`

These env vars are test-only. They are not user-facing settings and should not be surfaced in preferences or persisted in SQLite.

## Resolution Rules

The override applies only when all of the following are true:

1. the task being created is a PTY task
2. the app is running under the real E2E harness with override env vars present
3. the task creation caller did not already provide an explicit `agentProvider`
4. the task creation caller did not already provide an explicit `model`

Precedence, highest to lowest:

1. explicit `CreateItemOptions.agentProvider`
2. explicit `CreateItemOptions.model`
3. real-E2E env overrides
4. existing workflow/agent/default provider resolution
5. existing default model behavior

To keep behavior simple and predictable, the initial implementation should treat explicit provider/model input as an atomic user choice:

- if either explicit provider or explicit model is present, do not apply either E2E override field

This avoids mixed-source task definitions in the first pass.

## Source of Truth

The resolved provider and model must be computed before:

- inserting the `pipeline_item` row
- spawning the PTY session

This ensures:

- database state reflects what the task actually uses
- sidebar, task detail, and session behavior stay coherent
- later features such as rerun/resume or transfer inherit truthful metadata

The override must not be implemented as a late rewrite in `spawnPtySession`.

## Expected Code Boundaries

### `apps/desktop/tests/e2e/run.ts`

Responsibility:

- inject real-E2E provider/model env vars into launched app instances
- keep the default centralized in the runner

Behavior:

- for `real/` suites, set provider `codex` and model `gpt-5.4-mini`
- for `mock/` suites, do nothing
- allow future per-run override by environment if needed, but do not require that in this change

### Desktop task creation path

Primary boundary:

- `apps/desktop/src/stores/tasks.ts`

Responsibility:

- resolve the effective PTY task provider/model before DB insert and before spawn

Supporting boundary:

- small helper module in `apps/desktop/src/stores/` or `apps/desktop/src/utils/`

Responsibility:

- read and validate test-only env vars
- apply the precedence rules
- return either a resolved override or `null`

### `apps/desktop/src/App.vue`

Responsibility:

- remain thin
- continue passing explicit user choices into `store.createItem`

The override logic should not live in the component.

## Validation Rules

Provider validation:

- accepted values: `claude`, `copilot`, `codex`
- invalid values are ignored

Model validation:

- any non-empty string is accepted as a model override
- empty strings are ignored

Initial default:

- real E2E sets `codex` + `gpt-5.4-mini`

## Testing Strategy

### Unit tests

Add focused tests around the override resolver:

- applies `codex` + `gpt-5.4-mini` when real-E2E env vars are present and no explicit provider/model is supplied
- ignores invalid provider env values
- ignores empty model env values
- does not apply override when explicit provider is supplied
- does not apply override when explicit model is supplied
- does not apply override for non-PTY task creation if the helper is called from a shared path

### App/store-level tests

Add or update task-creation tests to verify:

- DB insert receives the resolved provider when override is active
- spawn path receives the same provider/model as the inserted task metadata

### Runner verification

Add a small test if practical around `tests/e2e/run.ts`, or otherwise verify by inspection in the implementation plan, that real suites receive the env vars and mock suites do not.

## Non-Goals

This change does not:

- change user-facing default agent preferences
- add a preferences UI for E2E provider/model selection
- rewrite existing workflow or agent-definition model resolution outside the real-E2E override case
- solve agent-specific behavior differences inside individual real tests

## Risks

### Mixed explicit and overridden inputs

If explicit and overridden values are merged loosely, tasks may end up with surprising combinations such as a user-selected provider and a test-selected model.

Mitigation:

- treat any explicit provider/model input as opting out of the E2E override entirely

### Test-only behavior leaking into production

If the override resolver is too broadly wired, normal launches could pick up stray env vars unexpectedly.

Mitigation:

- keep the contract narrowly named for real E2E
- resolve it only in task creation
- cover no-env behavior in tests

### Future provider-specific model mismatches

Model strings are provider-specific. A future change could pair a codex model string with another provider.

Mitigation:

- current default is a known pair: `codex` + `gpt-5.4-mini`
- validation should ignore malformed provider values rather than forcing a mismatched pair

## Success Criteria

The change is successful when:

- real desktop E2E runs no longer require Claude authentication by default
- real E2E PTY tasks use `codex` with `gpt-5.4-mini` unless a test explicitly asks otherwise
- task DB metadata matches the actual spawned agent configuration
- mock E2E and normal app behavior remain unchanged
