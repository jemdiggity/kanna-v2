import { describe, it, expect, beforeEach } from "bun:test";
import {
  activeContext,
  contextShortcuts,
  setContext,
  resetContext,
  setContextShortcuts as register,
  clearContextShortcuts,
  getContextShortcuts,
  type ShortcutContext,
} from "./useShortcutContext";

describe("useShortcutContext", () => {
  beforeEach(() => {
    resetContext();
    clearContextShortcuts();
  });

  describe("activeContext", () => {
    it("defaults to 'main'", () => {
      expect(activeContext.value).toBe("main");
    });

    it("can be set to diff", () => {
      setContext("diff");
      expect(activeContext.value).toBe("diff");
    });

    it("resets to main", () => {
      setContext("file");
      resetContext();
      expect(activeContext.value).toBe("main");
    });
  });

  describe("registerContextShortcuts", () => {
    it("stores shortcuts for a context", () => {
      register("diff", [{ label: "Cycle Scope", display: "Space" }]);
      expect(contextShortcuts.value.get("diff")).toEqual([
        { label: "Cycle Scope", display: "Space" },
      ]);
    });

    it("clears shortcuts for a context", () => {
      register("diff", [{ label: "Cycle Scope", display: "Space" }]);
      clearContextShortcuts("diff");
      expect(contextShortcuts.value.has("diff")).toBe(false);
    });
  });

  describe("getContextShortcuts", () => {
    it("returns global shortcuts tagged for the context", () => {
      register("diff", [{ label: "Cycle Scope", display: "Space" }]);
      const result = getContextShortcuts("diff");
      const labels = result.map((s) => s.action);
      expect(labels).toContain("Cycle Scope");
    });

    // NOTE: These tests require Task 1 to add `context` tags to the shortcuts array.
    // Until then, all shortcuts have no context field, so !def.context is true for all,
    // meaning getContextShortcuts returns ALL shortcuts regardless of context.
    it.skip("includes untagged global shortcuts (available in all contexts)", () => {
      const result = getContextShortcuts("diff");
      const labels = result.map((s) => s.action);
      expect(labels).toContain("Keyboard Shortcuts");
      expect(labels).toContain("Command Palette");
      expect(labels).toContain("Dismiss");
    });

    it.skip("excludes shortcuts tagged for other contexts", () => {
      const result = getContextShortcuts("diff");
      const labels = result.map((s) => s.action);
      expect(labels).not.toContain("New Task");
      expect(labels).not.toContain("File Picker");
    });
  });
});
