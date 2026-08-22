import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nativeHarness = vi.hoisted(() => ({
  animationKinds: [] as string[],
  autoFinishAnimations: true,
  layoutPresets: [] as unknown[],
  panResponderConfigs: [] as Array<
    Record<string, ((...args: never[]) => unknown) | undefined>
  >,
  pendingAnimations: [] as Array<() => void>,
  reduceMotionEnabled: false,
  reduceMotionListener: null as ((enabled: boolean) => void) | null
}));

vi.mock("react-native", () => {
  class MockAnimatedValue {
    value: number;

    constructor(value: number) {
      this.value = value;
    }

    setValue(value: number): void {
      this.value = value;
    }

    interpolate(config: {
      inputRange: number[];
      outputRange: number[];
    }): MockInterpolation {
      return new MockInterpolation(this, config);
    }
  }

  class MockInterpolation {
    constructor(
      readonly source: MockAnimatedValue,
      readonly config: { inputRange: number[]; outputRange: number[] }
    ) {}
  }

  interface MockAnimation {
    apply(): void;
    start(callback?: (result: { finished: boolean }) => void): void;
  }

  const animation = (
    kind: string,
    apply: () => void
  ): MockAnimation => ({
    apply,
    start(callback) {
      nativeHarness.animationKinds.push(kind);
      const finish = () => {
        apply();
        callback?.({ finished: true });
      };
      if (nativeHarness.autoFinishAnimations) finish();
      else nativeHarness.pendingAnimations.push(finish);
    }
  });

  return {
    AccessibilityInfo: {
      addEventListener: vi.fn(
        (_event: string, listener: (enabled: boolean) => void) => {
          nativeHarness.reduceMotionListener = listener;
          return { remove: vi.fn() };
        }
      ),
      isReduceMotionEnabled: vi.fn(async () => nativeHarness.reduceMotionEnabled)
    },
    Animated: {
      View: "AnimatedView",
      Value: MockAnimatedValue,
      multiply: (left: unknown, right: unknown) => ({ left, right }),
      parallel: (animations: MockAnimation[]) =>
        animation("parallel", () => {
          for (const item of animations) item.apply();
        }),
      sequence: (animations: MockAnimation[]) =>
        animation("sequence", () => {
          for (const item of animations) item.apply();
        }),
      spring: (value: MockAnimatedValue, config: { toValue: number }) =>
        animation("spring", () => value.setValue(config.toValue)),
      timing: (value: MockAnimatedValue, config: { toValue: number }) =>
        animation("timing", () => value.setValue(config.toValue))
    },
    Dimensions: { get: () => ({ width: 390 }) },
    LayoutAnimation: {
      Presets: { easeInEaseOut: "easeInEaseOut", spring: "spring" },
      configureNext: vi.fn((preset: unknown) => {
        nativeHarness.layoutPresets.push(preset);
      })
    },
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
  };
});

let SwipeableTaskCard:
  | typeof import("./SwipeableTaskCard").SwipeableTaskCard
  | null = null;

beforeAll(async () => {
  SwipeableTaskCard = (await import("./SwipeableTaskCard")).SwipeableTaskCard;
});

beforeEach(() => {
  nativeHarness.animationKinds.length = 0;
  nativeHarness.autoFinishAnimations = true;
  nativeHarness.layoutPresets.length = 0;
  nativeHarness.panResponderConfigs.length = 0;
  nativeHarness.pendingAnimations.length = 0;
  nativeHarness.reduceMotionEnabled = false;
  nativeHarness.reduceMotionListener = null;
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

/** A touch that is still down, dragged through `dxs` in order. */
function drag(...dxs: number[]): void {
  const config = gestureConfig();
  act(() => {
    config.onPanResponderGrant?.(gestureEvent, gesture(dxs[0] ?? 0));
    for (const dx of dxs) {
      config.onPanResponderMove?.(gestureEvent, gesture(dx));
    }
  });
}

/** Lifting the finger where the drag left off. */
function release(dx: number): void {
  const config = gestureConfig();
  act(() => {
    config.onPanResponderRelease?.(gestureEvent, gesture(dx));
  });
}

/** One complete touch: drag through `dxs` and let go at the last one. */
function swipe(...dxs: number[]): void {
  drag(...dxs);
  release(dxs.at(-1) ?? 0);
}

/** How the action under the row is drawn right now. */
function animatedNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (!value || typeof value !== "object") {
    throw new Error("Expected an animated number");
  }
  if ("value" in value && typeof value.value === "number") return value.value;
  if ("source" in value && "config" in value) {
    const interpolation = value as {
      source: { value: number };
      config: { inputRange: number[]; outputRange: number[] };
    };
    const { inputRange, outputRange } = interpolation.config;
    const source = interpolation.source.value;
    const upperIndex = inputRange.findIndex((input) => source <= input);
    if (upperIndex <= 0) return outputRange[0] ?? 0;
    if (upperIndex === -1) return outputRange.at(-1) ?? 0;
    const lowerIndex = upperIndex - 1;
    const progress =
      (source - (inputRange[lowerIndex] ?? 0)) /
      ((inputRange[upperIndex] ?? 0) - (inputRange[lowerIndex] ?? 0));
    return (
      (outputRange[lowerIndex] ?? 0) +
      progress *
        ((outputRange[upperIndex] ?? 0) - (outputRange[lowerIndex] ?? 0))
    );
  }
  throw new Error("Expected an animated number");
}

function actionScale(
  renderer: ReactTestRenderer,
  testID: string
): number {
  const style = renderer.root.findByProps({ testID }).props.style as unknown[];
  const animatedStyle = style.at(-1) as {
    transform: Array<{ scale: unknown }>;
  };
  return animatedNumber(animatedStyle.transform[0]?.scale);
}

function actionOpacity(renderer: ReactTestRenderer, testID: string): number {
  const style = renderer.root.findByProps({ testID }).props.style as unknown[];
  const animatedStyle = style.at(-1) as { opacity: unknown };
  return animatedNumber(animatedStyle.opacity);
}

function actionBackgroundColor(
  renderer: ReactTestRenderer,
  testID: string
): string {
  const style = renderer.root.findByProps({ testID }).props.style as unknown[];
  const animatedStyle = style.at(-1) as {
    backgroundColor: {
      source: { value: number };
      config: { outputRange: string[] };
    };
  };
  const { source, config } = animatedStyle.backgroundColor;
  return source.value === 1
    ? (config.outputRange.at(-1) ?? "")
    : (config.outputRange[0] ?? "");
}

/** Where the card itself sits, which is `0` whenever the row is at rest. */
function rowTranslation(renderer: ReactTestRenderer): number {
  const style = renderer.root.findByProps({ "data-pan-handlers": true }).props
    .style as { transform: { translateX: number }[] };
  return animatedNumber(style.transform[0].translateX);
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
  onTogglePin: (pinned: boolean) => Promise<void>,
  onPress: () => void = vi.fn()
) {
  if (!SwipeableTaskCard) throw new Error("SwipeableTaskCard was not loaded");
  const task: TaskSummary = {
    id: "task-1",
    repoId: "repo-1",
    title: "Pin this task",
    stage: "in progress"
  };

  return (
    <SwipeableTaskCard
      isSubtask={false}
      pinned={pinned}
      repoLabel={null}
      task={task}
      uiId="task-1"
      onPress={onPress}
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

async function renderDismissCard(
  onDismiss: () => Promise<void>
): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(dismissCardElement(onDismiss));
  });
  if (!renderer) throw new Error("SwipeableTaskCard did not render");
  return renderer;
}

function longTitleCardElement() {
  if (!SwipeableTaskCard) throw new Error("SwipeableTaskCard was not loaded");
  return (
    <SwipeableTaskCard
      isSubtask={false}
      repoLabel={null}
      shortId="a6ea6b03"
      task={{
        id: "a6ea6b03",
        repoId: "repo-1",
        title: `Long ${"mobile task title ".repeat(12)}end`,
        stage: "in progress"
      }}
      uiId="a6ea6b03"
      onPress={vi.fn()}
      onTogglePin={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

describe("SwipeableTaskCard", () => {
  it("keeps the complete short id on a long-titled row, open or closed", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(longTitleCardElement());
    });
    if (!renderer) throw new Error("SwipeableTaskCard did not render");
    const row = renderer as ReactTestRenderer;
    const renderedId = () =>
      row.root.findByProps({
        testID: MOBILE_E2E_IDS.taskListItemId("a6ea6b03")
      }).props.children;

    expect(renderedId()).toBe("a6ea6b03");
    // Finger still down, row displaced: the id must survive the open state too.
    drag(-70);
    expect(renderedId()).toBe("a6ea6b03");
  });

  it("claims a deliberate leftward swipe but yields to scrolling", async () => {
    await renderCard(vi.fn().mockResolvedValue(undefined));
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
    // The row rests closed, so a rightward drag has nothing to act on and
    // belongs to whatever encloses the row.
    expect(
      config.onMoveShouldSetPanResponderCapture?.(gestureEvent, gesture(60, 5))
    ).toBe(false);
  });

  it("pins when the swipe is released past the threshold", async () => {
    const onTogglePin = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderCard(onTogglePin);

    await act(async () => {
      swipe(-70);
      await Promise.resolve();
    });

    expect(onTogglePin).toHaveBeenCalledWith(true);
    expect(nativeHarness.animationKinds).toContain("sequence");
    expect(nativeHarness.layoutPresets).toContain("spring");
    // Nothing rests open: the row is back where it started, with no revealed
    // button waiting for a second tap.
    expect(rowTranslation(renderer)).toBe(0);
  });

  it("waits for the completion spring before invoking the pin callback", async () => {
    const onTogglePin = vi.fn().mockResolvedValue(undefined);
    await renderCard(onTogglePin);

    drag(-70);
    nativeHarness.pendingAnimations.length = 0;
    nativeHarness.autoFinishAnimations = false;
    release(-70);

    expect(onTogglePin).not.toHaveBeenCalled();
    expect(nativeHarness.pendingAnimations).toHaveLength(1);

    await act(async () => {
      nativeHarness.pendingAnimations.shift()?.();
      await Promise.resolve();
    });
    expect(onTogglePin).toHaveBeenCalledWith(true);
  });

  it("uses only a fade and no layout spring when reduced motion is enabled", async () => {
    nativeHarness.reduceMotionEnabled = true;
    const onTogglePin = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderCard(onTogglePin);

    nativeHarness.animationKinds.length = 0;
    drag(-70);
    expect(
      actionOpacity(renderer, MOBILE_E2E_IDS.taskPinAction("task-1"))
    ).toBe(1);
    expect(
      actionBackgroundColor(
        renderer,
        MOBILE_E2E_IDS.taskPinAction("task-1")
      )
    ).toBe("#2563EB");
    const rowStyle = renderer.root.findByProps({ "data-pan-handlers": true })
      .props.style as { transform: unknown[] };
    expect(rowStyle.transform).toEqual([]);

    await act(async () => {
      release(-70);
      await Promise.resolve();
    });

    expect(nativeHarness.animationKinds).toEqual(["timing"]);
    expect(nativeHarness.layoutPresets).toEqual([]);
    expect(onTogglePin).toHaveBeenCalledWith(true);
  });

  it("fades a cancelled reduced-motion swipe back to rest", async () => {
    nativeHarness.reduceMotionEnabled = true;
    const onTogglePin = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderCard(onTogglePin);

    nativeHarness.animationKinds.length = 0;
    drag(-30);
    await act(async () => {
      release(-30);
      await Promise.resolve();
    });

    expect(nativeHarness.animationKinds).toEqual(["parallel"]);
    expect(onTogglePin).not.toHaveBeenCalled();
    expect(
      renderer.root.findByProps({ "data-pan-handlers": true }).props.style
        .transform
    ).toEqual([]);
  });

  it("performs nothing when the swipe is dragged back inside the threshold before release", async () => {
    const onTogglePin = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderCard(onTogglePin);

    // Swipe past the threshold, hold, then swipe the action back away again.
    drag(-70);
    expect(actionScale(renderer, MOBILE_E2E_IDS.taskPinAction("task-1"))).toBe(
      1.04
    );
    drag(-70, -20);
    expect(actionScale(renderer, MOBILE_E2E_IDS.taskPinAction("task-1"))).toBe(
      0.88
    );

    await act(async () => {
      release(-20);
      await Promise.resolve();
    });

    expect(onTogglePin).not.toHaveBeenCalled();
    expect(rowTranslation(renderer)).toBe(0);
  });

  it("performs nothing for a short, undecided drag", async () => {
    const onTogglePin = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderCard(onTogglePin);

    await act(async () => {
      swipe(-20);
      await Promise.resolve();
    });

    expect(onTogglePin).not.toHaveBeenCalled();
    expect(rowTranslation(renderer)).toBe(0);
  });

  it("keeps the swipe once it starts and performs nothing if it is terminated", async () => {
    const onTogglePin = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderCard(onTogglePin);
    const config = gestureConfig();

    // The row never hands the touch back, so a scroll container cannot
    // reclaim it half-way through a swipe.
    expect(config.onPanResponderTerminationRequest?.()).toBe(false);

    drag(-70);
    await act(async () => {
      config.onPanResponderTerminate?.(gestureEvent, gesture(-70));
      await Promise.resolve();
    });

    // A gesture the row lost is not a release: it acts on nothing.
    expect(onTogglePin).not.toHaveBeenCalled();
    expect(rowTranslation(renderer)).toBe(0);
  });

  it("emphasizes the action as the swipe crosses the commit threshold", async () => {
    const renderer = await renderCard(vi.fn().mockResolvedValue(undefined));
    const pinAction = MOBILE_E2E_IDS.taskPinAction("task-1");

    expect(actionScale(renderer, pinAction)).toBe(0.88);
    drag(-47);
    expect(actionScale(renderer, pinAction)).toBe(0.88);
    drag(-47, -48);
    expect(actionScale(renderer, pinAction)).toBe(1.04);
    // The action is drawn for the eye alone now — VoiceOver reaches pin
    // through the row's own accessibility action instead.
    expect(
      renderer.root.findByProps({ testID: pinAction }).props
        .importantForAccessibility
    ).toBe("no-hide-descendants");
  });

  it("keeps every action solid at mid-swipe and arms with color and scale", async () => {
    const pinAction = MOBILE_E2E_IDS.taskPinAction("task-1");
    const pinRenderer = await renderCard(vi.fn().mockResolvedValue(undefined));
    drag(-30);
    expect(actionOpacity(pinRenderer, pinAction)).toBeGreaterThanOrEqual(0.95);
    expect(actionBackgroundColor(pinRenderer, pinAction)).toBe("#435F96");
    drag(-48);
    expect(actionBackgroundColor(pinRenderer, pinAction)).toBe("#2563EB");
    expect(actionScale(pinRenderer, pinAction)).toBe(1.04);

    const unpinRenderer = await renderCard(
      vi.fn().mockResolvedValue(undefined),
      true
    );
    drag(-30);
    expect(actionOpacity(unpinRenderer, pinAction)).toBeGreaterThanOrEqual(0.95);
    expect(actionBackgroundColor(unpinRenderer, pinAction)).toBe("#743F4C");
    drag(-48);
    expect(actionBackgroundColor(unpinRenderer, pinAction)).toBe("#9F2D42");
    expect(actionScale(unpinRenderer, pinAction)).toBe(1.04);

    const dismissAction = MOBILE_E2E_IDS.activityDismissAction("task-activity");
    const dismissRenderer = await renderDismissCard(
      vi.fn().mockResolvedValue(undefined)
    );
    drag(-30);
    expect(actionOpacity(dismissRenderer, dismissAction)).toBeGreaterThanOrEqual(
      0.95
    );
    expect(actionBackgroundColor(dismissRenderer, dismissAction)).toBe(
      "#803F4B"
    );
    drag(-48);
    expect(actionBackgroundColor(dismissRenderer, dismissAction)).toBe(
      "#B4233C"
    );
    expect(actionScale(dismissRenderer, dismissAction)).toBe(1.04);
  });

  it("keeps the card tap opening the task, swiped or not", async () => {
    const onPress = vi.fn();
    const onTogglePin = vi.fn().mockResolvedValue(undefined);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(cardElement(false, onTogglePin, onPress));
    });
    if (!renderer) throw new Error("SwipeableTaskCard did not render");
    const card = (renderer as ReactTestRenderer).root.findByProps({
      testID: MOBILE_E2E_IDS.taskListItem("task-1")
    });

    // After a cancelled swipe.
    await act(async () => {
      swipe(-20);
      await Promise.resolve();
    });
    act(() => {
      card.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);

    // And after a committed one: the row keeps no open state to consume the
    // next tap.
    await act(async () => {
      swipe(-70);
      await Promise.resolve();
    });
    act(() => {
      card.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("reports a failed pin inline on the row that failed", async () => {
    const onTogglePin = vi.fn().mockRejectedValue(new Error("offline"));
    const renderer = await renderCard(onTogglePin);

    await act(async () => {
      swipe(-70);
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

    // Swiping is the only pointer pin affordance: no pin button survives on
    // the card.
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

  it("dismisses on release too: both lists read the same gesture", async () => {
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderDismissCard(onDismiss);
    const config = gestureConfig();
    expect(
      config.onMoveShouldSetPanResponderCapture?.(gestureEvent, gesture(-10, -30))
    ).toBe(false);
    expect(
      config.onMoveShouldSetPanResponderCapture?.(gestureEvent, gesture(-75, 4))
    ).toBe(true);

    const dismissAction = MOBILE_E2E_IDS.activityDismissAction("task-activity");
    drag(-75);
    expect(actionScale(renderer, dismissAction)).toBe(1.04);
    expect(
      renderer.root.findByProps({ testID: dismissAction }).findByType("Text")
        .props.children
    ).toBe("Dismiss");
    // The card carries no dismiss button of its own any more.
    expect(
      renderer.root.findAllByProps({
        testID: "mobile.activity-dismiss-button.task-activity"
      })
    ).toHaveLength(0);

    await act(async () => {
      release(-75);
      await Promise.resolve();
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(nativeHarness.layoutPresets).toContain("easeInEaseOut");
    expect(rowTranslation(renderer)).toBe(0);
  });

  it("leaves an Activity row alone when its swipe is taken back", async () => {
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderDismissCard(onDismiss);

    drag(-75, -30);
    await act(async () => {
      release(-30);
      await Promise.resolve();
    });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(rowTranslation(renderer)).toBe(0);
  });

  it("keeps a failed dismissal visible and announces its inline error", async () => {
    const onDismiss = vi.fn().mockRejectedValue(new Error("storage full"));
    const renderer = await renderDismissCard(onDismiss);
    const card = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.taskListItem("task-activity")
    });

    await act(async () => {
      card.props.onAccessibilityAction({
        nativeEvent: { actionName: "dismiss" }
      });
      await Promise.resolve();
    });

    const error = renderer.root.findByProps({
      testID: MOBILE_E2E_IDS.activityDismissError("task-activity")
    });
    expect(error.props.accessibilityLiveRegion).toBe("polite");
    expect(error.props.children).toBe("storage full");
  });

  it("labels the swipe action from the phone's own pin state, with no pending step", async () => {
    const onTogglePin = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderCard(onTogglePin, false);
    const pinAction = MOBILE_E2E_IDS.taskPinAction("task-1");

    drag(-70);
    expect(
      renderer.root.findByProps({ testID: pinAction }).findByType("Text").props
        .children
    ).toBe("Pin");
    await act(async () => {
      release(-70);
      await Promise.resolve();
    });
    expect(onTogglePin).toHaveBeenCalledWith(true);

    // The list re-renders the row from the local record; no "Pinning…" step
    // exists to sit between the two labels.
    act(() => {
      renderer.update(cardElement(true, onTogglePin));
    });
    drag(-70);
    expect(
      renderer.root.findByProps({ testID: pinAction }).findByType("Text").props
        .children
    ).toBe("Unpin");
  });
});
