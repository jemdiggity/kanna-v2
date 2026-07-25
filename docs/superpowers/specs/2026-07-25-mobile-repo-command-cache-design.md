# Mobile Repository Command Cache Design

## Context

The mobile More screen currently treats repository command discovery as an
availability probe. Opening More clears the selected catalog, requests it from
the repository's owning desktop, and shows `Commands unavailable` if that
request fails. A brief relay disconnect can therefore blank commands that the
app loaded successfully moments earlier.

Other mobile collection paths retain last-good repository and task snapshots
when a later source read fails. Repository commands should follow the same
session-level behavior.

## Goals

- Retain each successfully loaded repository command catalog for the current
  application session.
- Show cached commands immediately when revisiting or refreshing a repository.
- Refresh the catalog in the background and replace the cache on success.
- Keep cached commands visible when a refresh fails.
- Preserve the existing error and repository-fallback behavior when no cached
  catalog exists.
- Never retain a catalog after the server confirms its revision is stale.

## Non-Goals

- Persist command catalogs in AsyncStorage or across app restarts.
- Add catalog expiry timers or a general-purpose caching framework.
- Retry command execution automatically.
- Make commands executable while their owning desktop is offline.
- Change server catalog composition or relay protocol behavior.

## Design

### Cache ownership

The mobile controller owns an in-memory map from display repository ID to
`RepoCommandCatalog`. The controller already coordinates catalog reads,
repository selection, command launches, and stale-revision recovery, so keeping
the cache there avoids adding persistence or transport-specific state.

Only successful catalog responses enter the cache. Catalogs are stored under
the selected display repository ID after the routed client normalizes any local
owner repository identity.

### Catalog loading

When command loading begins for a selected repository:

1. If the cache contains a catalog for that repository, publish it to the
   session store immediately with `ready` status.
2. Request a fresh catalog from the routed client.
3. On success, replace the cached catalog and publish the fresh value if the
   request still belongs to the selected repository and active load generation.
4. On failure with a cached catalog, leave the cached catalog and `ready`
   status intact. Do not mark the repository unavailable or select a different
   repository.
5. On failure without a cached catalog, retain the existing behavior: mark the
   repository command source unavailable, try the next repository, and show the
   error UI only after every available repository fails.

Generation and selected-repository checks remain authoritative. A late request
must not populate the visible store for a repository the user has left.

### Repository switching

The session store continues to hold only the selected repository's visible
catalog. The controller map retains catalogs for other repositories. Returning
to a previously loaded repository restores its cached commands synchronously
before its refresh completes.

This keeps presentation state simple while allowing multiple repository
catalogs to survive selection changes.

### Stale revisions

A command launch may return a conflict indicating that the displayed catalog
revision is stale. That response is authoritative evidence that the cached
catalog is invalid.

Before the existing reload path runs, the controller removes that repository's
cached catalog and clears the visible catalog. The reload must obtain a fresh
catalog; if it cannot, the normal unavailable state is shown rather than
restoring known-stale commands.

Other launch failures do not evict the cache because they do not establish that
the catalog contents changed.

### Error presentation

Cached refresh failures are intentionally silent, matching last-good repository
supplementation. Commands remain visible, and attempting one still contacts the
owning desktop. The existing catalog revision in the run request prevents a
cached command from silently executing different server behavior.

When no catalog has ever loaded for a repository, the existing
`Commands unavailable` state and `Try Again` action remain unchanged.

## Testing

Controller tests will prove:

- A successful catalog remains visible when a later refresh fails.
- Returning to a repository restores its cached catalog while refresh is in
  flight.
- A successful refresh replaces the cached revision.
- An initial failure without cache retains the existing unavailable fallback.
- A stale-revision command conflict evicts the known-stale cache before reload.
- Existing generation guards prevent late refreshes from replacing the selected
  repository's visible catalog.

Focused verification:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts src/state/sessionStore.test.ts
pnpm --dir apps/mobile run typecheck
```

