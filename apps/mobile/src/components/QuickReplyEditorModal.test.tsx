import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickReplyEditorModal } from "./QuickReplyEditorModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const editorHarness = vi.hoisted(() => ({
  alert: vi.fn(),
  focus: vi.fn()
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    Alert: { alert: editorHarness.alert },
    KeyboardAvoidingView: "KeyboardAvoidingView",
    Modal: ({
      children,
      visible,
      ...props
    }: {
      children?: React.ReactNode;
      visible: boolean;
      [key: string]: unknown;
    }) =>
      visible ? ReactModule.createElement("Modal", props, children) : null,
    Platform: { OS: "ios" },
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles
    },
    Text: "Text",
    TextInput: ReactModule.forwardRef(
      (props: Record<string, unknown>, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({
          focus: editorHarness.focus
        }));
        return ReactModule.createElement("TextInput", props);
      }
    ),
    View: "View"
  };
});

const mounted: ReactTestRenderer[] = [];

beforeEach(() => {
  editorHarness.alert.mockReset();
  editorHarness.focus.mockReset();
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount());
  }
});

function renderEditor(
  overrides: Partial<React.ComponentProps<typeof QuickReplyEditorModal>> = {}
) {
  const onClose = vi.fn();
  const onSave = vi.fn().mockResolvedValue(undefined);
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <QuickReplyEditorModal
        replies={[
          { id: "first", text: "One" },
          { id: "second", text: "Two" }
        ]}
        visible
        onClose={onClose}
        onSave={onSave}
        {...overrides}
      />
    );
  });
  mounted.push(renderer);
  return { onClose, onSave, renderer };
}

async function flushMicrotasks(iterations = 4) {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

describe("QuickReplyEditorModal", () => {
  it("edits, reorders, adds, deletes, normalizes, and saves a draft copy", async () => {
    const { onClose, onSave, renderer } = renderEditor();

    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.first.input" })
        .props.onChangeText("  Updated  ")
    );
    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.first.down" })
        .props.onPress()
    );
    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.add" })
        .props.onPress()
    );

    const inputs = renderer.root.findAllByType("TextInput");
    const addedInput = inputs.at(-1);
    expect(addedInput?.props.value).toBe("");
    act(() => addedInput?.props.onChangeText("Third"));
    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.second.delete" })
        .props.onPress()
    );

    await act(async () => {
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.done" })
        .props.onPress();
      await flushMicrotasks();
    });

    expect(onSave).toHaveBeenCalledWith(
      [
        { id: "first", text: "Updated" },
        expect.objectContaining({ text: "Third" })
      ],
      false
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables deletion at one and adding at five", () => {
    const one = renderEditor({
      replies: [{ id: "only", text: "Only" }]
    }).renderer;
    expect(
      one.root.findByProps({ testID: "mobile.quick-replies.only.delete" })
        .props.disabled
    ).toBe(true);

    const five = renderEditor({
      replies: Array.from({ length: 5 }, (_, index) => ({
        id: `reply-${index}`,
        text: `Reply ${index}`
      }))
    }).renderer;
    expect(
      five.root.findByProps({ testID: "mobile.quick-replies.add" }).props
        .disabled
    ).toBe(true);
  });

  it("shows inline duplicate validation and does not save", async () => {
    const { onClose, onSave, renderer } = renderEditor();
    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.second.input" })
        .props.onChangeText(" one ")
    );

    await act(async () => {
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.done" })
        .props.onPress();
      await flushMicrotasks();
    });

    expect(
      renderer.root.findByProps({
        testID: "mobile.quick-replies.second.error"
      }).props.children
    ).toMatch(/unique/i);
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(editorHarness.focus).toHaveBeenCalledOnce();
  });

  it.each([
    ["   ", /cannot be blank/i],
    ["x".repeat(201), /200 characters/i]
  ])("rejects invalid reply text %#", async (text, message) => {
    const { onSave, renderer } = renderEditor();
    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.first.input" })
        .props.onChangeText(text)
    );

    await act(async () => {
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.done" })
        .props.onPress();
      await flushMicrotasks();
    });

    expect(
      renderer.root.findByProps({
        testID: "mobile.quick-replies.first.error"
      }).props.children
    ).toMatch(message);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the draft open with a retryable error when persistence fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("disk full"));
    const { onClose, renderer } = renderEditor({ onSave });

    await act(async () => {
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.done" })
        .props.onPress();
      await flushMicrotasks();
    });

    expect(
      renderer.root.findByProps({
        testID: "mobile.quick-replies.save-error"
      }).props.children
    ).toMatch(/could not save quick replies/i);
    expect(
      renderer.root.findByProps({
        testID: "mobile.quick-replies.first.input"
      }).props.value
    ).toBe("One");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not replace a failed baseline until the user confirms", async () => {
    const { onClose, onSave, renderer } = renderEditor({
      replacementConfirmationRequired: true
    });

    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.done" })
        .props.onPress()
    );
    expect(editorHarness.alert).toHaveBeenCalledWith(
      "Replace quick replies?",
      expect.stringMatching(/could not be loaded/i),
      expect.any(Array),
      expect.objectContaining({ cancelable: true })
    );
    const buttons = editorHarness.alert.mock.calls[0]?.[2] as
      | Array<{ text: string; onPress?: () => void }>
      | undefined;
    await act(async () => {
      buttons?.find((button) => button.text === "Cancel")?.onPress?.();
      await flushMicrotasks();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("confirms replacement with the complete loaded ordered list", async () => {
    const replies = [
      { id: "first", text: "One" },
      { id: "second", text: "Two" },
      { id: "third", text: "Three" }
    ];
    const { onClose, onSave, renderer } = renderEditor({
      replies,
      replacementConfirmationRequired: true
    });

    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.done" })
        .props.onPress()
    );
    const buttons = editorHarness.alert.mock.calls[0]?.[2] as
      | Array<{ text: string; onPress?: () => void }>
      | undefined;
    await act(async () => {
      buttons?.find((button) => button.text === "Replace")?.onPress?.();
      await flushMicrotasks();
    });

    expect(onSave).toHaveBeenCalledWith(replies, true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels without saving", () => {
    const { onClose, onSave, renderer } = renderEditor();

    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.cancel" })
        .props.onPress()
    );

    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("refreshes its draft from props when reopened", () => {
    const { onClose, onSave, renderer } = renderEditor();
    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-replies.first.input" })
        .props.onChangeText("Unsaved")
    );
    act(() =>
      renderer.update(
        <QuickReplyEditorModal
          replies={[{ id: "fresh", text: "Fresh" }]}
          visible={false}
          onClose={onClose}
          onSave={onSave}
        />
      )
    );
    act(() =>
      renderer.update(
        <QuickReplyEditorModal
          replies={[{ id: "fresh", text: "Fresh" }]}
          visible
          onClose={onClose}
          onSave={onSave}
        />
      )
    );

    expect(
      renderer.root.findByProps({
        testID: "mobile.quick-replies.fresh.input"
      }).props.value
    ).toBe("Fresh");
  });
});
