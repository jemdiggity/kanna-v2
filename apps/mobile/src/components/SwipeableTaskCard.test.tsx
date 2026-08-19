import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nativeHarness = vi.hoisted(() => ({
  panResponderConfigs: [] as Array<
    Record<string, ((...args: never[]) => unknown) | undefined>
  >
}));

vi.mock("react-native", () => ({
  PanResponder: {
    create: vi.fn((config) => {
      nativeHarness.panResponderConfigs.push(config);
      return { panHandlers: { "data-pan-handlers": true } };
    })
  },
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

beforeEach(() => {
  nativeHarness.panResponderConfigs.length = 0;
});

/** The gesture config the row handed to React Native for this render. */
function gestureConfig(): Record<
  string,
  ((...args: never[]) => unknown) | undefined
> {
  const config = nativeHarness.panResponderConfigs.at(-1);
  if (!config) throw new Error("The row did not create a pan responder");
  return config;
}

const gesture = (dx: number, dy = 0) =>
  ({ dx, dy }) as never;
const gestureEvent = {} as never;

/** One complete touch: grant, drag by `dx`, release. */
function swipe(dx: number): void {
  const config = gestureConfig();
  act(() => {
    config.onPanResponderGrant?.(gestureEvent, gesture(dx));
    config.onPanResponderMove?.(gestureEvent, gesture(dx));
    config.onPanResponderRelease?.(gestureEvent, gesture(dx));
  });
}

function swipeOpen(dx = -70): void {
  swipe(dx);
}

function actionRevealed(renderer: ReactTestRenderer, uiId: string): boolean {
  return (
    renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.taskPinAction(uiId)
    }).props.importantForAccessibility === "yes"
  );
}

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

describe("SwipeableTaskCard", () => {
  it("reveals Pin for a deliberate horizontal swipe but yields to scrolling", async () => {
    const renderer = await renderCard(vi.fn().mockResolvedValue(undefined));
    const config = gestureConfig();

    // A mostly-vertical drag stays with the enclosing task ScrollView.
    expect(
      config.onMoveShouldSetPanResponderCapture?.(gestureEvent, gesture(-10, -20))
    ).toBe(false);
    // A deliberate left drag takes the gesture, even though the card's own
    // Pressable already holds the responder.
    expect(
      config.onMoveShouldSetPanResponderCapture?.(gestureEvent, gesture(-60, 5))
    ).toBe(true);
    expect(
      config.onMoveShouldSetPanResponder?.(gestureEvent, gesture(-60, 5))
    ).toBe(true);

    swipeOpen();

    const action = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.taskPinAction("task-1")
    });
    expect(action.props.accessibilityLabel).toBe("Pin Pin this task");
    expect(action.props.importantForAccessibility).toBe("yes");
  });

  it("keeps the swipe once it starts and closes the row when it is cancelled", async () => {
    const renderer = await renderCard(vi.fn().mockResolvedValue(undefined));
    const config = gestureConfig();

    // The row never hands the touch back, so a scroll container cannot
    // reclaim it half-way through the reveal.
    expect(config.onPanResponderTerminationRequest?.()).toBe(false);

    swipeOpen();
    expect(
      renderer.root.findByProps({
        testID: MOBILE_E2E_IDS.taskPinAction("task-1")
      }).props.importantForAccessibility
    ).toBe("yes");

    act(() => {
      config.onPanResponderTerminate?.(gestureEvent, gesture(-70));
    });
    expect(
      renderer.root.findByProps({
        testID: MOBILE_E2E_IDS.taskPinAction("task-1")
      }).props.importantForAccessibility
    ).toBe("no-hide-descendants");
  });

  it("closes a revealed row with a separate rightward gesture", async () => {
    const renderer = await renderCard(vi.fn().mockResolvedValue(undefined));
    const config = gestureConfig();

    swipeOpen();
    expect(actionRevealed(renderer, "task-1")).toBe(true);

    // The revealed row is a resting position, so the closing drag arrives as
    // its own touch — the row has to claim it in the direction that closes.
    expect(
      config.onMoveShouldSetPanResponderCapture?.(gestureEvent, gesture(60, 5))
    ).toBe(true);
    expect(
      config.onMoveShouldSetPanResponder?.(gestureEvent, gesture(60, 5))
    ).toBe(true);

    swipe(60);
    expect(actionRevealed(renderer, "task-1")).toBe(false);

    // Closed again, a rightward drag has nothing to act on and goes back to
    // whatever encloses the row.
    expect(
      config.onMoveShouldSetPanResponderCapture?.(gestureEvent, gesture(60, 5))
    ).toBe(false);
  });

  it("keeps a revealed row open for a rightward drag that stays past the threshold", async () => {
    const renderer = await renderCard(vi.fn().mockResolvedValue(undefined));

    swipeOpen();
    swipe(20);

    expect(actionRevealed(renderer, "task-1")).toBe(true);
  });

  it("consumes the first tap on a revealed row to close it", async () => {
    if (!SwipeableTaskCard) throw new Error("SwipeableTaskCard was not loaded");
    const onPress = vi.fn();
    const task: TaskSummary = {
      id: "task-1",
      repoId: "repo-1",
      title: "Pin this task",
      stage: "in progress",
      pinned: false
    };
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <SwipeableTaskCard
          isSubtask={false}
          repoLabel={null}
          task={task}
          uiId="task-1"
          onPress={onPress}
          onTogglePin={vi.fn().mockResolvedValue(undefined)}
        />
      );
    });
    if (!renderer) throw new Error("SwipeableTaskCard did not render");
    const card = (renderer as ReactTestRenderer).root.findByProps({
      testID: MOBILE_E2E_IDS.taskListItem("task-1")
    });

    swipeOpen();
    act(() => {
      card.props.onPress();
    });
    expect(onPress).not.toHaveBeenCalled();
    expect(actionRevealed(renderer as ReactTestRenderer, "task-1")).toBe(false);

    // Closed, the card opens the task again.
    act(() => {
      card.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not release the reveal for a short, undecided drag", async () => {
    const renderer = await renderCard(vi.fn().mockResolvedValue(undefined));
    swipeOpen(-20);

    expect(
      renderer.root.findByProps({
        testID: MOBILE_E2E_IDS.taskPinAction("task-1")
      }).props.importantForAccessibility
    ).toBe("no-hide-descendants");
  });

  it("pins from the revealed action and reports failures inline", async () => {
    const onTogglePin = vi.fn().mockRejectedValue(new Error("offline"));
    const renderer = await renderCard(onTogglePin);
    swipeOpen();

    const action = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.taskPinAction("task-1")
    });
    await act(async () => {
      action.props.onPress();
      await Promise.resolve();
    });

    expect(onTogglePin).toHaveBeenCalledWith(true);
    const error = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.taskPinError("task-1")
    });
    expect(error.props.accessibilityLiveRegion).toBe("polite");
    expect(error.props.children).toBe("offline");
  });

  it("carries pin as a row accessibility action instead of a pin button", async () => {
    const onTogglePin = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderCard(onTogglePin);

    // Swiping is the only pin affordance: no pin button survives on the card.
    expect(
      renderer.root.findAllByProps({ testID: "mobile.task-pin-button.task-1" })
    ).toHaveLength(0);

    const card = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.taskListItem("task-1")
    });
    expect(card.props.accessibilityActions).toEqual([
      { name: "pin", label: "Pin" }
    ]);
    await act(async () => {
      card.props.onAccessibilityAction({ nativeEvent: { actionName: "pin" } });
      await Promise.resolve();
    });
    expect(onTogglePin).toHaveBeenCalledWith(true);
  });

  it("offers unpin to assistive technology once the task is pinned", async () => {
    const onTogglePin = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderCard(onTogglePin, true);

    const card = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.taskListItem("task-1")
    });
    expect(card.props.accessibilityActions).toEqual([
      { name: "unpin", label: "Unpin" }
    ]);
    await act(async () => {
      card.props.onAccessibilityAction({ nativeEvent: { actionName: "unpin" } });
      await Promise.resolve();
    });
    expect(onTogglePin).toHaveBeenCalledWith(false);
  });

  it("reveals Dismiss for a deliberate swipe and exposes a non-swipe fallback", async () => {
    if (!SwipeableTaskCard) throw new Error("SwipeableTaskCard was not loaded");
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(dismissCardElement(onDismiss));
    });
    if (!renderer) throw new Error("SwipeableTaskCard did not render");
    const config = gestureConfig();
    expect(
      config.onMoveShouldSetPanResponderCapture?.(gestureEvent, gesture(-10, -30))
    ).toBe(false);
    expect(
      config.onMoveShouldSetPanResponderCapture?.(gestureEvent, gesture(-75, 4))
    ).toBe(true);
    swipeOpen(-75);

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
    "keeps $pendingLabel on the revealed action after the optimistic task rerender",
    async ({ initialPinned, requestedPinned, pendingLabel }) => {
      let resolveRequest: (() => void) | null = null;
      const request = new Promise<void>((resolve) => {
        resolveRequest = resolve;
      });
      const onTogglePin = vi.fn().mockReturnValue(request);
      const renderer = await renderCard(onTogglePin, initialPinned);
      swipeOpen();

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

      await act(async () => {
        resolveRequest?.();
        await request;
      });
    }
  );
});
