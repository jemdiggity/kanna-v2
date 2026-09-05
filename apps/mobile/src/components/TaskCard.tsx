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
import {
  TASK_BLOCKED_THEME,
  TASK_STAGE_STRIPE_WIDTH,
  resolveTaskStageTheme
} from "../theme/taskStageTheme";

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
  /**
   * The task's display id, rendered beside the title in the bounded metadata
   * column. The owner references tasks by this id constantly; long ids
   * middle-ellipsize so neither they nor a long title consumes the row.
   * Rows without a durable id yet pass null and render no id.
   */
  shortId?: string | null;
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
  shortId = null,
  pinned = false,
  pinAction,
  dismissAction,
  onPress
}: TaskCardProps) {
  const model = buildTaskListItemModel(task);
  const blocked = isTaskBlocked(task);
  // Stage sets the row's hue; pinning sets how brightly its outline burns.
  // The two signals stay readable together because they never fight over the
  // same channel.
  const stageTheme = resolveTaskStageTheme(task.stage);
  const pinLabel = pinned ? "Unpin" : "Pin";
  const accessibilityLabel = [
    isSubtask ? "Subtask" : null,
    blocked ? "Blocked" : null,
    pinned ? "Pinned" : null,
    model.title,
    shortId ? `Task ID ${shortId}` : null,
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
      style={[
        styles.card,
        {
          backgroundColor: stageTheme.surface,
          borderColor: pinned ? stageTheme.pinnedBorder : stageTheme.border,
          borderLeftColor: stageTheme.accent
        }
      ]}
      testID={MOBILE_E2E_IDS.taskListItem(uiId)}
      onAccessibilityAction={handleAccessibilityAction}
      onPress={onPress}
    >
      {repoLabel ? (
        <Text
          numberOfLines={1}
          style={[styles.repoLabel, { color: stageTheme.secondaryLabel }]}
        >
          {repoLabel}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Text numberOfLines={2} style={[styles.title, titleActivityStyle]}>
          {model.title}
        </Text>
        <View style={styles.pillColumn}>
          {shortId ? (
            <Text
              ellipsizeMode="middle"
              numberOfLines={1}
              style={styles.shortId}
              testID={MOBILE_E2E_IDS.taskListItemId(uiId)}
            >
              {shortId}
            </Text>
          ) : null}
          <View
            style={[
              styles.stagePill,
              { backgroundColor: stageTheme.chipBackground }
            ]}
          >
            <Text style={[styles.stageLabel, { color: stageTheme.chipLabel }]}>
              {model.stageLabel}
            </Text>
          </View>
          {blocked ? (
            <View
              style={[
                styles.stagePill,
                styles.blockedPill,
                { backgroundColor: TASK_BLOCKED_THEME.chipBackground }
              ]}
            >
              <Text
                style={[
                  styles.stageLabel,
                  { color: TASK_BLOCKED_THEME.chipLabel }
                ]}
              >
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
  /**
   * Colour arrives per row from `resolveTaskStageTheme`: a saturated left edge
   * in the stage's icon colour, over a card surface tinted the same hue. The
   * static styles here only hold the geometry.
   *
   * Pinned rows still say so with their outline — now the stage's own colour
   * at full strength against the muted border an unpinned row wears. Stage and
   * pin stay orthogonal: hue is the stage, brightness is the pin, and a badge
   * or glyph would shout over the stage pill it sits beside.
   */
  card: {
    borderRadius: 20,
    borderWidth: 1,
    // The stripe eats 5px of the left inset, so the text starts where it did.
    borderLeftWidth: TASK_STAGE_STRIPE_WIDTH,
    gap: 10,
    padding: 16,
    paddingLeft: 16 - (TASK_STAGE_STRIPE_WIDTH - 1)
  },
  row: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  /** Colour is stage-derived: a fixed grey loses AA on the tinted surfaces. */
  repoLabel: {
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
  /** Bounded metadata keeps both a long id and the title readable. */
  pillColumn: {
    alignItems: "flex-end",
    flexShrink: 0,
    gap: 6,
    maxWidth: "45%"
  },
  stagePill: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  blockedPill: {
    alignSelf: "flex-end"
  },
  // Subordinate to the title on purpose: legible for cross-checking, quiet
  // enough that the row still reads title-first.
  shortId: {
    alignSelf: "flex-end",
    color: "#6F819E",
    fontFamily: "Menlo",
    fontSize: 11,
    maxWidth: "100%"
  },
  stageLabel: {
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
