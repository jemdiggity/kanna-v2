// @vitest-environment happy-dom

import { defineComponent, h, nextTick, reactive } from "vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { MarkdownPreviewMode } from "../stores/markdownPreviewMode";
import type { ModalTearOffContext } from "../modalTearOff";
import { useAppModals } from "./useAppModals";

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
} = {}) {
  const savePreference = vi.fn(
    options.savePreference ?? (async () => {}),
  );
  const store = reactive({
    repos: [],
    selectedRepo: { id: "repo-1", path: "/repo" },
    currentItem: { id: "task-a", branch: "task-a" },
    markdownPreviewMode: options.markdownPreviewMode ?? "rendered",
    savePreference,
  });
  const clearTearOffContext = vi.fn(async () => {});
  const TestHarness = defineComponent({
    setup() {
      const modals = useAppModals({
        isMobile: false,
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
      });
      return { modals };
    },
    render() {
      return h("div");
    },
  });
  const wrapper = mount(TestHarness);
  return { clearTearOffContext, modals: wrapper.vm.modals, savePreference, store, wrapper };
}

describe("useAppModals", () => {
  it("restores a transferred tree as a normal maximized modal and clears only its transfer state", async () => {
    const harness = mountMarkdownModalHarness({
      tearOffContext: {
        surface: "tree",
        worktreePath: "/repo/.kanna-worktrees/task-a",
        repoRoot: "/repo",
      },
    });

    harness.modals.restoreTransferredModal();
    expect(harness.modals.showTreeExplorer.value).toBe(true);
    expect(harness.modals.maximizedModal.value).toBe("tree");
    expect(harness.modals.treeExplorerRoot.value).toBe("/repo/.kanna-worktrees/task-a");

    harness.modals.closeTreeExplorer();
    expect(harness.modals.showTreeExplorer.value).toBe(false);
    expect(harness.modals.maximizedModal.value).toBe(null);
    expect(harness.clearTearOffContext).toHaveBeenCalledOnce();
    await nextTick();
    harness.wrapper.unmount();
  });

  it("restores transferred diff view state in the ordinary maximized modal", () => {
    const harness = mountMarkdownModalHarness({
      tearOffContext: {
        surface: "diff",
        repoPath: "/repo",
        viewKey: "item:task-a",
        initialScope: "working",
        initialScrollPositions: { working: 240 },
        initialBranchInclude: "all",
      },
    });

    harness.modals.restoreTransferredModal();
    expect(harness.modals.showDiffModal.value).toBe(true);
    expect(harness.modals.maximizedModal.value).toBe("diff");
    expect(harness.modals.currentDiffViewState.value).toMatchObject({
      scope: "working",
      scrollPositions: { working: 240 },
      branchInclude: "all",
    });

    harness.modals.closeDiffModal();
    expect(harness.clearTearOffContext).toHaveBeenCalledOnce();
    harness.wrapper.unmount();
  });

  it("rechecks agent CLIs when the setup shell closes", () => {
    const { modals, wrapper } = mountMarkdownModalHarness();
    const recheckClis = vi.fn(async () => {});
    modals.mainPanelRef.value = {
      recheckClis,
    } as unknown as NonNullable<typeof modals.mainPanelRef.value>;
    modals.showShellModal.value = true;
    modals.maximizedModal.value = "shell";

    modals.onShellClose();

    expect(modals.showShellModal.value).toBe(false);
    expect(modals.maximizedModal.value).toBe(null);
    expect(recheckClis).toHaveBeenCalledOnce();
    wrapper.unmount();
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

  it("opens and closes remote image URL previews", async () => {
    const TestHarness = defineComponent({
      setup() {
        const modals = useAppModals({
          isMobile: false,
          store: {} as Parameters<typeof useAppModals>[0]["store"],
          windowWorkspace: {
            bootstrap: { windowId: "main" },
            loadSnapshot: vi.fn(),
            persistSidebarWidth: vi.fn(),
          } as unknown as Parameters<typeof useAppModals>[0]["windowWorkspace"],
        });
        return { modals };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);

    wrapper.vm.modals.openImageUrlPreview("https://example.com/screenshot.png");
    expect(wrapper.vm.modals.showImageUrlPreviewModal.value).toBe(true);
    expect(wrapper.vm.modals.previewImageUrl.value).toBe("https://example.com/screenshot.png");

    wrapper.vm.modals.closeImageUrlPreview();
    expect(wrapper.vm.modals.showImageUrlPreviewModal.value).toBe(false);
  });
});
