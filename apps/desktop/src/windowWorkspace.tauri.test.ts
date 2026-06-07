import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWindowWorkspace,
  WINDOW_WORKSPACE_SETTINGS_KEY,
  type WorkspaceSnapshot,
} from "./windowWorkspace";

const settingStore = vi.hoisted(() => new Map<string, string>());
const closeMock = vi.hoisted(() => vi.fn(async () => {}));
const destroyMock = vi.hoisted(() => vi.fn(async () => {}));
const openWebviewLabels = vi.hoisted(() => ["main"]);

vi.mock("./tauri-mock", () => ({
  isTauri: true,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: closeMock,
    destroy: destroyMock,
  }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: vi.fn(async () =>
    openWebviewLabels.map((label) => ({ label })),
  ),
}));

vi.mock("@kanna/db", () => ({
  getSetting: vi.fn(async (_db, key: string) => settingStore.get(key) ?? null),
  setSetting: vi.fn(async (_db, key: string, value: string) => {
    settingStore.set(key, value);
  }),
}));

describe("windowWorkspace in Tauri", () => {
  beforeEach(() => {
    settingStore.clear();
    openWebviewLabels.splice(0, openWebviewLabels.length, "main");
    closeMock.mockClear();
    destroyMock.mockClear();
  });

  it("requests a normal native close instead of directly destroying the webview", async () => {
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

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).not.toHaveBeenCalled();
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
});
