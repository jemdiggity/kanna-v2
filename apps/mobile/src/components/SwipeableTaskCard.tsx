import React, { useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PanResponderGestureState
} from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import { buildTaskListItemModel } from "../screens/taskPresentation";
import { TaskCard } from "./TaskCard";
import {
  TASK_ROW_ACTION_WIDTH,
  clampTaskRowSwipe,
  shouldBeginTaskRowSwipe,
  shouldRevealTaskRowAction
} from "./taskRowSwipe";

function beginsSwipe(
  gestureState: PanResponderGestureState,
  offset: number
): boolean {
  return shouldBeginTaskRowSwipe({
    dx: gestureState.dx,
    dy: gestureState.dy,
    offset
  });
}

interface SwipeableTaskCardProps {
  task: TaskSummary;
  uiId: string;
  isSubtask: boolean;
  repoLabel: string | null;
  /** This phone's own pin state for the row. */
  pinned?: boolean;
  onPress(): void;
  onDismiss?(): Promise<void>;
  onTogglePin?(pinned: boolean): Promise<void>;
}

export function SwipeableTaskCard({
  task,
  uiId,
  isSubtask,
  repoLabel,
  pinned = false,
  onPress,
  onDismiss,
  onTogglePin
}: SwipeableTaskCardProps) {
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [pinError, setPinError] = useState<string | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  // A revealed row rests there until something closes it, so the gesture
  // config — which `PanResponder` builds once — has to read the position the
  // next touch starts from rather than assume the row is closed. Refs carry
  // it: state alone would be a value the memoized handlers captured while the
  // row was still closed.
  const restingOffsetRef = useRef(0);
  const gestureStartOffsetRef = useRef(0);
  const moveTo = (offset: number) => {
    restingOffsetRef.current = offset;
    setSwipeOffset(offset);
  };
  // The row lives inside the vertical task ScrollView and wraps a pressable
  // card, so the gesture has to win a real responder negotiation against both.
  // `PanResponder` is the API that does that: it derives the displacement from
  // React Native's own touch history (rather than from an `onTouchStart` this
  // view is not guaranteed to observe once the card's Pressable holds the
  // responder), and refusing termination keeps the enclosing ScrollView from
  // reclaiming the touch mid-swipe and snapping the row shut.
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gestureState) =>
          beginsSwipe(gestureState, restingOffsetRef.current),
        onMoveShouldSetPanResponderCapture: (_event, gestureState) =>
          beginsSwipe(gestureState, restingOffsetRef.current),
        onPanResponderGrant: () => {
          gestureStartOffsetRef.current = restingOffsetRef.current;
        },
        onPanResponderMove: (_event, gestureState) => {
          moveTo(
            clampTaskRowSwipe(gestureState.dx, gestureStartOffsetRef.current)
          );
        },
        onPanResponderRelease: (_event, gestureState) => {
          const released = clampTaskRowSwipe(
            gestureState.dx,
            gestureStartOffsetRef.current
          );
          moveTo(
            shouldRevealTaskRowAction(released) ? -TASK_ROW_ACTION_WIDTH : 0
          );
        },
        onPanResponderTerminate: () => {
          moveTo(0);
        },
        onPanResponderTerminationRequest: () => false
      }),
    []
  );

  // Pin and dismiss are phone-local writes, so the row has no in-flight state
  // to report: the label is whatever this phone's own record says right now.
  const pinLabel = pinned ? "Unpin" : "Pin";
  const actionRevealed = swipeOffset < 0;
  const swipeLabel = onDismiss ? "Dismiss" : pinLabel;

  if (!onTogglePin && !onDismiss) {
    return (
      <TaskCard
        isSubtask={isSubtask}
        pinned={pinned}
        repoLabel={repoLabel}
        task={task}
        uiId={uiId}
        onPress={onPress}
      />
    );
  }

  // A revealed row is modal over its own content: the first tap on the card
  // closes it rather than opening the task, which is the other half of the
  // close affordance the swipe-right gesture provides.
  const pressCard = () => {
    if (actionRevealed) {
      moveTo(0);
      return;
    }
    onPress();
  };

  const togglePin = async () => {
    if (!onTogglePin) return;
    setPinError(null);
    moveTo(0);
    try {
      await onTogglePin(!pinned);
    } catch (error) {
      setPinError(error instanceof Error ? error.message : String(error));
    }
  };
  const dismiss = async () => {
    if (!onDismiss) return;
    setDismissError(null);
    moveTo(0);
    try {
      await onDismiss();
    } catch (error) {
      setDismissError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityElementsHidden={!actionRevealed}
        accessibilityLabel={`${swipeLabel} ${
          buildTaskListItemModel(task).title
        }`}
        accessibilityRole="button"
        importantForAccessibility={
          actionRevealed ? "yes" : "no-hide-descendants"
        }
        style={[
          styles.action,
          onDismiss
            ? styles.dismissAction
            : pinned
              ? styles.unpinAction
              : styles.pinAction
        ]}
        testID={
          onDismiss
            ? MOBILE_E2E_IDS.activityDismissAction(uiId)
            : MOBILE_E2E_IDS.taskPinAction(uiId)
        }
        onPress={() => {
          if (onDismiss) {
            void dismiss();
          } else {
            void togglePin();
          }
        }}
      >
        <Text style={styles.actionLabel}>{swipeLabel}</Text>
      </Pressable>
      <View
        style={{ transform: [{ translateX: swipeOffset }] }}
        {...panResponder.panHandlers}
      >
        <TaskCard
          dismissAction={
            onDismiss
              ? {
                  error: dismissError,
                  onDismiss: () => {
                    void dismiss();
                  }
                }
              : undefined
          }
          isSubtask={isSubtask}
          pinAction={
            onTogglePin
              ? {
                  error: pinError,
                  onToggle: () => {
                    void togglePin();
                  }
                }
              : undefined
          }
          pinned={pinned}
          repoLabel={repoLabel}
          task={task}
          uiId={uiId}
          onPress={pressCard}
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
    width: TASK_ROW_ACTION_WIDTH
  },
  pinAction: {
    backgroundColor: "#2563EB"
  },
  unpinAction: {
    backgroundColor: "#9F2D42"
  },
  dismissAction: {
    backgroundColor: "#B4233C"
  },
  actionLabel: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800"
  }
});
