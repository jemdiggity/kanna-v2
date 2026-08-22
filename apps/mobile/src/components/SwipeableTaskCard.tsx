import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  LayoutAnimation,
  PanResponder,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type PanResponderGestureState
} from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import { TaskCard } from "./TaskCard";
import {
  TASK_ROW_ACTION_WIDTH,
  TASK_ROW_REDUCED_MOTION_FADE_MS,
  TASK_ROW_SWIPE_COMMIT_THRESHOLD,
  clampTaskRowSwipe,
  shouldBeginTaskRowSwipe,
  shouldCommitTaskRowAction,
  taskRowCompletionMotion
} from "./taskRowSwipe";

const TASK_ROW_DEFAULT_EXIT_DISTANCE = 600;
const TASK_ROW_ACTION_REVEAL_FADE_DISTANCE = 14;

interface ActionColors {
  idle: string;
  armed: string;
}

const PIN_ACTION_COLORS: ActionColors = {
  idle: "#435F96",
  armed: "#2563EB"
};
const UNPIN_ACTION_COLORS: ActionColors = {
  idle: "#743F4C",
  armed: "#9F2D42"
};
const DISMISS_ACTION_COLORS: ActionColors = {
  idle: "#803F4B",
  armed: "#B4233C"
};

function startAnimation(
  animation: Animated.CompositeAnimation,
  onFinished: () => void
): void {
  animation.start(({ finished }) => {
    if (finished) onFinished();
  });
}

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
  /** The row's short task id; see {@link TaskCard}. */
  shortId?: string | null;
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
  shortId = null,
  pinned = false,
  onPress,
  onDismiss,
  onTogglePin
}: SwipeableTaskCardProps) {
  const swipeOffset = useRef(new Animated.Value(0)).current;
  const completionOpacity = useRef(new Animated.Value(1)).current;
  const actionArmed = useRef(new Animated.Value(0)).current;
  const actionColorArmed = useRef(new Animated.Value(0)).current;
  const [pinError, setPinError] = useState<string | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState(false);
  const reduceMotionRef = useRef(false);
  const armedRef = useRef(false);
  const completingRef = useRef(false);
  const exitDistanceRef = useRef(TASK_ROW_DEFAULT_EXIT_DISTANCE);
  // The swipe commits when the finger lifts, so the row has one resting
  // position and every drag is measured from it. `PanResponder` builds its
  // config once, so the release reaches the current action through a ref
  // rather than the handlers it captured on the first render.
  const commitRef = useRef<() => Promise<boolean>>(async () => false);

  useEffect(() => {
    let mounted = true;
    const update = (enabled: boolean) => {
      if (!mounted) return;
      reduceMotionRef.current = enabled;
      setReduceMotionEnabled(enabled);
    };
    void AccessibilityInfo.isReduceMotionEnabled().then(update);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      update
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  const resetAnimatedRow = () => {
    swipeOffset.setValue(0);
    completionOpacity.setValue(1);
    actionArmed.setValue(0);
    actionColorArmed.setValue(0);
    armedRef.current = false;
    completingRef.current = false;
  };

  const animateArmedState = (armed: boolean) => {
    if (armedRef.current === armed) return;
    armedRef.current = armed;
    if (reduceMotionRef.current) {
      actionArmed.setValue(armed ? 1 : 0);
      actionColorArmed.setValue(armed ? 1 : 0);
      return;
    }
    Animated.parallel([
      Animated.spring(actionArmed, {
        damping: 14,
        mass: 0.55,
        stiffness: 360,
        toValue: armed ? 1 : 0,
        useNativeDriver: true
      }),
      Animated.timing(actionColorArmed, {
        duration: 110,
        toValue: armed ? 1 : 0,
        useNativeDriver: false
      })
    ]).start();
  };

  const springClosed = () => {
    completingRef.current = false;
    animateArmedState(false);
    if (reduceMotionRef.current) {
      startAnimation(
        Animated.parallel([
          Animated.timing(swipeOffset, {
            duration: TASK_ROW_REDUCED_MOTION_FADE_MS,
            toValue: 0,
            useNativeDriver: true
          }),
          Animated.timing(completionOpacity, {
            duration: TASK_ROW_REDUCED_MOTION_FADE_MS,
            toValue: 1,
            useNativeDriver: true
          })
        ]),
        resetAnimatedRow
      );
      return;
    }
    startAnimation(
      Animated.spring(swipeOffset, {
        damping: 20,
        mass: 0.75,
        stiffness: 260,
        toValue: 0,
        useNativeDriver: true
      }),
      resetAnimatedRow
    );
  };

  const finishCommittedAction = async () => {
    if (!reduceMotionRef.current) {
      LayoutAnimation.configureNext(
        onDismiss
          ? LayoutAnimation.Presets.easeInEaseOut
          : LayoutAnimation.Presets.spring
      );
    }
    const succeeded = await commitRef.current();
    if (succeeded) {
      resetAnimatedRow();
    } else {
      springClosed();
    }
  };

  const completeSwipe = () => {
    completingRef.current = true;
    if (taskRowCompletionMotion(reduceMotionRef.current) === "fade") {
      startAnimation(
        Animated.timing(completionOpacity, {
          duration: TASK_ROW_REDUCED_MOTION_FADE_MS,
          toValue: 0,
          useNativeDriver: true
        }),
        () => {
          void finishCommittedAction();
        }
      );
      return;
    }

    if (onDismiss) {
      startAnimation(
        Animated.spring(swipeOffset, {
          damping: 18,
          mass: 0.8,
          stiffness: 210,
          toValue: -exitDistanceRef.current,
          useNativeDriver: true
        }),
        () => {
          void finishCommittedAction();
        }
      );
      return;
    }

    startAnimation(
      Animated.sequence([
        Animated.spring(swipeOffset, {
          damping: 12,
          mass: 0.65,
          stiffness: 300,
          toValue: -TASK_ROW_ACTION_WIDTH,
          useNativeDriver: true
        }),
        Animated.spring(swipeOffset, {
          damping: 15,
          mass: 0.7,
          stiffness: 240,
          toValue: 0,
          useNativeDriver: true
        })
      ]),
      () => {
        void finishCommittedAction();
      }
    );
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
          beginsSwipe(gestureState),
        onMoveShouldSetPanResponderCapture: (_event, gestureState) =>
          beginsSwipe(gestureState),
        onPanResponderMove: (_event, gestureState) => {
          if (completingRef.current) return;
          const offset = clampTaskRowSwipe(gestureState.dx);
          swipeOffset.setValue(offset);
          animateArmedState(shouldCommitTaskRowAction(offset));
        },
        onPanResponderRelease: (_event, gestureState) => {
          const released = clampTaskRowSwipe(gestureState.dx);
          if (shouldCommitTaskRowAction(released)) {
            completeSwipe();
          } else {
            springClosed();
          }
        },
        // A terminated gesture is one the row lost, not one the user let go
        // of: it takes the row back to rest and performs nothing.
        onPanResponderTerminate: () => {
          springClosed();
        },
        onPanResponderTerminationRequest: () => false
      }),
    []
  );

  // Pin and dismiss are phone-local writes, so the row has no in-flight state
  // to report: the label is whatever this phone's own record says right now.
  const pinLabel = pinned ? "Unpin" : "Pin";
  const swipeLabel = onDismiss ? "Dismiss" : pinLabel;
  const measureRow = (event: LayoutChangeEvent) => {
    exitDistanceRef.current =
      Math.max(event.nativeEvent.layout.width, TASK_ROW_ACTION_WIDTH * 2) +
      TASK_ROW_ACTION_WIDTH;
  };

  if (!onTogglePin && !onDismiss) {
    return (
      <TaskCard
        isSubtask={isSubtask}
        pinned={pinned}
        repoLabel={repoLabel}
        shortId={shortId}
        task={task}
        uiId={uiId}
        onPress={onPress}
      />
    );
  }

  const togglePin = async (): Promise<boolean> => {
    if (!onTogglePin) return false;
    setPinError(null);
    try {
      await onTogglePin(!pinned);
      return true;
    } catch (error) {
      setPinError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const dismiss = async (): Promise<boolean> => {
    if (!onDismiss) return false;
    setDismissError(null);
    try {
      await onDismiss();
      return true;
    } catch (error) {
      setDismissError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  commitRef.current = () => {
    if (onDismiss) {
      return dismiss();
    }
    return togglePin();
  };

  const actionOpacity = reduceMotionEnabled
    ? 1
    : swipeOffset.interpolate({
        inputRange: [
          -TASK_ROW_ACTION_WIDTH,
          -TASK_ROW_ACTION_REVEAL_FADE_DISTANCE,
          0
        ],
        outputRange: [1, 1, 0]
      });
  const actionScale = actionArmed.interpolate({
    inputRange: [0, 1],
    outputRange: [0.88, 1.04]
  });
  const actionColors = onDismiss
    ? DISMISS_ACTION_COLORS
    : pinned
      ? UNPIN_ACTION_COLORS
      : PIN_ACTION_COLORS;
  const actionBackgroundColor = actionColorArmed.interpolate({
    inputRange: [0, 1],
    outputRange: [actionColors.idle, actionColors.armed]
  });
  const reducedMotionRowOpacity = reduceMotionEnabled
    ? swipeOffset.interpolate({
        inputRange: [-TASK_ROW_ACTION_WIDTH, 0],
        outputRange: [0.72, 1]
      })
    : 1;

  return (
    <View style={styles.container} onLayout={measureRow}>
      {/*
        The action is never a resting, tappable state any more, so it is drawn
        for the eye alone: VoiceOver reaches pin and dismiss through the row's
        own accessibility actions, and an exposed twin of them here would only
        be a second, unreachable copy.
      */}
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.action,
          onDismiss
            ? styles.dismissAction
            : pinned
              ? styles.unpinAction
              : styles.pinAction,
          {
            backgroundColor: actionBackgroundColor,
            opacity: actionOpacity,
            transform: reduceMotionEnabled ? [] : [{ scale: actionScale }]
          }
        ]}
        testID={
          onDismiss
            ? MOBILE_E2E_IDS.activityDismissAction(uiId)
            : MOBILE_E2E_IDS.taskPinAction(uiId)
        }
      >
        <Text style={styles.actionLabel}>{swipeLabel}</Text>
      </Animated.View>
      <Animated.View
        style={{
          opacity: Animated.multiply(
            completionOpacity,
            reducedMotionRowOpacity
          ),
          transform: reduceMotionEnabled ? [] : [{ translateX: swipeOffset }]
        }}
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
          shortId={shortId}
          task={task}
          uiId={uiId}
          onPress={onPress}
        />
      </Animated.View>
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
    backgroundColor: PIN_ACTION_COLORS.armed
  },
  unpinAction: {
    backgroundColor: UNPIN_ACTION_COLORS.armed
  },
  dismissAction: {
    backgroundColor: DISMISS_ACTION_COLORS.armed
  },
  actionLabel: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800"
  }
});
