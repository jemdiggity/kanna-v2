import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import type { RefreshStatus } from "../state/sessionStore";
import {
  buildMoreCommandPalette,
  type MoreCommandAction
} from "./moreCommands";

interface MoreScreenProps {
  forceCloudEnabled: boolean;
  showDeveloperDiagnostics: boolean;
  refreshStatus: RefreshStatus;
  selectedTask: TaskSummary | null;
  onRefresh(): void;
  onForceCloudChange(enabled: boolean): void;
  onOpenComposer(): void;
  onAdvanceTaskStage(taskId: string): void;
  onRunMergeAgent(taskId: string): void;
  onCloseTask(taskId: string): void;
}

export function MoreScreen({
  forceCloudEnabled,
  showDeveloperDiagnostics,
  refreshStatus,
  selectedTask,
  onRefresh,
  onForceCloudChange,
  onOpenComposer,
  onAdvanceTaskStage,
  onRunMergeAgent,
  onCloseTask
}: MoreScreenProps) {
  const [query, setQuery] = useState("");
  const paletteEntries = useMemo(
    () => buildMoreCommandPalette({ refreshStatus, selectedTask }, query),
    [query, refreshStatus, selectedTask]
  );

  const handleAction = (action: MoreCommandAction) => {
    switch (action.id) {
      case "refresh":
        onRefresh();
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
      testID={MOBILE_E2E_IDS.moreScreen}
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
                    style={({ pressed }) => [
                      styles.action,
                      isRefreshing
                        ? styles.actionDisabled
                        : pressed
                          ? styles.actionPressed
                          : null
                    ]}
                    testID={MOBILE_E2E_IDS.moreCommand(action.id)}
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
                  Try merge, stage, refresh, or task.
                </Text>
              </View>
            )}
          </View>
        </View>
        {showDeveloperDiagnostics ? (
          <View style={styles.diagnosticsCard}>
            <Text style={styles.commandLabel}>Developer diagnostics</Text>
            <Pressable
              accessibilityLabel="Force Cloud"
              accessibilityState={{ checked: forceCloudEnabled }}
              style={styles.diagnosticToggle}
              testID={MOBILE_E2E_IDS.developerForceCloudToggle}
              onPress={() => onForceCloudChange(!forceCloudEnabled)}
            >
              <View
                style={[
                  styles.diagnosticIndicator,
                  forceCloudEnabled ? styles.diagnosticIndicatorActive : null
                ]}
              />
              <View style={styles.diagnosticText}>
                <Text style={styles.actionTitle}>Force Cloud</Text>
                <Text style={styles.actionCopy}>
                  {forceCloudEnabled ? "Relay only" : "Automatic LAN preferred"}
                </Text>
              </View>
            </Pressable>
          </View>
        ) : null}
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
  diagnosticsCard: {
    backgroundColor: "#0D1727",
    borderColor: "#22304D",
    borderRadius: 20,
    borderWidth: 1,
    gap: 10,
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
  actionPressed: {
    backgroundColor: "#182842",
    borderColor: "#3A5F91",
    opacity: 0.82,
    transform: [{ scale: 0.98 }]
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
  },
  diagnosticToggle: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    paddingVertical: 4
  },
  diagnosticIndicator: {
    backgroundColor: "#172338",
    borderColor: "#3B5278",
    borderRadius: 8,
    borderWidth: 1,
    height: 16,
    width: 16
  },
  diagnosticIndicatorActive: {
    backgroundColor: "#56A2FF",
    borderColor: "#8EC2FF"
  },
  diagnosticText: {
    flex: 1
  }
});
