# Diff View Keyboard Navigation

## Summary

Add `less`-style keyboard scrolling to DiffView and remap scope cycling from Space to macOS tab navigation convention (Cmd+Shift+[ / Cmd+Shift+]).

## Changes

### File: `apps/desktop/src/components/DiffView.vue`

**Scope cycling remap:**
- Remove: Space (no modifiers) → `cycleScope()`
- Add: Cmd+Shift+] → next scope, Cmd+Shift+[ → previous scope
- Cycle order unchanged: working → branch → commit

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
- Plain letter keys (j, k, f, b, d, u, g, q) only fire with no modifiers
- G requires Shift only (no meta/ctrl/alt)
- Arrow keys and PageUp/PageDown work with no modifiers
- Space works with no modifiers (reclaimed from scope cycling)

**New emit:** `close` — emitted on `q` press, bubbled through DiffModal.

### File: `apps/desktop/src/components/DiffModal.vue`

- Pass through new `close` emit from DiffView (already closes via `@close="emit('close')"` on overlay click; add `@close` on the DiffView component).

## Non-goals

- File-to-file navigation (jumping between changed files)
- Search within diff (/ to search)
- Collapsing/expanding files
