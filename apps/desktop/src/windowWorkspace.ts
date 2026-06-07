import { getSetting, setSetting, type DbHandle } from "@kanna/db";

import { emit } from "./emit";
import { listen } from "./listen";
import { isTauri } from "./tauri-mock";

export interface WindowBootstrap {
  windowId: string;
  selectedRepoId: string | null;
  selectedItemId: string | null;
}

export interface WorkspaceWindowState extends WindowBootstrap {
  sidebarHidden: boolean;
  sidebarWidth: number;
  order: number;
}

export interface WorkspaceSnapshot {
  windows: WorkspaceWindowState[];
}

export interface WindowWorkspaceController {
  bootstrap: WindowBootstrap;
  loadSnapshot: () => Promise<WorkspaceSnapshot>;
  saveSnapshot: (snapshot: WorkspaceSnapshot) => Promise<void>;
  openWindow: (selection: {
    selectedRepoId: string | null;
    selectedItemId: string | null;
  }) => Promise<void>;
  closeWindow: () => Promise<void>;
  forgetCurrentWindow: () => Promise<void>;
  persistSelection: (selection: {
    selectedRepoId: string | null;
    selectedItemId: string | null;
  }) => Promise<void>;
  persistSidebarHidden: (hidden: boolean) => Promise<void>;
  persistSidebarWidth: (width: number) => Promise<void>;
  invalidateSharedData: (reason: string) => Promise<void>;
  restoreAdditionalWindows: () => Promise<void>;
  onSharedInvalidation: (handler: (payload: { reason?: string; sourceWindowId?: string }) => void | Promise<void>) => Promise<() => void>;
}

export const WINDOW_WORKSPACE_SETTINGS_KEY = "window_workspace_v1";
export const WINDOW_WORKSPACE_INVALIDATED_EVENT = "kanna://window-workspace-invalidated";
export const WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT = "kanna://native-new-window";
export const WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT = "kanna://native-close-window";
export const WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT = "kanna://native-navigate-task-up";
export const WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT = "kanna://native-navigate-task-down";
export const WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT = "kanna://native-navigate-repo-up";
export const WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT = "kanna://native-navigate-repo-down";
export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 420;

export function normalizeSidebarWidth(width: unknown): number {
  return typeof width === "number" && Number.isFinite(width) && width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH
    ? Math.round(width)
    : DEFAULT_SIDEBAR_WIDTH;
}

export function parseWindowBootstrap(search: string): WindowBootstrap {
  const params = new URLSearchParams(search);

  return {
    windowId: params.get("windowId") ?? "main",
    selectedRepoId: params.get("selectedRepoId"),
    selectedItemId: params.get("selectedItemId"),
  };
}

export function reconcileWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
  windowId: string,
): WorkspaceSnapshot {
  const normalized = normalizeWorkspaceSnapshot(snapshot);

  if (normalized.windows.some((entry) => entry.windowId === windowId)) {
    return normalized;
  }

  return {
    windows: [
      ...normalized.windows,
      {
        windowId,
        selectedRepoId: null,
        selectedItemId: null,
        sidebarHidden: false,
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        order: snapshot.windows.length,
      },
    ],
  };
}

export function removeWindowFromWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
  windowId: string,
): WorkspaceSnapshot {
  return normalizeWorkspaceSnapshot({
    windows: snapshot.windows.filter((entry) => entry.windowId !== windowId),
  });
}

function normalizeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const ordered = [...snapshot.windows].sort((left, right) => left.order - right.order);

  return {
    windows: ordered.map((entry, index) => ({
      windowId: entry.windowId,
      selectedRepoId: entry.selectedRepoId,
      selectedItemId: entry.selectedItemId,
      sidebarHidden: entry.sidebarHidden,
      sidebarWidth: normalizeSidebarWidth(entry.sidebarWidth),
      order: index,
    })),
  };
}

function buildWindowUrl(state: WindowBootstrap): string {
  const params = new URLSearchParams();
  params.set("windowId", state.windowId);
  if (state.selectedRepoId) params.set("selectedRepoId", state.selectedRepoId);
  if (state.selectedItemId) params.set("selectedItemId", state.selectedItemId);
  return `/?${params.toString()}`;
}

function createWindowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `window-${Date.now()}`;
}

function windowIdFromWebviewLabel(label: string): string | null {
  if (label === "main") return "main";
  return label.startsWith("window-") ? label.slice("window-".length) : null;
}

async function readOpenWorkspaceWindowIds(): Promise<Set<string> | null> {
  if (!isTauri) return null;

  try {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const ids = new Set<string>();
    for (const window of await getAllWebviewWindows()) {
      const id = windowIdFromWebviewLabel(window.label);
      if (id) ids.add(id);
    }
    return ids;
  } catch (error) {
    console.warn("[windowWorkspace] failed to inspect open windows:", error);
    return null;
  }
}

export async function readWorkspaceSnapshot(db: DbHandle): Promise<WorkspaceSnapshot> {
  const raw = await getSetting(db, WINDOW_WORKSPACE_SETTINGS_KEY);
  if (!raw) return { windows: [] };

  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceSnapshot>;
    return normalizeWorkspaceSnapshot({
      windows: Array.isArray(parsed.windows) ? parsed.windows.map((entry, index) => ({
        windowId: typeof entry?.windowId === "string" ? entry.windowId : `window-${index}`,
        selectedRepoId: typeof entry?.selectedRepoId === "string" ? entry.selectedRepoId : null,
        selectedItemId: typeof entry?.selectedItemId === "string" ? entry.selectedItemId : null,
        sidebarHidden: entry?.sidebarHidden === true,
        sidebarWidth: normalizeSidebarWidth(entry?.sidebarWidth),
        order: typeof entry?.order === "number" ? entry.order : index,
      })) : [],
    });
  } catch {
    return { windows: [] };
  }
}

export async function writeWorkspaceSnapshot(db: DbHandle, snapshot: WorkspaceSnapshot): Promise<void> {
  await setSetting(db, WINDOW_WORKSPACE_SETTINGS_KEY, JSON.stringify(normalizeWorkspaceSnapshot(snapshot)));
}

export async function resolveWindowBootstrap(
  db: DbHandle,
  bootstrap: WindowBootstrap,
  snapshotOverride?: WorkspaceSnapshot,
): Promise<WindowBootstrap> {
  if (bootstrap.selectedRepoId || bootstrap.selectedItemId) {
    return bootstrap;
  }

  const snapshot = snapshotOverride ?? await readWorkspaceSnapshot(db);
  const savedWindow = snapshot.windows.find((entry) => entry.windowId === bootstrap.windowId);
  if (!savedWindow) {
    return bootstrap;
  }

  return {
    windowId: bootstrap.windowId,
    selectedRepoId: savedWindow.selectedRepoId,
    selectedItemId: savedWindow.selectedItemId,
  };
}

export function createWindowWorkspace(input: {
  db: DbHandle;
  bootstrap: WindowBootstrap;
}): WindowWorkspaceController {
  const { db, bootstrap } = input;

  async function loadSnapshot(): Promise<WorkspaceSnapshot> {
    return reconcileWorkspaceSnapshot(await readWorkspaceSnapshot(db), bootstrap.windowId);
  }

  async function saveSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    await writeWorkspaceSnapshot(db, reconcileWorkspaceSnapshot(snapshot, bootstrap.windowId));
  }

  async function forgetCurrentWindow(): Promise<void> {
    const snapshot = await loadSnapshot();
    const openWindowIds = await readOpenWorkspaceWindowIds();
    const liveSnapshot = openWindowIds
      ? {
          windows: snapshot.windows.filter((entry) => openWindowIds.has(entry.windowId)),
        }
      : snapshot;
    await writeWorkspaceSnapshot(db, removeWindowFromWorkspaceSnapshot(liveSnapshot, bootstrap.windowId));
  }

  async function spawnWindow(state: WindowBootstrap): Promise<void> {
    const url = buildWindowUrl(state);

    if (isTauri) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      new WebviewWindow(`window-${state.windowId}`, {
        url,
        title: "",
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
      });
      return;
    }

    window.open(url, "_blank");
  }

  async function closeCurrentWindow(): Promise<void> {
    if (isTauri) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
      return;
    }

    window.close();
  }

  async function updateCurrentWindow(
    apply: (entry: WorkspaceWindowState) => WorkspaceWindowState,
  ): Promise<void> {
    const snapshot = await loadSnapshot();
    const next = normalizeWorkspaceSnapshot({
      windows: snapshot.windows.map((entry) =>
        entry.windowId === bootstrap.windowId ? apply(entry) : entry,
      ),
    });
    await saveSnapshot(next);
  }

  return {
    bootstrap,
    loadSnapshot,
    saveSnapshot,
    openWindow: async (selection) => {
      const windowId = createWindowId();
      const snapshot = await loadSnapshot();
      const nextWindow: WorkspaceWindowState = {
        windowId,
        selectedRepoId: selection.selectedRepoId,
        selectedItemId: selection.selectedItemId,
        sidebarHidden: false,
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        order: snapshot.windows.length,
      };
      await saveSnapshot({
        windows: [...snapshot.windows, nextWindow],
      });
      await spawnWindow(nextWindow);
    },
    forgetCurrentWindow,
    closeWindow: async () => {
      await forgetCurrentWindow();
      await closeCurrentWindow();
    },
    persistSelection: async (selection) => {
      await updateCurrentWindow((entry) => ({
        ...entry,
        selectedRepoId: selection.selectedRepoId,
        selectedItemId: selection.selectedItemId,
      }));
    },
    persistSidebarHidden: async (hidden) => {
      await updateCurrentWindow((entry) => ({
        ...entry,
        sidebarHidden: hidden,
      }));
    },
    persistSidebarWidth: async (width) => {
      await updateCurrentWindow((entry) => ({
        ...entry,
        sidebarWidth: normalizeSidebarWidth(width),
      }));
    },
    invalidateSharedData: async (reason) => {
      await emit(WINDOW_WORKSPACE_INVALIDATED_EVENT, {
        reason,
        sourceWindowId: bootstrap.windowId,
      });
    },
    restoreAdditionalWindows: async () => {
      if (bootstrap.windowId !== "main") return;
      const snapshot = await loadSnapshot();
      const extraWindows = snapshot.windows
        .filter((entry) => entry.windowId !== bootstrap.windowId)
        .sort((left, right) => left.order - right.order);

      for (const entry of extraWindows) {
        await spawnWindow(entry);
      }
    },
    onSharedInvalidation: async (handler) =>
      listen(WINDOW_WORKSPACE_INVALIDATED_EVENT, async (event: { payload?: { reason?: string; sourceWindowId?: string } }) => {
        const payload = event.payload ?? {};
        if (payload.sourceWindowId === bootstrap.windowId) return;
        await handler(payload);
      }),
  };
}
