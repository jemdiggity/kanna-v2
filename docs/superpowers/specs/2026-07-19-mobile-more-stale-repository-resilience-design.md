# Mobile More Stale Repository Resilience Design

## Problem

The mobile repository list combines explicit repository catalogs with repositories derived from cloud task snapshots. A task-derived repository can outlive the repository row or route that originally backed it. When More opens, it automatically requests the selected repository's command catalog. If that repository is stale, the request can return `404 /v1/repos/{repoId}/commands`, and the whole More screen shows `Commands unavailable` even when other repositories remain usable.

Task-derived repositories must remain available to task browsing and history. Their presence must not make the repository command UI unusable.

## Desired Behavior

- More continues to load the selected repository first.
- A command-catalog failure marks only that repository unavailable for the current mobile session.
- More excludes unavailable repositories from its repository chips and automatically tries the next candidate repository.
- A successful catalog with zero commands is still a valid repository and shows the existing empty-catalog state.
- More shows its terminal `Commands unavailable` state only after every candidate repository has failed.
- Selecting or refreshing repositories outside More remains unchanged. Stale task-derived repositories are not removed from shared task/history state.
- A later explicit retry clears the transient unavailable set and probes repositories again, allowing a recovered route to reappear.

## Architecture

Keep command availability in the mobile session store, separate from the shared `repos` collection. The store will track repository IDs whose command-catalog reads failed and expose the data needed by More to filter its chips.

The mobile controller will own fallback orchestration because it already owns catalog reads, selection changes, generation guards, and retry behavior. A catalog failure will be handled as a repository-local failure: record the failed ID, select the next repository that is not known unavailable, and load its catalog. Existing generation checks will prevent late reads from overwriting a newer selection.

The More screen remains presentational. `RootNavigator` filters the shared repository list using the store's unavailable IDs before passing repositories to More; the screen does not perform network requests itself.

## Data Flow

1. The user opens More.
2. The controller requests commands for the selected repository.
3. On success, the controller clears any transient failure for that repository and stores the catalog as it does today.
4. On failure, the controller records that repository as unavailable and finds the next repository in the current ordered list that is not marked unavailable.
5. If a candidate exists, the controller selects it and repeats the catalog load. The failed repository is no longer rendered as a More chip.
6. If no candidate exists, the controller retains the final error so More can show `Commands unavailable` and retry.
7. Retry clears transient command-unavailability state and starts again from the current repository list.

## Error Handling

All command-catalog read failures are isolated at repository scope. This includes a stale `404`, an unavailable owning desktop, or another route/read failure. The fallback loop is bounded by the number of repositories because each failed ID is excluded before another read starts.

Command execution failures are unchanged. A repository is marked unavailable only when its catalog cannot be read; a failed command run must not silently hide the repository.

Empty catalogs are successful reads and must not trigger fallback.

## Testing

Controller tests will cover:

- opening More with a stale selected repository falls through to the next repository and reaches `ready`;
- the stale repository is recorded as unavailable without being removed from the shared repository collection;
- multiple stale repositories are skipped without an unbounded retry loop;
- an empty but successful catalog remains selected;
- all candidates failing produces the existing error state;
- retry clears transient failures and can restore a previously unavailable repository;
- stale in-flight catalog responses still cannot overwrite the current selection.

Screen or navigation tests will verify that repositories marked unavailable are not rendered as More chips while task-oriented repository state remains intact.

## Scope

This change does not alter cloud task retention, repository publication, server repository storage, or task-list filtering. Those systems may still expose task-derived repositories for history. The change only prevents stale command routes from breaking the mobile More experience.
