import { describe, it, expect, beforeEach } from "vitest";
import {
  activeContext,
  contextShortcuts,
  setContext,
  resetContext,
  setContextShortcuts as register,
  setContextShortcuts,
  clearContextShortcuts,
  getContextShortcutGroups,
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
      const actions = result.map((s) => s.action);
      expect(actions).toContain("Cycle Scope");
    });

    it("includes global shortcuts tagged for main context", () => {
      const result = getContextShortcuts("main");
      const actions = result.map((s) => s.action);
      expect(actions).toContain("shortcuts.keyboardShortcuts");
      expect(actions).toContain("shortcuts.commandPalette");
      expect(actions).not.toContain("shortcuts.dismiss");
    });

    it("keeps only modal-relevant global shortcuts in modal contexts", () => {
      for (const ctx of ["diff", "file", "shell", "tree", "graph"] as ShortcutContext[]) {
        const result = getContextShortcuts(ctx);
        const actions = result.map((s) => s.action);
        expect(actions).not.toContain("shortcuts.commandPalette");
        expect(actions).toContain("shortcuts.keyboardShortcuts");
        expect(actions).not.toContain("shortcuts.dismiss");
      }
    });

    it("shows the file picker shortcut in inspect modal contexts", () => {
      for (const ctx of ["diff", "shell", "tree", "graph"] as ShortcutContext[]) {
        const result = getContextShortcuts(ctx);
        const actions = result.map((s) => s.action);
        expect(actions).toContain("shortcuts.filePicker");
        expect(actions).toContain("shortcuts.openLatestAgentFile");
      }
    });

    it("includes tree-specific supplementary shortcuts in tree context", () => {
      register("tree", [{ label: "Yank path", display: "y" }]);
      const result = getContextShortcuts("tree");
      const actions = result.map((s) => s.action);
      expect(actions).toContain("shortcuts.maximize");
      expect(actions).toContain("Yank path");
      expect(actions).toContain("shortcuts.treeExplorer");
      expect(actions).toContain("shortcuts.keyboardShortcuts");
    });

    it("keeps help but excludes dismiss and unrelated global actions from new task context", () => {
      const result = getContextShortcuts("newTask");
      const actions = result.map((s) => s.action);
      expect(actions).toContain("shortcuts.keyboardShortcuts");
      expect(actions).not.toContain("shortcuts.dismiss");
      expect(actions).not.toContain("shortcuts.commandPalette");
    });

    it("excludes shortcuts tagged for other contexts", () => {
      const result = getContextShortcuts("diff");
      const actions = result.map((s) => s.action);
      expect(actions).not.toContain("shortcuts.newTask");
      expect(actions).not.toContain("shortcuts.commandPalette");
    });

    it("includes cross-preview shortcuts from file context", () => {
      const result = getContextShortcuts("file");
      const actions = result.map((s) => s.action);

      expect(actions).toContain("shortcuts.filePreview");
      expect(actions).toContain("shortcuts.openLatestAgentFile");
      expect(actions).toContain("shortcuts.treeExplorer");
      expect(actions).toContain("shortcuts.viewDiff");
      expect(actions).toContain("shortcuts.shellTerminal");
      expect(actions).toContain("shortcuts.maximize");
      expect(actions).toContain("shortcuts.keyboardShortcuts");
    });

    it("shows the file preview recall shortcut in the file context menu", () => {
      const result = getContextShortcutGroups((key) => key, "file");
      const filePreviewShortcut = result
        .flatMap((group) => group.shortcuts)
        .find((shortcut) => shortcut.action === "shortcuts.filePreview");

      expect(filePreviewShortcut?.keys).toBe("⌥⌘P");
    });

    it("translates grouped context shortcut labels while preserving supplementary labels", () => {
      register("diff", [{ label: "Cycle Scope", display: "Space" }]);

      const result = getContextShortcutGroups((key) => `translated:${key}`, "diff");
      const flattened = result.flatMap((group) => group.shortcuts.map((shortcut) => shortcut.action));

      expect(flattened).toContain("translated:shortcuts.maximize");
      expect(flattened).toContain("Cycle Scope");
      expect(flattened).not.toContain("shortcuts.maximize");
    });

    it("keeps Help in its own group for modal contexts", () => {
      register("diff", [{ label: "Cycle Scope", display: "Space" }]);

      const result = getContextShortcutGroups((key) => `translated:${key}`, "diff");
      const helpGroup = result.find((group) => group.key === "shortcuts.groupAppHelp");

      expect(helpGroup).toBeDefined();
      expect(helpGroup?.shortcuts).toEqual([
        { action: "translated:shortcuts.keyboardShortcuts", keys: "⌘/" },
      ]);
    });

    it("groups file context shortcuts into search, navigation, view, and help sections", () => {
      setContextShortcuts(
        "file",
        [
          { label: "Search", display: "/", groupKey: "shortcuts.groupSearch" },
          { label: "Next / Prev match", display: "n / N", groupKey: "shortcuts.groupSearch" },
          { label: "Line ↓/↑", display: "j / k", groupKey: "shortcuts.groupNavigation" },
          { label: "Toggle line numbers", display: "l", groupKey: "shortcuts.groupViews" },
        ] as unknown as Parameters<typeof setContextShortcuts>[1],
      );

      const result = getContextShortcutGroups((key) => key, "file");

      expect(result.map((group) => group.key)).toEqual([
        "shortcuts.groupAppHelp",
        "shortcuts.groupOpenInspect",
        "shortcuts.groupSearch",
        "shortcuts.groupNavigation",
        "shortcuts.groupViews",
      ]);
    });

    it("groups diff context shortcuts into search, navigation, view, and help sections", () => {
      setContextShortcuts(
        "diff",
        [
          { label: "Search", display: "/", groupKey: "shortcuts.groupSearch" },
          { label: "Next / Prev match", display: "n / N", groupKey: "shortcuts.groupSearch" },
          { label: "Line ↓/↑", display: "j / k", groupKey: "shortcuts.groupNavigation" },
          { label: "Cycle filter", display: "s", groupKey: "shortcuts.groupViews" },
        ] as unknown as Parameters<typeof setContextShortcuts>[1],
      );

      const result = getContextShortcutGroups((key) => key, "diff");

      expect(result.map((group) => group.key)).toEqual([
        "shortcuts.groupAppHelp",
        "shortcuts.groupOpenInspect",
        "shortcuts.groupSearch",
        "shortcuts.groupNavigation",
        "shortcuts.groupViews",
      ]);
    });
  });
});
