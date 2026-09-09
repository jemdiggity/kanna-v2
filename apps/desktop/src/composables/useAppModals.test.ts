// @vitest-environment happy-dom

import { computed, defineComponent, h, nextTick, reactive } from "vue";
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarkdownPreviewMode } from "../stores/markdownPreviewMode";
import type { ModalTearOffContext } from "../modalTearOff";
import type { WorkspaceTask } from "../workspace/types";
import { useAppModals } from "./useAppModals";
import {
  mainTabScopeKeyForApp,
  mainTabScopeKeyForTask,
  useMainTabs,
} from "./useMainTabs";

const taskViewMocks = vi.hoisted(() => ({
  relayFactory: vi.fn(),
  lanFactory: vi.fn(),
  listTaskDirectory: vi.fn(),
  readTaskFile: vi.fn(),
  readTaskDiff: vi.fn(),
}));

vi.mock("../services/desktopRelayTerminal", () => ({
  createConfiguredDesktopRemoteTaskViewClient: taskViewMocks.relayFactory,
}));

vi.mock("../services/desktopLanTerminal", () => ({
  createConfiguredDesktopLanTaskViewClient: taskViewMocks.lanFactory,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function mountMarkdownModalHarness(options: {
  markdownPreviewMode?: MarkdownPreviewMode;
  savePreference?: (key: string, value: string) => Promise<void>;
  tearOffContext?: ModalTearOffContext;
  selectedRepo?: { id: string; path: string };
  currentItem?: { id: string; branch: string };
  selectedWorkspaceTask?: WorkspaceTask;
} = {}) {
  const savePreference = vi.fn(
    options.savePreference ?? (async () => {}),
  );
  const store = reactive({
    repos: [],
    selectedRepo: options.selectedRepo ?? { id: "repo-1", path: "/repo" },
    currentItem: options.currentItem ?? { id: "task-a", branch: "task-a" },
    markdownPreviewMode: options.markdownPreviewMode ?? "rendered",
    savePreference,
  });
  const clearTearOffContext = vi.fn(async () => {});
  const TestHarness = defineComponent({
    setup() {
      const mainTabs = useMainTabs({
        scopeKey: computed(() =>
          store.currentItem
            ? mainTabScopeKeyForTask(store.currentItem.id)
            : mainTabScopeKeyForApp()
        ),
      });
      const modals = useAppModals({
        isMobile: false,
        mainTabs,
        store: store as unknown as Parameters<typeof useAppModals>[0]["store"],
        windowWorkspace: {
          bootstrap: {
            windowId: "main",
            selectedRepoId: "repo-1",
            selectedItemId: "task-a",
            ...(options.tearOffContext
              ? { tearOffContext: options.tearOffContext }
              : {}),
          },
          loadSnapshot: vi.fn(),
          persistSidebarWidth: vi.fn(),
          clearTearOffContext,
        } as unknown as Parameters<typeof useAppModals>[0]["windowWorkspace"],
        selectedWorkspaceTask: computed(() => options.selectedWorkspaceTask ?? null),
      });
      return { modals, mainTabs };
    },
    render() {
      return h("div");
    },
  });
  const wrapper = mount(TestHarness);
  return {
    clearTearOffContext,
    modals: wrapper.vm.modals,
    mainTabs: wrapper.vm.mainTabs,
    savePreference,
    store,
    wrapper,
  };
}

describe("useAppModals", () => {
  beforeEach(() => {
    taskViewMocks.relayFactory.mockReset();
    taskViewMocks.lanFactory.mockReset().mockResolvedValue({
      close: vi.fn(),
      listTaskDirectory: taskViewMocks.listTaskDirectory,
      readTaskFile: taskViewMocks.readTaskFile,
      readTaskDiff: taskViewMocks.readTaskDiff,
    });
    taskViewMocks.listTaskDirectory.mockReset().mockResolvedValue({
      path: "",
      entries: [],
      offset: 0,
      nextOffset: null,
      totalEntries: 0,
    });
    taskViewMocks.readTaskFile.mockReset().mockResolvedValue({
      path: "README.md",
      content: "LAN body",
    });
    taskViewMocks.readTaskDiff.mockReset().mockResolvedValue({
      taskId: "owner-task",
      baseRef: "main",
      mergeBase: "base",
      patch: "diff",
      truncated: false,
    });
  });

  it("routes remote-owned task views without constructing a local worktree path", () => {
    const remoteItem = {
      id: "cloud-task",
      branch: "task-owner-branch",
    };
    const harness = mountMarkdownModalHarness({
      selectedRepo: { id: "local-repo", path: "/local/repo" },
      currentItem: { id: "local-shadow", branch: "task-local-shadow" },
      selectedWorkspaceTask: {
        item: remoteItem,
        owner: { kind: "remote", id: "desktop-owner" },
        terminal: {
          kind: "cloud",
          remoteRef: {
            ownerDesktopId: "desktop-owner",
            ownerLocalTaskId: "owner-task",
          },
        },
      } as WorkspaceTask,
    });

    expect(harness.modals.currentWorktreePath.value).toBeUndefined();
    expect(harness.modals.activeRepoPath.value).toBe("");
    expect(harness.modals.activeTaskViewIsRemote.value).toBe(true);
    expect(harness.modals.activeRemoteTaskRoute.value).toEqual({
      desktopId: "desktop-owner",
      taskId: "owner-task",
      transport: "cloud",
    });
    expect(harness.modals.treeExplorerRoot.value).toBe("task-owner-branch");

    harness.wrapper.unmount();
  });

  it("routes LAN tree, file, and diff reads without constructing a relay client", async () => {
    const harness = mountMarkdownModalHarness({
      selectedWorkspaceTask: {
        item: { id: "lan-task", branch: "task-owner-branch" },
        owner: { kind: "remote", id: "peer-owner" },
        terminal: {
          kind: "lan",
          remoteRef: {
            ownerDesktopId: "peer-owner",
            ownerLocalTaskId: "owner-task",
          },
        },
      } as WorkspaceTask,
    });

    expect(harness.modals.activeRemoteTaskRoute.value).toEqual({
      desktopId: "peer-owner",
      taskId: "owner-task",
      transport: "lan",
    });

    await harness.modals.listRemoteTaskDirectory("src", true);
    await harness.modals.readRemoteTaskFile("README.md");
    await harness.modals.readRemoteTaskDiff({ scope: "working", mode: "all" });

    expect(taskViewMocks.lanFactory).toHaveBeenCalledOnce();
    expect(taskViewMocks.relayFactory).not.toHaveBeenCalled();
    expect(taskViewMocks.listTaskDirectory).toHaveBeenCalledWith({
      desktopId: "peer-owner",
      taskId: "owner-task",
      path: "src",
      showAllFiles: true,
    });
    expect(taskViewMocks.readTaskFile).toHaveBeenCalledWith({
      desktopId: "peer-owner",
      taskId: "owner-task",
      path: "README.md",
    });
    expect(taskViewMocks.readTaskDiff).toHaveBeenCalledWith({
      desktopId: "peer-owner",
      taskId: "owner-task",
      request: { scope: "working", mode: "all" },
    });
    harness.wrapper.unmount();
  });

  it("keeps an unreachable remote-owned task off local filesystem paths", async () => {
    const harness = mountMarkdownModalHarness({
      selectedRepo: { id: "local-repo", path: "/local/repo" },
      currentItem: { id: "local-shadow", branch: "task-local-shadow" },
      selectedWorkspaceTask: {
        item: { id: "cloud-offline", branch: "task-owner-offline" },
        owner: { kind: "remote", id: "unknown" },
        sources: [],
        terminal: { kind: "none" },
      } as WorkspaceTask,
    });

    expect(harness.modals.currentWorktreePath.value).toBeUndefined();
    expect(harness.modals.activeRepoPath.value).toBe("");
    expect(harness.modals.activeTaskViewIsRemote.value).toBe(true);
    expect(harness.modals.activeRemoteTaskRoute.value).toBeNull();
    expect(harness.modals.treeExplorerRoot.value).toBe("task-owner-offline");
    await expect(harness.modals.listRemoteTaskDirectory("", false)).rejects.toThrow(
      "Remote task route is unavailable.",
    );

    harness.wrapper.unmount();
  });

  it("restores a transferred tree into a maximized tab and clears only its transfer state", async () => {
    const harness = mountMarkdownModalHarness({
      selectedRepo: { id: "repo-current", path: "/current-repo" },
      currentItem: { id: "task-current", branch: "task-current" },
      tearOffContext: {
        surface: "tree",
        worktreePath: "/current-repo/.kanna-worktrees/task-current",
        repoRoot: "/current-repo",
      },
    });

    harness.modals.restoreTransferredModal();
    expect(harness.mainTabs.activeTab.value?.kind).toBe("tree");
    expect(harness.modals.maximizedModal.value).toBe("tree");
    expect(harness.modals.treeExplorerRoot.value).toBe(
      "/current-repo/.kanna-worktrees/task-current",
    );
    expect(harness.modals.activeRepoPath.value).toBe("/current-repo");
    expect(harness.modals.activeWorktreePath.value).toBe(
      "/current-repo/.kanna-worktrees/task-current",
    );

    // Closing the tab it restored into is what releases the tear-off context.
    harness.modals.finishTransferredModal("tree");
    expect(harness.clearTearOffContext).toHaveBeenCalledOnce();
    await nextTick();
    harness.wrapper.unmount();
  });

  it("restores the authoritative LAN transport from a remote tree tear-off", () => {
    const harness = mountMarkdownModalHarness({
      tearOffContext: {
        surface: "tree",
        worktreePath: "task-owner-branch",
        repoRoot: "",
        remoteDesktopId: "peer-owner",
        remoteTaskId: "owner-task",
        remoteTransport: "lan",
      },
    });

    expect(harness.modals.activeTaskViewIsRemote.value).toBe(true);
    expect(harness.modals.activeRemoteTaskRoute.value).toEqual({
      desktopId: "peer-owner",
      taskId: "owner-task",
      transport: "lan",
    });
    harness.wrapper.unmount();
  });

  it("restores transferred diff view state into a maximized tab", () => {
    const harness = mountMarkdownModalHarness({
      selectedRepo: { id: "repo-current", path: "/current-repo" },
      currentItem: { id: "task-current", branch: "task-current" },
      tearOffContext: {
        surface: "diff",
        repoPath: "/current-repo",
        worktreePath: "/current-repo/.kanna-worktrees/task-current",
        viewKey: "item:task-current",
        taskId: "task-current",
        initialScope: "working",
        initialScrollPositions: { working: 240 },
        initialBranchInclude: "all",
      },
    });

    harness.modals.restoreTransferredModal();
    expect(harness.mainTabs.activeTab.value?.kind).toBe("diff");
    expect(harness.modals.maximizedModal.value).toBe("diff");
    expect(harness.modals.currentDiffViewKey.value).toBe("item:task-current");
    expect(harness.modals.activeRepoPath.value).toBe("/current-repo");
    expect(harness.modals.activeDiffWorktreePath.value).toBe(
      "/current-repo/.kanna-worktrees/task-current",
    );
    expect(harness.modals.currentDiffViewState.value).toMatchObject({
      scope: "working",
      scrollPositions: { working: 240 },
      branchInclude: "all",
    });

    harness.modals.finishTransferredModal("diff");
    expect(harness.clearTearOffContext).toHaveBeenCalledOnce();
    harness.wrapper.unmount();
  });

  
  it("uses and persists one Markdown mode across task preview flows", async () => {
    const { modals, savePreference, store, wrapper } = mountMarkdownModalHarness();

    modals.openFilePreview("README.md", undefined, false);
    expect(modals.currentPreviewMarkdownMode.value).toBe("rendered");

    modals.updateCurrentPreviewMarkdownMode("raw");
    expect(store.markdownPreviewMode).toBe("raw");
    expect(savePreference).toHaveBeenCalledWith("markdownPreviewMode", "raw");

    store.currentItem = { id: "task-b", branch: "task-b" };
    await nextTick();
    modals.openFilePreview("docs/guide.md", undefined, false);
    expect(modals.currentPreviewMarkdownMode.value).toBe("raw");

    wrapper.unmount();
  });

  it("keeps the latest Markdown mode when saves resolve out of order", async () => {
    const rawSave = deferred();
    const renderedSave = deferred();
    const bothSavesCompleted = deferred();
    let wrapper: ReturnType<typeof mountMarkdownModalHarness>["wrapper"] | undefined;

    try {
      const harness = mountMarkdownModalHarness();
      wrapper = harness.wrapper;
      let activeSaves = 0;
      let maximumConcurrentSaves = 0;
      const completionOrder: MarkdownPreviewMode[] = [];

      function simulateSave(completion: ReturnType<typeof deferred>) {
        return async (_key: string, value: string) => {
          activeSaves += 1;
          maximumConcurrentSaves = Math.max(maximumConcurrentSaves, activeSaves);
          await completion.promise;
          harness.store.markdownPreviewMode = value as MarkdownPreviewMode;
          completionOrder.push(value as MarkdownPreviewMode);
          activeSaves -= 1;
          if (completionOrder.length === 2) bothSavesCompleted.resolve();
        };
      }

      harness.savePreference
        .mockImplementationOnce(simulateSave(rawSave))
        .mockImplementationOnce(simulateSave(renderedSave));

      harness.modals.updateCurrentPreviewMarkdownMode("raw");
      harness.modals.updateCurrentPreviewMarkdownMode("rendered");
      expect(harness.store.markdownPreviewMode).toBe("rendered");

      renderedSave.resolve();
      rawSave.resolve();
      await bothSavesCompleted.promise;

      expect(harness.savePreference.mock.calls.map(([, value]) => value)).toEqual([
        "raw",
        "rendered",
      ]);
      expect(harness.store.markdownPreviewMode).toBe("rendered");
      expect(maximumConcurrentSaves).toBe(1);
      expect(completionOrder).toEqual(["raw", "rendered"]);
    } finally {
      wrapper?.unmount();
    }
  });

  it("keeps the latest choice and continues when earlier persistence fails", async () => {
    const persistenceError = new Error("settings unavailable");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let wrapper: ReturnType<typeof mountMarkdownModalHarness>["wrapper"] | undefined;

    try {
      const harness = mountMarkdownModalHarness();
      wrapper = harness.wrapper;
      harness.savePreference
        .mockRejectedValueOnce(persistenceError)
        .mockImplementationOnce(async (_key, value) => {
          harness.store.markdownPreviewMode = value as MarkdownPreviewMode;
        });

      harness.modals.updateCurrentPreviewMarkdownMode("raw");
      harness.modals.updateCurrentPreviewMarkdownMode("rendered");

      await vi.waitFor(() => {
        expect(harness.savePreference).toHaveBeenCalledTimes(2);
      });
      await nextTick();

      expect(harness.savePreference.mock.calls.map(([, value]) => value)).toEqual([
        "raw",
        "rendered",
      ]);
      expect(harness.store.markdownPreviewMode).toBe("rendered");
      expect(errorSpy).toHaveBeenCalledWith(
        "[App] failed to persist Markdown preview mode:",
        persistenceError,
      );
    } finally {
      errorSpy.mockRestore();
      wrapper?.unmount();
    }
  });

  it("opens a remote image URL as its own tab", () => {
    const harness = mountMarkdownModalHarness();

    harness.modals.openImageUrlPreview("https://example.invalid/shot.png");

    const tab = harness.mainTabs.activeTab.value;
    expect(tab?.kind).toBe("image");
    expect(tab?.imageUrl).toBe("https://example.invalid/shot.png");

    harness.mainTabs.closeTab(tab!.id);
    expect(harness.mainTabs.tabs.value.some((entry) => entry.kind === "image")).toBe(false);

    harness.wrapper.unmount();
  });
});
