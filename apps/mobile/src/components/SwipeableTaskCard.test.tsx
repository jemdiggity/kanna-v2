import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

let SwipeableTaskCard:
  | typeof import("./SwipeableTaskCard").SwipeableTaskCard
  | null = null;

beforeAll(async () => {
  SwipeableTaskCard = (await import("./SwipeableTaskCard")).SwipeableTaskCard;
});

async function renderCard(
  onTogglePin: (pinned: boolean) => Promise<void>
): Promise<ReactTestRenderer> {
  if (!SwipeableTaskCard) throw new Error("SwipeableTaskCard was not loaded");
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(
      <SwipeableTaskCard
        isSubtask={false}
        repoLabel={null}
        task={{
          id: "task-1",
          repoId: "repo-1",
          title: "Pin this task",
          stage: "in progress",
          pinned: false
        }}
        uiId="task-1"
        onPress={vi.fn()}
        onTogglePin={onTogglePin}
      />
    );
  });
  if (!renderer) throw new Error("SwipeableTaskCard did not render");
  return renderer;
}

function touch(pageX: number, pageY: number) {
  return { nativeEvent: { pageX, pageY } };
}

describe("SwipeableTaskCard", () => {
  it("reveals Pin for a deliberate horizontal swipe but yields to scrolling", async () => {
    const renderer = await renderCard(vi.fn().mockResolvedValue(undefined));
    const responder = renderer.root.findAllByType("View").find(
      (node) => typeof node.props.onTouchStart === "function"
    );
    if (!responder) throw new Error("Swipe responder was not rendered");

    act(() => responder.props.onTouchStart(touch(200, 100)));
    expect(
      responder.props.onMoveShouldSetResponderCapture(touch(190, 80))
    ).toBe(false);
    expect(
      responder.props.onMoveShouldSetResponderCapture(touch(130, 95))
    ).toBe(true);
    act(() => {
      responder.props.onResponderMove(touch(130, 95));
      responder.props.onResponderRelease(touch(130, 95));
    });

    const action = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.taskPinAction("task-1")
    });
    expect(action.props.accessibilityLabel).toBe("Pin Pin this task");
    expect(action.props.importantForAccessibility).toBe("yes");
  });

  it("offers a visible non-swipe action and reports failures inline", async () => {
    const onTogglePin = vi.fn().mockRejectedValue(new Error("offline"));
    const renderer = await renderCard(onTogglePin);
    const button = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.taskPinButton("task-1")
    });

    await act(async () => {
      button.props.onPress({ stopPropagation: vi.fn() });
      await Promise.resolve();
    });

    expect(onTogglePin).toHaveBeenCalledWith(true);
    const error = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.taskPinError("task-1")
    });
    expect(error.props.accessibilityLiveRegion).toBe("polite");
    expect(error.props.children).toBe("offline");
  });
});
