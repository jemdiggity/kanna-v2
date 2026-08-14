# Kanna Store Decomposition

## Summary

Refactor `apps/desktop/src/stores/kanna.ts` from a 2,300+ line monolith into a thin composition root plus focused store modules. The goal is not just to reduce line count, but to give each file one clear responsibility so task creation, session management, workflow transitions, selection logic, and startup wiring can be reasoned about independently.

The public API may change. The preferred shape is still a single top-level `useKannaStore()` entry point for the app, but its implementation should be assembled from smaller modules rather than owning every concern directly.

## Goals

- Reduce `apps/desktop/src/stores/kanna.ts` to roughly 300-500 lines.
- Split the current store by responsibility, not by arbitrary technical layer.
- Keep behavior unchanged for task creation, task closing, blocked-task startup, workflow advancement, session spawning, and startup event handling.
- Make each extracted file small enough to understand in one pass.
- Preserve or improve existing test coverage around the most failure-prone paths.

## Non-Goals

- Rewriting the task lifecycle or changing product behavior.
- Converting everything into multiple independent Pinia stores.
- Renaming unrelated store helper modules that already have good boundaries.
- Performing opportunistic cleanup outside the store decomposition work.

## Current Problems

`apps/desktop/src/stores/kanna.ts` currently owns all of the following:

- reactive DB reads
- selection and navigation history
- repo import/create/hide flows
- task creation and worktree bootstrap
- PTY command assembly and shell prewarming
- runtime status sync and daemon event handling
- workflow definition loading and stage advancement
- blocked-task orchestration
- preference loading and persistence
- startup initialization
- several file-local utilities and caches

This creates a few concrete costs:

- behavior is hard to trace because ownership boundaries are unclear
- tests have to import a very large module even when exercising a small seam
- internal helpers reach across unrelated concerns because everything lives in one closure
- file-local globals such as DB state, port allocation, and session waiters are harder to reason about than necessary
- moving carefully in one area still requires carrying a large amount of unrelated context

## Proposed Structure

Keep `useKannaStore()` as the composition root, but extract focused support modules with neutral names rather than `kanna*` prefixes.

### `apps/desktop/src/stores/kanna.ts`

Thin store entry point.

Responsibilities:

- create the shared store context
- assemble the extracted modules
- expose the final public API used by components
- keep only minimal wiring code and exports

Target size: 300-500 lines.

### `apps/desktop/src/stores/state.ts`

Shared reactive state and caches.

Responsibilities:

- refs such as `selectedRepoId`, `selectedItemId`, `pendingSetupIds`, preferences, and refresh triggers
- computed async reads for `repos` and `items`
- shared caches for workflows, agents, stage order, pending visibility, and runtime timers
- utility types that describe the shared store context

This file is the source of truth for shared mutable state.

### `apps/desktop/src/stores/selection.ts`

Selection, history, and sidebar ordering.

Responsibilities:

- `selectedRepo`, `currentItem`, `sortedItemsForCurrentRepo`, `sortedItemsAllRepos`
- repo and item selection
- startup selection restore
- back/forward navigation
- sidebar sorting and visibility rules
- unread-to-idle dwell handling

### `apps/desktop/src/stores/sessions.ts`

Terminal session and runtime-status behavior.

Responsibilities:

- PTY preparation and spawn
- shell session spawn and prewarm
- task terminal environment setup
- runtime status sync from daemon
- deferred runtime status scheduling
- session-exit waiters

This module should own the mechanics of talking to daemon-backed sessions.

### `apps/desktop/src/stores/tasks.ts`

Task lifecycle orchestration.

Responsibilities:

- `createItem()`
- background worktree setup and agent spawn
- close task flow
- undo close
- repo create/import/clone/hide actions
- blocked-task start flow
- blocker edit and blocker transfer behavior

This is the behavioral core for task lifecycle mutations.

### `apps/desktop/src/stores/workflow.ts`

Workflow and agent definition behavior.

Responsibilities:

- load workflow definitions
- load agent definitions
- resolve stage order from repo config
- `advanceStage()`
- `rerunStage()`
- workflow-specific prompt building

### `apps/desktop/src/stores/init.ts`

Startup and event registration.

Responsibilities:

- `init(db)`
- stale activity repair
- orphaned task cleanup
- auto-start of newly unblocked tasks
- shell prewarming at startup
- Tauri event listener registration
- app window title setup

### `apps/desktop/src/stores/ports.ts`

Task port allocation.

Responsibilities:

- port allocation lock
- claim/release helpers
- DB-backed port reservation and cleanup

This logic is already mostly standalone and should stop living at the top of `kanna.ts`.

### Keep Existing Focused Helpers

These files already have a clear purpose and should remain as separate helpers unless a boundary becomes awkward:

- `kannaCleanup.ts`
- `taskRuntimeStatus.ts`
- `taskCloseBehavior.ts`
- `taskCloseSelection.ts`
- `taskShellPrewarm.ts`
- `taskBaseBranch.ts`
- `agent-provider.ts`
- `agent-permissions.ts`

## Architectural Rules

### 1. One shared context object

The extracted modules should communicate through an explicit typed context object rather than through hidden file-local coupling.

That context should hold:

- the `DbHandle`
- shared refs and computed state
- shared caches
- cross-module callbacks that need to be injected to avoid circular imports
- utilities like `toast`, `tt()`, and `bump()`

This keeps ownership explicit and prevents the new modules from recreating a hidden monolith through imports.

### 2. No new cross-store graph

Do not split the app into several independently-mounted Pinia stores. That would make initialization order, event registration, and action composition harder in this app because task flows cross nearly every concern.

Instead:

- one top-level store remains
- internals are decomposed into focused modules
- modules are plain TypeScript helpers that operate on shared typed state

### 3. Move behavior with the owning lifecycle

Code should be extracted according to who owns the lifecycle:

- session spawn and runtime sync belong with session management
- startup listeners belong with initialization
- task close and undo belong with task lifecycle
- selection fallback and history belong with selection

This avoids the current pattern where unrelated code reaches into the same large closure because it happens to be nearby.

### 4. Reduce free-floating globals

The current module-level globals should be narrowed:

- DB handle should live in explicit context after `init()`
- port allocation lock should move into `ports.ts`
- session exit waiter state should move into `sessions.ts`

File-local state is acceptable when truly owned by one module, but it should not be shared implicitly across unrelated concerns.

## Implementation Strategy

### Phase 1: Extract shared state

Create `state.ts` and move:

- shared refs
- computed async reads
- caches
- helper interfaces used across multiple modules

At the end of this phase, `kanna.ts` should still behave the same but consume a structured shared state object.

### Phase 2: Extract pure ownership islands

Move the most self-contained logic next:

- `ports.ts`
- `workflow.ts`
- `selection.ts`

These have relatively clear seams and reduce pressure on the main store quickly.

### Phase 3: Extract session and task orchestration

Move the highest-complexity action clusters:

- `sessions.ts`
- `tasks.ts`

These are the most coupled areas, so they should be extracted after the shared context shape is stable.

### Phase 4: Extract startup wiring

Move `init()` and event listeners into `init.ts` once the task/session entry points are already stable.

This keeps the event-registration module focused on orchestration rather than behavior details.

### Phase 5: Collapse `kanna.ts` into a facade

At the end, `kanna.ts` should mostly:

- create the shared state/context
- initialize the extracted modules
- return the combined API

## Public API Direction

The external store API may change where it makes the internal boundaries cleaner.

However, the preferred outcome is:

- components still import `useKannaStore()` from `apps/desktop/src/stores/kanna.ts`
- implementation details move behind that boundary
- only meaningful call-site changes are made when they improve clarity, not just because the refactor made them possible

This keeps the decomposition focused on maintainability rather than broad UI churn.

## Testing Strategy

This is a refactor, so the risk is behavioral drift rather than missing product requirements.

The most important verification points are:

- runtime status synchronization
- task creation and base-branch behavior
- task close and teardown behavior
- blocked-task startup behavior
- workflow advance and rerun behavior

Expected test work:

- update existing store tests to match the extracted module structure
- add narrow tests only where extraction creates a new seam worth locking down
- avoid broad snapshot-style tests that simply restate current implementation

Minimum verification:

- `pnpm exec tsc --noEmit`
- targeted Vitest runs for touched store tests

If the refactor touches Rust or command boundaries indirectly, run the smallest relevant additional checks, but TypeScript verification is the required baseline.

## Files Expected To Change

- `apps/desktop/src/stores/kanna.ts`
- `apps/desktop/src/stores/state.ts`
- `apps/desktop/src/stores/selection.ts`
- `apps/desktop/src/stores/sessions.ts`
- `apps/desktop/src/stores/tasks.ts`
- `apps/desktop/src/stores/workflow.ts`
- `apps/desktop/src/stores/init.ts`
- `apps/desktop/src/stores/ports.ts`
- existing touched tests such as:
  - `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
  - `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

Additional files may change if small call-site cleanup is needed in `App.vue` or components that consume the store.

## Resolved Decisions

- Keep one top-level store entry point rather than several peer stores.
- Use neutral module names such as `state.ts`, `tasks.ts`, and `sessions.ts`, not `kannaState.ts` or `kannaTasks.ts`.
- Prefer explicit shared context over hidden module globals.
- Preserve behavior first; improve call-site API only when it materially clarifies ownership.
- Target file size should be roughly 300-500 lines for the composition root and similarly bounded for extracted modules when practical.

## Risks And Controls

### Risk: hidden circular dependencies after extraction

Control:

- define a shared context type early
- keep module boundaries directional
- inject callbacks where needed instead of importing sideways

### Risk: startup/event ordering regressions

Control:

- extract `init()` last
- keep existing listener behavior intact while moving code
- verify with targeted runtime status and startup tests

### Risk: task lifecycle behavior drifts during decomposition

Control:

- preserve function-level behavior while moving code
- do not combine refactor with feature work
- keep tests close to task creation, close, undo, and blocked flows

## Implementation Notes

- Keep comments and logging only where they explain non-obvious lifecycle behavior.
- Avoid introducing `any` while reshaping the shared context types.
- Prefer moving existing code with minimal semantic edits first, then tighten naming and signatures once tests are green.
