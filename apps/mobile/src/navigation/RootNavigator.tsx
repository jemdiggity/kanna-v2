import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  DefaultTheme,
  NavigationContainer,
  StackActions,
  useFocusEffect,
  useIsFocused,
  useNavigationContainerRef,
  type InitialState,
  type NavigationState
} from "@react-navigation/native";
import {
  createBottomTabNavigator,
  type BottomTabBarProps
} from "@react-navigation/bottom-tabs";
import {
  createNativeStackNavigator,
  type NativeStackScreenProps
} from "@react-navigation/native-stack";
import {
  type LayoutChangeEvent,
  StyleSheet,
  Text,
  View
} from "react-native";
import type { ScrollView as NativeScrollView } from "react-native";
import { AccountBadge } from "../components/AccountBadge";
import { CreateTaskComposer } from "../components/CreateTaskComposer";
import { FloatingToolbar } from "../components/FloatingToolbar";
import { resolveMobileTerminalGeometry } from "../mobileTerminalGeometry";
import { resolveBlockerTasks } from "../lib/api/taskIdentity";
import { MachinesScreen } from "../screens/MachinesScreen";
import { MoreScreen } from "../screens/MoreScreen";
import { filterCommandAvailableRepos } from "../screens/repoCommandPresentation";
import { SearchScreen } from "../screens/SearchScreen";
import { TaskScreen } from "../screens/TaskScreen";
import type { TaskQuickReply } from "../screens/taskQuickReplies";
import { TasksScreen } from "../screens/TasksScreen";
import type { MobileController } from "../state/mobileController";
import { buildMachineInventory } from "../state/machineInventory";
import type {
  SessionState,
  TaskTerminalOutputSource
} from "../state/sessionStore";
import {
  projectTaskUiSlots,
  taskUiSlotForSelection,
  taskUiSlotToTaskSummary
} from "../state/taskUiSlots";
import {
  createRootNavigator,
  MAIN_TAB_ROUTES,
  ROOT_STACK_ROUTES,
  UTILITY_ACTIONS
} from "./navigationConfig";
import {
  projectActiveView,
  type MainTabParamList,
  type RootStackParamList
} from "./navigationState";
import {
  planTaskDetailNavigation,
  resolveFocusedTaskRouteIdentity,
  resolvePendingTaskCreationRoute,
  resolveTaskCleanupIdentity
} from "./taskNavigation";
import { useTabReselectionScrollToTop } from "./useTabReselectionScrollToTop";

export type {
  RootNavigatorModel,
  TabName,
  TabRoute,
  UtilityAction
} from "./navigationConfig";
export {
  createRootNavigator,
  MAIN_TAB_ROUTES,
  ROOT_STACK_ROUTES,
  UTILITY_ACTIONS
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTabs = createBottomTabNavigator<MainTabParamList>();
const KANNA_NAVIGATION_THEME = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: "#08111E"
  }
};

interface RootNavigatorProps {
  controller: MobileController;
  e2eTaskSnapshotMarker?: string;
  forceCloudEnabled: boolean;
  initialState: InitialState;
  notificationTaskRequest?: {
    key: number;
    taskId: string;
  } | null;
  openMachinesRequestKey: number;
  onForceCloudChange(enabled: boolean): void;
  onOpenAccount(): void;
  quickReplies: readonly TaskQuickReply[];
  quickRepliesHydrated: boolean;
  state: SessionState;
  terminalOutputSource?: TaskTerminalOutputSource;
}

interface NavigationContent {
  controller: MobileController;
  e2eTaskSnapshotMarker?: string;
  forceCloudEnabled: boolean;
  onForceCloudChange(enabled: boolean): void;
  onOpenAccount(): void;
  openComposer(): void;
  pushDesktops(): void;
  pushPreparedTask(taskId: string): void;
  pushSearch(): void;
  pushTask(taskId: string): void;
  quickReplies: readonly TaskQuickReply[];
  quickRepliesHydrated: boolean;
  state: SessionState;
  terminalOutputSource?: TaskTerminalOutputSource;
  taskDetailViewportRef: React.MutableRefObject<{
    width: number;
    height: number;
  } | null>;
}

const NavigationContentContext = createContext<NavigationContent | null>(null);

export default function RootNavigator({
  controller,
  e2eTaskSnapshotMarker,
  forceCloudEnabled,
  initialState,
  notificationTaskRequest = null,
  openMachinesRequestKey,
  onForceCloudChange,
  onOpenAccount,
  quickReplies,
  quickRepliesHydrated,
  state,
  terminalOutputSource
}: RootNavigatorProps) {
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  const taskDetailViewportRef = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const pendingTaskRouteRef = useRef<string | null>(null);
  const previousOpenMachinesRequestKeyRef = useRef(openMachinesRequestKey);
  const handledNotificationRequestKeyRef = useRef<number | null>(null);

  const pushPreparedTask = useCallback((taskId: string) => {
    if (!navigationRef.isReady()) return;
    const rootState = navigationRef.getRootState();
    const plan = planTaskDetailNavigation({
      index: rootState.index,
      pendingTaskId: pendingTaskRouteRef.current,
      routes: rootState.routes,
      taskId
    });
    if (plan.type === "none") return;

    pendingTaskRouteRef.current = taskId;
    navigationRef.dispatch(
      plan.type === "push"
        ? StackActions.push("TaskDetail", { taskId })
        : plan.type === "replace"
          ? StackActions.replace("TaskDetail", { taskId })
          : StackActions.popTo("TaskDetail", { taskId })
    );
  }, [navigationRef]);
  const pushTask = useCallback((taskId: string) => {
    controller.openTask(taskId);
    pushPreparedTask(taskId);
  }, [controller, pushPreparedTask]);
  useEffect(() => {
    if (
      !notificationTaskRequest ||
      handledNotificationRequestKeyRef.current === notificationTaskRequest.key
    ) {
      return;
    }
    handledNotificationRequestKeyRef.current = notificationTaskRequest.key;
    pushTask(notificationTaskRequest.taskId);
  }, [notificationTaskRequest, pushTask]);
  const pushSearch = useCallback(() => {
    if (navigationRef.isReady()) {
      navigationRef.dispatch(StackActions.push("Search"));
    }
  }, [navigationRef]);
  const pushDesktops = useCallback(() => {
    if (navigationRef.isReady()) {
      navigationRef.dispatch(StackActions.push("Desktops"));
    }
  }, [navigationRef]);
  useEffect(() => {
    if (previousOpenMachinesRequestKeyRef.current === openMachinesRequestKey) return;
    previousOpenMachinesRequestKeyRef.current = openMachinesRequestKey;
    pushDesktops();
  }, [openMachinesRequestKey, pushDesktops]);

  const content = useMemo<NavigationContent>(() => ({
    controller,
    e2eTaskSnapshotMarker,
    forceCloudEnabled,
    onForceCloudChange,
    onOpenAccount,
    openComposer: () => controller.openComposer(),
    pushDesktops,
    pushPreparedTask,
    pushSearch,
    pushTask,
    quickReplies,
    quickRepliesHydrated,
    state,
    terminalOutputSource,
    taskDetailViewportRef
  }), [
    controller,
    e2eTaskSnapshotMarker,
    forceCloudEnabled,
    onForceCloudChange,
    onOpenAccount,
    pushDesktops,
    pushPreparedTask,
    pushSearch,
    pushTask,
    quickReplies,
    quickRepliesHydrated,
    state,
    terminalOutputSource
  ]);

  return (
    <NavigationContentContext.Provider value={content}>
      <View
        style={styles.navigatorHost}
        onLayout={(event: LayoutChangeEvent) => {
          const { width, height } = event.nativeEvent.layout;
          taskDetailViewportRef.current = { width, height };
        }}
      >
        <NavigationContainer
          initialState={initialState}
          ref={navigationRef}
          theme={KANNA_NAVIGATION_THEME}
          onStateChange={(navigationState?: NavigationState) => {
            pendingTaskRouteRef.current = null;
            controller.setNavigationView(projectActiveView(navigationState));
          }}
        >
          <RootStack.Navigator
            screenOptions={{
              contentStyle: styles.stackContent,
              headerBackTitle: "Back",
              headerStyle: styles.header,
              headerTintColor: "#F5F7FB",
              headerTitleStyle: styles.headerTitle
            }}
          >
            <RootStack.Screen
              component={MainTabsRoute}
              name="MainTabs"
              options={{ headerShown: false }}
            />
            <RootStack.Screen
              component={TaskDetailRoute}
              name="TaskDetail"
              options={{
                fullScreenGestureEnabled: false,
                gestureDirection: "horizontal",
                gestureEnabled: true,
                headerShown: false
              }}
            />
            <RootStack.Screen
              component={SearchRoute}
              name="Search"
              options={{ title: "" }}
            />
            <RootStack.Screen
              component={DesktopsRoute}
              name="Desktops"
              options={{ headerShown: false }}
            />
          </RootStack.Navigator>
        </NavigationContainer>
        <ComposerOverlay />
      </View>
    </NavigationContentContext.Provider>
  );
}

function MainTabsRoute() {
  return (
    <MainTabs.Navigator
      screenOptions={{ headerShown: false }}
      tabBar={(props: BottomTabBarProps) => <NavigatorTabBar {...props} />}
    >
      <MainTabs.Screen component={TasksTabRoute} name="Tasks" />
      <MainTabs.Screen component={ActivityTabRoute} name="Activity" />
      <MainTabs.Screen component={MoreTabRoute} name="More" />
    </MainTabs.Navigator>
  );
}

function NavigatorTabBar(props: BottomTabBarProps) {
  const { openComposer, pushSearch } = useNavigationContent();

  return (
    <FloatingToolbar
      {...props}
      onSelectUtilityAction={(action) => {
        if (action === "search") {
          pushSearch();
        } else {
          openComposer();
        }
      }}
    />
  );
}

function TasksTabRoute() {
  const { controller, pushDesktops, pushTask, state } = useNavigationContent();
  const scrollViewRef = useTabReselectionScrollToTop();
  const needsDesktopSetup =
    state.auth.status === "signedOut" &&
    state.accountDesktops.length === 0 &&
    state.liveLanDesktops.length === 0 &&
    state.trustedDesktops.length === 0;
  return (
    <StandardScreen title="Tasks">
      <TasksScreen
        needsDesktopSetup={needsDesktopSetup}
        repos={state.repos}
        selectedRepoId={state.selectedRepoId}
        taskCollectionStatus={state.taskCollectionStatus}
        taskSlots={projectTaskUiSlots(state.repoTasks, state.taskUiSlots)}
        scrollViewRef={scrollViewRef}
        onOpenMachines={pushDesktops}
        onSelectRepo={(repoId) => {
          void controller.selectRepo(repoId);
        }}
        onOpenTask={pushTask}
      />
    </StandardScreen>
  );
}

function ActivityTabRoute() {
  const { controller, pushTask, state } = useNavigationContent();
  const scrollViewRef = useTabReselectionScrollToTop();
  return (
    <StandardScreen title="Activity">
      <TasksScreen
        heading="Recent"
        repos={state.repos}
        selectedRepoId={state.selectedRepoId}
        taskCollectionStatus={state.taskCollectionStatus}
        taskSlots={projectTaskUiSlots(state.recentTasks, state.taskUiSlots)}
        scrollViewRef={scrollViewRef}
        onSelectRepo={(repoId) => {
          void controller.selectRepo(repoId);
        }}
        onOpenTask={pushTask}
      />
    </StandardScreen>
  );
}

function MoreTabRoute() {
  const scrollViewRef = useTabReselectionScrollToTop();
  return (
    <StandardScreen title="More">
      <MoreRouteContent scrollViewRef={scrollViewRef} />
    </StandardScreen>
  );
}

function SearchRoute() {
  const { controller, pushTask, state } = useNavigationContent();
  return (
    <UtilityScreen>
      <SearchScreen
        focusRequestKey={1}
        query={state.searchQuery}
        results={state.searchResults}
        onChangeQuery={(query) => {
          void controller.searchTasks(query);
        }}
        onOpenTask={pushTask}
      />
    </UtilityScreen>
  );
}

function DesktopsRoute({ navigation }: NativeStackScreenProps<RootStackParamList, "Desktops">) {
  const { controller, state } = useNavigationContent();
  const [pairingVisible, setPairingVisible] = useState(false);
  const machines = useMemo(
    () => buildMachineInventory({
      accountDesktops: state.accountDesktops,
      manualDesktops: state.trustedDesktops,
      liveLanDesktops: state.liveLanDesktops
    }),
    [state.accountDesktops, state.liveLanDesktops, state.trustedDesktops]
  );
  return (
    <UtilityScreen>
      <MachinesScreen
        machines={machines}
        sourceWarnings={state.machineSourceWarnings}
        pairingVisible={pairingVisible}
        onBack={() => navigation.goBack()}
        onOpenPairing={() => setPairingVisible(true)}
        onClosePairing={() => setPairingVisible(false)}
        onPairCode={async (code) => {
          await controller.pairMachineByCode(code);
          setPairingVisible(false);
        }}
        onPairPayload={async (payload) => {
          await controller.pairMachineByPayload(payload);
          setPairingVisible(false);
        }}
        onRemoveManual={(desktopId) => controller.removeManualMachine(desktopId)}
      />
    </UtilityScreen>
  );
}

function MoreRouteContent({
  scrollViewRef
}: {
  scrollViewRef: React.RefObject<NativeScrollView | null>;
}) {
  const { controller, pushPreparedTask, state } = useNavigationContent();
  const commandRepos = filterCommandAvailableRepos(
    state.repos,
    state.unavailableRepoCommandIds,
    state.selectedRepoId
  );

  return (
    <MoreScreen
      catalog={state.repoCommandCatalog}
      errorMessage={state.repoCommandErrorMessage}
      onRetry={() => {
        void controller.retryRepoCommand().then((taskId) => {
          if (taskId) pushPreparedTask(taskId);
        });
      }}
      onRunCommand={(commandId) => {
        void controller.runRepoCommand(commandId).then((taskId) => {
          if (taskId) pushPreparedTask(taskId);
        });
      }}
      onSelectRepo={(repoId) => {
        void controller.selectRepo(repoId);
      }}
      repos={commandRepos}
      runningCommandId={state.runningRepoCommandId}
      scrollViewRef={scrollViewRef}
      selectedRepoId={state.selectedRepoId}
      status={state.repoCommandStatus}
    />
  );
}

function TaskDetailRoute({
  navigation,
  route
}: NativeStackScreenProps<RootStackParamList, "TaskDetail">) {
  const {
    controller,
    e2eTaskSnapshotMarker,
    quickReplies,
    quickRepliesHydrated,
    state,
    terminalOutputSource
  } = useNavigationContent();
  const routeTaskId = route.params.taskId;
  const routeTask = resolveTask(state, routeTaskId);
  const selectedTask = state.selectedTaskId
    ? resolveTask(state, state.selectedTaskId)
    : null;
  const isFocused = useIsFocused();
  const taskId = resolveFocusedTaskRouteIdentity({
    focused: isFocused,
    routeTaskExists: routeTask !== null,
    routeTaskId,
    selectedTaskExists: selectedTask !== null,
    selectedTaskId: state.selectedTaskId
  });
  const task = taskId === routeTaskId ? routeTask : selectedTask;
  const cleanupTaskId = resolveTaskCleanupIdentity({
    routeTaskExists: routeTask !== null,
    routeTaskId,
    selectedTaskExists: selectedTask !== null,
    selectedTaskId: state.selectedTaskId
  });
  const selectedTaskIdRef = useRef(state.selectedTaskId);
  const cleanupTaskIdRef = useRef(cleanupTaskId);
  selectedTaskIdRef.current = state.selectedTaskId;
  cleanupTaskIdRef.current = cleanupTaskId;

  useFocusEffect(
    useCallback(() => {
      if (selectedTaskIdRef.current !== taskId) {
        controller.openTask(taskId);
      }
      controller.setTaskDetailVisible(true);
      return () => controller.setTaskDetailVisible(false);
    }, [controller, taskId])
  );

  useEffect(
    () => () => controller.closeTask(cleanupTaskIdRef.current),
    [controller]
  );

  useEffect(() => {
    if (taskId !== routeTaskId) {
      navigation.setParams({ taskId });
    }
  }, [navigation, routeTaskId, taskId]);

  useEffect(() => {
    if (
      state.connectionState === "connected" &&
      state.selectedTaskId === null &&
      navigation.canGoBack()
    ) {
      navigation.goBack();
    }
  }, [navigation, state.connectionState, state.selectedTaskId]);

  if (!task) {
    return <View style={styles.taskPlaceholder} />;
  }

  const creationSlot = taskUiSlotForSelection(
    state.taskUiSlots,
    routeTaskId
  );
  const creationAttempt =
    creationSlot?.state === "creating"
      ? state.taskCreationAttempts.find(
          (attempt) => attempt.slotId === creationSlot.slotId
        ) ?? null
      : null;
  const pendingTaskAction =
    creationAttempt?.pendingAction ??
    (state.pendingTaskAction &&
    state.pendingTaskAction.taskId ===
      (resolveDurableTaskId(state, routeTaskId) ?? routeTaskId)
      ? state.pendingTaskAction.action
      : null);

  return (
    <TaskScreen
      blockerTasks={resolveBlockerTasks(task, visibleTasks(state))}
      e2eTaskSnapshotMarker={e2eTaskSnapshotMarker}
      task={task}
      terminalErrorMessage={state.taskTerminalErrorMessage}
      terminalOutput={state.taskTerminalOutput}
      terminalOutputEpoch={state.taskTerminalOutputEpoch}
      terminalOutputStart={state.taskTerminalOutputStart}
      terminalOutputSource={terminalOutputSource}
      terminalStatus={state.taskTerminalStatus}
      agentErrorMessage={state.taskAgentErrorMessage}
      agentEvents={state.taskAgentEvents}
      agentStatus={state.taskAgentStatus}
      companionStatus={state.taskCompanionStatus}
      companionSnapshot={state.taskCompanionSnapshot}
      companionUnread={state.taskCompanionUnread}
      companionErrorMessage={state.taskCompanionErrorMessage}
      companionEventStatus={state.taskCompanionEventStatus}
      quickReplies={quickReplies}
      quickRepliesHydrated={quickRepliesHydrated}
      pendingTaskAction={pendingTaskAction}
      taskCreationPhase={resolveTaskCreationPhase(state, routeTaskId)}
      taskCreationErrorMessage={creationAttempt?.errorMessage ?? null}
      onBack={() => {
        if (!navigation.canGoBack()) {
          return false;
        }
        navigation.goBack();
        return true;
      }}
      onAdvanceTaskStage={() => {
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        if (durableTaskId) {
          void controller.advanceDesktopTaskStage(durableTaskId);
        }
      }}
      onCloseTask={() => {
        const slot = taskUiSlotForSelection(state.taskUiSlots, routeTaskId);
        if (slot?.state === "creating") {
          void controller.abortTaskCreation(slot.slotId);
          return;
        }
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        if (durableTaskId) {
          void controller.closeDesktopTask(durableTaskId);
        }
      }}
      onResolveTaskFileMentions={(mentions) => {
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        return durableTaskId
          ? controller.resolveTaskFileMentions(durableTaskId, mentions)
          : Promise.reject(new Error("Task creation is still in progress."));
      }}
      onReadTaskFile={(path) => {
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        return durableTaskId
          ? controller.readTaskFile(durableTaskId, path)
          : Promise.reject(new Error("Task creation is still in progress."));
      }}
      onReadTaskDiff={(request) => {
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        return durableTaskId
          ? controller.readTaskDiff(durableTaskId, request)
          : Promise.reject(new Error("Task creation is still in progress."));
      }}
      onSendInput={(input) => {
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        if (durableTaskId) {
          void controller.sendTaskInput(durableTaskId, input);
        }
      }}
      onSendTerminalInput={(dataB64) => {
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        if (durableTaskId) {
          controller.sendTaskTerminalInput(durableTaskId, dataB64);
        }
      }}
      onResizeTerminal={(cols, rows) => {
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        if (durableTaskId) {
          controller.resizeTaskTerminal(durableTaskId, cols, rows);
        }
      }}
      onStopAgent={() => {
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        if (durableTaskId) controller.interruptTaskAgent(durableTaskId);
      }}
      onResolveAgentPermission={(requestId, decision) => {
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        if (durableTaskId) {
          controller.sendTaskAgentPermission(durableTaskId, requestId, decision);
        }
      }}
      onRecoverTaskCreation={() => {
        const slot = taskUiSlotForSelection(state.taskUiSlots, routeTaskId);
        if (slot?.state === "creating") {
          void controller.recoverTaskCreation(slot.slotId);
        }
      }}
      onCompanionOpenChange={(isOpen) => {
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        if (durableTaskId) {
          controller.setTaskCompanionOpen(durableTaskId, isOpen);
        }
      }}
      onSendCompanionEvent={(sessionId, revision, event) => {
        const durableTaskId = resolveDurableTaskId(state, routeTaskId);
        if (durableTaskId) {
          controller.sendTaskCompanionEvent(
            durableTaskId,
            sessionId,
            revision,
            event
          );
        }
      }}
    />
  );
}

function ComposerOverlay() {
  const {
    controller,
    pushPreparedTask,
    state,
    taskDetailViewportRef
  } = useNavigationContent();
  const selectedCreationAttempt = state.taskCreationAttempts?.find(
    (attempt) => attempt.slotId === state.selectedTaskId
  );
  const pendingTaskRoute = resolvePendingTaskCreationRoute({
    composerOpen: state.isComposerOpen,
    pendingSlotId: selectedCreationAttempt?.slotId ?? null,
    selectedTaskId: state.selectedTaskId
  });
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

  useEffect(() => {
    if (pendingTaskRoute) pushPreparedTask(pendingTaskRoute);
  }, [pendingTaskRoute, pushPreparedTask]);

  return (
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
        ).then((taskId) => {
          if (taskId) pushPreparedTask(taskId);
        });
      }}
    />
  );
}

function StandardScreen({
  children,
  title
}: {
  children: React.ReactNode;
  title: string;
}) {
  const { onOpenAccount, state } = useNavigationContent();
  return (
    <View style={styles.standardScreen}>
      {state.errorMessage && state.connectionState === "connected" ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{state.errorMessage}</Text>
        </View>
      ) : null}
      <View style={styles.topBar}>
        <Text numberOfLines={1} style={styles.topBarTitle}>
          {title}
        </Text>
        <AccountBadge auth={state.auth} onPress={onOpenAccount} />
      </View>
      {children}
    </View>
  );
}

function UtilityScreen({ children }: { children: React.ReactNode }) {
  return <View style={styles.utilityScreen}>{children}</View>;
}

function resolveSelectedTask(state: SessionState) {
  return state.selectedTaskId
    ? resolveTask(state, state.selectedTaskId)
    : null;
}

function visibleTasks(state: SessionState) {
  return [
    ...new Map(
      [...state.repoTasks, ...state.recentTasks, ...state.searchResults].map(
        (task) => [task.id, task] as const
      )
    ).values()
  ];
}

function resolveTask(state: SessionState, taskId: string) {
  const slot = taskUiSlotForSelection(
    projectTaskUiSlots(visibleTasks(state), state.taskUiSlots),
    taskId
  );
  return slot ? taskUiSlotToTaskSummary(slot) : null;
}

function resolveDurableTaskId(state: SessionState, taskId: string) {
  const slot = taskUiSlotForSelection(state.taskUiSlots, taskId);
  if (slot) {
    return slot.taskId;
  }
  return resolveTask(state, taskId)?.id ?? null;
}

function resolveTaskCreationPhase(state: SessionState, taskId: string) {
  const slot = taskUiSlotForSelection(state.taskUiSlots, taskId);
  if (slot?.state !== "creating") {
    return "idle";
  }
  return (
    state.taskCreationAttempts.find(
      (attempt) => attempt.slotId === slot.slotId
    )?.phase ?? "idle"
  );
}

function useNavigationContent(): NavigationContent {
  const content = useContext(NavigationContentContext);
  if (!content) {
    throw new Error("RootNavigator content is unavailable");
  }
  return content;
}

const styles = StyleSheet.create({
  navigatorHost: {
    flex: 1
  },
  stackContent: {
    backgroundColor: "#08111E"
  },
  header: {
    backgroundColor: "#08111E"
  },
  headerTitle: {
    fontWeight: "800"
  },
  standardScreen: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 18
  },
  utilityScreen: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 18
  },
  taskPlaceholder: {
    backgroundColor: "#08111E",
    flex: 1
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
