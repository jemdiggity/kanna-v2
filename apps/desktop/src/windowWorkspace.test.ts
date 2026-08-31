import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyWindowWorkspaceMutation,
  createWindowWorkspace,
  normalizeWindowGeometry,
  normalizeTearOffWindowGeometry,
  removeWindowFromWorkspaceSnapshot,
  parseWindowBootstrap,
  reconcileWorkspaceSnapshot,
  resolveRestorableWindowGeometry,
  resolveWindowBootstrap,
  WINDOW_WORKSPACE_SETTINGS_KEY,
  type WorkspaceSnapshot,
} from "./windowWorkspace";
import { updateDesktopServerClientHandlersForTests } from "./services/desktopServerClient";

const settingStore = vi.hoisted(() => new Map<string, string>());

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

vi.mock("@kanna/" + "db", () => ({
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
      mutateWindowWorkspace: async (mutation) => {
        const current = JSON.parse(
          settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? '{"windows":[]}',
        ) as WorkspaceSnapshot;
        const next = applyWindowWorkspaceMutation(current, mutation);
        settingStore.set(WINDOW_WORKSPACE_SETTINGS_KEY, JSON.stringify(next));
        return next;
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

  it("normalizes only usable finite window geometry", () => {
    expect(normalizeWindowGeometry({ x: 120.4, y: -90.6, width: 980.2, height: 720.8 })).toEqual({
      x: 120,
      y: -91,
      width: 980,
      height: 721,
    });
    expect(normalizeWindowGeometry({ x: Number.NaN, y: 90, width: 980, height: 720 })).toBeNull();
    expect(normalizeWindowGeometry({ x: 120, y: 90, width: 799, height: 720 })).toBeNull();
    expect(normalizeWindowGeometry({ x: 120, y: 90, width: 980, height: 599 })).toBeNull();
  });

  it("keeps modal-sized geometry only for a tear-off workspace row", () => {
    const geometry = { x: 120, y: 90, width: 780, height: 480 };
    expect(normalizeWindowGeometry(geometry)).toBeNull();
    expect(normalizeTearOffWindowGeometry(geometry)).toEqual(geometry);
    expect(normalizeTearOffWindowGeometry({ ...geometry, width: 419 })).toBeNull();
    expect(normalizeTearOffWindowGeometry({ ...geometry, height: 279 })).toBeNull();
  });

  it("clears transferred-modal state while keeping the normal selected workspace", () => {
    const context = {
      surface: "tree" as const,
      worktreePath: "/repo/worktree",
      repoRoot: "/repo",
    };
    const snapshot: WorkspaceSnapshot = {
      windows: [{
        windowId: "tear-off-1",
        selectedRepoId: "repo-old",
        selectedItemId: "task-old",
        sidebarHidden: false,
        sidebarWidth: 260,
        order: 0,
        geometry: { x: 120, y: 90, width: 780, height: 480 },
        tearOffContext: context,
      }],
    };

    expect(applyWindowWorkspaceMutation(snapshot, {
      operation: "clearTearOff",
      windowId: "tear-off-1",
      selectedRepoId: "repo-1",
      selectedItemId: "task-1",
    })).toEqual({
      windows: [{
        windowId: "tear-off-1",
        selectedRepoId: "repo-1",
        selectedItemId: "task-1",
        sidebarHidden: false,
        sidebarWidth: 260,
        order: 0,
        geometry: null,
      }],
    });
  });

  it("parses a persisted tear-off bootstrap from the window URL", () => {
    const context = {
      surface: "tree" as const,
      worktreePath: "/repo/worktree",
      repoRoot: "/repo",
    };
    const params = new URLSearchParams({
      windowId: "tear-off-1",
      tearOff: JSON.stringify(context),
    });
    expect(parseWindowBootstrap(`?${params.toString()}`)).toEqual({
      windowId: "tear-off-1",
      selectedRepoId: null,
      selectedItemId: null,
      tearOffContext: context,
    });
  });

  it("loads legacy workspace rows without geometry as a defaultable null value", async () => {
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [{
          windowId: "main",
          selectedRepoId: "repo-1",
          selectedItemId: "task-1",
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

    await expect(workspace.loadSnapshot({ authoritative: true })).resolves.toEqual({
      windows: [{
        windowId: "main",
        selectedRepoId: "repo-1",
        selectedItemId: "task-1",
        order: 0,
        sidebarHidden: false,
        sidebarWidth: 260,
        geometry: null,
      }],
    });
  });

  it("updates geometry only for an existing workspace window", () => {
    const snapshot: WorkspaceSnapshot = {
      windows: [{
        windowId: "main",
        selectedRepoId: null,
        selectedItemId: null,
        order: 0,
        sidebarHidden: false,
        sidebarWidth: 260,
        geometry: null,
      }],
    };

    const updated = applyWindowWorkspaceMutation(snapshot, {
      operation: "updateGeometry",
      windowId: "main",
      geometry: { x: 120, y: 90, width: 980, height: 720 },
    });
    expect(updated.windows[0]?.geometry).toEqual({ x: 120, y: 90, width: 980, height: 720 });

    expect(applyWindowWorkspaceMutation(updated, {
      operation: "updateGeometry",
      windowId: "missing",
      geometry: { x: 0, y: 0, width: 1200, height: 800 },
    })).toEqual(updated);
  });

  it("keeps saved geometry that intersects an available monitor", () => {
    const geometry = { x: 120, y: 90, width: 980, height: 720 };
    const monitors = [{
      workArea: {
        position: { x: 0, y: 25 },
        size: { width: 1512, height: 957 },
      },
    }];

    expect(resolveRestorableWindowGeometry(geometry, monitors)).toEqual(geometry);
  });

  it("moves fully off-screen geometry into the primary work area", () => {
    const monitors = [{
      workArea: {
        position: { x: 0, y: 25 },
        size: { width: 1512, height: 957 },
      },
    }];

    expect(resolveRestorableWindowGeometry(
      { x: 4000, y: 200, width: 1800, height: 1200 },
      monitors,
    )).toEqual({
      x: 0,
      y: 25,
      width: 1512,
      height: 957,
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

  it("keeps authoritative snapshots empty instead of synthesizing the current window", async () => {
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });

    await expect(workspace.loadSnapshot()).resolves.toEqual({
      windows: [{
        windowId: "main",
        selectedRepoId: null,
        selectedItemId: null,
        order: 0,
        sidebarHidden: false,
        sidebarWidth: 260,
      }],
    });
    await expect(
      workspace.loadSnapshot({ authoritative: true }),
    ).resolves.toEqual({ windows: [] });
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

  it("serializes workspace mutations so an older selection cannot overwrite a newer one", async () => {
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [{
          windowId: "main",
          selectedRepoId: "repo-1",
          selectedItemId: "task-initial",
          order: 0,
          sidebarHidden: false,
          sidebarWidth: 260,
        }],
      } satisfies WorkspaceSnapshot),
    );
    const firstWriteStarted = createDeferred<void>();
    const releaseFirstWrite = createDeferred<void>();
    let mutationCount = 0;
    updateDesktopServerClientHandlersForTests({
      getSetting: async (key) => settingStore.get(key) ?? null,
      mutateWindowWorkspace: async (mutation) => {
        mutationCount += 1;
        if (mutationCount === 1) {
          firstWriteStarted.resolve();
          await releaseFirstWrite.promise;
        }
        const current = JSON.parse(
          settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? '{"windows":[]}',
        ) as WorkspaceSnapshot;
        const next = applyWindowWorkspaceMutation(current, mutation);
        settingStore.set(WINDOW_WORKSPACE_SETTINGS_KEY, JSON.stringify(next));
        return next;
      },
    });
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: {
        windowId: "main",
        selectedRepoId: null,
        selectedItemId: null,
      },
    });

    const olderWrite = workspace.persistSelection({
      selectedRepoId: "repo-1",
      selectedItemId: null,
    });
    await firstWriteStarted.promise;
    const newerWrite = workspace.persistSelection({
      selectedRepoId: "repo-1",
      selectedItemId: "task-durable",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mutationCount).toBe(1);

    releaseFirstWrite.resolve();
    await Promise.all([olderWrite, newerWrite]);
    const saved = JSON.parse(settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? "") as WorkspaceSnapshot;
    expect(saved.windows[0]).toMatchObject({
      selectedRepoId: "repo-1",
      selectedItemId: "task-durable",
    });
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

  it("notifies peer windows when the current window leaves the workspace", async () => {
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
            selectedRepoId: null,
            selectedItemId: null,
            order: 1,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
        ],
      } satisfies WorkspaceSnapshot),
    );
    const main = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });
    const secondary = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "win-2", selectedRepoId: null, selectedItemId: null },
    });
    const handler = vi.fn();
    const unlisten = await main.onSharedInvalidation(handler);

    await secondary.closeWindow();

    expect(handler).toHaveBeenCalledWith({
      reason: "windowMembership",
      sourceWindowId: "win-2",
    });
    unlisten();
  });

  it("returns the exact removed row for failed-close recovery", async () => {
    const savedWindow = {
      windowId: "main",
      selectedRepoId: "repo-current",
      selectedItemId: "task-current",
      order: 0,
      sidebarHidden: true,
      sidebarWidth: 347,
      geometry: null,
    };
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({ windows: [savedWindow] } satisfies WorkspaceSnapshot),
    );
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });

    await expect(workspace.forgetCurrentWindow()).resolves.toEqual(savedWindow);
  });

  it("restores a failed closer behind the successor that acquired ownership", () => {
    const mutation = {
      operation: "restore",
      window: {
        windowId: "main",
        selectedRepoId: "repo-current",
        selectedItemId: "task-current",
        order: 0,
        sidebarHidden: true,
        sidebarWidth: 347,
      },
    } as const;
    const restored = applyWindowWorkspaceMutation(
      {
        windows: [
          {
            windowId: "window-2",
            selectedRepoId: "repo-2",
            selectedItemId: "task-2",
            order: 0,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
        ],
      },
      mutation,
    );

    expect(restored.windows).toEqual([
      {
        windowId: "window-2",
        selectedRepoId: "repo-2",
        selectedItemId: "task-2",
        order: 0,
        sidebarHidden: false,
        sidebarWidth: 260,
      },
      {
        windowId: "main",
        selectedRepoId: "repo-current",
        selectedItemId: "task-current",
        order: 1,
        sidebarHidden: true,
        sidebarWidth: 347,
      },
    ]);
    expect(applyWindowWorkspaceMutation(restored, mutation)).toEqual(restored);
  });

  it("captures pending selection persistence before an ambiguous removal", async () => {
    const selectionStarted = createDeferred<void>();
    const releaseSelection = createDeferred<void>();
    const removalError = new Error("remove response lost");
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [{
          windowId: "main",
          selectedRepoId: "repo-old",
          selectedItemId: "task-old",
          order: 0,
          sidebarHidden: false,
          sidebarWidth: 260,
        }],
      } satisfies WorkspaceSnapshot),
    );
    updateDesktopServerClientHandlersForTests({
      mutateWindowWorkspace: async (mutation) => {
        if (mutation.operation === "updateSelection") {
          selectionStarted.resolve();
          await releaseSelection.promise;
        }
        const current = JSON.parse(
          settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? '{"windows":[]}',
        ) as WorkspaceSnapshot;
        const next = applyWindowWorkspaceMutation(current, mutation);
        settingStore.set(WINDOW_WORKSPACE_SETTINGS_KEY, JSON.stringify(next));
        if (mutation.operation === "remove") throw removalError;
        return next;
      },
    });
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });

    const persistence = workspace.persistSelection({
      selectedRepoId: "repo-current",
      selectedItemId: "task-current",
    });
    await selectionStarted.promise;
    const removal = workspace.forgetCurrentWindow();
    releaseSelection.resolve();
    await persistence;

    await expect(removal).rejects.toMatchObject({
      cause: removalError,
      removedWindow: {
        windowId: "main",
        selectedRepoId: "repo-current",
        selectedItemId: "task-current",
        order: 0,
        sidebarHidden: false,
        sidebarWidth: 260,
      },
    });
  });

  it("compensates an ambiguous removal response without retaking ownership", async () => {
    const removalError = new Error("remove response lost");
    const savedWindow = {
      windowId: "main",
      selectedRepoId: "repo-current",
      selectedItemId: "task-current",
      order: 0,
      sidebarHidden: true,
      sidebarWidth: 347,
    };
    settingStore.set(
      WINDOW_WORKSPACE_SETTINGS_KEY,
      JSON.stringify({
        windows: [
          savedWindow,
          {
            windowId: "window-2",
            selectedRepoId: "repo-2",
            selectedItemId: "task-2",
            order: 1,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
        ],
      } satisfies WorkspaceSnapshot),
    );
    updateDesktopServerClientHandlersForTests({
      mutateWindowWorkspace: async (mutation) => {
        const current = JSON.parse(
          settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? '{"windows":[]}',
        ) as WorkspaceSnapshot;
        const next = applyWindowWorkspaceMutation(current, mutation);
        settingStore.set(WINDOW_WORKSPACE_SETTINGS_KEY, JSON.stringify(next));
        if (mutation.operation === "remove") throw removalError;
        return next;
      },
    });
    const workspace = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });

    await expect(workspace.forgetCurrentWindow()).rejects.toMatchObject({
      cause: removalError,
      removedWindow: savedWindow,
    });

    const saved = JSON.parse(
      settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? "",
    ) as WorkspaceSnapshot;
    expect(saved.windows).toEqual([{
      windowId: "window-2",
      selectedRepoId: "repo-2",
      selectedItemId: "task-2",
      order: 0,
      sidebarHidden: false,
      sidebarWidth: 260,
    }]);
  });

  it("does not restore a removed leader when another window saves selection", async () => {
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
            selectedRepoId: null,
            selectedItemId: null,
            order: 1,
            sidebarHidden: false,
            sidebarWidth: 260,
          },
        ],
      } satisfies WorkspaceSnapshot),
    );
    const main = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "main", selectedRepoId: null, selectedItemId: null },
    });
    const secondary = createWindowWorkspace({
      db: {} as never,
      bootstrap: { windowId: "win-2", selectedRepoId: null, selectedItemId: null },
    });

    await Promise.all([
      main.forgetCurrentWindow(),
      secondary.persistSelection({
        selectedRepoId: "repo-new",
        selectedItemId: "task-new",
      }),
    ]);

    const saved = JSON.parse(
      settingStore.get(WINDOW_WORKSPACE_SETTINGS_KEY) ?? "",
    ) as WorkspaceSnapshot;
    expect(saved.windows).toEqual([{
      windowId: "win-2",
      selectedRepoId: "repo-new",
      selectedItemId: "task-new",
      order: 0,
      sidebarHidden: false,
      sidebarWidth: 260,
    }]);
  });
});
