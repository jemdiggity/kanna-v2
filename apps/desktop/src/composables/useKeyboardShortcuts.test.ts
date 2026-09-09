// @vitest-environment happy-dom

import { defineComponent } from "vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  getShortcutGroups,
  isAppShortcut,
  useKeyboardShortcuts,
  shortcuts,
  type ActionName,
  type KeyboardActions,
} from "./useKeyboardShortcuts";
import type { ShortcutContext } from "./useShortcutContext";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";
import ko from "../i18n/locales/ko.json";

function identityTranslate(key: string): string {
  return key;
}

function englishTranslate(key: string): string {
  const values: Record<string, string> = {
    "shortcuts.groupOpenInspect": "Tools",
    "shortcuts.commandPalette": "Command Palette",
    "shortcuts.analytics": "Analytics",
    "shortcuts.commitGraph": "Commit Graph",
    "shortcuts.filePicker": "File Picker",
    "shortcuts.filePreview": "File Preview",
    "shortcuts.openInIDE": "Open in IDE",
    "shortcuts.openLatestAgentFile": "Open Latest Agent File",
    "shortcuts.shellRepoRoot": "Shell at Repo Root",
    "shortcuts.shellTerminal": "Shell Terminal",
    "shortcuts.treeExplorer": "Tree Explorer",
    "shortcuts.viewDiff": "View Diff",
  };
  return values[key] ?? key;
}

describe("getShortcutGroups", () => {
  it("groups full-menu shortcuts by workflow-first categories", () => {
    const groups = getShortcutGroups(identityTranslate);

    expect(groups.map((group) => group.title)).toEqual([
      "shortcuts.groupCreateOrganize",
      "shortcuts.groupMoveAround",
      "shortcuts.groupOpenInspect",
      "shortcuts.groupWorkspace",
      "shortcuts.groupAppHelp",
    ]);
  });

  it("assigns shortcuts to the expected workflow-first groups", () => {
    const groups = getShortcutGroups(identityTranslate);
    const groupMap = Object.fromEntries(
      groups.map((group) => [group.title, group.shortcuts.map((shortcut) => shortcut.action)]),
    );

    expect(groupMap["shortcuts.groupCreateOrganize"]).toEqual([
      "shortcuts.createRepo",
      "shortcuts.importClone",
      "shortcuts.newTask",
      "shortcuts.focusSearch",
      "shortcuts.advanceStage",
      "shortcuts.closeReject",
    ]);

    expect(groupMap["shortcuts.groupMoveAround"]).toEqual([
      "shortcuts.previousTask",
      "shortcuts.nextTask",
      "shortcuts.previousRepo",
      "shortcuts.nextRepo",
      "shortcuts.goBack",
      "shortcuts.goForward",
      "shortcuts.oldestUnread",
      "shortcuts.oldestUnreadAllRepos",
      "shortcuts.oldestRead",
      "shortcuts.oldestReadAllRepos",
    ]);

    expect([...groupMap["shortcuts.groupOpenInspect"]].sort()).toEqual([
      "shortcuts.analytics",
      "shortcuts.commandPalette",
      "shortcuts.commitGraph",
      "shortcuts.filePicker",
      "shortcuts.filePreview",
      "shortcuts.openInIDE",
      "shortcuts.openLatestAgentFile",
      "shortcuts.shellRepoRoot",
      "shortcuts.shellTerminal",
      "shortcuts.treeExplorer",
      "shortcuts.viewDiff",
    ].sort());

    expect(groupMap["shortcuts.groupWorkspace"]).toEqual([
      "shortcuts.newWindow",
      "shortcuts.closeTab",
      "shortcuts.closeWindow",
      "shortcuts.toggleSidebar",
      "shortcuts.maximize",
    ]);

    expect(groupMap["shortcuts.groupAppHelp"]).toEqual([
      "shortcuts.preferences",
      "shortcuts.keyboardShortcuts",
    ]);
  });

  it("sorts tools alphabetically by their visible label", () => {
    const groups = getShortcutGroups(englishTranslate);
    const tools = groups.find((group) => group.title === "Tools");

    expect(tools?.shortcuts.map((shortcut) => shortcut.action)).toEqual([
      "Analytics",
      "Command Palette",
      "Commit Graph",
      "File Picker",
      "File Preview",
      "Open in IDE",
      "Open Latest Agent File",
      "Shell at Repo Root",
      "Shell Terminal",
      "Tree Explorer",
      "View Diff",
    ]);
  });
});

describe("isAppShortcut", () => {
  it("matches shifted letter shortcuts using the uppercase event key", () => {
    expect(isAppShortcut(new KeyboardEvent("keydown", {
      key: "E",
      metaKey: true,
      shiftKey: true,
    }))).toBe(true);
  });

  it("matches Option+Command+P for file preview recall", () => {
    expect(isAppShortcut(new KeyboardEvent("keydown", {
      key: "p",
      metaKey: true,
      altKey: true,
    }))).toBe(true);
  });

  it("matches the macOS Option+Command+P character event by physical key code", () => {
    expect(isAppShortcut(new KeyboardEvent("keydown", {
      key: "π",
      code: "KeyP",
      metaKey: true,
      altKey: true,
    }))).toBe(true);
  });

  it("matches the new window shortcut", () => {
    expect(isAppShortcut(new KeyboardEvent("keydown", {
      key: "n",
      metaKey: true,
    }))).toBe(true);
  });

  it("matches the close window shortcut", () => {
    expect(isAppShortcut(new KeyboardEvent("keydown", {
      key: "w",
      metaKey: true,
    }))).toBe(true);
  });

  it("matches Command+L for the latest agent file", () => {
    expect(isAppShortcut(new KeyboardEvent("keydown", {
      key: "l",
      metaKey: true,
    }))).toBe(true);
  });

  it("does not reserve Command+Z", () => {
    expect(isAppShortcut(new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
    }))).toBe(false);
  });
});

describe("shortcut contexts", () => {
  it("allows Command+P to open the file picker from the file preview", () => {
    const openFileShortcut = shortcuts.find((shortcut) => shortcut.action === "openFile");

    expect(openFileShortcut?.context).toContain("file");
  });

  it("maps Command+L to the latest agent file action", () => {
    const shortcut = shortcuts.find((entry) => entry.action === "openLatestFileLink");

    expect(shortcut).toMatchObject({ key: "l", meta: true, display: "⌘L" });
    expect(shortcut?.context).toContain("file");
  });
});

describe("useKeyboardShortcuts", () => {
  const actionNames: ActionName[] = [
    "newTask",
    "newWindow",
    "openFile",
    "openLatestFileLink",
    "toggleFilePreview",
    "advanceStage",
    "closeTask",
    "undoClose",
    "navigateUp",
    "navigateDown",
    "navigateRepoUp",
    "navigateRepoDown",
    "dismiss",
    "openInIDE",
    "openShell",
    "showDiff",
    "showCommitGraph",
    "toggleMaximize",
    "showShortcuts",
    "showAllShortcuts",
    "toggleSidebar",
    "commandPalette",
    "showAnalytics",
    "goBack",
    "goForward",
    "createRepo",
    "importRepo",
    "blockTask",
    "editBlockedTask",
    "toggleTreeExplorer",
    "openPreferences",
    "openShellRepoRoot",
    "prevTab",
    "nextTab",
    "focusSearch",
    "goToOldestUnread",
    "goToOldestUnreadAllRepos",
    "goToOldestRead",
    "goToOldestReadAllRepos",
  ];

  function buildActions(): KeyboardActions {
    return Object.fromEntries(actionNames.map((name) => [name, vi.fn()])) as KeyboardActions;
  }

  function mountShortcutHarness(actions: KeyboardActions, context: () => ShortcutContext) {
    const Harness = defineComponent({
      setup() {
        useKeyboardShortcuts(actions, { context });
        return () => null;
      },
    });

    return mount(Harness);
  }

  it.each([
    { key: "U", action: "goToOldestUnreadAllRepos" as const, labelKey: "shortcuts.oldestUnreadAllRepos" },
    { key: "R", action: "goToOldestReadAllRepos" as const, labelKey: "shortcuts.oldestReadAllRepos" },
  ])("maps Shift+Command+$key to $action", ({ key, action, labelKey }) => {
    expect(shortcuts.find((shortcut) => shortcut.action === action)).toMatchObject({
      action,
      labelKey,
      key: [key, key.toLowerCase()],
      meta: true,
      shift: true,
    });

    const actions = buildActions();
    const wrapper = mountShortcutHarness(actions, () => "main");
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));

    expect(actions[action]).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("allows opening the file picker from the diff modal context", () => {
    const actions = buildActions();
    const wrapper = mountShortcutHarness(actions, () => "diff");

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "p",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));

    expect(actions.openFile).toHaveBeenCalledTimes(1);
    expect(actions.newTask).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("does not dispatch undo close for Command+Z", () => {
    const actions = buildActions();
    const wrapper = mountShortcutHarness(actions, () => "main");

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));

    expect(actions.undoClose).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does not expose stage approval shortcuts from the diff modal context", () => {
    const actions = buildActions();
    const wrapper = mountShortcutHarness(actions, () => "diff");

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));

    expect(actions.advanceStage).toHaveBeenCalledTimes(0);
    wrapper.unmount();
  });

  it("allows preview modal shortcuts from every preview modal context", () => {
    const previewContexts: ShortcutContext[] = ["diff", "file", "shell", "tree", "graph"];
    const previewShortcuts: Array<{
      action: ActionName;
      event: { key: string; meta?: boolean; shift?: boolean };
    }> = [
      { action: "openFile", event: { key: "p", meta: true } },
      { action: "openLatestFileLink", event: { key: "l", meta: true } },
      { action: "showDiff", event: { key: "d", meta: true } },
      { action: "showCommitGraph", event: { key: "g", meta: true } },
      { action: "openShell", event: { key: "j", meta: true } },
      { action: "openShellRepoRoot", event: { key: "J", meta: true, shift: true } },
      { action: "toggleTreeExplorer", event: { key: "E", meta: true, shift: true } },
    ];

    for (const context of previewContexts) {
      for (const shortcut of previewShortcuts) {
        const actions = buildActions();
        const wrapper = mountShortcutHarness(actions, () => context);

        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: shortcut.event.key,
          metaKey: shortcut.event.meta ?? false,
          shiftKey: shortcut.event.shift ?? false,
          bubbles: true,
          cancelable: true,
        }));

        expect(actions[shortcut.action], `${shortcut.action} in ${context}`).toHaveBeenCalledTimes(1);
        wrapper.unmount();
      }
    }
  });

  it("handles Escape as dismiss in the tree modal context", () => {
    const actions = buildActions();
    const wrapper = mountShortcutHarness(actions, () => "tree");

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));

    expect(actions.dismiss).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});

describe("shortcut i18n labels", () => {
  const locales: Record<string, unknown> = { en, ja, ko };

  function lookup(messages: unknown, key: string): unknown {
    return key.split(".").reduce<unknown>((node, segment) => {
      if (typeof node !== "object" || node === null) return undefined;
      return (node as Record<string, unknown>)[segment];
    }, messages);
  }

  // Both the shortcuts modal and the command palette render these keys through
  // t() — a missing one leaks the raw "shortcuts.prevTab" string into the UI.
  it.each(Object.keys(locales))("resolves every shortcut label and group in %s", (locale) => {
    const messages = locales[locale];
    const missing = shortcuts
      .flatMap((shortcut) => [shortcut.labelKey, shortcut.groupKey])
      .filter((key) => typeof lookup(messages, key) !== "string");

    expect([...new Set(missing)]).toEqual([]);
  });
});
