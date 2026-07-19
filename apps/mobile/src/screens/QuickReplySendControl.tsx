import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View
} from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import {
  exceedsTaskQuickReplyTapSlop,
  selectTaskQuickReplyIndex,
  TASK_QUICK_REPLY_CARD_GAP,
  TASK_QUICK_REPLY_CARD_HEIGHT,
  TASK_QUICK_REPLY_CARD_WIDTH,
  TASK_QUICK_REPLY_LONG_PRESS_MS
} from "./taskQuickReplyGesture";
import type { TaskQuickReply } from "./taskQuickReplies";

interface QuickReplySendControlProps {
  disabled: boolean;
  gestureScopeKey: string;
  hydrated: boolean;
  replies: readonly TaskQuickReply[];
  onPress(): void;
  onSelectReply(replyId: string): void;
}

type GesturePhase = "idle" | "tracking" | "active";

export function QuickReplySendControl({
  disabled,
  gestureScopeKey,
  hydrated,
  replies,
  onPress,
  onSelectReply
}: QuickReplySendControlProps) {
  const propsRef = useRef({
    disabled,
    gestureScopeKey,
    hydrated,
    replies,
    onPress,
    onSelectReply
  });
  propsRef.current = {
    disabled,
    gestureScopeKey,
    hydrated,
    replies,
    onPress,
    onSelectReply
  };

  const mountedRef = useRef(true);
  const phaseRef = useRef<GesturePhase>("idle");
  const selectedIndexRef = useRef<number | null>(null);
  const gestureScopeAtGrantRef = useRef<string | null>(null);
  const cancelledTapRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entrance = useRef(new Animated.Value(0)).current;
  const [active, setActive] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);

  const clearLongPressTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resetGesture = useCallback(() => {
    clearLongPressTimer();
    phaseRef.current = "idle";
    selectedIndexRef.current = null;
    gestureScopeAtGrantRef.current = null;
    cancelledTapRef.current = false;
    if (mountedRef.current) {
      setSelectedIndex(null);
      setActive(false);
    }
  }, [clearLongPressTimer]);

  const activateGesture = useCallback(() => {
    timerRef.current = null;
    if (!mountedRef.current || phaseRef.current !== "tracking") {
      return;
    }
    if (
      propsRef.current.disabled ||
      gestureScopeAtGrantRef.current !== propsRef.current.gestureScopeKey ||
      !propsRef.current.hydrated ||
      propsRef.current.replies.length === 0
    ) {
      cancelledTapRef.current = true;
      return;
    }

    phaseRef.current = "active";
    entrance.setValue(0);
    setActive(true);
    Animated.timing(entrance, {
      duration: 140,
      toValue: 1,
      useNativeDriver: true
    }).start();
  }, [entrance]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !propsRef.current.disabled,
        onMoveShouldSetPanResponder: () => false,
        onPanResponderGrant: () => {
          if (propsRef.current.disabled) {
            return;
          }
          clearLongPressTimer();
          phaseRef.current = "tracking";
          gestureScopeAtGrantRef.current =
            propsRef.current.gestureScopeKey;
          selectedIndexRef.current = null;
          cancelledTapRef.current = false;
          timerRef.current = setTimeout(
            activateGesture,
            TASK_QUICK_REPLY_LONG_PRESS_MS
          );
        },
        onPanResponderMove: (_event, gestureState) => {
          if (phaseRef.current === "tracking") {
            if (exceedsTaskQuickReplyTapSlop(gestureState)) {
              clearLongPressTimer();
              cancelledTapRef.current = true;
            }
            return;
          }
          if (phaseRef.current !== "active") {
            return;
          }

          const nextIndex = selectTaskQuickReplyIndex(
            gestureState,
            propsRef.current.replies.length
          );
          if (nextIndex !== selectedIndexRef.current) {
            selectedIndexRef.current = nextIndex;
            setSelectedIndex(nextIndex);
          }
        },
        onPanResponderRelease: (_event, gestureState) => {
          const phase = phaseRef.current;
          const gestureIsCurrent =
            !propsRef.current.disabled &&
            gestureScopeAtGrantRef.current ===
              propsRef.current.gestureScopeKey;
          const releaseIndex =
            phase === "active" && gestureIsCurrent
              ? selectTaskQuickReplyIndex(
                  gestureState,
                  propsRef.current.replies.length
                )
              : null;
          const selectedReply =
            releaseIndex !== null
              ? propsRef.current.replies[releaseIndex]
              : null;
          const shouldSendDraft =
            gestureIsCurrent &&
            phase === "tracking" &&
            !cancelledTapRef.current &&
            !exceedsTaskQuickReplyTapSlop(gestureState);
          resetGesture();

          if (selectedReply) {
            propsRef.current.onSelectReply(selectedReply.id);
          } else if (shouldSendDraft) {
            propsRef.current.onPress();
          }
        },
        onPanResponderTerminate: resetGesture,
        onPanResponderTerminationRequest: () => false
      }),
    [activateGesture, resetGesture]
  );

  const previousGestureScopeKeyRef = useRef(gestureScopeKey);
  useEffect(() => {
    const scopeChanged =
      previousGestureScopeKeyRef.current !== gestureScopeKey;
    previousGestureScopeKeyRef.current = gestureScopeKey;
    if (disabled || scopeChanged) {
      resetGesture();
    }
  }, [disabled, gestureScopeKey, resetGesture]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      clearLongPressTimer();
      phaseRef.current = "idle";
    }, []
  );

  const selectAccessibleReply = (replyId: string) => {
    setPickerVisible(false);
    propsRef.current.onSelectReply(replyId);
  };

  return (
    <View style={styles.host}>
      {active ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.rail,
            {
              opacity: entrance,
              transform: [
                {
                  translateY: entrance.interpolate({
                    inputRange: [0, 1],
                    outputRange: [8, 0]
                  })
                },
                {
                  scale: entrance.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.96, 1]
                  })
                }
              ]
            }
          ]}
          testID={MOBILE_E2E_IDS.taskQuickReplyRail}
        >
          {replies.map((reply, index) => (
            <QuickReplyCard
              key={reply.id}
              reply={reply}
              selected={selectedIndex === index}
            />
          ))}
        </Animated.View>
      ) : null}

      <View
        {...panResponder.panHandlers}
        accessible
        accessibilityActions={[
          { name: "activate", label: "Send reply" },
          { name: "showQuickReplies", label: "Show quick replies" }
        ]}
        accessibilityHint="Activate to send. Show quick replies for saved replies."
        accessibilityLabel="Send reply"
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        onAccessibilityAction={(event) => {
          if (propsRef.current.disabled) {
            return;
          }
          if (event.nativeEvent.actionName === "activate") {
            propsRef.current.onPress();
          } else if (
            event.nativeEvent.actionName === "showQuickReplies" &&
            propsRef.current.hydrated
          ) {
            setPickerVisible(true);
          }
        }}
        style={[styles.sendButton, disabled ? styles.sendButtonDisabled : null]}
        testID={MOBILE_E2E_IDS.taskSendButton}
      >
        <Text style={styles.sendButtonLabel}>Send</Text>
      </View>

      <Modal
        animationType="fade"
        transparent
        visible={pickerVisible}
        onRequestClose={() => setPickerVisible(false)}
      >
        <View style={styles.pickerBackdrop}>
          <View
            accessibilityViewIsModal
            style={styles.picker}
            testID={MOBILE_E2E_IDS.taskQuickReplyPicker}
          >
            <Text style={styles.pickerTitle}>Quick Replies</Text>
            {replies.map((reply) => (
              <Pressable
                accessibilityLabel={reply.text}
                accessibilityRole="button"
                key={reply.id}
                onPress={() => selectAccessibleReply(reply.id)}
                style={styles.pickerReply}
                testID={MOBILE_E2E_IDS.taskQuickReply(reply.id)}
              >
                <Text style={styles.pickerReplyLabel}>{reply.text}</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => setPickerVisible(false)}
              style={styles.pickerCancel}
              testID={MOBILE_E2E_IDS.taskQuickReplyPickerCancel}
            >
              <Text style={styles.pickerCancelLabel}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function QuickReplyCard({
  reply,
  selected
}: {
  reply: TaskQuickReply;
  selected: boolean;
}) {
  const highlight = useRef(new Animated.Value(selected ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(highlight, {
      duration: 90,
      toValue: selected ? 1 : 0,
      useNativeDriver: true
    }).start();
  }, [highlight, selected]);

  return (
    <Animated.View
      accessibilityLabel={reply.text}
      accessibilityState={{ selected }}
      style={[
        styles.replyCard,
        selected ? styles.replyCardSelected : null,
        {
          transform: [
            {
              scale: highlight.interpolate({
                inputRange: [0, 1],
                outputRange: [1, 1.045]
              })
            }
          ]
        }
      ]}
      testID={MOBILE_E2E_IDS.taskQuickReply(reply.id)}
    >
      <Text
        allowFontScaling={false}
        ellipsizeMode="tail"
        numberOfLines={2}
        style={[
          styles.replyCardLabel,
          selected ? styles.replyCardLabelSelected : null
        ]}
      >
        {reply.text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    height: 40,
    position: "relative",
    width: 58
  },
  sendButton: {
    alignItems: "center",
    backgroundColor: "#315F9D",
    borderRadius: 14,
    height: 40,
    justifyContent: "center",
    width: 58
  },
  sendButtonDisabled: {
    opacity: 0.45
  },
  sendButtonLabel: {
    color: "#F5F7FB",
    fontSize: 13,
    fontWeight: "700"
  },
  rail: {
    bottom: TASK_QUICK_REPLY_CARD_GAP + 40,
    flexDirection: "column-reverse",
    gap: TASK_QUICK_REPLY_CARD_GAP,
    position: "absolute",
    right: 0,
    width: TASK_QUICK_REPLY_CARD_WIDTH
  },
  replyCard: {
    backgroundColor: "#12233B",
    borderColor: "#38557E",
    borderRadius: 17,
    borderWidth: 1,
    justifyContent: "center",
    height: TASK_QUICK_REPLY_CARD_HEIGHT,
    paddingHorizontal: 15,
    paddingVertical: 8,
    shadowColor: "#000000",
    shadowOffset: { height: 12, width: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 12
  },
  replyCardSelected: {
    backgroundColor: "#285A98",
    borderColor: "#82B9FF",
    borderWidth: 2
  },
  replyCardLabel: {
    color: "#DCEAFF",
    fontSize: 13,
    fontWeight: "700"
  },
  replyCardLabelSelected: {
    color: "#FFFFFF"
  },
  pickerBackdrop: {
    backgroundColor: "rgba(2, 6, 14, 0.72)",
    flex: 1,
    justifyContent: "flex-end",
    padding: 16
  },
  picker: {
    backgroundColor: "#0D1727",
    borderColor: "#2B4265",
    borderRadius: 24,
    borderWidth: 1,
    gap: 8,
    padding: 18
  },
  pickerTitle: {
    color: "#F5F7FB",
    fontSize: 20,
    fontWeight: "800",
    marginBottom: 4
  },
  pickerReply: {
    backgroundColor: "#12233B",
    borderColor: "#38557E",
    borderRadius: 16,
    borderWidth: 1,
    padding: 14
  },
  pickerReplyLabel: {
    color: "#E5F0FF",
    fontSize: 15,
    fontWeight: "700"
  },
  pickerCancel: {
    alignItems: "center",
    padding: 12
  },
  pickerCancelLabel: {
    color: "#9EB5D3",
    fontSize: 15,
    fontWeight: "700"
  }
});
