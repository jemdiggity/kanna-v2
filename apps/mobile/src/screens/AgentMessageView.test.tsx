import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FrameAgentEvent } from "@kanna/agent-protocol";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskTerminalStatus } from "../state/sessionStore";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

vi.mock("../components/LoadingText", () => ({
  LoadingText: "LoadingText"
}));

// The exported AgentMessageView is memoized; this harness drives the component
// implementation directly.
let AgentMessageView:
  | typeof import("./AgentMessageView").AgentMessageViewComponent
  | null = null;

beforeAll(async () => {
  AgentMessageView = (await import("./AgentMessageView")).AgentMessageViewComponent;
});

interface ElementNode {
  type: unknown;
  props?: {
    children?: ElementNode | ElementNode[] | string | number | null;
    testID?: string;
    [key: string]: unknown;
  };
}

function renderAgentView(
  events: FrameAgentEvent[],
  status: TaskTerminalStatus = "live",
  onRequestHistory: () => void = vi.fn()
): ElementNode {
  if (!AgentMessageView) {
    throw new Error("AgentMessageView was not loaded");
  }

  return AgentMessageView({
    errorMessage: null,
    events,
    status,
    onInterrupt: vi.fn(),
    onRequestHistory,
    onResolvePermission: vi.fn()
  }) as ElementNode;
}

function collectText(node: ElementNode | ElementNode[] | string | number | null | undefined): string {
  if (node === null || node === undefined) {
    return "";
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join(" ");
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  const children = node.props?.children;
  const childList = Array.isArray(children) ? children : [children];
  return childList.map(collectText).join(" ");
}

function findByTestId(node: ElementNode, testID: string): ElementNode | null {
  if (node.props?.testID === testID) {
    return node;
  }

  const children = node.props?.children;
  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    if (child && typeof child === "object") {
      const match = findByTestId(child as ElementNode, testID);
      if (match) {
        return match;
      }
    }
  }

  return null;
}

function findByType(node: ElementNode, type: unknown): ElementNode | null {
  if (node.type === type) return node;

  const children = node.props?.children;
  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    if (child && typeof child === "object") {
      const match = findByType(child as ElementNode, type);
      if (match) return match;
    }
  }

  return null;
}

function findByAccessibilityLabel(
  node: ElementNode | ElementNode[],
  accessibilityLabel: string
): ElementNode | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findByAccessibilityLabel(child, accessibilityLabel);
      if (match) return match;
    }
    return null;
  }
  if (node.props?.accessibilityLabel === accessibilityLabel) return node;

  const children = node.props?.children;
  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    if (child && typeof child === "object") {
      const match = findByAccessibilityLabel(
        child as ElementNode | ElementNode[],
        accessibilityLabel
      );
      if (match) return match;
    }
  }

  return null;
}

describe("AgentMessageView", () => {
  it("requests older agent history when the reader reaches the loaded top", () => {
    const onRequestHistory = vi.fn();
    const tree = renderAgentView([], "live", onRequestHistory);
    const onScroll = findByType(tree, "ScrollView")?.props?.onScroll as
      | ((event: { nativeEvent: { contentOffset: { y: number } } }) => void)
      | undefined;

    onScroll?.({ nativeEvent: { contentOffset: { y: 79 } } });
    expect(onRequestHistory).toHaveBeenCalledOnce();
  });

  it("renders neutral agent events as native chat, tools, permissions, stats, and debug", () => {
    const tree = renderAgentView([
      { seq: 0, event: { type: "user_message", text: "Please inspect auth" } },
      { seq: 1, event: { type: "assistant_text", text: "I will check it.", truncated: false } },
      { seq: 2, event: { type: "tool_call", call_id: "call-1", tool_name: "Bash", input: { command: "pnpm test" } } },
      { seq: 3, event: { type: "tool_result", call_id: "call-1", output: "passed", truncated: false, is_error: false } },
      { seq: 4, event: { type: "permission_request", request_id: "perm-1", tool_name: "Edit", input: { path: "src/auth.ts" } } },
      { seq: 5, event: { type: "turn_completed", status: "success", stats: { duration_ms: 1234, input_tokens: 10, output_tokens: 20, total_cost_usd: 0.01, num_turns: 1 } } },
      { seq: 6, event: { type: "diagnostic", message: "debug stderr" } }
    ]);

    const text = collectText(tree);

    expect(findByTestId(tree, "mobile.agent-message-view")).not.toBeNull();
    expect(text).toContain("Please inspect auth");
    expect(text).toContain("I will check it.");
    expect(text).toContain("Bash");
    expect(text).toContain("pnpm test");
    expect(text).toContain("passed");
    expect(text).toContain("Allow for session");
    expect(text).toContain("1 turns");
    expect(text).toContain("Debug");
    expect(text).toContain("debug stderr");
    expect(findByAccessibilityLabel(tree, "Allow Edit once")?.props).toMatchObject({
      accessibilityRole: "button"
    });
    expect(
      findByAccessibilityLabel(tree, "Allow Edit for this session")?.props
    ).toMatchObject({ accessibilityRole: "button" });
    expect(findByAccessibilityLabel(tree, "Deny Edit")?.props).toMatchObject({
      accessibilityRole: "button"
    });
    expect(findByTestId(tree, MOBILE_E2E_IDS.taskStopButton)?.props).toMatchObject({
      accessibilityRole: "button"
    });
  });

  it.each(["live", "idle"] as const)(
    "exposes agent stream readiness for the healthy %s state",
    (status) => {
      const tree = renderAgentView([], status);

      expect(findByTestId(tree, "mobile.agent-message-ready")).not.toBeNull();
    }
  );

  it.each(["connecting", "restarting", "error", "closed"] as const)(
    "does not expose agent stream readiness for the %s state",
    (status) => {
      const tree = renderAgentView([], status);

      expect(findByTestId(tree, "mobile.agent-message-ready")).toBeNull();
    }
  );

  it("animates the agent connection state", () => {
    const tree = renderAgentView([], "connecting");

    expect(findByType(tree, "LoadingText")?.props.label).toBe("Connecting");
    expect(collectText(tree)).not.toContain("Connecting...");
  });

  it("shows an animated session restart state", () => {
    const tree = renderAgentView([], "restarting");

    expect(findByType(tree, "LoadingText")?.props.label).toBe(
      "Restarting session"
    );
  });

  it.each(["live", "idle", "error", "closed"] as const)(
    "does not animate the agent %s state",
    (status) => {
      expect(findByType(renderAgentView([], status), "LoadingText")).toBeNull();
    }
  );
});
