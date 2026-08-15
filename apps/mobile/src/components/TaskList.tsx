import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import type { TaskUiSlot } from "../state/taskUiSlots";
import { taskUiSlotToTaskSummary } from "../state/taskUiSlots";
import { buildTaskTreeRows, type TaskTreeRow } from "../screens/taskTreeRows";
import { SwipeableTaskCard } from "./SwipeableTaskCard";
import { TaskCard } from "./TaskCard";
import { LoadingText } from "./LoadingText";

const SUBTASK_INDENT = 16;
const MAX_SUBTASK_INDENT_DEPTH = 3;

interface TaskListProps {
  emptyLabel: string;
  errorLabel?: string | null;
  loading?: boolean;
  /** Nest subtasks under their visible parent (desktop sidebar parity). */
  nestSubtasks?: boolean;
  repoLabelForTask?: (task: TaskSummary) => string | null;
  taskSlots: TaskUiSlot[];
  testID?: string;
  onOpenTask(taskId: string): void;
  onDismissTask?(taskId: string): Promise<void>;
  onSetTaskPinned?(taskId: string, pinned: boolean): Promise<void>;
}

export function TaskList({
  emptyLabel,
  errorLabel = null,
  loading = false,
  nestSubtasks = false,
  repoLabelForTask,
  testID,
  taskSlots,
  onOpenTask,
  onDismissTask,
  onSetTaskPinned
}: TaskListProps) {
  if (!taskSlots.length) {
    return (
      <View collapsable={false} style={styles.emptyCard} testID={testID}>
        {loading ? (
          <LoadingText label="Loading tasks" style={styles.emptyLabel} />
        ) : (
          <Text style={styles.emptyLabel}>{errorLabel ?? emptyLabel}</Text>
        )}
      </View>
    );
  }

  const rows: TaskTreeRow[] = nestSubtasks
    ? buildTaskTreeRows(taskSlots)
    : taskSlots.map((slot) => ({ slot, depth: 0 }));

  return (
    <View collapsable={false} style={styles.list} testID={testID}>
      {rows.map(({ slot, depth }) => {
        const task = taskUiSlotToTaskSummary(slot);
        const commonProps = {
          isSubtask: depth > 0,
          repoLabel: repoLabelForTask?.(task) ?? null,
          task,
          uiId: slot.slotId,
          onPress: () => onOpenTask(slot.slotId)
        };
        const card = slot.state === "ready" &&
          (onSetTaskPinned || onDismissTask) ? (
          <SwipeableTaskCard
            key={slot.slotId}
            {...commonProps}
            onDismiss={
              onDismissTask
                ? () => onDismissTask(slot.taskId)
                : undefined
            }
            onTogglePin={
              onSetTaskPinned
                ? (pinned) => onSetTaskPinned(slot.taskId, pinned)
                : undefined
            }
          />
        ) : (
          <TaskCard key={slot.slotId} {...commonProps} />
        );
        if (depth === 0) {
          return <React.Fragment key={slot.slotId}>{card}</React.Fragment>;
        }
        return (
          <View
            key={slot.slotId}
            style={[
              styles.subtaskRow,
              {
                marginLeft:
                  Math.min(depth, MAX_SUBTASK_INDENT_DEPTH) * SUBTASK_INDENT
              }
            ]}
            testID={MOBILE_E2E_IDS.taskListSubtaskRow(slot.slotId)}
          >
            {card}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 12
  },
  subtaskRow: {
    borderLeftColor: "#2E4368",
    borderLeftWidth: 2,
    paddingLeft: 10
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
