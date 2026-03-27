# Terminal File Links

## Summary

Add clickable file path links to the terminal. When Claude or other tools output relative file paths (e.g., `docs/specs/design.md`, `src/utils/fuzzyMatch.ts:42`), the user can Cmd+click to open the file in the file preview modal, scrolled to the indicated line.

## Motivation

Agent output frequently references file paths. Today the user must manually copy the path and use the file picker to navigate to it. Clickable file links close this gap — hover to confirm the file exists, Cmd+click to preview it.

## Design

### Link Detection

Register a custom `ILinkProvider` via xterm.js `terminal.registerLinkProvider()` in the `useTerminal` composable. This runs alongside the existing `WebLinksAddon` (which handles `http://https://` URLs) — no changes to URL link behavior.

**Regex pattern** matches relative file paths with optional `:line` suffix:

```
(?:^|[\s"'`(])([a-zA-Z0-9_.\-][\w.\-/]*\/[\w.\-/]*\.[a-zA-Z0-9]+)(?::(\d+))?
```

Requirements for a match:
- At least one `/` (avoids matching bare words like `error.message`)
- A file extension (the `.xxx` part — avoids matching directory-only paths)
- No leading `/` (relative paths only)
- Optional `:N` line number suffix

Examples that match:
- `docs/specs/design.md`
- `src/utils/fuzzyMatch.ts:42`
- `packages/core/src/pipeline/types.ts`

Examples that don't match:
- `error.message` (no `/`)
- `/Users/foo/bar.ts` (absolute path)
- `node_modules/` (no extension)
- `https://example.com` (handled by WebLinksAddon)

### Validation (on hover)

When xterm.js calls `provideLinks(lineNumber, callback)`:

1. Extract the line text from the terminal buffer
2. Run the regex to find all path-like matches
3. For each match, resolve against the worktree root path
4. Call the `file_exists` Tauri command to validate existence
5. Cache results in a `Map<string, boolean>` (keyed by relative path)
6. Return `ILink[]` only for paths that exist on disk

The cache is per-terminal instance and cleared on `dispose()`. This avoids repeated filesystem calls when hovering the same line multiple times.

The `worktreePath` string is passed as a new parameter to `useTerminal()`.

### Activation (Cmd+click)

The `ILink.activate(event, text)` callback:

1. Checks `event.metaKey` — if not held, returns (bare click stays normal terminal behavior)
2. Parses the line number from the matched text (if present)
3. Dispatches a `CustomEvent("file-link-activate", { detail: { path, line } })` on the terminal container element, which bubbles up to App.vue

App.vue catches the event and:
1. Sets `previewFilePath` to the relative path
2. Sets `previewInitialLine` to the line number (or undefined)
3. Sets `showFilePreviewModal = true`

### Hover Decoration

Use xterm.js default link decorations (underline on hover). The `ILink.hover` callback adds a tooltip element inside `Terminal.element` with the `xterm-hover` class showing the full resolved path, e.g., "Open preview (Cmd+click)".

The `ILink.leave` callback removes the tooltip.

### File Preview Line Navigation

Add an `initialLine?: number` prop to `FilePreviewModal`.

After the file content loads and syntax highlighting completes:

1. Calculate the scroll offset: `(initialLine - 1) * lineHeight`, centered in the viewport
2. Set `contentRef.scrollTop` to that offset
3. Apply a CSS highlight animation to the target line — a subtle background color (`rgba(255, 255, 150, 0.15)`) that fades to transparent over 1.5 seconds

Implementation: wrap each line in the highlighted HTML output with a `data-line="N"` attribute (via a shiki transformer), then use `querySelector('[data-line="42"]')` to find and highlight the target line.

If `initialLine` is not provided or the line doesn't exist in the file, no scrolling or highlighting occurs.

## Files Changed

| File | Change |
|---|---|
| `apps/desktop/src/composables/useTerminal.ts` | Add `worktreePath` parameter. Register `ILinkProvider` with regex matching, `file_exists` validation cache, Cmd+click activation. Add tooltip on hover/leave. |
| `apps/desktop/src/components/TerminalView.vue` | Add `worktreePath` prop, pass to `useTerminal()`. |
| `apps/desktop/src/components/TerminalTabs.vue` | Pass `worktreePath` to `TerminalView` (already available in `PtySessionConfig`). |
| `apps/desktop/src/App.vue` | Listen for `file-link-activate` custom event. Set `previewFilePath`, `previewInitialLine`, and `showFilePreviewModal`. Pass `initialLine` to `FilePreviewModal`. |
| `apps/desktop/src/components/FilePreviewModal.vue` | Add `initialLine?: number` prop. After content loads, scroll to line and apply highlight animation. Add shiki transformer to tag lines with `data-line` attributes. Add CSS keyframes for line highlight fade. |

## Edge Cases

- **Path doesn't exist on click** — shouldn't happen since we validate on hover, but if the file is deleted between hover and click, the preview modal shows its existing error state.
- **Very long lines** — regex runs per-line from the terminal buffer; long lines may contain multiple path matches, all returned as separate links.
- **Paths with spaces** — not matched by the regex (relative paths with spaces are rare in codebases and would create too many false positives).
- **Cache staleness** — the validation cache lives for the terminal's lifetime. A file created after the first hover won't be detected until a new hover triggers re-validation. This is acceptable — re-hovering the line refreshes the cache for that path.
- **Shell modal terminals** — shell terminals don't have a worktree path context. The link provider is only registered when `worktreePath` is provided, so shell modals are unaffected.

## Out of Scope

- Absolute path detection
- Line + column support (`:line:col`)
- Opening in IDE instead of preview (could be added later via modifier key)
- File links in the AgentView (SDK mode) — only PTY terminals
