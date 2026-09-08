import type { DbHandle } from "./types/kanna";
import type { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";

import { emit } from "./emit";
import { listen } from "./listen";
import {
  getDesktopSetting,
  mutateDesktopWindowWorkspace,
  type DesktopWindowWorkspaceMutation,
} from "./services/desktopServerClient";
import { disposeDesktopCompanionBridgeManager } from "./services/desktopCompanionBridge";
import { isTauri } from "./tauri-mock";
import {
  isModalTearOffContext,
  modalTearOffTitle,
  parseModalTearOffContext,
  type ModalTearOffContext,
  type ModalTearOffGeometry,
} from "./modalTearOff";

export interface WindowBootstrap {
  windowId: string;
  selectedRepoId: string | null;
  selectedItemId: string | null;
  tearOffContext?: ModalTearOffContext | null;
}

export interface WorkspaceWindowState extends WindowBootstrap {
  sidebarHidden: boolean;
  sidebarWidth: number;
  order: number;
  geometry?: WorkspaceWindowGeometry | null;
}

export interface WorkspaceWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkspaceMonitorWorkArea {
  workArea: {
    position: { x: number; y: number };
    size: { width: number; height: number };
  };
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
  openTearOffWindow: (
    context: ModalTearOffContext,
    geometry: ModalTearOffGeometry,
  ) => Promise<void>;
  clearTearOffContext: () => Promise<void>;
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
  restoreCurrentWindowGeometry: () => Promise<void>;
  startGeometryTracking: () => Promise<() => void>;
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
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;
export const MIN_TEAR_OFF_WINDOW_WIDTH = 420;
export const MIN_TEAR_OFF_WINDOW_HEIGHT = 280;

export interface AppWebviewWindowOptions {
  label: string;
  url: string;
  title: string;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  x?: number;
  y?: number;
  visible?: boolean;
  resizable?: boolean;
  focus?: boolean;
}

interface CreatedAppWebviewWindow {
  show: () => Promise<void>;
  setFocus: () => Promise<void>;
  setSize: (size: PhysicalSize) => Promise<void>;
  setPosition: (position: PhysicalPosition) => Promise<void>;
  startDragging: () => Promise<void>;
}

export async function openAppWebviewWindow(
  options: AppWebviewWindowOptions,
  onCreated?: (webview: CreatedAppWebviewWindow) => Promise<void>,
): Promise<void> {
  if (!isTauri) {
    const features = [
      `width=${options.width}`,
      `height=${options.height}`,
      ...(options.x === undefined ? [] : [`left=${options.x}`]),
      ...(options.y === undefined ? [] : [`top=${options.y}`]),
    ];
    window.open(options.url, "_blank", features.join(","));
    return;
  }

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await new Promise<void>((resolve, reject) => {
    const webview = new WebviewWindow(options.label, {
      url: options.url,
      title: options.title,
      width: options.width,
      height: options.height,
      ...(options.minWidth === undefined ? {} : { minWidth: options.minWidth }),
      ...(options.minHeight === undefined ? {} : { minHeight: options.minHeight }),
      ...(options.x === undefined ? {} : { x: options.x }),
      ...(options.y === undefined ? {} : { y: options.y }),
      ...(options.visible === undefined ? {} : { visible: options.visible }),
      ...(options.resizable === undefined ? {} : { resizable: options.resizable }),
      ...(options.focus === undefined ? {} : { focus: options.focus }),
    });
    void webview.once("tauri://created", () => {
      void (async () => {
        try {
          await onCreated?.(webview);
          resolve();
        } catch (error) {
          reject(error);
        }
      })();
    });
    void webview.once("tauri://error", (event) => {
      reject(new Error(`failed to create window: ${String(event.payload)}`));
    });
  });
}

export function normalizeSidebarWidth(width: unknown): number {
  return typeof width === "number" && Number.isFinite(width) && width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH
    ? Math.round(width)
    : DEFAULT_SIDEBAR_WIDTH;
}

export function normalizeWindowGeometry(value: unknown): WorkspaceWindowGeometry | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<WorkspaceWindowGeometry>;
  if (
    typeof candidate.x !== "number" || !Number.isFinite(candidate.x) ||
    typeof candidate.y !== "number" || !Number.isFinite(candidate.y) ||
    typeof candidate.width !== "number" || !Number.isFinite(candidate.width) ||
    typeof candidate.height !== "number" || !Number.isFinite(candidate.height) ||
    candidate.width < MIN_WINDOW_WIDTH || candidate.height < MIN_WINDOW_HEIGHT
  ) {
    return null;
  }

  return {
    x: Math.round(candidate.x),
    y: Math.round(candidate.y),
    width: Math.round(candidate.width),
    height: Math.round(candidate.height),
  };
}

export function normalizeTearOffWindowGeometry(value: unknown): WorkspaceWindowGeometry | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<WorkspaceWindowGeometry>;
  if (
    typeof candidate.x !== "number" || !Number.isFinite(candidate.x) ||
    typeof candidate.y !== "number" || !Number.isFinite(candidate.y) ||
    typeof candidate.width !== "number" || !Number.isFinite(candidate.width) ||
    typeof candidate.height !== "number" || !Number.isFinite(candidate.height) ||
    candidate.width < MIN_TEAR_OFF_WINDOW_WIDTH || candidate.height < MIN_TEAR_OFF_WINDOW_HEIGHT
  ) {
    return null;
  }
  return {
    x: Math.round(candidate.x),
    y: Math.round(candidate.y),
    width: Math.round(candidate.width),
    height: Math.round(candidate.height),
  };
}

function rectanglesIntersect(
  geometry: WorkspaceWindowGeometry,
  monitor: WorkspaceMonitorWorkArea,
): boolean {
  const left = monitor.workArea.position.x;
  const top = monitor.workArea.position.y;
  const right = left + monitor.workArea.size.width;
  const bottom = top + monitor.workArea.size.height;
  return geometry.x < right && geometry.x + geometry.width > left &&
    geometry.y < bottom && geometry.y + geometry.height > top;
}

export function resolveRestorableWindowGeometry(
  value: unknown,
  monitors: readonly WorkspaceMonitorWorkArea[],
  tearOff = false,
): WorkspaceWindowGeometry | null {
  const geometry = tearOff
    ? normalizeTearOffWindowGeometry(value)
    : normalizeWindowGeometry(value);
  if (!geometry || monitors.length === 0) return geometry;
  if (monitors.some((monitor) => rectanglesIntersect(geometry, monitor))) return geometry;

  const fallback = monitors[0];
  if (!fallback) return geometry;
  return {
    x: Math.round(fallback.workArea.position.x),
    y: Math.round(fallback.workArea.position.y),
    width: Math.round(Math.min(geometry.width, fallback.workArea.size.width)),
    height: Math.round(Math.min(geometry.height, fallback.workArea.size.height)),
  };
}

export function parseWindowBootstrap(search: string): WindowBootstrap {
  const params = new URLSearchParams(search);
  const tearOffContext = parseModalTearOffContext(search);

  return {
    windowId: params.get("windowId") ?? "main",
    selectedRepoId: params.get("selectedRepoId"),
    selectedItemId: params.get("selectedItemId"),
    ...(tearOffContext ? { tearOffContext } : {}),
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
    windows: ordered.map((entry, index) => {
      const normalized = {
        windowId: entry.windowId,
        selectedRepoId: entry.selectedRepoId,
        selectedItemId: entry.selectedItemId,
        sidebarHidden: entry.sidebarHidden,
        sidebarWidth: normalizeSidebarWidth(entry.sidebarWidth),
        order: index,
        ...(isModalTearOffContext(entry.tearOffContext)
          ? { tearOffContext: entry.tearOffContext }
          : {}),
      };
      return entry.geometry === undefined
        ? normalized
        : {
            ...normalized,
            geometry: entry.tearOffContext
              ? normalizeTearOffWindowGeometry(entry.geometry)
              : normalizeWindowGeometry(entry.geometry),
          };
    }),
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
    case "clearTearOff": {
      const entry = next.windows.find((candidate) => candidate.windowId === mutation.windowId);
      if (entry) {
        entry.selectedRepoId = mutation.selectedRepoId;
        entry.selectedItemId = mutation.selectedItemId;
        entry.tearOffContext = null;
        entry.geometry = null;
      }
      break;
    }
    case "updateGeometry": {
      const entry = next.windows.find((candidate) => candidate.windowId === mutation.windowId);
      if (entry) {
        entry.geometry = entry.tearOffContext
          ? normalizeTearOffWindowGeometry(mutation.geometry)
          : normalizeWindowGeometry(mutation.geometry);
      }
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
  if (state.tearOffContext) {
    const params = new URLSearchParams({
      windowId: state.windowId,
      windowMode: "tearOff",
    });
    return `/?${params.toString()}`;
  }
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
        ...(isModalTearOffContext(entry?.tearOffContext)
          ? { tearOffContext: entry.tearOffContext }
          : {}),
        geometry: isModalTearOffContext(entry?.tearOffContext)
          ? normalizeTearOffWindowGeometry(entry?.geometry)
          : normalizeWindowGeometry(entry?.geometry),
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
  if (bootstrap.tearOffContext) return bootstrap;

  const snapshot = snapshotOverride ?? await readWorkspaceSnapshot(db);
  const savedWindow = snapshot.windows.find((entry) => entry.windowId === bootstrap.windowId);

  // The URL's selection parameters are a LAUNCH hint — what the window was
  // opened on — and they never leave the address bar. Preferring them meant
  // that on every later reload a window was pinned to the repo and task it was
  // opened with, however long ago: when those ids were gone the restore fell
  // through to the first repo and dropped the selection entirely, discarding
  // what the window had actually persisted. A saved entry that names a
  // selection is the durable record and wins; the hint only covers the first
  // load, before this window has persisted anything of its own.
  if (savedWindow && (savedWindow.selectedRepoId || savedWindow.selectedItemId)) {
    return {
      windowId: bootstrap.windowId,
      selectedRepoId: savedWindow.selectedRepoId,
      selectedItemId: savedWindow.selectedItemId,
      ...(savedWindow.tearOffContext ? { tearOffContext: savedWindow.tearOffContext } : {}),
    };
  }

  if (bootstrap.selectedRepoId || bootstrap.selectedItemId) {
    return bootstrap;
  }
  if (!savedWindow) {
    return bootstrap;
  }

  return {
    windowId: bootstrap.windowId,
    selectedRepoId: savedWindow.selectedRepoId,
    selectedItemId: savedWindow.selectedItemId,
    ...(savedWindow.tearOffContext ? { tearOffContext: savedWindow.tearOffContext } : {}),
  };
}

export function createWindowWorkspace(input: {
  db: DbHandle;
  bootstrap: WindowBootstrap;
}): WindowWorkspaceController {
  const { db, bootstrap } = input;
  let currentTearOffContext = bootstrap.tearOffContext ?? null;
  let currentSelection = {
    selectedRepoId: bootstrap.selectedRepoId,
    selectedItemId: bootstrap.selectedItemId,
  };
  let currentWindowUpdateQueue = Promise.resolve();

  async function resolveNativeGeometry(
    geometry: unknown,
    tearOff = false,
  ): Promise<WorkspaceWindowGeometry | null> {
    const normalized = tearOff
      ? normalizeTearOffWindowGeometry(geometry)
      : normalizeWindowGeometry(geometry);
    if (!normalized || !isTauri) return normalized;
    try {
      const { availableMonitors, primaryMonitor } = await import("@tauri-apps/api/window");
      const [primary, available] = await Promise.all([primaryMonitor(), availableMonitors()]);
      const monitors = primary
        ? [primary, ...available.filter((monitor) =>
            monitor.workArea.position.x !== primary.workArea.position.x ||
            monitor.workArea.position.y !== primary.workArea.position.y ||
            monitor.workArea.size.width !== primary.workArea.size.width ||
            monitor.workArea.size.height !== primary.workArea.size.height)]
        : available;
      return resolveRestorableWindowGeometry(normalized, monitors, tearOff);
    } catch (error) {
      console.warn("[windowWorkspace] failed to inspect monitors for geometry restore:", error);
      return normalized;
    }
  }

  async function applyNativeGeometry(
    nativeWindow: {
      setSize: (size: PhysicalSize) => Promise<void>;
      setPosition: (position: PhysicalPosition) => Promise<void>;
    },
    geometry: WorkspaceWindowGeometry,
  ): Promise<void> {
    const { PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/window");
    await nativeWindow.setSize(new PhysicalSize(geometry.width, geometry.height));
    await nativeWindow.setPosition(new PhysicalPosition(geometry.x, geometry.y));
  }

  async function physicalTearOffGeometry(
    geometry: ModalTearOffGeometry,
  ): Promise<WorkspaceWindowGeometry> {
    if (!isTauri) return geometry;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const scaleFactor = await getCurrentWindow().scaleFactor();
    return {
      x: Math.round(geometry.x * scaleFactor),
      y: Math.round(geometry.y * scaleFactor),
      width: Math.round(geometry.width * scaleFactor),
      height: Math.round(geometry.height * scaleFactor),
    };
  }

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
        ...(bootstrap.tearOffContext ? { tearOffContext: bootstrap.tearOffContext } : {}),
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

  async function spawnWindow(
    state: WindowBootstrap & { geometry?: WorkspaceWindowGeometry | null },
    options: { continueNativeDrag?: boolean } = {},
  ): Promise<void> {
    const url = buildWindowUrl(state);
    const tearOffContext = state.tearOffContext ?? null;
    const geometry = await resolveNativeGeometry(state.geometry, Boolean(tearOffContext));
    await openAppWebviewWindow(
      {
        label: `window-${state.windowId}`,
        url,
        title: tearOffContext ? modalTearOffTitle(tearOffContext) : "",
        width: geometry?.width ?? 1200,
        height: geometry?.height ?? 800,
        minWidth: tearOffContext ? MIN_TEAR_OFF_WINDOW_WIDTH : MIN_WINDOW_WIDTH,
        minHeight: tearOffContext ? MIN_TEAR_OFF_WINDOW_HEIGHT : MIN_WINDOW_HEIGHT,
        ...(geometry ? { visible: false } : {}),
      },
      geometry
        ? async (webview) => {
            try {
              await applyNativeGeometry(webview, geometry);
            } catch (error) {
              console.warn("[windowWorkspace] failed to apply saved window geometry:", error);
            }
            await webview.show();
            await webview.setFocus();
            if (options.continueNativeDrag) {
              try {
                await webview.startDragging();
              } catch (error) {
                // Synthetic WebDriver pointer events cannot begin a native OS
                // drag, but the window transition itself remains valid.
                console.debug("[windowWorkspace] native drag handoff unavailable:", error);
              }
            }
          }
        : undefined,
    );
  }

  async function destroyNativeWindow(): Promise<void> {
    await disposeDesktopCompanionBridgeManager();
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

  async function restoreCurrentWindowGeometry(): Promise<void> {
    if (!isTauri) return;
    const snapshot = await loadSnapshot({ authoritative: true });
    const saved = snapshot.windows.find((entry) => entry.windowId === bootstrap.windowId);
    const geometry = await resolveNativeGeometry(
      saved?.geometry,
      Boolean(saved?.tearOffContext ?? currentTearOffContext),
    );
    if (!geometry) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const nativeWindow = getCurrentWindow();
    if (saved?.tearOffContext ?? currentTearOffContext) {
      // On macOS WKWebView, native outer/inner size APIs can report the same
      // value despite title-bar chrome. Correct from the rendered viewport so
      // the content area—not the outer frame—matches the original modal.
      const [outerSize, scaleFactor] = await Promise.all([
        nativeWindow.outerSize(),
        nativeWindow.scaleFactor(),
      ]);
      const widthDelta = geometry.width - Math.round(window.innerWidth * scaleFactor);
      const heightDelta = geometry.height - Math.round(window.innerHeight * scaleFactor);
      const { PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/window");
      await nativeWindow.setSize(new PhysicalSize(
        Math.max(1, outerSize.width + widthDelta),
        Math.max(1, outerSize.height + heightDelta),
      ));
      await nativeWindow.setPosition(new PhysicalPosition(geometry.x, geometry.y));
      return;
    }
    await applyNativeGeometry(nativeWindow, geometry);
  }

  async function startGeometryTracking(): Promise<() => void> {
    if (!isTauri) return () => {};
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const nativeWindow = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const persistGeometry = async () => {
      timer = null;
      try {
        const [position, size] = await Promise.all([
          nativeWindow.outerPosition(),
          currentTearOffContext ? nativeWindow.innerSize() : nativeWindow.outerSize(),
        ]);
        if (disposed) return;
        const geometryInput = {
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height,
        };
        const geometry = currentTearOffContext
          ? normalizeTearOffWindowGeometry(geometryInput)
          : normalizeWindowGeometry(geometryInput);
        if (!geometry) return;
        await queueCurrentWindowMutation({
          operation: "updateGeometry",
          windowId: bootstrap.windowId,
          geometry,
        });
      } catch (error) {
        console.warn("[windowWorkspace] failed to persist window geometry:", error);
      }
    };
    const schedulePersistence = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void persistGeometry();
      }, 150);
    };
    const [unlistenMoved, unlistenResized] = await Promise.all([
      nativeWindow.onMoved(schedulePersistence),
      nativeWindow.onResized(schedulePersistence),
    ]);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      unlistenMoved();
      unlistenResized();
    };
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
    openTearOffWindow: async (context, geometry) => {
      const windowId = createWindowId();
      const snapshot = await loadSnapshot();
      const nativeGeometry = await physicalTearOffGeometry(geometry);
      const nextWindow: WorkspaceWindowState = {
        windowId,
        selectedRepoId: currentSelection.selectedRepoId,
        selectedItemId: currentSelection.selectedItemId,
        sidebarHidden: false,
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        order: snapshot.windows.length,
        geometry: nativeGeometry,
        tearOffContext: context,
      };
      await mutateWorkspace({ operation: "ensure", window: nextWindow });
      try {
        await spawnWindow(nextWindow, { continueNativeDrag: true });
        await notifyWindowMembershipChanged();
      } catch (error) {
        await mutateWorkspace({ operation: "remove", windowId });
        throw error;
      }
    },
    clearTearOffContext: async () => {
      if (!currentTearOffContext) return;
      await mutateWorkspace({
        operation: "clearTearOff",
        windowId: bootstrap.windowId,
        selectedRepoId: bootstrap.selectedRepoId,
        selectedItemId: bootstrap.selectedItemId,
      });
      await notifyWindowMembershipChanged();
      currentTearOffContext = null;

      if (isTauri) {
        const { getCurrentWindow, PhysicalSize } = await import("@tauri-apps/api/window");
        const nativeWindow = getCurrentWindow();
        const [outerSize, scaleFactor] = await Promise.all([
          nativeWindow.outerSize(),
          nativeWindow.scaleFactor(),
        ]);
        const minimumSize = new PhysicalSize(
          Math.round(MIN_WINDOW_WIDTH * scaleFactor),
          Math.round(MIN_WINDOW_HEIGHT * scaleFactor),
        );
        await nativeWindow.setMinSize(minimumSize);
        if (outerSize.width < minimumSize.width || outerSize.height < minimumSize.height) {
          await nativeWindow.setSize(new PhysicalSize(
            Math.max(outerSize.width, minimumSize.width),
            Math.max(outerSize.height, minimumSize.height),
          ));
        }
      }

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
      currentSelection = { ...selection };
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
    restoreCurrentWindowGeometry,
    startGeometryTracking,
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
        try {
          await spawnWindow(entry);
        } catch (error) {
          console.error(`[windowWorkspace] failed to restore window ${entry.windowId}:`, error);
        }
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
