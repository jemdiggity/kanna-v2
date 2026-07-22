import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import { isTaskBlocked } from "../lib/api/taskIdentity";
import { buildTaskListItemModel } from "../screens/taskPresentation";

interface TaskCardProps {
  task: TaskSummary;
  uiId?: string;
  isSubtask?: boolean;
  onPress(): void;
}

export function TaskCard({
  task,
  uiId = task.id,
  isSubtask = false,
  onPress
}: TaskCardProps) {
  const model = buildTaskListItemModel(task);
  const blocked = isTaskBlocked(task);
  const accessibilityLabel = [
    isSubtask ? "Subtask" : null,
    blocked ? "Blocked" : null,
    model.title,
    model.stageLabel,
    model.waitingPromptSnippet
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");
  const effectiveActivity =
    task.activity === "working" || task.activity === "unread"
      ? task.activity
      : "idle";
  const titleActivityStyle =
    effectiveActivity === "unread"
      ? styles.titleUnread
      : effectiveActivity === "working"
        ? styles.titleWorking
        : styles.titleIdle;

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityValue={{ text: effectiveActivity }}
      accessible
      style={styles.card}
      testID={MOBILE_E2E_IDS.taskListItem(uiId)}
      onPress={onPress}
    >
      <View style={styles.row}>
        <Text numberOfLines={2} style={[styles.title, titleActivityStyle]}>
          {model.title}
        </Text>
        <View style={styles.pillColumn}>
          <View style={styles.stagePill}>
            <Text style={styles.stageLabel}>{model.stageLabel}</Text>
          </View>
          {blocked ? (
            <View style={[styles.stagePill, styles.blockedPill]}>
              <Text style={[styles.stageLabel, styles.blockedLabel]}>
                blocked
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      {model.waitingPromptSnippet ? (
        <Text
          numberOfLines={3}
          style={[
            styles.preview,
            model.isWaitingPromptPlaceholder
              ? styles.previewPlaceholder
              : null
          ]}
        >
          {model.waitingPromptSnippet}
        </Text>
      ) : null}
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
  row: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  title: {
    color: "#F3F7FF",
    flex: 1,
    fontSize: 17
  },
  titleIdle: {
    fontStyle: "normal",
    fontWeight: "normal"
  },
  titleUnread: {
    fontStyle: "normal",
    fontWeight: "bold"
  },
  titleWorking: {
    fontStyle: "italic",
    fontWeight: "normal"
  },
  pillColumn: {
    alignItems: "flex-end",
    gap: 6
  },
  stagePill: {
    alignSelf: "flex-start",
    backgroundColor: "#172843",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  blockedPill: {
    alignSelf: "flex-end",
    backgroundColor: "#2B2033"
  },
  blockedLabel: {
    color: "#C9A8E0"
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
  },
  previewPlaceholder: {
    color: "#6F819E"
  }
});
