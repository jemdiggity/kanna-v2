import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { RepoSummary, TaskSummary } from "../lib/api/types";
import { TaskList } from "../components/TaskList";
import { visibleActivityTasks } from "./activityTaskOrder";
import { orderRepoTaskSlots } from "./repoTaskOrder";
import type { TaskUiSlot } from "../state/taskUiSlots";
import { taskUiSlotToTaskSummary } from "../state/taskUiSlots";
import type { TaskCollectionStatus } from "../state/sessionStore";
import {
  emptyLocalTaskListPreferences,
  localPinnedTaskIds,
  type LocalTaskListPreferences
} from "../state/taskListPreferences";

interface TasksScreenProps {
  heading?: string | null;
  needsDesktopSetup?: boolean;
  repos: RepoSummary[];
  selectedRepoId: string | null;
  taskCollectionStatus: TaskCollectionStatus;
  repoCommandErrorMessage?: string | null;
  repoSelectionDisabled?: boolean;
  /** This phone's own pinned/dismissed rows. */
  taskListPreferences?: LocalTaskListPreferences;
  taskSlots: TaskUiSlot[];
  scrollViewRef?: React.RefObject<ScrollView | null>;
  onOpenMachines?(): void;
  onRetryRepoCommand?(): void;
  onDismissRepoCommandError?(): void;
  onSelectRepo(repoId: string): void;
  onOpenTask(taskId: string): void;
  onDismissActivity?(taskId: string): Promise<void>;
  onSetTaskPinned?(taskId: string, pinned: boolean): Promise<void>;
}

export function TasksScreen({
  heading,
  needsDesktopSetup = false,
  repos,
  selectedRepoId,
  taskCollectionStatus,
  repoCommandErrorMessage = null,
  repoSelectionDisabled = false,
  taskListPreferences = emptyLocalTaskListPreferences(),
  taskSlots,
  scrollViewRef,
  onOpenMachines,
  onRetryRepoCommand,
  onDismissRepoCommandError,
  onSelectRepo,
  onOpenTask,
  onDismissActivity,
  onSetTaskPinned
}: TasksScreenProps) {
  const isRecentView = heading === "Recent";
  const pinnedTaskIds = localPinnedTaskIds(taskListPreferences);
  const repoNamesById = new Map(repos.map((repo) => [repo.id, repo.name]));
  const recentTaskRepoLabel = (task: TaskSummary): string =>
    task.repoName?.trim() ||
    repoNamesById.get(task.repoId)?.trim() ||
    task.repoId;
  const scopedTaskSlots = !isRecentView && selectedRepoId
    ? taskSlots.filter(
        (slot) => taskUiSlotToTaskSummary(slot).repoId === selectedRepoId
      )
    : taskSlots;
  const displayedTaskSlots = isRecentView
    ? visibleActivityTasks(
        taskSlots.map(taskUiSlotToTaskSummary),
        taskListPreferences
      ).map(
        (task) => taskSlots.find(
          (slot) => taskUiSlotToTaskSummary(slot).id === task.id
        )!
      )
    : orderRepoTaskSlots(scopedTaskSlots, pinnedTaskIds);
  const showDesktopSetup =
    !isRecentView &&
    needsDesktopSetup &&
    taskCollectionStatus === "ready" &&
    displayedTaskSlots.length === 0 &&
    onOpenMachines !== undefined;

  return (
    <ScrollView
      ref={scrollViewRef}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      testID={
        isRecentView
          ? MOBILE_E2E_IDS.recentScreen
          : MOBILE_E2E_IDS.tasksScreen
      }
    >
      <View style={styles.wrap}>
        {heading ? <Text style={styles.heading}>{heading}</Text> : null}

        {!isRecentView && repos.length > 0 ? (
          <ScrollView
            contentContainerStyle={styles.repoRow}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {repos.map((repo) => {
              const selected = repo.id === selectedRepoId;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{
                    disabled: repoSelectionDisabled,
                    selected
                  }}
                  disabled={repoSelectionDisabled}
                  key={repo.id}
                  style={[
                    styles.repoChip,
                    selected ? styles.repoChipSelected : null,
                    repoSelectionDisabled ? styles.repoChipDisabled : null
                  ]}
                  testID={MOBILE_E2E_IDS.tasksRepo(repo.id)}
                  onPress={() => onSelectRepo(repo.id)}
                >
                  <Text
                    style={[
                      styles.repoLabel,
                      selected ? styles.repoLabelSelected : null
                    ]}
                  >
                    {repo.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        {!isRecentView && repoCommandErrorMessage ? (
          <View accessibilityRole="alert" style={styles.commandErrorCard}>
            <Text style={styles.commandErrorTitle}>
              Command task unavailable
            </Text>
            <Text style={styles.commandErrorCopy}>
              {repoCommandErrorMessage}
            </Text>
            <View style={styles.commandErrorActions}>
              {onRetryRepoCommand ? (
                <Pressable
                  onPress={onRetryRepoCommand}
                  style={styles.commandErrorPrimary}
                  testID={MOBILE_E2E_IDS.tasksRepoCommandRetry}
                >
                  <Text style={styles.commandErrorPrimaryLabel}>Try Again</Text>
                </Pressable>
              ) : null}
              {onDismissRepoCommandError ? (
                <Pressable
                  onPress={onDismissRepoCommandError}
                  style={styles.commandErrorSecondary}
                  testID={MOBILE_E2E_IDS.tasksRepoCommandDismiss}
                >
                  <Text style={styles.commandErrorSecondaryLabel}>Dismiss</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        {showDesktopSetup && onOpenMachines ? (
          <DesktopSetupEmptyState onOpenMachines={onOpenMachines} />
        ) : (
          <TaskList
            emptyLabel={isRecentView ? "You're all caught up." : "No tasks yet."}
            errorLabel={
              taskCollectionStatus === "error" ? "Could not load tasks." : null
            }
            loading={
              taskCollectionStatus === "loading" && displayedTaskSlots.length === 0
            }
            nestSubtasks
            pinnedTaskIds={pinnedTaskIds}
            repoLabelForTask={isRecentView ? recentTaskRepoLabel : undefined}
            taskSlots={displayedTaskSlots}
            onOpenTask={onOpenTask}
            onDismissTask={isRecentView ? onDismissActivity : undefined}
            onSetTaskPinned={onSetTaskPinned}
          />
        )}
      </View>
    </ScrollView>
  );
}

function DesktopSetupEmptyState({
  onOpenMachines
}: {
  onOpenMachines(): void;
}) {
  return (
    <View style={styles.setupCard}>
      <Text style={styles.setupTitle}>Connect Kanna on your Mac</Text>
      <Text style={styles.setupDetail}>
        Kanna Mobile is a companion to Kanna for macOS. Install the desktop app
        from kanna.build first, then scan its pairing QR code to connect over
        your local network. Cloud sign-in for remote access is separate and
        optional.
      </Text>
      <Pressable
        accessibilityLabel="Pair a Mac"
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.setupButton,
          pressed ? styles.setupButtonPressed : null
        ]}
        testID={MOBILE_E2E_IDS.tasksPairMacButton}
        onPress={onOpenMachines}
      >
        <Text style={styles.setupButtonLabel}>Pair a Mac</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: 140
  },
  wrap: {
    gap: 14
  },
  heading: {
    color: "#F5F7FB",
    fontSize: 24,
    fontWeight: "700"
  },
  repoRow: {
    gap: 10,
    paddingVertical: 2
  },
  repoChip: {
    backgroundColor: "#152036",
    borderColor: "#22304D",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  repoChipSelected: {
    backgroundColor: "#E8F1FF"
  },
  repoChipDisabled: { opacity: 0.6 },
  repoLabel: {
    color: "#D5DEEC",
    fontSize: 13,
    fontWeight: "700"
  },
  repoLabelSelected: {
    color: "#0B1220"
  },
  commandErrorCard: {
    backgroundColor: "#241A18",
    borderColor: "#75483D",
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 16
  },
  commandErrorTitle: { color: "#FFD7CE", fontSize: 15, fontWeight: "800" },
  commandErrorCopy: { color: "#E8BEB4", fontSize: 13, lineHeight: 19 },
  commandErrorActions: { flexDirection: "row", gap: 10 },
  commandErrorPrimary: {
    backgroundColor: "#E8F1FF",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  commandErrorPrimaryLabel: {
    color: "#0B1220",
    fontSize: 13,
    fontWeight: "800"
  },
  commandErrorSecondary: {
    borderColor: "#9C685B",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  commandErrorSecondaryLabel: {
    color: "#FFD7CE",
    fontSize: 13,
    fontWeight: "800"
  },
  setupCard: {
    alignItems: "center",
    backgroundColor: "#10192A",
    borderColor: "#20304C",
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 24
  },
  setupTitle: {
    color: "#F5F7FB",
    fontSize: 18,
    fontWeight: "800",
    textAlign: "center"
  },
  setupDetail: {
    color: "#93A7C8",
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center"
  },
  setupButton: {
    backgroundColor: "#E8F1FF",
    borderRadius: 999,
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 11
  },
  setupButtonPressed: {
    opacity: 0.82
  },
  setupButtonLabel: {
    color: "#0B1220",
    fontSize: 14,
    fontWeight: "800"
  }
});
