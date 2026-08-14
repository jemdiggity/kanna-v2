# DB Query Layer With Embedded Optimistic Overlays

## Summary

Replace the store’s manual `bump()` / `refreshKey` invalidation model with a DB-backed query layer that exposes reactive refs and embeds optimistic overlays internally. The UI should never directly mutate canonical `repos` or `items`. Instead, components call store mutations, those mutations write through a query/mutation layer, and the query layer is responsible for both:

- loading canonical data from SQLite
- merging temporary optimistic state into the exposed reactive result

The database remains the source of truth. Optimism is allowed, but only if it is encapsulated inside the query layer rather than spread through UI or store modules.

## Goals

- Remove `bump()` from the store API and internal architecture.
- Remove `refreshKey` from `state.ts`.
- Keep SQLite as the canonical source of truth.
- Keep `repos` and `items` reactive for the UI.
- Ensure UI code never mutates canonical query refs directly.
- Encapsulate optimistic task/repo overlays in one query layer rather than mutating `items.value` ad hoc.

## Non-Goals

- Replacing SQLite with a new persistence layer.
- Introducing a generic invalidation event bus.
- Making the UI optimistic everywhere by default.
- Turning the query layer into a generic cache framework for every future data shape.

## Current Problem

The current refactor still relies on:

- `refreshKey` in `state.ts`
- `computedAsync` reads for `repos` and `items`
- many distributed `context.bump()` calls
- some direct local mutation of `items.value` for pending placeholders or immediate UI transitions

This mixes three responsibilities that should be separate:

- canonical DB reads
- optimistic temporary UI state
- invalidation/reload mechanics

The result is hard to reason about because:

- writes and refresh logic are scattered
- UI and store code can shape canonical collections directly
- there is no single place that defines how optimistic state reconciles with DB state

## Recommended Approach

Add a focused query layer, likely `apps/desktop/src/stores/queries.ts`, that owns the reactive read model for DB-backed collections.

The query layer should own:

- canonical `repos` loaded from the DB
- canonical `items` loaded from the DB
- optimistic overlays for repos/items where needed
- merged reactive refs exposed to the rest of the app
- refresh/reload methods
- small helper methods for optimistic mutation lifecycles

The UI reads only the merged reactive refs. It never directly mutates them.

## Data Model

### Canonical State

Loaded from SQLite:

- `baseRepos: Ref<Repo[]>`
- `baseItems: Ref<PipelineItem[]>`

### Optimistic Overlays

Owned by the query layer:

- `optimisticRepos: Map<string, RepoOverlay>`
- `optimisticItems: Map<string, PipelineItemOverlay>`

These overlays may represent:

- pending task placeholders before DB insertion fully settles
- temporary hidden/renamed/closed states while a mutation is in flight
- other short-lived UI responsiveness cases where immediate feedback is useful

### Exposed Reactive State

Computed from canonical state plus overlays:

- `repos: ComputedRef<Repo[]>`
- `items: ComputedRef<PipelineItem[]>`

Consumers see only the merged result.

## Data Flow

### Read Path

```text
SQLite rows
  -> query layer loads canonical refs
  -> query layer merges optimistic overlays
  -> UI consumes merged reactive refs
```

### Mutation Path

```text
UI calls store mutation
  -> mutation delegates to query/mutation layer
  -> optional optimistic overlay is applied
  -> DB write executes
  -> query layer reloads canonical data
  -> optimistic overlay is reconciled or removed
  -> merged refs update reactively
```

This preserves the DB as the one source of truth while still allowing responsive UI behavior.

## Proposed Structure

### `apps/desktop/src/stores/state.ts`

Keep:

- selection refs
- preferences refs
- caches such as workflow/agent/stage-order
- pending runtime timers and similar non-canonical state

Remove:

- `refreshKey`
- `bump`
- ownership of DB-backed `repos` and `items`

### `apps/desktop/src/stores/queries.ts`

New module. This is the core of the design.

Responsibilities:

- load canonical `repos` and `items` from SQLite
- hydrate repo-config-derived stage-order cache during item loading
- own optimistic overlays
- expose merged reactive refs
- provide refresh methods
- provide optimistic helpers for mutation flows

Suggested API:

```ts
export interface QueryState<T> {
  data: ComputedRef<T>;
  pending: Ref<boolean>;
  error: Ref<unknown>;
  refresh: () => Promise<void>;
}

export interface QueriesApi {
  repos: QueryState<Repo[]>;
  items: QueryState<PipelineItem[]>;
  loadInitialData(): Promise<void>;
  reloadRepos(): Promise<void>;
  reloadItems(): Promise<void>;
  reloadAll(): Promise<void>;
  withOptimisticItemOverlay<T>(input: {
    key: string;
    apply(base: PipelineItem[]): PipelineItem[];
    run: () => Promise<T>;
    reconcile?: () => Promise<void>;
  }): Promise<T>;
}
```

The exact helper names may change, but the ownership should not.

### `apps/desktop/src/stores/kanna.ts`

Responsibilities after change:

- create shared state
- create the query layer
- compose mutation modules around it
- expose query-backed refs and mutation actions
- stop exporting `bump()`

## Architectural Rules

### 1. UI cannot mutate canonical query state

No component or store action should directly assign into canonical `repos` or `items`.

That means no patterns like:

- `items.value = ...`
- `repos.value = ...`

outside the query layer itself.

### 2. Optimism belongs to the query layer

Optimistic behavior is allowed only when it is encapsulated inside the query layer.

Mutation modules may ask for an optimistic overlay, but they may not implement overlay logic themselves.

### 3. DB remains canonical

After a mutation settles, the canonical result must come from a DB reload, not from trusting the optimistic patch forever.

### 4. Query ownership is centralized

Only `queries.ts` may define how DB-backed collections refresh, merge, and reconcile.

Other modules may:

- write to the DB
- request query refresh
- request optimistic overlays through the query API

Other modules may not:

- create alternative refresh tokens
- maintain parallel canonical collection refs
- patch canonical query results directly

## Why This Is Better Than Plain Reload-After-Write

A simple reload-after-write model already improves on `bump()`, but it does not fully solve the existing architectural problem because the current store still wants temporary pending placeholders and immediate visual transitions.

If optimism is left outside the query layer, the app ends up with:

- a canonical query layer
- plus ad hoc local mutation paths in task/store code

That just recreates the same ownership confusion in a different form.

Embedding optimism in the query layer gives one clear place to answer:

- what is canonical?
- what is temporary?
- when does temporary state disappear?
- how do merged query refs behave?

## Migration Strategy

### Phase 1: Introduce `queries.ts`

- move canonical `repos` and `items` ownership there
- expose merged reactive refs
- keep the rest of the store API stable at first

### Phase 2: Remove invalidation plumbing

- delete `refreshKey`
- delete `bump`
- replace `computedAsync` ownership with query-layer refs

### Phase 3: Move optimistic placeholder logic into the query layer

- remove direct `items.value` mutations from task flows
- reimplement pending create behavior as an optimistic item overlay

### Phase 4: Replace mutation-time `bump()` calls

For each DB mutation:

- decide whether it needs:
  - pure reload
  - optimistic overlay + reload
- move that behavior behind query-layer helpers

## Expected Module Effects

### `tasks.ts`

This module should stop mutating `items.value` directly. Task creation placeholders and similar immediate feedback should become optimistic overlays managed by `queries.ts`.

### `sessions.ts`

Runtime status updates should write activity to the DB, then request query-layer reconciliation rather than invalidating global store state.

### `workflow.ts`

Stage transitions should rely on query-layer refresh after DB mutations that affect task rows.

### `init.ts`

Startup should call `loadInitialData()` or explicit query refresh methods, not `bump()`.

### `selection.ts`

Selection logic should consume query-backed refs exactly as if they were ordinary reactive arrays. It should not need to know which entries are canonical versus optimistic.

## Testing

Required verification:

- `pnpm exec tsc --noEmit`
- `pnpm test -- src/stores/kanna.runtimeStatusSync.test.ts`
- `pnpm test -- src/stores/kanna.taskBaseBranch.test.ts`
- relevant config/init store tests that touch query-backed state

Recommended targeted tests:

- query layer returns canonical rows when no overlays exist
- optimistic task overlay appears immediately during create flow
- optimistic overlay disappears after successful DB reconciliation
- optimistic overlay is removed on failed mutation

## Files Expected To Change

- `apps/desktop/src/stores/kanna.ts`
- `apps/desktop/src/stores/state.ts`
- `apps/desktop/src/stores/queries.ts`
- `apps/desktop/src/stores/tasks.ts`
- `apps/desktop/src/stores/sessions.ts`
- `apps/desktop/src/stores/workflow.ts`
- `apps/desktop/src/stores/init.ts`
- touched store tests under `apps/desktop/src/stores/`

## Resolved Decisions

- The DB remains the source of truth.
- `bump()` is removed rather than renamed.
- Reactive reads come from a query layer.
- UI reads merged reactive refs and never patches canonical collections directly.
- Optimistic behavior is allowed, but only inside the query layer.
- Canonical reconciliation always comes back through the DB.

## Risks And Controls

### Risk: query layer becomes too generic

Control:

- keep the API narrow and store-focused
- support only the read shapes and optimistic helpers this store actually needs

### Risk: placeholder UX regresses during task creation

Control:

- move pending placeholder behavior into optimistic item overlays
- test immediate appearance, success reconciliation, and failure cleanup

### Risk: mutation modules still patch collections directly out of habit

Control:

- remove write access patterns from those modules
- make the query layer the only owner of DB-backed collection refs

## Implementation Notes

- Do not replace `bump()` with another global invalidation token.
- Do not let “temporary UI state” become an excuse for direct collection mutation outside the query layer.
- Prefer a small, explicit overlay model over a clever general-purpose patch engine.
