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

  // Clamp currentMatch when match count shrinks (e.g., query changes)
  watch(matchCount, (count) => {
    if (currentMatch.value > count && count > 0) {
      currentMatch.value = count;
    } else if (count === 0) {
      currentMatch.value = 1;
    }
  });

  const decorations = computed<DecorationItem[]>(() => {
    if (!matches.value.length) return [];
    const clamped = Math.max(1, Math.min(currentMatch.value, matches.value.length));
    const activeIdx = clamped - 1;
    return matches.value.map((m, i) => ({
      start: m.start,
      end: m.end,
      properties: {
        class: i === activeIdx ? "search-hl-active" : "search-hl",
      },
    }));
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
