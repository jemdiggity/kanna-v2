import { describe, expect, it } from "vitest";
import { computed, ref } from "vue";

import { AGENT_TAB_ID, mainTabId, useMainTabs } from "./useMainTabs";

function setup(initialScope: string | null = "item:task-a") {
  const scope = ref<string | null>(initialScope);
  const tabs = useMainTabs({ scopeKey: computed(() => scope.value) });
  return { scope, tabs };
}

describe("useMainTabs", () => {
  it("always offers the agent session first and never closes it", () => {
    const { tabs } = setup();

    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([AGENT_TAB_ID]);
    expect(tabs.activeTabId.value).toBe(AGENT_TAB_ID);

    tabs.openTab({ kind: "diff" });
    tabs.closeTab(AGENT_TAB_ID);

    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([AGENT_TAB_ID, "diff"]);
  });

  it("focuses an already open view instead of stacking a duplicate", () => {
    const { tabs } = setup();

    tabs.openTab({ kind: "file", filePath: "src/a.ts" });
    tabs.openTab({ kind: "diff" });
    tabs.openTab({ kind: "file", filePath: "src/a.ts", initialLine: 12 });

    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([
      AGENT_TAB_ID,
      "file:src/a.ts",
      "diff",
    ]);
    expect(tabs.activeTabId.value).toBe("file:src/a.ts");
    // Re-opening at a line re-aims the tab that is already showing the file.
    expect(tabs.activeTab.value?.initialLine).toBe(12);
  });

  it("keeps each task's tabs and restores them when the task comes back", () => {
    const { scope, tabs } = setup();

    tabs.openTab({ kind: "file", filePath: "src/a.ts" });

    scope.value = "item:task-b";
    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([AGENT_TAB_ID]);

    tabs.openTab({ kind: "shell" });
    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([AGENT_TAB_ID, "shell"]);

    scope.value = "item:task-a";
    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([AGENT_TAB_ID, "file:src/a.ts"]);
    expect(tabs.activeTabId.value).toBe("file:src/a.ts");
  });

  it("opens nothing while no task is selected", () => {
    const { tabs } = setup(null);

    expect(tabs.openTab({ kind: "diff" })).toBeNull();
    expect(tabs.tabs.value).toEqual([]);
  });

  it("toggles a view closed only when it is the one in front", () => {
    const { tabs } = setup();

    tabs.toggleTab({ kind: "diff" });
    expect(tabs.activeTabId.value).toBe("diff");

    tabs.openTab({ kind: "shell" });
    expect(tabs.activeTabId.value).toBe("shell");

    // Diff is open but behind the shell: the shortcut raises it.
    tabs.toggleTab({ kind: "diff" });
    expect(tabs.activeTabId.value).toBe("diff");
    expect(tabs.isOpen("diff")).toBe(true);

    // Now it is in front, so the same shortcut closes it.
    tabs.toggleTab({ kind: "diff" });
    expect(tabs.isOpen("diff")).toBe(false);
  });

  it("moves to the tab that takes the closed one's place", () => {
    const { tabs } = setup();

    tabs.openTab({ kind: "diff" });
    tabs.openTab({ kind: "file", filePath: "src/a.ts" });
    tabs.openTab({ kind: "shell" });

    // A middle tab hands over to its right neighbour...
    tabs.activateTab("file:src/a.ts");
    tabs.closeTab("file:src/a.ts");
    expect(tabs.activeTabId.value).toBe("shell");

    // ...and the last one falls back to its left.
    tabs.closeTab("shell");
    expect(tabs.activeTabId.value).toBe("diff");

    tabs.closeTab("diff");
    expect(tabs.activeTabId.value).toBe(AGENT_TAB_ID);
  });

  it("leaves the active tab alone when a background tab closes", () => {
    const { tabs } = setup();

    tabs.openTab({ kind: "diff" });
    tabs.openTab({ kind: "file", filePath: "src/a.ts" });
    tabs.closeTab("diff");

    expect(tabs.activeTabId.value).toBe("file:src/a.ts");
  });

  it("cycles through the open tabs in both directions", () => {
    const { tabs } = setup();

    tabs.openTab({ kind: "diff" });
    tabs.openTab({ kind: "shell" });
    expect(tabs.activeTabId.value).toBe("shell");

    tabs.cycleTab(1);
    expect(tabs.activeTabId.value).toBe(AGENT_TAB_ID);

    tabs.cycleTab(-1);
    expect(tabs.activeTabId.value).toBe("shell");
  });

  it("reports the shortcut context of the active tab", () => {
    const { tabs } = setup();

    expect(tabs.activeTabContext.value).toBe("main");
    tabs.openTab({ kind: "file", filePath: "src/a.ts" });
    expect(tabs.activeTabContext.value).toBe("file");
    tabs.openTab({ kind: "shell" });
    expect(tabs.activeTabContext.value).toBe("shell");
  });

  it("names a file tab by its path so an agent-driven open is idempotent", () => {
    expect(mainTabId({ kind: "file", filePath: "src/a.ts" })).toBe("file:src/a.ts");
    expect(mainTabId({ kind: "file", filePath: "src/b.ts" })).not.toBe(
      mainTabId({ kind: "file", filePath: "src/a.ts" }),
    );
    expect(mainTabId({ kind: "diff" })).toBe("diff");
  });
});
