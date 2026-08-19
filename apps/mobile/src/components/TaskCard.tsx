import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent
} from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import { isTaskBlocked } from "../lib/api/taskIdentity";
import { buildTaskListItemModel } from "../screens/taskPresentation";

/**
 * Pin state has no button of its own: swiping the row is the only pin
 * affordance. The card keeps this action so VoiceOver users still reach
 * pin/unpin through the row's accessibility actions, and so an in-flight
 * failure can be reported inline on the row that failed.
 */
export interface TaskCardPinAction {
  error: string | null;
  onToggle(): void;
}

/**
 * Dismiss has no button of its own either: swiping the row is the only
 * dismiss affordance, and this action keeps it reachable from VoiceOver. It
 * is a local write, so there is no pending state to report — only a failure
 * to record it.
 */
export interface TaskCardDismissAction {
  error: string | null;
  onDismiss(): void;
}

interface TaskCardProps {
  task: TaskSummary;
  uiId?: string;
  isSubtask?: boolean;
  repoLabel?: string | null;
  /** This phone's own pin state for the row. */
  pinned?: boolean;
  pinAction?: TaskCardPinAction;
  dismissAction?: TaskCardDismissAction;
  onPress(): void;
}

export function TaskCard({
  task,
  uiId = task.id,
  isSubtask = false,
  repoLabel = null,
  pinned = false,
  pinAction,
  dismissAction,
  onPress
}: TaskCardProps) {
  const model = buildTaskListItemModel(task);
  const blocked = isTaskBlocked(task);
  const pinLabel = pinned ? "Unpin" : "Pin";
  const accessibilityLabel = [
    isSubtask ? "Subtask" : null,
    blocked ? "Blocked" : null,
    pinned ? "Pinned" : null,
    model.title,
    repoLabel,
    model.stageLabel,
    model.waitingPromptSnippet
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");
  const effectiveActivity =
    task.activity === "working" || task.activity === "unread"
      ? task.activity
      : "idle";
  const titleActivityStyle =
    effectiveActivity === "unread"
      ? styles.titleUnread
      : effectiveActivity === "working"
        ? styles.titleWorking
        : styles.titleIdle;
  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === (pinned ? "unpin" : "pin")) {
      pinAction?.onToggle();
    } else if (event.nativeEvent.actionName === "dismiss") {
      dismissAction?.onDismiss();
    }
  };
  const accessibilityActions = [
    ...(pinAction
      ? [{ name: pinned ? "unpin" : "pin", label: pinLabel }]
      : []),
    ...(dismissAction ? [{ name: "dismiss", label: "Dismiss" }] : [])
  ];

  return (
    <Pressable
      accessibilityActions={
        accessibilityActions.length > 0 ? accessibilityActions : undefined
      }
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityValue={{ text: effectiveActivity }}
      accessible
      style={[styles.card, pinned ? styles.cardPinned : null]}
      testID={MOBILE_E2E_IDS.taskListItem(uiId)}
      onAccessibilityAction={handleAccessibilityAction}
      onPress={onPress}
    >
      {repoLabel ? (
        <Text numberOfLines={1} style={styles.repoLabel}>
          {repoLabel}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Text numberOfLines={2} style={[styles.title, titleActivityStyle]}>
          {model.title}
        </Text>
        <View style={styles.pillColumn}>
          <View style={styles.stagePill}>
            <Text style={styles.stageLabel}>{model.stageLabel}</Text>
          </View>
          {blocked ? (
            <View style={[styles.stagePill, styles.blockedPill]}>
              <Text style={[styles.stageLabel, styles.blockedLabel]}>
                blocked
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      {model.waitingPromptSnippet ? (
        <Text
          numberOfLines={3}
          style={[
            styles.preview,
            model.isWaitingPromptPlaceholder
              ? styles.previewPlaceholder
              : null
          ]}
        >
          {model.waitingPromptSnippet}
        </Text>
      ) : null}
      {pinAction?.error ? (
        <Text
          accessibilityLiveRegion="polite"
          style={styles.pinError}
          testID={MOBILE_E2E_IDS.taskPinError(uiId)}
        >
          {pinAction.error}
        </Text>
      ) : null}
      {dismissAction?.error ? (
        <Text
          accessibilityLiveRegion="polite"
          style={styles.actionError}
          testID={MOBILE_E2E_IDS.activityDismissError(uiId)}
        >
          {dismissAction.error}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#111B2C",
    borderColor: "#20304C",
    borderRadius: 20,
    borderWidth: 1,
    gap: 10,
    padding: 16
  },
  /**
   * Pinned rows say so with their outline: the same border, one step brighter.
   * The row's position already carries most of the message, so this only has
   * to be legible at a glance — a badge or glyph would shout over the stage
   * pill it sits beside.
   */
  cardPinned: {
    borderColor: "#4C6FA8"
  },
  row: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  repoLabel: {
    color: "#7E93B4",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: -4,
    textTransform: "uppercase"
  },
  title: {
    color: "#F3F7FF",
    flex: 1,
    fontSize: 17
  },
  titleIdle: {
    fontStyle: "normal",
    fontWeight: "normal"
  },
  titleUnread: {
    fontStyle: "normal",
    fontWeight: "bold"
  },
  titleWorking: {
    fontStyle: "italic",
    fontWeight: "normal"
  },
  pillColumn: {
    alignItems: "flex-end",
    gap: 6
  },
  stagePill: {
    alignSelf: "flex-start",
    backgroundColor: "#172843",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  blockedPill: {
    alignSelf: "flex-end",
    backgroundColor: "#2B2033"
  },
  blockedLabel: {
    color: "#C9A8E0"
  },
  stageLabel: {
    color: "#9EB6DC",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase"
  },
  preview: {
    color: "#B8C6DB",
    fontSize: 14,
    lineHeight: 20
  },
  previewPlaceholder: {
    color: "#6F819E"
  },
  pinError: {
    color: "#FF9DAA",
    fontSize: 13,
    lineHeight: 18
  },
  actionError: {
    color: "#FF9DAA",
    fontSize: 13,
    lineHeight: 18
  }
});
