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
  parseIncomingTransferRequest,
  parseOutgoingTransferCommittedEvent,
  parseOutgoingTransferFinalizationRequestEvent,
  parsePairingCompletedEvent,
  parsePairingRequestedEvent,
  parseTaskPullRequestedEvent,
  type TaskPullRequestedEvent,
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
import type { TransferMachine } from "../services/desktopTransferMachines";

type AppPreferences = ReturnType<typeof useAppPreferences>["preferences"];
type AppUpdateController = ReturnType<typeof useAppUpdate>;
type NativeKeyboardActions = Pick<
  KeyboardActions,
  | "newWindow"
  | "closeWindow"
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
  importPendingIncomingTransfers: () => Promise<void>;
  initializeDesktopCloudAuth: () => Promise<void>;
  initializeDesktopLanTaskSync: () => void;
  openFilePreview: (
    filePath: string,
    initialLine: number | undefined,
    fromPicker: boolean,
    fromTree?: boolean,
    remoteContent?: string,
  ) => void;
  openImageUrlPreview: (imageUrl: string) => void;
  preferences: AppPreferences;
  refreshCloudTransferRoute: (peerId: string) => Promise<void>;
  remoteTaskDiagnostics: Ref<unknown>;
  restoreSidebarWidth: () => Promise<void>;
  shortcutsStartFull: Ref<boolean>;
  showShortcutsModal: Ref<boolean>;
  startSystemThemeListener: () => void;
  stopSidebarResize: () => void;
  stopSystemThemeListener: () => void;
  store: ReturnType<typeof useKannaStore>;
  toast: ReturnType<typeof useToast>;
  transferMachines: Readonly<Ref<TransferMachine[]>>;
  warmTransferSidecar: () => Promise<void>;
  windowWorkspace: WindowWorkspaceController;
}

function eventPayload(event: unknown): unknown {
  return (event as { payload?: unknown })?.payload ?? event;
}

export async function handleTaskPullRequested(
  request: TaskPullRequestedEvent,
  store: Pick<ReturnType<typeof useKannaStore>, "items" | "pushTaskToPeer">,
  inFlightSourceTaskIds: Set<string>,
  transferMachines: readonly TransferMachine[] | (() => readonly TransferMachine[]),
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    signal?: AbortSignal;
    refreshCloudTransferRoute?: (peerId: string) => Promise<void>;
    waitForRetry?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const readMachines = typeof transferMachines === "function"
    ? transferMachines
    : () => transferMachines;
  const maxAttempts = options.maxAttempts
    ?? (typeof transferMachines === "function" ? 41 : 1);
  const retryDelayMs = options.retryDelayMs ?? 250;
  const waitForRetry = options.waitForRetry
    ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const sourceIsEligible = () => {
    const source = store.items.find((item) => item.id === request.sourceTaskId);
    if (
      !source
      || source.closed_at != null
      || ["pending", "streaming", "importing", "awaiting_acknowledgment"].includes(
        source.transfer_status ?? "",
      )
    ) {
      return null;
    }
    return source;
  };
  const initialSource = sourceIsEligible();
  if (!initialSource || inFlightSourceTaskIds.has(initialSource.id)) return false;

  inFlightSourceTaskIds.add(initialSource.id);
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (options.signal?.aborted) return false;
      const source = sourceIsEligible();
      if (!source) return false;
      const requester = readMachines().find((machine) =>
        machine.peerId === request.requesterPeerId);
      if (requester) {
        if (requester.relayDesktopId && options.refreshCloudTransferRoute) {
          await options.refreshCloudTransferRoute(request.requesterPeerId);
          if (options.signal?.aborted) return false;
        }
        await store.pushTaskToPeer(source.id, request.requesterPeerId, {
          transport: requester.preferredTransport,
          cloudFallback: requester.cloudFallback,
          targetDesktopId: requester.desktopId,
        });
        return true;
      }
      if (attempt + 1 < maxAttempts) {
        await waitForRetry(retryDelayMs);
      }
    }
    return false;
  } finally {
    inFlightSourceTaskIds.delete(initialSource.id);
  }
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
  importPendingIncomingTransfers,
  initializeDesktopCloudAuth,
  initializeDesktopLanTaskSync,
  openFilePreview,
  openImageUrlPreview,
  preferences,
  refreshCloudTransferRoute,
  remoteTaskDiagnostics,
  restoreSidebarWidth,
  shortcutsStartFull,
  showShortcutsModal,
  startSystemThemeListener,
  stopSidebarResize,
  stopSystemThemeListener,
  store,
  toast,
  transferMachines,
  warmTransferSidecar,
  windowWorkspace,
}: UseAppLifecycleOptions) {
  const appUnlisteners: Array<() => void> = [];
  const fatalInitializationError = ref<string | null>(null);
  const taskPullPushesInFlight = new Set<string>();
  const taskPullAbortController = new AbortController();
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

  function handleFileLinkActivate(event: Event) {
    const detail = (event as CustomEvent).detail as {
      path: string;
      line?: number;
      remoteContent?: string;
    };
    openFilePreview(detail.path, detail.line, false, false, detail.remoteContent);
  }

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

    appUpdate.start();
    window.addEventListener("dragenter", suppressFileDropNavigation);
    window.addEventListener("dragover", suppressFileDropNavigation);
    window.addEventListener("drop", suppressFileDropNavigation);
    document.addEventListener("file-link-activate", handleFileLinkActivate);
    document.addEventListener("image-link-activate", handleImageLinkActivate);
    document.addEventListener("terminal-file-link-available", handleTerminalFileLinkAvailable);

    await restoreSidebarWidth();
    await store.init(db);
    preferences.appTheme = normalizeAppThemePreference(store.appTheme);
    preferences.codeTheme = normalizeCodeThemePreference(store.codeTheme);
    startSystemThemeListener();
    await nextTick();
    if (windowWorkspace && windowWorkspace.bootstrap.windowId === "main") {
      scheduleStartupBackup(dbName);
    }
    try {
      const unlistenTransferRequest = await listen("transfer-request", async (event: unknown) => {
        try {
          const request = parseIncomingTransferRequest(eventPayload(event));
          await store.recordIncomingTransfer(request);
          await invoke("mark_incoming_transfer_event_recorded", {
            transferId: request.transferId,
          });
          await store.approveIncomingTransfer(request.transferId);
        } catch (e: unknown) {
          console.error("[App] failed to import incoming transfer request:", e);
          toast.error(e instanceof Error ? e.message : String(e));
        }
      });
      appUnlisteners.push(unlistenTransferRequest);
    } catch (e: unknown) {
      console.error("[App] transfer-request listener registration failed:", e);
    }
    try {
      const unlistenTaskPullRequested = await listen("task-pull-requested", async (event: unknown) => {
        try {
          await handleTaskPullRequested(
            parseTaskPullRequestedEvent(eventPayload(event)),
            store,
            taskPullPushesInFlight,
            () => transferMachines.value,
            {
              refreshCloudTransferRoute,
              signal: taskPullAbortController.signal,
            },
          );
        } catch (e: unknown) {
          console.error("[App] failed to handle task pull request:", e);
          toast.error(e instanceof Error ? e.message : String(e));
        }
      });
      appUnlisteners.push(unlistenTaskPullRequested);
    } catch (e: unknown) {
      console.error("[App] task-pull-requested listener registration failed:", e);
    }
    void initializeDesktopCloudAuth().catch((error) =>
      console.warn("[cloud] failed to initialize desktop auth:", error),
    );
    initializeDesktopLanTaskSync();
    await importPendingIncomingTransfers();
    if (import.meta.env.DEV && window.__KANNA_E2E__) {
      void remoteTaskDiagnostics.value;
      window.__KANNA_E2E__.ready = true;
    }

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
        await getKeyboardActions().closeWindow();
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

    try {
      const unlistenOutgoingTransferCommitted = await listen("outgoing-transfer-committed", async (event: unknown) => {
        let transferId: string | null = null;
        try {
          const committed = parseOutgoingTransferCommittedEvent(eventPayload(event));
          transferId = committed.transferId;
          await store.handleOutgoingTransferCommitted(committed);
        } catch (e: unknown) {
          console.error("[App] failed to handle outgoing transfer commit acknowledgment:", e);
          if (transferId) {
            try {
              await invoke("nack_outgoing_transfer_commit", { transferId });
            } catch (nackError: unknown) {
              console.error("[App] failed to nack outgoing transfer commit acknowledgment:", nackError);
            }
          }
        }
      });
      appUnlisteners.push(unlistenOutgoingTransferCommitted);
    } catch (e: unknown) {
      console.error("[App] outgoing-transfer-committed listener registration failed:", e);
    }

    try {
      const unlistenOutgoingTransferFinalizationRequested = await listen("outgoing-transfer-finalization-requested", async (event: unknown) => {
        const request = parseOutgoingTransferFinalizationRequestEvent(eventPayload(event));
        try {
          const finalized = await store.finalizeOutgoingTransfer(request.transferId);
          await invoke("complete_outgoing_transfer_finalization", {
            transferId: request.transferId,
            payload: finalized.payload,
            finalizedCleanly: finalized.finalizedCleanly,
            error: null,
          });
        } catch (error: unknown) {
          console.error("[App] failed to finalize outgoing transfer:", error);
          await invoke("complete_outgoing_transfer_finalization", {
            transferId: request.transferId,
            payload: null,
            finalizedCleanly: false,
            error: error instanceof Error ? error.message : String(error),
          }).catch((invokeError: unknown) => {
            console.error("[App] failed to report outgoing transfer finalization error:", invokeError);
          });
        }
      });
      appUnlisteners.push(unlistenOutgoingTransferFinalizationRequested);
    } catch (e: unknown) {
      console.error("[App] outgoing-transfer-finalization-requested listener registration failed:", e);
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
    if (!store.hideShortcutsOnStartup) {
      shortcutsStartFull.value = true;
      showShortcutsModal.value = true;
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
    taskPullAbortController.abort();
    disposeDesktopCloudWorkspace();
    stopSidebarResize();
    window.removeEventListener("dragenter", suppressFileDropNavigation);
    window.removeEventListener("dragover", suppressFileDropNavigation);
    window.removeEventListener("drop", suppressFileDropNavigation);
    document.removeEventListener("file-link-activate", handleFileLinkActivate);
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
