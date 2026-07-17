import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { TaskSummary } from "../lib/api/types";
import type { RefreshStatus } from "../state/sessionStore";
import {
  buildMoreCommandPalette,
  type MoreCommandAction
} from "./moreCommands";

interface MoreScreenProps {
  pairingCode: string | null;
  refreshStatus: RefreshStatus;
  selectedTask: TaskSummary | null;
  onRefresh(): void;
  onShowDesktops(): void;
  onStartPairing(): void;
  onOpenComposer(): void;
  onAdvanceTaskStage(taskId: string): void;
  onRunMergeAgent(taskId: string): void;
  onCloseTask(taskId: string): void;
}

export function MoreScreen({
  pairingCode,
  refreshStatus,
  selectedTask,
  onRefresh,
  onShowDesktops,
  onStartPairing,
  onOpenComposer,
  onAdvanceTaskStage,
  onRunMergeAgent,
  onCloseTask
}: MoreScreenProps) {
  const [query, setQuery] = useState("");
  const paletteEntries = useMemo(
    () => buildMoreCommandPalette({ pairingCode, refreshStatus, selectedTask }, query),
    [pairingCode, query, refreshStatus, selectedTask]
  );

  const handleAction = (action: MoreCommandAction) => {
    switch (action.id) {
      case "refresh":
        onRefresh();
        break;
      case "pair":
        onStartPairing();
        break;
      case "desktops":
        onShowDesktops();
        break;
      case "compose":
        onOpenComposer();
        break;
      case "advance-stage":
        if (selectedTask) {
          onAdvanceTaskStage(selectedTask.id);
        }
        break;
      case "merge-agent":
        if (selectedTask) {
          onRunMergeAgent(selectedTask.id);
        }
        break;
      case "close-task":
        if (selectedTask) {
          onCloseTask(selectedTask.id);
        }
        break;
    }
  };

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.wrap}>
        <Text style={styles.heading}>More</Text>

        <View style={styles.paletteCard}>
          {selectedTask ? (
            <View style={styles.activeTaskRow}>
              <Text numberOfLines={1} style={styles.activeTaskTitle}>
                {selectedTask.title}
              </Text>
              <View style={styles.taskStagePill}>
                <Text style={styles.taskStageLabel}>{selectedTask.stage ?? "unknown"}</Text>
              </View>
            </View>
          ) : null}

          <TextInput
            autoCapitalize="none"
            onChangeText={setQuery}
            placeholder="Search or run a command"
            placeholderTextColor="#6A7E9D"
            style={styles.searchInput}
            value={query}
          />

          <View style={styles.paletteList}>
            {paletteEntries.length ? (
              paletteEntries.map((action) => {
                const isRefreshing =
                  action.id === "refresh" && refreshStatus === "refreshing";

                return (
                  <Pressable
                    disabled={isRefreshing}
                    key={action.id}
                    style={[styles.action, isRefreshing ? styles.actionDisabled : null]}
                    onPress={() => handleAction(action)}
                  >
                    <Text style={styles.commandLabel}>{action.sectionTitle}</Text>
                    <Text style={styles.actionTitle}>{action.title}</Text>
                    <Text style={styles.actionCopy}>{action.copy}</Text>
                  </Pressable>
                );
              })
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No commands matched</Text>
                <Text style={styles.emptyCopy}>
                  Try merge, stage, pair, or task.
                </Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: 140
  },
  wrap: {
    gap: 14
  },
  heading: {
    color: "#F5F7FB",
    fontSize: 24,
    fontWeight: "700"
  },
  paletteCard: {
    backgroundColor: "#0D1727",
    borderColor: "#22304D",
    borderRadius: 20,
    borderWidth: 1,
    gap: 12,
    padding: 16
  },
  searchInput: {
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 16,
    borderWidth: 1,
    color: "#F5F7FB",
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 13
  },
  paletteList: {
    gap: 10
  },
  activeTaskRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  commandLabel: {
    color: "#7FA7D9",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase"
  },
  activeTaskTitle: {
    color: "#F5F7FB",
    flex: 1,
    fontSize: 15,
    fontWeight: "700"
  },
  taskStagePill: {
    backgroundColor: "#172843",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  taskStageLabel: {
    color: "#9EB6DC",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase"
  },
  emptyState: {
    alignItems: "center",
    backgroundColor: "#10192A",
    borderColor: "#20304C",
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
    padding: 20
  },
  emptyTitle: {
    color: "#F5F7FB",
    fontSize: 15,
    fontWeight: "700"
  },
  emptyCopy: {
    color: "#93A7C8",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center"
  },
  action: {
    backgroundColor: "#111B2C",
    borderColor: "#20304C",
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
    padding: 14
  },
  actionDisabled: {
    opacity: 0.65
  },
  actionTitle: {
    color: "#F5F7FB",
    fontSize: 16,
    fontWeight: "700"
  },
  actionCopy: {
    color: "#B4C2D8",
    fontSize: 14,
    lineHeight: 20
  }
});
