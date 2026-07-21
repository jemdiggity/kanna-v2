import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View
} from "react-native";
import {
  WebView as NativeWebView,
  type WebViewNavigation,
  type WebViewProps
} from "react-native-webview";
import {
  DEFAULT_TASK_DIFF_REQUEST,
  type TaskDiffContent,
  type TaskDiffRequest
} from "../lib/api/types";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import { buildTaskDiffDocument } from "./buildTaskDiffDocument";

export interface TaskDiffPreviewProps {
  readDiff(request: TaskDiffRequest): Promise<TaskDiffContent>;
  onClose(): void;
}

type LoadState =
  | { requestKey: string; status: "loading" }
  | { diff: TaskDiffContent; requestKey: string; status: "content" }
  | { error: string; requestKey: string; retryable: boolean; status: "error" };

interface DiffScopeOption {
  scope: TaskDiffRequest["scope"];
  label: string;
}

interface DiffModeOption {
  mode: TaskDiffRequest["mode"];
  label: string;
}

const DIFF_SCOPE_OPTIONS: readonly DiffScopeOption[] = [
  { scope: "branch", label: "Branch" },
  { scope: "working", label: "Working" }
];

const BRANCH_MODE_OPTIONS: readonly DiffModeOption[] = [
  { mode: "all", label: "All" },
  { mode: "staged", label: "Staged" },
  { mode: "none", label: "Committed" }
];

const WORKING_MODE_OPTIONS: readonly DiffModeOption[] = [
  { mode: "all", label: "All" },
  { mode: "unstaged", label: "Unstaged" },
  { mode: "staged", label: "Staged" }
];

function requestKey(request: TaskDiffRequest): string {
  return `${request.scope}\u0000${request.mode}`;
}

function defaultModeForScope(scope: TaskDiffRequest["scope"]): TaskDiffRequest {
  return scope === "branch"
    ? { scope: "branch", mode: "all" }
    : { scope: "working", mode: "all" };
}

const WebView = NativeWebView as unknown as React.ComponentType<WebViewProps>;
const ENABLE_E2E_WEBVIEW_INSPECTION =
  process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED === "1";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTaskDiffErrorRetryable(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 404) return false;
  }

  const message = errorMessage(error);
  const statusMatch = message.match(/\((\d{3})\)|\bstatus\s+(\d{3})\b/i);
  const status = Number(statusMatch?.[1] ?? statusMatch?.[2]);
  if (status === 404) return false;

  return !/task not found/i.test(message);
}

export function TaskDiffPreview({ readDiff, onClose }: TaskDiffPreviewProps) {
  const readDiffRef = useRef(readDiff);
  readDiffRef.current = readDiff;

  const [retryGeneration, setRetryGeneration] = useState(0);
  const [diffRequest, setDiffRequest] = useState<TaskDiffRequest>(
    DEFAULT_TASK_DIFF_REQUEST
  );
  const activeRequestKey = requestKey(diffRequest);
  const [loadState, setLoadState] = useState<LoadState>({
    requestKey: activeRequestKey,
    status: "loading"
  });
  const visibleState: LoadState =
    loadState.requestKey === activeRequestKey
      ? loadState
      : { requestKey: activeRequestKey, status: "loading" };

  const diffDocument = useMemo(
    () =>
      visibleState.status === "content"
        ? buildTaskDiffDocument({
            patch: visibleState.diff.patch,
            baseRef: visibleState.diff.baseRef,
            truncated: visibleState.diff.truncated
          })
        : "",
    [visibleState]
  );

  useEffect(() => {
    let active = true;
    const pendingKey = requestKey(diffRequest);
    setLoadState({ requestKey: pendingKey, status: "loading" });

    let request: Promise<TaskDiffContent>;
    try {
      request = readDiffRef.current(diffRequest);
    } catch (error) {
      request = Promise.reject(error);
    }

    void request.then(
      (diff) => {
        if (!active) return;
        setLoadState({ diff, requestKey: pendingKey, status: "content" });
      },
      (error: unknown) => {
        if (!active) return;
        setLoadState({
          error: errorMessage(error),
          requestKey: pendingKey,
          retryable: isTaskDiffErrorRetryable(error),
          status: "error"
        });
      }
    );

    return () => {
      active = false;
    };
  }, [diffRequest, retryGeneration]);

  const retry = () => {
    setLoadState({ requestKey: activeRequestKey, status: "loading" });
    setRetryGeneration((generation) => generation + 1);
  };
  const selectScope = (scope: TaskDiffRequest["scope"]) => {
    if (scope !== diffRequest.scope) {
      setDiffRequest(defaultModeForScope(scope));
    }
  };
  const selectMode = (mode: TaskDiffRequest["mode"]) => {
    if (mode !== diffRequest.mode) {
      setDiffRequest({ scope: diffRequest.scope, mode } as TaskDiffRequest);
    }
  };
  const modeOptions =
    diffRequest.scope === "branch" ? BRANCH_MODE_OPTIONS : WORKING_MODE_OPTIONS;

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      visible
    >
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.title} testID={MOBILE_E2E_IDS.taskDiffTitle}>
              Diff
            </Text>
            <Text
              numberOfLines={1}
              style={styles.base}
              testID={MOBILE_E2E_IDS.taskDiffBase}
            >
              {diffRequest.scope === "working"
                ? "Working tree changes"
                : visibleState.status === "content" && visibleState.diff.baseRef
                  ? `Changes vs ${visibleState.diff.baseRef}`
                  : "Branch changes"}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            hitSlop={10}
            onPress={onClose}
            style={styles.closeButton}
            testID={MOBILE_E2E_IDS.taskDiffClose}
          >
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>

        <View style={styles.scopeBar}>
          <View style={styles.scopeGroup}>
            {DIFF_SCOPE_OPTIONS.map((option) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: diffRequest.scope === option.scope }}
                key={option.scope}
                onPress={() => selectScope(option.scope)}
                style={[
                  styles.scopeButton,
                  diffRequest.scope === option.scope ? styles.scopeButtonActive : null
                ]}
                testID={MOBILE_E2E_IDS.taskDiffScopeOption(option.scope)}
              >
                <Text
                  style={[
                    styles.scopeButtonText,
                    diffRequest.scope === option.scope
                      ? styles.scopeButtonTextActive
                      : null
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.modeGroup}>
            {modeOptions.map((option) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: diffRequest.mode === option.mode }}
                key={option.mode}
                onPress={() => selectMode(option.mode)}
                style={[
                  styles.modeChip,
                  diffRequest.mode === option.mode ? styles.modeChipActive : null
                ]}
                testID={MOBILE_E2E_IDS.taskDiffModeOption(option.mode)}
              >
                <Text
                  style={[
                    styles.modeChipText,
                    diffRequest.mode === option.mode ? styles.modeChipTextActive : null
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {visibleState.status === "loading" ? (
          <View style={styles.centeredState}>
            <ActivityIndicator color="#73b7ff" size="large" />
            <Text style={styles.stateText}>Loading diff…</Text>
          </View>
        ) : visibleState.status === "error" ? (
          <View style={styles.centeredState}>
            <Text
              style={styles.errorTitle}
              testID={MOBILE_E2E_IDS.taskDiffError}
            >
              Couldn’t load diff
            </Text>
            <Text
              selectable
              style={styles.errorText}
              testID={MOBILE_E2E_IDS.taskDiffErrorMessage}
            >
              {visibleState.error}
            </Text>
            {visibleState.retryable ? (
              <Pressable
                accessibilityRole="button"
                onPress={retry}
                style={styles.retryButton}
              >
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={styles.content}>
            <WebView
              allowFileAccess={false}
              allowFileAccessFromFileURLs={false}
              allowUniversalAccessFromFileURLs={false}
              allowsLinkPreview={false}
              domStorageEnabled={false}
              javaScriptCanOpenWindowsAutomatically={false}
              javaScriptEnabled={false}
              mixedContentMode="never"
              onShouldStartLoadWithRequest={(request: WebViewNavigation) =>
                request.url === "about:blank"
              }
              originWhitelist={["about:blank"]}
              setSupportMultipleWindows={false}
              sharedCookiesEnabled={false}
              source={{ html: diffDocument }}
              style={styles.webView}
              thirdPartyCookiesEnabled={false}
              webviewDebuggingEnabled={ENABLE_E2E_WEBVIEW_INSPECTION}
            />
            {ENABLE_E2E_WEBVIEW_INSPECTION ? (
              <Text
                accessibilityValue={{
                  text: JSON.stringify({
                    baseRef: visibleState.diff.baseRef,
                    mode: diffRequest.mode,
                    patch: visibleState.diff.patch,
                    scope: diffRequest.scope,
                    truncated: visibleState.diff.truncated
                  })
                }}
                pointerEvents="none"
                style={styles.e2eInspection}
                testID={MOBILE_E2E_IDS.taskDiffInspection}
              >
                {JSON.stringify({
                  baseRef: visibleState.diff.baseRef,
                  mode: diffRequest.mode,
                  patch: visibleState.diff.patch,
                  scope: diffRequest.scope,
                  truncated: visibleState.diff.truncated
                })}
              </Text>
            ) : null}
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  e2eInspection: {
    height: 1,
    opacity: 0.01,
    position: "absolute",
    width: 1
  },
  safeArea: {
    backgroundColor: "#050B14",
    flex: 1
  },
  header: {
    alignItems: "flex-start",
    borderBottomColor: "#1D2C43",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 13
  },
  headerCopy: {
    flex: 1
  },
  title: {
    color: "#F4F8FF",
    fontSize: 17,
    fontWeight: "700"
  },
  base: {
    color: "#8292A9",
    fontFamily: "Menlo",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3
  },
  closeButton: {
    borderColor: "#31415B",
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  closeText: {
    color: "#D7E2F0",
    fontSize: 14,
    fontWeight: "600"
  },
  scopeBar: {
    borderBottomColor: "#15243C",
    borderBottomWidth: 1,
    gap: 9,
    paddingHorizontal: 18,
    paddingVertical: 11
  },
  scopeGroup: {
    backgroundColor: "#0B1422",
    borderColor: "#22304D",
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    overflow: "hidden"
  },
  scopeButton: {
    alignItems: "center",
    flex: 1,
    paddingVertical: 9
  },
  scopeButtonActive: {
    backgroundColor: "#1E3A5F"
  },
  scopeButtonText: {
    color: "#8292A9",
    fontSize: 13,
    fontWeight: "700"
  },
  scopeButtonTextActive: {
    color: "#E8F1FF"
  },
  modeGroup: {
    flexDirection: "row",
    gap: 8
  },
  modeChip: {
    borderColor: "#31415B",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 6
  },
  modeChipActive: {
    backgroundColor: "#1E3A5F",
    borderColor: "#3B6A9F"
  },
  modeChipText: {
    color: "#8292A9",
    fontSize: 12,
    fontWeight: "600"
  },
  modeChipTextActive: {
    color: "#E8F1FF"
  },
  centeredState: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 28
  },
  stateText: {
    color: "#AEBBD0",
    fontSize: 14,
    marginTop: 12
  },
  errorTitle: {
    color: "#F4F8FF",
    fontSize: 18,
    fontWeight: "700"
  },
  errorText: {
    color: "#C4CEDD",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
    textAlign: "center"
  },
  retryButton: {
    backgroundColor: "#2D6EB8",
    borderRadius: 9,
    marginTop: 18,
    paddingHorizontal: 18,
    paddingVertical: 10
  },
  retryText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700"
  },
  content: {
    flex: 1
  },
  webView: {
    backgroundColor: "#050B14",
    flex: 1
  }
});
