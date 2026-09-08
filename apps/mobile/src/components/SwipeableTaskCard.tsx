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
  TASK_ROW_REDUCED_MOTION_TIMING_MS,
  TASK_ROW_SWIPE_COMMIT_THRESHOLD,
  clampTaskRowSwipe,
  shouldBeginTaskRowSwipe,
  shouldCommitTaskRowAction,
  taskRowCompletionMotion
} from "./taskRowSwipe";

const TASK_ROW_DEFAULT_EXIT_DISTANCE = 600;

/**
 * A committed pin is confirmed in the hand as well as on the screen. Haptics
 * is already part of the app's native surface, so this is a JS-only use of a
 * module the binary already carries; it is loaded lazily and every failure is
 * silent, so a build or device without it simply gets the visual confirmation.
 */
function confirmCommitWithHaptics(): void {
  void import("expo-haptics")
    .then((haptics) => haptics.impactAsync(haptics.ImpactFeedbackStyle.Light))
    .catch(() => undefined);
}

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
  const actionArmed = useRef(new Animated.Value(0)).current;
  const actionColorArmed = useRef(new Animated.Value(0)).current;
  const [pinError, setPinError] = useState<string | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const reduceMotionRef = useRef(false);
  const armedRef = useRef(false);
  const completingRef = useRef(false);
  const exitDistanceRef = useRef(TASK_ROW_DEFAULT_EXIT_DISTANCE);
  /**
   * The pin state the action is drawn from while a committed row closes over
   * it. The row's own pin state flips on the frame the swipe commits, and the
   * action underneath must not flip with it half-way through the close.
   */
  const [closingFromPinned, setClosingFromPinned] = useState<boolean | null>(
    null
  );
  // The swipe commits when the finger lifts, so the row has one resting
  // position and every drag is measured from it. `PanResponder` builds its
  // config once, so the release reaches the current action through refs
  // rather than the handlers it captured on the first render.
  const commitRef = useRef<() => Promise<boolean>>(async () => false);
  const commitPinRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let mounted = true;
    const update = (enabled: boolean) => {
      if (!mounted) return;
      reduceMotionRef.current = enabled;
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
        useNativeDriver: true
      })
    ]).start();
  };

  const springClosed = () => {
    completingRef.current = false;
    animateArmedState(false);
    if (reduceMotionRef.current) {
      startAnimation(
        Animated.timing(swipeOffset, {
          duration: TASK_ROW_REDUCED_MOTION_TIMING_MS,
          toValue: 0,
          useNativeDriver: true
        }),
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

  /**
   * A dismissed row leaves the list, so its record is written once the row has
   * finished travelling off screen: there is nothing left to animate into, and
   * a row that could not be dismissed springs back instead of vanishing.
   */
  const finishDismiss = async () => {
    if (!reduceMotionRef.current) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    }
    const succeeded = await commitRef.current();
    if (succeeded) {
      resetAnimatedRow();
    } else {
      springClosed();
    }
  };

  /**
   * Takes the committed row back to rest. The pin it just wrote is already on
   * the screen, so this is the receipt for a state change that has happened —
   * short, and never the thing the state is waiting on.
   */
  const closeAfterPinCommit = () => {
    const settle = () => {
      resetAnimatedRow();
      setClosingFromPinned(null);
    };
    if (reduceMotionRef.current) {
      startAnimation(
        Animated.timing(swipeOffset, {
          duration: TASK_ROW_REDUCED_MOTION_TIMING_MS,
          toValue: 0,
          useNativeDriver: true
        }),
        settle
      );
      return;
    }
    startAnimation(
      Animated.spring(swipeOffset, {
        damping: 22,
        mass: 0.6,
        stiffness: 420,
        toValue: 0,
        useNativeDriver: true
      }),
      settle
    );
  };

  const completeSwipe = () => {
    completingRef.current = true;

    if (onDismiss) {
      startAnimation(
        taskRowCompletionMotion(reduceMotionRef.current) === "timing"
          ? Animated.timing(swipeOffset, {
              duration: TASK_ROW_REDUCED_MOTION_TIMING_MS,
              toValue: -exitDistanceRef.current,
              useNativeDriver: true
            })
          : Animated.spring(swipeOffset, {
              damping: 18,
              mass: 0.8,
              stiffness: 210,
              toValue: -exitDistanceRef.current,
              useNativeDriver: true
            }),
        () => {
          void finishDismiss();
        }
      );
      return;
    }

    // Pinning is a record this phone already holds, so the finger lifting is
    // the whole event: the row's pin state and its place in the list change
    // now, and the row closes over an action that no longer has anything to
    // wait for.
    commitPinRef.current();
    closeAfterPinCommit();
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
          // A row already performing its action does not perform it twice.
          if (completingRef.current) return;
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
  // to report: the label is whatever this phone's own record says right now —
  // except under a row that is still closing over its own committed swipe,
  // which keeps describing the state that swipe acted on.
  const actionPinned = closingFromPinned ?? pinned;
  const swipeLabel = onDismiss ? "Dismiss" : actionPinned ? "Unpin" : "Pin";
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

  /**
   * Performs the pin now. The record is local, so nothing here waits: the list
   * is told to animate the reorder this write is about to cause, the write
   * happens, and persistence is left to settle behind the interaction — a
   * failure comes back to the row as an inline error, not as a frozen gesture.
   */
  const commitPin = (holdActionThroughClose = false) => {
    if (!onTogglePin) return;
    if (holdActionThroughClose) setClosingFromPinned(pinned);
    confirmCommitWithHaptics();
    // Deliberately no `LayoutAnimation` here. The row's new place in the list
    // is a fact the moment the finger lifts, and animating the reorder means
    // the row is still travelling for as long as the animation runs — which
    // is the delay this row is supposed to have stopped having. The swipe
    // closing over the action is the motion; the position is not animated.
    void togglePin();
  };
  commitPinRef.current = () => commitPin(true);

  const actionScale = actionArmed.interpolate({
    inputRange: [0, 1],
    outputRange: [0.88, 1.04]
  });
  const actionColors = onDismiss
    ? DISMISS_ACTION_COLORS
    : actionPinned
      ? UNPIN_ACTION_COLORS
      : PIN_ACTION_COLORS;
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
          {
            transform: [{ scale: actionScale }]
          }
        ]}
        testID={
          onDismiss
            ? MOBILE_E2E_IDS.activityDismissAction(uiId)
            : MOBILE_E2E_IDS.taskPinAction(uiId)
        }
      >
        <View
          style={[
            styles.actionBackground,
            { backgroundColor: actionColors.idle }
          ]}
        />
        <Animated.View
          style={[
            styles.actionBackground,
            {
              backgroundColor: actionColors.armed,
              opacity: actionColorArmed
            }
          ]}
        />
        <Text style={styles.actionLabel}>{swipeLabel}</Text>
      </Animated.View>
      <Animated.View
        style={{
          opacity: 1,
          transform: [{ translateX: swipeOffset }]
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
                    commitPin();
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
  actionBackground: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0
  },
  actionLabel: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800"
  }
});
