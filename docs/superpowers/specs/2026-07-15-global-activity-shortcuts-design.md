# Global Activity Shortcuts Design

## Goal

Make the Shift variants of Kanna's read/unread task shortcuts select the oldest eligible task across all visible repositories, while leaving the unshifted shortcuts scoped to the selected repository.

## Shortcut Contract

| Shortcut | Behavior |
| --- | --- |
| `Cmd+U` | Select the oldest unread task in the selected repository. If none exists, select the oldest read task in that repository. |
| `Shift+Cmd+U` | Select the oldest unread task across all visible repositories. If none exists, select the oldest read task across those repositories. |
| `Cmd+R` | Select the oldest read task in the selected repository. |
| `Shift+Cmd+R` | Select the oldest read task across all visible repositories. |

"Oldest" continues to mean the earliest task `created_at`. It does not use `unread_at` or `activity_changed_at`.

"Read" continues to mean `activity === "idle"`; working tasks are not read-navigation candidates.

## Candidate Scope

The local shortcuts use the existing selected-repository sidebar projection. The global shortcuts use the existing all-visible-repositories sidebar projection. Consequently, global navigation includes local and cloud-backed repositories currently present in the sidebar, honors the active sidebar search filter, and excludes hidden repositories.

Existing eligibility rules remain unchanged:

- pinned tasks are excluded from activity shortcuts;
- tasks whose workspaces are tearing down are excluded;
- blocked tasks are excluded from read selection, including the unread shortcut's read fallback;
- unread selection otherwise retains its current blocker behavior.

Closed tasks remain absent because the sidebar projections already exclude them.

## Architecture

Parameterize the existing read and unread-with-read-fallback navigation helpers with an explicit scope: current repository or all visible repositories. Candidate filtering, oldest-task selection, fallback behavior, and cross-repository selection remain in the existing navigation composable.

Navigation history remains a single in-memory ledger, but its identities are workspace presentation-slot IDs rather than local-only task slots. The store exposes identity-agnostic record/back-target/forward-target operations, while `useAppTaskNavigation` applies those targets through the same local-or-remote selection path. This lets a global shortcut jump to a cloud-backed task and still return with Back, and it lets every Back/Forward action invalidate any older asynchronous repository-selection intent.

Server state-change refreshes preserve focus only when the selected repository and presentation slot still match the values captured before the refresh. This prevents a delayed settings or session refresh from restoring the task that was selected before a cross-repository shortcut completed.

Rename the Shift shortcut action identifiers from "newest" semantics to explicit global-oldest semantics. Update their English, Japanese, and Korean shortcut labels to describe the new scope. The unshifted action identifiers and labels remain unchanged.

The generic activity-selection utility may retain its current oldest/newest capability; removing an otherwise harmless mode is outside this behavior change.

## Data Flow

1. The keyboard registry maps an unshifted shortcut to a current-repository action and a Shift shortcut to an all-repositories action.
2. The action requests read or unread-with-fallback selection with the corresponding scope.
3. The navigation composable obtains the scoped sidebar projection and applies existing eligibility filters.
4. `selectTaskByActivity` chooses the candidate with the earliest `created_at`.
5. The existing sidebar selection path selects the task. If it belongs to another repository, that path first changes repositories and then selects the task while preserving navigation history and selection-intent race protection.
6. Back and Forward resolve a visible workspace presentation slot from the shared history ledger, then route it through that same repository-aware selection path without recording a circular history entry.

If no eligible task exists after fallback, navigation is a no-op. Existing selection errors continue through the current asynchronous selection path; this feature adds no new error surface or toast.

## Testing

Add or update tests that prove:

- `Cmd+U` and `Cmd+R` remain scoped to the selected repository;
- `Shift+Cmd+U` chooses the globally oldest unread task and switches repositories;
- `Shift+Cmd+U` falls back to the globally oldest eligible read task when no unread task exists;
- `Shift+Cmd+R` chooses the globally oldest eligible read task and switches repositories;
- global shortcuts preserve pinned, teardown, blocked-read, search, and visible-repository candidate rules through the shared helper;
- shortcut definitions dispatch the renamed global actions;
- the shortcut modal displays the new localized global-oldest labels.
- a local-to-remote global shortcut records the previous presentation slot, and Back/Forward crosses owners correctly;
- a newer Back action cancels an older pending cross-repository selection;
- a newer task selection survives an older in-flight server state refresh;
- the active mock E2E shortcut suite reflects local-unshifted/global-shifted behavior, including global read fallback.

Focused desktop unit tests should cover the navigation and registry changes, followed by the repository's normal desktop typecheck and relevant broader test command.

## Non-Goals

- Changing sidebar sort order.
- Changing how unread timestamps are recorded.
- Including hidden repositories or tasks filtered out of the sidebar.
- Adding cyclic navigation or retaining the current newest-task shortcuts under different keys.
- Changing task activity, pinning, blocker, or teardown semantics.
