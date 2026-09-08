import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, nextTick, ref } from "vue";

import { AGENT_TAB_ID, PERSISTED_MAIN_TABS_VERSION, useMainTabs } from "./useMainTabs";
import { MAIN_TABS_STORAGE_KEY, useMainTabPersistence } from "./useMainTabPersistence";

interface SetupOptions {
  stored?: string | null;
  taskIds?: string[];
  repoIds?: string[];
  writeStorage?: (key: string, value: string) => Promise<unknown>;
  storageKey?: string;
}

function setup(options: SetupOptions = {}) {
  const scope = ref<string | null>("item:task-a");
  const tabs = useMainTabs({ scopeKey: computed(() => scope.value) });
  const openTaskIds = ref<string[]>(options.taskIds ?? ["task-a"]);
  const openRepoIds = ref<string[]>(options.repoIds ?? ["repo-a"]);
  const saved: Array<{ key: string; value: string }> = [];
  const writeStorage = options.writeStorage
    ?? (async (key: string, value: string) => { saved.push({ key, value }); });
  const persistence = useMainTabPersistence({
    tabs,
    openTaskIds,
    openRepoIds,
    readStorage: async () => options.stored ?? null,
    writeStorage,
    storageKey: options.storageKey,
  });
  return { scope, tabs, openTaskIds, openRepoIds, saved, persistence };
}

function storedPayload(scopes: Record<string, { tabs: Array<Record<string, unknown>>; activeId: string }>): string {
  return JSON.stringify({ version: PERSISTED_MAIN_TABS_VERSION, scopes });
}

describe("useMainTabPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("restores the tab sets a previous run left behind", async () => {
    const { tabs, persistence } = setup({
      stored: storedPayload({
        "item:task-a": {
          tabs: [{ kind: "diff" }, { kind: "shell", shellScope: "repo" }],
          activeId: "shell:repo",
        },
      }),
    });

    await persistence.hydrate();

    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([AGENT_TAB_ID, "diff", "shell:repo"]);
    expect(tabs.activeTabId.value).toBe("shell:repo");
  });

  it("leaves behind a stored scope whose task closed while the app was shut down", async () => {
    const { tabs, scope, persistence } = setup({
      stored: storedPayload({
        "item:task-a": { tabs: [{ kind: "diff" }], activeId: "diff" },
        "item:task-gone": { tabs: [{ kind: "diff" }], activeId: "diff" },
      }),
      taskIds: ["task-a"],
    });

    await persistence.hydrate();
    scope.value = "item:task-gone";

    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([AGENT_TAB_ID]);
  });

  it("writes once the tabs hold still, not once per keystroke", async () => {
    const { tabs, saved, persistence } = setup();
    await persistence.hydrate();

    tabs.openTab({ kind: "diff" });
    await nextTick();
    tabs.openTab({ kind: "file", filePath: "src/a.ts" });
    await nextTick();
    expect(saved).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(500);

    expect(saved).toHaveLength(1);
    expect(saved[0].key).toBe(MAIN_TABS_STORAGE_KEY);
    expect(JSON.parse(saved[0].value).scopes["item:task-a"].tabs).toEqual([
      { kind: "diff" },
      { kind: "file", filePath: "src/a.ts" },
    ]);
  });

  it("stores nothing before the stored state has been read back", async () => {
    const { tabs, saved } = setup();

    tabs.openTab({ kind: "diff" });
    await nextTick();
    await vi.advanceTimersByTimeAsync(500);

    // Writing here would overwrite the previous run's tabs with the empty set
    // this one starts from, before it has had the chance to restore them.
    expect(saved).toHaveLength(0);
  });

  it("drops a scope when its task leaves the desktop, and stores that", async () => {
    const { tabs, scope, openTaskIds, saved, persistence } = setup({ taskIds: ["task-a", "task-b"] });
    await persistence.hydrate();

    tabs.openTab({ kind: "diff" });
    await nextTick();
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.parse(saved[0].value).scopes["item:task-a"]).toBeDefined();

    openTaskIds.value = ["task-b"];
    await nextTick();
    await vi.advanceTimersByTimeAsync(500);

    scope.value = "item:task-a";
    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([AGENT_TAB_ID]);
    expect(JSON.parse(saved.at(-1)!.value).scopes["item:task-a"]).toBeUndefined();
  });

  it("keeps a scope whose task has simply not loaded yet", async () => {
    const { tabs, persistence } = setup({
      stored: storedPayload({ "item:task-a": { tabs: [{ kind: "diff" }], activeId: "diff" } }),
      taskIds: ["task-a"],
    });

    await persistence.hydrate();
    await nextTick();

    // The prune watcher runs immediately with whatever the store holds; a
    // restored scope must survive that first pass.
    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([AGENT_TAB_ID, "diff"]);
  });

  it("keeps the tabs open when the write fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tabs, persistence } = setup({
      writeStorage: async () => { throw new Error("storage unavailable"); },
    });
    await persistence.hydrate();

    tabs.openTab({ kind: "diff" });
    await nextTick();
    await vi.advanceTimersByTimeAsync(500);

    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([AGENT_TAB_ID, "diff"]);
    expect(error).toHaveBeenCalled();
  });

  it("opens on the agent session when the stored value is corrupt", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tabs, persistence } = setup({ stored: "{ not json" });

    await persistence.hydrate();

    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual([AGENT_TAB_ID]);
    expect(error).not.toHaveBeenCalled();
  });

  it("stores each window's tabs under its own key", async () => {
    const { tabs, saved, persistence } = setup({ storageKey: "kanna.mainTabs.secondary-1" });
    await persistence.hydrate();

    tabs.openTab({ kind: "diff" });
    await nextTick();
    await vi.advanceTimersByTimeAsync(500);

    // A tear-off opens on the view it was torn off with; inheriting the main
    // window's tabs is not what it is for.
    expect(saved[0].key).toBe("kanna.mainTabs.secondary-1");
  });
});
