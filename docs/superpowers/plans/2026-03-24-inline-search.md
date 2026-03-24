# Inline Search for File Preview — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add vim/less-style inline search (`/` to open, `n/N` to navigate) to the file preview modal using Shiki's `decorations` API.

**Architecture:** New `useInlineSearch` composable produces Shiki decoration descriptors from a search query. FilePreviewModal passes these decorations to `codeToHtml`, which handles highlighting natively. Two keyboard handler paths: `handleSearchKeys` for the `useLessScroll` extraHandler chain, `handleInputKeys` for direct `@keydown` on the search input.

**Tech Stack:** Vue 3 composables, Shiki 4.0.2 `decorations` API, `bun:test`

**Spec:** `docs/superpowers/specs/2026-03-24-inline-search-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/desktop/src/composables/useInlineSearch.ts` | Create | Search state, match finding, decoration generation, keyboard handlers |
| `apps/desktop/src/composables/useInlineSearch.test.ts` | Create | Unit tests for match finding, decoration generation, navigation |
| `apps/desktop/src/components/FilePreviewModal.vue` | Modify | Integrate composable, refactor Shiki rendering, add search bar template + CSS |
| `apps/desktop/src/i18n/locales/en.json` | Modify | Add search-related i18n strings |
| `apps/desktop/src/i18n/locales/ja.json` | Modify | Add search-related i18n strings |
| `apps/desktop/src/i18n/locales/ko.json` | Modify | Add search-related i18n strings |

---

### Task 1: Create `useInlineSearch` composable — match finding and decorations

**Files:**
- Create: `apps/desktop/src/composables/useInlineSearch.ts`
- Create: `apps/desktop/src/composables/useInlineSearch.test.ts`

- [ ] **Step 1: Write failing tests for match finding**

Create `apps/desktop/src/composables/useInlineSearch.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { ref } from "vue";
import { useInlineSearch, type DecorationItem } from "./useInlineSearch";

describe("useInlineSearch", () => {
  describe("match finding", () => {
    it("finds all case-insensitive matches", () => {
      const rawText = ref("Hello hello HELLO world");
      const { query, matchCount } = useInlineSearch(rawText);
      query.value = "hello";
      expect(matchCount.value).toBe(3);
    });

    it("returns zero matches for empty query", () => {
      const rawText = ref("Hello world");
      const { query, matchCount } = useInlineSearch(rawText);
      query.value = "";
      expect(matchCount.value).toBe(0);
    });

    it("returns zero matches when no text matches", () => {
      const rawText = ref("Hello world");
      const { query, matchCount } = useInlineSearch(rawText);
      query.value = "xyz";
      expect(matchCount.value).toBe(0);
    });

    it("handles special regex characters in query", () => {
      const rawText = ref("price is $100 (USD)");
      const { query, matchCount } = useInlineSearch(rawText);
      query.value = "$100 (USD)";
      expect(matchCount.value).toBe(1);
    });
  });

  describe("decorations", () => {
    it("produces decorations with correct offsets", () => {
      const rawText = ref("foo bar foo");
      const { query, decorations } = useInlineSearch(rawText);
      query.value = "foo";
      expect(decorations.value).toHaveLength(2);
      expect(decorations.value[0]).toEqual({
        start: 0, end: 3,
        properties: { class: "search-hl-active" },
      });
      expect(decorations.value[1]).toEqual({
        start: 8, end: 11,
        properties: { class: "search-hl" },
      });
    });

    it("returns empty decorations for empty query", () => {
      const rawText = ref("foo bar");
      const { decorations } = useInlineSearch(rawText);
      expect(decorations.value).toEqual([]);
    });

    it("active match uses search-hl-active, others use search-hl (mutually exclusive)", () => {
      const rawText = ref("aa aa aa");
      const { query, decorations } = useInlineSearch(rawText);
      query.value = "aa";
      const activeCount = decorations.value.filter(
        (d: DecorationItem) => d.properties.class === "search-hl-active"
      ).length;
      expect(activeCount).toBe(1);
      const inactiveCount = decorations.value.filter(
        (d: DecorationItem) => d.properties.class === "search-hl"
      ).length;
      expect(inactiveCount).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && bun test src/composables/useInlineSearch.test.ts`
Expected: FAIL — module `./useInlineSearch` not found.

- [ ] **Step 3: Implement match finding and decoration generation**

Create `apps/desktop/src/composables/useInlineSearch.ts`:

```ts
import { ref, computed, watch, type Ref, type ComputedRef } from "vue";

export interface DecorationItem {
  start: number;
  end: number;
  properties: { class: string };
}

interface InlineSearchReturn {
  isSearching: Ref<boolean>;
  query: Ref<string>;
  matchCount: ComputedRef<number>;
  currentMatch: Ref<number>;
  decorations: ComputedRef<DecorationItem[]>;
  openSearch: () => void;
  closeSearch: () => void;
  nextMatch: () => void;
  prevMatch: () => void;
  handleSearchKeys: (e: KeyboardEvent) => boolean;
  handleInputKeys: (e: KeyboardEvent) => void;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatches(text: string, query: string): { start: number; end: number }[] {
  if (!query) return [];
  const escaped = escapeRegExp(query);
  const re = new RegExp(escaped, "gi");
  const matches: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return matches;
}

export function useInlineSearch(rawText: Ref<string>): InlineSearchReturn {
  const isSearching = ref(false);
  const query = ref("");
  const currentMatch = ref(1);

  const matches = computed(() => findMatches(rawText.value, query.value));

  const matchCount = computed(() => matches.value.length);

  const decorations = computed<DecorationItem[]>(() => {
    if (!matches.value.length) return [];
    const activeIdx = Math.min(currentMatch.value, matches.value.length) - 1;
    return matches.value.map((m, i) => ({
      start: m.start,
      end: m.end,
      properties: {
        class: i === activeIdx ? "search-hl-active" : "search-hl",
      },
    }));
  });

  // Clamp currentMatch when match count shrinks (e.g., query changes)
  watch(matchCount, (count) => {
    if (currentMatch.value > count && count > 0) {
      currentMatch.value = count;
    } else if (count === 0) {
      currentMatch.value = 1;
    }
  });

  function openSearch() {
    isSearching.value = true;
  }

  function closeSearch() {
    isSearching.value = false;
    query.value = "";
    currentMatch.value = 1;
  }

  function nextMatch() {
    if (!matchCount.value) return;
    currentMatch.value =
      currentMatch.value >= matchCount.value ? 1 : currentMatch.value + 1;
  }

  function prevMatch() {
    if (!matchCount.value) return;
    currentMatch.value =
      currentMatch.value <= 1 ? matchCount.value : currentMatch.value - 1;
  }

  function handleSearchKeys(e: KeyboardEvent): boolean {
    const noMods = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const meta = e.metaKey || e.ctrlKey;

    if (e.key === "/" && noMods) {
      e.preventDefault();
      openSearch();
      return true;
    }

    if (meta && e.key === "f") {
      e.preventDefault();
      openSearch();
      return true;
    }

    if (e.key === "n" && noMods && isSearching.value) {
      e.preventDefault();
      nextMatch();
      return true;
    }

    if (e.key === "N" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && isSearching.value) {
      e.preventDefault();
      prevMatch();
      return true;
    }

    return false;
  }

  function handleInputKeys(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      nextMatch();
      return;
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      prevMatch();
      return;
    }
  }

  return {
    isSearching,
    query,
    matchCount,
    currentMatch,
    decorations,
    openSearch,
    closeSearch,
    nextMatch,
    prevMatch,
    handleSearchKeys,
    handleInputKeys,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && bun test src/composables/useInlineSearch.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useInlineSearch.ts apps/desktop/src/composables/useInlineSearch.test.ts
git commit -m "feat: add useInlineSearch composable with match finding and decorations"
```

---

### Task 2: Add navigation and edge case tests

**Files:**
- Modify: `apps/desktop/src/composables/useInlineSearch.test.ts`
- Modify: `apps/desktop/src/composables/useInlineSearch.ts` (if clamping fix needed)

- [ ] **Step 1: Write tests for navigation and edge cases**

Append to `useInlineSearch.test.ts` — insert **before** the final closing `});` of the outer `describe("useInlineSearch")` block:

```ts
  describe("navigation", () => {
    it("nextMatch wraps from last to first", () => {
      const rawText = ref("aa bb aa");
      const { query, currentMatch, nextMatch } = useInlineSearch(rawText);
      query.value = "aa";
      expect(currentMatch.value).toBe(1);
      nextMatch();
      expect(currentMatch.value).toBe(2);
      nextMatch();
      expect(currentMatch.value).toBe(1);
    });

    it("prevMatch wraps from first to last", () => {
      const rawText = ref("aa bb aa");
      const { query, currentMatch, prevMatch } = useInlineSearch(rawText);
      query.value = "aa";
      expect(currentMatch.value).toBe(1);
      prevMatch();
      expect(currentMatch.value).toBe(2);
    });

    it("nextMatch is no-op with zero matches", () => {
      const rawText = ref("hello");
      const { query, currentMatch, nextMatch } = useInlineSearch(rawText);
      query.value = "xyz";
      nextMatch();
      expect(currentMatch.value).toBe(1);
    });

    it("clamps currentMatch when matches shrink", () => {
      const rawText = ref("aa bb aa cc aa");
      const { query, currentMatch, nextMatch, decorations } = useInlineSearch(rawText);
      query.value = "aa";
      nextMatch();
      nextMatch();
      expect(currentMatch.value).toBe(3);
      query.value = "bb";
      expect(decorations.value.length).toBe(1);
      // Active decoration should exist (clamped to 1)
      expect(decorations.value[0].properties.class).toBe("search-hl-active");
    });
  });

  describe("openSearch / closeSearch", () => {
    it("openSearch sets isSearching to true", () => {
      const rawText = ref("hello");
      const { isSearching, openSearch } = useInlineSearch(rawText);
      expect(isSearching.value).toBe(false);
      openSearch();
      expect(isSearching.value).toBe(true);
    });

    it("closeSearch clears query and resets state", () => {
      const rawText = ref("hello hello");
      const { query, isSearching, currentMatch, openSearch, closeSearch, nextMatch } = useInlineSearch(rawText);
      openSearch();
      query.value = "hello";
      nextMatch();
      closeSearch();
      expect(isSearching.value).toBe(false);
      expect(query.value).toBe("");
      expect(currentMatch.value).toBe(1);
    });
  });

  describe("rawText reactivity", () => {
    it("recomputes matches when rawText changes", () => {
      const rawText = ref("foo bar foo");
      const { query, matchCount } = useInlineSearch(rawText);
      query.value = "foo";
      expect(matchCount.value).toBe(2);
      rawText.value = "foo";
      expect(matchCount.value).toBe(1);
    });
  });
```

- [ ] **Step 2: Run tests**

Run: `cd apps/desktop && bun test src/composables/useInlineSearch.test.ts`
Expected: All tests PASS. (The clamping logic is already in Task 1's implementation.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/composables/useInlineSearch.test.ts
git commit -m "test: add navigation, open/close, and reactivity tests for useInlineSearch"
```

---

### Task 3: Add i18n strings

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/ja.json`
- Modify: `apps/desktop/src/i18n/locales/ko.json`

- [ ] **Step 1: Add English i18n strings**

In `apps/desktop/src/i18n/locales/en.json`, add these keys inside the `"filePreview"` object (after `"shortcutToggleLineNumbers"`):

```json
    "shortcutSearch": "Search",
    "shortcutSearchAlt": "Search (alt)",
    "shortcutNextPrevMatch": "Next / Prev match",
    "searchNoMatches": "No matches",
    "searchPlaceholder": "Search..."
```

- [ ] **Step 2: Add Japanese i18n strings**

In `apps/desktop/src/i18n/locales/ja.json`, add inside `"filePreview"`:

```json
    "shortcutSearch": "検索",
    "shortcutSearchAlt": "検索（代替）",
    "shortcutNextPrevMatch": "次 / 前の一致",
    "searchNoMatches": "一致なし",
    "searchPlaceholder": "検索..."
```

- [ ] **Step 3: Add Korean i18n strings**

In `apps/desktop/src/i18n/locales/ko.json`, add inside `"filePreview"`:

```json
    "shortcutSearch": "검색",
    "shortcutSearchAlt": "검색 (대체)",
    "shortcutNextPrevMatch": "다음 / 이전 일치",
    "searchNoMatches": "일치 없음",
    "searchPlaceholder": "검색..."
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/ja.json apps/desktop/src/i18n/locales/ko.json
git commit -m "i18n: add inline search strings for file preview"
```

---

### Task 4: Refactor FilePreviewModal Shiki rendering to be reactive

**Files:**
- Modify: `apps/desktop/src/components/FilePreviewModal.vue`

This task extracts the `codeToHtml` call from `loadFile()` into a separate reactive watcher so that decorations can trigger re-highlighting without re-loading the file.

- [ ] **Step 1: Add new reactive state for language**

In `FilePreviewModal.vue`, after the `const highlighted = ref("");` line (line 36), add:

```ts
const currentLang = ref("text");
```

- [ ] **Step 2: Extract `codeToHtml` into a watcher**

Replace the `loadFile()` function (lines 132-167) with two pieces:

**New `loadFile()`** — handles file I/O and language loading only:

```ts
async function loadFile() {
  loading.value = true;
  error.value = null;
  renderMarkdown.value = false;
  try {
    const fullPath = `${props.worktreePath}/${props.filePath}`;
    const raw = await invoke<string>("read_text_file", { path: fullPath });

    const hl = await getHighlighter();
    const lang = langFromPath(props.filePath);

    try {
      await hl.loadLanguage(lang);
    } catch {
      // Language not available — fall back to text
    }

    const loadedLangs = hl.getLoadedLanguages();
    // Set lang before content so the watcher fires once with the correct language
    currentLang.value = loadedLangs.includes(lang) ? lang : "text";
    content.value = raw;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
```

**New watcher** — re-highlights whenever content or language changes:

```ts
watch([content, currentLang], async ([raw, lang]) => {
  if (!raw) { highlighted.value = ""; return; }
  try {
    const hl = await getHighlighter();
    highlighted.value = hl.codeToHtml(raw, {
      lang,
      theme: "github-dark",
      transformers: [{
        pre(node: any) {
          node.properties.style = "white-space:pre-wrap;word-wrap:break-word;";
        },
      }],
    });
  } catch (e: unknown) {
    console.error("[FilePreview] highlight failed:", e);
  }
}, { immediate: false });
```

- [ ] **Step 3: Verify the app still works**

Run dev server if not running: `./scripts/dev.sh start`
Manual test: Open tree explorer (Shift+Cmd+E), navigate to a source file, press Enter/l to open file preview. Verify syntax highlighting renders correctly.

- [ ] **Step 4: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No new type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/FilePreviewModal.vue
git commit -m "refactor: extract Shiki codeToHtml into reactive watcher in FilePreviewModal"
```

---

### Task 5: Integrate `useInlineSearch` into FilePreviewModal

**Files:**
- Modify: `apps/desktop/src/components/FilePreviewModal.vue`

- [ ] **Step 1: Import and call the composable**

At the top of `<script setup>`, add the import:

```ts
import { useInlineSearch } from "../composables/useInlineSearch";
```

After the existing composable calls (after `useShortcutContext("file")`), add:

```ts
const {
  isSearching,
  query: searchQuery,
  matchCount: searchMatchCount,
  currentMatch: searchCurrentMatch,
  decorations: searchDecorations,
  openSearch,
  closeSearch,
  handleSearchKeys,
  handleInputKeys,
} = useInlineSearch(content);

const searchInputRef = ref<HTMLInputElement | null>(null);
```

- [ ] **Step 2: Wire decorations into the Shiki watcher**

Update the `watch` from Task 4 to include `searchDecorations`:

```ts
watch([content, currentLang, searchDecorations], async ([raw, lang, decos]) => {
  if (!raw) { highlighted.value = ""; return; }
  try {
    const hl = await getHighlighter();
    highlighted.value = hl.codeToHtml(raw, {
      lang,
      theme: "github-dark",
      decorations: decos,
      transformers: [{
        pre(node: any) {
          node.properties.style = "white-space:pre-wrap;word-wrap:break-word;";
        },
      }],
    });
  } catch (e: unknown) {
    console.error("[FilePreview] highlight failed:", e);
  }
}, { immediate: false });
```

- [ ] **Step 3: Close search on file navigation**

Add a watcher that resets search when the file changes:

```ts
watch(() => props.filePath, () => {
  closeSearch();
});
```

- [ ] **Step 4: Scroll to active match after re-render**

Add a watcher after the Shiki watcher. Use a `shouldScrollToMatch` flag so we only scroll on navigation actions (not every keystroke):

```ts
const shouldScrollToMatch = ref(false);

// Wrap nextMatch/prevMatch to trigger scroll
const origNextMatch = nextMatch;
const origPrevMatch = prevMatch;
function nextMatchAndScroll() { origNextMatch(); shouldScrollToMatch.value = true; }
function prevMatchAndScroll() { origPrevMatch(); shouldScrollToMatch.value = true; }

watch(highlighted, () => {
  if (!shouldScrollToMatch.value) return;
  shouldScrollToMatch.value = false;
  nextTick(() => {
    contentRef.value
      ?.querySelector(".search-hl-active")
      ?.scrollIntoView({ block: "center" });
  });
});
```

Note: The `handleSearchKeys` and `handleInputKeys` from the composable call `nextMatch`/`prevMatch` internally. To avoid wrapping, an alternative approach is to just always scroll to the active match on highlight change — the UX of scrolling to the first match on initial search is actually good. If so, use the simpler version:

```ts
watch(highlighted, () => {
  nextTick(() => {
    contentRef.value
      ?.querySelector(".search-hl-active")
      ?.scrollIntoView({ block: "center" });
  });
});
```

Choose the simpler version unless the scroll-on-type behavior feels jarring during manual testing.

- [ ] **Step 5: Chain `handleSearchKeys` into `useLessScroll` extraHandler**

Update the `useLessScroll` call's `extraHandler`. The search handler runs first, gated on markdown mode:

```ts
useLessScroll(contentRef, {
  extraHandler(e) {
    // Search keys first (disabled in rendered markdown mode)
    if (!(renderMarkdown.value && isMarkdownFile.value) && handleSearchKeys(e)) {
      return true;
    }

    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "o") {
      e.preventDefault();
      openInIDE();
      return true;
    }
    if (
      e.key === "l" &&
      !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    ) {
      e.preventDefault();
      showLineNumbers.value = !showLineNumbers.value;
      return true;
    }
    if (
      e.key === "m" &&
      isMarkdownFile.value &&
      !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    ) {
      e.preventDefault();
      if (isSearching.value) closeSearch();
      renderMarkdown.value = !renderMarkdown.value;
      return true;
    }
    return false;
  },
  onClose: () => emit("close"),
});
```

- [ ] **Step 6: Focus search input when opened**

Add a watcher that focuses the input when `isSearching` becomes true:

```ts
watch(isSearching, (searching) => {
  if (searching) {
    nextTick(() => searchInputRef.value?.focus());
  }
});
```

- [ ] **Step 7: Update shortcut registration**

Replace the existing `registerContextShortcuts("file", [...])` call with:

```ts
registerContextShortcuts("file", [
  { label: t('filePreview.shortcutSearch'), display: "/" },
  { label: t('filePreview.shortcutSearchAlt'), display: "⌘F" },
  { label: t('filePreview.shortcutNextPrevMatch'), display: "n / N" },
  { label: t('filePreview.shortcutOpenIDE'), display: "⌘O" },
  { label: t('filePreview.shortcutToggleLineNumbers'), display: "l" },
  ...(props.filePath.toLowerCase().endsWith(".md")
    ? [{ label: t('filePreview.shortcutToggleMarkdown'), display: "m" }]
    : []),
  { label: t('filePreview.shortcutLineUpDown'), display: "j / k" },
  { label: t('filePreview.shortcutPageUpDown'), display: "f / b" },
  { label: t('filePreview.shortcutHalfUpDown'), display: "d / u" },
  { label: t('filePreview.shortcutTopBottom'), display: "g / G" },
  { label: t('filePreview.shortcutClose'), display: "q" },
]);
```

- [ ] **Step 8: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No new type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/components/FilePreviewModal.vue
git commit -m "feat: integrate useInlineSearch into FilePreviewModal"
```

---

### Task 6: Add search bar template and CSS

**Files:**
- Modify: `apps/desktop/src/components/FilePreviewModal.vue`

- [ ] **Step 1: Add search bar to template**

In the `<template>` section, add the search bar inside `.preview-modal`, after the `.preview-content` div and before the closing `</div>` of `.preview-modal`:

```html
      <!-- Search bar (vim/less style, bottom of modal) -->
      <div v-if="isSearching" class="search-bar">
        <span class="search-prefix">/</span>
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          class="search-input"
          :placeholder="$t('filePreview.searchPlaceholder')"
          @keydown="handleInputKeys"
        />
        <span v-if="searchQuery" class="search-count">
          {{ searchMatchCount > 0
            ? `${searchCurrentMatch}/${searchMatchCount}`
            : $t('filePreview.searchNoMatches') }}
        </span>
      </div>
```

- [ ] **Step 2: Add `position: relative` to `.preview-modal`**

In the `<style scoped>` section, add `position: relative;` to `.preview-modal`:

```css
.preview-modal {
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 8px;
  width: 90vw;
  height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  outline: none;
  position: relative;
}
```

- [ ] **Step 3: Add search bar and highlight CSS**

Append to the `<style scoped>` section:

```css
/* Search bar */
.search-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: #1e1e1e;
  border-top: 1px solid #333;
  border-radius: 0 0 8px 8px;
  z-index: 10;
}

.search-prefix {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: #666;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: #e0e0e0;
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
}

.search-input::placeholder {
  color: #555;
}

.search-count {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 11px;
  color: #888;
  flex-shrink: 0;
}

/* Search highlight styles (inside v-html, needs :deep) */
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

- [ ] **Step 4: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No new type errors.

- [ ] **Step 5: Manual test**

1. Open tree explorer (Shift+Cmd+E), navigate to a source file, open preview
2. Press `/` — search bar appears at bottom with focused input
3. Type a search term — matches highlight in yellow, counter shows "1/N"
4. Press `Enter` — jumps to next match, counter updates
5. Press `Shift+Enter` — jumps to previous match
6. Press `Escape` — search bar closes, highlights clear
7. Press `n` after closing — nothing happens (search bar is closed)
8. Open a `.md` file, press `m` to switch to rendered mode, press `/` — nothing happens (search disabled)
9. Open a `.md` file in raw mode, press `/` — search works on raw markdown
10. Press `Cmd+F` — same as `/`, opens search bar

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/FilePreviewModal.vue
git commit -m "feat: add search bar UI and highlight CSS for file preview inline search"
```

---

### Task 7: Run all tests and type check

**Files:** None (verification only)

- [ ] **Step 1: Run composable unit tests**

Run: `cd apps/desktop && bun test src/composables/useInlineSearch.test.ts`
Expected: All tests PASS.

- [ ] **Step 2: Run all project tests**

Run: `bun test`
Expected: All existing tests still PASS.

- [ ] **Step 3: Run TypeScript type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Run Rust clippy (ensures no Tauri command breakage)**

Run: `cd apps/desktop/src-tauri && cargo clippy`
Expected: No new warnings.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address test/type issues from inline search integration"
```

(Skip this step if no fixes were needed.)
