# DB Query Layer For Reactive Store State

## Summary

Remove the manual `bump()` / `refreshKey` invalidation pattern from the desktop store while keeping SQLite as the source of truth. Replace the current `computedAsync` + global refresh token approach with a focused query layer that owns reactive `repos` and `items` refs and is the only place allowed to translate DB writes into UI refreshes.

The goal is not to make the Tauri SQLite plugin magically reactive. The goal is to stop scattering manual refresh triggers throughout task, session, workflow, and init code and replace them with a normal architecture:

- DB is canonical
- store actions write to the DB
- a query layer reloads the affected reactive collections in one place

## Goals

- Remove `bump()` from the store API and internal architecture.
- Remove `refreshKey` from `state.ts`.
- Keep the DB as the canonical source of truth.
- Preserve reactive UI behavior for repos, tasks, selection, and daemon-driven updates.
- Make it obvious which code reloads `repos` and `items` after DB mutations.
- Reduce the number of places that must know how to refresh store state.

## Non-Goals

- Replacing SQLite with a different storage mechanism.
- Introducing a generic app-wide event bus for arbitrary invalidation.
- Making every DB query individually reactive.
- Reworking task lifecycle behavior beyond the refresh architecture needed to support it.

## Current Problem

The refactored store is structurally smaller, but it still depends on a manual invalidation mechanism:

- `state.ts` owns `refreshKey`
- `computedAsync` for `repos` and `items` depends on `refreshKey`
- many actions call `context.bump()` after writes

That means the architecture still says:

1. write to DB
2. remember to call `bump()`
3. rely on a global refresh token to re-read all affected data later

This has several problems:

- refresh behavior is distributed across many modules
- callers can forget to refresh
- refresh scope is coarse even when the mutation is local
- `bump()` is a hidden coupling point between unrelated domains
- the UI is reactive only because code manually invalidates it

## Recommended Approach

Introduce a query module, likely `apps/desktop/src/stores/queries.ts`, that owns reactive DB-backed collections and all reloading behavior.

### Responsibilities of `queries.ts`

- own `repos: Ref<Repo[]>`
- own `items: Ref<PipelineItem[]>`
- own loading state for these collections
- own functions such as:
  - `loadRepos()`
  - `loadItems()`
  - `reloadAll()`
  - `reloadRepos()`
  - `reloadItems()`
  - optionally `reloadRepoItems(repoId)` if the implementation proves worth it
- perform any one-time repo-config stage-order cache hydration that is currently embedded in the `items` loader

This creates one explicit boundary:

- DB writes happen in action modules
- query refresh happens through the query layer

No other module should manually invalidate arbitrary store state.

## Data Flow

### Before

```text
action writes DB
  -> action calls bump()
  -> refreshKey changes
  -> computedAsync re-runs later
  -> repos/items eventually update
```

### After

```text
action writes DB
  -> action calls queryLayer.reloadItems() or reloadRepos()
  -> query layer re-reads DB immediately
  -> repos/items refs update directly
```

This is still explicit, but it is explicit at the right boundary rather than hidden behind a global refresh lever.

## Why Not Other Approaches

### Option 1: Keep `bump()` and rename it

This does not solve the architectural problem. The issue is not the name; the issue is that many modules must remember to poke a global invalidation token.

### Option 2: Generic table-change event bus

This is better than `bump()`, but still based on broad invalidation signaling. It also introduces a second infrastructure concept without much gain. For this codebase, a small query layer is simpler and easier to trace.

### Option 3: In-memory store state is canonical

This would produce a reactive UI easily, but it contradicts the requirement that the DB is the source of truth. It also increases the risk of divergence during startup recovery, undo flows, and daemon-driven events.

## Proposed Structure

### `apps/desktop/src/stores/state.ts`

Keep:

- long-lived refs unrelated to DB query invalidation
- preferences refs
- selection refs
- caches such as workflow/agent/stage-order
- pending setup / runtime timers

Remove:

- `refreshKey`
- `bump`
- `computedAsync` ownership of `repos` and `items`

### `apps/desktop/src/stores/queries.ts`

New module.

Responsibilities:

- initialize `repos` and `items` refs
- read from DB
- hydrate stage-order cache from repo config as part of item loading
- expose narrow reload methods

Suggested API:

```ts
export interface QueriesApi {
  repos: Ref<Repo[]>;
  items: Ref<PipelineItem[]>;
  loadInitialData(): Promise<void>;
  reloadRepos(): Promise<void>;
  reloadItems(): Promise<void>;
  reloadAll(): Promise<void>;
}
```

If a narrower method like `reloadRepoItems(repoId)` proves worthwhile, it can be added, but the initial design should stay small.

### `apps/desktop/src/stores/kanna.ts`

Responsibilities after change:

- create state
- create query layer
- pass query layer into task/session/workflow/init modules as needed
- stop exporting `bump()`

## Architectural Rules

### 1. Query ownership is centralized

Only `queries.ts` owns reloading logic for DB-backed reactive collections.

Other modules may:

- write to the DB
- call a query-layer reload method

Other modules may not:

- mutate `repos` as ad hoc refresh logic
- maintain their own alternate reload token
- recreate `computedAsync` loaders for the same data

### 2. DB is canonical

The query layer must always reload from the DB after mutations that affect canonical state.

Optimistic local mutation is acceptable only for truly temporary UI state, such as the existing pending-create placeholder, and even that state must reconcile back through the query layer.

### 3. Narrow reloads where obvious, broad reloads where safer

Prefer correctness first:

- `reloadItems()` after task and activity mutations
- `reloadRepos()` after repo mutations
- `reloadAll()` only when a mutation genuinely crosses both boundaries or when startup/init simplicity matters more than precision

Do not over-engineer per-row patching unless it removes meaningful complexity.

## Migration Strategy

### Phase 1: Introduce the query layer alongside existing modules

- create `queries.ts`
- move `repos` and `items` ownership there
- keep the rest of the store API stable

### Phase 2: Remove `refreshKey` plumbing

- delete `refreshKey` from `state.ts`
- delete `bump` from `StoreContext`
- remove `bump()` export from `kanna.ts`

### Phase 3: Replace mutation-time refresh calls

For each current `context.bump()` call:

- determine whether it should become `reloadItems()`, `reloadRepos()`, or `reloadAll()`
- replace the call with the narrowest correct query-layer reload

### Phase 4: Keep local-only state truly local

Existing direct local mutations that represent transient UI behavior, such as pending placeholders before the DB row is fully established, may remain. But once the DB write completes, the query layer becomes responsible for canonical reconciliation.

## Expected Effects By Module

### `tasks.ts`

Most `bump()` calls here should become `reloadItems()`. Repo creation/import flows should also use `reloadRepos()` where appropriate.

### `sessions.ts`

Runtime-status updates should write activity to the DB, then reload items through the query layer rather than globally invalidating store state.

### `workflow.ts`

Stage reruns and stage-complete transitions should reload items after DB writes that affect canonical task state.

### `init.ts`

Startup should call `loadInitialData()` or `reloadAll()` after recovery work, not a generic `bump()`.

### `selection.ts`

No architectural change is needed beyond consuming the query-owned `repos` and `items` refs.

## Testing

The key thing to verify is not just type safety, but that the UI-facing refs still update when DB-backed state changes.

Required verification:

- `pnpm exec tsc --noEmit`
- `pnpm test -- src/stores/kanna.runtimeStatusSync.test.ts`
- `pnpm test -- src/stores/kanna.taskBaseBranch.test.ts`
- any additional store tests that currently rely on `readRepoConfig`, `collectTeardownCommands`, or init-driven updates

Recommended targeted tests:

- a test proving repo mutations update `repos` without `bump()`
- a test proving task/activity mutations update `items` without `bump()`

## Files Expected To Change

- `apps/desktop/src/stores/kanna.ts`
- `apps/desktop/src/stores/state.ts`
- `apps/desktop/src/stores/queries.ts`
- `apps/desktop/src/stores/selection.ts`
- `apps/desktop/src/stores/sessions.ts`
- `apps/desktop/src/stores/workflow.ts`
- `apps/desktop/src/stores/tasks.ts`
- `apps/desktop/src/stores/init.ts`
- touched store tests under `apps/desktop/src/stores/`

## Resolved Decisions

- The DB remains the source of truth.
- `bump()` is removed rather than renamed.
- Refresh logic moves into a single query layer instead of a generic event bus.
- The store stays reactive by updating DB-backed refs through explicit query reload methods.
- Correctness takes priority over hyper-granular per-row diffing.

## Risks And Controls

### Risk: placeholder UX regresses during task creation

Control:

- keep temporary placeholder state local where needed
- reconcile against canonical query reload immediately after DB insertion and setup transitions

### Risk: over-refreshing causes unnecessary work

Control:

- start with a small API of `reloadRepos()`, `reloadItems()`, and `reloadAll()`
- narrow only where the code clearly benefits

### Risk: some DB writes stop refreshing the UI

Control:

- make query reload calls explicit at the write boundary
- cover task/activity and repo mutation flows with targeted tests

## Implementation Notes

- Do not replace `bump()` with a disguised global invalidation helper.
- Do not spread reload policy back across modules after creating `queries.ts`.
- Prefer straightforward reload-after-write behavior over clever caching until the architecture is stable.
