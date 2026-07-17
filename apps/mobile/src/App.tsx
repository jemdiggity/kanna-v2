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
  type AppStateStatus,
  SafeAreaView,
  StyleSheet,
  Text,
  View
} from "react-native";
import type { InitialState } from "@react-navigation/native";
import {
  getForegroundTransitionAction,
  shouldCheckForOtaUpdateOnForeground
} from "./appLifecycle";
import { createAppModel, resolveForceCloud, type AppModel } from "./appModel";
import { AccountSheet } from "./components/AccountSheet";
import { UpdateReadyBanner } from "./components/UpdateReadyBanner";
import { MOBILE_E2E_IDS } from "./e2eTestIds";
import {
  checkAndFetchUpdate,
  reloadToApplyUpdate
} from "./lib/updates/otaUpdates";
import RootNavigator from "./navigation/RootNavigator";
import { buildInitialNavigationState } from "./navigation/navigationState";
import { buildMachineInventory, summarizeMachines } from "./state/machineInventory";

const OTA_FOREGROUND_CHECK_THROTTLE_MS = 5 * 60 * 1000;

export default function App() {
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
  const [accountSheetVisible, setAccountSheetVisible] = useState(false);
  const [forceCloudEnabled, setForceCloudEnabled] = useState(resolveForceCloud());
  const [openMachinesRequestKey, setOpenMachinesRequestKey] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [updatePromptVisible, setUpdatePromptVisible] = useState(false);
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
  const e2eTaskSnapshotMarker =
    process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED === "1"
      ? state.recentTasks
          .map((task) => `${task.id}:${task.title ?? ""}`)
          .join("\n")
      : undefined;

  const runOtaUpdateCheck = useCallback(async (nowMs = Date.now()) => {
    lastOtaCheckAtRef.current = nowMs;
    const result = await checkAndFetchUpdate();

    if (result.state === "downloaded") {
      hasDownloadedUpdateRef.current = true;
      setUpdatePromptVisible(true);
    }
  }, []);

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
    };
  }, [model, runOtaUpdateCheck]);

  useEffect(() => {
    let previousState: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener("change", (nextState) => {
      const foregroundAction = getForegroundTransitionAction({
        previousState,
        nextState,
        hasDownloadedUpdate: hasDownloadedUpdateRef.current
      });
      if (foregroundAction === "reload") {
        hasDownloadedUpdateRef.current = false;
        void reloadToApplyUpdate();
        previousState = nextState;
        return;
      }

      if (foregroundAction === "refresh") {
        void controller.refresh();
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
    };
  }, [controller, runOtaUpdateCheck]);

  return (
    <SafeAreaView style={styles.safeArea} testID={MOBILE_E2E_IDS.appShell}>
      <View style={styles.shell}>
        {initialized && initialNavigationStateRef.current ? (
          <RootNavigator
            controller={controller}
            e2eTaskSnapshotMarker={e2eTaskSnapshotMarker}
            forceCloudEnabled={forceCloudEnabled}
            initialState={initialNavigationStateRef.current}
            openMachinesRequestKey={openMachinesRequestKey}
            state={state}
            onForceCloudChange={(enabled) => {
              setForceCloudEnabled(enabled);
              model.setForceCloud(enabled);
              void controller.refresh();
            }}
            onOpenAccount={() => setAccountSheetVisible(true)}
          />
        ) : null}
        {initializationError ? (
          <View style={styles.initializationError}>
            <Text style={styles.initializationErrorText}>
              {`Could not restore the mobile session: ${initializationError}`}
            </Text>
          </View>
        ) : null}
        <AccountSheet
          auth={state.auth}
          machineCount={machineSummary.total}
          availableMachineCount={machineSummary.available}
          visible={accountSheetVisible}
          onClose={() => setAccountSheetVisible(false)}
          onOpenMachines={() => {
            setAccountSheetVisible(false);
            setOpenMachinesRequestKey((requestKey) => requestKey + 1);
          }}
          onSignIn={(email, password) => {
            void controller.signInWithEmailPassword(email, password);
          }}
          onSignOut={() => {
            void controller.signOut();
          }}
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
      </View>
    </SafeAreaView>
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
  }
});
