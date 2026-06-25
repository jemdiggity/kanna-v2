import { computed, nextTick, ref, watch, type Ref } from "vue";
import {
  buildDiffSearchTargets,
  findDiffSearchMatches,
  type DiffSearchFile,
  type DiffSearchMatch,
} from "../utils/diffSearch";

export interface DiffSearchBarHandle {
  focus: () => void;
}

interface UseDiffSearchOptions {
  containerRef: Readonly<Ref<HTMLElement | null>>;
  renderedFiles: Readonly<Ref<DiffSearchFile[]>>;
  searchBarRef: Ref<DiffSearchBarHandle | null>;
  t: (key: string) => string;
  focusDiffView: () => void;
}

export function useDiffSearch(options: UseDiffSearchOptions) {
  const isSearching = ref(false);
  const searchQuery = ref("");
  const currentMatch = ref(1);

  const searchTargets = computed(() => buildDiffSearchTargets(options.renderedFiles.value));
  const searchMatches = computed(() => findDiffSearchMatches(searchTargets.value, searchQuery.value));
  const searchMatchCount = computed(() => searchMatches.value.length);
  const searchCountLabel = computed(() => {
    if (!searchQuery.value) return "";
    if (!searchMatchCount.value) return options.t("diffView.searchNoMatches");
    return `${currentMatch.value}/${searchMatchCount.value}`;
  });

  function openSearch() {
    isSearching.value = true;
  }

  function closeSearch() {
    isSearching.value = false;
    searchQuery.value = "";
    currentMatch.value = 1;
  }

  function focusSearchInput() {
    nextTick(() => options.searchBarRef.value?.focus());
  }

  function nextMatch() {
    if (!searchMatchCount.value) return;
    currentMatch.value =
      currentMatch.value >= searchMatchCount.value ? 1 : currentMatch.value + 1;
  }

  function prevMatch() {
    if (!searchMatchCount.value) return;
    currentMatch.value =
      currentMatch.value <= 1 ? searchMatchCount.value : currentMatch.value - 1;
  }

  function getFileWrapper(fileId: string): HTMLElement | null {
    const wrappers = options.containerRef.value?.querySelectorAll<HTMLElement>(".diff-file");
    if (!wrappers) return null;
    return [...wrappers].find((wrapper) => wrapper.dataset.fileId === fileId) ?? null;
  }

  function ensureSearchStyles(shadowRoot: ShadowRoot) {
    if (shadowRoot.querySelector("style[data-kanna-diff-search]")) return;
    const style = document.createElement("style");
    style.dataset.kannaDiffSearch = "true";
    style.textContent = `
      .diff-search-match {
        background: rgba(255, 196, 61, 0.22);
        box-shadow: inset 0 0 0 1px rgba(255, 196, 61, 0.3);
      }

      .diff-search-active {
        background: rgba(255, 196, 61, 0.4);
        box-shadow: inset 0 0 0 1px rgba(255, 196, 61, 0.85);
      }
    `;
    shadowRoot.appendChild(style);
  }

  function getMatchElements(match: DiffSearchMatch): HTMLElement[] {
    const wrapper = getFileWrapper(match.anchor.fileId);
    const container = wrapper?.querySelector<HTMLElement>("diffs-container");
    const shadowRoot = container?.shadowRoot;
    if (shadowRoot) {
      ensureSearchStyles(shadowRoot);
    }

    if (match.anchor.type === "file-header") {
      const stickyHeader = wrapper?.querySelector<HTMLElement>(".diff-file-header");
      if (stickyHeader) return [stickyHeader];
      if (!shadowRoot) return [];
      const title = shadowRoot.querySelector<HTMLElement>("[data-title]");
      return title ? [title] : [];
    }

    if (!shadowRoot) return [];

    const lineIndexPrefix = `${match.anchor.unifiedLineIndex},`;
    const gutter = shadowRoot.querySelector<HTMLElement>(`[data-gutter] [data-line-index^="${lineIndexPrefix}"]`);
    const content = shadowRoot.querySelector<HTMLElement>(`[data-content] [data-line-index^="${lineIndexPrefix}"]`);
    return [gutter, content].filter((element): element is HTMLElement => element != null);
  }

  function clearSearchHighlights() {
    for (const header of options.containerRef.value?.querySelectorAll<HTMLElement>(".diff-file-header.diff-search-match, .diff-file-header.diff-search-active") ?? []) {
      header.classList.remove("diff-search-match", "diff-search-active");
    }

    const containers = options.containerRef.value?.querySelectorAll<HTMLElement>("diffs-container");
    if (!containers) return;

    for (const container of containers) {
      const shadowRoot = container.shadowRoot;
      if (!shadowRoot) continue;
      for (const element of shadowRoot.querySelectorAll<HTMLElement>(".diff-search-match, .diff-search-active")) {
        element.classList.remove("diff-search-match", "diff-search-active");
      }
    }
  }

  function applySearchHighlights() {
    clearSearchHighlights();
    if (!searchMatches.value.length) return;

    const activeIndex = Math.max(1, Math.min(currentMatch.value, searchMatches.value.length)) - 1;
    let activeElement: HTMLElement | null = null;

    for (const [index, match] of searchMatches.value.entries()) {
      const elements = getMatchElements(match);
      for (const element of elements) {
        element.classList.add("diff-search-match");
        if (index === activeIndex) {
          element.classList.add("diff-search-active");
          if (activeElement == null && !element.closest("[data-gutter]")) {
            activeElement = element;
          }
        }
      }
    }

    activeElement?.scrollIntoView?.({ block: "center" });
  }

  function handleSearchInputKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
      nextTick(() => options.focusDiffView());
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        prevMatch();
      } else {
        nextMatch();
      }
      nextTick(() => options.focusDiffView());
    }
  }

  watch(searchMatchCount, (count) => {
    if (count === 0) {
      currentMatch.value = 1;
      return;
    }
    if (currentMatch.value > count) {
      currentMatch.value = count;
    }
  });

  watch(searchQuery, () => {
    currentMatch.value = 1;
  });

  watch([searchMatches, currentMatch], () => {
    nextTick(() => applySearchHighlights());
  });

  watch(isSearching, (searching) => {
    if (searching) {
      focusSearchInput();
    }
  });

  return {
    isSearching,
    searchQuery,
    searchCountLabel,
    openSearch,
    closeSearch,
    focusSearchInput,
    nextMatch,
    prevMatch,
    applySearchHighlights,
    handleSearchInputKeydown,
  };
}
