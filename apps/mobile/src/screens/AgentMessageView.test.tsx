import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FrameAgentEvent } from "@kanna/agent-protocol";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

let AgentMessageView: typeof import("./AgentMessageView").AgentMessageView | null = null;

beforeAll(async () => {
  AgentMessageView = (await import("./AgentMessageView")).AgentMessageView;
});

interface ElementNode {
  type: unknown;
  props?: {
    children?: ElementNode | ElementNode[] | string | number | null;
    testID?: string;
    [key: string]: unknown;
  };
}

function renderAgentView(events: FrameAgentEvent[]): ElementNode {
  if (!AgentMessageView) {
    throw new Error("AgentMessageView was not loaded");
  }

  return AgentMessageView({
    errorMessage: null,
    events,
    status: "live",
    onInterrupt: vi.fn(),
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

describe("AgentMessageView", () => {
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
  });

  it("compacts large token counts in turn stats", () => {
    const tree = renderAgentView([
      {
        seq: 1,
        event: {
          type: "turn_completed",
          status: "success",
          stats: {
            duration_ms: 1234,
            input_tokens: 1200,
            output_tokens: 4_567_890,
            total_cost_usd: 0.01,
            num_turns: 1
          }
        }
      }
    ]);

    expect(collectText(tree)).toContain("1.2k/4.6M tok");
  });
});
