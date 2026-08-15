import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { RepoSummary, TaskSummary } from "../lib/api/types";
import { TaskList } from "../components/TaskList";
import { visibleActivityTasks } from "./activityTaskOrder";
import { taskCreationTimestamp } from "./taskTreeRows";
import type { TaskUiSlot } from "../state/taskUiSlots";
import { taskUiSlotToTaskSummary } from "../state/taskUiSlots";
import type { TaskCollectionStatus } from "../state/sessionStore";

interface TasksScreenProps {
  heading?: string | null;
  needsDesktopSetup?: boolean;
  repos: RepoSummary[];
  selectedRepoId: string | null;
  taskCollectionStatus: TaskCollectionStatus;
  taskSlots: TaskUiSlot[];
  scrollViewRef?: React.RefObject<ScrollView | null>;
  onOpenMachines?(): void;
  onSelectRepo(repoId: string): void;
  onOpenTask(taskId: string): void;
  onDismissActivity?(taskId: string): Promise<void>;
  onSetTaskPinned?(taskId: string, pinned: boolean): Promise<void>;
}

function sortTaskSlotsNewestFirst(taskSlots: readonly TaskUiSlot[]): TaskUiSlot[] {
  return [...taskSlots].sort((left, right) => {
    const leftTimestamp = taskCreationTimestamp(taskUiSlotToTaskSummary(left));
    const rightTimestamp = taskCreationTimestamp(taskUiSlotToTaskSummary(right));
    if (leftTimestamp === null) return rightTimestamp === null ? 0 : 1;
    if (rightTimestamp === null) return -1;
    return rightTimestamp - leftTimestamp;
  });
}

export function TasksScreen({
  heading,
  needsDesktopSetup = false,
  repos,
  selectedRepoId,
  taskCollectionStatus,
  taskSlots,
  scrollViewRef,
  onOpenMachines,
  onSelectRepo,
  onOpenTask,
  onDismissActivity,
  onSetTaskPinned
}: TasksScreenProps) {
  const isRecentView = heading === "Recent";
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
    ? visibleActivityTasks(taskSlots.map(taskUiSlotToTaskSummary)).map(
        (task) => taskSlots.find(
          (slot) => taskUiSlotToTaskSummary(slot).id === task.id
        )!
      )
    : sortTaskSlotsNewestFirst(scopedTaskSlots);
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
                  accessibilityState={{ selected }}
                  key={repo.id}
                  style={[styles.repoChip, selected ? styles.repoChipSelected : null]}
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
  repoLabel: {
    color: "#D5DEEC",
    fontSize: 13,
    fontWeight: "700"
  },
  repoLabelSelected: {
    color: "#0B1220"
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
