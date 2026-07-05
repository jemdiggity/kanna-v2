import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWindowWorkspace,
  removeWindowFromWorkspaceSnapshot,
  parseWindowBootstrap,
  reconcileWorkspaceSnapshot,
  resolveWindowBootstrap,
  WINDOW_WORKSPACE_SETTINGS_KEY,
  type WorkspaceSnapshot,
} from "./windowWorkspace";
import { updateDesktopServerClientHandlersForTests } from "./services/desktopServerClient";

const settingStore = vi.hoisted(() => new Map<string, string>());

vi.mock("@kanna/db", () => ({
  getSetting: vi.fn(async (_db, key: string) => settingStore.get(key) ?? null),
  setSetting: vi.fn(async (_db, key: string, value: string) => {
    settingStore.set(key, value);
  }),
}));

describe("windowWorkspace", () => {
  beforeEach(() => {
    settingStore.clear();
    updateDesktopServerClientHandlersForTests({
      getSetting: async (key) => settingStore.get(key) ?? null,
      putSetting: async (key, value) => {
        settingStore.set(key, value);
        return { key, value };
      },
    });
    vi.spyOn(window, "close").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses bootstrap selection from the query string", () => {
    expect(
      parseWindowBootstrap("?windowId=win-2&selectedRepoId=repo-1&selectedItemId=task-9"),
    ).toEqual({
      windowId: "win-2",
      selectedRepoId: "repo-1",
      selectedItemId: "task-9",
    });
  });

  it("adds a missing window record without disturbing saved order", () => {
    const snapshot: WorkspaceSnapshot = {
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
    };

    expect(reconcileWorkspaceSnapshot(snapshot, "win-2")).toEqual({
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
          selectedRepoId: null,
          selectedItemId: null,
          order: 1,
          sidebarHidden: false,
          sidebarWidth: 260,
        },
      ],
    });
  });

  it("preserves valid sidebar widths and defaults invalid widths", () => {
    const snapshot = reconcileWorkspaceSnapshot(
      {
        windows: [
          {
            windowId: "main",
            selectedRepoId: "repo-1",
            selectedItemId: null,
            order: 1,
            sidebarHidden: false,
            sidebarWidth: 360,
          },
          {
            windowId: "win-2",
            selectedRepoId: "repo-2",
            selectedItemId: null,
            order: 0,
            sidebarHidden: false,
            sidebarWidth: 999,
          },
        ],
      },
      "main",
    );

    expect(snapshot.windows).toEqual([
      {
        windowId: "win-2",
        selectedRepoId: "repo-2",
        selectedItemId: null,
        order: 0,
        sidebarHidden: false,
        sidebarWidth: 260,
      },
      {
        windowId: "main",
        selectedRepoId: "repo-1",
        selectedItemId: null,
        order: 1,
        sidebarHidden: false,
        sidebarWidth: 360,
      },
    ]);
  });

  it("hydrates the main window selection from the saved workspace snapshot", async () => {
    const db = {
      execute: async () => ({ rowsAffected: 1 }),
      select: async () => [],
    };

    const bootstrap = await resolveWindowBootstrap(
      db as never,
      {
        windowId: "main",
        selectedRepoId: null,
        selectedItemId: null,
      },
      {
        windows: [
          {
            windowId: "main",
            selectedRepoId: "repo-1",
            selectedItemId: "task-2",
            order: 0,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
        ],
      },
    );

    expect(bootstrap).toEqual({
      windowId: "main",
      selectedRepoId: "repo-1",
      selectedItemId: "task-2",
    });
  });

  it("removes a closed window and renormalizes the remaining order", () => {
    const snapshot: WorkspaceSnapshot = {
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
          sidebarWidth: 260,
        },
        {
          windowId: "win-3",
          selectedRepoId: "repo-2",
          selectedItemId: null,
          order: 2,
          sidebarHidden: false,
          sidebarWidth: 260,
        },
      ],
    };

    expect(removeWindowFromWorkspaceSnapshot(snapshot, "win-2")).toEqual({
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
          windowId: "win-3",
          selectedRepoId: "repo-2",
          selectedItemId: null,
          order: 1,
          sidebarHidden: false,
          sidebarWidth: 260,
        },
      ],
    });
  });

  it("persists sidebar width for the current window", async () => {
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
            selectedRepoId: "repo-2",
            selectedItemId: "task-2",
            order: 1,
            sidebarHidden: false,
            sidebarWidth: 280,
          },
        ],
      } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: {
        windowId: "win-2",
        selectedRepoId: null,
        selectedItemId: null,
      },
    });

    await workspace.persistSidebarWidth(320);

    const saved = JSON.parse(settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? "") as WorkspaceSnapshot;
    expect(saved.windows).toEqual([
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
        selectedRepoId: "repo-2",
        selectedItemId: "task-2",
        order: 1,
        sidebarHidden: false,
        sidebarWidth: 320,
      },
    ]);
  });

  it("persists removal of the current window when closing", async () => {
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
            sidebarWidth: 260,
          },
        ],
      } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: {
        windowId: "win-2",
        selectedRepoId: null,
        selectedItemId: null,
      },
    });

    await workspace.closeWindow();

    const saved = JSON.parse(settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? "") as WorkspaceSnapshot;
    expect(saved).toEqual({
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
    });
  });
});
