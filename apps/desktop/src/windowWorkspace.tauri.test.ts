import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const workspaceMutations = vi.hoisted(() => [] as Array<{ operation: string; [key: string]: unknown }>);
const currentWindowHarness = vi.hoisted(() => ({
  setPosition: vi.fn(async () => {}),
  setSize: vi.fn(async () => {}),
  outerPosition: vi.fn(async () => ({ x: 200, y: 120 })),
  outerSize: vi.fn(async () => ({ width: 1000, height: 740 })),
  innerSize: vi.fn(async () => ({ width: 1000, height: 708 })),
  scaleFactor: vi.fn(async () => 1),
  movedHandler: null as null | (() => void),
  resizedHandler: null as null | (() => void),
  unlistenMoved: vi.fn(),
  unlistenResized: vi.fn(),
}));
const createdWindows = vi.hoisted(() => [] as Array<{
  label: string;
  options: Record<string, unknown>;
  setPosition: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  setFocus: ReturnType<typeof vi.fn>;
}>);

vi.mock("./tauri-mock", () => ({
  isTauri: true,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: closeMock,
    destroy: destroyMock,
    setPosition: currentWindowHarness.setPosition,
    setSize: currentWindowHarness.setSize,
    outerPosition: currentWindowHarness.outerPosition,
    outerSize: currentWindowHarness.outerSize,
    innerSize: currentWindowHarness.innerSize,
    scaleFactor: currentWindowHarness.scaleFactor,
    onMoved: vi.fn(async (handler: () => void) => {
      currentWindowHarness.movedHandler = handler;
      return currentWindowHarness.unlistenMoved;
    }),
    onResized: vi.fn(async (handler: () => void) => {
      currentWindowHarness.resizedHandler = handler;
      return currentWindowHarness.unlistenResized;
    }),
  }),
  availableMonitors: vi.fn(async () => [{
    workArea: {
      position: { x: 0, y: 25 },
      size: { width: 1512, height: 957 },
    },
  }]),
  primaryMonitor: vi.fn(async () => ({
    workArea: {
      position: { x: 0, y: 25 },
      size: { width: 1512, height: 957 },
    },
  })),
  PhysicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
  PhysicalSize: class {
    constructor(public width: number, public height: number) {}
  },
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

    options: Record<string, unknown>;
    setPosition = vi.fn(async () => {});
    setSize = vi.fn(async () => {});
    show = vi.fn(async () => {});
    setFocus = vi.fn(async () => {});
    startDragging = vi.fn(async () => {});
    innerSize = vi.fn(async () => ({ width: 780, height: 448 }));
    outerSize = vi.fn(async () => ({ width: 780, height: 480 }));

    constructor(label: string, options: Record<string, unknown> = {}) {
      this.label = label;
      this.options = options;
      openWebviewLabels.push(label);
      createdWindows.push(this);
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    settingStore.clear();
    updateDesktopServerClientHandlersForTests({
      getSetting: async (key) => settingStore.get(key) ?? null,
      putSetting: async (key, value) => {
        settingStore.set(key, value);
        return { key, value };
      },
      mutateWindowWorkspace: async (mutation) => {
        workspaceMutations.push(mutation);
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
    workspaceMutations.splice(0);
    createdWindows.splice(0);
    currentWindowHarness.setPosition.mockClear();
    currentWindowHarness.setSize.mockClear();
    currentWindowHarness.outerPosition.mockClear();
    currentWindowHarness.outerSize.mockClear();
    currentWindowHarness.innerSize.mockClear();
    currentWindowHarness.scaleFactor.mockClear();
    currentWindowHarness.movedHandler = null;
    currentWindowHarness.resizedHandler = null;
    currentWindowHarness.unlistenMoved.mockClear();
    currentWindowHarness.unlistenResized.mockClear();
  });

  it("restores saved geometry for the current native window", async () => {
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
          geometry: { x: 120, y: 90, width: 980, height: 720 },
        }],
      } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });

    await workspace.restoreCurrentWindowGeometry();

    expect(currentWindowHarness.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 980, height: 720 }),
    );
    expect(currentWindowHarness.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({ x: 120, y: 90 }),
    );
  });

  it("restores a secondary window before revealing it", async () => {
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [
          {
            windowId: "main",
            selectedRepoId: null,
            selectedItemId: null,
            order: 0,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
          {
            windowId: "win-2",
            selectedRepoId: "repo-1",
            selectedItemId: "task-1",
            order: 1,
            sidebarHidden: false,
            sidebarWidth: 260,
            geometry: { x: 180, y: 110, width: 1024, height: 768 },
          },
        ],
      } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });

    await workspace.restoreAdditionalWindows();

    const restored = createdWindows[0];
    expect(restored?.options.visible).toBe(false);
    expect(restored?.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1024, height: 768 }),
    );
    expect(restored?.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({ x: 180, y: 110 }),
    );
    expect(restored?.show).toHaveBeenCalledTimes(1);
    expect(restored?.setPosition.mock.invocationCallOrder[0]).toBeLessThan(
      restored?.show.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("restores a persisted tear-off through the shared window lifecycle", async () => {
    const context = {
      surface: "diff" as const,
      repoPath: "/repo",
      worktreePath: "/repo/.kanna-worktrees/task-1",
    };
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [
          {
            windowId: "main",
            selectedRepoId: null,
            selectedItemId: null,
            order: 0,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
          {
            windowId: "tear-off-1",
            selectedRepoId: null,
            selectedItemId: null,
            order: 1,
            sidebarHidden: false,
            sidebarWidth: 260,
            geometry: { x: 240, y: 180, width: 1080, height: 614 },
            tearOffContext: context,
          },
        ],
      } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });

    await workspace.restoreAdditionalWindows();

    const restored = createdWindows[0];
    expect(restored?.options).toMatchObject({
      title: "Diff — Kanna",
      minWidth: 420,
      minHeight: 280,
      visible: false,
    });
    expect(String(restored?.options.url)).toContain("windowMode=tearOff");
    expect(restored?.show).toHaveBeenCalledTimes(1);
  });

  it("fits a tear-off native frame to its persisted content size", async () => {
    const innerWidthSpy = vi.spyOn(window, "innerWidth", "get").mockReturnValue(780);
    const innerHeightSpy = vi.spyOn(window, "innerHeight", "get").mockReturnValue(448);
    currentWindowHarness.outerSize.mockResolvedValueOnce({ width: 1560, height: 896 });
    currentWindowHarness.scaleFactor.mockResolvedValueOnce(2);
    const context = {
      surface: "tree" as const,
      worktreePath: "/repo/.kanna-worktrees/task-1",
      repoRoot: "/repo",
    };
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [{
          windowId: "tear-off-1",
          selectedRepoId: null,
          selectedItemId: null,
          order: 0,
          sidebarHidden: false,
          sidebarWidth: 260,
          geometry: { x: 480, y: 360, width: 1560, height: 960 },
          tearOffContext: context,
        }],
      } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: {
        windowId: "tear-off-1",
        selectedRepoId: null,
        selectedItemId: null,
        tearOffContext: context,
      },
    });

    await workspace.restoreCurrentWindowGeometry();
    innerWidthSpy.mockRestore();
    innerHeightSpy.mockRestore();

    expect(currentWindowHarness.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1560, height: 960 }),
    );
    expect(currentWindowHarness.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({ x: 480, y: 360 }),
    );
  });

  it("persists a tear-off context and exact modal geometry before opening it", async () => {
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });
    const context = {
      surface: "tree" as const,
      worktreePath: "/repo/.kanna-worktrees/task-1",
      repoRoot: "/repo",
    };

    await workspace.openTearOffWindow(context, {
      x: 240,
      y: 180,
      width: 780,
      height: 480,
    });

    const created = createdWindows[0];
    expect(created?.label).toMatch(/^window-/);
    expect(created?.options).toMatchObject({
      title: "task-1 — Kanna",
      width: 780,
      height: 480,
      minWidth: 420,
      minHeight: 280,
      visible: false,
    });
    expect(String(created?.options.url)).toContain("windowMode=tearOff");
    expect(created?.startDragging).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(
      settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? '{"windows":[]}',
    ) as WorkspaceSnapshot;
    expect(stored.windows).toHaveLength(1);
    expect(stored.windows[0]).toMatchObject({
      geometry: { x: 240, y: 180, width: 780, height: 480 },
      tearOffContext: context,
    });
    expect(ensuredWindowWasLive).toEqual([false]);
  });

  it("reveals a secondary window when applying its saved geometry fails", async () => {
    const geometryError = new Error("geometry restore failed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [
          {
            windowId: "main",
            selectedRepoId: null,
            selectedItemId: null,
            order: 0,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
          {
            windowId: "win-2",
            selectedRepoId: "repo-1",
            selectedItemId: "task-1",
            order: 1,
            sidebarHidden: false,
            sidebarWidth: 260,
            geometry: { x: 180, y: 110, width: 1024, height: 768 },
          },
        ],
      } satisfies WorkspaceSnapshot),
    );
    webviewCreatedHarness.handler = async (label) => {
      const restored = createdWindows.find((entry) => entry.label === label);
      restored?.setSize.mockRejectedValueOnce(geometryError);
    };
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });

    await expect(workspace.restoreAdditionalWindows()).resolves.toBeUndefined();

    const restored = createdWindows[0];
    expect(restored?.show).toHaveBeenCalledTimes(1);
    expect(restored?.setFocus).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[windowWorkspace] failed to apply saved window geometry:",
      geometryError,
    );
    warnSpy.mockRestore();
  });

  it("continues restoring saved windows after one spawn fails", async () => {
    const focusError = new Error("focus failed");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [
          {
            windowId: "main",
            selectedRepoId: null,
            selectedItemId: null,
            order: 0,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
          ...["win-2", "win-3"].map((windowId, index) => ({
            windowId,
            selectedRepoId: "repo-1",
            selectedItemId: `task-${index + 1}`,
            order: index + 1,
            sidebarHidden: false,
            sidebarWidth: 260,
            geometry: {
              x: 180 + index * 40,
              y: 110 + index * 40,
              width: 1024,
              height: 768,
            },
          })),
        ],
      } satisfies WorkspaceSnapshot),
    );
    webviewCreatedHarness.handler = async (label) => {
      if (label === "window-win-2") {
        createdWindows.find((entry) => entry.label === label)
          ?.setFocus.mockRejectedValueOnce(focusError);
      }
    };
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });

    await expect(workspace.restoreAdditionalWindows()).resolves.toBeUndefined();

    expect(createdWindows.map((entry) => entry.label)).toEqual([
      "window-win-2",
      "window-win-3",
    ]);
    expect(createdWindows[1]?.show).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[windowWorkspace] failed to restore window win-2:",
      focusError,
    );
    errorSpy.mockRestore();
  });

  it("coalesces native move and resize events into one geometry mutation", async () => {
    vi.useFakeTimers();
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
    const dispose = await workspace.startGeometryTracking();

    currentWindowHarness.movedHandler?.();
    currentWindowHarness.resizedHandler?.();
    await vi.advanceTimersByTimeAsync(150);

    expect(workspaceMutations.filter((mutation) => mutation.operation === "updateGeometry")).toEqual([{
      operation: "updateGeometry",
      windowId: "main",
      geometry: { x: 200, y: 120, width: 1000, height: 740 },
    }]);

    dispose();
    expect(currentWindowHarness.unlistenMoved).toHaveBeenCalledTimes(1);
    expect(currentWindowHarness.unlistenResized).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
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
      geometry: null,
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
