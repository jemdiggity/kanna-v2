import React, { useEffect, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Image,
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
import { LoadingText } from "../components/LoadingText";
import { displayTaskId } from "../lib/api/taskIdentity";
import type {
  RepoDirectoryListing,
  RepoFileRange,
  TaskDiffContent,
  TaskDiffRequest,
  TaskFileContent,
  TaskFileMentionInput,
  TaskFileMentionResolution,
  TaskInputAttachment,
  TaskSummary
} from "../lib/api/types";
import { isTaskBlocked, type BlockerTaskRef } from "../lib/api/taskIdentity";
import {
  ImageAttachmentError,
  type PreparedImageAttachment
} from "../lib/attachments/imageAttachmentBudget";
import {
  pickImageAttachment,
  type ImageAttachmentSource
} from "../lib/attachments/pickImageAttachment";
import { showImageAttachmentSourceMenu } from "./taskAttachmentMenu";
import type {
  TaskCompanionEventStatus,
  TaskCompanionStatus,
  TaskCreationAction,
  TaskCreationPhase,
  TaskStageAction,
  TaskTerminalOutputSource,
  TaskTerminalStatus
} from "../state/sessionStore";
import type { TerminalOutputLike } from "../state/terminalOutputBuffer";
import type {
  CompanionEvent,
  FrameAgentEvent,
  PermissionDecision
} from "@kanna/agent-protocol";
import { AgentMessageView } from "./AgentMessageView";
import { TaskDiffPreview } from "./TaskDiffPreview";
import { TaskFilePreview } from "./TaskFilePreview";
import { TaskMentionedFiles } from "./TaskMentionedFiles";
import { RepoExplorer } from "./RepoExplorer";
import { TerminalWebView } from "./TerminalWebView";
import { showTaskActionMenu, type TaskAction } from "./taskActionMenu";
import {
  mentionedFilesActionLabel,
  type TerminalFileMentionHistory
} from "./terminalFileMentions";
import {
  VisualCompanionModal,
  type VisualCompanionSnapshot
} from "./VisualCompanionModal";
import {
  clampTaskComposerHeight,
  appendComposerFileReference,
  TASK_COMPOSER_MAX_HEIGHT,
  TASK_COMPOSER_MIN_HEIGHT,
  TASK_COMPOSER_TEXT_INPUT_PROPS
} from "./taskComposerInput";
import { getComposerBottomOffset } from "./taskComposerKeyboard";
import { QuickReplySendControl } from "./QuickReplySendControl";
import {
  buildTaskQuickReply,
  type TaskQuickReply
} from "./taskQuickReplies";
import { buildTaskWorkspaceModel } from "./taskWorkspace";
import { resolveMobileTerminalGeometry } from "../mobileTerminalGeometry";
import {
  TASK_STAGE_STRIPE_WIDTH,
  resolveTaskStageTheme
} from "../theme/taskStageTheme";
import {
  getTerminalBottomInset,
  getTerminalSelectionToolbarTop
} from "./terminalSafeArea";

const EMPTY_MENTIONED_FILES: TerminalFileMentionHistory = {
  mentions: [],
  overflow: false
};

interface TaskScreenProps {
  task: TaskSummary;
  blockerTasks?: readonly BlockerTaskRef[];
  e2eTaskSnapshotMarker?: string;
  terminalOutput: TerminalOutputLike;
  terminalOutputEpoch: number;
  terminalOutputStart: number;
  terminalOutputSource?: TaskTerminalOutputSource;
  terminalStatus: TaskTerminalStatus;
  terminalErrorMessage: string | null;
  agentEvents: FrameAgentEvent[];
  agentStatus: TaskTerminalStatus;
  agentErrorMessage: string | null;
  taskCreationPhase?: TaskCreationPhase;
  taskCreationErrorMessage?: string | null;
  companionStatus?: TaskCompanionStatus;
  companionSnapshot?: VisualCompanionSnapshot | null;
  companionUnread?: boolean;
  companionErrorMessage?: string | null;
  companionEventStatus?: TaskCompanionEventStatus;
  quickReplies: readonly TaskQuickReply[];
  quickRepliesHydrated: boolean;
  /** Whether the connected desktop advertised the task-input attachment
   * contract. Absent on desktops built before it, which accept the field and
   * silently drop the photo. */
  desktopSupportsAttachments?: boolean;
  pendingTaskAction?: TaskStageAction | TaskCreationAction | null;
  onBack(): boolean;
  onAdvanceTaskStage(): void;
  onCloseTask(): void;
  onResolveTaskFileMentions(
    mentions: readonly TaskFileMentionInput[]
  ): Promise<TaskFileMentionResolution>;
  onReadTaskFile(path: string): Promise<TaskFileContent>;
  onListTaskDirectory(path: string, showAllFiles?: boolean, offset?: number, filter?: string): Promise<RepoDirectoryListing>;
  onReadTaskFileRange(path: string, startLine: number, lineCount: number, metadataOnly?: boolean): Promise<RepoFileRange>;
  onReadTaskDiff(request: TaskDiffRequest): Promise<TaskDiffContent>;
  onSendInput(input: string, attachment?: TaskInputAttachment): void;
  /** Injected by the attachment tests; production uses the Expo picker. */
  pickAttachment?(source: ImageAttachmentSource): Promise<PreparedImageAttachment | null>;
  onSendTerminalInput?(dataB64: string): void;
  /** The terminal view scrolled near the top of its loaded buffer. */
  onRequestTerminalScrollback?(): void;
  onResizeTerminal?(cols: number, rows: number): void;
  onStopAgent(): void;
  onRequestAgentHistory?(): void;
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
  blockerTasks = [],
  e2eTaskSnapshotMarker,
  terminalOutput,
  terminalOutputEpoch,
  terminalOutputStart,
  terminalOutputSource,
  terminalStatus,
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
  quickReplies,
  quickRepliesHydrated,
  desktopSupportsAttachments = false,
  pendingTaskAction = null,
  onBack,
  onAdvanceTaskStage,
  onCloseTask,
  onResolveTaskFileMentions,
  onReadTaskFile,
  onListTaskDirectory,
  onReadTaskFileRange,
  onReadTaskDiff,
  onSendInput,
  pickAttachment = pickImageAttachment,
  onSendTerminalInput,
  onRequestTerminalScrollback,
  onResizeTerminal,
  onStopAgent,
  onRequestAgentHistory,
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
  // The list colours rows by stage; the detail header wears the same colour so
  // opening a task does not drop the signal that led the eye to it.
  const stageTheme = resolveTaskStageTheme(task.stage);
  const [draftInput, setDraftInput] = useState("");
  const [attachment, setAttachment] = useState<PreparedImageAttachment | null>(
    null
  );
  const [attachmentErrorMessage, setAttachmentErrorMessage] = useState<
    string | null
  >(null);
  const [isPickingAttachment, setIsPickingAttachment] = useState(false);
  const [composerInputHeight, setComposerInputHeight] = useState(
    TASK_COMPOSER_MIN_HEIGHT
  );
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isBackPending, setIsBackPending] = useState(false);
  const [screenViewport, setScreenViewport] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [composerTop, setComposerTop] = useState<number | null>(null);
  const [topChromeBottom, setTopChromeBottom] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    line?: number;
    previewRevision: number;
  } | null>(null);
  const [mentionedFiles, setMentionedFiles] = useState<{
    history: TerminalFileMentionHistory;
    previewRevision: number;
  }>({
    history: { mentions: [], overflow: false },
    previewRevision: 0
  });
  const [mentionedFilesRequest, setMentionedFilesRequest] = useState<{
    autoSelectUnique: boolean;
    history: TerminalFileMentionHistory;
    previewRevision: number;
  } | null>(null);
  const [expandedTitleTaskId, setExpandedTitleTaskId] = useState<string | null>(
    null
  );
  const [companionModalTaskId, setCompanionModalTaskId] = useState<string | null>(
    null
  );
  const [diffModalTaskId, setDiffModalTaskId] = useState<string | null>(null);
  const [explorerTaskId, setExplorerTaskId] = useState<string | null>(null);
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
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const isAgentTask = task.agentType === "agent";
  const isBlocked = isTaskBlocked(task);
  // Callers pass resolved blocker summaries; fall back to bare ids so the
  // placeholder stays truthful when a blocker is not in the collections.
  const blockedRefs: readonly BlockerTaskRef[] = blockerTasks.length
    ? blockerTasks
    : (task.blockedByTaskIds ?? []).map((blockerTaskId) => ({
        blockerTaskId,
        task: null
      }));
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
  // The terminal is memoized: a fresh closure here would re-render it on every
  // composer keystroke. Both handlers read the live preview scope off the ref
  // instead of closing over this render's revision.
  const handleTerminalMentionedFilesChange = useRef(
    (history: TerminalFileMentionHistory) => {
      setMentionedFiles({
        history,
        previewRevision: previewScopeRef.current.revision
      });
    }
  ).current;
  const handleTerminalOpenFile = useRef((path: string, line?: number) => {
    setMentionedFilesRequest({
      autoSelectUnique: true,
      history: {
        mentions: [
          {
            path,
            raw: line === undefined ? path : `${path}:${line}`,
            ...(line === undefined ? {} : { line })
          }
        ],
        overflow: false
      },
      previewRevision: previewScopeRef.current.revision
    });
  }).current;
  const activeSelectedFile =
    !isAgentTask && selectedFile?.previewRevision === previewRevision
      ? selectedFile
      : null;
  const activeMentionedFiles =
    !isAgentTask && mentionedFiles.previewRevision === previewRevision
      ? mentionedFiles.history
      : EMPTY_MENTIONED_FILES;
  const activeMentionedFilesRequest =
    !isAgentTask &&
    mentionedFilesRequest?.previewRevision === previewRevision
      ? mentionedFilesRequest
      : null;
  const isTitleExpanded = expandedTitleTaskId === task.id;
  const expandedTaskId = displayTaskId(task);
  // The collapsed header carries the id too: it is how the owner cross-checks
  // the task they are looking at, and a one-line title is exactly what
  // ellipsizes. A task still being created has only a local slot id, which is
  // not an id anything can be cross-checked against, so it shows none.
  const collapsedTaskId =
    taskCreationPhase === "idle" ? expandedTaskId : null;
  const expandedPrompt = task.prompt?.trim() ? task.prompt : task.title;
  const expandedPromptMaxHeight = Math.min(320, windowHeight * 0.45);
  const effectiveActivity =
    task.activity === "working" || task.activity === "unread"
      ? task.activity
      : "idle";
  const isComposerDisabled =
    isBlocked ||
    (isAgentTask
      ? taskCreationPhase !== "idle" ||
        agentStatus === "connecting" ||
        agentStatus === "error"
      : model.isComposerDisabled);
  const isAnimatedCreation =
    taskCreationPhase === "pending" || taskCreationPhase === "recovering";
  const isAnimatedTerminalConnection =
    taskCreationPhase === "idle" &&
    !isAgentTask &&
    (terminalStatus === "idle" || terminalStatus === "connecting");
  const terminalViewport =
    screenViewport ?? { width: windowWidth, height: windowHeight };
  const terminalGeometry = resolveMobileTerminalGeometry(terminalViewport);
  const terminalBottomInset = getTerminalBottomInset(
    screenViewport?.height ?? 0,
    composerTop
  );
  const terminalSelectionToolbarTop =
    getTerminalSelectionToolbarTop(topChromeBottom);
  // An attachment is a file the desktop writes and names in the injected
  // message, which only the HTTP input path does. SDK-mode tasks answer over
  // the agent stream instead, so they get no attach control rather than an
  // affordance that silently drops the photo.
  //
  // The desktop has to be able to receive one too. A build that predates
  // attachments deserializes the field, ignores it, delivers the text alone
  // and answers 204 — indistinguishable from success — so an unadvertised
  // desktop hides the control for exactly the same reason: no affordance beats
  // one that quietly loses the photo.
  const canAttachPhoto = !isAgentTask && desktopSupportsAttachments;
  const composerSnapshotRef = useRef({
    taskId: task.id,
    draftInput,
    attachment,
    isComposerDisabled,
    onSendInput
  });
  composerSnapshotRef.current = {
    taskId: task.id,
    draftInput,
    attachment,
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
    composerSnapshotRef.current.attachment = null;
    setComposerInputHeight(TASK_COMPOSER_MIN_HEIGHT);
    setDraftInput("");
    setAttachment(null);
    setAttachmentErrorMessage(null);
  };
  const removeAttachment = () => {
    composerSnapshotRef.current.attachment = null;
    setAttachment(null);
    setAttachmentErrorMessage(null);
  };
  const attachPhotoFrom = async (source: ImageAttachmentSource) => {
    setIsPickingAttachment(true);
    setAttachmentErrorMessage(null);
    try {
      const picked = await pickAttachment(source);
      if (!picked) {
        return;
      }
      // The user can switch tasks while the picker is open; a photo chosen for
      // one task must not land on whichever task the screen now shows.
      if (composerSnapshotRef.current.taskId !== task.id) {
        return;
      }
      composerSnapshotRef.current.attachment = picked;
      setAttachment(picked);
    } catch (error) {
      setAttachmentErrorMessage(
        error instanceof ImageAttachmentError
          ? error.message
          : `Could not attach that photo: ${
              error instanceof Error ? error.message : String(error)
            }`
      );
    } finally {
      setIsPickingAttachment(false);
    }
  };
  const openAttachmentMenu = () => {
    if (isPickingAttachment || isComposerDisabled) {
      return;
    }
    showImageAttachmentSourceMenu((source) => {
      void attachPhotoFrom(source);
    });
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
    const nextAttachment = snapshot.attachment;
    // A photo on its own is a message: the composed input the agent receives
    // is the image reference, with or without accompanying text.
    if ((!nextInput && !nextAttachment) || snapshot.isComposerDisabled) {
      return;
    }

    // Forwarded only when there is one: an input with no photo must reach
    // every layer below exactly as it always did.
    if (nextAttachment) {
      snapshot.onSendInput(nextInput, nextAttachment.payload);
    } else {
      snapshot.onSendInput(nextInput);
    }
    clearDraftInput();
    Keyboard.dismiss();
  };
  const sendDraftInput = () => submitInput(composerSnapshotRef.current.draftInput);
  const navigateBack = () => {
    if (isBackPending) {
      return;
    }

    setIsBackPending(true);
    if (!onBack()) {
      setIsBackPending(false);
      return;
    }

    // Dispatch navigation before dismissing the software keyboard. On some
    // devices the keyboard animation can otherwise make a recognized first tap
    // look ignored while the task screen remains stationary.
    Keyboard.dismiss();
  };
  const isTaskActionPending = pendingTaskAction !== null;
  const openTaskActionMenu = () => {
    if (isTaskActionPending) {
      return;
    }
    showTaskActionMenu(
      {
        mentionedFilesLabel: mentionedFilesActionLabel(activeMentionedFiles),
        ...(taskCreationPhase !== "idle" ? { taskCreation: true } : {})
      },
      (action: TaskAction) => {
        switch (action) {
          case "browse-files":
            setExplorerTaskId(task.id);
            break;
          case "mentioned-files":
            setMentionedFilesRequest({
              autoSelectUnique: false,
              history: activeMentionedFiles,
              previewRevision
            });
            break;
          case "view-diff":
            setDiffModalTaskId(task.id);
            break;
          case "advance-stage":
            onAdvanceTaskStage();
            break;
          case "close-task":
            onCloseTask();
            break;
        }
      }
    );
  };
  const selectQuickReply = (replyId: string) => {
    const currentSnapshot = composerSnapshotRef.current;
    if (
      currentSnapshot.taskId !== task.id ||
      currentSnapshot.isComposerDisabled
    ) {
      return;
    }

    const quickReply = quickReplies.find((reply) => reply.id === replyId);
    if (!quickReply) {
      return;
    }
    submitInput(buildTaskQuickReply(quickReply, currentSnapshot.draftInput));
  };

  useEffect(() => {
    const lifecycle = companionLifecycleRef.current;
    lifecycle.taskId = task.id;
    lifecycle.onOpenChange = onCompanionOpenChange;
    setExpandedTitleTaskId((currentTaskId) =>
      currentTaskId === task.id ? currentTaskId : null
    );
    setCompanionModalTaskId(null);
    setDiffModalTaskId(null);
    removeAttachment();
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

  useEffect(() => {
    if (
      task.agentType !== "agent" &&
      taskCreationPhase === "idle" &&
      !isBlocked
    ) {
      onResizeTerminal?.(terminalGeometry.cols, terminalGeometry.rows);
    }
  }, [
    isBlocked,
    onResizeTerminal,
    task.agentType,
    task.id,
    taskCreationPhase,
    terminalGeometry.cols,
    terminalGeometry.rows
  ]);

  return (
    <View
      style={styles.screen}
      testID={MOBILE_E2E_IDS.taskDetailScreen}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setScreenViewport((current) =>
          current?.width === width && current.height === height
            ? current
            : { width, height }
        );
      }}
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
            <View
              pointerEvents={model.canRecoverTaskCreation ? "auto" : "none"}
              style={styles.terminalOverlay}
              testID={MOBILE_E2E_IDS.terminalOverlay}
            >
              {isAnimatedCreation ? (
                <LoadingText
                  label={model.overlayLabel ?? "Creating task"}
                  style={styles.terminalOverlayLabel}
                />
              ) : (
                <Text style={styles.terminalOverlayLabel}>{model.overlayLabel}</Text>
              )}
              {taskCreationErrorMessage ? (
                <Text style={styles.taskCreationError}>{taskCreationErrorMessage}</Text>
              ) : null}
              {model.canRecoverTaskCreation ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{
                    busy: isTaskActionPending,
                    disabled: isTaskActionPending
                  }}
                  disabled={isTaskActionPending}
                  style={styles.taskCreationRecoverButton}
                  testID={MOBILE_E2E_IDS.taskCreationRecoverButton}
                  onPress={onRecoverTaskCreation}
                >
                  <Text style={styles.taskCreationRecoverLabel}>Recover task</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : isBlocked ? (
          <View style={styles.terminalSkeleton}>
            <View style={styles.skeletonLineWide} />
            <View style={styles.skeletonLineMid} />
            <View style={styles.skeletonLineShort} />
            <View
              pointerEvents="none"
              style={styles.terminalOverlay}
              testID={MOBILE_E2E_IDS.taskBlockedPlaceholder}
            >
              <Text style={styles.terminalOverlayLabel}>Blocked</Text>
              <Text style={styles.blockedDetail}>
                {blockedRefs.length === 1
                  ? "Waiting on 1 task:"
                  : `Waiting on ${blockedRefs.length} tasks:`}
              </Text>
              {blockedRefs.map((blocker) => (
                <Text
                  key={blocker.blockerTaskId}
                  numberOfLines={2}
                  style={styles.blockedTaskTitle}
                >
                  {blocker.task?.title ?? blocker.blockerTaskId}
                </Text>
              ))}
              <Text style={styles.blockedDetail}>
                The agent starts when its blockers finish.
              </Text>
            </View>
          </View>
        ) : task.agentType === "agent" ? (
          <AgentMessageView
            errorMessage={agentErrorMessage}
            events={agentEvents}
            status={agentStatus}
            onInterrupt={onStopAgent}
            onRequestHistory={onRequestAgentHistory}
            onResolvePermission={onResolveAgentPermission}
          />
        ) : model.isTerminalHealthy ? (
          <TerminalWebView
            fullscreen
            key={task.id}
            output={terminalOutput}
            outputEpoch={terminalOutputEpoch}
            outputStart={terminalOutputStart}
            terminalOutputSource={terminalOutputSource}
            status={terminalStatus}
            cols={terminalGeometry.cols}
            rows={terminalGeometry.rows}
            taskId={task.id}
            bottomInset={terminalBottomInset}
            selectionToolbarTop={terminalSelectionToolbarTop}
            onConsolePress={Keyboard.dismiss}
            onMentionedFilesChange={handleTerminalMentionedFilesChange}
            onOpenFile={handleTerminalOpenFile}
            onTerminalInput={onSendTerminalInput}
            onRequestScrollback={onRequestTerminalScrollback}
          />
        ) : (
          <View style={styles.terminalSkeleton}>
            <View style={styles.skeletonLineWide} />
            <View style={styles.skeletonLineMid} />
            <View style={styles.skeletonLineShort} />
            {model.overlayLabel ? (
              <View
                pointerEvents="none"
                style={styles.terminalOverlay}
                testID={MOBILE_E2E_IDS.terminalOverlay}
              >
                {isAnimatedTerminalConnection ? (
                  <LoadingText
                    label={model.overlayLabel}
                    style={styles.terminalOverlayLabel}
                  />
                ) : (
                  <Text style={styles.terminalOverlayLabel}>{model.overlayLabel}</Text>
                )}
              </View>
            ) : null}
          </View>
        )}
      </View>

      {isTitleExpanded ? (
        <Pressable
          accessible={false}
          focusable={false}
          style={[
            styles.titleDismissLayer,
            { top: topChromeBottom ?? 64 }
          ]}
          testID={MOBILE_E2E_IDS.taskTitleDismissLayer}
          onPress={() => setExpandedTitleTaskId(null)}
        />
      ) : null}

      <View
        pointerEvents="box-none"
        style={styles.topChrome}
        testID={MOBILE_E2E_IDS.taskTopChrome}
        onLayout={(event) => {
          const { y, height } = event.nativeEvent.layout;
          setTopChromeBottom(y + height);
        }}
      >
        <Pressable
          accessibilityHint="Returns to the previous screen"
          accessibilityLabel={isBackPending ? "Going back" : "Back"}
          accessibilityLiveRegion="polite"
          accessibilityRole="button"
          accessibilityState={{
            busy: isBackPending,
            disabled: isBackPending
          }}
          disabled={isBackPending}
          hitSlop={4}
          style={({ pressed }) => [
            styles.backButton,
            pressed && !isBackPending ? styles.backButtonPressed : null,
            isBackPending ? styles.backButtonPending : null
          ]}
          testID={MOBILE_E2E_IDS.taskBackButton}
          onPress={navigateBack}
        >
          {isBackPending ? (
            <ActivityIndicator color="#D5DEEC" size="small" />
          ) : (
            <Text accessible={false} style={styles.backLabel}>{"<"}</Text>
          )}
        </Pressable>
        <Pressable
          accessible
          accessibilityHint={
            isTitleExpanded ? "Collapse title" : "Expand title"
          }
          accessibilityLabel={`${model.stageLabel}: ${
            isTitleExpanded
              ? `${expandedPrompt}. Task ID: ${expandedTaskId}`
              : collapsedTaskId
                ? `${model.title}. Task ID: ${collapsedTaskId}`
                : model.title
          }`}
          accessibilityRole="button"
          accessibilityState={{ expanded: isTitleExpanded }}
          accessibilityValue={{ text: effectiveActivity }}
          style={[
            styles.titleChip,
            {
              borderColor: stageTheme.border,
              borderLeftColor: stageTheme.accent
            },
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
          <Text
            accessible={false}
            style={[styles.stageLabel, { color: stageTheme.chipLabel }]}
          >
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
                  {expandedTaskId}
                </Text>
              </View>
            </ScrollView>
          ) : (
            <>
              <Text
                accessible={false}
                numberOfLines={1}
                style={styles.title}
                testID={MOBILE_E2E_IDS.taskDetailTitle}
              >
                {model.title}
              </Text>
              {collapsedTaskId ? (
                <Text
                  accessible={false}
                  style={styles.collapsedTaskId}
                  testID={MOBILE_E2E_IDS.taskDetailTaskId}
                >
                  {collapsedTaskId}
                </Text>
              ) : null}
            </>
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
                  : companionUnread
                    ? "Visual companion ready, new update"
                  : "Visual companion ready"
              }
              accessibilityRole="button"
              accessibilityValue={
                companionStatus === "available" && companionUnread
                  ? { text: "unread" }
                  : undefined
              }
              onPress={openCompanion}
              style={styles.companionButton}
              testID={MOBILE_E2E_IDS.visualCompanionButton}
            >
              {companionStatus === "available" && companionUnread ? (
                <View
                  accessible={false}
                  importantForAccessibility="no-hide-descendants"
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
            accessibilityLabel={
              pendingTaskAction === "close-task"
                ? "Closing task"
                : pendingTaskAction === "advance-stage"
                  ? "Advancing task stage"
                  : "Task actions"
            }
            accessibilityRole="button"
            accessibilityState={{
              busy: isTaskActionPending,
              disabled: isTaskActionPending
            }}
            disabled={isTaskActionPending}
            style={styles.plusButton}
            testID={MOBILE_E2E_IDS.taskMoreButton}
            onPress={openTaskActionMenu}
          >
            {isTaskActionPending ? (
              <ActivityIndicator
                color="#E8F1FF"
                size="small"
                testID={MOBILE_E2E_IDS.taskActionPendingSpinner}
              />
            ) : (
              <Text style={styles.plusButtonLabel}>+</Text>
            )}
          </Pressable>
        </View>

        {attachment ? (
          <View
            style={styles.attachmentRow}
            testID={MOBILE_E2E_IDS.taskAttachmentPreview}
          >
            <Image
              accessibilityIgnoresInvertColors
              accessibilityLabel="Attached photo"
              source={{ uri: attachment.previewUri }}
              style={styles.attachmentThumbnail}
            />
            <Text numberOfLines={1} style={styles.attachmentLabel}>
              {attachment.payload.fileName}
            </Text>
            <Pressable
              accessibilityLabel="Remove attached photo"
              accessibilityRole="button"
              onPress={removeAttachment}
              style={styles.attachmentRemove}
              testID={MOBILE_E2E_IDS.taskAttachmentRemove}
            >
              <Text style={styles.attachmentRemoveLabel}>✕</Text>
            </Pressable>
          </View>
        ) : null}
        {attachmentErrorMessage ? (
          <Text
            style={styles.attachmentError}
            testID={MOBILE_E2E_IDS.taskAttachmentError}
          >
            {attachmentErrorMessage}
          </Text>
        ) : null}

        <View style={styles.inputComposer}>
          {canAttachPhoto ? (
            <Pressable
              accessibilityLabel="Attach photo"
              accessibilityRole="button"
              accessibilityState={{
                busy: isPickingAttachment,
                disabled: isComposerDisabled || isPickingAttachment
              }}
              disabled={isComposerDisabled || isPickingAttachment}
              onPress={openAttachmentMenu}
              style={[
                styles.attachButton,
                isComposerDisabled ? styles.attachButtonDisabled : null
              ]}
              testID={MOBILE_E2E_IDS.taskAttachButton}
            >
              {isPickingAttachment ? (
                <ActivityIndicator color="#9BB0CC" size="small" />
              ) : (
                <Ionicons color="#9BB0CC" name="add" size={24} />
              )}
            </Pressable>
          ) : null}
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
          <QuickReplySendControl
            disabled={isComposerDisabled}
            gestureScopeKey={task.id}
            hydrated={quickRepliesHydrated}
            replies={quickReplies}
            onPress={sendDraftInput}
            onSelectReply={selectQuickReply}
          />
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
      {explorerTaskId === task.id ? (
        <RepoExplorer
          title={task.title}
          listDirectory={onListTaskDirectory}
          readFile={onReadTaskFileRange}
          onInsertReference={(reference) => {
            const current = composerSnapshotRef.current.draftInput;
            updateDraftInput(appendComposerFileReference(current, reference));
          }}
          onClose={() => setExplorerTaskId(null)}
        />
      ) : null}
      {activeMentionedFilesRequest ? (
        <TaskMentionedFiles
          autoSelectUnique={activeMentionedFilesRequest.autoSelectUnique}
          history={activeMentionedFilesRequest.history}
          resolveMentions={onResolveTaskFileMentions}
          onClose={() => setMentionedFilesRequest(null)}
          onSelect={({ path, line }) => {
            if (
              activeMentionedFilesRequest.previewRevision !== previewRevision
            ) {
              return;
            }
            setMentionedFilesRequest(null);
            setSelectedFile({
              path,
              ...(line === undefined ? {} : { line }),
              previewRevision
            });
          }}
        />
      ) : null}
      {diffModalTaskId === task.id ? (
        <TaskDiffPreview
          readDiff={(request) => onReadTaskDiff(request)}
          onClose={() => setDiffModalTaskId(null)}
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
  blockedDetail: {
    color: "#93A7C8",
    fontSize: 13,
    maxWidth: 300,
    textAlign: "center"
  },
  blockedTaskTitle: {
    color: "#E6EDF8",
    fontSize: 14,
    fontWeight: "600",
    maxWidth: 300,
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
    elevation: 6,
    zIndex: 5
  },
  backButton: {
    alignItems: "center",
    backgroundColor: "rgba(13, 21, 36, 0.78)",
    borderColor: "#22304D",
    borderRadius: 999,
    borderWidth: 1,
    height: 48,
    justifyContent: "center",
    width: 48
  },
  backButtonPending: {
    opacity: 0.72
  },
  backButtonPressed: {
    opacity: 0.62,
    transform: [{ scale: 0.96 }]
  },
  backLabel: {
    color: "#D5DEEC",
    fontSize: 19,
    fontWeight: "700",
    lineHeight: 19
  },
  /** Stage colour arrives inline; only the geometry is static here. */
  titleChip: {
    alignItems: "center",
    backgroundColor: "rgba(13, 21, 36, 0.78)",
    borderRadius: 18,
    borderWidth: 1,
    borderLeftWidth: TASK_STAGE_STRIPE_WIDTH,
    flex: 1,
    flexDirection: "row",
    gap: 10,
    minWidth: 0,
    paddingHorizontal: 14,
    paddingLeft: 14 - (TASK_STAGE_STRIPE_WIDTH - 1),
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
  // The title above takes the slack and truncates to one line; the id sits
  // beside it at its own width and never shrinks.
  collapsedTaskId: {
    color: "#7E93B4",
    flexShrink: 0,
    fontFamily: "Menlo",
    fontSize: 11
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
  attachmentRow: {
    alignItems: "center",
    backgroundColor: "rgba(8, 15, 27, 0.88)",
    borderColor: "#20304C",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginBottom: 8,
    padding: 8
  },
  attachmentThumbnail: {
    backgroundColor: "#0B1322",
    borderRadius: 8,
    height: 44,
    width: 44
  },
  attachmentLabel: {
    color: "#C6D6EC",
    flex: 1,
    fontSize: 12
  },
  attachmentRemove: {
    alignItems: "center",
    borderRadius: 999,
    height: 28,
    justifyContent: "center",
    width: 28
  },
  attachmentRemoveLabel: {
    color: "#9BB0CC",
    fontSize: 14,
    fontWeight: "700"
  },
  attachmentError: {
    color: "#FF9A8B",
    fontSize: 12,
    marginBottom: 8,
    paddingHorizontal: 4
  },
  attachButton: {
    alignItems: "center",
    borderRadius: 999,
    height: 32,
    justifyContent: "center",
    width: 32
  },
  attachButtonDisabled: {
    opacity: 0.45
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
