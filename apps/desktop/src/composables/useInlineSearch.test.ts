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
});
