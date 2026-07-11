import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import { buildTaskListItemModel } from "../screens/taskPresentation";

interface TaskCardProps {
  isRecentView: boolean;
  repoName: string | null;
  task: TaskSummary;
  onPress(): void;
}

export function TaskCard({ isRecentView, repoName, task, onPress }: TaskCardProps) {
  const model = buildTaskListItemModel(task, repoName, isRecentView);

  return (
    <Pressable
      accessibilityLabel={`${task.title}, ${model.repoLabel}, ${model.stageLabel}`}
      accessible
      style={styles.card}
      testID={MOBILE_E2E_IDS.taskListItem(task.id)}
      onPress={onPress}
    >
      <View style={styles.topRow}>
        <Text style={styles.scopeLabel}>{model.scopeLabel}</Text>
        <Text style={styles.repoLabel}>{model.repoLabel}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.title}>{task.title}</Text>
        <View style={styles.stagePill}>
          <Text style={styles.stageLabel}>{model.stageLabel}</Text>
        </View>
      </View>
      <Text numberOfLines={3} style={styles.preview}>
        {model.preview}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#111B2C",
    borderColor: "#20304C",
    borderRadius: 20,
    borderWidth: 1,
    gap: 10,
    padding: 16
  },
  topRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  row: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  scopeLabel: {
    color: "#7FA7D9",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase"
  },
  repoLabel: {
    color: "#8EA3C4",
    fontSize: 12,
    fontWeight: "600"
  },
  title: {
    color: "#F3F7FF",
    flex: 1,
    fontSize: 17,
    fontWeight: "700"
  },
  stagePill: {
    alignSelf: "flex-start",
    backgroundColor: "#172843",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  stageLabel: {
    color: "#9EB6DC",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase"
  },
  preview: {
    color: "#B8C6DB",
    fontSize: 14,
    lineHeight: 20
  }
});
