import React, { useCallback, useEffect, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Alert,
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
  TaskPort,
  TaskPreviewOpenResult,
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
import type { TaskInputSendOutcome } from "../state/mobileController";
import type { TerminalOutputLike } from "../state/terminalOutputBuffer";
import type {
  CompanionEvent,
  FrameAgentEvent,
  PermissionDecision
} from "@kanna/agent-protocol";
import { AgentMessageView } from "./AgentMessageView";
import { TaskDiffPreview } from "./TaskDiffPreview";
import { TaskPreviewModal } from "./TaskPreviewModal";
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
  appendComposerFileReference,
  shouldTaskComposerScroll,
  TASK_COMPOSER_LINE_HEIGHT,
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
  desktopWorkspace?: boolean;
  blockerTasks?: readonly BlockerTaskRef[];
  e2eTaskSnapshotMarker?: string;
  terminalOutput: TerminalOutputLike;
  terminalOutputEpoch: number;
  terminalOutputStart: number;
  terminalOutputSource?: TaskTerminalOutputSource;
  terminalCols?: number | null;
  terminalRows?: number | null;
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
  onReadTaskFileRange(path: string, startLine: number, lineCount: number, metadataOnly?: boolean, startByte?: number): Promise<RepoFileRange>;
  onReadTaskDiff(request: TaskDiffRequest): Promise<TaskDiffContent>;
  taskPreviewRouteAvailable?: boolean;
  onOpenTaskPreview?(portName?: string): Promise<TaskPreviewOpenResult>;
  onCloseTaskPreview?(): Promise<void>;
  onSendInput(
    input: string,
    attachment?: TaskInputAttachment
  ): Promise<TaskInputSendOutcome> | void;
  /** Injected by the attachment tests; production uses the Expo picker. */
  pickAttachment?(source: ImageAttachmentSource): Promise<PreparedImageAttachment | null>;
  onSendTerminalInput?(dataB64: string): void;
  /** The terminal view scrolled near the top of its loaded buffer. */
  onRequestTerminalScrollback?(): void;
  onResizeTerminal?(cols: number, rows: number): void;
  onTakeTerminalControl?(): void;
  onReleaseTerminalControl?(): void;
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

type ComposerInputStatus = {
  taskId: string;
  outcome: TaskInputSendOutcome | { status: "sending" };
};

function composerInputStatusMessage(
  outcome: ComposerInputStatus["outcome"]
): string {
  switch (outcome.status) {
    case "sending":
      return "Sending input to the desktop…";
    case "delivered":
      return "Input accepted by the desktop; agent processing is not confirmed yet.";
    case "failed":
      return `Input was not sent: ${outcome.message} Your text is still here.`;
    case "uncertain":
      return `Input delivery is uncertain: ${outcome.message} Check the desktop terminal before retrying. Your text is still here.`;
  }
}

function composerInputStatusIconColor(
  outcome: ComposerInputStatus["outcome"]
): string {
  if (outcome.status === "failed" || outcome.status === "uncertain") {
    return "#FF9A8B";
  }
  return "#9BB0CC";
}

function composerInputStatusIcon(
  outcome: ComposerInputStatus["outcome"]
): "warning-outline" | "time-outline" | "checkmark-circle-outline" {
  if (outcome.status === "failed" || outcome.status === "uncertain") {
    return "warning-outline";
  }
  if (outcome.status === "sending") {
    return "time-outline";
  }
  return "checkmark-circle-outline";
}

export function TaskScreen({
  task,
  desktopWorkspace = false,
  blockerTasks = [],
  e2eTaskSnapshotMarker,
  terminalOutput,
  terminalOutputEpoch,
  terminalOutputStart,
  terminalOutputSource,
  terminalCols = null,
  terminalRows = null,
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
  taskPreviewRouteAvailable = true,
  onOpenTaskPreview = () =>
    Promise.reject(new Error("This desktop does not support dev-server preview.")),
  onCloseTaskPreview = () => Promise.resolve(),
  onSendInput,
  pickAttachment = pickImageAttachment,
  onSendTerminalInput,
  onRequestTerminalScrollback,
  onResizeTerminal,
  onTakeTerminalControl,
  onReleaseTerminalControl,
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
  const [inputDeliveryStatus, setInputDeliveryStatus] =
    useState<ComposerInputStatus | null>(null);
  const [inputSendingTaskId, setInputSendingTaskId] = useState<string | null>(
    null
  );
  const [isPickingAttachment, setIsPickingAttachment] = useState(false);
  const [isComposerScrollable, setIsComposerScrollable] = useState(false);
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isBackPending, setIsBackPending] = useState(false);
  const [terminalControlTaken, setTerminalControlTaken] = useState(false);
  useEffect(() => {
    // Takeover belongs to one live terminal attachment, not to the task row
    // or screen component. A task switch, reconnect, background expiry, or
    // terminal replacement must never leave the next attachment showing a
    // stale release action.
    setTerminalControlTaken(false);
  }, [task.id]);
  useEffect(() => {
    if (terminalStatus !== "live") {
      setTerminalControlTaken(false);
    }
  }, [terminalStatus]);
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
  const [previewModalTaskId, setPreviewModalTaskId] = useState<string | null>(null);
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
  // ellipsizes. A local creation slot has no durable id, but a recovered task
  // can already have its owner-local id before creation returns to idle.
  const collapsedTaskId = task.ownerLocalTaskId?.trim() ||
    (task.id.startsWith("create:") ? null : expandedTaskId);
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
        agentStatus === "restarting" ||
        agentStatus === "error"
      : model.isComposerDisabled);
  const isAnimatedCreation =
    taskCreationPhase === "pending" || taskCreationPhase === "recovering";
  const isAnimatedTerminalConnection =
    taskCreationPhase === "idle" &&
    !isAgentTask &&
    (terminalStatus === "idle" ||
      terminalStatus === "connecting" ||
      terminalStatus === "restarting");
  const terminalViewport =
    screenViewport ?? { width: windowWidth, height: windowHeight };
  const terminalGeometry = resolveMobileTerminalGeometry(terminalViewport);
  const terminalBottomInset = getTerminalBottomInset(
    screenViewport?.height ?? 0,
    composerTop
  );
  const terminalSelectionToolbarTop =
    getTerminalSelectionToolbarTop(topChromeBottom);
  // A transient transport reconnect does not invalidate the authoritative
  // snapshot already on screen. Keep the same xterm document mounted so the
  // resumed generation replaces its buffer atomically instead of briefly
  // rebuilding a phone-width terminal and presenting that as a reconnect.
  const hasAuthoritativeTerminalSnapshot =
    terminalOutput.length > 0 && terminalCols !== null && terminalRows !== null;
  const preservesAuthoritativeTerminalSnapshot =
    hasAuthoritativeTerminalSnapshot &&
    (terminalStatus === "idle" ||
      terminalStatus === "connecting" ||
      terminalStatus === "restarting");
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
  const isInputSending = inputSendingTaskId === task.id;
  const activeInputDeliveryStatus =
    inputDeliveryStatus?.taskId === task.id
      ? inputDeliveryStatus.outcome
      : null;
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
  const inputSubmissionRef = useRef<{
    token: symbol;
    taskId: string;
    input: string;
    draftInput: string;
    attachment: PreparedImageAttachment | null;
  } | null>(null);
  const composerLayoutRef = useRef({
    contentHeight: TASK_COMPOSER_MIN_HEIGHT,
    deferredContentHeight: null as number | null,
    draftChangedSinceExpansion: false,
    isExpanded: false
  });
  const composerInputRef = useRef<TextInput>(null);
  const composerScrollRef = useRef<ScrollView>(null);
  const revealComposerCaret = useCallback(() => {
    requestAnimationFrame(() => {
      const end = composerSnapshotRef.current.draftInput.length;
      composerInputRef.current?.setNativeProps({
        selection: { end, start: end }
      });
      composerScrollRef.current?.scrollToEnd({ animated: false });
    });
  }, []);
  const expandComposer = useCallback(() => {
    if (!composerLayoutRef.current.isExpanded) {
      composerLayoutRef.current.isExpanded = true;
      composerLayoutRef.current.deferredContentHeight = null;
      composerLayoutRef.current.draftChangedSinceExpansion = false;
      setIsComposerExpanded(true);
    }
    const shouldScroll = shouldTaskComposerScroll(
      composerLayoutRef.current.contentHeight
    );
    setIsComposerScrollable(shouldScroll);
    if (shouldScroll) {
      revealComposerCaret();
    }
  }, [revealComposerCaret]);
  const collapseComposer = useCallback(() => {
    composerLayoutRef.current.isExpanded = false;
    composerScrollRef.current?.scrollTo({ animated: false, y: 0 });
    setIsComposerExpanded(false);
  }, []);
  const applyComposerContentHeight = (contentHeight: number) => {
    composerLayoutRef.current.contentHeight = contentHeight;
    const shouldScroll = shouldTaskComposerScroll(contentHeight);
    setIsComposerScrollable(shouldScroll);
    if (shouldScroll) {
      revealComposerCaret();
    }
  };
  const updateDraftInput = (nextDraftInput: string) => {
    composerSnapshotRef.current.draftInput = nextDraftInput;
    composerLayoutRef.current.draftChangedSinceExpansion = true;
    if (!nextDraftInput) {
      composerLayoutRef.current.deferredContentHeight = null;
      composerLayoutRef.current.contentHeight = TASK_COMPOSER_MIN_HEIGHT;
      setIsComposerScrollable(false);
    } else if (composerLayoutRef.current.deferredContentHeight !== null) {
      const deferredContentHeight =
        composerLayoutRef.current.deferredContentHeight;
      composerLayoutRef.current.deferredContentHeight = null;
      applyComposerContentHeight(deferredContentHeight);
    }
    if (inputDeliveryStatus?.taskId === task.id) {
      setInputDeliveryStatus(null);
    }
    setDraftInput(nextDraftInput);
  };
  const clearDraftInput = () => {
    composerSnapshotRef.current.draftInput = "";
    composerSnapshotRef.current.attachment = null;
    composerLayoutRef.current.deferredContentHeight = null;
    composerLayoutRef.current.contentHeight = TASK_COMPOSER_MIN_HEIGHT;
    setIsComposerScrollable(false);
    setDraftInput("");
    setAttachment(null);
    setAttachmentErrorMessage(null);
  };
  const removeAttachment = () => {
    composerSnapshotRef.current.attachment = null;
    if (inputDeliveryStatus?.taskId === task.id) {
      setInputDeliveryStatus(null);
    }
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
      if (inputDeliveryStatus?.taskId === task.id) {
        setInputDeliveryStatus(null);
      }
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
    // The input stays intrinsically sized so Fabric reports soft wraps. The
    // surrounding native viewport owns the cap and scrolling, avoiding the
    // controlled-height TextInput path that drops both measurements and caret
    // following on device. Ignore collapsed measurements so refocus restores
    // the last expanded content height.
    if (
      composerSnapshotRef.current.draftInput &&
      composerLayoutRef.current.isExpanded
    ) {
      const contentHeight = event.nativeEvent.contentSize.height;
      if (
        !composerLayoutRef.current.draftChangedSinceExpansion &&
        contentHeight < composerLayoutRef.current.contentHeight &&
        composerLayoutRef.current.deferredContentHeight === null
      ) {
        // Refocusing expands the outer viewport from the retained intrinsic
        // measurement. Fabric can emit one stale collapsed-height event during
        // that transition. Defer the first smaller measurement until either a
        // second measurement proves it stale or onChangeText proves it came
        // from an edit; Fabric may deliver those callbacks in either order.
        composerLayoutRef.current.deferredContentHeight = contentHeight;
        return;
      }
      composerLayoutRef.current.deferredContentHeight = null;
      applyComposerContentHeight(contentHeight);
    }
  };
  const submitInput = (input: string) => {
    const snapshot = composerSnapshotRef.current;
    const nextInput = input.trim();
    const nextAttachment = snapshot.attachment;
    // A photo on its own is a message: the composed input the agent receives
    // is the image reference, with or without accompanying text. One logical
    // submission may be in flight at a time for this task; the native input
    // remains editable, but Send cannot duplicate the pending request.
    if (
      (!nextInput && !nextAttachment) ||
      snapshot.isComposerDisabled ||
      inputSubmissionRef.current?.taskId === snapshot.taskId
    ) {
      return;
    }

    const submission = {
      token: Symbol("task-input-submission"),
      taskId: snapshot.taskId,
      input: nextInput,
      draftInput: snapshot.draftInput,
      attachment: nextAttachment
    };
    inputSubmissionRef.current = submission;
    setInputSendingTaskId(snapshot.taskId);
    setInputDeliveryStatus({
      taskId: snapshot.taskId,
      outcome: { status: "sending" }
    });

    let sendResult: Promise<TaskInputSendOutcome> | void;
    try {
      // Forwarded only when there is one: an input with no photo must reach
      // every layer below exactly as it always did. The callback's promise is
      // the authoritative boundary for clearing native draft state.
      sendResult =
        nextAttachment
          ? snapshot.onSendInput(nextInput, nextAttachment.payload)
          : snapshot.onSendInput(nextInput);
    } catch (error) {
      sendResult = Promise.reject(error);
    }

    const finishSubmission = (outcome: TaskInputSendOutcome | void) => {
      if (inputSubmissionRef.current?.token !== submission.token) {
        return;
      }
      inputSubmissionRef.current = null;
      setInputSendingTaskId(null);
      const current = composerSnapshotRef.current;
      const stillOwnsSubmittedDraft =
        current.taskId === submission.taskId &&
        current.draftInput === submission.draftInput &&
        current.attachment === submission.attachment;
      if (!stillOwnsSubmittedDraft) {
        return;
      }

      const resolvedOutcome: TaskInputSendOutcome =
        outcome ?? { status: "delivered" };
      setInputDeliveryStatus({
        taskId: submission.taskId,
        outcome: resolvedOutcome
      });
      if (resolvedOutcome.status === "delivered") {
        clearDraftInput();
        Keyboard.dismiss();
      }
    };
    const failSubmission = (error: unknown) => {
      // A callback that rejects without mapping its transport error is still
      // unsafe to retry: the request may have reached the desktop. Keep the
      // draft and expose the conservative outcome at the composer.
      if (inputSubmissionRef.current?.token !== submission.token) {
        return;
      }
      inputSubmissionRef.current = null;
      setInputSendingTaskId(null);
      const current = composerSnapshotRef.current;
      if (
        current.taskId !== submission.taskId ||
        current.draftInput !== submission.draftInput ||
        current.attachment !== submission.attachment
      ) {
        return;
      }
      setInputDeliveryStatus({
        taskId: submission.taskId,
        outcome: {
          status: "uncertain",
          message:
            error instanceof Error
              ? error.message
              : "the connection ended before delivery was confirmed"
        }
      });
    };

    // A synchronous void callback is retained for lightweight embedders and
    // test doubles; production navigation returns the controller promise.
    // Handling it synchronously also keeps native TextInput clearing
    // deterministic for callbacks that explicitly guarantee acceptance.
    if (sendResult === undefined) {
      finishSubmission(undefined);
    } else {
      void sendResult.then(finishSubmission).catch(failSubmission);
    }
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
  const previewPorts: readonly TaskPort[] = task.ports ?? [];
  const previewAvailable =
    taskCreationPhase === "idle" &&
    taskPreviewRouteAvailable &&
    previewPorts.length > 0;
  const openTaskActionMenu = () => {
    if (isTaskActionPending) {
      return;
    }
    showTaskActionMenu(
      {
        mentionedFilesLabel: mentionedFilesActionLabel(activeMentionedFiles),
        ...(previewAvailable ? { previewAvailable: true } : {}),
        ...(taskCreationPhase !== "idle" ? { taskCreation: true } : {})
      },
      (action: TaskAction) => {
        switch (action) {
          case "preview":
            setPreviewModalTaskId(task.id);
            break;
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
    setPreviewModalTaskId(null);
    setInputDeliveryStatus(null);
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
      expandComposer();
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hideSubscription = Keyboard.addListener("keyboardWillHide", () => {
      collapseComposer();
      setKeyboardHeight(0);
    });

    return () => {
      composerSnapshotRef.current.isComposerDisabled = true;
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [collapseComposer, expandComposer]);

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

  const isComposerViewportScrollable =
    isComposerScrollable ||
    (!isComposerExpanded &&
      composerLayoutRef.current.contentHeight > TASK_COMPOSER_MIN_HEIGHT);

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
        ) : model.isTerminalHealthy ||
          preservesAuthoritativeTerminalSnapshot ? (
          <>
            <TerminalWebView
              fullscreen
              key={task.id}
              output={terminalOutput}
              outputEpoch={terminalOutputEpoch}
              outputStart={terminalOutputStart}
              terminalOutputSource={terminalOutputSource}
              status={terminalStatus}
              cols={terminalCols}
              rows={terminalRows}
              taskId={task.id}
              bottomInset={terminalBottomInset}
              selectionToolbarTop={terminalSelectionToolbarTop}
              onConsolePress={Keyboard.dismiss}
              onMentionedFilesChange={handleTerminalMentionedFilesChange}
              onOpenFile={handleTerminalOpenFile}
              onTerminalInput={onSendTerminalInput}
              onRequestScrollback={onRequestTerminalScrollback}
            />
            {onTakeTerminalControl && onReleaseTerminalControl ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: terminalControlTaken }}
                style={styles.terminalControlButton}
                onPress={() => {
                  if (terminalControlTaken) {
                    onReleaseTerminalControl();
                    setTerminalControlTaken(false);
                  } else {
                    onTakeTerminalControl();
                    setTerminalControlTaken(true);
                  }
                }}
              >
                <Text style={styles.terminalControlLabel}>
                  {terminalControlTaken ? "Release terminal control" : "Take terminal control"}
                </Text>
              </Pressable>
            ) : null}
          </>
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
        style={[
          styles.topChrome,
          desktopWorkspace ? styles.desktopTopChrome : null
        ]}
        testID={MOBILE_E2E_IDS.taskTopChrome}
        onLayout={(event) => {
          const { y, height } = event.nativeEvent.layout;
          setTopChromeBottom(y + height);
        }}
      >
        {!desktopWorkspace ? (
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
        ) : null}
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
            desktopWorkspace ? styles.desktopTitleChip : null,
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
            <>
              <ScrollView
                accessible={false}
                nestedScrollEnabled
                showsVerticalScrollIndicator
                style={[
                  styles.promptScroll,
                  { maxHeight: expandedPromptMaxHeight }
                ]}
              >
                <Text
                  accessible={false}
                  selectable
                  style={styles.prompt}
                  testID={MOBILE_E2E_IDS.taskExpandedPrompt}
                >
                  {expandedPrompt}
                </Text>
              </ScrollView>
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
            </>
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
        {desktopWorkspace ? (
          <View style={styles.desktopWorkspaceTabs}>
            <View
              accessibilityRole="tab"
              accessibilityState={{ selected: true }}
              style={[styles.desktopWorkspaceTab, styles.desktopWorkspaceTabSelected]}
              testID={MOBILE_E2E_IDS.taskWorkspaceTerminalTab}
            >
              <Text style={styles.desktopWorkspaceTabSelectedLabel}>Terminal</Text>
            </View>
            <Pressable
              accessibilityRole="tab"
              style={styles.desktopWorkspaceTab}
              testID={MOBILE_E2E_IDS.taskWorkspaceFilesTab}
              onPress={() => setExplorerTaskId(task.id)}
            >
              <Text style={styles.desktopWorkspaceTabLabel}>Files</Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              style={styles.desktopWorkspaceTab}
              testID={MOBILE_E2E_IDS.taskWorkspaceDiffTab}
              onPress={() => setDiffModalTaskId(task.id)}
            >
              <Text style={styles.desktopWorkspaceTabLabel}>Diff</Text>
            </Pressable>
            {previewAvailable ? (
              <Pressable
                accessibilityRole="tab"
                style={styles.desktopWorkspaceTab}
                testID={MOBILE_E2E_IDS.taskPreviewButton}
                onPress={() => setPreviewModalTaskId(task.id)}
              >
                <Text style={styles.desktopWorkspaceTabLabel}>Preview</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
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
          {previewAvailable && !desktopWorkspace ? (
            <Pressable
              accessibilityLabel="Preview dev server"
              accessibilityRole="button"
              onPress={() => setPreviewModalTaskId(task.id)}
              style={styles.companionButton}
              testID={MOBILE_E2E_IDS.taskPreviewButton}
            >
              <Text style={styles.companionButtonLabel}>Preview</Text>
            </Pressable>
          ) : null}
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
        {activeInputDeliveryStatus ? (
          <View
            accessibilityLiveRegion="polite"
            accessibilityLabel={composerInputStatusMessage(
              activeInputDeliveryStatus
            )}
            style={[
              styles.taskInputStatus,
              activeInputDeliveryStatus.status === "failed" ||
              activeInputDeliveryStatus.status === "uncertain"
                ? styles.taskInputStatusError
                : null
            ]}
            testID={MOBILE_E2E_IDS.taskInputStatus}
          >
            <Ionicons
              color={composerInputStatusIconColor(activeInputDeliveryStatus)}
              name={composerInputStatusIcon(activeInputDeliveryStatus)}
              size={16}
            />
            <Text style={styles.taskInputStatusText}>
              {composerInputStatusMessage(activeInputDeliveryStatus)}
            </Text>
          </View>
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
          <ScrollView
            ref={composerScrollRef}
            contentContainerStyle={styles.inputFieldContent}
            keyboardShouldPersistTaps="always"
            scrollEnabled={isComposerViewportScrollable}
            showsVerticalScrollIndicator={isComposerViewportScrollable}
            style={[
              styles.inputFieldViewport,
              {
                height: !isComposerExpanded
                  ? TASK_COMPOSER_MIN_HEIGHT
                  : Math.min(
                      TASK_COMPOSER_MAX_HEIGHT,
                      Math.max(
                        TASK_COMPOSER_MIN_HEIGHT,
                        composerLayoutRef.current.contentHeight
                      )
                    )
              }
            ]}
            testID={MOBILE_E2E_IDS.taskInputViewport}
          >
            <TextInput
              {...TASK_COMPOSER_TEXT_INPUT_PROPS}
              ref={composerInputRef}
              editable={!isComposerDisabled}
              onChangeText={updateDraftInput}
              onContentSizeChange={updateComposerInputHeight}
              onBlur={collapseComposer}
              onFocus={expandComposer}
              onPressIn={expandComposer}
              placeholder="Reply…"
              placeholderTextColor="#6F89AE"
              scrollEnabled={false}
              style={[
                styles.inputField,
                // Fabric can retain a multiline TextInput's intrinsic native
                // height after its controlled value becomes empty. Pin the
                // empty input to one line on the existing native view; omit
                // the height while editing so it can still report soft wraps.
                !draftInput ? { height: TASK_COMPOSER_MIN_HEIGHT } : null,
                isComposerDisabled ? styles.inputFieldDisabled : null
              ]}
              testID={MOBILE_E2E_IDS.taskInput}
              value={draftInput}
            />
          </ScrollView>
          <QuickReplySendControl
            disabled={isComposerDisabled || isInputSending}
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
      {previewModalTaskId === task.id ? (
        <TaskPreviewModal
          ports={previewPorts}
          taskTitle={task.title}
          onClose={() => {
            setPreviewModalTaskId(null);
            void onCloseTaskPreview().catch((error: unknown) => {
              Alert.alert(
                "Couldn’t close preview",
                error instanceof Error
                  ? error.message
                  : "The preview will expire automatically."
              );
            });
          }}
          onOpen={onOpenTaskPreview}
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
  terminalControlButton: {
    backgroundColor: "#101A29",
    borderColor: "#33445F",
    borderRadius: 6,
    borderWidth: 1,
    bottom: 112,
    paddingHorizontal: 10,
    paddingVertical: 7,
    position: "absolute",
    right: 12,
    zIndex: 3
  },
  terminalControlLabel: {
    color: "#D8E4F4",
    fontSize: 12,
    fontWeight: "600"
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
  desktopTopChrome: {
    alignItems: "center",
    backgroundColor: "rgba(11, 21, 37, 0.97)",
    borderBottomColor: "#22304D",
    borderBottomWidth: 1,
    gap: 8,
    left: 0,
    paddingHorizontal: 12,
    paddingVertical: 8,
    right: 0,
    top: 0
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
  desktopTitleChip: {
    backgroundColor: "transparent",
    borderRadius: 6,
    maxWidth: 310,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  desktopWorkspaceTabs: {
    alignItems: "center",
    flexDirection: "row",
    gap: 3
  },
  desktopWorkspaceTab: {
    alignItems: "center",
    borderRadius: 6,
    justifyContent: "center",
    minHeight: 36,
    paddingHorizontal: 11
  },
  desktopWorkspaceTabSelected: {
    backgroundColor: "#22304D"
  },
  desktopWorkspaceTabLabel: {
    color: "#8FA4C4",
    fontSize: 12,
    fontWeight: "700"
  },
  desktopWorkspaceTabSelectedLabel: {
    color: "#F5F7FB",
    fontSize: 12,
    fontWeight: "800"
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
  taskInputStatus: {
    alignItems: "center",
    backgroundColor: "rgba(32, 48, 76, 0.72)",
    borderColor: "rgba(155, 176, 204, 0.42)",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  taskInputStatusError: {
    backgroundColor: "rgba(92, 34, 31, 0.76)",
    borderColor: "rgba(255, 154, 139, 0.5)"
  },
  taskInputStatusText: {
    color: "#C6D6EC",
    flex: 1,
    fontSize: 12,
    lineHeight: 17
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
    alignItems: "flex-end",
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
    fontSize: 14,
    lineHeight: TASK_COMPOSER_LINE_HEIGHT,
    minHeight: TASK_COMPOSER_MIN_HEIGHT,
    paddingHorizontal: 8,
    paddingVertical: 10,
    textAlignVertical: "top",
    width: "100%"
  },
  inputFieldContent: {
    flexGrow: 1
  },
  inputFieldViewport: {
    flex: 1
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
