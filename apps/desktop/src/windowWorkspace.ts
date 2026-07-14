import type { DbHandle } from "./types/kanna";

import { emit } from "./emit";
import { listen } from "./listen";
import {
  getDesktopSetting,
  mutateDesktopWindowWorkspace,
  type DesktopWindowWorkspaceMutation,
} from "./services/desktopServerClient";
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

export interface LoadWorkspaceSnapshotOptions {
  authoritative?: boolean;
}

export class WindowWorkspaceRemovalError extends Error {
  readonly removedWindow: WorkspaceWindowState | null;
  override readonly cause: unknown;

  constructor(removedWindow: WorkspaceWindowState | null, cause: unknown) {
    super("window workspace removal could not be confirmed");
    this.name = "WindowWorkspaceRemovalError";
    this.removedWindow = removedWindow;
    this.cause = cause;
  }
}

export interface WindowWorkspaceController {
  bootstrap: WindowBootstrap;
  initialize: () => Promise<void>;
  loadSnapshot: (options?: LoadWorkspaceSnapshotOptions) => Promise<WorkspaceSnapshot>;
  openWindow: (selection: {
    selectedRepoId: string | null;
    selectedItemId: string | null;
  }) => Promise<void>;
  closeWindow: () => Promise<void>;
  destroyNativeWindow: () => Promise<void>;
  forgetCurrentWindow: () => Promise<WorkspaceWindowState | null>;
  restoreCurrentWindow: (window: WorkspaceWindowState) => Promise<void>;
  notifyWindowMembershipChanged: () => Promise<void>;
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
export const WINDOW_WORKSPACE_MEMBERSHIP_REASON = "windowMembership";
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

export function applyWindowWorkspaceMutation(
  snapshot: WorkspaceSnapshot,
  mutation: DesktopWindowWorkspaceMutation,
): WorkspaceSnapshot {
  const next = normalizeWorkspaceSnapshot(snapshot);
  switch (mutation.operation) {
    case "ensure":
      if (!next.windows.some((entry) => entry.windowId === mutation.window.windowId)) {
        next.windows.push(mutation.window);
      }
      break;
    case "restore":
      if (!next.windows.some((entry) => entry.windowId === mutation.window.windowId)) {
        // A window recovering from a failed native close rejoins at the end so
        // it does not disturb the surviving windows' stable display order.
        next.windows.push({
          ...mutation.window,
          order: next.windows.length,
        });
      }
      break;
    case "updateSelection": {
      const entry = next.windows.find((candidate) => candidate.windowId === mutation.windowId);
      if (entry) {
        entry.selectedRepoId = mutation.selectedRepoId;
        entry.selectedItemId = mutation.selectedItemId;
      }
      break;
    }
    case "updateSidebarHidden": {
      const entry = next.windows.find((candidate) => candidate.windowId === mutation.windowId);
      if (entry) entry.sidebarHidden = mutation.sidebarHidden;
      break;
    }
    case "updateSidebarWidth": {
      const entry = next.windows.find((candidate) => candidate.windowId === mutation.windowId);
      if (entry) entry.sidebarWidth = normalizeSidebarWidth(mutation.sidebarWidth);
      break;
    }
    case "remove": {
      if (mutation.observedWindowIds && mutation.liveWindowIds) {
        const observed = new Set(mutation.observedWindowIds);
        const live = new Set(mutation.liveWindowIds);
        next.windows = next.windows.filter((entry) =>
          !observed.has(entry.windowId) || live.has(entry.windowId),
        );
      }
      next.windows = next.windows.filter((entry) => entry.windowId !== mutation.windowId);
      break;
    }
  }
  return normalizeWorkspaceSnapshot(next);
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
  void db;
  const raw = await getDesktopSetting(WINDOW_WORKSPACE_SETTINGS_KEY);
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
  } catch (error) {
    console.debug("[windowWorkspace] failed to parse workspace snapshot:", error);
    return { windows: [] };
  }
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
  let currentWindowUpdateQueue = Promise.resolve();

  async function mutateWorkspace(
    mutation: DesktopWindowWorkspaceMutation,
  ): Promise<WorkspaceSnapshot> {
    const snapshot = await mutateDesktopWindowWorkspace(mutation);
    return normalizeWorkspaceSnapshot(snapshot);
  }

  async function loadSnapshot(
    options: LoadWorkspaceSnapshotOptions = {},
  ): Promise<WorkspaceSnapshot> {
    const persisted = await readWorkspaceSnapshot(db);
    return options.authoritative
      ? persisted
      : reconcileWorkspaceSnapshot(persisted, bootstrap.windowId);
  }

  async function initialize(): Promise<void> {
    const snapshot = await readWorkspaceSnapshot(db);
    await mutateWorkspace({
      operation: "ensure",
      window: {
        windowId: bootstrap.windowId,
        selectedRepoId: bootstrap.selectedRepoId,
        selectedItemId: bootstrap.selectedItemId,
        sidebarHidden: false,
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        order: snapshot.windows.length,
      },
    });
    try {
      await notifyWindowMembershipChanged();
    } catch (error) {
      // The durable membership is sufficient for this window to initialize;
      // the notification only prompts peer renderers to refresh sooner.
      console.warn("[windowWorkspace] failed to notify initialized membership:", error);
    }
  }

  async function forgetCurrentWindow(): Promise<WorkspaceWindowState | null> {
    // Capture only a durable row. loadSnapshot() synthesizes a default row for
    // missing windows, which is not safe compensation state for an ambiguous
    // remove response.
    await currentWindowUpdateQueue.catch(() => undefined);
    const snapshot = await readWorkspaceSnapshot(db);
    const currentWindow = snapshot.windows.find(
      (entry) => entry.windowId === bootstrap.windowId,
    ) ?? null;
    const openWindowIds = await readOpenWorkspaceWindowIds();
    try {
      await mutateWorkspace({
        operation: "remove",
        windowId: bootstrap.windowId,
        ...(openWindowIds
          ? {
              observedWindowIds: snapshot.windows.map((entry) => entry.windowId),
              liveWindowIds: [...openWindowIds],
            }
          : {}),
      });
    } catch (error) {
      // The server may have committed even when its response is lost. Preserve
      // the pre-remove row so the close coordinator can restore idempotently.
      throw new WindowWorkspaceRemovalError(currentWindow, error);
    }
    return currentWindow;
  }

  async function restoreCurrentWindow(window: WorkspaceWindowState): Promise<void> {
    if (window.windowId !== bootstrap.windowId) {
      throw new Error(`cannot restore workspace window ${window.windowId} from ${bootstrap.windowId}`);
    }
    await mutateWorkspace({ operation: "restore", window });
  }

  async function notifyWindowMembershipChanged(): Promise<void> {
    await emit(WINDOW_WORKSPACE_INVALIDATED_EVENT, {
      reason: WINDOW_WORKSPACE_MEMBERSHIP_REASON,
      sourceWindowId: bootstrap.windowId,
    });
  }

  async function spawnWindow(state: WindowBootstrap): Promise<void> {
    const url = buildWindowUrl(state);

    if (isTauri) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      await new Promise<void>((resolve, reject) => {
        const webview = new WebviewWindow(`window-${state.windowId}`, {
          url,
          title: "",
          width: 1200,
          height: 800,
          minWidth: 800,
          minHeight: 600,
        });
        void webview.once("tauri://created", () => resolve());
        void webview.once("tauri://error", (event) => {
          reject(new Error(`failed to create window: ${String(event.payload)}`));
        });
      });
      return;
    }

    window.open(url, "_blank");
  }

  async function destroyNativeWindow(): Promise<void> {
    if (isTauri) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      // `close()` emits another CloseRequested event. This path runs only
      // after membership removal, so bypass that event and destroy exactly
      // once instead of reopening the close-request race.
      await getCurrentWindow().destroy();
      return;
    }

    window.close();
  }

  function queueCurrentWindowMutation(
    mutation: DesktopWindowWorkspaceMutation,
  ): Promise<void> {
    const update = currentWindowUpdateQueue.catch(() => undefined).then(async () => {
      await mutateWorkspace(mutation);
    });
    currentWindowUpdateQueue = update;
    return update;
  }

  return {
    bootstrap,
    initialize,
    loadSnapshot,
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
      await spawnWindow(nextWindow);
    },
    forgetCurrentWindow,
    restoreCurrentWindow,
    notifyWindowMembershipChanged,
    destroyNativeWindow,
    closeWindow: async () => {
      let removedWindow: WorkspaceWindowState | null = null;
      try {
        removedWindow = await forgetCurrentWindow();
        await notifyWindowMembershipChanged();
        await destroyNativeWindow();
      } catch (error) {
        if (error instanceof WindowWorkspaceRemovalError) {
          removedWindow = error.removedWindow;
        }
        if (removedWindow) {
          try {
            await restoreCurrentWindow(removedWindow);
          } catch (recoveryError) {
            console.warn("[windowWorkspace] failed to restore membership after close failure:", recoveryError);
          }
          try {
            // Notify even when the restore response was lost: the idempotent
            // mutation may still have committed and peers should refresh from
            // the authoritative snapshot.
            await notifyWindowMembershipChanged();
          } catch (notificationError) {
            console.warn("[windowWorkspace] failed to notify restored membership:", notificationError);
          }
        }
        throw error;
      }
    },
    persistSelection: async (selection) => {
      await queueCurrentWindowMutation({
        operation: "updateSelection",
        windowId: bootstrap.windowId,
        selectedRepoId: selection.selectedRepoId,
        selectedItemId: selection.selectedItemId,
      });
    },
    persistSidebarHidden: async (hidden) => {
      await queueCurrentWindowMutation({
        operation: "updateSidebarHidden",
        windowId: bootstrap.windowId,
        sidebarHidden: hidden,
      });
    },
    persistSidebarWidth: async (width) => {
      await queueCurrentWindowMutation({
        operation: "updateSidebarWidth",
        windowId: bootstrap.windowId,
        sidebarWidth: normalizeSidebarWidth(width),
      });
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
