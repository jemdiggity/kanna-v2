import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { RepoSummary, TaskSummary } from "../lib/api/types";
import { TaskList } from "../components/TaskList";
import { orderActivityTasks } from "./activityTaskOrder";

interface TasksScreenProps {
  heading?: string | null;
  repos: RepoSummary[];
  selectedRepoId: string | null;
  tasks: TaskSummary[];
  onSelectRepo(repoId: string): void;
  onOpenTask(taskId: string): void;
}

export function TasksScreen({
  heading,
  repos,
  selectedRepoId,
  tasks,
  onSelectRepo,
  onOpenTask
}: TasksScreenProps) {
  const isRecentView = heading === "Recent";
  const displayedTasks = isRecentView
    ? orderActivityTasks(tasks)
    : selectedRepoId
      ? tasks.filter((task) => task.repoId === selectedRepoId)
      : tasks;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
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
          tasks={displayedTasks}
          testID={MOBILE_E2E_IDS.tasksScreen}
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
