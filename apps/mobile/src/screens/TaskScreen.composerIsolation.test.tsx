// Component coverage for the composer/terminal isolation boundary: typing a
// reply must not touch the terminal view. The task screen owns both the
// composer draft and the fullscreen terminal, so an unmemoized terminal
// re-renders on every keystroke — which is how a keystroke ended up re-planning
// a terminal mutation against the render-time output props and rewriting the
// whole screen. The terminal only reacts to its own inputs here: the real
// TerminalWebView renders against a mocked react-native-webview that records
// every render and every injected script.
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type {
  TaskTerminalOutputSnapshot,
  TaskTerminalOutputSource
} from "../state/sessionStore";
import {
  appendTerminalOutput,
  createTerminalOutput,
  type TerminalOutputBuffer
} from "../state/terminalOutputBuffer";
import type { TaskSummary } from "../lib/api/types";
import { DEFAULT_TASK_QUICK_REPLIES } from "./taskQuickReplies";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const webViewHarness = vi.hoisted(() => ({
  injectedScripts: [] as string[],
  latestProps: null as Record<string, unknown> | null,
  renderCount: 0
}));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Keyboard: {
    addListener: () => ({ remove: () => {} }),
    dismiss: () => {}
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
vi.mock("react-native-webview", async () => {
  const ReactModule = await import("react");
  const WebView = ReactModule.forwardRef(
    (props: Record<string, unknown>, ref: React.Ref<unknown>) => {
      webViewHarness.renderCount += 1;
      webViewHarness.latestProps = props;
      ReactModule.useImperativeHandle(
        ref,
        () => ({
          injectJavaScript: (script: string) => {
            webViewHarness.injectedScripts.push(script);
          }
        }),
        []
      );
      return null;
    }
  );
  return { WebView };
});

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("../lib/diagnostics/mobileCrashDiagnostics", () => ({
  captureMobileCrashDiagnostic: vi.fn()
}));
vi.mock("./AgentMessageView", () => ({ AgentMessageView: "AgentMessageView" }));
vi.mock("../components/LoadingText", () => ({ LoadingText: "LoadingText" }));
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
  webViewHarness.injectedScripts.length = 0;
  webViewHarness.latestProps = null;
  webViewHarness.renderCount = 0;
});

// The real xterm document reports back over the message bridge once it is
// ready; until then the component queues state instead of injecting it.
async function signalTerminalReady(): Promise<void> {
  const onMessage = webViewHarness.latestProps?.onMessage as
    | ((event: { nativeEvent: { data: string } }) => void)
    | undefined;
  if (!onMessage) throw new Error("the terminal WebView was not rendered");
  await act(async () => {
    onMessage({
      nativeEvent: { data: JSON.stringify({ type: "terminal-ready" }) }
    });
  });
}

const TASK: TaskSummary = {
  id: "task-1",
  repoId: "repo-1",
  repoName: "Repo One",
  title: "Wire the composer",
  stage: "in progress",
  agentType: "pty",
  activity: "idle"
} as TaskSummary;

interface MutableTerminalOutputSource extends TaskTerminalOutputSource {
  emit(snapshot: TaskTerminalOutputSnapshot): void;
}

function createTerminalOutputSource(
  initial: TaskTerminalOutputSnapshot
): MutableTerminalOutputSource {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(next) {
      snapshot = next;
      for (const listener of [...listeners]) {
        listener();
      }
    }
  };
}

interface RenderOptions {
  output: TerminalOutputBuffer;
  outputEpoch: number;
  outputStart: number;
  terminalOutputSource: TaskTerminalOutputSource;
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
      terminalOutput={options.output}
      terminalOutputEpoch={options.outputEpoch}
      terminalOutputStart={options.outputStart}
      terminalOutputSource={options.terminalOutputSource}
      terminalStatus="live"
      terminalErrorMessage={null}
      agentEvents={[]}
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
      onStopAgent={vi.fn()}
      onResolveAgentPermission={vi.fn()}
      onRecoverTaskCreation={vi.fn()}
    />
  );
}

function createRenderOptions(): RenderOptions & {
  source: MutableTerminalOutputSource;
} {
  const output = createTerminalOutput("bnBtIHRlc3QK\n");
  const source = createTerminalOutputSource({
    taskId: TASK.id,
    output,
    outputEpoch: 4,
    outputStart: 0,
    status: "live"
  });
  return {
    output,
    outputEpoch: 4,
    outputStart: 0,
    terminalOutputSource: source,
    source,
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

describe("task screen composer isolation", () => {
  it("does not re-render or re-drive the terminal while the reply draft changes", async () => {
    const options = createRenderOptions();
    await act(async () => {
      rendered = create(taskScreenElement(options));
    });
    await signalTerminalReady();

    // Live output reaches the terminal through the dedicated source, so the
    // render-time output props trail behind it. A keystroke that re-drives the
    // terminal from those props rewinds the screen to the stale snapshot.
    await act(async () => {
      options.source.emit({
        taskId: TASK.id,
        output: appendTerminalOutput(options.output, "c3RyZWFtaW5nCg==\n").output,
        outputEpoch: options.outputEpoch,
        outputStart: options.outputStart,
        status: "live"
      });
    });

    const rendersBeforeTyping = webViewHarness.renderCount;
    const scriptsBeforeTyping = webViewHarness.injectedScripts.length;
    expect(rendersBeforeTyping).toBeGreaterThan(0);

    const { onChangeText } = composerInput();
    for (const draft of ["s", "sh", "shi", "ship", "ship "]) {
      await act(async () => {
        onChangeText(draft);
      });
    }

    expect(webViewHarness.injectedScripts.slice(scriptsBeforeTyping)).toEqual([]);
    expect(webViewHarness.renderCount).toBe(rendersBeforeTyping);
    // The draft is local to the composer, so no keystroke may reach the server.
    for (const call of Object.values(options.serverCalls)) {
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

  it("still streams new terminal output into the terminal while a draft is open", async () => {
    const options = createRenderOptions();
    await act(async () => {
      rendered = create(taskScreenElement(options));
    });
    await signalTerminalReady();

    await act(async () => {
      composerInput().onChangeText("ship it");
    });

    const scriptsBeforeOutput = webViewHarness.injectedScripts.length;
    await act(async () => {
      options.source.emit({
        taskId: TASK.id,
        output: appendTerminalOutput(options.output, "bmV3IG91dHB1dAo=\n").output,
        outputEpoch: 4,
        outputStart: 0,
        status: "live"
      });
    });

    expect(
      webViewHarness.injectedScripts.slice(scriptsBeforeOutput)
    ).toHaveLength(1);
    expect(webViewHarness.injectedScripts.at(-1)).toContain(
      "__appendTerminalChunk"
    );
  });
});
