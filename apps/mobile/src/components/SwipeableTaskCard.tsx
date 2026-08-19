import React, { useMemo, useState } from "react";
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

function beginsSwipe(gestureState: PanResponderGestureState): boolean {
  return shouldBeginTaskRowSwipe({ dx: gestureState.dx, dy: gestureState.dy });
}

interface SwipeableTaskCardProps {
  task: TaskSummary;
  uiId: string;
  isSubtask: boolean;
  repoLabel: string | null;
  onPress(): void;
  onDismiss?(): Promise<void>;
  onTogglePin?(pinned: boolean): Promise<void>;
}

export function SwipeableTaskCard({
  task,
  uiId,
  isSubtask,
  repoLabel,
  onPress,
  onDismiss,
  onTogglePin
}: SwipeableTaskCardProps) {
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [pendingPinned, setPendingPinned] = useState<boolean | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [dismissPending, setDismissPending] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
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
          beginsSwipe(gestureState),
        onMoveShouldSetPanResponderCapture: (_event, gestureState) =>
          beginsSwipe(gestureState),
        onPanResponderMove: (_event, gestureState) => {
          setSwipeOffset(clampTaskRowSwipe(gestureState.dx));
        },
        onPanResponderRelease: (_event, gestureState) => {
          setSwipeOffset(
            shouldRevealTaskRowAction(gestureState.dx)
              ? -TASK_ROW_ACTION_WIDTH
              : 0
          );
        },
        onPanResponderTerminate: () => {
          setSwipeOffset(0);
        },
        onPanResponderTerminationRequest: () => false
      }),
    []
  );

  const pinned = task.pinned ?? false;
  const pinLabel = pinned ? "Unpin" : "Pin";
  const pendingPinLabel =
    pendingPinned === null
      ? null
      : pendingPinned
        ? "Pinning…"
        : "Unpinning…";
  const actionRevealed = swipeOffset < 0;
  const dismissLabel = dismissPending ? "Dismissing…" : "Dismiss";
  const swipeLabel = onDismiss ? dismissLabel : pendingPinLabel ?? pinLabel;

  if (!onTogglePin && !onDismiss) {
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

  const togglePin = async () => {
    if (!onTogglePin) return;
    if (pendingPinned !== null) return;
    const nextPinned = !pinned;
    setPendingPinned(nextPinned);
    setPinError(null);
    try {
      await onTogglePin(nextPinned);
      setSwipeOffset(0);
    } catch (error) {
      setPinError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingPinned(null);
    }
  };
  const dismiss = async () => {
    if (!onDismiss || dismissPending) return;
    setDismissPending(true);
    setDismissError(null);
    try {
      await onDismiss();
      setSwipeOffset(0);
    } catch (error) {
      setDismissError(error instanceof Error ? error.message : String(error));
    } finally {
      setDismissPending(false);
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
        accessibilityState={{
          busy: onDismiss ? dismissPending : pendingPinned !== null,
          disabled: onDismiss ? dismissPending : pendingPinned !== null
        }}
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
                  pending: dismissPending,
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
