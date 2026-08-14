# New Task Options UI Cache Design

## Problem

The New Task modal opens before its repository-specific options finish loading. `openNewTaskModal()` currently clears the option refs before mounting the modal, so the base-branch control briefly has no valid selection and renders “Select a valid base branch.” The message is accurate for a fully loaded repository with no usable branch, but misleading during ordinary loading.

## Goals

- Reopening New Task for a previously loaded repository immediately displays its last known valid options.
- Every open still refreshes repository options so branches, workflows, and agent availability do not become permanently stale.
- A repository that has never loaded does not display a validation error while options are loading.
- Switching repositories while loads overlap never displays or commits options from the wrong repository.
- Genuine loaded states with no valid base branch continue to display “Select a valid base branch” and block creation.

## Non-goals

- Persisting New Task options across application restarts.
- Adding a time-to-live or suppressing refreshes.
- Caching the prompt, manually selected workflow, manually selected branch, or other draft form state.
- Changing backend branch discovery or repository-definition APIs.

## Design

`useAppTaskCreation` will own an in-memory map keyed by repository id. Each entry is one complete New Task option snapshot containing:

- available agent providers;
- available workflows and the default workflow;
- available base branches and the resolved default base branch;
- the repository default branch name.

When New Task opens, the composable will determine the target repository before changing visible option state. If that repository has a cached snapshot, it will synchronously apply the entire snapshot and then mount the modal. If it has no snapshot, it will clear the option refs as it does today. In both cases it will mark options as loading, mount the modal immediately, and start a fresh load.

The load will continue to use the existing generation check. After all option sources for a local repository resolve, the composable will build one snapshot, confirm that the load is still current and the modal is still open, then update both the cache and visible refs together. Cloud-only repositories will use the same snapshot boundary after their remote branch lookup. Failed sources retain the existing fallback values and error reporting; the resulting complete snapshot represents the usable result of that load.

The cache remains local to the `useAppTaskCreation` instance. It therefore lasts for the desktop UI session, is naturally discarded when the application controller is rebuilt, and cannot leak between application instances.

## Loading Presentation

Cached values remain visible and disabled while the background refresh is running, matching the current rule that options and submission cannot be changed during a load.

For an uncached repository, the base-branch value will show the existing loading-options label while `optionsLoading` is true. It will not use invalid styling during that state. Once loading finishes, a missing valid branch reverts to the existing validation label and invalid styling. This distinguishes incomplete data from a completed invalid result without adding another translation string.

## Data Consistency

Snapshots are repo-scoped, so opening repository B can never hydrate repository A's values. The cache is updated only after the generation and modal-open guards pass. A superseded or cancelled load neither changes visible state nor replaces the cached snapshot.

Each refresh replaces the full snapshot rather than mutating fields as individual requests resolve. This prevents combinations such as a new default branch paired with an old branch list.

## Testing

Composable tests will verify that:

- reopening a repository hydrates its previous snapshot synchronously while a second load remains pending;
- the second load still runs and replaces cached and visible values when it completes;
- different repositories use separate snapshots;
- superseded loads do not overwrite visible state or cache.

Component tests will verify that:

- an uncached loading modal displays the loading label without invalid styling;
- a completed load with no valid base branch still displays the validation label and invalid styling;
- cached valid branch values remain visible during loading.

Focused Vitest suites for the composable and modal will run first, followed by the desktop test suite or the broadest practical repository check.
