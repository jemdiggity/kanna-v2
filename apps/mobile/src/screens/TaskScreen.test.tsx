import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type {
  TaskCreationPhase,
  TaskTerminalStatus
} from "../state/sessionStore";
import {
  DEFAULT_TASK_QUICK_REPLIES,
  type TaskQuickReply
} from "./taskQuickReplies";
import { getTerminalSelectionToolbarTop } from "./terminalSafeArea";

vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
  callback(0);
  return 0;
});

const hookHarness = vi.hoisted(() => ({
  callbackIndex: 0,
  callbacks: [] as unknown[],
  effectCleanups: [] as Array<(() => void) | undefined>,
  effectDependencies: [] as Array<readonly unknown[] | undefined>,
  effectIndex: 0,
  hookIndex: 0,
  refIndex: 0,
  refs: [] as Array<{ current: unknown }>,
  stateValues: [] as unknown[]
}));

const componentMocks = vi.hoisted(() => ({
  draftSetter: vi.fn(),
  keyboardDismiss: vi.fn(),
  onBack: vi.fn(() => true),
  onAdvanceTaskStage: vi.fn(),
  onCloseTask: vi.fn(),
  onSendInput: vi.fn(),
  showTaskActionMenu: vi.fn()
}));

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();

  return {
    ...actual,
    useCallback: <T,>(callback: T) => {
      const index = hookHarness.callbackIndex++;
      hookHarness.callbacks[index] ??= callback;
      return hookHarness.callbacks[index] as T;
    },
    useEffect: vi.fn(
      (
        callback: () => void | (() => void),
        dependencies?: readonly unknown[]
      ) => {
        const effectIndex = hookHarness.effectIndex;
        hookHarness.effectIndex += 1;
        const previousDependencies =
          hookHarness.effectDependencies[effectIndex];
        const dependenciesChanged =
          dependencies === undefined ||
          previousDependencies === undefined ||
          dependencies.length !== previousDependencies.length ||
          dependencies.some(
            (dependency, index) =>
              !Object.is(dependency, previousDependencies[index])
          );

        hookHarness.effectDependencies[effectIndex] = dependencies;
        if (dependenciesChanged) {
          hookHarness.effectCleanups[effectIndex]?.();
          const cleanup = callback();
          hookHarness.effectCleanups[effectIndex] =
            typeof cleanup === "function" ? cleanup : undefined;
        }
      }
    ),
    useRef: <T,>(initialValue: T) => {
      const index = hookHarness.refIndex++;
      hookHarness.refs[index] ??= { current: initialValue };
      return hookHarness.refs[index] as { current: T };
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const index = hookHarness.hookIndex++;
      if (!(index in hookHarness.stateValues)) {
        hookHarness.stateValues[index] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      const setValue = (nextValue: T | ((value: T) => T)) => {
        const currentValue = hookHarness.stateValues[index] as T;
        hookHarness.stateValues[index] =
          typeof nextValue === "function"
             ? (nextValue as (value: T) => T)(currentValue)
            : nextValue;
        if (index === 0) {
          componentMocks.draftSetter(hookHarness.stateValues[index]);
        }
      };
      return [hookHarness.stateValues[index] as T, vi.fn(setValue)] as const;
    }
  };
});

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Keyboard: {
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    dismiss: componentMocks.keyboardDismiss
  },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  TextInput: "TextInput",
  useWindowDimensions: () => ({ height: 800, width: 390 }),
  View: "View"
}));

vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("./AgentMessageView", () => ({
  AgentMessageView: "AgentMessageView"
}));

vi.mock("../components/LoadingText", () => ({
  LoadingText: "LoadingText"
}));

vi.mock("./TerminalWebView", () => ({
  TerminalWebView: "TerminalWebView"
}));
vi.mock("./RepoExplorer", () => ({ RepoExplorer: "RepoExplorer" }));

vi.mock("./TaskFilePreview", () => ({
  TaskFilePreview: "TaskFilePreview"
}));

vi.mock("./TaskDiffPreview", () => ({
  TaskDiffPreview: "TaskDiffPreview"
}));

vi.mock("./TaskMentionedFiles", () => ({
  TaskMentionedFiles: "TaskMentionedFiles"
}));

vi.mock("./VisualCompanionModal", () => ({
  VisualCompanionModal: "VisualCompanionModal"
}));

vi.mock("./TaskPreviewModal", () => ({
  TaskPreviewModal: "TaskPreviewModal"
}));

vi.mock("./QuickReplySendControl", () => ({
  QuickReplySendControl: "QuickReplySendControl"
}));

vi.mock("./taskActionMenu", () => ({
  showTaskActionMenu: componentMocks.showTaskActionMenu
}));

let TaskScreen: typeof import("./TaskScreen").TaskScreen | null = null;

beforeAll(async () => {
  TaskScreen = (await import("./TaskScreen")).TaskScreen;
});

beforeEach(() => {
  hookHarness.callbackIndex = 0;
  hookHarness.callbacks.length = 0;
  hookHarness.effectDependencies = [];
  hookHarness.effectCleanups = [];
  hookHarness.effectIndex = 0;
  hookHarness.hookIndex = 0;
  hookHarness.refIndex = 0;
  hookHarness.refs.length = 0;
  hookHarness.stateValues.length = 0;
  componentMocks.draftSetter.mockReset();
  componentMocks.keyboardDismiss.mockReset();
  componentMocks.onBack.mockReset();
  componentMocks.onBack.mockReturnValue(true);
  componentMocks.onAdvanceTaskStage.mockReset();
  componentMocks.onCloseTask.mockReset();
  componentMocks.onSendInput.mockReset();
  componentMocks.showTaskActionMenu.mockReset();
});
interface ElementNode {
  type: unknown;
  props?: {
    children?: ElementNode | ElementNode[] | string | null;
    testID?: string;
    [key: string]: unknown;
  };
}

interface RenderTaskScreenOptions {
  agentType?: "agent" | "pty";
  blockedByTaskIds?: string[];
  blockerTasks?: Array<{
    blockerTaskId: string;
    task: { id: string; repoId: string; title: string; stage: string } | null;
  }>;
  terminalOutputEpoch?: number;
  terminalOutputStart?: number;
  e2eTaskSnapshotMarker?: string;
  activity?: "idle" | "working" | "unread";
  draftInput?: string;
  terminalOutput?: string;
  terminalStatus?: TaskTerminalStatus;
  taskCreationPhase?: TaskCreationPhase;
  taskCreationErrorMessage?: string | null;
  onRecoverTaskCreation?: () => void;
  onBack?: () => boolean;
  agentStatus?: TaskTerminalStatus;
  onSendTerminalInput?: (
    dataB64: string,
    kind: "draft" | "submission" | "control"
  ) => void;
  terminalInputUnavailableReason?:
    | "connecting"
    | "authentication_required"
    | "capability_required"
    | "terminal_detached"
    | null;
  onResizeTerminal?: (cols: number, rows: number) => void;
  onResolveTaskFileMentions?: (
    mentions: readonly { path: string; line?: number }[]
  ) => Promise<{
    mentions: Array<{
      path: string;
      matches: Array<{ path: string }>;
      truncated: boolean;
    }>;
  }>;
  onReadTaskFile?: (path: string) => Promise<{ path: string; content: string }>;
  onReadTaskDiff?: () => Promise<{
    taskId: string;
    baseRef: string | null;
    mergeBase: string | null;
    patch: string;
    truncated: boolean;
  }>;
  onOpenTaskPreview?: () => Promise<{
    url: string;
    portName: string;
    port: number;
    expiresAt: number;
    ports: Array<{ name: string; port: number; listening: boolean }>;
  }>;
  onCloseTaskPreview?: () => Promise<void>;
  taskPreviewRouteAvailable?: boolean;
  taskId?: string;
  ownerLocalTaskId?: string;
  title?: string;
  prompt?: string;
  ports?: Array<{ name: string; port: number }>;
  queuedInputCount?: number;
  queuedInputReason?: "input_held_by_draft" | "delivery_uncertain" | "sending";
  quickReplies?: readonly TaskQuickReply[];
  quickRepliesHydrated?: boolean;
  companionStatus?: "idle" | "connecting" | "reconnecting" | "available" | "unavailable" | "error";
  companionSnapshot?: {
    sessionId: string;
    revision: string;
    documentKind: "fragment";
    html: string;
  } | null;
  companionUnread?: boolean;
  companionErrorMessage?: string | null;
  companionEventStatus?: "idle" | "sending" | "sent" | "error";
  onCompanionOpenChange?: (isOpen: boolean) => void;
  onSendCompanionEvent?: (...args: unknown[]) => void;
  pendingTaskAction?:
    | "advance-stage"
    | "close-task"
    | null;
}

function renderTaskScreen(options: RenderTaskScreenOptions = {}): ElementNode {
  if (!TaskScreen) {
    throw new Error("TaskScreen was not loaded");
  }

  const {
    agentType = "pty",
    blockedByTaskIds,
    blockerTasks,
    terminalOutputEpoch = 1,
    terminalOutputStart = 0,
    e2eTaskSnapshotMarker,
    activity = "idle",
    draftInput = "",
    terminalOutput = "terminal",
    terminalStatus = "live",
    taskCreationPhase = "idle",
    taskCreationErrorMessage = null,
    onRecoverTaskCreation = vi.fn(),
    onBack = componentMocks.onBack,
    agentStatus = "live",
    onSendTerminalInput,
    terminalInputUnavailableReason = "terminal_detached",
    onResizeTerminal,
    onResolveTaskFileMentions = vi.fn().mockResolvedValue({
      mentions: []
    }),
    onReadTaskFile = vi.fn().mockResolvedValue({
      path: "docs/spec.md",
      content: "# Spec"
    }),
    onReadTaskDiff = vi.fn().mockResolvedValue({
      taskId: "task-1",
      baseRef: "main",
      mergeBase: "abc123",
      patch: "",
      truncated: false
    }),
    onOpenTaskPreview = vi.fn().mockRejectedValue(new Error("unavailable")),
    onCloseTaskPreview = vi.fn().mockResolvedValue(undefined),
    taskPreviewRouteAvailable = true,
    taskId = "task-1",
    ownerLocalTaskId,
    title = "Task",
    prompt,
    ports,
    queuedInputCount,
    queuedInputReason,
    quickReplies = DEFAULT_TASK_QUICK_REPLIES,
    quickRepliesHydrated = true,
    companionStatus = "idle",
    companionSnapshot = null,
    companionUnread = false,
    companionErrorMessage = null,
    companionEventStatus = "idle",
    onCompanionOpenChange = vi.fn(),
    onSendCompanionEvent = vi.fn(),
    pendingTaskAction = null
  } = options;

  hookHarness.callbackIndex = 0;
  hookHarness.effectIndex = 0;
  hookHarness.hookIndex = 0;
  hookHarness.refIndex = 0;
  hookHarness.stateValues[0] = draftInput;
  return TaskScreen({
    task: {
      id: taskId,
      ownerLocalTaskId,
      repoId: "repo-1",
      title,
      prompt,
      ports,
      stage: "in progress",
      agentType,
      activity,
      blockedByTaskIds,
      queuedInputCount,
      queuedInputReason
    },
    blockerTasks,
    terminalOutput,
    terminalOutputEpoch,
    terminalOutputStart,
    terminalStatus,
    terminalInputUnavailableReason,
    terminalErrorMessage: null,
    taskCreationPhase,
    taskCreationErrorMessage,
    agentEvents: [{ seq: 0, event: { type: "user_message", text: "hello" } }],
    agentStatus,
    agentErrorMessage: null,
    companionStatus,
    companionSnapshot,
    companionUnread,
    companionErrorMessage,
    companionEventStatus,
    quickReplies,
    quickRepliesHydrated,
    pendingTaskAction,
    e2eTaskSnapshotMarker,
    onBack,
    onAdvanceTaskStage: componentMocks.onAdvanceTaskStage,
    onCloseTask: componentMocks.onCloseTask,
    onSendInput: componentMocks.onSendInput,
    onSendTerminalInput,
    onResizeTerminal,
    onStopAgent: vi.fn(),
    onResolveAgentPermission: vi.fn(),
    onRecoverTaskCreation,
    onResolveTaskFileMentions,
    onReadTaskFile,
    onListTaskDirectory: vi.fn().mockResolvedValue({
      path: "",
      entries: [],
      offset: 0,
      nextOffset: null,
      totalEntries: 0
    }),
    onReadTaskFileRange: vi.fn(),
    onReadTaskDiff,
    onOpenTaskPreview,
    onCloseTaskPreview,
    taskPreviewRouteAvailable,
    onCompanionOpenChange,
    onSendCompanionEvent
  }) as ElementNode;
}

function unmountTaskScreen(): void {
  for (const cleanup of hookHarness.effectCleanups.splice(0)) {
    cleanup?.();
  }
}

it("shows why held task messages are queued and clears the status at zero", () => {
  let tree = renderTaskScreen({
    queuedInputCount: 2,
    queuedInputReason: "input_held_by_draft"
  });
  const status = findByTestId(tree, MOBILE_E2E_IDS.taskQueuedInputStatus);
  expect(status).not.toBeNull();
  const heldCopy = JSON.stringify(status?.props?.children);
  expect(heldCopy).toContain("queued behind an unsent draft at the desktop terminal");
  // The daemon releases a held message at the producer's own submission
  // boundary *or* when the composer is attested empty, and it keeps the
  // message either way. Saying only "after that draft is submitted" invited a
  // resend that would deliver the message twice.
  expect(heldCopy).toContain("submitted or cleared");
  expect(heldCopy).toContain("don't send it again");

  tree = renderTaskScreen({ queuedInputCount: 0 });
  expect(findByTestId(tree, MOBILE_E2E_IDS.taskQueuedInputStatus)).toBeNull();
});

function invokeLayout(
  node: ElementNode | null,
  layout: { height: number; width: number; x: number; y: number }
): void {
  const onLayout = node?.props?.onLayout;
  if (typeof onLayout !== "function") {
    throw new Error("expected node to expose an onLayout callback");
  }
  onLayout({ nativeEvent: { layout } });
}

function findByTestId(node: ElementNode | ElementNode[] | string | null | undefined, testID: string): ElementNode | null {
  if (!node || typeof node === "string") {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findByTestId(child, testID);
      if (match) return match;
    }
    return null;
  }
  if (node.props?.testID === testID) {
    return node;
  }
  return findByTestId(node.props?.children, testID);
}

function findByType(node: ElementNode | ElementNode[] | string | null | undefined, type: string): ElementNode | null {
  if (!node || typeof node === "string") {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findByType(child, type);
      if (match) return match;
    }
    return null;
  }
  if (node.type === type) {
    return node;
  }
  return findByType(node.props?.children, type);
}

function findByTypeAndText(
  node: ElementNode | ElementNode[] | string | null | undefined,
  type: string,
  text: string
): ElementNode | null {
  if (!node || typeof node === "string") {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findByTypeAndText(child, type, text);
      if (match) return match;
    }
    return null;
  }
  if (node.type === type && node.props?.children === text) {
    return node;
  }
  return findByTypeAndText(node.props?.children, type, text);
}

function findPathByTestId(
  node: ElementNode | ElementNode[] | string | null | undefined,
  testID: string,
  ancestors: ElementNode[] = []
): ElementNode[] | null {
  if (!node || typeof node === "string") {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const path = findPathByTestId(child, testID, ancestors);
      if (path) return path;
    }
    return null;
  }

  const path = [...ancestors, node];
  if (node.props?.testID === testID) {
    return path;
  }
  return findPathByTestId(node.props?.children, testID, path);
}

function findCommonAncestor(
  tree: ElementNode,
  firstTestID: string,
  secondTestID: string
): ElementNode | null {
  const firstPath = findPathByTestId(tree, firstTestID);
  const secondPath = findPathByTestId(tree, secondTestID);
  if (!firstPath || !secondPath) {
    return null;
  }

  let commonAncestor: ElementNode | null = null;
  for (let index = 0; index < Math.min(firstPath.length, secondPath.length); index += 1) {
    if (firstPath[index] !== secondPath[index]) {
      break;
    }
    commonAncestor = firstPath[index];
  }
  return commonAncestor;
}

function styleEntries(node: ElementNode | null): Array<Record<string, unknown>> {
  const style = node?.props?.style;
  const entries = Array.isArray(style) ? style : [style];

  return entries.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
  );
}

function pressByTestId(tree: ElementNode, testID: string): void {
  const onPress = findByTestId(tree, testID)?.props?.onPress;
  expect(onPress).toBeTypeOf("function");
  (onPress as () => void)();
}

function findSendControl(tree: ElementNode): ElementNode | null {
  return findByType(tree, "QuickReplySendControl");
}

function pressSend(tree: ElementNode): void {
  const onPress = findSendControl(tree)?.props?.onPress;
  expect(onPress).toBeTypeOf("function");
  (onPress as () => void)();
}

describe("TaskScreen", () => {
  it("shows uncertain creation inside the task workspace and recovers in place", () => {
    const onRecoverTaskCreation = vi.fn();
    const tree = renderTaskScreen({
      taskCreationPhase: "uncertain",
      taskCreationErrorMessage: "Desktop response was lost",
      onRecoverTaskCreation,
      taskId: "create:slot-1"
    });

    expect(findByType(tree, "TerminalWebView")).toBeNull();
    expect(findByTypeAndText(tree, "Text", "Task creation interrupted")).not.toBeNull();
    expect(findByTypeAndText(tree, "Text", "Desktop response was lost")).not.toBeNull();
    expect(findByTestId(tree, "mobile.task-creation.recover")).not.toBeNull();
    expect(findSendControl(tree)?.props).toMatchObject({
      disabled: true
    });

    pressByTestId(tree, "mobile.task-creation.recover");
    expect(onRecoverTaskCreation).toHaveBeenCalledOnce();
  });

  it("opens the creation-specific task actions for an uncertain workspace", () => {
    const tree = renderTaskScreen({
      taskCreationPhase: "uncertain",
      taskId: "create:slot-1"
    });

    pressByTestId(tree, "mobile.task-more-button");

    expect(componentMocks.showTaskActionMenu).toHaveBeenCalledWith(
      { mentionedFilesLabel: "Mentioned Files (0)", taskCreation: true },
      expect.any(Function)
    );
    const onSelect = componentMocks.showTaskActionMenu.mock.calls[0]![1] as (
      selectedAction: "close-task"
    ) => void;
    onSelect("close-task");
    expect(componentMocks.onCloseTask).toHaveBeenCalledOnce();
  });

  it("blocks recovery and duplicate task actions while abort is in flight", () => {
    const onRecoverTaskCreation = vi.fn();
    const tree = renderTaskScreen({
      taskCreationPhase: "uncertain",
      taskId: "create:slot-1",
      pendingTaskAction: "close-task",
      onRecoverTaskCreation
    });

    expect(findByTestId(tree, "mobile.task-creation.recover")?.props)
      .toMatchObject({
        accessibilityState: { busy: true, disabled: true },
        disabled: true
      });
    expect(findByTestId(tree, "mobile.task-more-button")?.props)
      .toMatchObject({
        accessibilityLabel: "Closing task",
        accessibilityState: { busy: true, disabled: true },
        disabled: true
      });

    pressByTestId(tree, "mobile.task-more-button");

    expect(componentMocks.showTaskActionMenu).not.toHaveBeenCalled();
    expect(onRecoverTaskCreation).not.toHaveBeenCalled();
  });

  it("shows pending creation without offering recovery", () => {
    const tree = renderTaskScreen({
      taskCreationPhase: "pending",
      taskId: "create:slot-1"
    });

    expect(findByType(tree, "LoadingText")?.props).toMatchObject({
      label: "Creating task"
    });
    expect(findByTestId(tree, "mobile.task-creation.recover")).toBeNull();
  });

  it.each([
    ["pending", "Creating task"],
    ["recovering", "Recovering task"]
  ] as const)("animates %s task creation", (taskCreationPhase, label) => {
    const tree = renderTaskScreen({
      taskCreationPhase,
      taskId: "create:slot-1"
    });

    expect(findByType(tree, "LoadingText")?.props.label).toBe(label);
  });

  it.each(["idle", "connecting"] as const)(
    "animates PTY %s connection state",
    (terminalStatus) => {
      const tree = renderTaskScreen({ terminalStatus });

      expect(findByType(tree, "LoadingText")?.props.label).toBe("Connecting");
      expect(
        findByTestId(tree, MOBILE_E2E_IDS.terminalOverlay)?.props.pointerEvents
      ).toBe("none");
    }
  );

  it.each([
    ["connected terminal", { terminalStatus: "live" as const }],
    ["connecting terminal", { terminalStatus: "connecting" as const }],
    [
      "long scrollback",
      {
        terminalStatus: "live" as const,
        terminalOutput: `${"scrollback line\n".repeat(20_000)}END`
      }
    ]
  ])("keeps Back responsive through %s state", (_caseName, options) => {
    let tree = renderTaskScreen(options);
    let backButton = findByTestId(tree, MOBILE_E2E_IDS.taskBackButton);
    const resolveStyle = backButton?.props.style as
      | ((state: { pressed: boolean }) => unknown[])
      | undefined;

    expect(backButton?.props).toMatchObject({
      accessibilityHint: "Returns to the previous screen",
      accessibilityLabel: "Back",
      accessibilityRole: "button",
      accessibilityState: { busy: false, disabled: false },
      disabled: false,
      hitSlop: 4
    });
    expect(resolveStyle?.({ pressed: false })).toContainEqual(
      expect.objectContaining({ height: 48, width: 48 })
    );
    expect(resolveStyle?.({ pressed: true })).toContainEqual(
      expect.objectContaining({ opacity: 0.62 })
    );

    pressByTestId(tree, MOBILE_E2E_IDS.taskBackButton);

    expect(componentMocks.onBack).toHaveBeenCalledOnce();
    expect(componentMocks.keyboardDismiss).toHaveBeenCalledOnce();

    tree = renderTaskScreen(options);
    backButton = findByTestId(tree, MOBILE_E2E_IDS.taskBackButton);
    expect(backButton?.props).toMatchObject({
      accessibilityLabel: "Going back",
      accessibilityState: { busy: true, disabled: true },
      disabled: true
    });
    expect(findByType(backButton, "ActivityIndicator")).not.toBeNull();

    pressByTestId(tree, MOBILE_E2E_IDS.taskBackButton);
    expect(componentMocks.onBack).toHaveBeenCalledOnce();
  });

  it("does not leave Back disabled when no navigation boundary can pop", () => {
    const onBack = vi.fn(() => false);
    let tree = renderTaskScreen({ onBack });

    pressByTestId(tree, MOBILE_E2E_IDS.taskBackButton);
    tree = renderTaskScreen({ onBack });

    expect(onBack).toHaveBeenCalledOnce();
    expect(componentMocks.keyboardDismiss).not.toHaveBeenCalled();
    expect(
      findByTestId(tree, MOBILE_E2E_IDS.taskBackButton)?.props
    ).toMatchObject({
      accessibilityLabel: "Back",
      accessibilityState: { busy: false, disabled: false },
      disabled: false
    });
  });

  it.each(["closed", "error"] as const)(
    "keeps PTY %s state static",
    (terminalStatus) => {
      expect(
        findByType(renderTaskScreen({ terminalStatus }), "LoadingText")
      ).toBeNull();
    }
  );

  it("opens task actions from the plus button", () => {
    const tree = renderTaskScreen({ agentType: "agent" });

    pressByTestId(tree, "mobile.task-more-button");

    expect(componentMocks.showTaskActionMenu).toHaveBeenCalledOnce();
  });

  it("offers preview only for a task with declared ports and opens its modal", () => {
    expect(
      findByTestId(renderTaskScreen(), MOBILE_E2E_IDS.taskPreviewButton)
    ).toBeNull();

    let tree = renderTaskScreen({
      ports: [{ name: "DEV_PORT", port: 8471 }]
    });
    const previewButton = findByTestId(
      tree,
      MOBILE_E2E_IDS.taskPreviewButton
    );
    expect(previewButton?.props).toMatchObject({
      accessibilityLabel: "Preview dev server",
      accessibilityRole: "button"
    });

    pressByTestId(tree, MOBILE_E2E_IDS.taskPreviewButton);
    tree = renderTaskScreen({ ports: [{ name: "DEV_PORT", port: 8471 }] });
    expect(findByType(tree, "TaskPreviewModal")?.props).toMatchObject({
      ports: [{ name: "DEV_PORT", port: 8471 }],
      taskTitle: "Task"
    });

    expect(
      findByTestId(
        renderTaskScreen({
          ports: [{ name: "DEV_PORT", port: 8471 }],
          taskPreviewRouteAvailable: false
        }),
        MOBILE_E2E_IDS.taskPreviewButton
      )
    ).toBeNull();
  });

  it("closes the server preview when the preview modal closes", async () => {
    const onCloseTaskPreview = vi.fn().mockResolvedValue(undefined);
    let tree = renderTaskScreen({
      ports: [{ name: "DEV_PORT", port: 8471 }],
      onCloseTaskPreview
    });
    pressByTestId(tree, MOBILE_E2E_IDS.taskPreviewButton);
    tree = renderTaskScreen({
      ports: [{ name: "DEV_PORT", port: 8471 }],
      onCloseTaskPreview
    });

    const previewModal = findByType(tree, "TaskPreviewModal");
    (previewModal?.props?.onClose as () => void)();
    await Promise.resolve();

    expect(onCloseTaskPreview).toHaveBeenCalledOnce();
  });

  it.each([
    ["advance-stage", componentMocks.onAdvanceTaskStage],
    ["close-task", componentMocks.onCloseTask]
  ] as const)("routes the %s task action", (action, expectedCallback) => {
    const tree = renderTaskScreen({ agentType: "agent" });
    pressByTestId(tree, "mobile.task-more-button");
    const onSelect = componentMocks.showTaskActionMenu.mock.calls[0]![1] as (
      selectedAction: "advance-stage" | "close-task"
    ) => void;

    onSelect(action);

    expect(expectedCallback).toHaveBeenCalledOnce();
  });

  it("opens the diff preview from the view-diff task action and closes it", async () => {
    const onReadTaskDiff = vi.fn().mockResolvedValue({
      taskId: "task-1",
      baseRef: "main",
      mergeBase: "abc123",
      patch: "diff --git a/x b/x",
      truncated: false
    });
    let tree = renderTaskScreen({ onReadTaskDiff });
    expect(findByType(tree, "TaskDiffPreview")).toBeNull();

    pressByTestId(tree, "mobile.task-more-button");
    const onSelect = componentMocks.showTaskActionMenu.mock.calls[0]![1] as (
      selectedAction: "view-diff"
    ) => void;
    onSelect("view-diff");
    tree = renderTaskScreen({ onReadTaskDiff });

    const diffPreview = findByType(tree, "TaskDiffPreview");
    expect(diffPreview).not.toBeNull();
    await (diffPreview?.props?.readDiff as () => Promise<unknown>)();
    expect(onReadTaskDiff).toHaveBeenCalledOnce();

    (diffPreview?.props?.onClose as () => void)();
    tree = renderTaskScreen({ onReadTaskDiff });
    expect(findByType(tree, "TaskDiffPreview")).toBeNull();
  });

  it("opens the worktree browser and inserts its line reference into the composer", () => {
    let tree = renderTaskScreen({ draftInput: "Check this" });
    pressByTestId(tree, "mobile.task-more-button");
    const onSelect = componentMocks.showTaskActionMenu.mock.calls[0]![1] as (
      selectedAction: "browse-files"
    ) => void;
    onSelect("browse-files");
    tree = renderTaskScreen({ draftInput: "Check this" });
    const explorer = findByType(tree, "RepoExplorer");
    expect(explorer).not.toBeNull();

    (explorer?.props?.onInsertReference as (value: string) => void)(
      "src/main.ts:12-18"
    );

    expect(componentMocks.draftSetter).toHaveBeenLastCalledWith(
      "Check this\nsrc/main.ts:12-18"
    );
  });

  it("keeps the plus button idle without a pending task action", () => {
    const tree = renderTaskScreen({ agentType: "agent" });

    const moreButton = findByTestId(tree, "mobile.task-more-button");
    expect(moreButton?.props).toMatchObject({
      accessibilityLabel: "Task actions",
      disabled: false
    });
    expect(findByTestId(tree, "mobile.task-action-pending")).toBeNull();
  });

  it.each([
    ["close-task", "Closing task"],
    ["advance-stage", "Advancing task stage"]
  ] as const)(
    "shows a spinner and blocks the menu while %s is in flight",
    (pendingTaskAction, accessibilityLabel) => {
      const tree = renderTaskScreen({
        agentType: "agent",
        pendingTaskAction
      });

      const moreButton = findByTestId(tree, "mobile.task-more-button");
      expect(moreButton?.props).toMatchObject({
        accessibilityLabel,
        accessibilityState: { busy: true, disabled: true },
        disabled: true
      });
      expect(
        findByTestId(tree, "mobile.task-action-pending")?.type
      ).toBe("ActivityIndicator");
      expect(findByTypeAndText(tree, "Text", "+")).toBeNull();

      pressByTestId(tree, "mobile.task-more-button");

      expect(componentMocks.showTaskActionMenu).not.toHaveBeenCalled();
    }
  );

  it("offers an unread visual companion action and opens its full-screen view", () => {
    const onCompanionOpenChange = vi.fn();
    const companionSnapshot = {
      sessionId: "123-456",
      revision: "rev-1",
      documentKind: "fragment" as const,
      html: '<button data-choice="ship">Ship</button>'
    };
    let tree = renderTaskScreen({
      companionStatus: "available",
      companionSnapshot,
      companionUnread: true,
      onCompanionOpenChange
    });

    expect(findByTestId(tree, "mobile.visual-companion.button")?.props)
      .toMatchObject({
        accessibilityLabel: "Visual companion ready, new update",
        accessibilityRole: "button",
        accessibilityValue: { text: "unread" }
      });
    expect(findByTestId(tree, "mobile.visual-companion.unread")?.props)
      .toMatchObject({
        accessible: false,
        importantForAccessibility: "no-hide-descendants"
      });
    expect(findByType(tree, "VisualCompanionModal")).toBeNull();

    pressByTestId(tree, "mobile.visual-companion.button");
    tree = renderTaskScreen({
      companionStatus: "available",
      companionSnapshot,
      companionUnread: false,
      onCompanionOpenChange
    });

    expect(onCompanionOpenChange).toHaveBeenCalledWith(true);
    expect(findByTestId(tree, "mobile.visual-companion.button")?.props)
      .toMatchObject({
        accessibilityLabel: "Visual companion ready",
        accessibilityRole: "button"
      });
    expect(
      findByTestId(tree, "mobile.visual-companion.button")?.props
        ?.accessibilityValue
    ).toBeUndefined();
    expect(findByTestId(tree, "mobile.visual-companion.unread")).toBeNull();
    expect(findByType(tree, "VisualCompanionModal")?.props).toMatchObject({
      status: "available",
      snapshot: companionSnapshot
    });
  });

  it("keeps an ended companion modal visible until close and restores task focus", () => {
    const onCompanionOpenChange = vi.fn();
    const companionSnapshot = {
      sessionId: "123-456",
      revision: "rev-1",
      documentKind: "fragment" as const,
      html: "<h1>Ready</h1>"
    };
    let tree = renderTaskScreen({
      companionStatus: "available",
      companionSnapshot,
      onCompanionOpenChange
    });
    pressByTestId(tree, "mobile.visual-companion.button");

    tree = renderTaskScreen({
      companionStatus: "unavailable",
      companionSnapshot: null,
      onCompanionOpenChange
    });
    const modal = findByType(tree, "VisualCompanionModal");
    expect(modal?.props).toMatchObject({
      status: "unavailable",
      snapshot: null
    });

    (modal?.props?.onClose as () => void)();
    tree = renderTaskScreen({
      companionStatus: "unavailable",
      companionSnapshot: null,
      onCompanionOpenChange
    });
    expect(onCompanionOpenChange).toHaveBeenLastCalledWith(false);
    expect(findByType(tree, "VisualCompanionModal")).toBeNull();
  });

  it("surfaces a task-scoped source error without exposing a stale snapshot", () => {
    const message =
      "The visual companion is too large. Ask the agent to simplify the screen.";
    const staleSnapshot = {
      sessionId: "123-456",
      revision: "rev-1",
      documentKind: "fragment" as const,
      html: '<button data-choice="ship">Ship</button>'
    };
    let tree = renderTaskScreen({
      companionStatus: "error",
      companionSnapshot: staleSnapshot,
      companionErrorMessage: message
    });

    expect(findByTestId(tree, "mobile.visual-companion.button")?.props)
      .toMatchObject({ accessibilityLabel: "Visual companion unavailable" });
    pressByTestId(tree, "mobile.visual-companion.button");
    tree = renderTaskScreen({
      companionStatus: "error",
      companionSnapshot: staleSnapshot,
      companionErrorMessage: message
    });

    expect(findByType(tree, "VisualCompanionModal")?.props).toMatchObject({
      status: "error",
      snapshot: null,
      errorMessage: message
    });
  });

  it("surfaces a task-scoped source error before any snapshot exists", () => {
    const message =
      "The visual companion is not valid UTF-8 HTML. Ask the agent to recreate the screen.";
    let tree = renderTaskScreen({
      companionStatus: "error",
      companionSnapshot: null,
      companionErrorMessage: message
    });

    expect(findByTestId(tree, "mobile.visual-companion.button")?.props)
      .toMatchObject({ accessibilityLabel: "Visual companion unavailable" });
    pressByTestId(tree, "mobile.visual-companion.button");
    tree = renderTaskScreen({
      companionStatus: "error",
      companionSnapshot: null,
      companionErrorMessage: message
    });

    expect(findByType(tree, "VisualCompanionModal")?.props).toMatchObject({
      status: "error",
      snapshot: null,
      errorMessage: message
    });
  });

  it("notifies that an open companion closed when the task id changes", () => {
    const onCompanionOpenChange = vi.fn();
    const companionSnapshot = {
      sessionId: "123-456",
      revision: "rev-1",
      documentKind: "fragment" as const,
      html: "<h1>Ready</h1>"
    };
    let tree = renderTaskScreen({
      taskId: "task-pending",
      companionStatus: "available",
      companionSnapshot,
      onCompanionOpenChange
    });
    pressByTestId(tree, "mobile.visual-companion.button");
    tree = renderTaskScreen({
      taskId: "task-pending",
      companionStatus: "available",
      companionSnapshot,
      onCompanionOpenChange
    });
    expect(findByType(tree, "VisualCompanionModal")).not.toBeNull();

    tree = renderTaskScreen({
      taskId: "task-canonical",
      companionStatus: "available",
      companionSnapshot,
      onCompanionOpenChange
    });

    expect(onCompanionOpenChange.mock.calls).toEqual([[true], [false]]);
    expect(findByType(tree, "VisualCompanionModal")).toBeNull();
  });

  it("notifies that an open companion closed when the task screen unmounts", () => {
    const onCompanionOpenChange = vi.fn();
    const companionSnapshot = {
      sessionId: "123-456",
      revision: "rev-1",
      documentKind: "fragment" as const,
      html: "<h1>Ready</h1>"
    };
    const tree = renderTaskScreen({
      companionStatus: "available",
      companionSnapshot,
      onCompanionOpenChange
    });
    pressByTestId(tree, "mobile.visual-companion.button");

    unmountTaskScreen();

    expect(onCompanionOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it("forwards companion bridge events through the active task callback", () => {
    const onSendCompanionEvent = vi.fn();
    const companionSnapshot = {
      sessionId: "123-456",
      revision: "rev-1",
      documentKind: "fragment" as const,
      html: "<h1>Ready</h1>"
    };
    let tree = renderTaskScreen({
      companionStatus: "available",
      companionSnapshot,
      onSendCompanionEvent
    });
    pressByTestId(tree, "mobile.visual-companion.button");
    tree = renderTaskScreen({
      companionStatus: "available",
      companionSnapshot,
      onSendCompanionEvent
    });
    const event = {
      event_id: "mobile-1",
      type: "click",
      choice: "ship",
      text: "Ship",
      id: null,
      timestamp: 1
    };

    (findByType(tree, "VisualCompanionModal")?.props?.onSendEvent as (
      ...args: unknown[]
    ) => void)("123-456", "rev-1", event);

    expect(onSendCompanionEvent).toHaveBeenCalledWith(
      "123-456",
      "rev-1",
      event
    );
  });

  it("shows a blocked placeholder instead of a terminal for blocked tasks", () => {
    const collectText = (
      node: ElementNode | ElementNode[] | string | null | undefined
    ): string => {
      if (!node) return "";
      if (typeof node === "string") return node;
      if (Array.isArray(node)) return node.map(collectText).join("");
      return collectText(node.props?.children ?? null);
    };

    const tree = renderTaskScreen({
      blockedByTaskIds: ["kanache-task"],
      blockerTasks: [
        {
          blockerTaskId: "kanache-task",
          task: {
            id: "kanache-task",
            repoId: "repo-kanache",
            title: "Rust-input-hash donor matching",
            stage: "in progress"
          }
        }
      ]
    });

    const placeholder = findByTestId(
      tree,
      MOBILE_E2E_IDS.taskBlockedPlaceholder
    );
    expect(placeholder).not.toBeNull();
    const placeholderText = collectText(placeholder);
    expect(placeholderText).toContain("Blocked");
    expect(placeholderText).toContain("Waiting on 1 task:");
    expect(placeholderText).toContain("Rust-input-hash donor matching");
    expect(findByType(tree, "TerminalWebView")).toBeNull();
    expect(findByType(tree, "AgentMessageView")).toBeNull();
    expect(
      findByTestId(tree, MOBILE_E2E_IDS.taskInput)?.props?.editable
    ).toBe(false);
  });

  it("falls back to blocker ids when a blocker is not in the collections", () => {
    const tree = renderTaskScreen({ blockedByTaskIds: ["task-elsewhere"] });
    const placeholder = findByTestId(
      tree,
      MOBILE_E2E_IDS.taskBlockedPlaceholder
    );

    expect(placeholder).not.toBeNull();
    expect(JSON.stringify(placeholder)).toContain("task-elsewhere");
  });

  it("routes agent tasks to the native agent message view", () => {
    const tree = renderTaskScreen({ agentType: "agent" });

    expect(findByType(tree, "AgentMessageView")).not.toBeNull();
    expect(findByType(tree, "TerminalWebView")).toBeNull();
  });

  it("keeps PTY tasks on the terminal WebView", () => {
    const tree = renderTaskScreen({ agentType: "pty" });

    expect(findByType(tree, "TerminalWebView")).not.toBeNull();
    expect(findByType(tree, "AgentMessageView")).toBeNull();
  });

  it("hands the terminal WebView the alt-screen scroll input callback", () => {
    const onSendTerminalInput = vi.fn();
    const tree = renderTaskScreen({ agentType: "pty", onSendTerminalInput });
    const terminal = findByType(tree, "TerminalWebView");

    expect(terminal?.props?.onTerminalInput).toBeTypeOf("function");

    (
      terminal?.props?.onTerminalInput as (
        dataB64: string,
        kind: "control"
      ) => void
    )("G1s8NjU7MTsxTQ==", "control");
    expect(onSendTerminalInput).toHaveBeenCalledWith(
      "G1s8NjU7MTsxTQ==",
      "control"
    );
  });

  it("sends terminal-strip keys with their exact kind when available", () => {
    const onSendTerminalInput = vi.fn();
    let tree = renderTaskScreen({
      agentType: "pty",
      onSendTerminalInput,
      terminalInputUnavailableReason: null
    });

    expect(findByTestId(tree, MOBILE_E2E_IDS.taskTerminalKeyStrip)).toBeNull();
    expect(findByTestId(tree, MOBILE_E2E_IDS.taskInput)).not.toBeNull();
    pressByTestId(tree, MOBILE_E2E_IDS.taskTerminalDirectInputToggle);
    tree = renderTaskScreen({
      agentType: "pty",
      onSendTerminalInput,
      terminalInputUnavailableReason: null
    });
    expect(
      findByTestId(tree, MOBILE_E2E_IDS.taskTerminalDirectInputStatus)
    ).not.toBeNull();
    expect(findByTestId(tree, MOBILE_E2E_IDS.taskInput)).toBeNull();
    pressByTestId(tree, MOBILE_E2E_IDS.taskTerminalKey("escape"));
    pressByTestId(tree, MOBILE_E2E_IDS.taskTerminalKey("enter"));
    expect(onSendTerminalInput).toHaveBeenNthCalledWith(1, "Gw==", "draft");
    expect(onSendTerminalInput).toHaveBeenNthCalledWith(
      2,
      "DQ==",
      "submission"
    );

    pressByTestId(tree, MOBILE_E2E_IDS.taskTerminalDirectInputToggle);
    tree = renderTaskScreen({
      agentType: "pty",
      onSendTerminalInput,
      terminalInputUnavailableReason: null
    });
    expect(findByTestId(tree, MOBILE_E2E_IDS.taskTerminalKeyStrip)).toBeNull();
    expect(findByTestId(tree, MOBILE_E2E_IDS.taskInput)).not.toBeNull();
  });

  it("explains disabled PTY keys and omits the strip for SDK tasks", () => {
    let pty = renderTaskScreen({
      agentType: "pty",
      terminalInputUnavailableReason: "authentication_required"
    });
    pressByTestId(pty, MOBILE_E2E_IDS.taskTerminalDirectInputToggle);
    pty = renderTaskScreen({
      agentType: "pty",
      terminalInputUnavailableReason: "authentication_required"
    });
    expect(
      findByTestId(pty, MOBILE_E2E_IDS.taskTerminalKey("escape"))?.props
        ?.disabled
    ).toBe(true);
    expect(
      JSON.stringify(
        findByTestId(pty, MOBILE_E2E_IDS.taskTerminalKeyDisabledReason)?.props
          ?.children
      )
    ).toMatch(/pair/i);

    const sdk = renderTaskScreen({ agentType: "agent" });
    expect(
      findByTestId(sdk, MOBILE_E2E_IDS.taskTerminalDirectInputToggle)
    ).toBeNull();
    expect(findByTestId(sdk, MOBILE_E2E_IDS.taskTerminalKeyStrip)).toBeNull();
  });

  it("uses the mobile viewport geometry instead of a never-rendered PTY snapshot", () => {
    const onResizeTerminal = vi.fn();
    const tree = renderTaskScreen({ agentType: "pty", onResizeTerminal });
    const terminal = findByType(tree, "TerminalWebView");

    expect(terminal?.props).toMatchObject({
      cols: 80,
      rows: 48
    });
    expect(onResizeTerminal).toHaveBeenCalledWith(80, 48);
  });

  it("resizes xterm and the PTY from a measured tablet layout", () => {
    const onResizeTerminal = vi.fn();
    let tree = renderTaskScreen({ agentType: "pty", onResizeTerminal });

    invokeLayout(findByTestId(tree, MOBILE_E2E_IDS.taskDetailScreen), {
      height: 1366,
      width: 1024,
      x: 0,
      y: 0
    });
    tree = renderTaskScreen({ agentType: "pty", onResizeTerminal });

    expect(findByType(tree, "TerminalWebView")?.props).toMatchObject({
      cols: 128,
      rows: 72
    });
    expect(onResizeTerminal).toHaveBeenLastCalledWith(128, 72);
  });

  it("passes retained terminal stream coordinates to the terminal WebView", () => {
    const tree = renderTaskScreen({
      agentType: "pty",
      terminalOutputEpoch: 9,
      terminalOutputStart: 600_002
    });

    expect(findByType(tree, "TerminalWebView")?.props).toMatchObject({
      outputEpoch: 9,
      outputStart: 600_002
    });
  });

  it("passes normal, multiline, and keyboard-shifted composer geometry to the terminal", () => {
    let tree = renderTaskScreen({ agentType: "pty" });

    invokeLayout(findByTestId(tree, "mobile.task-detail-screen"), {
      height: 800,
      width: 390,
      x: 0,
      y: 0
    });
    invokeLayout(findByTestId(tree, "mobile.task-composer-chrome"), {
      height: 110,
      width: 362,
      x: 14,
      y: 676
    });
    tree = renderTaskScreen({ agentType: "pty" });
    expect(findByType(tree, "TerminalWebView")?.props?.bottomInset).toBe(132);

    for (const [composerTop, expectedInset] of [
      [596, 212],
      [362, 446],
      [282, 526]
    ] as const) {
      invokeLayout(findByTestId(tree, "mobile.task-composer-chrome"), {
        height: 800 - composerTop,
        width: 362,
        x: 14,
        y: composerTop
      });
      tree = renderTaskScreen({ agentType: "pty" });
      expect(findByType(tree, "TerminalWebView")?.props?.bottomInset).toBe(
        expectedInset
      );
    }
  });

  it("keeps the terminal selection toolbar clear of the measured top chrome", () => {
    let tree = renderTaskScreen({ agentType: "pty" });

    // Until the floating chrome reports a layout, the terminal still gets a
    // clearance that covers the collapsed header instead of rendering the
    // toolbar underneath it.
    expect(findByType(tree, "TerminalWebView")?.props?.selectionToolbarTop).toBe(
      getTerminalSelectionToolbarTop(null)
    );

    invokeLayout(findByTestId(tree, "mobile.task-top-chrome"), {
      height: 52,
      width: 362,
      x: 14,
      y: 16
    });
    tree = renderTaskScreen({ agentType: "pty" });
    expect(findByType(tree, "TerminalWebView")?.props?.selectionToolbarTop).toBe(
      getTerminalSelectionToolbarTop(68)
    );

    // An expanded title chip grows the chrome; the toolbar tracks its bottom.
    invokeLayout(findByTestId(tree, "mobile.task-top-chrome"), {
      height: 360,
      width: 362,
      x: 14,
      y: 16
    });
    tree = renderTaskScreen({ agentType: "pty" });
    expect(findByType(tree, "TerminalWebView")?.props?.selectionToolbarTop).toBe(
      getTerminalSelectionToolbarTop(376)
    );
  });

  it("lists terminal mentions from the + menu and previews a canonical selection", async () => {
    const history = {
      mentions: [
        { raw: "src/main.ts:42", path: "src/main.ts", line: 42 },
        { raw: "README.md", path: "README.md" }
      ],
      overflow: false
    };
    const onResolveTaskFileMentions = vi.fn().mockResolvedValue({
      mentions: [
        {
          path: "src/main.ts",
          matches: [{ path: "packages/app/src/main.ts" }],
          truncated: false
        },
        {
          path: "README.md",
          matches: [{ path: "README.md" }],
          truncated: false
        }
      ]
    });
    const onReadTaskFile = vi.fn().mockResolvedValue({
      path: "packages/app/src/main.ts",
      content: "export {}"
    });
    let tree = renderTaskScreen({
      agentType: "pty",
      onReadTaskFile,
      onResolveTaskFileMentions
    });
    const terminal = findByType(tree, "TerminalWebView");
    (terminal?.props?.onMentionedFilesChange as (value: unknown) => void)(history);

    tree = renderTaskScreen({
      agentType: "pty",
      onReadTaskFile,
      onResolveTaskFileMentions
    });
    pressByTestId(tree, "mobile.task-more-button");
    expect(componentMocks.showTaskActionMenu).toHaveBeenCalledWith(
      { mentionedFilesLabel: "Mentioned Files (2)" },
      expect.any(Function)
    );
    const onSelectAction =
      componentMocks.showTaskActionMenu.mock.calls[0]![1] as (
        action: "mentioned-files"
      ) => void;
    onSelectAction("mentioned-files");

    tree = renderTaskScreen({
      agentType: "pty",
      onReadTaskFile,
      onResolveTaskFileMentions
    });
    const mentionedFiles = findByType(tree, "TaskMentionedFiles");
    expect(mentionedFiles?.props).toMatchObject({
      history,
      autoSelectUnique: false,
      resolveMentions: onResolveTaskFileMentions
    });
    (
      mentionedFiles?.props?.onSelect as (selection: {
        path: string;
        line?: number;
      }) => void
    )({ path: "packages/app/src/main.ts", line: 42 });

    tree = renderTaskScreen({
      agentType: "pty",
      onReadTaskFile,
      onResolveTaskFileMentions
    });
    const preview = findByType(tree, "TaskFilePreview");
    expect(preview?.props).toMatchObject({
      path: "packages/app/src/main.ts",
      initialLine: 42
    });
    await expect(
      (preview?.props?.readFile as () => Promise<unknown>)()
    ).resolves.toEqual({
      path: "packages/app/src/main.ts",
      content: "export {}"
    });
    expect(onReadTaskFile).toHaveBeenCalledWith("packages/app/src/main.ts");

    (preview?.props?.onClose as () => void)();
    tree = renderTaskScreen({
      agentType: "pty",
      onReadTaskFile,
      onResolveTaskFileMentions
    });
    expect(findByType(tree, "TaskFilePreview")).toBeNull();
  });

  it("resolves a direct terminal file tap before opening its preview", () => {
    let tree = renderTaskScreen({ agentType: "pty" });
    const terminal = findByType(tree, "TerminalWebView");

    (terminal?.props?.onOpenFile as (path: string, line?: number) => void)(
      "main.ts",
      7
    );
    tree = renderTaskScreen({ agentType: "pty" });

    expect(findByType(tree, "TaskMentionedFiles")?.props).toMatchObject({
      autoSelectUnique: true,
      history: {
        mentions: [{ raw: "main.ts:7", path: "main.ts", line: 7 }],
        overflow: false
      }
    });
    expect(findByType(tree, "TaskFilePreview")).toBeNull();
  });

  it("does not reopen a file preview after switching to another task and back", () => {
    let tree = renderTaskScreen({ agentType: "pty" });
    const terminal = findByType(tree, "TerminalWebView");

    expect(terminal?.props?.onOpenFile).toBeTypeOf("function");
    (terminal?.props?.onOpenFile as (path: string, line?: number) => void)(
      "README.md"
    );

    tree = renderTaskScreen({ agentType: "pty", taskId: "task-2" });
    expect(findByType(tree, "TaskFilePreview")).toBeNull();

    tree = renderTaskScreen({ agentType: "pty" });
    expect(findByType(tree, "TaskFilePreview")).toBeNull();
  });

  it("does not reopen a file preview after switching to an SDK agent and back", () => {
    let tree = renderTaskScreen({ agentType: "pty" });
    const terminal = findByType(tree, "TerminalWebView");

    expect(terminal?.props?.onOpenFile).toBeTypeOf("function");
    (terminal?.props?.onOpenFile as (path: string, line?: number) => void)(
      "README.md"
    );

    tree = renderTaskScreen({ agentType: "agent" });
    expect(findByType(tree, "TerminalWebView")).toBeNull();
    expect(findByType(tree, "TaskFilePreview")).toBeNull();

    tree = renderTaskScreen({ agentType: "pty" });
    expect(findByType(tree, "TaskFilePreview")).toBeNull();
  });

  it("renders an E2E-only accepted snapshot marker when provided", () => {
    const marker = "cloud-only:Cloud task refreshed";
    const tree = renderTaskScreen({
      agentType: "agent",
      e2eTaskSnapshotMarker: marker
    });

    expect(findByTestId(tree, "mobile.task-snapshot-marker")?.props).toMatchObject({
      accessibilityLabel: marker
    });
  });

  it("exposes the visible task title independently from the snapshot marker", () => {
    const tree = renderTaskScreen({
      agentType: "pty",
      e2eTaskSnapshotMarker: "other-task:Task\ntask-1:Task"
    });

    expect(findByTestId(tree, "mobile.task-detail-title")?.props).toMatchObject({
      children: "Task"
    });
  });

  it("exposes selected task activity without grouping the detail controls", () => {
    const tree = renderTaskScreen({ agentType: "pty", activity: "unread" });
    const titleButton = findByTestId(tree, "mobile.task-title-button");

    expect(titleButton?.props).toMatchObject({
      accessible: true,
      accessibilityValue: { text: "unread" },
      testID: "mobile.task-title-button"
    });
  });
  it("sends a trimmed draft normally and clears the composer", () => {
    const tree = renderTaskScreen({
      agentType: "agent",
      draftInput: "  Use the smaller API.  "
    });
    const sendButton = findSendControl(tree);

    (sendButton?.props?.onPress as (() => void))();

    expect(componentMocks.onSendInput).toHaveBeenCalledWith("Use the smaller API.");
    expect(componentMocks.draftSetter).toHaveBeenCalledWith("");
  });

  it("pins the cleared native multiline input to one line after Send", () => {
    let tree = renderTaskScreen({
      agentType: "agent",
      draftInput: "First line\nSecond line\nThird line"
    });
    pressSend(tree);
    tree = renderTaskScreen({ agentType: "agent" });
    const inputAfterSend = findByTestId(tree, MOBILE_E2E_IDS.taskInput);

    expect(inputAfterSend?.props?.value).toBe("");
    expect(styleEntries(inputAfterSend)).toContainEqual({ height: 40 });
    expect(componentMocks.keyboardDismiss).toHaveBeenCalledOnce();
  });

  it("submits the latest composed multiline paste as one authoritative input", () => {
    const tree = renderTaskScreen({ agentType: "pty", draftInput: "" });
    const input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    const changeText = input?.props?.onChangeText as (value: string) => void;

    changeText("に");
    changeText("first pasted line\n日本語の composed line");
    pressSend(tree);

    expect(componentMocks.onSendInput).toHaveBeenCalledWith(
      "first pasted line\n日本語の composed line"
    );
    expect(componentMocks.onSendInput).toHaveBeenCalledTimes(1);
    expect(componentMocks.draftSetter).toHaveBeenLastCalledWith("");
  });

  it("resets a scrollable composer and dismisses its keyboard after Send", () => {
    let tree = renderTaskScreen({
      agentType: "agent",
      draftInput:
        "One long run-on sentence with no explicit newlines that has wrapped past the five-line composer cap on the native input."
    });
    let input = findByTestId(tree, "mobile.task-input");
    expect(input?.props?.onPressIn).toBe(input?.props?.onFocus);
    (input?.props?.onPressIn as () => void)();
    tree = renderTaskScreen({
      agentType: "agent",
      draftInput:
        "One long run-on sentence with no explicit newlines that has wrapped past the five-line composer cap on the native input."
    });
    input = findByTestId(tree, "mobile.task-input");
    const resizeComposer = input?.props?.onContentSizeChange as (
      event: unknown
    ) => void;

    resizeComposer({
      nativeEvent: { contentSize: { height: 142, width: 240 } }
    });
    tree = renderTaskScreen({
      agentType: "agent",
      draftInput:
        "One long run-on sentence with no explicit newlines that has wrapped past the five-line composer cap on the native input."
    });
    input = findByTestId(tree, "mobile.task-input");
    expect(
      findByTestId(tree, MOBILE_E2E_IDS.taskInputViewport)?.props?.scrollEnabled
    ).toBe(true);

    pressSend(tree);
    expect(componentMocks.onSendInput).toHaveBeenCalledOnce();
    resizeComposer({
      nativeEvent: { contentSize: { height: 142, width: 240 } }
    });
    tree = renderTaskScreen({ agentType: "agent" });

    expect(
      findByTestId(tree, MOBILE_E2E_IDS.taskInputViewport)?.props?.scrollEnabled
    ).toBe(false);
    expect(componentMocks.keyboardDismiss).toHaveBeenCalledOnce();
  });

  it("sizes the focused viewport from native layout between the one- and five-line bounds", () => {
    let tree = renderTaskScreen({ draftInput: "A composed task reply" });
    let input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    (input?.props?.onFocus as () => void)();
    tree = renderTaskScreen({ draftInput: "A composed task reply" });
    input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);

    (input?.props?.onContentSizeChange as (event: unknown) => void)({
      nativeEvent: { contentSize: { height: 80, width: 240 } }
    });
    tree = renderTaskScreen({ draftInput: "A composed task reply" });
    input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    const viewport = findByTestId(tree, MOBILE_E2E_IDS.taskInputViewport);

    expect(styleEntries(input)).toContainEqual(
      expect.objectContaining({ minHeight: 40, width: "100%" })
    );
    expect(styleEntries(input).some((style) => "height" in style)).toBe(false);
    expect(styleEntries(viewport)).toContainEqual({ height: 80 });
    expect(viewport?.props?.scrollEnabled).toBe(false);

    (input?.props?.onBlur as () => void)();
    tree = renderTaskScreen({ draftInput: "A composed task reply" });
    const collapsedViewport = findByTestId(
      tree,
      MOBILE_E2E_IDS.taskInputViewport
    );
    expect(styleEntries(collapsedViewport)).toContainEqual({ height: 40 });
    expect(collapsedViewport?.props?.scrollEnabled).toBe(true);
  });

  it("uses wrapped native content height with zero newlines to toggle internal scrolling", () => {
    const wrappedDraft =
      "This run-on sentence contains no newline characters but soft-wraps across more than five visual lines in the native task composer.";
    expect(wrappedDraft).not.toContain("\n");

    let tree = renderTaskScreen({ draftInput: wrappedDraft });
    let input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    (input?.props?.onFocus as () => void)();
    tree = renderTaskScreen({ draftInput: wrappedDraft });
    input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    (input?.props?.onContentSizeChange as (event: unknown) => void)({
      nativeEvent: { contentSize: { height: 142, width: 240 } }
    });
    tree = renderTaskScreen({ draftInput: wrappedDraft });
    input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    const viewport = findByTestId(tree, MOBILE_E2E_IDS.taskInputViewport);
    expect(viewport?.props?.scrollEnabled).toBe(true);
    expect(input?.props?.value).toBe(wrappedDraft);
    expect(styleEntries(viewport)).toContainEqual({ height: 120 });

    (input?.props?.onChangeText as (value: string) => void)(
      "Shortened soft-wrap draft"
    );
    (input?.props?.onContentSizeChange as (event: unknown) => void)({
      nativeEvent: { contentSize: { height: 80, width: 240 } }
    });
    tree = renderTaskScreen({ draftInput: "Shortened soft-wrap draft" });

    expect(
      findByTestId(tree, MOBILE_E2E_IDS.taskInputViewport)?.props?.scrollEnabled
    ).toBe(false);
  });

  it("resets native scrolling when its draft is deleted", () => {
    let tree = renderTaskScreen({ draftInput: "A long wrapped draft" });
    let input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    (input?.props?.onFocus as () => void)();
    tree = renderTaskScreen({ draftInput: "A long wrapped draft" });
    input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    (input?.props?.onContentSizeChange as (event: unknown) => void)({
      nativeEvent: { contentSize: { height: 142, width: 240 } }
    });
    tree = renderTaskScreen({ draftInput: "A long wrapped draft" });
    input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);

    (input?.props?.onChangeText as (value: string) => void)("");
    tree = renderTaskScreen();

    expect(findByTestId(tree, MOBILE_E2E_IDS.taskInput)?.props?.scrollEnabled).toBe(
      false
    );
    expect(componentMocks.onSendInput).not.toHaveBeenCalled();
    expect(componentMocks.keyboardDismiss).not.toHaveBeenCalled();
  });

  it("restores on refocus and accepts shrink measured before the text change", () => {
    const draftInput =
      "Eight lines of wrapped content remain in the draft while the keyboard is dismissed and return to their capped scrolling viewport when editing resumes.";
    let tree = renderTaskScreen({ draftInput });
    let input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);

    expect(input?.props?.onPressIn).toBe(input?.props?.onFocus);
    (input?.props?.onPressIn as () => void)();
    tree = renderTaskScreen({ draftInput });
    input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    (input?.props?.onContentSizeChange as (event: unknown) => void)({
      nativeEvent: { contentSize: { height: 180, width: 240 } }
    });
    tree = renderTaskScreen({ draftInput });
    input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    let viewport = findByTestId(tree, MOBILE_E2E_IDS.taskInputViewport);
    expect(viewport?.props?.scrollEnabled).toBe(true);
    expect(styleEntries(viewport)).toContainEqual({ height: 120 });

    (input?.props?.onBlur as () => void)();
    tree = renderTaskScreen({ draftInput });
    input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    expect(input?.props?.value).toBe(draftInput);
    viewport = findByTestId(tree, MOBILE_E2E_IDS.taskInputViewport);
    expect(viewport?.props?.scrollEnabled).toBe(true);
    expect(styleEntries(viewport)).toContainEqual({ height: 40 });

    expect(input?.props?.onPressIn).toBe(input?.props?.onFocus);
    (input?.props?.onPressIn as () => void)();
    tree = renderTaskScreen({ draftInput });
    input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    (input?.props?.onContentSizeChange as (event: unknown) => void)({
      nativeEvent: { contentSize: { height: 40, width: 240 } }
    });
    tree = renderTaskScreen({ draftInput });
    viewport = findByTestId(tree, MOBILE_E2E_IDS.taskInputViewport);
    expect(viewport?.props?.scrollEnabled).toBe(true);
    expect(styleEntries(viewport)).toContainEqual({ height: 120 });

    (input?.props?.onContentSizeChange as (event: unknown) => void)({
      nativeEvent: { contentSize: { height: 80, width: 240 } }
    });
    tree = renderTaskScreen({ draftInput });
    input = findByTestId(tree, MOBILE_E2E_IDS.taskInput);
    viewport = findByTestId(tree, MOBILE_E2E_IDS.taskInputViewport);
    expect(styleEntries(viewport)).toContainEqual({ height: 80 });
    expect(viewport?.props?.scrollEnabled).toBe(false);

    (input?.props?.onChangeText as (value: string) => void)(
      "Short refocused draft"
    );
    tree = renderTaskScreen({ draftInput: "Short refocused draft" });
    viewport = findByTestId(tree, MOBILE_E2E_IDS.taskInputViewport);
    expect(styleEntries(viewport)).toContainEqual({ height: 80 });
    expect(viewport?.props?.scrollEnabled).toBe(false);
  });

  it.each(["", "  \n\t"])(
    "does not send or clear an empty normal draft %#",
    (draftInput) => {
      const tree = renderTaskScreen({ agentType: "agent", draftInput });
      const sendButton = findSendControl(tree);

      (sendButton?.props?.onPress as (() => void))();

      expect(componentMocks.onSendInput).not.toHaveBeenCalled();
      expect(componentMocks.draftSetter).not.toHaveBeenCalled();
      expect(componentMocks.keyboardDismiss).not.toHaveBeenCalled();
    }
  );

  it.each(["agent", "pty"] as const)(
    "exposes hydrated quick replies with an empty %s draft",
    (agentType) => {
      const tree = renderTaskScreen({ agentType });
      const sendButton = findSendControl(tree);

      expect(sendButton?.props).toMatchObject({
        disabled: false,
        hydrated: true,
        replies: DEFAULT_TASK_QUICK_REPLIES
      });
    }
  );

  it("forwards the customized list and hydration state", () => {
    const customReplies = [{ id: "custom", text: "Ship it." }];
    const tree = renderTaskScreen({
      quickReplies: customReplies,
      quickRepliesHydrated: false
    });

    expect(findSendControl(tree)?.props).toMatchObject({
      hydrated: false,
      replies: customReplies
    });
  });

  it("sends the selected quick reply plus the current draft and clears it", () => {
    const tree = renderTaskScreen({
      agentType: "agent",
      draftInput: "  Also add regression tests.  "
    });
    const sendButton = findSendControl(tree);
    (sendButton?.props?.onSelectReply as (replyId: string) => void)(
      "sgtm-proceed"
    );

    expect(componentMocks.onSendInput).toHaveBeenCalledWith(
      "SGTM. Proceed.\n\nAlso add regression tests."
    );
    expect(componentMocks.draftSetter).toHaveBeenCalledWith("");
    expect(componentMocks.keyboardDismiss).toHaveBeenCalledOnce();
  });

  it("uses the current draft when a pending quick reply is selected", () => {
    const tree = renderTaskScreen({
      agentType: "agent",
      draftInput: "Initial detail."
    });
    const sendButton = findSendControl(tree);
    const input = findByTestId(tree, "mobile.task-input");

    (input?.props?.onChangeText as ((value: string) => void))("Latest detail.");
    (sendButton?.props?.onSelectReply as (replyId: string) => void)(
      "sgtm-proceed"
    );

    expect(componentMocks.onSendInput).toHaveBeenCalledWith(
      "SGTM. Proceed.\n\nLatest detail."
    );
    expect(componentMocks.draftSetter).toHaveBeenLastCalledWith("");
  });

  it("ignores a reply id that is no longer configured", () => {
    const tree = renderTaskScreen({
      draftInput: "Keep this draft.",
      quickReplies: [{ id: "configured", text: "Proceed." }]
    });

    (findSendControl(tree)?.props?.onSelectReply as (replyId: string) => void)(
      "missing"
    );

    expect(componentMocks.onSendInput).not.toHaveBeenCalled();
    expect(componentMocks.draftSetter).not.toHaveBeenCalled();
  });

  it("ignores a pending quick reply after the composer becomes unavailable", () => {
    const tree = renderTaskScreen({
      agentType: "agent",
      draftInput: "Keep this draft."
    });
    const sendButton = findSendControl(tree);
    const onSelect = sendButton?.props?.onSelectReply as (
      replyId: string
    ) => void;

    renderTaskScreen({
      agentType: "agent",
      agentStatus: "error",
      draftInput: "Keep this draft."
    });
    onSelect("sgtm-proceed");

    expect(componentMocks.onSendInput).not.toHaveBeenCalled();
    expect(componentMocks.draftSetter).not.toHaveBeenCalled();
  });

  it("ignores a pending quick reply after the selected task changes", () => {
    const tree = renderTaskScreen({
      agentType: "agent",
      draftInput: "Task one detail.",
      taskId: "task-1"
    });
    const sendButton = findSendControl(tree);
    const onSelect = sendButton?.props?.onSelectReply as (
      replyId: string
    ) => void;

    renderTaskScreen({ agentType: "agent", taskId: "task-2" });
    onSelect("sgtm-proceed");

    expect(componentMocks.onSendInput).not.toHaveBeenCalled();
    expect(componentMocks.draftSetter).not.toHaveBeenCalled();
  });

  it.each([
    ["agent connecting", { agentType: "agent", agentStatus: "connecting" }],
    ["agent error", { agentType: "agent", agentStatus: "error" }],
    ["PTY connecting", { agentType: "pty", terminalStatus: "connecting" }],
    ["PTY idle", { agentType: "pty", terminalStatus: "idle" }],
    ["PTY error", { agentType: "pty", terminalStatus: "error" }],
    ["PTY closed", { agentType: "pty", terminalStatus: "closed" }]
  ] as const)(
    "disables ordinary and shortcut sends while %s",
    (_caseName, options) => {
      const tree = renderTaskScreen(options);
      const sendButton = findSendControl(tree);

      expect(sendButton?.props).toMatchObject({
        disabled: true
      });
      (sendButton?.props?.onPress as (() => void))();
      (sendButton?.props?.onSelectReply as (replyId: string) => void)(
        "sgtm-proceed"
      );

      expect(componentMocks.onSendInput).not.toHaveBeenCalled();
    }
  );
  it("starts with the renamed display title collapsed and accessible", () => {
    const title = "Short renamed task";
    const tree = renderTaskScreen({
      activity: "unread",
      title,
      prompt: "Canonical prompt that differs from the title"
    });
    const titleButton = findByTestId(tree, "mobile.task-title-button");
    const titleText = findByTestId(tree, "mobile.task-detail-title");

    expect(titleButton?.props).toMatchObject({
      accessibilityHint: "Expand title",
      accessibilityLabel: `in progress: ${title}. Task ID: task-1`,
      accessibilityRole: "button",
      accessibilityState: { expanded: false },
      accessibilityValue: { text: "unread" }
    });
    expect(titleText?.props).toMatchObject({
      accessible: false,
      children: title,
      numberOfLines: 1,
      testID: "mobile.task-detail-title"
    });
    expect(findByTestId(tree, "mobile.task-title-dismiss-layer")).toBeNull();
  });

  it("expands to the bounded scrollable canonical prompt through its end", () => {
    const title = "Short renamed task";
    const prompt = `${"Detailed canonical prompt line.\n".repeat(80)}PROMPT_END_SENTINEL`;
    let tree = renderTaskScreen({ title, prompt });

    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen({ title, prompt });

    expect(findByTestId(tree, "mobile.task-title-button")?.props).toMatchObject({
      accessibilityHint: "Collapse title",
      accessibilityLabel: `in progress: ${prompt}. Task ID: task-1`,
      accessibilityState: { expanded: true }
    });
    expect(findByTestId(tree, "mobile.task-detail-title")).toBeNull();
    expect(findByTestId(tree, "mobile.task-expanded-prompt")?.props).toMatchObject({
      accessible: false,
      children: prompt
    });
    const promptScroll = findByType(tree, "ScrollView");
    expect(promptScroll?.props).toMatchObject({
      accessible: false,
      nestedScrollEnabled: true
    });
    expect(styleEntries(promptScroll)).toContainEqual({ maxHeight: 320 });
    expect(
      findPathByTestId(
        promptScroll,
        MOBILE_E2E_IDS.taskExpandedTaskId
      )
    ).toBeNull();
    expect(findByTestId(tree, MOBILE_E2E_IDS.taskExpandedTaskId)?.props).toMatchObject({
      children: "task-1",
      testID: MOBILE_E2E_IDS.taskExpandedTaskId
    });
    const titleDismissLayer = findByTestId(
      tree,
      "mobile.task-title-dismiss-layer"
    );
    expect(titleDismissLayer?.props.accessible).toBe(false);
    expect(styleEntries(titleDismissLayer)).toContainEqual({
      backgroundColor: "transparent",
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
      zIndex: 4
    });
    expect(styleEntries(titleDismissLayer)).toContainEqual({ top: 64 });
  });

  it("keeps the collapsed header's task ID complete when the title truncates", () => {
    const taskId = "a6ea6b03";
    const title = `Long ${"mobile task title ".repeat(12)}end`;
    const tree = renderTaskScreen({ taskId, title });

    const titleText = findByTestId(tree, "mobile.task-detail-title");
    const idText = findByTestId(tree, "mobile.task-detail-task-id");
    // The title is the one that gives — one line, tail-ellipsized — while the
    // id renders beside it as its own element and stays whole.
    expect(titleText?.props?.numberOfLines).toBe(1);
    expect(String(titleText?.props?.children)).not.toContain(taskId);
    expect(idText?.props).toMatchObject({
      accessible: false,
      children: taskId
    });
    expect(idText?.props?.numberOfLines).toBeUndefined();
    expect(styleEntries(idText)).toContainEqual(
      expect.objectContaining({ flexShrink: 0 })
    );
    // VoiceOver reads the whole title; only the visible line truncates.
    expect(findByTestId(tree, "mobile.task-title-button")?.props).toMatchObject({
      accessibilityLabel: `in progress: ${title}. Task ID: ${taskId}`
    });
  });

  it("shows no task ID for a task that is still being created", () => {
    const tree = renderTaskScreen({
      taskId: "create:slot-1",
      taskCreationPhase: "pending"
    });

    expect(findByTestId(tree, "mobile.task-detail-task-id")).toBeNull();
    expect(
      findByTestId(tree, "mobile.task-title-button")?.props?.accessibilityLabel
    ).not.toContain("Task ID");
  });

  it("shows an owner-local ID while a recovered task is still settling", () => {
    const tree = renderTaskScreen({
      taskId: "create:slot-1",
      ownerLocalTaskId: "019f6c9d6ed40000000120e4307b4591",
      taskCreationPhase: "recovering"
    });

    expect(findByTestId(tree, "mobile.task-detail-task-id")?.props).toMatchObject({
      children: "019f6c9d6ed40000000120e4307b4591"
    });
  });

  it("keeps the complete task ID in the collapsed header and the expanded panel", () => {
    const taskId = "019f6c9d6ed40000000120e4307b4591";
    const prompt = "Canonical full prompt";
    let tree = renderTaskScreen({ taskId, prompt });

    // Collapsed: no identity panel, but the id itself survives beside the
    // one-line title as its own element.
    expect(findByTypeAndText(tree, "Text", "Task ID")).toBeNull();
    expect(findByTypeAndText(tree, "Text", taskId)?.props).toMatchObject({
      accessible: false,
      children: taskId,
      testID: "mobile.task-detail-task-id"
    });

    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen({ taskId, prompt });

    expect(findByTypeAndText(tree, "Text", "Task ID")).not.toBeNull();
    expect(findByTypeAndText(tree, "Text", taskId)?.props).toMatchObject({
      accessible: false,
      children: taskId,
      testID: "mobile.task-expanded-task-id"
    });
    expect(findByTestId(tree, "mobile.task-title-button")?.props).toMatchObject({
      accessibilityLabel: `in progress: ${prompt}. Task ID: ${taskId}`,
      accessibilityState: { expanded: true }
    });
  });

  it("shows the desktop-local task ID for cloud-sourced tasks", () => {
    const localTaskId = "019f6c9d6ed40000000120e4307b4591";
    const taskId = `cloud:desktop-1:repo-1:${localTaskId}`;
    const prompt = "Canonical full prompt";
    let tree = renderTaskScreen({
      taskId,
      ownerLocalTaskId: localTaskId,
      prompt
    });

    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen({
      taskId,
      ownerLocalTaskId: localTaskId,
      prompt
    });

    expect(findByTypeAndText(tree, "Text", taskId)).toBeNull();
    expect(findByTypeAndText(tree, "Text", localTaskId)?.props).toMatchObject({
      accessible: false,
      children: localTaskId,
      testID: "mobile.task-expanded-task-id"
    });
    expect(findByTestId(tree, "mobile.task-title-button")?.props).toMatchObject({
      accessibilityLabel: `in progress: ${prompt}. Task ID: ${localTaskId}`,
      accessibilityState: { expanded: true }
    });
  });

  it("makes the expanded prompt and task ID selectable", () => {
    const taskId = "task-selectable";
    const prompt = "Select all or part of this prompt";
    let tree = renderTaskScreen({ taskId, prompt });

    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen({ taskId, prompt });

    expect(findByTestId(tree, "mobile.task-expanded-prompt")?.props).toMatchObject({
      accessible: false,
      selectable: true
    });
    expect(findByTypeAndText(tree, "Text", taskId)?.props).toMatchObject({
      accessible: false,
      selectable: true
    });
  });

  it("registers a long-press handler while expanded to preserve text selection", () => {
    let tree = renderTaskScreen();

    expect(
      findByTestId(tree, "mobile.task-title-button")?.props?.onLongPress
    ).toBeUndefined();

    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen();

    const titleButton = findByTestId(tree, "mobile.task-title-button");
    expect(titleButton?.props?.onLongPress).toBeTypeOf("function");

    (titleButton?.props?.onLongPress as () => void)();
    tree = renderTaskScreen();
    expect(findByTestId(tree, "mobile.task-expanded-prompt")).not.toBeNull();
  });

  it("uses one accessible title-prompt toggle while keeping Back above the dismissal layer", () => {
    const prompt = `${"p".repeat(520)}PROMPT_END_SENTINEL`;
    let tree = renderTaskScreen({
      activity: "working",
      prompt
    });
    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen({ activity: "working", prompt });

    const titleButton = findByTestId(tree, "mobile.task-title-button");
    const dismissalLayer = findByTestId(
      tree,
      "mobile.task-title-dismiss-layer"
    );
    const promptText = findByTestId(tree, "mobile.task-expanded-prompt");
    const topChrome = findCommonAncestor(
      tree,
      "mobile.task-back-button",
      "mobile.task-title-button"
    );
    const bottomChrome = findCommonAncestor(
      tree,
      "mobile.task-more-button",
      "mobile.task-input"
    );

    expect(findByTestId(titleButton?.props?.children, "mobile.task-expanded-prompt")).not.toBeNull();
    expect.soft(topChrome?.props?.pointerEvents).toBe("box-none");
    expect.soft(dismissalLayer?.props?.focusable).toBe(false);
    expect(titleButton?.type).toBe("Pressable");
    expect(titleButton?.props?.disabled).not.toBe(true);
    expect(titleButton?.props).toMatchObject({
      accessible: true,
      accessibilityValue: { text: "working" }
    });
    expect(dismissalLayer?.type).toBe("Pressable");
    expect(dismissalLayer?.props?.disabled).not.toBe(true);
    expect(promptText?.type).toBe("Text");
    expect(promptText?.props).toMatchObject({
      accessible: false,
      children: prompt,
      testID: "mobile.task-expanded-prompt"
    });
    expect(findByTypeAndText(tree, "Text", "in progress")).not.toBeNull();
    expect(styleEntries(topChrome)).toContainEqual(
      expect.objectContaining({
        alignItems: "flex-start",
        elevation: 6,
        zIndex: 5
      })
    );
    expect(styleEntries(dismissalLayer)).toContainEqual(
      expect.objectContaining({ zIndex: 4 })
    );
    expect(styleEntries(dismissalLayer)).toContainEqual({ top: 64 });
    expect(styleEntries(bottomChrome)).toContainEqual(
      expect.objectContaining({ zIndex: 3 })
    );
  });

  it("keeps a same-task rename expanded and continues to show the canonical prompt", () => {
    const taskId = "task-renamed";
    const prompt = "Canonical full prompt\nPROMPT_END_SENTINEL";
    let tree = renderTaskScreen({ taskId, title: "Original title", prompt });

    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen({
      taskId,
      title: "Current renamed title",
      prompt
    });
    tree = renderTaskScreen({
      taskId,
      title: "Current renamed title",
      prompt
    });

    expect(findByTestId(tree, "mobile.task-title-button")?.props).toMatchObject({
      accessibilityLabel:
        `in progress: ${prompt}. Task ID: ${taskId}`,
      accessibilityState: { expanded: true }
    });
    expect(findByTestId(tree, "mobile.task-expanded-prompt")?.props).toMatchObject({
      children: prompt
    });
  });

  it("collapses the expanded title when the title is pressed again", () => {
    let tree = renderTaskScreen();
    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen();

    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen();

    expect(findByTestId(tree, "mobile.task-title-button")?.props).toMatchObject({
      accessibilityHint: "Expand title",
      accessibilityState: { expanded: false }
    });
    expect(findByTestId(tree, "mobile.task-detail-title")?.props?.numberOfLines).toBe(
      1
    );
    expect(findByTestId(tree, "mobile.task-title-dismiss-layer")).toBeNull();
  });

  it("falls back to the display title when an older task has no prompt", () => {
    let tree = renderTaskScreen({ title: "Legacy task title" });
    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen({ title: "Legacy task title" });

    expect(findByTestId(tree, "mobile.task-expanded-prompt")?.props).toMatchObject({
      children: "Legacy task title"
    });
  });

  it("preserves canonical prompt whitespace while treating whitespace-only prompts as absent", () => {
    const prompt = "  Indented first line\nPROMPT_END_SENTINEL\n";
    let tree = renderTaskScreen({ title: "Renamed", prompt });
    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen({ title: "Renamed", prompt });
    expect(findByTestId(tree, "mobile.task-expanded-prompt")?.props).toMatchObject({
      children: prompt
    });

    hookHarness.stateValues = [];
    tree = renderTaskScreen({ title: "Whitespace fallback", prompt: " \n\t " });
    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen({ title: "Whitespace fallback", prompt: " \n\t " });
    expect(findByTestId(tree, "mobile.task-expanded-prompt")?.props).toMatchObject({
      children: "Whitespace fallback"
    });
  });

  it("collapses the expanded title on the first outside press", () => {
    let tree = renderTaskScreen();
    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen();

    pressByTestId(tree, "mobile.task-title-dismiss-layer");
    tree = renderTaskScreen();

    expect(findByTestId(tree, "mobile.task-title-button")?.props).toMatchObject({
      accessibilityState: { expanded: false }
    });
    expect(findByTestId(tree, "mobile.task-title-dismiss-layer")).toBeNull();
  });

  it("clears expansion when switching tasks so it cannot reappear on return", () => {
    const title = "Shared task title";
    let tree = renderTaskScreen({ taskId: "task-a", title });
    pressByTestId(tree, "mobile.task-title-button");
    tree = renderTaskScreen({ taskId: "task-a", title });

    expect(findByTestId(tree, "mobile.task-title-button")?.props).toMatchObject({
      accessibilityState: { expanded: true }
    });

    tree = renderTaskScreen({ taskId: "task-b", title });
    expect(findByTestId(tree, "mobile.task-title-button")?.props).toMatchObject({
      accessibilityLabel: `in progress: ${title}. Task ID: task-b`,
      accessibilityState: { expanded: false }
    });
    expect(findByTestId(tree, "mobile.task-title-dismiss-layer")).toBeNull();

    tree = renderTaskScreen({ taskId: "task-a", title });
    expect(findByTestId(tree, "mobile.task-title-button")?.props).toMatchObject({
      accessibilityState: { expanded: false }
    });
    expect(findByTestId(tree, "mobile.task-title-dismiss-layer")).toBeNull();
  });
});
