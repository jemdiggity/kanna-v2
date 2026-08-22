// Component coverage for the composer/agent-transcript isolation boundary, the
// agentType === "agent" twin of TaskScreen.composerIsolation.test.tsx. The task
// screen owns both the composer draft and the agent message view, so an
// unmemoized transcript re-renders — re-filtering every event and rebuilding
// every bubble — on each keystroke. The real AgentMessageView renders here
// against a react-native mock whose ScrollView records every render of the
// transcript list.
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { FrameAgentEvent } from "@kanna/agent-protocol";
import type { TaskSummary } from "../lib/api/types";
import { createTerminalOutput } from "../state/terminalOutputBuffer";
import { DEFAULT_TASK_QUICK_REPLIES } from "./taskQuickReplies";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const agentViewHarness = vi.hoisted(() => ({ renderCount: 0 }));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  const { MOBILE_E2E_IDS: ids } = await import("../e2eTestIds");
  return {
    ActivityIndicator: "ActivityIndicator",
    Keyboard: {
      addListener: () => ({ remove: () => {} }),
      dismiss: () => {}
    },
    Pressable: "Pressable",
    // The transcript list is the agent view's own ScrollView, so it renders
    // exactly when AgentMessageView does — the property under test. Other
    // ScrollViews in the tree (the expanded title) carry no testID.
    ScrollView: (props: Record<string, unknown>) => {
      if (props.testID === ids.agentMessageReady) {
        agentViewHarness.renderCount += 1;
      }
      return ReactModule.createElement("ScrollView", props);
    },
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles
    },
    Text: "Text",
    TextInput: "TextInput",
    useWindowDimensions: () => ({ height: 800, width: 390 }),
    View: "View"
  };
});

vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("../components/LoadingText", () => ({ LoadingText: "LoadingText" }));
vi.mock("./TerminalWebView", () => ({ TerminalWebView: "TerminalWebView" }));
vi.mock("./RepoExplorer", () => ({ RepoExplorer: "RepoExplorer" }));
vi.mock("./TaskFilePreview", () => ({ TaskFilePreview: "TaskFilePreview" }));
vi.mock("./TaskDiffPreview", () => ({ TaskDiffPreview: "TaskDiffPreview" }));
vi.mock("./TaskMentionedFiles", () => ({
  TaskMentionedFiles: "TaskMentionedFiles"
}));
vi.mock("./VisualCompanionModal", () => ({
  VisualCompanionModal: "VisualCompanionModal"
}));
vi.mock("./QuickReplySendControl", () => ({
  QuickReplySendControl: "QuickReplySendControl"
}));
vi.mock("./taskActionMenu", () => ({ showTaskActionMenu: vi.fn() }));

let TaskScreen: typeof import("./TaskScreen").TaskScreen | null = null;
let rendered: ReactTestRenderer | null = null;

beforeAll(async () => {
  TaskScreen = (await import("./TaskScreen")).TaskScreen;
});

afterEach(async () => {
  if (rendered) {
    await act(async () => rendered?.unmount());
    rendered = null;
  }
  agentViewHarness.renderCount = 0;
});

const TASK: TaskSummary = {
  id: "task-agent-1",
  repoId: "repo-1",
  repoName: "Repo One",
  title: "Wire the composer",
  stage: "in progress",
  agentType: "agent",
  activity: "idle"
} as TaskSummary;

const AGENT_EVENTS: FrameAgentEvent[] = [
  { seq: 0, event: { type: "user_message", text: "Please inspect auth" } },
  {
    seq: 1,
    event: { type: "assistant_text", text: "I will check it.", truncated: false }
  }
];

interface RenderOptions {
  agentEvents: FrameAgentEvent[];
  agentCalls: {
    onResolveAgentPermission: ReturnType<typeof vi.fn>;
    onStopAgent: ReturnType<typeof vi.fn>;
  };
  serverCalls: {
    onReadTaskDiff: ReturnType<typeof vi.fn>;
    onReadTaskFile: ReturnType<typeof vi.fn>;
    onResolveTaskFileMentions: ReturnType<typeof vi.fn>;
    onSendInput: ReturnType<typeof vi.fn>;
    onSendTerminalInput: ReturnType<typeof vi.fn>;
  };
}

function taskScreenElement(options: RenderOptions) {
  if (!TaskScreen) throw new Error("TaskScreen was not loaded");
  return (
    <TaskScreen
      task={TASK}
      terminalOutput={createTerminalOutput("")}
      terminalOutputEpoch={0}
      terminalOutputStart={0}
      terminalStatus="idle"
      terminalErrorMessage={null}
      agentEvents={options.agentEvents}
      agentStatus="live"
      agentErrorMessage={null}
      quickReplies={DEFAULT_TASK_QUICK_REPLIES}
      quickRepliesHydrated
      onBack={() => true}
      onAdvanceTaskStage={vi.fn()}
      onCloseTask={vi.fn()}
      onResolveTaskFileMentions={options.serverCalls.onResolveTaskFileMentions}
      onReadTaskFile={options.serverCalls.onReadTaskFile}
      onReadTaskDiff={options.serverCalls.onReadTaskDiff}
      onSendInput={options.serverCalls.onSendInput}
      onSendTerminalInput={options.serverCalls.onSendTerminalInput}
      onStopAgent={options.agentCalls.onStopAgent}
      onResolveAgentPermission={options.agentCalls.onResolveAgentPermission}
      onRecoverTaskCreation={vi.fn()}
    />
  );
}

function createRenderOptions(): RenderOptions {
  return {
    agentEvents: AGENT_EVENTS,
    agentCalls: {
      onResolveAgentPermission: vi.fn(),
      onStopAgent: vi.fn()
    },
    serverCalls: {
      onReadTaskDiff: vi.fn(),
      onReadTaskFile: vi.fn(),
      onResolveTaskFileMentions: vi.fn(),
      onSendInput: vi.fn(),
      onSendTerminalInput: vi.fn()
    }
  };
}

function composerInput(): { onChangeText: (value: string) => void } {
  const input = rendered?.root.findAll(
    (node) => node.props?.testID === MOBILE_E2E_IDS.taskInput
  )[0];
  if (!input) throw new Error("the composer input was not rendered");
  return input.props as { onChangeText: (value: string) => void };
}

function transcriptBubbleCount(text: string): number {
  return (
    rendered?.root.findAll((node) => node.props?.children === text).length ?? 0
  );
}

describe("task screen agent composer isolation", () => {
  it("does not re-render the agent transcript while the reply draft changes", async () => {
    const options = createRenderOptions();
    await act(async () => {
      rendered = create(taskScreenElement(options));
    });

    const rendersBeforeTyping = agentViewHarness.renderCount;
    expect(rendersBeforeTyping).toBeGreaterThan(0);

    const { onChangeText } = composerInput();
    for (const draft of ["s", "sh", "shi", "ship", "ship "]) {
      await act(async () => {
        onChangeText(draft);
      });
    }

    expect(agentViewHarness.renderCount).toBe(rendersBeforeTyping);
    // The draft is local to the composer, so no keystroke may reach the server
    // or the running agent.
    for (const call of [
      ...Object.values(options.serverCalls),
      ...Object.values(options.agentCalls)
    ]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("keeps the draft in the composer while typing", async () => {
    const options = createRenderOptions();
    await act(async () => {
      rendered = create(taskScreenElement(options));
    });

    await act(async () => {
      composerInput().onChangeText("ship it");
    });

    const input = rendered?.root.findAll(
      (node) => node.props?.testID === MOBILE_E2E_IDS.taskInput
    )[0];
    expect(input?.props.value).toBe("ship it");
  });

  it("still renders newly streamed agent events while a draft is open", async () => {
    const options = createRenderOptions();
    await act(async () => {
      rendered = create(taskScreenElement(options));
    });

    await act(async () => {
      composerInput().onChangeText("ship it");
    });

    const rendersBeforeEvent = agentViewHarness.renderCount;
    await act(async () => {
      rendered?.update(
        taskScreenElement({
          ...options,
          agentEvents: [
            ...AGENT_EVENTS,
            {
              seq: 2,
              event: {
                type: "assistant_text",
                text: "Auth looks fine.",
                truncated: false
              }
            }
          ]
        })
      );
    });

    expect(agentViewHarness.renderCount).toBeGreaterThan(rendersBeforeEvent);
    expect(transcriptBubbleCount("Auth looks fine.")).toBeGreaterThan(0);
  });
});
