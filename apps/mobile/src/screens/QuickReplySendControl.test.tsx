import React from "react";
import {
  act,
  create,
  type ReactTestRenderer
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TASK_QUICK_REPLIES } from "./taskQuickReplies";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const nativeHarness = vi.hoisted(() => ({
  panResponderConfig: null as Record<
    string,
    ((...args: never[]) => unknown) | undefined
  > | null,
  timing: vi.fn()
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");

  class AnimatedValue {
    value: number;

    constructor(value: number) {
      this.value = value;
    }

    interpolate() {
      return this;
    }

    setValue(value: number) {
      this.value = value;
    }
  }

  nativeHarness.timing.mockImplementation(
    (value: AnimatedValue, config: { toValue: number }) => ({
      start(callback?: (result: { finished: boolean }) => void) {
        value.setValue(config.toValue);
        callback?.({ finished: true });
      },
      stop: vi.fn()
    })
  );

  return {
    Animated: {
      Value: AnimatedValue,
      View: "AnimatedView",
      timing: nativeHarness.timing
    },
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
    PanResponder: {
      create: vi.fn((config) => {
        nativeHarness.panResponderConfig = config;
        return { panHandlers: {} };
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

import { QuickReplySendControl } from "./QuickReplySendControl";

const mounted: ReactTestRenderer[] = [];
const event = {} as never;
const displacement = (dx = 0, dy = 0) => ({ dx, dy }) as never;

beforeEach(() => {
  vi.useFakeTimers();
  nativeHarness.panResponderConfig = null;
  nativeHarness.timing.mockClear();
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount());
  }
  vi.clearAllTimers();
  vi.useRealTimers();
});

function renderControl(
  overrides: Partial<React.ComponentProps<typeof QuickReplySendControl>> = {}
) {
  const onPress = vi.fn();
  const onSelectReply = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <QuickReplySendControl
        disabled={false}
        gestureScopeKey="task-a"
        hydrated
        replies={DEFAULT_TASK_QUICK_REPLIES}
        onPress={onPress}
        onSelectReply={onSelectReply}
        {...overrides}
      />
    );
  });
  mounted.push(renderer);
  return { onPress, onSelectReply, renderer };
}

function panResponder() {
  if (!nativeHarness.panResponderConfig) {
    throw new Error("PanResponder was not created");
  }
  return nativeHarness.panResponderConfig;
}

describe("QuickReplySendControl", () => {
  it("releases a short stationary touch as normal Send", () => {
    const { onPress, onSelectReply } = renderControl();

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => panResponder().onPanResponderRelease?.(event, displacement()));

    expect(onPress).toHaveBeenCalledOnce();
    expect(onSelectReply).not.toHaveBeenCalled();
  });

  it("cancels a pre-activation move beyond ten points", () => {
    const { onPress, onSelectReply } = renderControl();

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() =>
      panResponder().onPanResponderMove?.(event, displacement(11, 0))
    );
    act(() =>
      panResponder().onPanResponderRelease?.(event, displacement(11, 0))
    );

    expect(onPress).not.toHaveBeenCalled();
    expect(onSelectReply).not.toHaveBeenCalled();
  });

  it("activates after 400ms, highlights, and selects on release", () => {
    const { onPress, onSelectReply, renderer } = renderControl();

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => vi.advanceTimersByTime(400));
    expect(
      renderer.root.findByProps({ testID: "mobile.quick-reply.rail" })
    ).toBeDefined();

    act(() =>
      panResponder().onPanResponderMove?.(event, displacement(0, -52))
    );
    expect(
      renderer.root.findByProps({ testID: "mobile.quick-reply.sgtm-proceed" })
        .props.accessibilityState
    ).toEqual({ selected: true });

    act(() =>
      panResponder().onPanResponderRelease?.(event, displacement(0, -52))
    );
    expect(onSelectReply).toHaveBeenCalledWith("sgtm-proceed");
    expect(onPress).not.toHaveBeenCalled();
    expect(
      renderer.root.findAllByProps({ testID: "mobile.quick-reply.rail" })
    ).toHaveLength(0);
  });

  it("drag-selects from the complete loaded list without mutating it", () => {
    const replies = [
      { id: "first", text: "First" },
      { id: "second", text: "Second" },
      { id: "third", text: "Third" }
    ];
    const original = replies.map((reply) => ({ ...reply }));
    const { onSelectReply } = renderControl({ replies });

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => vi.advanceTimersByTime(400));
    act(() =>
      panResponder().onPanResponderRelease?.(event, displacement(0, -164))
    );

    expect(onSelectReply).toHaveBeenCalledWith("third");
    expect(replies).toEqual(original);
  });

  it("cancels an active release outside every card", () => {
    const { onPress, onSelectReply } = renderControl();

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => vi.advanceTimersByTime(400));
    act(() =>
      panResponder().onPanResponderRelease?.(event, displacement())
    );

    expect(onPress).not.toHaveBeenCalled();
    expect(onSelectReply).not.toHaveBeenCalled();
  });

  it("uses the final release position when no move event was delivered", () => {
    const { onPress, onSelectReply } = renderControl();

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => vi.advanceTimersByTime(400));
    act(() =>
      panResponder().onPanResponderRelease?.(event, displacement(0, -52))
    );

    expect(onSelectReply).toHaveBeenCalledWith("sgtm-proceed");
    expect(onPress).not.toHaveBeenCalled();
  });

  it("lets the final release position cancel an earlier highlight", () => {
    const { onPress, onSelectReply } = renderControl();

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => vi.advanceTimersByTime(400));
    act(() =>
      panResponder().onPanResponderMove?.(event, displacement(0, -52))
    );
    act(() =>
      panResponder().onPanResponderRelease?.(event, displacement(0, -350))
    );

    expect(onSelectReply).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
  });

  it("cancels an active gesture when its task scope changes", () => {
    const { onPress, onSelectReply, renderer } = renderControl();

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => vi.advanceTimersByTime(400));
    act(() =>
      renderer.update(
        <QuickReplySendControl
          disabled={false}
          gestureScopeKey="task-b"
          hydrated
          replies={DEFAULT_TASK_QUICK_REPLIES}
          onPress={onPress}
          onSelectReply={onSelectReply}
        />
      )
    );
    act(() =>
      panResponder().onPanResponderRelease?.(event, displacement(0, -52))
    );

    expect(onPress).not.toHaveBeenCalled();
    expect(onSelectReply).not.toHaveBeenCalled();
  });

  it("cancels an active gesture when Send becomes disabled", () => {
    const { onPress, onSelectReply, renderer } = renderControl();

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => vi.advanceTimersByTime(400));
    act(() =>
      renderer.update(
        <QuickReplySendControl
          disabled
          gestureScopeKey="task-a"
          hydrated
          replies={DEFAULT_TASK_QUICK_REPLIES}
          onPress={onPress}
          onSelectReply={onSelectReply}
        />
      )
    );
    act(() =>
      panResponder().onPanResponderRelease?.(event, displacement(0, -52))
    );

    expect(onPress).not.toHaveBeenCalled();
    expect(onSelectReply).not.toHaveBeenCalled();
  });

  it("cancels responder termination", () => {
    const { onPress, onSelectReply, renderer } = renderControl();

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => vi.advanceTimersByTime(400));
    act(() => panResponder().onPanResponderTerminate?.(event, displacement()));

    expect(onPress).not.toHaveBeenCalled();
    expect(onSelectReply).not.toHaveBeenCalled();
    expect(
      renderer.root.findAllByProps({ testID: "mobile.quick-reply.rail" })
    ).toHaveLength(0);
  });

  it("keeps short-tap Send available before hydration but cancels a hold", () => {
    const { onPress, onSelectReply } = renderControl({ hydrated: false });

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => panResponder().onPanResponderRelease?.(event, displacement()));
    expect(onPress).toHaveBeenCalledOnce();

    onPress.mockClear();
    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => vi.advanceTimersByTime(400));
    act(() => panResponder().onPanResponderRelease?.(event, displacement()));
    expect(onPress).not.toHaveBeenCalled();
    expect(onSelectReply).not.toHaveBeenCalled();
  });

  it("does not claim touches or accessibility actions while disabled", () => {
    const { onPress, onSelectReply, renderer } = renderControl({
      disabled: true
    });
    const send = renderer.root.findByProps({
      testID: "mobile.task-send-button"
    });

    expect(
      panResponder().onStartShouldSetPanResponder?.(event, displacement())
    ).toBe(false);
    expect(send.props.accessibilityState).toEqual({ disabled: true });
    act(() =>
      send.props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" }
      })
    );
    expect(onPress).not.toHaveBeenCalled();
    expect(onSelectReply).not.toHaveBeenCalled();
  });

  it("opens the accessible picker and selects through the same callback", () => {
    const { onSelectReply, renderer } = renderControl();
    const send = renderer.root.findByProps({
      testID: "mobile.task-send-button"
    });

    expect(send.props.accessibilityActions).toEqual([
      { name: "activate", label: "Send reply" },
      { name: "showQuickReplies", label: "Show quick replies" }
    ]);
    act(() =>
      send.props.onAccessibilityAction({
        nativeEvent: { actionName: "showQuickReplies" }
      })
    );
    expect(
      renderer.root.findByProps({ testID: "mobile.quick-reply.picker" })
    ).toBeDefined();

    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-reply.sgtm-proceed" })
        .props.onPress()
    );
    expect(onSelectReply).toHaveBeenCalledWith("sgtm-proceed");
    expect(
      renderer.root.findAllByProps({ testID: "mobile.quick-reply.picker" })
    ).toHaveLength(0);
  });

  it("keeps drag card rendering aligned to its fixed hit geometry", () => {
    const { renderer } = renderControl();

    act(() => panResponder().onPanResponderGrant?.(event, displacement()));
    act(() => vi.advanceTimersByTime(400));

    const card = renderer.root.findByProps({
      testID: "mobile.quick-reply.sgtm-proceed"
    });
    const label = card.findByType("Text");
    const cardStyles = Array.isArray(card.props.style)
      ? card.props.style
      : [card.props.style];
    expect(cardStyles).toContainEqual(
      expect.objectContaining({ height: 48 })
    );
    expect(label.props.allowFontScaling).toBe(false);
  });

  it("cancels the accessible picker without selecting", () => {
    const { onSelectReply, renderer } = renderControl();
    const send = renderer.root.findByProps({
      testID: "mobile.task-send-button"
    });

    act(() =>
      send.props.onAccessibilityAction({
        nativeEvent: { actionName: "showQuickReplies" }
      })
    );
    act(() =>
      renderer.root
        .findByProps({ testID: "mobile.quick-reply.picker.cancel" })
        .props.onPress()
    );

    expect(onSelectReply).not.toHaveBeenCalled();
    expect(
      renderer.root.findAllByProps({ testID: "mobile.quick-reply.picker" })
    ).toHaveLength(0);
  });

  it("closes the accessible picker without sending when task scope changes", () => {
    const { onPress, onSelectReply, renderer } = renderControl();
    const send = renderer.root.findByProps({
      testID: "mobile.task-send-button"
    });
    act(() =>
      send.props.onAccessibilityAction({
        nativeEvent: { actionName: "showQuickReplies" }
      })
    );

    act(() =>
      renderer.update(
        <QuickReplySendControl
          disabled={false}
          gestureScopeKey="task-b"
          hydrated
          replies={DEFAULT_TASK_QUICK_REPLIES}
          onPress={onPress}
          onSelectReply={onSelectReply}
        />
      )
    );

    expect(
      renderer.root.findAllByProps({ testID: "mobile.quick-reply.picker" })
    ).toHaveLength(0);
    expect(onPress).not.toHaveBeenCalled();
    expect(onSelectReply).not.toHaveBeenCalled();
  });
});
