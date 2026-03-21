# Diff View Keyboard Navigation

## Summary

Add `less`-style keyboard scrolling to DiffView and remap scope cycling from Space to macOS tab navigation convention (Cmd+Shift+[ / Cmd+Shift+]).

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

## Non-goals

- File-to-file navigation (jumping between changed files)
- Search within diff (/ to search)
- Collapsing/expanding files
