import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();

  return {
    ...actual,
    useEffect: vi.fn(),
    useState: <T,>(initialValue: T) => [initialValue, vi.fn()] as const
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
  }
): ElementNode {
  if (!TaskScreen) {
    throw new Error("TaskScreen was not loaded");
  }

  return TaskScreen({
    task: {
      id: "task-1",
      repoId: "repo-1",
      title: "Task",
      stage: "in progress",
      agentType
    },
    terminalOutput: "terminal",
    terminalStatus: "live",
    terminalCols: terminalDims.cols,
    terminalRows: terminalDims.rows,
    terminalErrorMessage: null,
    agentEvents: [{ seq: 0, event: { type: "user_message", text: "hello" } }],
    agentStatus: "live",
    agentErrorMessage: null,
    onBack: vi.fn(),
    onOpenMore: vi.fn(),
    onSendInput: vi.fn(),
    onStopAgent: vi.fn(),
    onResolveAgentPermission: vi.fn()
  }) as ElementNode;
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
});
