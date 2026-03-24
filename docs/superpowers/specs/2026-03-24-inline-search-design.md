# Inline Search for File Preview

**Date:** 2026-03-24
**Status:** Approved

## Summary

Add vim/less-style inline search (`/` to open, `n/N` to navigate) to the file preview modal. Uses Shiki's `decorations` API for zero-DOM-manipulation highlighting. Packaged as a reusable `useInlineSearch` composable for future use in other preview modals.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Search style | Vim/less: `/` to open, `n/N` to navigate | Matches existing `useLessScroll` keybindings |
| Pattern matching | Plain text, case-insensitive | Simple — no regex complexity |
| Navigation during search | `n/N` jump matches, `j/k` scroll normally | Standard vim/less behavior |
| Dismiss behavior | `Esc` closes bar and clears highlights | Simplest mental model |
| Match counter | Shown ("3/12") | Cheap to implement, useful feedback |
| Highlight method | Shiki decorations API | No DOM manipulation, clean integration |
| Markdown mode | Search disabled; user switches to raw first | Rendered markdown uses markdown-it, not Shiki |
| Architecture | `useInlineSearch` composable + FilePreviewModal integration | Clean separation, reusable |
| Search bar position | Bottom of modal, absolute positioned | Vim/less convention |

## Architecture

### New: `useInlineSearch` composable

**File:** `apps/desktop/src/composables/useInlineSearch.ts`

```ts
interface InlineSearchReturn {
  // State
  isSearching: Ref<boolean>       // search bar visible
  query: Ref<string>              // current search text
  matchCount: Ref<number>         // total matches
  currentMatch: Ref<number>       // 1-based index of active match

  // Shiki decorations (consumers pass these to codeToHtml)
  decorations: ComputedRef<ShikiDecoration[]>

  // Actions
  openSearch: () => void          // show bar, focus input
  closeSearch: () => void         // hide bar, clear highlights
  nextMatch: () => void           // jump to next
  prevMatch: () => void           // jump to previous

  // Keyboard handler for non-input keys (for useLessScroll extraHandler chain)
  // Handles: "/" to open, "n"/"N" to navigate when input is NOT focused
  handleSearchKeys: (e: KeyboardEvent) => boolean

  // Keyboard handler for the search <input> element (@keydown on the input)
  // Handles: Enter (next), Shift+Enter (prev), Escape (close)
  handleInputKeys: (e: KeyboardEvent) => void
}

function useInlineSearch(rawText: Ref<string>): InlineSearchReturn
```

**Responsibilities:**
- Owns search state (query, matches, current index)
- Scans `rawText` for case-insensitive matches on query change (debounced ~150ms). Watches `rawText` reactively — if the underlying text changes, matches recompute against the new content while preserving the current query.
- Converts match character offsets to numeric offsets (Shiki accepts plain numbers via `OffsetOrPosition`)
- Produces Shiki-compatible decoration descriptors: inactive matches get `class: 'search-hl'`, active match gets **only** `class: 'search-hl-active'` (mutually exclusive — Shiki throws on overlapping decorations)
- Exposes two keyboard handlers: `handleSearchKeys` for the `extraHandler` chain (non-input context), and `handleInputKeys` for direct `@keydown` on the search input

**Does NOT own:**
- Shiki calls or HTML generation (the component does that)
- DOM references or scrolling (the component handles scrollIntoView after re-render)

### Modified: `FilePreviewModal.vue`

**Integration points:**

1. **Composable setup:** Call `useInlineSearch(content)` alongside existing composables.
2. **Shiki re-rendering refactor:** Extract the `codeToHtml` call out of `loadFile()` into a separate `watch` on `[content, decorations, lang]`. `loadFile()` handles file I/O and language loading only. The watch re-runs `codeToHtml` whenever the raw content or decorations change. Shiki does NOT cache tokenization — each call re-tokenizes — but with the 150ms debounce this is acceptable for files under ~10k lines.
3. **Two keyboard handler paths:**
   - `handleSearchKeys` is chained into `useLessScroll`'s `extraHandler` — handles `/` (open), `n`/`N` (navigate). These only fire when the search input is NOT focused, because `useLessScroll` has an `isInputTarget` early-return guard.
   - `handleInputKeys` is bound directly as `@keydown` on the search `<input>` element — handles `Enter` (next), `Shift+Enter` (prev), `Escape` (close). This bypasses `useLessScroll` entirely.
4. **Scroll to active match:** After `highlighted.value` updates, `nextTick(() => contentRef.value?.querySelector('.search-hl-active')?.scrollIntoView({ block: 'center' }))`.
5. **Markdown gate:** When `renderMarkdown` is true, `handleSearchKeys` returns `false` for `/` (search disabled in rendered mode). If search is open when user presses `m`, close search first.
6. **Shortcut registration:** Add `{ label: "Search", display: "/" }`, `{ label: "Next/prev match", display: "n / N" }`, and `{ label: "Search (alt)", display: "⌘F" }` to `registerContextShortcuts`.

### Keyboard behavior

**Via `handleSearchKeys` (extraHandler chain — only fires when input is NOT focused):**

| Key | Context | Action |
|-----|---------|--------|
| `/` or `⌘F` | Not in rendered markdown | Open search bar, focus input |
| `n` | Search bar open, input not focused | Jump to next match |
| `N` (Shift+n) | Search bar open, input not focused | Jump to previous match |

**Via `handleInputKeys` (direct `@keydown` on search `<input>`):**

| Key | Context | Action |
|-----|---------|--------|
| `Escape` | Search input focused | Close search bar, clear highlights |
| `Enter` | Search input focused | Jump to next match |
| `Shift+Enter` | Search input focused | Jump to previous match |

**Unaffected (useLessScroll handles normally):**

| Key | Context | Action |
|-----|---------|--------|
| `j/k/f/b/d/u/g/G` | Input not focused | Normal scroll |

**Note:** `useLessScroll` has an `isInputTarget` early-return guard (line 35) that skips ALL handlers when the search input is focused. This is why input-focused keys (`Enter`, `Shift+Enter`, `Escape`) must be handled via a direct `@keydown` on the input element, not through the `extraHandler` chain.

### Search bar UI

- Position: `absolute; bottom: 0; left: 0; right: 0` inside `.preview-modal`
- Layout: single row — `/` prefix label, `<input>`, match counter text
- Styling: `background: #1e1e1e; border-top: 1px solid #333`; monospace 12px; matches modal header aesthetic
- Match counter: "3/12" when matches found, "No matches" when query has no hits, hidden when query is empty
- Input auto-focuses on open
- When hidden, no space is reserved — content area is unaffected

### CSS classes

Since `FilePreviewModal.vue` uses `<style scoped>` and Shiki output is injected via `v-html`, selectors must use `:deep()`:

```css
.preview-content :deep(.search-hl) {
  background: rgba(255, 200, 0, 0.25);
  border-radius: 2px;
}

.preview-content :deep(.search-hl-active) {
  background: rgba(255, 200, 0, 0.55);
  border-radius: 2px;
  outline: 1px solid rgba(255, 200, 0, 0.8);
}
```

### Data flow

```
User presses "/" → openSearch() → isSearching = true → search bar renders, input focuses
User types query → query ref updates (debounced 150ms)
  → scan rawText for matches → compute decorations array
  → FilePreviewModal re-runs codeToHtml(code, { decorations })
  → highlighted.value updates → Vue re-renders
  → nextTick → scrollIntoView('.search-hl-active')
User presses Enter/n → nextMatch() → currentMatch increments → decorations recompute (active class moves)
User presses Esc → closeSearch() → query = "", isSearching = false → decorations = [] → clean re-render
```

### Edge cases

- **Empty query:** decorations array is empty, match count shows nothing
- **No matches:** counter shows "No matches", `n/N` are no-ops
- **File changes (navigation):** `rawText` is watched reactively — when it changes, matches recompute against the new content while preserving the query. `closeSearch()` should also be called on file change (when `filePath` prop changes) to reset state cleanly.
- **Large files:** Shiki does NOT cache tokenization — each `codeToHtml` call re-tokenizes. With the 150ms debounce, this is acceptable for files under ~10k lines. For very large files, the debounce absorbs rapid keystrokes.
- **Rendered markdown mode:** `/` is a no-op; if search is open when user presses `m`, close search first.
- **Decoration overlap:** Shiki throws on overlapping decorations. The active match gets **only** `search-hl-active`, not both classes. The CSS for each class is self-contained.

## Reusability

The composable is generic — it takes raw text and returns decorations + state. Any component that uses Shiki for rendering can drop it in. The keyboard handler integrates with `useLessScroll`'s `extraHandler` pattern. Future preview modals (e.g., diff preview) can reuse this composable by:

1. Calling `useInlineSearch(rawText)`
2. Passing `decorations.value` to their Shiki `codeToHtml` call
3. Chaining `handleSearchKeys` into their key handler

## Files to create/modify

| File | Action |
|------|--------|
| `apps/desktop/src/composables/useInlineSearch.ts` | Create |
| `apps/desktop/src/components/FilePreviewModal.vue` | Modify |
| i18n locale files | Add search-related strings |

## Testing

- Unit test `useInlineSearch`: verify match finding, decoration generation, navigation cycling, edge cases (empty query, no matches, wrap-around)
- Manual test in FilePreviewModal: `/` opens bar, typing highlights, `n/N` navigate, `Esc` clears, markdown mode disables search
