import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyWindowWorkspaceMutation,
  createWindowWorkspace,
  WINDOW_WORKSPACE_SETTINGS_KEY,
  type WorkspaceSnapshot,
} from "./windowWorkspace";
import { updateDesktopServerClientHandlersForTests } from "./services/desktopServerClient";

const settingStore = vi.hoisted(() => new Map<string, string>());
const closeMock = vi.hoisted(() => vi.fn(async () => {}));
const destroyMock = vi.hoisted(() => vi.fn(async () => {}));
const emitMock = vi.hoisted(() => vi.fn(async () => {}));
const openWebviewLabels = vi.hoisted(() => ["main"]);
const ensuredWindowWasLive = vi.hoisted(() => [] as boolean[]);
const webviewCreatedHarness = vi.hoisted(() => ({
  handler: null as null | ((label: string) => Promise<void>),
}));
const disposeCompanionBridgesMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./tauri-mock", () => ({
  isTauri: true,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: closeMock,
    destroy: destroyMock,
  }),
}));

vi.mock("./services/desktopCompanionBridge", () => ({
  disposeDesktopCompanionBridgeManager: disposeCompanionBridgesMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: emitMock,
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: vi.fn(async () =>
    openWebviewLabels.map((label) => ({ label })),
  ),
  WebviewWindow: class {
    label: string;

    constructor(label: string) {
      this.label = label;
      openWebviewLabels.push(label);
    }

    async once(event: string, handler: (event: { payload: unknown }) => void) {
      if (event === "tauri://created") {
        queueMicrotask(() => {
          void (async () => {
            await webviewCreatedHarness.handler?.(this.label);
            handler({ payload: null });
          })();
        });
      }
      return () => {};
    }
  },
}));

vi.mock("@kanna/" + "db", () => ({
  getSetting: vi.fn(async (_db, key: string) => settingStore.get(key) ?? null),
  setSetting: vi.fn(async (_db, key: string, value: string) => {
    settingStore.set(key, value);
  }),
}));

describe("windowWorkspace in Tauri", () => {
  beforeEach(() => {
    settingStore.clear();
    updateDesktopServerClientHandlersForTests({
      getSetting: async (key) => settingStore.get(key) ?? null,
      putSetting: async (key, value) => {
        settingStore.set(key, value);
        return { key, value };
      },
      mutateWindowWorkspace: async (mutation) => {
        if (mutation.operation === "ensure" && mutation.window.windowId !== "main") {
          ensuredWindowWasLive.push(
            openWebviewLabels.includes(`window-${mutation.window.windowId}`),
          );
        }
        const current = JSON.parse(
          settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? '{"windows":[]}',
        ) as WorkspaceSnapshot;
        const next = applyWindowWorkspaceMutation(current, mutation);
        settingStore.set(WINDOW_WORKSPACE_SETTINGS_KEY, JSON.stringify(next));
        return next;
      },
    });
    openWebviewLabels.splice(0, openWebviewLabels.length, "main");
    closeMock.mockClear();
    destroyMock.mockClear();
    disposeCompanionBridgesMock.mockReset();
    disposeCompanionBridgesMock.mockResolvedValue(undefined);
    emitMock.mockReset();
    emitMock.mockResolvedValue(undefined);
    ensuredWindowWasLive.splice(0);
    webviewCreatedHarness.handler = null;
  });

  it("destroys the native window only after its membership is removed", async () => {
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [
          {
            windowId: "main",
            selectedRepoId: "repo-1",
            selectedItemId: "task-1",
            order: 0,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
        ],
      } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: {
        windowId: "main",
        selectedRepoId: null,
        selectedItemId: null,
      },
    });

    await workspace.closeWindow();

    expect(closeMock).not.toHaveBeenCalled();
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      "kanna://window-workspace-invalidated",
      { reason: "windowMembership", sourceWindowId: "main" },
    );
  });

  it("exposes a native-destroy-only finalization path after membership is removed", async () => {
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: {
        windowId: "main",
        selectedRepoId: null,
        selectedItemId: null,
      },
    });

    await workspace.destroyNativeWindow();

    expect(disposeCompanionBridgesMock).toHaveBeenCalledTimes(1);
    expect(closeMock).not.toHaveBeenCalled();
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("waits for companion lease cleanup before destroying the native window", async () => {
    let finishCleanup!: () => void;
    disposeCompanionBridgesMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: {
        windowId: "main",
        selectedRepoId: null,
        selectedItemId: null,
      },
    });

    const destroying = workspace.destroyNativeWindow();
    await Promise.resolve();
    expect(destroyMock).not.toHaveBeenCalled();

    finishCleanup();
    await destroying;
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a committed removal result distinct from notification failure", async () => {
    const savedWindow = {
      windowId: "main",
      selectedRepoId: "repo-1",
      selectedItemId: "task-1",
      order: 0,
      sidebarHidden: true,
      sidebarWidth: 347,
    };
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({ windows: [savedWindow] } satisfies WorkspaceSnapshot),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });

    await expect(workspace.forgetCurrentWindow()).resolves.toEqual(savedWindow);
    emitMock.mockRejectedValueOnce(new Error("notification failed"));
    await expect(workspace.notifyWindowMembershipChanged()).rejects.toThrow(
      "notification failed",
    );

    expect(JSON.parse(
      settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? "",
    )).toEqual({ windows: [] });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("keeps a committed restoration distinct from notification failure", async () => {
    const savedWindow = {
      windowId: "main",
      selectedRepoId: "repo-1",
      selectedItemId: "task-1",
      order: 0,
      sidebarHidden: true,
      sidebarWidth: 347,
    };
    const successorWindow = {
      windowId: "window-2",
      selectedRepoId: "repo-2",
      selectedItemId: "task-2",
      order: 0,
      sidebarHidden: false,
      sidebarWidth: 260,
    };
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({ windows: [successorWindow] } satisfies WorkspaceSnapshot),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });

    await expect(workspace.restoreCurrentWindow(savedWindow)).resolves.toBeUndefined();
    emitMock.mockRejectedValueOnce(new Error("notification failed"));
    await expect(workspace.notifyWindowMembershipChanged()).rejects.toThrow(
      "notification failed",
    );

    expect(JSON.parse(
      settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? "",
    )).toEqual({
      windows: [successorWindow, { ...savedWindow, order: 1 }],
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("prunes stale saved windows when the last live window closes", async () => {
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [
          {
            windowId: "main",
            selectedRepoId: "repo-1",
            selectedItemId: "task-1",
            order: 0,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
          {
            windowId: "win-2",
            selectedRepoId: "repo-1",
            selectedItemId: "task-2",
            order: 1,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
        ],
      } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: {
        windowId: "main",
        selectedRepoId: null,
        selectedItemId: null,
      },
    });

    await workspace.closeWindow();

    const saved = JSON.parse(settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? "") as WorkspaceSnapshot;
    expect(saved).toEqual({ windows: [] });
  });

  it("keeps other live windows when the current window closes", async () => {
    openWebviewLabels.splice(0, openWebviewLabels.length, "main", "window-win-2");
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [
          {
            windowId: "main",
            selectedRepoId: "repo-1",
            selectedItemId: "task-1",
            order: 0,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
          {
            windowId: "win-2",
            selectedRepoId: "repo-1",
            selectedItemId: "task-2",
            order: 1,
            sidebarHidden: true,
            sidebarWidth: 320,
          },
        ],
      } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: {
        windowId: "main",
        selectedRepoId: null,
        selectedItemId: null,
      },
    });

    await workspace.closeWindow();

    const saved = JSON.parse(settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? "") as WorkspaceSnapshot;
    expect(saved).toEqual({
      windows: [
        {
          windowId: "win-2",
          selectedRepoId: "repo-1",
          selectedItemId: "task-2",
          order: 0,
          sidebarHidden: true,
          sidebarWidth: 320,
        },
      ],
    });
  });

  it("lets the created webview register its own live membership", async () => {
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [{
          windowId: "main",
          selectedRepoId: null,
          selectedItemId: null,
          order: 0,
          sidebarHidden: false,
          sidebarWidth: 260,
        }],
      } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });
    webviewCreatedHarness.handler = async (label) => {
      const windowId = label.slice("window-".length);
      const child = createWindowWorkspace({
        db: {} as never,
        bootstrap: { windowId, selectedRepoId: "repo-1", selectedItemId: "task-1" },
      });
      await child.initialize();
    };

    await workspace.openWindow({ selectedRepoId: "repo-1", selectedItemId: "task-1" });

    expect(ensuredWindowWasLive).toEqual([true]);
  });

  it("does not resurrect a child that closes before the opener observes creation", async () => {
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [{
          windowId: "main",
          selectedRepoId: null,
          selectedItemId: null,
          order: 0,
          sidebarHidden: false,
          sidebarWidth: 260,
        }],
      } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });
    let childWindowId = "";
    webviewCreatedHarness.handler = async (label) => {
      childWindowId = label.slice("window-".length);
      const child = createWindowWorkspace({
        db: {} as never,
        bootstrap: {
          windowId: childWindowId,
          selectedRepoId: "repo-1",
          selectedItemId: "task-1",
        },
      });
      await child.initialize();
      await child.forgetCurrentWindow();
    };

    await workspace.openWindow({ selectedRepoId: "repo-1", selectedItemId: "task-1" });

    const saved = JSON.parse(
      settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? "",
    ) as WorkspaceSnapshot;
    expect(saved.windows.some((entry) => entry.windowId === childWindowId)).toBe(false);
  });
});
