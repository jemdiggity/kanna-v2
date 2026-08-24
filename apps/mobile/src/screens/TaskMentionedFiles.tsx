import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View
} from "react-native";
import type {
  TaskFileMentionInput,
  TaskFileMentionResolution
} from "../lib/api/types";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import {
  projectResolvedMentionRows,
  type ResolvedMentionProjection,
  type ResolvedMentionRow,
  type TerminalFileMentionHistory
} from "./terminalFileMentions";

export interface TaskMentionedFilesProps {
  history: TerminalFileMentionHistory;
  autoSelectUnique?: boolean;
  resolveMentions(
    mentions: readonly TaskFileMentionInput[]
  ): Promise<TaskFileMentionResolution>;
  onSelect(selection: { path: string; line?: number }): void;
  onClose(): void;
}

type LoadState =
  | { requestKey: string; status: "loading" }
  | { requestKey: string; status: "empty" }
  | {
      projection: ResolvedMentionProjection;
      requestKey: string;
      status: "content";
    }
  | { error: string; requestKey: string; status: "error" };

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function TaskMentionedFiles({
  history,
  autoSelectUnique = false,
  resolveMentions,
  onSelect,
  onClose
}: TaskMentionedFilesProps) {
  const resolveMentionsRef = useRef(resolveMentions);
  resolveMentionsRef.current = resolveMentions;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const requestKey = JSON.stringify(history);
  const mentionInputs = useMemo(
    () =>
      history.mentions.map(({ path, line }) => ({
        path,
        ...(line === undefined ? {} : { line })
      })),
    [requestKey]
  );
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>(
    mentionInputs.length === 0
      ? { requestKey, status: "empty" }
      : { requestKey, status: "loading" }
  );
  const visibleState: LoadState =
    loadState.requestKey === requestKey
      ? loadState
      : mentionInputs.length === 0
        ? { requestKey, status: "empty" }
        : { requestKey, status: "loading" };

  useEffect(() => {
    let active = true;
    if (mentionInputs.length === 0) {
      setLoadState({ requestKey, status: "empty" });
      return () => {
        active = false;
      };
    }

    setLoadState({ requestKey, status: "loading" });
    let pending: Promise<TaskFileMentionResolution>;
    try {
      pending = resolveMentionsRef.current(mentionInputs);
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending.then(
      (resolution) => {
        if (!active) return;
        const projection = projectResolvedMentionRows(history, resolution);
        if (
          autoSelectUnique &&
          projection.rows.length === 1 &&
          projection.unmatchedCount === 0 &&
          projection.rows[0]?.available
        ) {
          const row = projection.rows[0]!;
          onSelectRef.current({
            path: row.path,
            ...(row.line === undefined ? {} : { line: row.line })
          });
          return;
        }
        setLoadState({ projection, requestKey, status: "content" });
      },
      (error: unknown) => {
        if (!active) return;
        setLoadState({
          error: messageFromError(error),
          requestKey,
          status: "error"
        });
      }
    );

    return () => {
      active = false;
    };
  }, [autoSelectUnique, requestKey, retryGeneration]);

  const retry = () => {
    setLoadState({ requestKey, status: "loading" });
    setRetryGeneration((generation) => generation + 1);
  };
  const selectRow = (row: ResolvedMentionRow) => {
    if (!row.available) return;
    onSelect({
      path: row.path,
      ...(row.line === undefined ? {} : { line: row.line })
    });
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      testID={MOBILE_E2E_IDS.taskMentionedFilesModal}
      visible
    >
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Mentioned Files</Text>
            <Text style={styles.subtitle}>
              Recently referenced by the agent
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            hitSlop={10}
            onPress={onClose}
            style={styles.closeButton}
            testID={MOBILE_E2E_IDS.taskMentionedFilesClose}
          >
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>

        {visibleState.status === "loading" ? (
          <View style={styles.centered}>
            <ActivityIndicator color="#A9D7FF" size="large" />
            <Text style={styles.statusText}>Finding files…</Text>
          </View>
        ) : visibleState.status === "empty" ? (
          <View style={styles.centered}>
            <Text style={styles.emptyTitle}>No mentioned files</Text>
            <Text style={styles.statusText}>
              No files have been mentioned yet.
            </Text>
          </View>
        ) : visibleState.status === "error" ? (
          <View style={styles.centered} testID={MOBILE_E2E_IDS.taskMentionedFilesError}>
            <Text style={styles.emptyTitle}>Files unavailable</Text>
            <Text style={styles.statusText}>{visibleState.error}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={retry}
              style={styles.retryButton}
              testID={MOBILE_E2E_IDS.taskMentionedFilesRetry}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : visibleState.projection.rows.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyTitle}>No matching files</Text>
            <Text style={styles.statusText}>
              No matching file is available in this task workspace.
            </Text>
          </View>
        ) : (
          <FlatList
            contentContainerStyle={styles.list}
            data={visibleState.projection.rows}
            keyExtractor={(row) => `${row.available ? "available" : "unavailable"}:${row.path}`}
            ListFooterComponent={
              visibleState.projection.unmatchedCount > 0 ||
              visibleState.projection.truncated ? (
                <View style={styles.footer}>
                  {visibleState.projection.unmatchedCount > 0 ? (
                    <Text style={styles.footerText}>
                      {visibleState.projection.unmatchedCount}{" "}
                      {visibleState.projection.unmatchedCount === 1
                        ? "mention couldn't"
                        : "mentions couldn't"}{" "}
                      be matched
                    </Text>
                  ) : null}
                  {visibleState.projection.truncated ? (
                    <Text style={styles.footerText}>
                      More matches may be available.
                    </Text>
                  ) : null}
                </View>
              ) : null
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityLabel={
                  item.available
                    ? `Open file ${item.path}`
                    : `${item.path} unavailable: ${item.unavailableReason}`
                }
                accessibilityRole={item.available ? "button" : "text"}
                accessibilityState={{ disabled: !item.available }}
                disabled={!item.available}
                onPress={() => selectRow(item)}
                style={[styles.row, !item.available && styles.rowUnavailable]}
                testID={MOBILE_E2E_IDS.taskMentionedFilesRow(item.path)}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.filename, !item.available && styles.textUnavailable]}
                >
                  {item.path.split("/").pop()}
                  {item.line === undefined ? "" : `:${item.line}`}
                </Text>
                <Text
                  ellipsizeMode="middle"
                  numberOfLines={1}
                  style={[styles.path, !item.available && styles.textUnavailable]}
                >
                  {item.path}
                </Text>
                {!item.available ? (
                  <Text style={styles.unavailableReason}>
                    Unavailable · {item.unavailableReason}
                  </Text>
                ) : null}
              </Pressable>
            )}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: "#050B14",
    flex: 1
  },
  header: {
    alignItems: "center",
    borderBottomColor: "#1D2C43",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 14
  },
  title: {
    color: "#F4F8FC",
    fontSize: 20,
    fontWeight: "700"
  },
  subtitle: {
    color: "#8292A9",
    fontSize: 12,
    marginTop: 2
  },
  closeButton: {
    paddingHorizontal: 8,
    paddingVertical: 6
  },
  closeText: {
    color: "#A9D7FF",
    fontSize: 15,
    fontWeight: "600"
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 28
  },
  emptyTitle: {
    color: "#F4F8FC",
    fontSize: 17,
    fontWeight: "700"
  },
  statusText: {
    color: "#9BAABD",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center"
  },
  retryButton: {
    backgroundColor: "#A9D7FF",
    borderRadius: 9,
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 10
  },
  retryText: {
    color: "#07101D",
    fontSize: 14,
    fontWeight: "700"
  },
  list: {
    padding: 14
  },
  row: {
    backgroundColor: "#0C1727",
    borderColor: "#243A59",
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 9,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  rowUnavailable: {
    backgroundColor: "#09111D",
    borderColor: "#18263A"
  },
  filename: {
    color: "#E8F3FF",
    fontFamily: "Menlo",
    fontSize: 14,
    fontWeight: "600"
  },
  path: {
    color: "#8FA5BF",
    fontFamily: "Menlo",
    fontSize: 11,
    marginTop: 5
  },
  textUnavailable: {
    color: "#607087"
  },
  unavailableReason: {
    color: "#687991",
    fontSize: 11,
    marginTop: 7
  },
  footer: {
    gap: 5,
    paddingHorizontal: 6,
    paddingVertical: 14
  },
  footerText: {
    color: "#8292A9",
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center"
  }
});
