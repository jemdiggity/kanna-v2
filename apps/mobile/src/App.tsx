import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import {
  AppState,
  Platform,
  type AppStateStatus,
  SafeAreaView,
  StyleSheet,
  Text,
  View
} from "react-native";
import type { InitialState } from "@react-navigation/native";
import {
  createTerminalAppStateLifecycle,
  getForegroundTransitionAction,
  shouldCheckForOtaUpdateOnForeground
} from "./appLifecycle";
import { createAppModel, resolveForceCloud, type AppModel } from "./appModel";
import { AccountSheet } from "./components/AccountSheet";
import { MobileCrashBoundary } from "./components/MobileCrashBoundary";
import { QuickReplyEditorModal } from "./components/QuickReplyEditorModal";
import { UpdateReadyBanner } from "./components/UpdateReadyBanner";
import { LoadingText } from "./components/LoadingText";
import { LanNotificationBanner } from "./components/LanNotificationBanner";
import { MOBILE_E2E_IDS } from "./e2eTestIds";
import {
  checkAndFetchUpdate,
  reloadToApplyUpdate
} from "./lib/updates/otaUpdates";
import {
  resolveNotificationTaskId,
  startMobilePushNotifications,
  type MobileNotificationTaskTarget
} from "./lib/notifications/mobilePush";
import { startLanMobileNotifications } from "./lib/notifications/lanNotifications";
import type { MobileNotificationFrame } from "@kanna/stream-client";
import { readExpoConfig } from "./lib/expoConfig";
import {
  addMobileCrashBreadcrumb,
  updateMobileCrashContext
} from "./lib/diagnostics/mobileCrashDiagnostics";
import { readKannaExpoExtra, resolveAccountPortalUrl } from "./mobileEnvironment";
import { requestMobileAccountDeletion } from "./lib/firebase/accountDeletion";
import RootNavigator from "./navigation/RootNavigator";
import { buildInitialNavigationState } from "./navigation/navigationState";
import {
  DEFAULT_TASK_QUICK_REPLIES,
  type TaskQuickReply
} from "./screens/taskQuickReplies";
import { buildMachineInventory, summarizeMachines } from "./state/machineInventory";
import {
  createDefaultTaskQuickReplyPreferences,
  type TaskQuickReplyPreferences
} from "./state/taskQuickReplyPreferences";

const OTA_FOREGROUND_CHECK_THROTTLE_MS = 5 * 60 * 1000;

function AppContent() {
  const modelRef = useRef<AppModel | null>(null);
  if (!modelRef.current) {
    modelRef.current = createAppModel({
      options: {
        enableE2eTrustSeed:
          process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED === "1"
      }
    });
  }

  const model = modelRef.current;
  const state = useSyncExternalStore(
    model.sessionStore.subscribe,
    model.sessionStore.getState,
    model.sessionStore.getState
  );
  const { controller } = model;
  const quickReplyPreferencesRef = useRef<
    Promise<TaskQuickReplyPreferences> | null
  >(null);
  if (!quickReplyPreferencesRef.current) {
    quickReplyPreferencesRef.current =
      createDefaultTaskQuickReplyPreferences();
  }
  const quickReplyMutationVersionRef = useRef(0);
  const accountRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const quickReplyLoadStatusRef = useRef<"pending" | "loaded" | "failed">(
    "pending"
  );
  const [accountSheetVisible, setAccountSheetVisible] = useState(false);
  const accountSheetVisibleRef = useRef(accountSheetVisible);
  accountSheetVisibleRef.current = accountSheetVisible;
  const accountAuthRef = useRef(state.auth);
  accountAuthRef.current = state.auth;
  const [quickReplyEditorVisible, setQuickReplyEditorVisible] = useState(false);
  const [quickReplies, setQuickReplies] = useState<TaskQuickReply[]>(() =>
    DEFAULT_TASK_QUICK_REPLIES.map((reply) => ({ ...reply }))
  );
  const [quickRepliesHydrated, setQuickRepliesHydrated] = useState(false);
  const [quickReplyLoadFailed, setQuickReplyLoadFailed] = useState(false);
  const [forceCloudEnabled, setForceCloudEnabled] = useState(resolveForceCloud());
  updateMobileCrashContext({
    appState: AppState.currentState,
    connectionMode: state.connectionMode ?? "unknown",
    connectionState: state.connectionState,
    forceCloudEnabled,
    selectedTaskId: state.selectedTaskId,
    terminalCols: state.taskTerminalCols,
    terminalOutputChars: state.taskTerminalOutput.length,
    terminalOutputEpoch: state.taskTerminalOutputEpoch,
    terminalOutputStart: state.taskTerminalOutputStart,
    terminalRows: state.taskTerminalRows,
    terminalStatus: state.taskTerminalStatus
  });
  const [openMachinesRequestKey, setOpenMachinesRequestKey] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [updatePromptVisible, setUpdatePromptVisible] = useState(false);
  const [notificationTaskRequest, setNotificationTaskRequest] = useState<{
    key: number;
    target: MobileNotificationTaskTarget;
  } | null>(null);
  const [lanNotificationBanner, setLanNotificationBanner] =
    useState<MobileNotificationFrame | null>(null);
  const initialNavigationStateRef = useRef<InitialState | null>(null);
  const lastOtaCheckAtRef = useRef<number | null>(null);
  const hasDownloadedUpdateRef = useRef(false);
  const machines = useMemo(
    () => buildMachineInventory({
      accountDesktops: state.accountDesktops,
      manualDesktops: state.trustedDesktops,
      liveLanDesktops: state.liveLanDesktops
    }),
    [state.accountDesktops, state.liveLanDesktops, state.trustedDesktops]
  );
  const machineSummary = useMemo(() => summarizeMachines(machines), [machines]);
  const mobileExtra = readKannaExpoExtra(readExpoConfig());
  const subscriptionUrl = resolveAccountPortalUrl(mobileExtra?.appEnv);
  const e2eTaskSnapshotMarker =
    process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED === "1"
      ? state.recentTasks
          .map((task) => `${task.id}:${task.title ?? ""}`)
          .join("\n")
      : undefined;
  const resolvedNotificationTaskRequest = useMemo(() => {
    if (!notificationTaskRequest) return null;
    const taskId = resolveNotificationTaskId(
      notificationTaskRequest.target,
      state.recentTasks
    );
    return taskId
      ? { key: notificationTaskRequest.key, taskId }
      : null;
  }, [notificationTaskRequest, state.recentTasks]);

  const runOtaUpdateCheck = useCallback(async (nowMs = Date.now()) => {
    lastOtaCheckAtRef.current = nowMs;
    const result = await checkAndFetchUpdate();

    if (result.state === "downloaded") {
      hasDownloadedUpdateRef.current = true;
      setUpdatePromptVisible(true);
    }
  }, []);

  const refreshAccount = useCallback(() => {
    if (accountRefreshPromiseRef.current) {
      return accountRefreshPromiseRef.current;
    }

    const refreshPromise = Promise.resolve()
      .then(() => controller.refreshAccount())
      .catch((error: unknown) => {
        console.error("Could not refresh mobile account:", error);
      });
    accountRefreshPromiseRef.current = refreshPromise;
    void refreshPromise.then(() => {
      if (accountRefreshPromiseRef.current === refreshPromise) {
        accountRefreshPromiseRef.current = null;
      }
    });
    return refreshPromise;
  }, [controller]);

  useEffect(() => {
    let cancelled = false;
    const hydrationMutationVersion = quickReplyMutationVersionRef.current;
    void quickReplyPreferencesRef.current
      ?.then((preferences) => preferences.load())
      .then((loadResult) => {
        if (
          !cancelled &&
          quickReplyMutationVersionRef.current === hydrationMutationVersion
        ) {
          setQuickReplies(loadResult.replies);
          quickReplyLoadStatusRef.current = loadResult.status;
          setQuickReplyLoadFailed(loadResult.status === "failed");
        }
      })
      .catch(() => {
        if (!cancelled) {
          quickReplyLoadStatusRef.current = "failed";
          setQuickReplyLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setQuickRepliesHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      !accountSheetVisible ||
      state.auth.status !== "signedIn" ||
      state.auth.user.emailVerified !== false
    ) {
      return;
    }
    const interval = setInterval(() => {
      void refreshAccount();
    }, 3_000);
    return () => clearInterval(interval);
  }, [accountSheetVisible, refreshAccount, state.auth]);

  const saveQuickReplies = useCallback(
    async (
      replies: readonly TaskQuickReply[],
      confirmReplacement = false
    ) => {
      if (quickReplyLoadStatusRef.current === "pending") {
        throw new Error(
          "Quick replies cannot be saved before preferences finish loading."
        );
      }
      if (
        quickReplyLoadStatusRef.current === "failed" &&
        !confirmReplacement
      ) {
        throw new Error(
          "Quick replies cannot be replaced without confirmation."
        );
      }
      const preferences = await quickReplyPreferencesRef.current;
      if (!preferences) {
        throw new Error("Quick reply preferences are unavailable.");
      }
      const savedReplies = await preferences.save(replies, {
        confirmReplacement
      });
      quickReplyMutationVersionRef.current += 1;
      quickReplyLoadStatusRef.current = "loaded";
      setQuickReplies(savedReplies);
      setQuickReplyLoadFailed(false);
    },
    []
  );

  useEffect(() => {
    let cancelled = false;

    const finishInitialization = (error?: unknown) => {
      if (cancelled) return;
      if (error) {
        setInitializationError(
          error instanceof Error ? error.message : "Mobile initialization failed"
        );
      }
      const hydrated = model.sessionStore.getState();
      initialNavigationStateRef.current = buildInitialNavigationState({
        activeView: hydrated.activeView,
        selectedTaskId: hydrated.selectedTaskId
      });
      setInitialized(true);
      void runOtaUpdateCheck();
    };

    void model.initialize().then(
      () => finishInitialization(),
      (error) => finishInitialization(error)
    );

    return () => {
      cancelled = true;
      model.controller.dispose();
    };
  }, [model, runOtaUpdateCheck]);

  useEffect(() => {
    let previousState: AppStateStatus = AppState.currentState;
    const terminalLifecycle = createTerminalAppStateLifecycle({
      initialState: previousState,
      setTransportForeground(foreground) {
        model.setForeground?.(foreground);
      },
      setControllerForeground(foreground) {
        controller.setAppForeground(foreground);
      },
      expireTerminalGrace() {
        controller.expireTaskTerminalGrace();
      }
    });
    const subscription = AppState.addEventListener("change", (nextState) => {
      const terminalTransition = terminalLifecycle.transition(nextState);
      const foregroundAction = getForegroundTransitionAction({
        previousState,
        nextState,
        hasDownloadedUpdate: hasDownloadedUpdateRef.current
      });
      addMobileCrashBreadcrumb(
        "app-state",
        `${previousState}->${nextState} action=${foregroundAction}`
      );
      if (foregroundAction === "reload") {
        hasDownloadedUpdateRef.current = false;
        void reloadToApplyUpdate();
        previousState = nextState;
        return;
      }

      if (foregroundAction === "refresh") {
        void controller.refresh({
          preserveTaskSession: terminalTransition.preserveTerminal
        });
        const accountAuth = accountAuthRef.current;
        if (
          accountSheetVisibleRef.current &&
          accountAuth.status === "signedIn" &&
          accountAuth.user.emailVerified !== false &&
          accountAuth.user.cloudAccess === "inactive"
        ) {
          void refreshAccount();
        }
      }

      const nowMs = Date.now();
      if (
        shouldCheckForOtaUpdateOnForeground({
          previousState,
          nextState,
          nowMs,
          lastCheckAtMs: lastOtaCheckAtRef.current,
          throttleMs: OTA_FOREGROUND_CHECK_THROTTLE_MS
        })
      ) {
        void runOtaUpdateCheck(nowMs);
      }

      previousState = nextState;
    });

    return () => {
      subscription.remove();
      terminalLifecycle.dispose();
    };
  }, [controller, refreshAccount, runOtaUpdateCheck]);

  useEffect(() => {
    if (
      Platform.OS !== "ios" ||
      state.auth.status !== "signedIn" ||
      !state.mobileDeviceId
    ) {
      return;
    }
    const mobileExtra = readKannaExpoExtra(readExpoConfig());
    const relayUrl = mobileExtra?.relayUrl;
    if (!relayUrl || mobileExtra?.appEnv === "dev") return;

    let disposed = false;
    let stop: () => void = () => undefined;
    void startMobilePushNotifications({
      deviceId: state.mobileDeviceId,
      getIdToken: (forceRefresh) => model.getAuthIdToken(forceRefresh),
      relayUrl,
      onTaskOpen(target) {
        setNotificationTaskRequest((current) => ({
          key: (current?.key ?? 0) + 1,
          target
        }));
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        stop = cleanup;
      }
    }).catch((error: unknown) => {
      console.error("Mobile notification setup failed:", error);
    });

    return () => {
      disposed = true;
      stop();
    };
  }, [model, state.auth.status, state.mobileDeviceId]);

  const lanNotificationConnectionKey = state.trustedDesktops
    .map((desktop) =>
      [
        desktop.desktopId,
        desktop.deviceSecret,
        ...desktop.lanEndpoints.map((endpoint) => endpoint.baseUrl)
      ].join(":")
    )
    .sort()
    .join("|");
  useEffect(() => {
    if (!initialized || forceCloudEnabled || !lanNotificationConnectionKey) {
      return;
    }
    let disposed = false;
    let stop: () => void = () => undefined;
    void startLanMobileNotifications({
      source: model.client,
      onForeground(notification) {
        setLanNotificationBanner(notification);
      },
      onTaskOpen(target) {
        setNotificationTaskRequest((current) => ({
          key: (current?.key ?? 0) + 1,
          target
        }));
      }
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else stop = cleanup;
      })
      .catch((error: unknown) => {
        console.error("LAN notification setup failed:", error);
      });
    void model.client.listDesktops().catch((error: unknown) => {
      console.error("LAN desktop discovery failed:", error);
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [forceCloudEnabled, initialized, lanNotificationConnectionKey, model]);

  return (
    <SafeAreaView style={styles.safeArea} testID={MOBILE_E2E_IDS.appShell}>
      <View style={styles.shell}>
        {!initialized ? (
          <View style={styles.startupLoading}>
            <LoadingText
              label="Starting Kanna"
              style={styles.startupLoadingText}
              testID={MOBILE_E2E_IDS.appStartupLoading}
            />
          </View>
        ) : null}
        {initialized && initialNavigationStateRef.current ? (
          <RootNavigator
            controller={controller}
            e2eTaskSnapshotMarker={e2eTaskSnapshotMarker}
            forceCloudEnabled={forceCloudEnabled}
            initialState={initialNavigationStateRef.current}
            notificationTaskRequest={resolvedNotificationTaskRequest}
            openMachinesRequestKey={openMachinesRequestKey}
            quickReplies={quickReplies}
            quickRepliesHydrated={quickRepliesHydrated}
            state={state}
            terminalOutputSource={model.sessionStore.taskTerminalOutputSource}
            onForceCloudChange={(enabled) => {
              setForceCloudEnabled(enabled);
              model.setForceCloud(enabled);
              void controller.refresh();
            }}
            onOpenAccount={() => {
              setAccountSheetVisible(true);
              if (
                state.auth.status === "signedIn" &&
                state.auth.user.emailVerified !== false &&
                state.auth.user.cloudAccess === "inactive"
              ) {
                void refreshAccount();
              }
            }}
          />
        ) : null}
        {initializationError ? (
          <View style={styles.initializationError}>
            <Text style={styles.initializationErrorText}>
              {`Could not restore the mobile session: ${initializationError}`}
            </Text>
          </View>
        ) : null}
        {quickReplyLoadFailed ? (
          <View
            style={styles.quickReplyLoadNotice}
            testID={MOBILE_E2E_IDS.quickReplyLoadNotice}
          >
            <Text style={styles.quickReplyLoadNoticeText}>
              Quick replies could not be loaded; defaults shown.
            </Text>
          </View>
        ) : null}
        <AccountSheet
          auth={state.auth}
          machineCount={machineSummary.total}
          availableMachineCount={machineSummary.available}
          quickRepliesReady={quickRepliesHydrated}
          visible={accountSheetVisible}
          onClose={() => setAccountSheetVisible(false)}
          onOpenMachines={() => {
            setAccountSheetVisible(false);
            setOpenMachinesRequestKey((requestKey) => requestKey + 1);
          }}
          onOpenQuickReplies={() => {
            if (!quickRepliesHydrated) {
              return;
            }
            setAccountSheetVisible(false);
            setQuickReplyEditorVisible(true);
          }}
          onSignIn={(email, password) => {
            void controller.signInWithEmailPassword(email, password);
          }}
          onCreateAccount={(email, password) => {
            void controller.createUserWithEmailPassword(email, password);
          }}
          onRefreshAccount={() => {
            void refreshAccount();
          }}
          onSignOut={() => {
            void controller.signOut();
          }}
          subscriptionUrl={subscriptionUrl}
          onDeleteAccount={async () => {
            await requestMobileAccountDeletion();
            await controller.signOut();
            setAccountSheetVisible(false);
          }}
        />
        <QuickReplyEditorModal
          replies={quickReplies}
          replacementConfirmationRequired={quickReplyLoadFailed}
          visible={quickReplyEditorVisible}
          onClose={() => setQuickReplyEditorVisible(false)}
          onSave={saveQuickReplies}
        />
        {updatePromptVisible ? (
          <UpdateReadyBanner
            onDismiss={() => setUpdatePromptVisible(false)}
            onRestart={() => {
              hasDownloadedUpdateRef.current = false;
              void reloadToApplyUpdate();
            }}
          />
        ) : null}
        {lanNotificationBanner ? (
          <LanNotificationBanner
            body={lanNotificationBanner.body}
            canOpenTask={Boolean(lanNotificationBanner.taskId)}
            title={lanNotificationBanner.title}
            onDismiss={() => setLanNotificationBanner(null)}
            onOpen={() => {
              const taskId = lanNotificationBanner.taskId;
              if (taskId) {
                setNotificationTaskRequest((current) => ({
                  key: (current?.key ?? 0) + 1,
                  target: {
                    desktopId: lanNotificationBanner.desktopId,
                    taskId
                  }
                }));
              }
              setLanNotificationBanner(null);
            }}
          />
        ) : null}
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <MobileCrashBoundary>
      <AppContent />
    </MobileCrashBoundary>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: "#08111E",
    flex: 1
  },
  shell: {
    flex: 1
  },
  startupLoading: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center"
  },
  startupLoadingText: {
    color: "#93A7C8",
    fontSize: 15
  },
  initializationError: {
    backgroundColor: "#612124",
    borderRadius: 12,
    left: 16,
    padding: 12,
    position: "absolute",
    right: 16,
    top: 12,
    zIndex: 10
  },
  initializationErrorText: {
    color: "#FFC7CE",
    fontSize: 14
  },
  quickReplyLoadNotice: {
    backgroundColor: "#6A4B12",
    borderRadius: 12,
    bottom: 16,
    left: 16,
    padding: 12,
    position: "absolute",
    right: 16,
    zIndex: 10
  },
  quickReplyLoadNoticeText: {
    color: "#FFE5A3",
    fontSize: 14
  }
});
