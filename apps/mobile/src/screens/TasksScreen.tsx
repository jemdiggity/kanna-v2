import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { RepoSummary, TaskSummary } from "../lib/api/types";
import { TaskList } from "../components/TaskList";
import { orderActivityTasks } from "./activityTaskOrder";
import type { TaskUiSlot } from "../state/taskUiSlots";
import { taskUiSlotToTaskSummary } from "../state/taskUiSlots";

interface TasksScreenProps {
  heading?: string | null;
  repos: RepoSummary[];
  selectedRepoId: string | null;
  taskSlots: TaskUiSlot[];
  onSelectRepo(repoId: string): void;
  onOpenTask(taskId: string): void;
}

const sqliteTimestampPattern =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function taskCreationTimestamp(task: TaskSummary): number | null {
  const value = task.createdAt?.trim();
  if (!value) return null;
  const normalized = sqliteTimestampPattern.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
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
  repos,
  selectedRepoId,
  taskSlots,
  onSelectRepo,
  onOpenTask
}: TasksScreenProps) {
  const isRecentView = heading === "Recent";
  const scopedTaskSlots = !isRecentView && selectedRepoId
    ? taskSlots.filter(
        (slot) => taskUiSlotToTaskSummary(slot).repoId === selectedRepoId
      )
    : taskSlots;
  const displayedTaskSlots = isRecentView
    ? orderActivityTasks(taskSlots.map(taskUiSlotToTaskSummary)).map(
        (task) => taskSlots.find(
          (slot) => taskUiSlotToTaskSummary(slot).id === task.id
        )!
      )
    : sortTaskSlotsNewestFirst(scopedTaskSlots);

  return (
    <ScrollView
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
                  key={repo.id}
                  style={[styles.repoChip, selected ? styles.repoChipSelected : null]}
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

        <TaskList
          emptyLabel="No tasks yet."
          taskSlots={displayedTaskSlots}
          onOpenTask={onOpenTask}
        />
      </View>
    </ScrollView>
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
  }
});
