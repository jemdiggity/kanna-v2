import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const states: unknown[] = [];
let stateHookIndex = 0;

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();

  return {
    ...actual,
    useEffect: vi.fn(),
    useState: vi.fn((initialValue: unknown) => {
      const index = stateHookIndex;
      stateHookIndex += 1;
      if (!(index in states)) {
        states[index] = initialValue;
      }
      return [states[index], (value: unknown) => {
        states[index] =
          typeof value === "function"
            ? (value as (previous: unknown) => unknown)(states[index])
            : value;
      }];
    })
  };
});

vi.mock("react-native", () => ({
  Keyboard: {
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    dismiss: vi.fn()
  },
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  TextInput: "TextInput",
  View: "View"
}));

vi.mock("./AgentMessageView", () => ({
  AgentMessageView: "AgentMessageView"
}));

vi.mock("./TerminalWebView", () => ({
  TerminalWebView: "TerminalWebView"
}));

let TaskScreen: typeof import("./TaskScreen").TaskScreen | null = null;

beforeAll(async () => {
  TaskScreen = (await import("./TaskScreen")).TaskScreen;
});

beforeEach(() => {
  states.length = 0;
  stateHookIndex = 0;
});

interface ElementNode {
  type: unknown;
  props?: {
    children?: ElementNode | ElementNode[] | string | null;
    testID?: string;
    [key: string]: unknown;
  };
}

function renderTaskScreen(
  agentType: "agent" | "pty",
  terminalDims: { cols: number | null; rows: number | null } = {
    cols: null,
    rows: null
  },
  e2eTaskSnapshotMarker?: string,
  activity: "idle" | "working" | "unread" = "idle"
): ElementNode {
  if (!TaskScreen) {
    throw new Error("TaskScreen was not loaded");
  }

  stateHookIndex = 0;
  return TaskScreen({
    task: {
      id: "task-1",
      repoId: "repo-1",
      title: "Task",
      stage: "in progress",
      agentType,
      activity
    },
    terminalOutput: "terminal",
    terminalStatus: "live",
    terminalCols: terminalDims.cols,
    terminalRows: terminalDims.rows,
    terminalErrorMessage: null,
    agentEvents: [{ seq: 0, event: { type: "user_message", text: "hello" } }],
    agentStatus: "live",
    agentErrorMessage: null,
    e2eTaskSnapshotMarker,
    onBack: vi.fn(),
    onOpenMore: vi.fn(),
    onSendInput: vi.fn(),
    onStopAgent: vi.fn(),
    onResolveAgentPermission: vi.fn()
  }) as ElementNode;
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

describe("TaskScreen", () => {
  it("routes agent tasks to the native agent message view", () => {
    const tree = renderTaskScreen("agent");

    expect(findByType(tree, "AgentMessageView")).not.toBeNull();
    expect(findByType(tree, "TerminalWebView")).toBeNull();
  });

  it("keeps PTY tasks on the terminal WebView", () => {
    const tree = renderTaskScreen("pty");

    expect(findByType(tree, "TerminalWebView")).not.toBeNull();
    expect(findByType(tree, "AgentMessageView")).toBeNull();
  });

  it("passes desktop PTY dimensions to the terminal WebView", () => {
    const tree = renderTaskScreen("pty", { cols: 132, rows: 43 });
    const terminal = findByType(tree, "TerminalWebView");

    expect(terminal?.props).toMatchObject({
      cols: 132,
      rows: 43
    });
  });

  it("passes normal, multiline, and keyboard-shifted composer geometry to the terminal", () => {
    let tree = renderTaskScreen("pty");

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
    tree = renderTaskScreen("pty");
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
      tree = renderTaskScreen("pty");
      expect(findByType(tree, "TerminalWebView")?.props?.bottomInset).toBe(
        expectedInset
      );
    }
  });

  it("renders an E2E-only accepted snapshot marker when provided", () => {
    const marker = "cloud-only:Cloud task refreshed";
    const tree = renderTaskScreen("agent", undefined, marker);

    expect(findByTestId(tree, "mobile.task-snapshot-marker")?.props).toMatchObject({
      accessibilityLabel: marker
    });
  });

  it("exposes the visible task title independently from the snapshot marker", () => {
    const tree = renderTaskScreen(
      "pty",
      undefined,
      "other-task:Task\ntask-1:Task"
    );

    expect(findByTestId(tree, "mobile.task-detail-title")?.props).toMatchObject({
      children: "Task"
    });
  });

  it("exposes selected task activity without grouping the detail controls", () => {
    const tree = renderTaskScreen("pty", undefined, undefined, "unread");
    const title = findByTestId(tree, "mobile.task-detail-title");

    expect(title?.props).toMatchObject({
      accessibilityValue: { text: "unread" },
      children: "Task",
      testID: "mobile.task-detail-title"
    });
  });
});
