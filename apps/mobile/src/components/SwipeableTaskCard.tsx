import React, { useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent
} from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import { buildTaskListItemModel } from "../screens/taskPresentation";
import { TaskCard } from "./TaskCard";
import {
  TASK_PIN_ACTION_WIDTH,
  clampTaskPinSwipe,
  shouldBeginTaskPinSwipe,
  shouldRevealTaskPinAction
} from "./taskPinSwipe";

interface SwipeableTaskCardProps {
  task: TaskSummary;
  uiId: string;
  isSubtask: boolean;
  repoLabel: string | null;
  onPress(): void;
  onTogglePin?(pinned: boolean): Promise<void>;
}

export function SwipeableTaskCard({
  task,
  uiId,
  isSubtask,
  repoLabel,
  onPress,
  onTogglePin
}: SwipeableTaskCardProps) {
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [pinPending, setPinPending] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const pinned = task.pinned ?? false;
  const pinLabel = pinned ? "Unpin" : "Pin";
  const actionRevealed = swipeOffset < 0;

  if (!onTogglePin) {
    return (
      <TaskCard
        isSubtask={isSubtask}
        repoLabel={repoLabel}
        task={task}
        uiId={uiId}
        onPress={onPress}
      />
    );
  }

  const displacement = (event: GestureResponderEvent) => {
    const start = touchStart.current;
    return start
      ? {
          dx: event.nativeEvent.pageX - start.x,
          dy: event.nativeEvent.pageY - start.y
        }
      : { dx: 0, dy: 0 };
  };
  const togglePin = async () => {
    if (pinPending) return;
    setPinPending(true);
    setPinError(null);
    try {
      await onTogglePin(!pinned);
      setSwipeOffset(0);
    } catch (error) {
      setPinError(error instanceof Error ? error.message : String(error));
    } finally {
      setPinPending(false);
    }
  };

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityElementsHidden={!actionRevealed}
        accessibilityLabel={`${pinLabel} ${buildTaskListItemModel(task).title}`}
        accessibilityRole="button"
        accessibilityState={{ busy: pinPending, disabled: pinPending }}
        importantForAccessibility={
          actionRevealed ? "yes" : "no-hide-descendants"
        }
        style={[
          styles.action,
          pinned ? styles.unpinAction : styles.pinAction
        ]}
        testID={MOBILE_E2E_IDS.taskPinAction(uiId)}
        onPress={() => {
          void togglePin();
        }}
      >
        <Text style={styles.actionLabel}>
          {pinPending ? `${pinLabel}ning…` : pinLabel}
        </Text>
      </Pressable>
      <View
        style={{ transform: [{ translateX: swipeOffset }] }}
        onMoveShouldSetResponderCapture={(event) =>
          shouldBeginTaskPinSwipe(displacement(event))
        }
        onResponderMove={(event) => {
          setSwipeOffset(clampTaskPinSwipe(displacement(event).dx));
        }}
        onResponderRelease={(event) => {
          setSwipeOffset(
            shouldRevealTaskPinAction(displacement(event).dx)
              ? -TASK_PIN_ACTION_WIDTH
              : 0
          );
          touchStart.current = null;
        }}
        onResponderTerminate={() => {
          setSwipeOffset(0);
          touchStart.current = null;
        }}
        onTouchStart={(event) => {
          touchStart.current = {
            x: event.nativeEvent.pageX,
            y: event.nativeEvent.pageY
          };
        }}
      >
        <TaskCard
          isSubtask={isSubtask}
          pinAction={{
            error: pinError,
            pending: pinPending,
            onToggle: () => {
              void togglePin();
            }
          }}
          repoLabel={repoLabel}
          task={task}
          uiId={uiId}
          onPress={onPress}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 20,
    overflow: "hidden",
    position: "relative"
  },
  action: {
    alignItems: "center",
    bottom: 0,
    justifyContent: "center",
    position: "absolute",
    right: 0,
    top: 0,
    width: TASK_PIN_ACTION_WIDTH
  },
  pinAction: {
    backgroundColor: "#2563EB"
  },
  unpinAction: {
    backgroundColor: "#9F2D42"
  },
  actionLabel: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800"
  }
});
