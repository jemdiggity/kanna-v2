import React, { useMemo, useRef, useState } from "react";
import {
  PanResponder,
  StyleSheet,
  Text,
  View,
  type PanResponderGestureState
} from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import { TaskCard } from "./TaskCard";
import {
  TASK_ROW_ACTION_WIDTH,
  clampTaskRowSwipe,
  shouldBeginTaskRowSwipe,
  shouldCommitTaskRowAction,
  taskRowActionEmphasis
} from "./taskRowSwipe";

function beginsSwipe(gestureState: PanResponderGestureState): boolean {
  return shouldBeginTaskRowSwipe({
    dx: gestureState.dx,
    dy: gestureState.dy
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
  // The swipe commits when the finger lifts, so the row has one resting
  // position and every drag is measured from it. `PanResponder` builds its
  // config once, so the release reaches the current action through a ref
  // rather than the handlers it captured on the first render.
  const commitRef = useRef<() => void>(() => undefined);
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
          const released = clampTaskRowSwipe(gestureState.dx);
          setSwipeOffset(0);
          if (shouldCommitTaskRowAction(released)) {
            commitRef.current();
          }
        },
        // A terminated gesture is one the row lost, not one the user let go
        // of: it takes the row back to rest and performs nothing.
        onPanResponderTerminate: () => {
          setSwipeOffset(0);
        },
        onPanResponderTerminationRequest: () => false
      }),
    []
  );

  // Pin and dismiss are phone-local writes, so the row has no in-flight state
  // to report: the label is whatever this phone's own record says right now.
  const pinLabel = pinned ? "Unpin" : "Pin";
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

  const togglePin = async () => {
    if (!onTogglePin) return;
    setPinError(null);
    try {
      await onTogglePin(!pinned);
    } catch (error) {
      setPinError(error instanceof Error ? error.message : String(error));
    }
  };
  const dismiss = async () => {
    if (!onDismiss) return;
    setDismissError(null);
    try {
      await onDismiss();
    } catch (error) {
      setDismissError(error instanceof Error ? error.message : String(error));
    }
  };
  commitRef.current = () => {
    if (onDismiss) {
      void dismiss();
    } else {
      void togglePin();
    }
  };

  return (
    <View style={styles.container}>
      {/*
        The action is never a resting, tappable state any more, so it is drawn
        for the eye alone: VoiceOver reaches pin and dismiss through the row's
        own accessibility actions, and an exposed twin of them here would only
        be a second, unreachable copy.
      */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.action,
          onDismiss
            ? styles.dismissAction
            : pinned
              ? styles.unpinAction
              : styles.pinAction,
          taskRowActionEmphasis(swipeOffset)
        ]}
        testID={
          onDismiss
            ? MOBILE_E2E_IDS.activityDismissAction(uiId)
            : MOBILE_E2E_IDS.taskPinAction(uiId)
        }
      >
        <Text style={styles.actionLabel}>{swipeLabel}</Text>
      </View>
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
