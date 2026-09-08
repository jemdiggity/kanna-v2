import { nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, type Ref } from "vue";
import { isAgentProvider } from "@kanna/agent-protocol";
import type { DbHandle } from "../types/kanna";

import i18n from "../i18n";
import { invoke } from "../invoke";
import { listen, listenCurrentWebviewWindow } from "../listen";
import type { useKannaStore } from "../stores/kanna";
import { isTauri } from "../tauri-mock";
import {
  normalizeAppThemePreference,
  normalizeCodeThemePreference,
} from "../theme/theme";
import { normalizeAgentExecutionType } from "../stores/agentExecutionType";
import { getDesktopSetting } from "../services/desktopServerClient";
import {
  parsePairingCompletedEvent,
  parsePairingRequestedEvent,
} from "../utils/taskTransfer";
import {
  WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT,
  WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT,
  WindowWorkspaceRemovalError,
  type WindowWorkspaceController,
  type WorkspaceWindowState,
} from "../windowWorkspace";
import { scheduleStartupBackup, startPeriodicBackup } from "./useBackup";
import type { KeyboardActions } from "./useKeyboardShortcuts";
import type { useAppPreferences } from "./useAppPreferences";
import { parseRecentAgentChoices } from "../utils/agentChoiceUsage";
import type { useAppUpdate } from "./useAppUpdate";
import type { useToast } from "./useToast";
import { showTerminalFileLinkHintOnce } from "./terminalFileLinkHint";
import { openPath } from "@tauri-apps/plugin-opener";

type AppPreferences = ReturnType<typeof useAppPreferences>["preferences"];
type AppUpdateController = ReturnType<typeof useAppUpdate>;
type NativeKeyboardActions = Pick<
  KeyboardActions,
  | "newWindow"
  | "closeTabOrWindow"
  | "navigateUp"
  | "navigateDown"
  | "navigateRepoUp"
  | "navigateRepoDown"
>;

interface UseAppLifecycleOptions {
  appUpdate: AppUpdateController;
  commandUsageCounts: Ref<Record<string, number>>;
  db: DbHandle;
  dbName: string;
  disposeDesktopCloudWorkspace: () => void;
  getKeyboardActions: () => NativeKeyboardActions;
  homePath: Ref<string>;
  initializeDesktopCloudAuth: () => Promise<void>;
  initializeDesktopLanTaskSync: () => void;
  openFilePreview: (filePath: string, initialLine?: number, remoteContent?: string) => void;
  openImageUrlPreview: (imageUrl: string) => void;
  /**
   * Honour a `kanna_open_file` request from an agent: put the file in the
   * named task's own tab set. It never changes what this window has selected.
   */
  openTaskFileView: (taskId: string, filePath: string, line?: number) => void;
  preferences: AppPreferences;
  remoteTaskDiagnostics: Ref<unknown>;
  restoreSidebarWidth: () => Promise<void>;
  restoreTransferredModal: () => void;
  shortcutsStartFull: Ref<boolean>;
  showShortcutsModal: Ref<boolean>;
  startSystemThemeListener: () => void;
  stopSidebarResize: () => void;
  stopSystemThemeListener: () => void;
  store: ReturnType<typeof useKannaStore>;
  toast: ReturnType<typeof useToast>;
  warmTransferSidecar: () => Promise<void>;
  windowWorkspace: WindowWorkspaceController;
}

function eventPayload(event: unknown): unknown {
  return (event as { payload?: unknown })?.payload ?? event;
}

interface DesktopViewOpenCommand {
  taskId: string;
  path: string;
  line?: number;
}

function parseDesktopViewOpenEvent(payload: unknown): DesktopViewOpenCommand {
  const command = payload as Partial<DesktopViewOpenCommand> & { view?: string } | null;
  if (
    !command
    || typeof command.taskId !== "string"
    || typeof command.path !== "string"
    || (command.view !== undefined && command.view !== "file")
  ) {
    throw new Error("malformed desktop view open command");
  }
  return {
    taskId: command.taskId,
    path: command.path,
    line: typeof command.line === "number" ? command.line : undefined,
  };
}

function focusAgentTerminal() {
  nextTick(() => {
    const el = document.querySelector(".main-panel .xterm-helper-textarea") as HTMLElement | null;
    el?.focus();
  });
}

export function useAppLifecycle({
  appUpdate,
  commandUsageCounts,
  db,
  dbName,
  disposeDesktopCloudWorkspace,
  getKeyboardActions,
  homePath,
  initializeDesktopCloudAuth,
  initializeDesktopLanTaskSync,
  openFilePreview,
  openImageUrlPreview,
  openTaskFileView,
  preferences,
  remoteTaskDiagnostics,
  restoreSidebarWidth,
  restoreTransferredModal,
  shortcutsStartFull,
  showShortcutsModal,
  startSystemThemeListener,
  stopSidebarResize,
  stopSystemThemeListener,
  store,
  toast,
  warmTransferSidecar,
  windowWorkspace,
}: UseAppLifecycleOptions) {
  const appUnlisteners: Array<() => void> = [];
  const fatalInitializationError = ref<string | null>(null);
  let currentWindowClosePhase: "open" | "preparing" | "recovering" | "destroying" = "open";
  let resolveWindowMembershipInitialization: (() => void) | null = null;
  const windowMembershipInitialization = new Promise<void>((resolve) => {
    resolveWindowMembershipInitialization = resolve;
  });

  function finishWindowMembershipInitialization() {
    resolveWindowMembershipInitialization?.();
    resolveWindowMembershipInitialization = null;
  }

  async function restoreWindowMembershipAfterCloseFailure(
    removedWindow: WorkspaceWindowState | null,
  ): Promise<void> {
    if (!removedWindow) return;
    try {
      await windowWorkspace.restoreCurrentWindow(removedWindow);
    } catch (error) {
      console.warn("[App] failed to restore window membership after close failure:", error);
    }
    try {
      await windowWorkspace.notifyWindowMembershipChanged();
    } catch (error) {
      console.warn("[App] failed to notify restored window membership:", error);
    }
  }

  async function requestCloseCurrentWindow() {
    if (currentWindowClosePhase !== "open") return;
    currentWindowClosePhase = "preparing";
    let removedWindow: WorkspaceWindowState | null = null;
    try {
      await windowMembershipInitialization;
      removedWindow = await windowWorkspace.forgetCurrentWindow();
      await windowWorkspace.notifyWindowMembershipChanged();
      currentWindowClosePhase = "destroying";
      await windowWorkspace.destroyNativeWindow();
    } catch (error: unknown) {
      if (error instanceof WindowWorkspaceRemovalError) {
        removedWindow = error.removedWindow;
      }
      currentWindowClosePhase = "recovering";
      try {
        await restoreWindowMembershipAfterCloseFailure(removedWindow);
      } finally {
        currentWindowClosePhase = "open";
      }
      throw error;
    }
  }

  function listenNativeMenuAction(
    eventName: string,
    action: () => void | boolean | Promise<void>,
    label: string,
  ) {
    void (async () => {
      try {
        const unlisten = await listenCurrentWebviewWindow(eventName, async () => {
          await action();
        });
        appUnlisteners.push(unlisten);
      } catch (e: unknown) {
        console.error(`[App] native ${label} listener registration failed:`, e);
      }
    })();
  }

  function isFileTransfer(event: DragEvent): boolean {
    const transfer = event.dataTransfer;
    if (!transfer) return false;
    if (transfer.files.length > 0) return true;
    return Array.from(transfer.types).includes("Files");
  }

  function suppressFileDropNavigation(event: DragEvent) {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
  }

  async function handleFileLinkActivate(event: Event) {
    const detail = (event as CustomEvent).detail as {
      path: string;
      line?: number;
      remoteContent?: string;
      localAbsolutePath?: string;
    };
    if (detail.localAbsolutePath) {
      try {
        const content = await invoke<string>("read_text_file", {
          path: detail.localAbsolutePath,
        });
        openFilePreview(detail.path, detail.line, content);
      } catch (error: unknown) {
        console.warn("[App] local mentioned file is not text-renderable; opening with the OS:", error);
        try {
          await openPath(detail.localAbsolutePath);
        } catch (openError: unknown) {
          console.error("[App] failed to open local mentioned file:", openError);
          toast.error(
            openError instanceof Error ? openError.message : "Failed to open the mentioned file.",
          );
        }
      }
      return;
    }
    openFilePreview(detail.path, detail.line, detail.remoteContent);
  }
  const handleFileLinkActivateEvent = (event: Event) => {
    void handleFileLinkActivate(event);
  };

  function handleImageLinkActivate(event: Event) {
    const detail = (event as CustomEvent).detail as { url?: string };
    if (detail.url) openImageUrlPreview(detail.url);
  }

  function handleTerminalFileLinkAvailable() {
    showTerminalFileLinkHintOnce(
      window.localStorage,
      toast.info,
      i18n.global.t("toasts.latestAgentFileHint"),
    );
  }

  // Restore focus after native macOS fullscreen exit.
  // WKWebView loses first-responder status during the exit animation, breaking
  // terminal input and keyboard shortcuts. The Rust side calls
  // evaluateJavaScript: after a delay, which triggers becomeFirstResponder on
  // WKWebView (WebKit Bug 143482 fix). We track the last meaningful focused
  // element and expose a global restore function for that call.
  let lastFocusedElement: HTMLElement | null = null;
  document.addEventListener("focusin", (e) => {
    const el = e.target as HTMLElement;
    if (el && el !== document.body) lastFocusedElement = el;
  });
  (window as unknown as Record<string, unknown>).__kannaRestoreFocus = () => {
    if (lastFocusedElement) {
      lastFocusedElement.focus();
    }
  };

  // Init
  onMounted(async () => {
    if (isTauri) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const unlistenNativeWindowCloseRequest = await getCurrentWindow().onCloseRequested(async (event) => {
          // Every user/native close request is fenced. The one authorized
          // destruction bypasses CloseRequested through destroyNativeWindow.
          event.preventDefault();
          if (currentWindowClosePhase !== "open") return;
          try {
            await requestCloseCurrentWindow();
          } catch (error: unknown) {
            console.error("[App] native window close request failed:", error);
          }
        });
        appUnlisteners.push(unlistenNativeWindowCloseRequest);
      } catch (e: unknown) {
        finishWindowMembershipInitialization();
        fatalInitializationError.value =
          "Native window-close protection is unavailable. Restart Kanna and try again.";
        console.error("[App] native window close-request listener registration failed:", e);
        return;
      }
    }

    if (currentWindowClosePhase !== "open") {
      finishWindowMembershipInitialization();
      return;
    }
    try {
      await windowWorkspace.initialize();
    } finally {
      finishWindowMembershipInitialization();
    }
    if (currentWindowClosePhase !== "open") return;
    try {
      appUnlisteners.push(await windowWorkspace.startGeometryTracking());
    } catch (error: unknown) {
      console.warn("[App] native window geometry tracking unavailable:", error);
    }

    appUpdate.start();
    window.addEventListener("dragenter", suppressFileDropNavigation);
    window.addEventListener("dragover", suppressFileDropNavigation);
    window.addEventListener("drop", suppressFileDropNavigation);
    document.addEventListener("file-link-activate", handleFileLinkActivateEvent);
    document.addEventListener("image-link-activate", handleImageLinkActivate);
    document.addEventListener("terminal-file-link-available", handleTerminalFileLinkAvailable);

    await restoreSidebarWidth();
    await store.init(db);
    restoreTransferredModal();
    preferences.appTheme = normalizeAppThemePreference(store.appTheme);
    preferences.codeTheme = normalizeCodeThemePreference(store.codeTheme);
    startSystemThemeListener();
    await nextTick();
    if (windowWorkspace && windowWorkspace.bootstrap.windowId === "main") {
      scheduleStartupBackup(dbName);
    }
    void initializeDesktopCloudAuth().catch((error) =>
      console.warn("[cloud] failed to initialize desktop auth:", error),
    );

    try {
      const unlistenNativeNewWindow = await listenCurrentWebviewWindow(WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT, async () => {
        await getKeyboardActions().newWindow();
      });
      appUnlisteners.push(unlistenNativeNewWindow);
    } catch (e: unknown) {
      console.error("[App] native new-window listener registration failed:", e);
    }

    try {
      const unlistenNativeCloseWindow = await listenCurrentWebviewWindow(WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT, async () => {
        await getKeyboardActions().closeTabOrWindow();
      });
      appUnlisteners.push(unlistenNativeCloseWindow);
    } catch (e: unknown) {
      console.error("[App] native close-window listener registration failed:", e);
    }

    listenNativeMenuAction(
      WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT,
      getKeyboardActions().navigateUp,
      "navigate-task-up",
    );
    listenNativeMenuAction(
      WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
      getKeyboardActions().navigateDown,
      "navigate-task-down",
    );
    listenNativeMenuAction(
      WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
      getKeyboardActions().navigateRepoUp,
      "navigate-repo-up",
    );
    listenNativeMenuAction(
      WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
      getKeyboardActions().navigateRepoDown,
      "navigate-repo-down",
    );

    try {
      const unlistenDesktopViewOpen = await listen("desktop-view-open", (event: unknown) => {
        try {
          const command = parseDesktopViewOpenEvent(eventPayload(event));
          openTaskFileView(command.taskId, command.path, command.line);
        } catch (e: unknown) {
          console.error("[App] failed to handle desktop view open command:", e);
        }
      });
      appUnlisteners.push(unlistenDesktopViewOpen);
    } catch (e: unknown) {
      console.error("[App] desktop-view-open listener registration failed:", e);
    }

    try {
      const unlistenPairingStarted = await listen("pairing-started", async (event: unknown) => {
        try {
          const pairing = parsePairingCompletedEvent(eventPayload(event));
          toast.info(`Enter code ${pairing.verificationCode} on ${pairing.displayName}.`);
        } catch (e: unknown) {
          console.error("[App] failed to handle pairing started event:", e);
        }
      });
      appUnlisteners.push(unlistenPairingStarted);
    } catch (e: unknown) {
      console.error("[App] pairing-started listener registration failed:", e);
    }

    try {
      const unlistenPairingRequested = await listen("pairing-requested", async (event: unknown) => {
        let pairingRequestId: string | null = null;
        try {
          const pairing = parsePairingRequestedEvent(eventPayload(event));
          pairingRequestId = pairing.requestId;
          const enteredCode = window
            .prompt(`Enter pairing code for ${pairing.displayName}`)
            ?.trim() ?? null;
          if (enteredCode !== pairing.verificationCode) {
            await invoke("reject_peer_pairing", { pairingRequestId: pairing.requestId });
            toast.error("Pairing code did not match.");
            return;
          }

          await invoke("accept_peer_pairing", {
            pairingRequestId: pairing.requestId,
            verificationCode: enteredCode,
          });
          toast.info(`Paired with ${pairing.displayName}. Verify code ${pairing.verificationCode}.`);
        } catch (e: unknown) {
          console.error("[App] failed to handle pairing request event:", e);
          if (pairingRequestId) {
            try {
              await invoke("reject_peer_pairing", { pairingRequestId });
            } catch (rejectError: unknown) {
              console.error("[App] failed to reject pairing request:", rejectError);
            }
          }
          toast.error(e instanceof Error ? e.message : String(e));
        }
      });
      appUnlisteners.push(unlistenPairingRequested);
    } catch (e: unknown) {
      console.error("[App] pairing-requested listener registration failed:", e);
    }

    try {
      const unlistenPairingCompleted = await listen("pairing-completed", async (event: unknown) => {
        try {
          const pairing = parsePairingCompletedEvent(eventPayload(event));
          console.debug("[transfer] pairing-completed event received", {
            peerId: pairing.peerId,
            displayName: pairing.displayName,
          });
          toast.info(`Paired with ${pairing.displayName}. Verify code ${pairing.verificationCode}.`);
        } catch (e: unknown) {
          console.error("[App] failed to handle pairing completion event:", e);
        }
      });
      appUnlisteners.push(unlistenPairingCompleted);
    } catch (e: unknown) {
      console.error("[App] pairing-completed listener registration failed:", e);
    }

    // The desktop no longer elects a transfer consumer: the four lifecycle
    // events never leave `kanna-server`, so there is nothing to claim and
    // nothing to hand over when this window closes. LAN task sync is a window
    // concern and still starts here.
    initializeDesktopLanTaskSync();
    if (import.meta.env.DEV && window.__KANNA_E2E__) {
      void remoteTaskDiagnostics.value;
      window.__KANNA_E2E__.ready = true;
    }
    await warmTransferSidecar();

    // Cache $HOME for shell-at-home (no repo selected)
    invoke("read_env_var", { name: "HOME" }).then((val) => {
      homePath.value = val as string;
    }).catch(() => {
      homePath.value = "/Users";
    });

    // Load persisted locale
    const savedLocale = await getDesktopSetting("locale");
    if (savedLocale && ["en", "ja", "ko"].includes(savedLocale)) {
      i18n.global.locale.value = savedLocale as "en" | "ja" | "ko";
      preferences.locale = savedLocale;
    }

    // Sync preferences from store
    preferences.suspendAfterMinutes = store.suspendAfterMinutes;
    preferences.killAfterMinutes = store.killAfterMinutes;
    preferences.ideCommand = store.ideCommand;
    preferences.devLingerTerminals = store.devLingerTerminals;
    preferences.agentMessageAppearance = store.agentMessageAppearance;

    const savedAgentProvider = await getDesktopSetting("defaultAgentProvider");
    if (isAgentProvider(savedAgentProvider)) {
      preferences.defaultAgentProvider = savedAgentProvider;
    }
    const savedAgentType = await getDesktopSetting("defaultAgentType");
    if (savedAgentType !== null) {
      preferences.defaultAgentType = normalizeAgentExecutionType(savedAgentType);
    }
    preferences.recentAgentChoices = parseRecentAgentChoices(await getDesktopSetting("recentAgentChoices"));

    startPeriodicBackup(dbName, ref(db) as Ref<DbHandle | null>);
    // A transferred surface is already the intentional startup overlay for a
    // tear-off window. Do not cover it with the automatic shortcuts prompt.
    if (!store.hideShortcutsOnStartup && !windowWorkspace.bootstrap.tearOffContext) {
      shortcutsStartFull.value = true;
      showShortcutsModal.value = true;
    }
    // `ready` is raised well before this point, so it cannot tell an E2E driver
    // whether the startup shortcuts modal is still on its way. This marks the
    // decision itself as made, either way.
    if (import.meta.env.DEV && window.__KANNA_E2E__) {
      window.__KANNA_E2E__.startupOverlaysSettled = true;
    }
    const raw = await getDesktopSetting("commandPaletteUsage");
    if (raw) {
      try { commandUsageCounts.value = JSON.parse(raw) as Record<string, number>; }
      catch (e) { console.error("[App] corrupt commandPaletteUsage setting:", e); }
    }

  });

  onUnmounted(() => {
    while (appUnlisteners.length > 0) {
      const unlisten = appUnlisteners.pop();
      try {
        unlisten?.();
      } catch (e: unknown) {
        console.error("[App] failed to unlisten app event:", e);
      }
    }
  });

  onBeforeUnmount(() => {
    disposeDesktopCloudWorkspace();
    stopSidebarResize();
    window.removeEventListener("dragenter", suppressFileDropNavigation);
    window.removeEventListener("dragover", suppressFileDropNavigation);
    window.removeEventListener("drop", suppressFileDropNavigation);
    document.removeEventListener("file-link-activate", handleFileLinkActivateEvent);
    document.removeEventListener("image-link-activate", handleImageLinkActivate);
    document.removeEventListener("terminal-file-link-available", handleTerminalFileLinkAvailable);
    stopSystemThemeListener();
    appUpdate.dispose();
  });

  return {
    fatalInitializationError,
    focusAgentTerminal,
    requestCloseCurrentWindow,
  };
}
