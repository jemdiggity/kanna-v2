import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWindowWorkspace,
  WINDOW_WORKSPACE_SETTINGS_KEY,
  type WorkspaceSnapshot,
} from "./windowWorkspace";

const settingStore = vi.hoisted(() => new Map<string, string>());
const closeMock = vi.hoisted(() => vi.fn(async () => {}));
const destroyMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./tauri-mock", () => ({
  isTauri: true,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: closeMock,
    destroy: destroyMock,
  }),
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
});
