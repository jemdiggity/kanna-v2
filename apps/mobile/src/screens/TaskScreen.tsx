import React, { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputContentSizeChangeEvent,
  useWindowDimensions,
  View
} from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskFileContent, TaskSummary } from "../lib/api/types";
import type {
  TaskCompanionEventStatus,
  TaskCompanionStatus,
  TaskCreationPhase,
  TaskTerminalStatus
} from "../state/sessionStore";
import type {
  CompanionDocumentKind,
  CompanionEvent,
  FrameAgentEvent,
  PermissionDecision
} from "@kanna/agent-protocol";
import { AgentMessageView } from "./AgentMessageView";
import { TaskFilePreview } from "./TaskFilePreview";
import { TerminalWebView } from "./TerminalWebView";
import { showTaskActionMenu, type TaskAction } from "./taskActionMenu";
import { VisualCompanionModal } from "./VisualCompanionModal";
import {
  clampTaskComposerHeight,
  TASK_COMPOSER_MAX_HEIGHT,
  TASK_COMPOSER_MIN_HEIGHT,
  TASK_COMPOSER_TEXT_INPUT_PROPS
} from "./taskComposerInput";
import { getComposerBottomOffset } from "./taskComposerKeyboard";
import { showTaskQuickReplyMenu } from "./taskQuickReplyMenu";
import { buildTaskQuickReply } from "./taskQuickReplies";
import { buildTaskWorkspaceModel } from "./taskWorkspace";
import { getTerminalBottomInset } from "./terminalSafeArea";

interface TaskScreenProps {
  task: TaskSummary;
  e2eTaskSnapshotMarker?: string;
  terminalOutput: string;
  terminalOutputEpoch: number;
  terminalOutputStart: number;
  terminalStatus: TaskTerminalStatus;
  terminalCols: number | null;
  terminalRows: number | null;
  terminalErrorMessage: string | null;
  agentEvents: FrameAgentEvent[];
  agentStatus: TaskTerminalStatus;
  agentErrorMessage: string | null;
  taskCreationPhase?: TaskCreationPhase;
  taskCreationErrorMessage?: string | null;
  companionStatus?: TaskCompanionStatus;
  companionSnapshot?: {
    sessionId: string;
    revision: string;
    documentKind: CompanionDocumentKind;
    html: string;
  } | null;
  companionUnread?: boolean;
  companionErrorMessage?: string | null;
  companionEventStatus?: TaskCompanionEventStatus;
  onBack(): void;
  onAdvanceTaskStage(): void;
  onCloseTask(): void;
  onReadTaskFile(path: string): Promise<TaskFileContent>;
  onSendInput(input: string): void;
  onStopAgent(): void;
  onResolveAgentPermission(requestId: string, decision: PermissionDecision): void;
  onRecoverTaskCreation(): void;
  onCompanionOpenChange?(isOpen: boolean): void;
  onSendCompanionEvent?(
    sessionId: string,
    revision: string,
    event: CompanionEvent
  ): void;
}

function preserveExpandedTextSelection(): void {
  // Pressability suppresses onPress after a long press when this handler exists.
}

export function TaskScreen({
  task,
  e2eTaskSnapshotMarker,
  terminalOutput,
  terminalOutputEpoch,
  terminalOutputStart,
  terminalStatus,
  terminalCols,
  terminalRows,
  terminalErrorMessage,
  agentEvents,
  agentStatus,
  agentErrorMessage,
  taskCreationPhase = "idle",
  taskCreationErrorMessage = null,
  companionStatus = "idle",
  companionSnapshot = null,
  companionUnread = false,
  companionErrorMessage = null,
  companionEventStatus = "idle",
  onBack,
  onAdvanceTaskStage,
  onCloseTask,
  onReadTaskFile,
  onSendInput,
  onStopAgent,
  onResolveAgentPermission,
  onRecoverTaskCreation,
  onCompanionOpenChange,
  onSendCompanionEvent
}: TaskScreenProps) {
  const model = buildTaskWorkspaceModel({
    task,
    terminalStatus,
    terminalErrorMessage,
    taskCreationPhase
  });
  const [draftInput, setDraftInput] = useState("");
  const [composerInputHeight, setComposerInputHeight] = useState(
    TASK_COMPOSER_MIN_HEIGHT
  );
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [screenHeight, setScreenHeight] = useState(0);
  const [composerTop, setComposerTop] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    line?: number;
    previewRevision: number;
  } | null>(null);
  const [expandedTitleTaskId, setExpandedTitleTaskId] = useState<string | null>(
    null
  );
  const [companionModalTaskId, setCompanionModalTaskId] = useState<string | null>(
    null
  );
  const companionLifecycleRef = useRef<{
    isOpen: boolean;
    onOpenChange: ((isOpen: boolean) => void) | undefined;
    taskId: string;
  }>({
    isOpen: false,
    onOpenChange: onCompanionOpenChange,
    taskId: task.id
  });
  if (companionLifecycleRef.current.taskId === task.id) {
    companionLifecycleRef.current.onOpenChange = onCompanionOpenChange;
  }
  const { height: windowHeight } = useWindowDimensions();
  const isAgentTask = task.agentType === "agent";
  const previewScopeRef = useRef({
    isAgentTask,
    revision: 0,
    taskId: task.id
  });
  if (
    previewScopeRef.current.taskId !== task.id ||
    previewScopeRef.current.isAgentTask !== isAgentTask
  ) {
    previewScopeRef.current = {
      isAgentTask,
      revision: previewScopeRef.current.revision + 1,
      taskId: task.id
    };
  }
  const previewRevision = previewScopeRef.current.revision;
  const activeSelectedFile =
    !isAgentTask && selectedFile?.previewRevision === previewRevision
      ? selectedFile
      : null;
  const isTitleExpanded = expandedTitleTaskId === task.id;
  const expandedPrompt = task.prompt?.trim() ? task.prompt : task.title;
  const expandedPromptMaxHeight = Math.min(320, windowHeight * 0.45);
  const effectiveActivity =
    task.activity === "working" || task.activity === "unread"
      ? task.activity
      : "idle";
  const isComposerDisabled = isAgentTask
    ? taskCreationPhase !== "idle" ||
      agentStatus === "connecting" ||
      agentStatus === "error"
    : model.isComposerDisabled;
  const terminalBottomInset = getTerminalBottomInset(screenHeight, composerTop);
  const composerSnapshotRef = useRef({
    taskId: task.id,
    draftInput,
    isComposerDisabled,
    onSendInput
  });
  composerSnapshotRef.current = {
    taskId: task.id,
    draftInput,
    isComposerDisabled,
    onSendInput
  };
  const updateDraftInput = (nextDraftInput: string) => {
    composerSnapshotRef.current.draftInput = nextDraftInput;
    if (!nextDraftInput) {
      setComposerInputHeight(TASK_COMPOSER_MIN_HEIGHT);
    }
    setDraftInput(nextDraftInput);
  };
  const clearDraftInput = () => {
    composerSnapshotRef.current.draftInput = "";
    setComposerInputHeight(TASK_COMPOSER_MIN_HEIGHT);
    setDraftInput("");
  };
  const updateComposerInputHeight = (
    event: TextInputContentSizeChangeEvent
  ) => {
    setComposerInputHeight(
      composerSnapshotRef.current.draftInput
        ? clampTaskComposerHeight(event.nativeEvent.contentSize.height)
        : TASK_COMPOSER_MIN_HEIGHT
    );
  };
  const submitInput = (input: string) => {
    const snapshot = composerSnapshotRef.current;
    const nextInput = input.trim();
    if (!nextInput || snapshot.isComposerDisabled) {
      return;
    }

    snapshot.onSendInput(nextInput);
    clearDraftInput();
    Keyboard.dismiss();
  };
  const sendDraftInput = () => submitInput(composerSnapshotRef.current.draftInput);
  const openTaskActionMenu = () => {
    showTaskActionMenu((action: TaskAction) => {
      switch (action) {
        case "advance-stage":
          onAdvanceTaskStage();
          break;
        case "close-task":
          onCloseTask();
          break;
      }
    });
  };
  const openQuickReplyMenu = () => {
    const openedTaskId = composerSnapshotRef.current.taskId;
    if (composerSnapshotRef.current.isComposerDisabled) {
      return;
    }

    showTaskQuickReplyMenu((quickReply) => {
      const currentSnapshot = composerSnapshotRef.current;
      if (
        currentSnapshot.taskId !== openedTaskId ||
        currentSnapshot.isComposerDisabled
      ) {
        return;
      }
      submitInput(buildTaskQuickReply(quickReply, currentSnapshot.draftInput));
    });
  };

  useEffect(() => {
    const lifecycle = companionLifecycleRef.current;
    lifecycle.taskId = task.id;
    lifecycle.onOpenChange = onCompanionOpenChange;
    setExpandedTitleTaskId((currentTaskId) =>
      currentTaskId === task.id ? currentTaskId : null
    );
    setCompanionModalTaskId(null);
    return () => {
      if (!lifecycle.isOpen) return;
      lifecycle.isOpen = false;
      lifecycle.onOpenChange?.(false);
    };
  }, [task.id]);

  const openCompanion = () => {
    setCompanionModalTaskId(task.id);
    const lifecycle = companionLifecycleRef.current;
    if (lifecycle.isOpen) return;
    lifecycle.isOpen = true;
    lifecycle.onOpenChange?.(true);
  };
  const closeCompanion = () => {
    setCompanionModalTaskId(null);
    const lifecycle = companionLifecycleRef.current;
    if (!lifecycle.isOpen) return;
    lifecycle.isOpen = false;
    lifecycle.onOpenChange?.(false);
  };

  useEffect(() => {
    const showSubscription = Keyboard.addListener("keyboardWillShow", (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hideSubscription = Keyboard.addListener("keyboardWillHide", () => {
      setKeyboardHeight(0);
    });

    return () => {
      composerSnapshotRef.current.isComposerDisabled = true;
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  return (
    <View
      style={styles.screen}
      testID={MOBILE_E2E_IDS.taskDetailScreen}
      onLayout={(event) => setScreenHeight(event.nativeEvent.layout.height)}
    >
      {e2eTaskSnapshotMarker ? (
        <Text
          accessibilityLabel={e2eTaskSnapshotMarker}
          pointerEvents="none"
          style={styles.e2eTaskSnapshotMarker}
          testID={MOBILE_E2E_IDS.taskSnapshotMarker}
        >
          {e2eTaskSnapshotMarker}
        </Text>
      ) : null}
      <View style={styles.terminalCanvas}>
        {taskCreationPhase !== "idle" ? (
          <View style={styles.terminalSkeleton}>
            <View style={styles.skeletonLineWide} />
            <View style={styles.skeletonLineMid} />
            <View style={styles.skeletonLineShort} />
            <View style={styles.terminalOverlay} testID={MOBILE_E2E_IDS.terminalOverlay}>
              <Text style={styles.terminalOverlayLabel}>{model.overlayLabel}</Text>
              {taskCreationErrorMessage ? (
                <Text style={styles.taskCreationError}>{taskCreationErrorMessage}</Text>
              ) : null}
              {model.canRecoverTaskCreation ? (
                <Pressable
                  accessibilityRole="button"
                  style={styles.taskCreationRecoverButton}
                  testID={MOBILE_E2E_IDS.taskCreationRecoverButton}
                  onPress={onRecoverTaskCreation}
                >
                  <Text style={styles.taskCreationRecoverLabel}>Recover task</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : task.agentType === "agent" ? (
          <AgentMessageView
            errorMessage={agentErrorMessage}
            events={agentEvents}
            status={agentStatus}
            onInterrupt={onStopAgent}
            onResolvePermission={onResolveAgentPermission}
          />
        ) : model.isTerminalHealthy ? (
          <TerminalWebView
            fullscreen
            key={task.id}
            output={terminalOutput}
            outputEpoch={terminalOutputEpoch}
            outputStart={terminalOutputStart}
            status={terminalStatus}
            cols={terminalCols}
            rows={terminalRows}
            taskId={task.id}
            bottomInset={terminalBottomInset}
            onConsolePress={Keyboard.dismiss}
            onOpenFile={(path, line) => {
              setSelectedFile({ path, line, previewRevision });
            }}
          />
        ) : (
          <View style={styles.terminalSkeleton}>
            <View style={styles.skeletonLineWide} />
            <View style={styles.skeletonLineMid} />
            <View style={styles.skeletonLineShort} />
            {model.overlayLabel ? (
              <View style={styles.terminalOverlay} testID={MOBILE_E2E_IDS.terminalOverlay}>
                <Text style={styles.terminalOverlayLabel}>{model.overlayLabel}</Text>
              </View>
            ) : null}
          </View>
        )}
      </View>

      {isTitleExpanded ? (
        <Pressable
          accessible={false}
          focusable={false}
          style={styles.titleDismissLayer}
          testID={MOBILE_E2E_IDS.taskTitleDismissLayer}
          onPress={() => setExpandedTitleTaskId(null)}
        />
      ) : null}

      <View pointerEvents="box-none" style={styles.topChrome}>
        <Pressable
          style={styles.backButton}
          testID={MOBILE_E2E_IDS.taskBackButton}
          onPress={onBack}
        >
          <Text style={styles.backLabel}>{"<"}</Text>
        </Pressable>
        <Pressable
          accessible
          accessibilityHint={
            isTitleExpanded ? "Collapse title" : "Expand title"
          }
          accessibilityLabel={`${model.stageLabel}: ${
            isTitleExpanded
              ? `${expandedPrompt}. Task ID: ${task.id}`
              : model.title
          }`}
          accessibilityRole="button"
          accessibilityState={{ expanded: isTitleExpanded }}
          accessibilityValue={{ text: effectiveActivity }}
          style={[
            styles.titleChip,
            isTitleExpanded ? styles.titleChipExpanded : null
          ]}
          testID={MOBILE_E2E_IDS.taskTitleButton}
          onLongPress={
            isTitleExpanded ? preserveExpandedTextSelection : undefined
          }
          onPress={() =>
            setExpandedTitleTaskId((currentTaskId) =>
              currentTaskId === task.id ? null : task.id
            )
          }
        >
          <Text accessible={false} style={styles.stageLabel}>
            {model.stageLabel}
          </Text>
          {isTitleExpanded ? (
            <ScrollView
              accessible={false}
              nestedScrollEnabled
              showsVerticalScrollIndicator
              style={[styles.promptScroll, { maxHeight: expandedPromptMaxHeight }]}
            >
              <Text
                accessible={false}
                selectable
                style={styles.prompt}
                testID={MOBILE_E2E_IDS.taskExpandedPrompt}
              >
                {expandedPrompt}
              </Text>
              <View accessible={false} style={styles.taskIdentity}>
                <Text accessible={false} style={styles.taskIdLabel}>
                  Task ID
                </Text>
                <Text
                  accessible={false}
                  selectable
                  style={styles.taskId}
                  testID={MOBILE_E2E_IDS.taskExpandedTaskId}
                >
                  {task.id}
                </Text>
              </View>
            </ScrollView>
          ) : (
            <Text
              accessible={false}
              numberOfLines={1}
              style={styles.title}
              testID={MOBILE_E2E_IDS.taskDetailTitle}
            >
              {model.title}
            </Text>
          )}
        </Pressable>
      </View>

      <View
        pointerEvents="box-none"
        testID={MOBILE_E2E_IDS.taskComposerChrome}
        onLayout={(event) => setComposerTop(event.nativeEvent.layout.y)}
        style={[
          styles.bottomChrome,
          { bottom: getComposerBottomOffset(keyboardHeight) }
        ]}
      >
        <View style={styles.composerActions}>
          {companionSnapshot ||
          (companionStatus === "error" && companionErrorMessage) ? (
            <Pressable
              accessibilityLabel={
                companionStatus === "error"
                  ? "Visual companion unavailable"
                  : "Visual companion ready"
              }
              accessibilityRole="button"
              onPress={openCompanion}
              style={styles.companionButton}
              testID={MOBILE_E2E_IDS.visualCompanionButton}
            >
              {companionStatus === "available" && companionUnread ? (
                <View
                  accessibilityLabel="New visual companion update"
                  style={styles.companionUnread}
                  testID={MOBILE_E2E_IDS.visualCompanionUnread}
                />
              ) : null}
              <Text style={styles.companionButtonLabel}>
                {companionStatus === "error"
                  ? "Visual companion unavailable"
                  : "Visual companion ready"}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="Task actions"
            accessibilityRole="button"
            style={styles.plusButton}
            testID={MOBILE_E2E_IDS.taskMoreButton}
            onPress={openTaskActionMenu}
          >
            <Text style={styles.plusButtonLabel}>+</Text>
          </Pressable>
        </View>

        <View style={styles.inputComposer}>
          <TextInput
            {...TASK_COMPOSER_TEXT_INPUT_PROPS}
            editable={!isComposerDisabled}
            onChangeText={updateDraftInput}
            onContentSizeChange={updateComposerInputHeight}
            placeholder="Reply…"
            placeholderTextColor="#6F89AE"
            style={[
              styles.inputField,
              { height: composerInputHeight },
              isComposerDisabled ? styles.inputFieldDisabled : null
            ]}
            testID={MOBILE_E2E_IDS.taskInput}
            value={draftInput}
          />
          <Pressable
            accessibilityHint="Press and hold for quick replies."
            accessibilityLabel="Send reply"
            accessibilityRole="button"
            accessibilityState={{ disabled: isComposerDisabled }}
            disabled={isComposerDisabled}
            style={[
              styles.sendButton,
              isComposerDisabled ? styles.sendButtonDisabled : null
            ]}
            testID={MOBILE_E2E_IDS.taskSendButton}
            onLongPress={openQuickReplyMenu}
            onPress={sendDraftInput}
          >
            <Text style={styles.sendButtonLabel}>Send</Text>
          </Pressable>
        </View>
      </View>

      {activeSelectedFile ? (
        <TaskFilePreview
          initialLine={activeSelectedFile.line}
          path={activeSelectedFile.path}
          readFile={() => onReadTaskFile(activeSelectedFile.path)}
          onClose={() => setSelectedFile(null)}
        />
      ) : null}
      {companionModalTaskId === task.id ? (
        <VisualCompanionModal
          errorMessage={companionErrorMessage}
          eventStatus={companionEventStatus}
          snapshot={
            companionStatus === "available" ? companionSnapshot : null
          }
          status={companionStatus}
          onClose={closeCompanion}
          onSendEvent={(sessionId, revision, event) =>
            onSendCompanionEvent?.(sessionId, revision, event)
          }
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: "#040811",
    flex: 1,
    position: "relative"
  },
  terminalCanvas: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0
  },
  terminalSkeleton: {
    backgroundColor: "#050B14",
    gap: 14,
    justifyContent: "center",
    minHeight: 680,
    paddingHorizontal: 18,
    paddingVertical: 120,
    position: "relative"
  },
  skeletonLineWide: {
    backgroundColor: "#101A29",
    borderRadius: 999,
    height: 10,
    width: "88%"
  },
  skeletonLineMid: {
    backgroundColor: "#101A29",
    borderRadius: 999,
    height: 10,
    width: "62%"
  },
  skeletonLineShort: {
    backgroundColor: "#101A29",
    borderRadius: 999,
    height: 10,
    width: "46%"
  },
  terminalOverlay: {
    alignItems: "center",
    bottom: 0,
    gap: 12,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0
  },
  terminalOverlayLabel: {
    backgroundColor: "rgba(8, 17, 30, 0.92)",
    borderColor: "#2A4267",
    borderRadius: 999,
    borderWidth: 1,
    color: "#E6EDF8",
    fontSize: 13,
    fontWeight: "700",
    overflow: "hidden",
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  taskCreationError: {
    color: "#D6A5A5",
    fontSize: 12,
    maxWidth: 280,
    textAlign: "center"
  },
  taskCreationRecoverButton: {
    backgroundColor: "#E8F1FF",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  taskCreationRecoverLabel: {
    color: "#0B1220",
    fontSize: 13,
    fontWeight: "700"
  },
  topChrome: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10,
    left: 14,
    position: "absolute",
    right: 14,
    top: 16,
    zIndex: 5
  },
  backButton: {
    alignItems: "center",
    backgroundColor: "rgba(13, 21, 36, 0.78)",
    borderColor: "#22304D",
    borderRadius: 999,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    width: 36
  },
  backLabel: {
    color: "#D5DEEC",
    fontSize: 19,
    fontWeight: "700",
    lineHeight: 19
  },
  titleChip: {
    alignItems: "center",
    backgroundColor: "rgba(13, 21, 36, 0.78)",
    borderColor: "#22304D",
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: 10,
    minWidth: 0,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  titleChipExpanded: {
    alignItems: "stretch",
    flexDirection: "column"
  },
  titleDismissLayer: {
    backgroundColor: "transparent",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 4
  },
  stageLabel: {
    color: "#7FA7D9",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    maxWidth: 96,
    textTransform: "uppercase"
  },
  title: {
    color: "#F5F7FB",
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 17
  },
  promptScroll: {
    alignSelf: "stretch",
    flexGrow: 0
  },
  prompt: {
    color: "#F5F7FB",
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 20,
    paddingBottom: 2
  },
  taskIdentity: {
    borderTopColor: "#22304D",
    borderTopWidth: 1,
    gap: 4,
    marginTop: 8,
    paddingTop: 8
  },
  taskIdLabel: {
    color: "#7FA7D9",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase"
  },
  taskId: {
    color: "#9BB0CC",
    fontSize: 11,
    lineHeight: 16
  },
  bottomChrome: {
    left: 14,
    position: "absolute",
    right: 14,
    zIndex: 3
  },
  composerActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "flex-end",
    marginBottom: 8
  },
  companionButton: {
    alignItems: "center",
    backgroundColor: "rgba(25, 55, 91, 0.92)",
    borderColor: "#3B6A9F",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 7,
    minHeight: 40,
    paddingHorizontal: 13
  },
  companionButtonLabel: {
    color: "#E8F1FF",
    fontSize: 12,
    fontWeight: "700"
  },
  companionUnread: {
    backgroundColor: "#73B7FF",
    borderRadius: 999,
    height: 8,
    width: 8
  },
  plusButton: {
    alignItems: "center",
    backgroundColor: "rgba(13, 21, 36, 0.82)",
    borderColor: "#22304D",
    borderRadius: 999,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  plusButtonLabel: {
    color: "#E8F1FF",
    fontSize: 22,
    fontWeight: "500",
    lineHeight: 22
  },
  inputComposer: {
    alignItems: "center",
    backgroundColor: "rgba(8, 15, 27, 0.88)",
    borderColor: "#20304C",
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 10
  },
  inputField: {
    color: "#F5F7FB",
    flex: 1,
    fontSize: 14,
    maxHeight: TASK_COMPOSER_MAX_HEIGHT,
    minHeight: TASK_COMPOSER_MIN_HEIGHT,
    paddingHorizontal: 8,
    paddingVertical: 10,
    textAlignVertical: "top"
  },
  inputFieldDisabled: {
    color: "#6F89AE",
    opacity: 0.65
  },
  sendButton: {
    backgroundColor: "#E8F1FF",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 11
  },
  sendButtonDisabled: {
    opacity: 0.45
  },
  sendButtonLabel: {
    color: "#0B1220",
    fontSize: 13,
    fontWeight: "700"
  },
  e2eTaskSnapshotMarker: {
    color: "transparent",
    fontSize: 1,
    height: 1,
    left: 0,
    opacity: 0.01,
    position: "absolute",
    top: 0,
    width: 1
  }
});
