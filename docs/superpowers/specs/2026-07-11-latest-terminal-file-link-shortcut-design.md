# Latest Terminal File Link Shortcut

## Summary

Add a dedicated `⌘L` shortcut that opens the newest valid file path mentioned in the selected local PTY agent terminal. Reuse Kanna's existing file-link validation and preview events so text files, image files, and `:line[:column]` suffixes behave exactly like Cmd+click terminal links.

Teach the shortcut with a once-per-install informational toast the first time Kanna detects an openable terminal file link:

> Tip: Press ⌘L to open the latest file mentioned by the agent.

## Goals

- Let a keyboard-focused user open the most recently printed file link with one shortcut.
- Preserve the existing file preview, image preview, and line-number behavior.
- Make the shortcut discoverable without showing a hint for every task or every link.
- Keep path recognition and validation in one terminal-file-link source of truth.
- Include the action in Kanna's keyboard shortcut help and command palette.

## Non-goals

- Choosing among several links. The newest valid link wins in this first version.
- Adding file-link navigation to SDK/chat, cloud, mobile, or shell terminals.
- Expanding the accepted path syntax beyond what local PTY terminal links already recognize.
- Changing `⌘P`, `⌥⌘P`, Cmd+click, or file-preview recall semantics.
- Opening the file directly in the configured IDE.

## User Experience

### Successful shortcut

1. The agent prints one or more file paths in its local PTY terminal.
2. The user presses `⌘L`.
3. Kanna searches the selected terminal buffer from newest content to oldest.
4. Within a line, Kanna searches from right to left, so the final path printed on the newest matching line wins.
5. Nonexistent candidates are skipped.
6. A text file opens in the existing file preview. A `:line` or `:line:column` suffix opens and highlights the line; the column remains ignored, matching Cmd+click.
7. An image file opens in the existing image preview.

The search covers the terminal's current xterm buffer, including available scrollback. It does not depend on the mouse having hovered over a link first.

### No available link

If the selected task has no registered local PTY terminal or its buffer has no valid file link, Kanna shows an informational toast:

> No file link found in this terminal.

The action otherwise has no effect.

### Discovery toast

When a local PTY terminal first detects an openable file link, Kanna shows:

> Tip: Press ⌘L to open the latest file mentioned by the agent.

Kanna records a versioned flag in local storage before displaying the toast. Later links, tasks, windows, and app restarts do not repeat this version of the hint. The shortcut remains discoverable in `⌘/` keyboard help and the command palette.

## Architecture

### Shared path detection

Refactor `apps/desktop/src/composables/terminalFileLinks.ts` so link parsing and worktree-relative resolution are shared by both xterm's hover link provider and the new newest-link scan. A resolved candidate contains:

- the displayed terminal text and buffer position;
- the absolute path used for existence validation;
- the worktree-relative path used by the text preview;
- the optional line number; and
- whether the path is a supported image.

Relative candidates that contain a `..` path segment are rejected so keyboard activation cannot escape the active worktree. Absolute candidates remain restricted to the active worktree. Existing supported syntax stays unchanged otherwise.

The terminal file-link provider gains asynchronous operations to find and activate the newest valid candidate. It scans xterm rows using the buffer's zero-based line API, checks candidates in newest-first order, and reuses the provider's existing per-terminal existence cache. Activation dispatches the existing bubbling events:

- `file-link-activate { path, line }`
- `image-link-activate { url }`

No preview-specific behavior is duplicated in the terminal layer.

### Session-scoped terminal registry

Add a small frontend registry keyed by agent session id. An initialized local PTY terminal registers its newest-link activation operation and unregisters it when disposed. Cached terminals may remain registered, but the keyboard action addresses only the currently selected task's session id.

This avoids threading component refs through `MainPanel` → `TerminalTabs` → `TerminalView` while keeping terminal ownership and cleanup explicit. Registration cleanup only removes the matching provider instance, so a stale terminal cannot unregister a replacement created for the same session id.

### Keyboard action

Add `openLatestFileLink` to the centralized shortcut catalog in `useKeyboardShortcuts.ts`:

- keys: `⌘L`
- label: `Open Latest Agent File`
- group: Open & Inspect
- contexts: the same desktop preview contexts that allow the file picker

Because the shortcut catalog is the source for terminal passthrough, shortcut help, and static command-palette actions, one definition makes `⌘L` work while xterm has focus and exposes it in both discovery surfaces.

`useAppKeyboardActions.ts` looks up the selected task's registered terminal and awaits newest-link activation. A missing registration or candidate produces the no-link info toast.

### Hint delivery

The terminal file-link provider watches parsed xterm writes only until it finds its first valid candidate, then emits a lightweight availability event and stops watching for that terminal instance. Detection is debounced until the current burst of terminal rendering settles so validation does not run for every output chunk.

The app-level listener owns the versioned local-storage flag and informational toast. This keeps onboarding policy out of the terminal parser and makes repeat suppression testable without xterm. The flag is written synchronously before the toast is added, so later availability events in this or another window observe the hint as already shown.

## Error Handling

- Filesystem validation errors are treated as nonexistent candidates, matching current terminal-link behavior.
- A candidate deleted after validation falls through to the preview's existing read error state.
- An async scan invalidated by terminal disposal returns no activation.
- Repeated `⌘L` presses are safe; each press rescans current buffer order and opens the newest still-valid candidate.
- Positive existence results are cached for the terminal instance. Missing paths are rechecked so an early discovery scan cannot hide a file that the agent creates later.

## Localization

Add labels for the shortcut, the discovery toast, and the no-link toast to the existing English, Japanese, and Korean locale files. The shortcut glyph remains `⌘L` in each locale.

## Testing

Focused unit tests will verify:

- newest-line and rightmost-on-line ordering;
- nonexistent candidates are skipped in favor of older valid links;
- text activation preserves the first numeric suffix as the line;
- image activation uses the existing image event;
- scanning works without prior hover and returns no result without a worktree;
- traversal outside the worktree is rejected;
- registry replacement and cleanup are session-safe;
- `⌘L` is handled while the terminal has focus and appears in shortcut help;
- the keyboard action targets the selected session and shows the no-link toast when needed; and
- the discovery toast is emitted once after detection and suppressed after its storage flag is set.

The existing terminal-link event-to-preview E2E coverage remains the integration proof for text/image preview routing. Run the focused frontend tests and Vue typecheck after implementation.

## Files Expected to Change

- `apps/desktop/src/composables/terminalFileLinks.ts`
- `apps/desktop/src/composables/terminalFileLinks.test.ts`
- `apps/desktop/src/composables/terminalView.ts`
- `apps/desktop/src/composables/terminalDisposal.ts`
- `apps/desktop/src/composables/useKeyboardShortcuts.ts`
- `apps/desktop/src/composables/useKeyboardShortcuts.test.ts`
- `apps/desktop/src/composables/useAppKeyboardActions.ts`
- `apps/desktop/src/composables/useAppLifecycle.ts`
- new focused registry/hint modules and tests under `apps/desktop/src/composables/`
- `apps/desktop/src/i18n/locales/en.json`
- `apps/desktop/src/i18n/locales/ja.json`
- `apps/desktop/src/i18n/locales/ko.json`
- relevant `App.test.ts` coverage for app-level action and toast wiring
