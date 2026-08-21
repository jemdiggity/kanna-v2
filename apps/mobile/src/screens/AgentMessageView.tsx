import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { AgentEvent, FrameAgentEvent, PermissionDecision, TurnStats } from "@kanna/agent-protocol";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import { LoadingText } from "../components/LoadingText";
import type { TaskTerminalStatus } from "../state/sessionStore";

interface AgentMessageViewProps {
  events: FrameAgentEvent[];
  status: TaskTerminalStatus;
  errorMessage: string | null;
  onInterrupt(): void;
  onRequestHistory?(): void;
  onResolvePermission(requestId: string, decision: PermissionDecision): void;
}

export function AgentMessageViewComponent({
  events,
  status,
  errorMessage,
  onInterrupt,
  onRequestHistory,
  onResolvePermission
}: AgentMessageViewProps) {
  const visibleEvents = events.filter(
    (item) =>
      item.event.type !== "raw" &&
      item.event.type !== "diagnostic" &&
      item.event.type !== "permission_resolved"
  );
  const debugEvents = events.filter(
    (item) => item.event.type === "raw" || item.event.type === "diagnostic"
  );
  const lastStats = [...events]
    .reverse()
    .find((item) => item.event.type === "turn_completed")?.event;
  const isStreamReady = status === "live" || status === "idle";

  return (
    <View style={styles.shell} testID={MOBILE_E2E_IDS.agentMessageView}>
      <ScrollView
        contentContainerStyle={styles.content}
        onScroll={(event) => {
          if (event.nativeEvent.contentOffset.y <= 80) onRequestHistory?.();
        }}
        scrollEventThrottle={100}
        testID={isStreamReady ? MOBILE_E2E_IDS.agentMessageReady : undefined}
      >
        {visibleEvents.map((item) => (
          <View key={item.seq} style={styles.row}>
            {renderEvent(item.event, onResolvePermission)}
          </View>
        ))}
        {lastStats?.type === "turn_completed" ? (
          <Text style={styles.stats}>{formatStats(lastStats.stats)}</Text>
        ) : null}
        {debugEvents.length > 0 ? (
          <View style={styles.debugCard}>
            <Text style={styles.debugTitle}>Debug</Text>
            {debugEvents.map((item) => (
              <Text key={item.seq} style={styles.debugText}>
                {formatDebugEvent(item.event)}
              </Text>
            ))}
          </View>
        ) : null}
        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
        {status === "connecting" ? (
          <LoadingText label="Connecting" style={styles.mutedText} />
        ) : null}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        style={styles.stopButton}
        testID={MOBILE_E2E_IDS.taskStopButton}
        onPress={onInterrupt}
      >
        <Text style={styles.stopButtonLabel}>Stop</Text>
      </Pressable>
    </View>
  );
}

// The task screen owns the agent transcript and the reply composer, so it
// re-renders on state this view has no stake in — every keystroke of a draft,
// every keyboard frame, every chrome measurement. Each of those renders walks
// the whole event list three times and rebuilds every bubble, tool card, and
// permission prompt, on a list that only grows while an agent streams. Re-render
// only when the transcript's own inputs change. This mirrors TerminalWebView,
// the sibling view on the pty path.
export const AgentMessageView = React.memo(AgentMessageViewComponent);

function renderEvent(
  event: AgentEvent,
  onResolvePermission: AgentMessageViewProps["onResolvePermission"]
) {
  switch (event.type) {
    case "turn_started":
      return <Text style={styles.mutedText}>Started{event.model ? ` - ${event.model}` : ""}</Text>;
    case "user_message":
      return <Text style={[styles.bubble, styles.userBubble]}>{event.text}</Text>;
    case "assistant_text":
      return <Text style={[styles.bubble, styles.assistantBubble]}>{event.text}</Text>;
    case "thinking":
      return (
        <View style={styles.toolCard}>
          <Text style={styles.cardTitle}>Thinking</Text>
          <Text style={styles.cardText}>{event.text}</Text>
        </View>
      );
    case "tool_call":
      return (
        <View style={styles.toolCard}>
          <Text style={styles.cardTitle}>{event.tool_name}</Text>
          <Text style={styles.cardText}>{formatValue(event.input)}</Text>
        </View>
      );
    case "tool_result":
      return (
        <View style={styles.toolCard}>
          <Text style={styles.cardTitle}>{event.is_error ? "Tool error" : "Tool result"}</Text>
          <Text style={styles.cardText}>{event.output}</Text>
        </View>
      );
    case "tool_progress":
      return <Text style={styles.mutedText}>{event.message}</Text>;
    case "permission_request":
      return (
        <View style={styles.permissionCard}>
          <Text style={styles.cardTitle}>Permission: {event.tool_name}</Text>
          <Text style={styles.cardText}>{formatValue(event.input)}</Text>
          <View style={styles.permissionActions}>
            <Pressable
              accessibilityLabel={`Allow ${event.tool_name} once`}
              accessibilityRole="button"
              style={styles.permissionButton}
              onPress={() => onResolvePermission(event.request_id, { kind: "allow" })}
            >
              <Text style={styles.permissionButtonText}>Allow</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={`Allow ${event.tool_name} for this session`}
              accessibilityRole="button"
              style={styles.permissionButton}
              onPress={() => onResolvePermission(event.request_id, { kind: "allow_session" })}
            >
              <Text style={styles.permissionButtonText}>Allow for session</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={`Deny ${event.tool_name}`}
              accessibilityRole="button"
              style={styles.permissionButton}
              onPress={() => onResolvePermission(event.request_id, { kind: "deny", reason: null })}
            >
              <Text style={styles.permissionButtonText}>Deny</Text>
            </Pressable>
          </View>
        </View>
      );
    case "turn_completed":
      return <Text style={styles.mutedText}>Turn {event.status}</Text>;
    case "session_ended":
      return <Text style={styles.mutedText}>{event.message ?? `Session ended: ${event.reason}`}</Text>;
    case "permission_resolved":
    case "diagnostic":
    case "raw":
      return null;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDebugEvent(event: AgentEvent): string {
  if (event.type === "diagnostic") {
    return event.message;
  }
  if (event.type === "raw") {
    return event.line;
  }
  return "";
}

function formatStats(stats: TurnStats): string {
  const parts = [`${stats.num_turns} turns`, `${(stats.duration_ms / 1000).toFixed(1)}s`];
  if (stats.total_cost_usd !== null && stats.total_cost_usd !== undefined) {
    parts.push(`$${stats.total_cost_usd.toFixed(4)}`);
  }
  if (stats.input_tokens || stats.output_tokens) {
    parts.push(`${stats.input_tokens ?? 0}/${stats.output_tokens ?? 0} tok`);
  }
  return parts.join(" - ");
}

const styles = StyleSheet.create({
  shell: {
    backgroundColor: "#071018",
    flex: 1,
    paddingBottom: 96,
    paddingHorizontal: 14,
    paddingTop: 78
  },
  content: {
    gap: 10,
    paddingBottom: 28
  },
  row: {
    width: "100%"
  },
  bubble: {
    borderRadius: 18,
    fontSize: 15,
    lineHeight: 21,
    maxWidth: "86%",
    overflow: "hidden",
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#D6ECFF",
    color: "#092033"
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#142134",
    color: "#E8EEF7"
  },
  toolCard: {
    backgroundColor: "#0D1827",
    borderColor: "#29415F",
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 12
  },
  permissionCard: {
    backgroundColor: "#182113",
    borderColor: "#506A35",
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 12
  },
  cardTitle: {
    color: "#F2F6FC",
    fontSize: 13,
    fontWeight: "700"
  },
  cardText: {
    color: "#C9D6E8",
    fontFamily: "Menlo",
    fontSize: 12,
    lineHeight: 17
  },
  permissionActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  permissionButton: {
    backgroundColor: "#E3F4D1",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  permissionButtonText: {
    color: "#1E3210",
    fontSize: 12,
    fontWeight: "700"
  },
  stats: {
    color: "#8FB7E4",
    fontSize: 12
  },
  debugCard: {
    backgroundColor: "#10131A",
    borderColor: "#303846",
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
    padding: 10
  },
  debugTitle: {
    color: "#D8E1EF",
    fontSize: 12,
    fontWeight: "700"
  },
  debugText: {
    color: "#9CA9BC",
    fontFamily: "Menlo",
    fontSize: 11
  },
  mutedText: {
    color: "#8EA0BA",
    fontSize: 12
  },
  errorText: {
    color: "#FFB3B3",
    fontSize: 13
  },
  stopButton: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: "#401C22",
    borderColor: "#8D3D4A",
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8
  },
  stopButtonLabel: {
    color: "#FFDCE1",
    fontSize: 12,
    fontWeight: "700"
  }
});
