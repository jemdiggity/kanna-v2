import React, { useImperativeHandle } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface ScrollToTopTarget {
  current: { scrollToTop(): void } | null;
}

const harness = vi.hoisted(() => ({
  dismiss: vi.fn(),
  scrollTo: vi.fn(),
  target: null as ScrollToTopTarget | null
}));

vi.mock("@react-navigation/native", () => ({
  useScrollToTop: (target: ScrollToTopTarget) => {
    harness.target = target;
  }
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    Keyboard: { dismiss: harness.dismiss },
    ScrollView: ReactModule.forwardRef(function ScrollView(
      props: { children?: React.ReactNode },
      ref: React.ForwardedRef<{ scrollTo(options: unknown): void }>
    ) {
      useImperativeHandle(ref, () => ({ scrollTo: harness.scrollTo }));
      return ReactModule.createElement("ScrollView", props, props.children);
    })
  };
});

import { ScrollView } from "react-native";
import { useTabReselectionScrollToTop } from "./useTabReselectionScrollToTop";

function Harness({ withScrollOwner = true }: { withScrollOwner?: boolean }) {
  const scrollViewRef = useTabReselectionScrollToTop();
  return withScrollOwner ? <ScrollView ref={scrollViewRef} /> : null;
}

let rendered: ReactTestRenderer | null = null;

beforeEach(() => {
  harness.dismiss.mockReset();
  harness.scrollTo.mockReset();
  harness.target = null;
});

afterEach(async () => {
  if (rendered) {
    await act(async () => rendered?.unmount());
    rendered = null;
  }
});

describe("useTabReselectionScrollToTop", () => {
  it("dismisses the keyboard and scrolls the real owner to the absolute top", async () => {
    await act(async () => {
      rendered = create(<Harness />);
    });

    await act(async () => {
      harness.target?.current?.scrollToTop();
    });

    expect(harness.dismiss).toHaveBeenCalledOnce();
    expect(harness.scrollTo).toHaveBeenCalledWith({
      animated: true,
      x: 0,
      y: 0
    });
  });

  it("safely no-ops when the active state has no mounted scroll owner", async () => {
    await act(async () => {
      rendered = create(<Harness withScrollOwner={false} />);
    });

    expect(() => harness.target?.current?.scrollToTop()).not.toThrow();
    expect(harness.scrollTo).not.toHaveBeenCalled();
  });
});
