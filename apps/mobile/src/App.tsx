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
  type LayoutChangeEvent,
  SafeAreaView,
  StyleSheet,
  Text,
  View
} from "react-native";
import {
  getShellTitle,
  isTaskDetailVisible,
  shouldShowFloatingToolbar,
  shouldShowTopBar
} from "./appShell";
import {
  getForegroundTransitionAction,
  shouldCheckForOtaUpdateOnForeground
} from "./appLifecycle";
import { createAppModel, resolveForceCloud, type AppModel } from "./appModel";
import { resolveMobileTerminalGeometry } from "./mobileTerminalGeometry";
import { AccountBadge } from "./components/AccountBadge";
import { AccountSheet } from "./components/AccountSheet";
import { FloatingToolbar } from "./components/FloatingToolbar";
import { CreateTaskComposer } from "./components/CreateTaskComposer";
import { UpdateReadyBanner } from "./components/UpdateReadyBanner";
import { MOBILE_E2E_IDS } from "./e2eTestIds";
import {
  checkAndFetchUpdate,
  reloadToApplyUpdate
} from "./lib/updates/otaUpdates";
import { MachinesScreen } from "./screens/MachinesScreen";
import { MoreScreen } from "./screens/MoreScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { TaskScreen } from "./screens/TaskScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { buildMachineInventory, summarizeMachines } from "./state/machineInventory";
import {
  projectTaskUiSlots,
  taskUiSlotForSelection,
  taskUiSlotToTaskSummary
} from "./state/taskUiSlots";
import type { MobileView } from "./state/sessionStore";

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
  const { controller, navigator } = model;
  const [accountSheetVisible, setAccountSheetVisible] = useState(false);
  const [machinePairingVisible, setMachinePairingVisible] = useState(false);
  const [forceCloudEnabled, setForceCloudEnabled] = useState(resolveForceCloud());
  const [searchFocusRequestKey, setSearchFocusRequestKey] = useState(0);
  const [updatePromptVisible, setUpdatePromptVisible] = useState(false);
  const lastOtaCheckAtRef = useRef<number | null>(null);
  const hasDownloadedUpdateRef = useRef(false);
  const taskDetailViewportRef = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const machinesReturnViewRef = useRef<MobileView>("tasks");
  const machines = useMemo(
    () => buildMachineInventory({
      accountDesktops: state.accountDesktops,
      manualDesktops: state.trustedDesktops,
      liveLanDesktops: state.liveLanDesktops
    }),
    [state.accountDesktops, state.liveLanDesktops, state.trustedDesktops]
  );
  const composerMachines = useMemo(
    () => machines.map((machine) => ({
      id: machine.desktopId,
      name: machine.displayName,
      online: machine.availability.lan || machine.availability.cloud,
      mode: machine.availability.cloud ? "remote" as const : "lan" as const,
      reachableViaRelay: machine.availability.cloud,
      connectionMode:
        machine.availability.lan && machine.availability.cloud
          ? "both" as const
          : machine.availability.lan
            ? "lan" as const
            : "internet" as const,
      lastSeenAt: machine.availability.lastSeenAt
    })),
    [machines]
  );
  const machineSummary = useMemo(() => summarizeMachines(machines), [machines]);
  const authoritativeTasks = [
    ...new Map(
      [...state.repoTasks, ...state.recentTasks, ...state.searchResults].map(
        (task) => [task.id, task] as const
      )
    ).values()
  ];
  const taskUiSlots = projectTaskUiSlots(
    authoritativeTasks,
    state.taskUiSlots
  );
  const selectedTaskSlot = taskUiSlotForSelection(
    taskUiSlots,
    state.selectedTaskId
  );
  const selectedTask = selectedTaskSlot
    ? taskUiSlotToTaskSummary(selectedTaskSlot)
    : null;
  const selectedDurableTaskId = selectedTaskSlot?.taskId ?? null;
  const selectedTaskCreationPhase =
    selectedTaskSlot?.state === "creating" &&
    state.pendingTaskCreation?.slotId === selectedTaskSlot.slotId
      ? state.taskCreationPhase
      : "idle";
  const e2eTaskSnapshotMarker =
    process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED === "1"
      ? state.recentTasks
          .map((task) => `${task.id}:${task.title ?? ""}`)
          .join("\n")
      : undefined;
  const taskDetailVisible = isTaskDetailVisible(
    state.connectionState,
    selectedTask !== null,
    state.activeView
  );

  const openMachinesFromProfile = useCallback(() => {
    if (state.activeView !== "desktops") {
      machinesReturnViewRef.current = state.activeView;
    }
    setAccountSheetVisible(false);
    controller.showView("desktops");
  }, [controller, state.activeView]);

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

    void model.initialize().then(() => {
      if (!cancelled) {
        void runOtaUpdateCheck();
      }
    });

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
  }, [controller, model]);

  const mainContent = (() => {
    if (selectedTask && taskDetailVisible) {
      return (
        <TaskScreen
          e2eTaskSnapshotMarker={e2eTaskSnapshotMarker}
          task={selectedTask}
          terminalErrorMessage={state.taskTerminalErrorMessage}
          terminalOutput={state.taskTerminalOutput}
          terminalOutputEpoch={state.taskTerminalOutputEpoch}
          terminalOutputStart={state.taskTerminalOutputStart}
          terminalStatus={state.taskTerminalStatus}
          terminalCols={state.taskTerminalCols}
          terminalRows={state.taskTerminalRows}
          agentErrorMessage={state.taskAgentErrorMessage}
          agentEvents={state.taskAgentEvents}
          agentStatus={state.taskAgentStatus}
          taskCreationPhase={selectedTaskCreationPhase}
          taskCreationErrorMessage={
            selectedTaskCreationPhase === "idle"
              ? null
              : state.composerErrorMessage
          }
          onBack={() => controller.closeTask()}
          onAdvanceTaskStage={() => {
            if (selectedDurableTaskId) {
              void controller.advanceDesktopTaskStage(selectedDurableTaskId);
            }
          }}
          onCloseTask={() => {
            if (selectedDurableTaskId) {
              void controller.closeDesktopTask(selectedDurableTaskId);
            }
          }}
          onReadTaskFile={(path) => {
            if (!selectedDurableTaskId) {
              return Promise.reject(
                new Error("Task creation is still in progress.")
              );
            }
            return controller.readTaskFile(selectedDurableTaskId, path);
          }}
          onSendInput={(input) => {
            if (selectedDurableTaskId) {
              void controller.sendTaskInput(selectedDurableTaskId, input);
            }
          }}
          onStopAgent={() => {
            if (selectedDurableTaskId) {
              controller.interruptTaskAgent(selectedDurableTaskId);
            }
          }}
          onResolveAgentPermission={(requestId, decision) => {
            if (selectedDurableTaskId) {
              controller.sendTaskAgentPermission(
                selectedDurableTaskId,
                requestId,
                decision
              );
            }
          }}
          onRecoverTaskCreation={() => {
            void controller.recoverTaskCreation();
          }}
        />
      );
    }

    switch (state.activeView) {
      case "recent":
        return (
          <TasksScreen
            heading="Recent"
            repos={state.repos}
            selectedRepoId={state.selectedRepoId}
            taskSlots={projectTaskUiSlots(
              state.recentTasks,
              state.taskUiSlots
            )}
            onSelectRepo={(repoId) => {
              void controller.selectRepo(repoId);
            }}
            onOpenTask={(taskId) => controller.openTask(taskId)}
          />
        );
      case "desktops":
        return (
          <MachinesScreen
            machines={machines}
            sourceWarnings={state.machineSourceWarnings}
            pairingVisible={machinePairingVisible}
            onBack={() => {
              setMachinePairingVisible(false);
              controller.showView(machinesReturnViewRef.current);
            }}
            onOpenPairing={() => setMachinePairingVisible(true)}
            onClosePairing={() => setMachinePairingVisible(false)}
            onPairCode={async (code) => {
              await controller.pairMachineByCode(code);
              setMachinePairingVisible(false);
            }}
            onPairPayload={async (payload) => {
              await controller.pairMachineByPayload(payload);
              setMachinePairingVisible(false);
            }}
            onRemoveManual={(desktopId) => controller.removeManualMachine(desktopId)}
          />
        );
      case "search":
        return (
          <SearchScreen
            focusRequestKey={searchFocusRequestKey}
            query={state.searchQuery}
            results={state.searchResults}
            onChangeQuery={(query) => {
              void controller.searchTasks(query);
            }}
            onOpenTask={(taskId) => controller.openTask(taskId)}
          />
        );
      case "more":
        return (
          <MoreScreen
            forceCloudEnabled={forceCloudEnabled}
            showDeveloperDiagnostics={__DEV__ === true}
            refreshStatus={state.refreshStatus}
            selectedTask={selectedDurableTaskId ? selectedTask : null}
            onRefresh={() => {
              void controller.refresh();
            }}
            onForceCloudChange={(enabled) => {
              setForceCloudEnabled(enabled);
              model.setForceCloud(enabled);
              void controller.refresh();
            }}
            onOpenComposer={() => controller.openComposer()}
            onAdvanceTaskStage={(taskId) => {
              void controller.advanceDesktopTaskStage(taskId);
            }}
            onRunMergeAgent={(taskId) => {
              void controller.runMergeAgent(taskId);
            }}
            onCloseTask={(taskId) => {
              void controller.closeDesktopTask(taskId);
            }}
          />
        );
      case "tasks":
      default:
        return (
          <TasksScreen
            repos={state.repos}
            selectedRepoId={state.selectedRepoId}
            taskSlots={projectTaskUiSlots(
              state.repoTasks,
              state.taskUiSlots
            )}
            onSelectRepo={(repoId) => {
              void controller.selectRepo(repoId);
            }}
            onOpenTask={(taskId) => controller.openTask(taskId)}
          />
        );
    }
  })();

  const toolbarTab = (() => {
    switch (state.activeView) {
      case "recent":
        return "recent";
      case "desktops":
        return "desktops";
      case "more":
        return "more";
      case "search":
      case "tasks":
      default:
        return "tasks";
    }
  })();
  const shellTitle = getShellTitle(state.activeView);

  return (
    <SafeAreaView style={styles.safeArea} testID={MOBILE_E2E_IDS.appShell}>
      <View
        style={[styles.shell, taskDetailVisible ? styles.shellTaskDetail : null]}
        onLayout={(event: LayoutChangeEvent) => {
          const { width, height } = event.nativeEvent.layout;
          taskDetailViewportRef.current = { width, height };
        }}
      >
        {state.errorMessage && state.connectionState === "connected" && !taskDetailVisible ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{state.errorMessage}</Text>
          </View>
        ) : null}

        {shouldShowTopBar(taskDetailVisible, state.activeView) ? (
          <View style={styles.topBar}>
            <Text numberOfLines={1} style={styles.topBarTitle}>
              {shellTitle}
            </Text>
            <AccountBadge
              auth={state.auth}
              onPress={() => setAccountSheetVisible(true)}
            />
          </View>
        ) : null}

        {mainContent}

        {shouldShowFloatingToolbar(taskDetailVisible, state.activeView) ? (
          <FloatingToolbar
            activeTab={toolbarTab}
            utilityActions={navigator.utilityActions}
            onSelectTab={(tab) => controller.showView(tab)}
            onSelectUtilityAction={(action) => {
              if (action === "search") {
                setSearchFocusRequestKey((requestKey) => requestKey + 1);
                controller.showView("search");
                return;
              }

              controller.openComposer();
            }}
            tabs={navigator.tabs}
          />
        ) : null}

        <CreateTaskComposer
          isOpen={state.isComposerOpen}
          prompt={state.composerPrompt}
          repos={state.repos}
          desktops={composerMachines}
          selectedRepoId={state.composerRepoId}
          selectedDesktopId={state.composerDesktopId}
          selectedAgentProvider={state.composerAgentProvider}
          isOptionsExpanded={state.isComposerOptionsExpanded}
          errorMessage={state.composerErrorMessage}
          onClose={() => controller.closeComposer()}
          onSelectDesktop={(desktopId) => controller.selectComposerDesktop(desktopId)}
          onSelectAgentProvider={(provider) => controller.selectComposerAgentProvider(provider)}
          onToggleOptions={() =>
            controller.setComposerOptionsExpanded(!state.isComposerOptionsExpanded)
          }
          onChangePrompt={(prompt) => controller.updateComposerPrompt(prompt)}
          onSubmit={() => {
            void controller.createTask(
              resolveMobileTerminalGeometry(taskDetailViewportRef.current)
            );
          }}
        />
        <AccountSheet
          auth={state.auth}
          machineCount={machineSummary.total}
          availableMachineCount={machineSummary.available}
          visible={accountSheetVisible}
          onClose={() => setAccountSheetVisible(false)}
          onOpenMachines={openMachinesFromProfile}
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
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 18
  },
  shellTaskDetail: {
    paddingHorizontal: 0,
    paddingTop: 0
  },
  topBar: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    justifyContent: "space-between",
    marginBottom: 18
  },
  topBarTitle: {
    color: "#F5F7FB",
    flex: 1,
    fontSize: 30,
    fontWeight: "800"
  },
  errorBanner: {
    backgroundColor: "rgba(97, 33, 36, 0.38)",
    borderColor: "rgba(214, 102, 114, 0.34)",
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 12,
    padding: 14
  },
  errorText: {
    color: "#FFC7CE",
    fontSize: 14,
    lineHeight: 20
  }
});
