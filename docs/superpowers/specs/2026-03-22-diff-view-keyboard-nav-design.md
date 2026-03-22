# Diff View & File Viewer Keyboard Navigation

## Summary

Add `less`-style keyboard scrolling to DiffView and FilePreviewModal. Remap scope cycling (DiffView) from Space to Cmd+Shift+[/], remap markdown toggle (FilePreviewModal) from Space to `m`.

## Changes

### File: `apps/desktop/src/components/DiffView.vue`

**Replace the existing `onKeydown` handler entirely** (not additive — the current Space → cycleScope binding must be removed to avoid Space triggering both scope cycling and page-down).

**Scope cycling remap:**
- Remove: Space (no modifiers) → `cycleScope()`
- Add: Cmd+Shift+] → next scope, Cmd+Shift+[ → previous scope
- Add `cycleScopeBack()`: `(idx - 1 + length) % length` for reverse cycling
- Cycle order unchanged: working → branch → commit
- Note: Cmd+Shift+[/] are macOS tab-switching conventions. In Tauri WKWebView they are not intercepted by the OS and reach JavaScript.

**`less`-style scroll bindings on `.diff-container`:**

| Key | Action | Detail |
|-----|--------|--------|
| j / ArrowDown | Line down | ~40px (one line) |
| k / ArrowUp | Line up | ~40px |
| f / PageDown / Space | Page down | Container clientHeight |
| b / PageUp | Page up | Container clientHeight |
| d | Half page down | clientHeight / 2 |
| u | Half page up | clientHeight / 2 |
| g | Top | scrollTop = 0 |
| G (Shift+g) | Bottom | scrollTop = scrollHeight |
| q | Close | Emit 'close' |

**Key matching rules:**
- Skip if `e.target` is an input, textarea, or contenteditable element
- Plain letter keys (j, k, f, b, d, u, g, q) only fire with no modifiers
- G requires Shift only (no meta/ctrl/alt)
- Arrow keys and PageUp/PageDown work with no modifiers
- Space works with no modifiers (reclaimed from scope cycling)
- Listener registered on `window` (same as existing pattern), cleaned up in `onUnmounted`

**New emit:** `close` — emitted on `q` press, bubbled through DiffModal.

### File: `apps/desktop/src/components/DiffModal.vue`

- Pass through new `close` emit from DiffView (already closes via `@close="emit('close')"` on overlay click; add `@close` on the DiffView component).

### File: `apps/desktop/src/components/FilePreviewModal.vue`

**Replace the existing `handleKeydown` handler entirely.**

**Markdown toggle remap:**
- Remove: Space (no modifiers) → toggle `renderMarkdown` (markdown files only)
- Add: `m` (no modifiers) → toggle `renderMarkdown` (markdown files only)
- Update the mode badge tooltip from "space" to "m"

**`less`-style scroll bindings on `.preview-content`:**

Same key table as DiffView (j/k/f/b/d/u/g/G/q/Space/arrows/PageUp/PageDown).

**Key matching rules:** Same as DiffView (input target guard, modifier checks, window listener).

**Cmd+O retained:** `openInIDE()` binding unchanged (meta+o).

**`q` closes the modal:** Already has `close` emit, just call `emit('close')`.

## Non-goals

- File-to-file navigation (jumping between changed files)
- Search within diff (/ to search)
- Collapsing/expanding files
