# Markdown Preview Mode Preference Design

## Goal

Markdown files should open rendered for a user who has never chosen a preview mode. After the user switches between rendered and raw Markdown, Kanna should reuse that choice for every Markdown preview and across app restarts.

## Behavior

- A missing preference defaults to `rendered`.
- Toggling a Markdown preview to `raw` or `rendered` immediately updates the active preview and becomes the default for later Markdown previews.
- The last choice applies globally across tasks, repositories, windows, and restarts.
- Non-Markdown files continue to use syntax-highlighted raw previews and do not read or change the Markdown preference.
- Unknown persisted values fall back to `rendered`.

## Architecture

Use the existing SQLite-backed desktop settings map as the source of truth. Add a typed Markdown preview mode with a `rendered` default and a normalizer that accepts only `raw` or `rendered`. Load the setting through the existing snapshot-to-store path and expose it from the Kanna store.

`useAppModals` will read the global store value when it supplies `initialMarkdownMode` to `FilePreviewModal`. When the modal emits a mode change, `useAppModals` will update the in-memory store value immediately and queue persistence through `store.savePreference`. Only one save-and-snapshot-reload transaction may be in flight; pending toggles coalesce to the latest mode. After an older reload completes, the pending optimistic mode is reapplied before that latest mode is saved. Markdown mode will be removed from the task/repository-scoped file preview recall state; that state will continue to remember only the last file and line for each flow.

`FilePreviewModal` will also use `rendered` as its standalone prop default. Its existing Markdown extension check remains authoritative, so a rendered preference cannot affect non-Markdown files.

The settings table already accepts arbitrary keys, so this change requires no database migration.

A settings PUT broadcasts KSP state changes and may overlap an already-running snapshot reload. The shared `reloadSnapshot` path therefore uses latest-started semantics: only the current run may apply the fetched base snapshot and settings, record and propagate an error, or clear the shared pending state. Ownership is checked immediately after fetching and again after asynchronous repository-config reads, before synchronous publication. A superseded success returns before publication, and a superseded failure is ignored without clearing the current run's pending state.

## Failure Handling

If saving the setting fails, the current app session keeps the user's immediate selection and logs the persistence failure using the existing frontend logging convention. The persistence drain continues, so a queued newer choice can still be saved. Invalid or absent values loaded at startup safely normalize to `rendered`.

## Testing

Focused tests will cover:

- the store defaults a missing or invalid setting to `rendered`;
- the store restores persisted `raw` and `rendered` values;
- a Markdown preview opens rendered before the user has chosen a mode;
- toggling to raw updates the global preference and calls the existing persistence API;
- the raw choice is reused when opening Markdown in another task or repository flow;
- rapid toggles remain single-flight and finish on the latest choice even when completion is released in reverse order;
- a failed earlier save is logged without blocking a queued latest choice;
- a newer, non-default raw snapshot applies immediately and remains authoritative when an older rendered snapshot resolves last;
- stale success and failure settlement cannot publish settings, record an error, reject, or clear pending while the newer reload remains unresolved;
- an older reload paused in a repository-config read cannot publish after a newer raw snapshot completes, covering the post-config-loop ownership check;
- a current reload failure still rejects, records its error, and clears pending;
- non-Markdown previews remain raw regardless of the Markdown preference.

The focused desktop unit and integration tests are sufficient because this reuses the existing settings API and preview event wiring; no Rust or database schema behavior changes.

## Expected Files

- `apps/desktop/src/stores/queries.ts` — enforce latest-started snapshot publication, error, and pending semantics.
- `apps/desktop/src/stores/kanna.querySnapshot.test.ts` — cover reversed snapshot completion, stale settlement while current work remains pending, and supersession during repository-config loading.

## Non-goals

- Adding a separate Preferences-panel control.
- Remembering a different Markdown mode per task, repository, file, or window.
- Changing Markdown rendering, sanitization, syntax highlighting, or search behavior.
