// Component coverage for the photo-attachment composer: picking a photo has
// to show it, sending has to carry it beside the text in one submission, and
// removing or switching tasks has to drop it. The attachment is the only
// composer state that survives a round trip through a native picker, so
// "which task is on screen when the picker returns" is a real question here
// and is asserted rather than assumed.
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import type { PreparedImageAttachment } from "../lib/attachments/imageAttachmentBudget";
import { ImageAttachmentError } from "../lib/attachments/imageAttachmentBudget";
import { createTerminalOutput } from "../state/terminalOutputBuffer";
import { DEFAULT_TASK_QUICK_REPLIES } from "./taskQuickReplies";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const attachmentMenu = vi.hoisted(() => ({
  show: vi.fn()
}));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Image: "Image",
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
vi.mock("./TerminalWebView", () => ({ TerminalWebView: "TerminalWebView" }));
vi.mock("./RepoExplorer", () => ({ RepoExplorer: "RepoExplorer" }));
vi.mock("./VisualCompanionModal", () => ({
  VisualCompanionModal: "VisualCompanionModal"
}));
vi.mock("./TaskPreviewModal", () => ({
  TaskPreviewModal: "TaskPreviewModal"
}));
vi.mock("./QuickReplySendControl", () => ({
  QuickReplySendControl: "QuickReplySendControl"
}));
vi.mock("./taskActionMenu", () => ({ showTaskActionMenu: vi.fn() }));
vi.mock("./taskAttachmentMenu", () => ({
  showImageAttachmentSourceMenu: attachmentMenu.show
}));

let TaskScreen: typeof import("./TaskScreen").TaskScreen | null = null;
let rendered: ReactTestRenderer | null = null;

beforeAll(async () => {
  TaskScreen = (await import("./TaskScreen")).TaskScreen;
});

beforeEach(() => {
  attachmentMenu.show.mockReset();
  attachmentMenu.show.mockImplementation(
    (onSelect: (source: "library" | "camera") => void) => onSelect("library")
  );
});

afterEach(async () => {
  if (rendered) {
    await act(async () => rendered?.unmount());
    rendered = null;
  }
});

const PTY_TASK: TaskSummary = {
  id: "task-1",
  repoId: "repo-1",
  repoName: "Repo One",
  title: "Wire the composer",
  stage: "in progress",
  agentType: "pty",
  activity: "idle"
} as TaskSummary;

const SDK_TASK: TaskSummary = { ...PTY_TASK, id: "task-2", agentType: "agent" };

const PHOTO: PreparedImageAttachment = {
  previewUri: "file:///tmp/rendered.jpg",
  byteLength: 4,
  payload: {
    fileName: "IMG_4821.jpg",
    mediaType: "image/jpeg",
    dataBase64: "AQID"
  }
};

interface Harness {
  onSendInput: ReturnType<typeof vi.fn>;
  pickAttachment: ReturnType<typeof vi.fn>;
}

function screenElement(
  harness: Harness,
  task: TaskSummary = PTY_TASK,
  desktopSupportsAttachments = true
) {
  if (!TaskScreen) throw new Error("TaskScreen was not loaded");
  return (
    <TaskScreen
      task={task}
      desktopSupportsAttachments={desktopSupportsAttachments}
      terminalOutput={createTerminalOutput("")}
      terminalOutputEpoch={1}
      terminalOutputStart={0}
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
      onResolveTaskFileMentions={vi.fn()}
      onReadTaskFile={vi.fn()}
      onReadTaskDiff={vi.fn()}
      onSendInput={harness.onSendInput}
      pickAttachment={harness.pickAttachment}
      onSendTerminalInput={vi.fn()}
      onStopAgent={vi.fn()}
      onResolveAgentPermission={vi.fn()}
      onRecoverTaskCreation={vi.fn()}
    />
  );
}

function createHarness(
  pick: () => Promise<PreparedImageAttachment | null> = async () => PHOTO
): Harness {
  return { onSendInput: vi.fn(), pickAttachment: vi.fn(pick) };
}

async function renderScreen(
  harness: Harness,
  task: TaskSummary = PTY_TASK,
  desktopSupportsAttachments = true
): Promise<ReactTestRenderer> {
  await act(async () => {
    rendered = create(
      screenElement(harness, task, desktopSupportsAttachments)
    );
  });
  if (!rendered) throw new Error("the task screen was not rendered");
  return rendered;
}

function press(tree: ReactTestRenderer, testID: string): Promise<void> {
  const target = tree.root.findByProps({ testID });
  return act(async () => {
    (target.props as { onPress(): void }).onPress();
  });
}

function typeDraft(tree: ReactTestRenderer, text: string): Promise<void> {
  const input = tree.root.findByProps({ testID: MOBILE_E2E_IDS.taskInput });
  return act(async () => {
    (input.props as { onChangeText(value: string): void }).onChangeText(text);
  });
}

function sendComposer(tree: ReactTestRenderer): Promise<void> {
  const control = tree.root.findByType(
    "QuickReplySendControl" as unknown as React.ComponentType
  );
  return act(async () => {
    (control.props as { onPress(): void }).onPress();
  });
}

function has(tree: ReactTestRenderer, testID: string): boolean {
  return tree.root.findAllByProps({ testID }).length > 0;
}

describe("TaskScreen photo attachments", () => {
  it("uses a minimal composer plus without changing the attach control", async () => {
    const tree = await renderScreen(createHarness());
    const attachButton = tree.root.findByProps({
      testID: MOBILE_E2E_IDS.taskAttachButton
    });
    const icon = attachButton.findByType(
      "Ionicons" as unknown as React.ComponentType
    );

    expect(attachButton.props.accessibilityLabel).toBe("Attach photo");
    expect(attachButton.props.accessibilityRole).toBe("button");
    expect(attachButton.props.style[0]).toMatchObject({ height: 32, width: 32 });
    expect(icon.props).toMatchObject({
      color: "#9BB0CC",
      name: "add",
      size: 24
    });
    expect(
      attachButton.findAllByType("Text" as unknown as React.ComponentType)
    ).toHaveLength(0);
  });

  it("shows the picked photo and sends it with the typed text in one submission", async () => {
    const harness = createHarness();
    const tree = await renderScreen(harness);

    await typeDraft(tree, "what is wrong here?");
    await press(tree, MOBILE_E2E_IDS.taskAttachButton);

    expect(harness.pickAttachment).toHaveBeenCalledWith("library");
    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentPreview)).toBe(true);
    expect(
      tree.root.findByProps({ testID: MOBILE_E2E_IDS.taskAttachmentPreview })
        .findByType("Image" as unknown as React.ComponentType).props.source
    ).toEqual({ uri: "file:///tmp/rendered.jpg" });

    await sendComposer(tree);

    expect(harness.onSendInput).toHaveBeenCalledWith(
      "what is wrong here?",
      PHOTO.payload
    );
    // Sending clears the composer, so the next message cannot re-send the
    // same photo.
    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentPreview)).toBe(false);
  });

  it("sends a photo with no text at all", async () => {
    const harness = createHarness();
    const tree = await renderScreen(harness);

    await press(tree, MOBILE_E2E_IDS.taskAttachButton);
    await sendComposer(tree);

    expect(harness.onSendInput).toHaveBeenCalledWith("", PHOTO.payload);
  });

  it("still sends text alone with no attachment argument", async () => {
    const harness = createHarness();
    const tree = await renderScreen(harness);

    await typeDraft(tree, "continue");
    await sendComposer(tree);

    expect(harness.onSendInput).toHaveBeenCalledWith("continue");
  });

  it("keeps text and the photo visible when the desktop rejects the input", async () => {
    const harness = createHarness();
    harness.onSendInput.mockResolvedValue({
      status: "failed",
      reason: "server_rejected",
      message: "no live agent session"
    });
    const tree = await renderScreen(harness);

    await typeDraft(tree, "keep this dictated message");
    await press(tree, MOBILE_E2E_IDS.taskAttachButton);
    await sendComposer(tree);

    expect(
      tree.root.findByProps({ testID: MOBILE_E2E_IDS.taskInput }).props.value
    ).toBe("keep this dictated message");
    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentPreview)).toBe(true);
    expect(
      tree.root
        .findByProps({ testID: MOBILE_E2E_IDS.taskInputStatus })
        .findByType("Text" as unknown as React.ComponentType).props.children
    ).toContain("Your text is still here.");
  });

  it("keeps the canonical no-resend guidance when input is queued", async () => {
    const harness = createHarness();
    harness.onSendInput.mockResolvedValue({
      status: "queued",
      reason: "input_held_by_draft",
      message: "a human has an unsent line at that terminal",
      queuedInputCount: 1
    });
    const tree = await renderScreen(harness);

    await typeDraft(tree, "send this once the draft clears");
    await sendComposer(tree);

    const statusText = tree.root
      .findByProps({ testID: MOBILE_E2E_IDS.taskInputStatus })
      .findByType("Text" as unknown as React.ComponentType).props.children;
    expect(statusText).toContain("submitted or cleared");
    expect(statusText).toContain("don't send it again");
    expect(
      tree.root.findByProps({ testID: MOBILE_E2E_IDS.taskInput }).props.value
    ).toBe("");
  });

  it("announces the desktop-accepted outcome through the native status element", async () => {
    const harness = createHarness();
    harness.onSendInput.mockResolvedValue({ status: "delivered" });
    const tree = await renderScreen(harness);

    await typeDraft(tree, "continue");
    await sendComposer(tree);

    expect(
      tree.root.findByProps({ testID: MOBILE_E2E_IDS.taskInputStatus }).props
        .accessibilityLabel
    ).toContain("accepted by the desktop");
  });

  it("does not clear a newer native draft when an earlier send completes", async () => {
    const harness = createHarness();
    let resolveSend: ((outcome: { status: "delivered" }) => void) | null = null;
    harness.onSendInput.mockReturnValue(
      new Promise<{ status: "delivered" }>((resolve) => {
        resolveSend = resolve;
      })
    );
    const tree = await renderScreen(harness);

    await typeDraft(tree, "first dictated message");
    await sendComposer(tree);
    await sendComposer(tree);
    expect(harness.onSendInput).toHaveBeenCalledOnce();
    await typeDraft(tree, "newer draft on the same task");

    await act(async () => {
      resolveSend?.({ status: "delivered" });
      await Promise.resolve();
    });

    expect(
      tree.root.findByProps({ testID: MOBILE_E2E_IDS.taskInput }).props.value
    ).toBe("newer draft on the same task");
    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentPreview)).toBe(false);
    expect(
      tree.root.findAllByProps({ testID: MOBILE_E2E_IDS.taskInputStatus })
    ).toHaveLength(0);
  });

  it("forwards one long multiline native dictation update without truncating it", async () => {
    const harness = createHarness();
    harness.onSendInput.mockResolvedValue({ status: "delivered" });
    const dictatedText = [
      "A short opening sentence.",
      "A longer dictated paragraph with punctuation, numbers 12345, and enough words to exercise the capped native viewport.",
      "A final line."
    ].join("\n");
    const tree = await renderScreen(harness);

    await typeDraft(tree, dictatedText);
    await sendComposer(tree);

    expect(harness.onSendInput).toHaveBeenCalledWith(dictatedText);
    expect(
      tree.root.findByProps({ testID: MOBILE_E2E_IDS.taskInput }).props.value
    ).toBe("");
  });

  it("does not let a late result clear a different task’s draft", async () => {
    const harness = createHarness();
    let resolveSend: ((outcome: { status: "delivered" }) => void) | null = null;
    harness.onSendInput.mockReturnValue(
      new Promise<{ status: "delivered" }>((resolve) => {
        resolveSend = resolve;
      })
    );
    const tree = await renderScreen(harness);

    await typeDraft(tree, "task one input");
    await sendComposer(tree);
    await act(async () => {
      tree.update(screenElement(harness, { ...PTY_TASK, id: "task-2" }));
    });
    await typeDraft(tree, "task two draft");

    await act(async () => {
      resolveSend?.({ status: "delivered" });
      await Promise.resolve();
    });

    expect(
      tree.root.findByProps({ testID: MOBILE_E2E_IDS.taskInput }).props.value
    ).toBe("task two draft");
  });

  it("sends nothing when the composer is empty and no photo is attached", async () => {
    const harness = createHarness();
    const tree = await renderScreen(harness);

    await sendComposer(tree);

    expect(harness.onSendInput).not.toHaveBeenCalled();
  });

  it("removes an attached photo before it is sent", async () => {
    const harness = createHarness();
    const tree = await renderScreen(harness);

    await press(tree, MOBILE_E2E_IDS.taskAttachButton);
    await press(tree, MOBILE_E2E_IDS.taskAttachmentRemove);

    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentPreview)).toBe(false);

    await typeDraft(tree, "never mind");
    await sendComposer(tree);

    expect(harness.onSendInput).toHaveBeenCalledWith("never mind");
  });

  it("keeps a cancelled pick out of the composer", async () => {
    const harness = createHarness(async () => null);
    const tree = await renderScreen(harness);

    await press(tree, MOBILE_E2E_IDS.taskAttachButton);

    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentPreview)).toBe(false);
    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentError)).toBe(false);
  });

  it("explains an over-budget photo instead of attaching it", async () => {
    const harness = createHarness(async () => {
      throw new ImageAttachmentError(
        "too-large",
        "IMG_4821.jpg is 8.2 MB, over the 3.0 MB attachment limit."
      );
    });
    const tree = await renderScreen(harness);

    await press(tree, MOBILE_E2E_IDS.taskAttachButton);

    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentPreview)).toBe(false);
    expect(
      tree.root.findByProps({ testID: MOBILE_E2E_IDS.taskAttachmentError })
        .props.children
    ).toContain("over the 3.0 MB attachment limit");
  });

  it("explains a denied photo permission instead of closing on silence", async () => {
    // The distinction that matters: a cancelled pick says nothing, a denied
    // permission must say something, because iOS and Android show no second
    // dialog and the control would otherwise look broken forever.
    const harness = createHarness(async () => {
      throw new ImageAttachmentError(
        "permission-denied",
        "Photo access is off. Turn it on for Kanna in Settings to attach a photo."
      );
    });
    const tree = await renderScreen(harness);

    await press(tree, MOBILE_E2E_IDS.taskAttachButton);

    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentPreview)).toBe(false);
    expect(
      tree.root.findByProps({ testID: MOBILE_E2E_IDS.taskAttachmentError })
        .props.children
    ).toContain("Settings");
  });

  it("clears a permission message once a later pick succeeds", async () => {
    let deny = true;
    const harness = createHarness(async () => {
      if (deny) {
        throw new ImageAttachmentError(
          "permission-denied",
          "Photo access is off. Turn it on for Kanna in Settings to attach a photo."
        );
      }
      return PHOTO;
    });
    const tree = await renderScreen(harness);

    await press(tree, MOBILE_E2E_IDS.taskAttachButton);
    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentError)).toBe(true);

    deny = false;
    await press(tree, MOBILE_E2E_IDS.taskAttachButton);

    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentError)).toBe(false);
    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentPreview)).toBe(true);
  });

  it("offers no attach control when the desktop does not advertise attachments", async () => {
    // A desktop built before attachments accepts the field, ignores it, and
    // answers 204 — so offering the control would clear the composer and let
    // the agent answer about a picture it never received.
    const harness = createHarness();
    const tree = await renderScreen(harness, PTY_TASK, false);

    expect(has(tree, MOBILE_E2E_IDS.taskAttachButton)).toBe(false);
  });

  it("still sends text to a desktop that does not advertise attachments", async () => {
    const harness = createHarness();
    const tree = await renderScreen(harness, PTY_TASK, false);

    await typeDraft(tree, "continue");
    await sendComposer(tree);

    expect(harness.onSendInput).toHaveBeenCalledWith("continue");
  });

  it("offers no attach control on an SDK-mode task, whose input never carries a file", async () => {
    const harness = createHarness();
    const tree = await renderScreen(harness, SDK_TASK);

    expect(has(tree, MOBILE_E2E_IDS.taskAttachButton)).toBe(false);
  });

  it("drops a photo attached to a task the screen has since left", async () => {
    const harness = createHarness();
    const tree = await renderScreen(harness);

    await press(tree, MOBILE_E2E_IDS.taskAttachButton);
    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentPreview)).toBe(true);

    await act(async () => {
      tree.update(screenElement(harness, { ...PTY_TASK, id: "task-9" }));
    });

    expect(has(tree, MOBILE_E2E_IDS.taskAttachmentPreview)).toBe(false);
  });
});
