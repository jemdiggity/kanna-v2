import React, { useEffect, useRef, useSyncExternalStore } from "react";
import {
  AppState,
  type AppStateStatus,
  SafeAreaView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { isTaskDetailVisible, shouldShowFloatingToolbar } from "./appShell";
import { shouldRefreshOnAppStateTransition } from "./appLifecycle";
import { createAppModel, type AppModel } from "./appModel";
import { FloatingToolbar } from "./components/FloatingToolbar";
import { CreateTaskComposer } from "./components/CreateTaskComposer";
import { MOBILE_E2E_IDS } from "./e2eTestIds";
import { ConnectionScreen } from "./screens/ConnectionScreen";
import { DesktopsScreen } from "./screens/DesktopsScreen";
import { MoreScreen } from "./screens/MoreScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { TaskScreen } from "./screens/TaskScreen";
import { TasksScreen } from "./screens/TasksScreen";

export default function App() {
  const modelRef = useRef<AppModel | null>(null);
  if (!modelRef.current) {
    modelRef.current = createAppModel();
  }

  const model = modelRef.current;
  const state = useSyncExternalStore(
    model.sessionStore.subscribe,
    model.sessionStore.getState,
    model.sessionStore.getState
  );
  const { controller, navigator } = model;
  const taskDetailVisible = isTaskDetailVisible(state.selectedTaskId, state.activeView);

  useEffect(() => {
    void model.initialize();
  }, [model]);

  useEffect(() => {
    let previousState: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (
        shouldRefreshOnAppStateTransition(previousState, nextState) &&
        model.sessionStore.getState().connectionState === "connected"
      ) {
        void controller.refresh();
      }

      previousState = nextState;
    });

    return () => {
      subscription.remove();
    };
  }, [controller, model]);

  const selectedTask =
    state.repoTasks.find((task) => task.id === state.selectedTaskId) ??
    state.recentTasks.find((task) => task.id === state.selectedTaskId) ??
    state.searchResults.find((task) => task.id === state.selectedTaskId) ??
    null;
  const mainContent = (() => {
    if (state.connectionState !== "connected") {
      return (
        <ConnectionScreen
          auth={state.auth}
          connectionState={state.connectionState}
          desktopName={state.desktopName}
          errorMessage={state.errorMessage}
          pairingCode={state.pairingCode}
          onConnectLocal={() => {
            void controller.connectLocal();
          }}
          onSignIn={(email, password) => {
            void controller.signInWithEmailPassword(email, password);
          }}
          onSignOut={() => {
            void controller.signOut();
          }}
        />
      );
    }

    if (selectedTask && taskDetailVisible) {
      return (
        <TaskScreen
          task={selectedTask}
          terminalOutput={state.taskTerminalOutput}
          terminalStatus={state.taskTerminalStatus}
          onBack={() => controller.closeTask()}
          onOpenMore={() => controller.showView("more")}
          onSendInput={(input) => {
            void controller.sendTaskInput(selectedTask.id, input);
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
            tasks={state.recentTasks}
            onSelectRepo={(repoId) => {
              void controller.selectRepo(repoId);
            }}
            onOpenTask={(taskId) => controller.openTask(taskId)}
          />
        );
      case "desktops":
        return (
          <DesktopsScreen
            desktops={state.desktops}
            selectedDesktopId={state.selectedDesktopId}
            onSelectDesktop={(desktopId) => controller.selectDesktop(desktopId)}
          />
        );
      case "search":
        return (
          <SearchScreen
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
            pairingCode={state.pairingCode}
            refreshStatus={state.refreshStatus}
            selectedTask={selectedTask}
            onRefresh={() => {
              void controller.refresh();
            }}
            onShowDesktops={() => controller.showView("desktops")}
            onStartPairing={() => {
              void controller.connectLocal();
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
            heading="Tasks"
            repos={state.repos}
            selectedRepoId={state.selectedRepoId}
            tasks={state.repoTasks}
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
      case "more":
      case "desktops":
        return "more";
      case "search":
      case "tasks":
      default:
        return "tasks";
    }
  })();

  return (
    <SafeAreaView style={styles.safeArea} testID={MOBILE_E2E_IDS.appShell}>
      <View style={styles.backgroundGlow} />
      <View style={styles.backgroundOrb} />
      <View style={[styles.shell, taskDetailVisible ? styles.shellTaskDetail : null]}>
        {state.errorMessage && state.connectionState === "connected" && !taskDetailVisible ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{state.errorMessage}</Text>
          </View>
        ) : null}

        {mainContent}

        {shouldShowFloatingToolbar(
          state.connectionState,
          state.selectedTaskId,
          state.activeView
        ) ? (
          <FloatingToolbar
            activeTab={toolbarTab}
            utilityActions={navigator.utilityActions}
            onSelectTab={(tab) => controller.showView(tab)}
            onSelectUtilityAction={(action) => {
              if (action === "search") {
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
          selectedRepoId={state.selectedRepoId}
          onClose={() => controller.closeComposer()}
          onSelectRepo={(repoId) => {
            void controller.selectRepo(repoId);
          }}
          onChangePrompt={(prompt) => controller.updateComposerPrompt(prompt)}
          onSubmit={() => {
            void controller.createTask();
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: "#08111E",
    flex: 1
  },
  backgroundGlow: {
    backgroundColor: "#122B51",
    borderRadius: 280,
    height: 280,
    opacity: 0.22,
    position: "absolute",
    right: -70,
    top: -40,
    width: 280
  },
  backgroundOrb: {
    backgroundColor: "#163057",
    borderRadius: 220,
    bottom: 120,
    height: 220,
    left: -90,
    opacity: 0.16,
    position: "absolute",
    width: 220
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
