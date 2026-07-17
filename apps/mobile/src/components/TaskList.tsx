import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { TaskUiSlot } from "../state/taskUiSlots";
import { taskUiSlotToTaskSummary } from "../state/taskUiSlots";
import { TaskCard } from "./TaskCard";

interface TaskListProps {
  emptyLabel: string;
  taskSlots: TaskUiSlot[];
  testID?: string;
  onOpenTask(taskId: string): void;
}

export function TaskList({
  emptyLabel,
  testID,
  taskSlots,
  onOpenTask
}: TaskListProps) {
  if (!taskSlots.length) {
    return (
      <View collapsable={false} style={styles.emptyCard} testID={testID}>
        <Text style={styles.emptyLabel}>{emptyLabel}</Text>
      </View>
    );
  }

  return (
    <View collapsable={false} style={styles.list} testID={testID}>
      {taskSlots.map((slot) => {
        const task = taskUiSlotToTaskSummary(slot);
        return (
          <TaskCard
            key={slot.slotId}
            task={task}
            uiId={slot.slotId}
            onPress={() => onOpenTask(slot.slotId)}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 12
  },
  emptyCard: {
    alignItems: "center",
    backgroundColor: "#10192A",
    borderColor: "#20304C",
    borderRadius: 18,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 160,
    padding: 24
  },
  emptyLabel: {
    color: "#93A7C8",
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center"
  }
});
