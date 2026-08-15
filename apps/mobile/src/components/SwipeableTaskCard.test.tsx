import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";

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
  onTogglePin: (pinned: boolean) => Promise<void>,
  pinned = false
): Promise<ReactTestRenderer> {
  if (!SwipeableTaskCard) throw new Error("SwipeableTaskCard was not loaded");
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(cardElement(pinned, onTogglePin));
  });
  if (!renderer) throw new Error("SwipeableTaskCard did not render");
  return renderer;
}

function cardElement(
  pinned: boolean,
  onTogglePin: (pinned: boolean) => Promise<void>
) {
  if (!SwipeableTaskCard) throw new Error("SwipeableTaskCard was not loaded");
  const task: TaskSummary = {
    id: "task-1",
    repoId: "repo-1",
    title: "Pin this task",
    stage: "in progress",
    pinned
  };

  return (
    <SwipeableTaskCard
      isSubtask={false}
      repoLabel={null}
      task={task}
      uiId="task-1"
      onPress={vi.fn()}
      onTogglePin={onTogglePin}
    />
  );
}

function dismissCardElement(onDismiss: () => Promise<void>) {
  if (!SwipeableTaskCard) throw new Error("SwipeableTaskCard was not loaded");
  return (
    <SwipeableTaskCard
      isSubtask={false}
      repoLabel="Kanna"
      task={{
        id: "task-activity",
        repoId: "repo-1",
        title: "Review this activity",
        stage: "review",
        activity: "unread"
      }}
      uiId="task-activity"
      onDismiss={onDismiss}
      onPress={vi.fn()}
    />
  );
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

  it("reveals Dismiss for a deliberate swipe and exposes a non-swipe fallback", async () => {
    if (!SwipeableTaskCard) throw new Error("SwipeableTaskCard was not loaded");
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(dismissCardElement(onDismiss));
    });
    if (!renderer) throw new Error("SwipeableTaskCard did not render");
    const responder = renderer.root.findAllByType("View").find(
      (node) => typeof node.props.onTouchStart === "function"
    );
    if (!responder) throw new Error("Swipe responder was not rendered");

    act(() => responder.props.onTouchStart(touch(200, 100)));
    expect(
      responder.props.onMoveShouldSetResponderCapture(touch(190, 70))
    ).toBe(false);
    expect(
      responder.props.onMoveShouldSetResponderCapture(touch(125, 96))
    ).toBe(true);
    act(() => {
      responder.props.onResponderMove(touch(125, 96));
      responder.props.onResponderRelease(touch(125, 96));
    });

    const swipeAction = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.activityDismissAction("task-activity")
    });
    expect(swipeAction.props).toMatchObject({
      accessibilityLabel: "Dismiss Review this activity",
      importantForAccessibility: "yes"
    });
    const button = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.activityDismissButton("task-activity")
    });
    await act(async () => {
      button.props.onPress({ stopPropagation: vi.fn() });
      await Promise.resolve();
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps a failed dismissal visible and announces its inline error", async () => {
    if (!SwipeableTaskCard) throw new Error("SwipeableTaskCard was not loaded");
    const onDismiss = vi.fn().mockRejectedValue(new Error("owner offline"));
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(dismissCardElement(onDismiss));
    });
    if (!renderer) throw new Error("SwipeableTaskCard did not render");
    const button = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.activityDismissButton("task-activity")
    });

    await act(async () => {
      button.props.onPress({ stopPropagation: vi.fn() });
      await Promise.resolve();
    });

    const error = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.activityDismissError("task-activity")
    });
    expect(error.props.accessibilityLiveRegion).toBe("polite");
    expect(error.props.children).toBe("owner offline");
  });

  it.each([
    {
      initialPinned: false,
      requestedPinned: true,
      pendingLabel: "Pinning…"
    },
    {
      initialPinned: true,
      requestedPinned: false,
      pendingLabel: "Unpinning…"
    }
  ])(
    "keeps $pendingLabel on both actions after the optimistic task rerender",
    async ({ initialPinned, requestedPinned, pendingLabel }) => {
      let resolveRequest: (() => void) | null = null;
      const request = new Promise<void>((resolve) => {
        resolveRequest = resolve;
      });
      const onTogglePin = vi.fn().mockReturnValue(request);
      const renderer = await renderCard(onTogglePin, initialPinned);
      const responder = renderer.root.findAllByType("View").find(
        (node) => typeof node.props.onTouchStart === "function"
      );
      if (!responder) throw new Error("Swipe responder was not rendered");

      act(() => {
        responder.props.onTouchStart(touch(200, 100));
        responder.props.onResponderMove(touch(130, 95));
        responder.props.onResponderRelease(touch(130, 95));
      });
      const action = renderer.root.findByProps({
        testID: MOBILE_E2E_IDS.taskPinAction("task-1")
      });
      act(() => action.props.onPress());
      expect(onTogglePin).toHaveBeenCalledWith(requestedPinned);

      act(() => {
        renderer.update(cardElement(requestedPinned, onTogglePin));
      });

      const pendingAction = renderer.root.findByProps({
        testID: MOBILE_E2E_IDS.taskPinAction("task-1")
      });
      expect(pendingAction.props.accessibilityLabel).toBe(
        `${pendingLabel} Pin this task`
      );
      expect(pendingAction.props.accessibilityState).toEqual({
        busy: true,
        disabled: true
      });
      expect(pendingAction.findByType("Text").props.children).toBe(pendingLabel);

      const pendingButton = renderer.root.findByProps({
        testID: MOBILE_E2E_IDS.taskPinButton("task-1")
      });
      expect(pendingButton.props.accessibilityLabel).toBe(
        `${pendingLabel} Pin this task`
      );
      expect(pendingButton.props.accessibilityState).toEqual({
        busy: true,
        disabled: true
      });
      expect(pendingButton.findByType("Text").props.children).toBe(pendingLabel);

      await act(async () => {
        resolveRequest?.();
        await request;
      });
    }
  );
});
