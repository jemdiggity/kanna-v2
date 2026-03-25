import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createNavigationHistory } from "./useNavigationHistory";

describe("useNavigationHistory", () => {
  let nav: ReturnType<typeof createNavigationHistory>;
  let now: number;
  let dateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    now = 10_000;
    dateSpy = spyOn(Date, "now").mockImplementation(() => now);
    nav = createNavigationHistory();
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  /** Advance fake clock past the dwell threshold so select() records the entry. */
  function tick() {
    now += 1500;
  }

  describe("select", () => {
    it("pushes previous task onto back stack", () => {
      tick();
      nav.select("B", "A");
      expect(nav.canGoBack.value).toBe(true);
      expect(nav.canGoForward.value).toBe(false);
    });

    it("clears forward stack on new navigation", () => {
      tick();
      nav.select("B", "A");
      nav.goBack("B"); // back to A, forward has B
      expect(nav.canGoForward.value).toBe(true);
      tick();
      nav.select("C", "A"); // new nav clears forward
      expect(nav.canGoForward.value).toBe(false);
    });

    it("suppresses duplicate consecutive entries", () => {
      tick();
      nav.select("B", "A");
      tick();
      nav.select("C", "A"); // same previous as top of stack
      const first = nav.goBack("C");
      expect(first).toBe("A");
      const second = nav.goBack("A");
      expect(second).toBeNull(); // only one entry
    });

    it("ignores null previous task", () => {
      tick();
      nav.select("A", null);
      expect(nav.canGoBack.value).toBe(false);
    });

    it("ignores when previous equals new", () => {
      tick();
      nav.select("A", "A");
      expect(nav.canGoBack.value).toBe(false);
    });

    it("skips transient navigations under dwell threshold", () => {
      tick();
      nav.select("B", "A");
      // No tick — next call is within dwell threshold
      nav.select("C", "B");
      // Only A should be on the stack
      const result = nav.goBack("C");
      expect(result).toBe("A");
      expect(nav.goBack("A")).toBeNull();
    });

    it("caps back stack at 50 entries", () => {
      for (let i = 0; i < 60; i++) {
        tick();
        nav.select(`task-${i + 1}`, `task-${i}`);
      }
      let count = 0;
      let current = "task-60";
      while (nav.canGoBack.value) {
        current = nav.goBack(current)!;
        count++;
      }
      expect(count).toBe(50);
    });
  });

  describe("goBack", () => {
    it("returns null when back stack is empty", () => {
      expect(nav.goBack("A")).toBeNull();
    });

    it("returns previous task and pushes current to forward stack", () => {
      tick();
      nav.select("B", "A");
      tick();
      nav.select("C", "B");
      const result = nav.goBack("C");
      expect(result).toBe("B");
      expect(nav.canGoForward.value).toBe(true);
    });

    it("skips task IDs not in the valid set", () => {
      tick();
      nav.select("B", "A");
      tick();
      nav.select("C", "B");
      // B was deleted, only A and C are valid
      const result = nav.goBack("C", new Set(["A", "C"]));
      expect(result).toBe("A");
    });

    it("returns null if all back entries are invalid", () => {
      tick();
      nav.select("B", "A");
      const result = nav.goBack("B", new Set(["B"])); // A not valid
      expect(result).toBeNull();
    });
  });

  describe("goForward", () => {
    it("returns null when forward stack is empty", () => {
      expect(nav.goForward("A")).toBeNull();
    });

    it("returns next task and pushes current to back stack", () => {
      tick();
      nav.select("B", "A");
      nav.goBack("B"); // now on A, forward has B
      const result = nav.goForward("A");
      expect(result).toBe("B");
      expect(nav.canGoBack.value).toBe(true);
    });

    it("skips invalid task IDs", () => {
      tick();
      nav.select("B", "A");
      tick();
      nav.select("C", "B");
      nav.goBack("C"); // on B, forward has C
      nav.goBack("B"); // on A, forward has B, C
      // B was deleted
      const result = nav.goForward("A", new Set(["A", "C"]));
      expect(result).toBe("C");
    });
  });

  describe("full navigation sequence", () => {
    it("handles back-forward-new navigation correctly", () => {
      tick();
      nav.select("B", "A");
      tick();
      nav.select("C", "B");
      // Go back twice: C -> B -> A
      expect(nav.goBack("C")).toBe("B");
      expect(nav.goBack("B")).toBe("A");
      // Go forward once: A -> B
      expect(nav.goForward("A")).toBe("B");
      // New navigation from B -> D clears forward
      tick();
      nav.select("D", "B");
      expect(nav.canGoForward.value).toBe(false);
      // Back should go to B (from D)
      expect(nav.goBack("D")).toBe("B");
    });
  });
});
