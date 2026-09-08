import { StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import { displayTaskId } from "../lib/api/taskIdentity";
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
  compact?: boolean;
  selectedTaskId?: string | null;
  repoLabelForTask?: (task: TaskSummary) => string | null;
  /** Task ids this phone has pinned, in its own pin order. */
  pinnedTaskIds?: readonly string[];
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
  compact = false,
  selectedTaskId = null,
  pinnedTaskIds = [],
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
    ? buildTaskTreeRows(taskSlots, pinnedTaskIds)
    : taskSlots.map((slot) => ({ slot, depth: 0 }));

  return (
    <View
      collapsable={false}
      style={[styles.list, compact ? styles.listCompact : null]}
      testID={testID}
    >
      {rows.map(({ slot, depth }) => {
        const task = taskUiSlotToTaskSummary(slot);
        const commonProps = {
          compact,
          isSubtask: depth > 0,
          pinned: pinnedTaskIds.includes(task.id),
          selected: slot.slotId === selectedTaskId || task.id === selectedTaskId,
          repoLabel: repoLabelForTask?.(task) ?? null,
          // A slot still being created has no durable id yet — only the local
          // slot id, which is not something the owner can cross-check — so it
          // renders no id rather than a synthetic one.
          shortId: slot.state === "ready" ? displayTaskId(slot.task) : null,
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
        // Every depth renders the same element type on purpose. Pinning a
        // subtask un-nests it on the very tick the pin is written — a pinned
        // row is never nested (`buildTaskTreeRows`) — so its depth drops to 0
        // under a stable key. Swapping the wrapper's element type there would
        // make React unmount and remount the row mid-gesture, recreating the
        // `Animated.Value` its closing swipe is running and hard-cutting the
        // row to rest. Indent and the subtask testID stay depth-only.
        const nested = depth > 0;
        return (
          <View
            key={slot.slotId}
            style={
              nested
                ? [
                    styles.subtaskRow,
                    {
                      marginLeft:
                        Math.min(depth, MAX_SUBTASK_INDENT_DEPTH) *
                        SUBTASK_INDENT
                    }
                  ]
                : undefined
            }
            testID={
              nested
                ? MOBILE_E2E_IDS.taskListSubtaskRow(slot.slotId)
                : undefined
            }
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
  listCompact: {
    gap: 6
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
