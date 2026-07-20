import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TaskCreationPhase,
  TaskTerminalStatus
} from "../state/sessionStore";
import {
  DEFAULT_TASK_QUICK_REPLIES,
  type TaskQuickReply
} from "./taskQuickReplies";

const hookHarness = vi.hoisted(() => ({
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
  onAdvanceTaskStage: vi.fn(),
  onCloseTask: vi.fn(),
  onSendInput: vi.fn(),
  showTaskActionMenu: vi.fn()
}));

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();

  return {
    ...actual,
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

vi.mock("./AgentMessageView", () => ({
  AgentMessageView: "AgentMessageView"
}));

vi.mock("../components/LoadingText", () => ({
  LoadingText: "LoadingText"
}));

vi.mock("./TerminalWebView", () => ({
  TerminalWebView: "TerminalWebView"
}));

vi.mock("./TaskFilePreview", () => ({
  TaskFilePreview: "TaskFilePreview"
}));

vi.mock("./VisualCompanionModal", () => ({
  VisualCompanionModal: "VisualCompanionModal"
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
  hookHarness.effectDependencies = [];
  hookHarness.effectCleanups = [];
  hookHarness.effectIndex = 0;
  hookHarness.hookIndex = 0;
  hookHarness.refIndex = 0;
  hookHarness.refs.length = 0;
  hookHarness.stateValues.length = 0;
  componentMocks.draftSetter.mockReset();
  componentMocks.keyboardDismiss.mockReset();
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
  terminalDims?: { cols: number | null; rows: number | null };
  terminalOutputEpoch?: number;
  terminalOutputStart?: number;
  e2eTaskSnapshotMarker?: string;
  activity?: "idle" | "working" | "unread";
  draftInput?: string;
  terminalStatus?: TaskTerminalStatus;
  taskCreationPhase?: TaskCreationPhase;
  taskCreationErrorMessage?: string | null;
  onRecoverTaskCreation?: () => void;
  agentStatus?: TaskTerminalStatus;
  onReadTaskFile?: (path: string) => Promise<{ path: string; content: string }>;
  taskId?: string;
  title?: string;
  prompt?: string;
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
}

function renderTaskScreen(options: RenderTaskScreenOptions = {}): ElementNode {
  if (!TaskScreen) {
    throw new Error("TaskScreen was not loaded");
  }

  const {
    agentType = "pty",
    terminalDims = { cols: null, rows: null },
    terminalOutputEpoch = 1,
    terminalOutputStart = 0,
    e2eTaskSnapshotMarker,
    activity = "idle",
    draftInput = "",
    terminalStatus = "live",
    taskCreationPhase = "idle",
    taskCreationErrorMessage = null,
    onRecoverTaskCreation = vi.fn(),
    agentStatus = "live",
    onReadTaskFile = vi.fn().mockResolvedValue({
      path: "docs/spec.md",
      content: "# Spec"
    }),
    taskId = "task-1",
    title = "Task",
    prompt,
    quickReplies = DEFAULT_TASK_QUICK_REPLIES,
    quickRepliesHydrated = true,
    companionStatus = "idle",
    companionSnapshot = null,
    companionUnread = false,
    companionErrorMessage = null,
    companionEventStatus = "idle",
    onCompanionOpenChange = vi.fn(),
    onSendCompanionEvent = vi.fn()
  } = options;

  hookHarness.effectIndex = 0;
  hookHarness.hookIndex = 0;
  hookHarness.refIndex = 0;
  hookHarness.stateValues[0] = draftInput;
  return TaskScreen({
    task: {
      id: taskId,
      repoId: "repo-1",
      title,
      prompt,
      stage: "in progress",
      agentType,
      activity
    },
    terminalOutput: "terminal",
    terminalOutputEpoch,
    terminalOutputStart,
    terminalStatus,
    terminalCols: terminalDims.cols,
    terminalRows: terminalDims.rows,
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
    e2eTaskSnapshotMarker,
    onBack: vi.fn(),
    onAdvanceTaskStage: componentMocks.onAdvanceTaskStage,
    onCloseTask: componentMocks.onCloseTask,
    onSendInput: componentMocks.onSendInput,
    onStopAgent: vi.fn(),
    onResolveAgentPermission: vi.fn(),
    onRecoverTaskCreation,
    onReadTaskFile,
    onCompanionOpenChange,
    onSendCompanionEvent
  }) as ElementNode;
}

function unmountTaskScreen(): void {
  for (const cleanup of hookHarness.effectCleanups.splice(0)) {
    cleanup?.();
  }
}

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
    }
  );

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

  it.each([
    ["advance-stage", componentMocks.onAdvanceTaskStage],
    ["close-task", componentMocks.onCloseTask]
  ] as const)("routes the %s task action", (action, expectedCallback) => {
    const tree = renderTaskScreen({ agentType: "agent" });
    pressByTestId(tree, "mobile.task-more-button");
    const onSelect = componentMocks.showTaskActionMenu.mock.calls[0]![0] as (
      selectedAction: "advance-stage" | "close-task"
    ) => void;

    onSelect(action);

    expect(expectedCallback).toHaveBeenCalledOnce();
  });

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
        accessibilityLabel: "Visual companion ready",
        accessibilityRole: "button"
      });
    expect(findByTestId(tree, "mobile.visual-companion.unread")).not.toBeNull();
    expect(findByType(tree, "VisualCompanionModal")).toBeNull();

    pressByTestId(tree, "mobile.visual-companion.button");
    tree = renderTaskScreen({
      companionStatus: "available",
      companionSnapshot,
      companionUnread: false,
      onCompanionOpenChange
    });

    expect(onCompanionOpenChange).toHaveBeenCalledWith(true);
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

  it("passes desktop PTY dimensions to the terminal WebView", () => {
    const tree = renderTaskScreen({
      agentType: "pty",
      terminalDims: { cols: 132, rows: 43 }
    });
    const terminal = findByType(tree, "TerminalWebView");

    expect(terminal?.props).toMatchObject({
      cols: 132,
      rows: 43
    });
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

  it("opens terminal file links in a task preview and closes it", async () => {
    const onReadTaskFile = vi.fn().mockResolvedValue({
      path: "docs/spec.md",
      content: "# Spec"
    });
    let tree = renderTaskScreen({ agentType: "pty", onReadTaskFile });
    const terminal = findByType(tree, "TerminalWebView");

    expect(terminal?.props?.onOpenFile).toBeTypeOf("function");
    (terminal?.props?.onOpenFile as (path: string, line?: number) => void)(
      "docs/spec.md",
      42
    );

    tree = renderTaskScreen({ agentType: "pty", onReadTaskFile });
    const preview = findByType(tree, "TaskFilePreview");
    expect(preview?.props).toMatchObject({
      path: "docs/spec.md",
      initialLine: 42
    });
    await expect(
      (preview?.props?.readFile as () => Promise<unknown>)()
    ).resolves.toEqual({
      path: "docs/spec.md",
      content: "# Spec"
    });
    expect(onReadTaskFile).toHaveBeenCalledWith("docs/spec.md");

    (preview?.props?.onClose as () => void)();
    tree = renderTaskScreen({ agentType: "pty", onReadTaskFile });
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

  it("shrinks an expanded composer and dismisses its keyboard after Send", () => {
    let tree = renderTaskScreen({
      agentType: "agent",
      draftInput: "First line.\nSecond line."
    });
    let input = findByTestId(tree, "mobile.task-input");
    const resizeComposer = input?.props?.onContentSizeChange as (
      event: unknown
    ) => void;

    resizeComposer({
      nativeEvent: { contentSize: { height: 82, width: 240 } }
    });
    tree = renderTaskScreen({
      agentType: "agent",
      draftInput: "First line.\nSecond line."
    });
    input = findByTestId(tree, "mobile.task-input");
    expect(styleEntries(input)).toContainEqual({ height: 82 });

    pressSend(tree);
    resizeComposer({
      nativeEvent: { contentSize: { height: 82, width: 240 } }
    });
    tree = renderTaskScreen({ agentType: "agent" });

    expect(styleEntries(findByTestId(tree, "mobile.task-input"))).toContainEqual({
      height: 40
    });
    expect(componentMocks.keyboardDismiss).toHaveBeenCalledOnce();
  });

  it("shrinks an expanded composer when its draft is deleted", () => {
    let tree = renderTaskScreen({ draftInput: "First line.\nSecond line." });
    let input = findByTestId(tree, "mobile.task-input");
    (input?.props?.onContentSizeChange as (event: unknown) => void)({
      nativeEvent: { contentSize: { height: 82, width: 240 } }
    });
    tree = renderTaskScreen({ draftInput: "First line.\nSecond line." });
    input = findByTestId(tree, "mobile.task-input");

    (input?.props?.onChangeText as (value: string) => void)("");
    tree = renderTaskScreen();

    expect(styleEntries(findByTestId(tree, "mobile.task-input"))).toContainEqual({
      height: 40
    });
    expect(componentMocks.onSendInput).not.toHaveBeenCalled();
    expect(componentMocks.keyboardDismiss).not.toHaveBeenCalled();
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
      accessibilityLabel: `in progress: ${title}`,
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
    expect(findByTestId(tree, "mobile.task-title-dismiss-layer")?.props).toMatchObject({
      accessible: false,
      style: {
        bottom: 0,
        left: 0,
        position: "absolute",
        right: 0,
        top: 0,
        zIndex: 4
      }
    });
  });

  it("shows the complete task ID only in the expanded identity panel", () => {
    const taskId = "019f6c9d6ed40000000120e4307b4591";
    const prompt = "Canonical full prompt";
    let tree = renderTaskScreen({ taskId, prompt });

    expect(findByTypeAndText(tree, "Text", "Task ID")).toBeNull();
    expect(findByTypeAndText(tree, "Text", taskId)).toBeNull();

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
      expect.objectContaining({ alignItems: "flex-start", zIndex: 5 })
    );
    expect(styleEntries(dismissalLayer)).toContainEqual(
      expect.objectContaining({ zIndex: 4 })
    );
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
      accessibilityLabel: `in progress: ${title}`,
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
