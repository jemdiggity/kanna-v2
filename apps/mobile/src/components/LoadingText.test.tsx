import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text"
}));

import { LoadingText } from "./LoadingText";

const NBSP = "\u00a0";

let rendered: ReactTestRenderer | null = null;

function collectText(node: { children?: Array<unknown> } | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? [])
    .map((child) =>
      typeof child === "string"
        ? child
        : collectText(child as { children?: Array<unknown> })
    )
    .join("");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  if (rendered) {
    await act(async () => rendered?.unmount());
    rendered = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LoadingText", () => {
  it("cycles a fixed-width terminal ellipsis with stable accessibility metadata", async () => {
    await act(async () => {
      rendered = create(<LoadingText label="Connecting" testID="loading" />);
    });

    const text = rendered!.root
      .findAllByProps({ testID: "loading" })
      .find((node) => node.type === "Text")!;
    expect(text.props.accessibilityLabel).toBe("Connecting, loading");
    expect(text.props.accessibilityRole).toBe("progressbar");
    expect(collectText(text)).toBe(`Connecting.${NBSP}${NBSP}`);

    await act(async () => vi.advanceTimersByTime(400));
    expect(collectText(text)).toBe(`Connecting..${NBSP}`);

    await act(async () => vi.advanceTimersByTime(400));
    expect(collectText(text)).toBe("Connecting...");

    await act(async () => vi.advanceTimersByTime(400));
    expect(collectText(text)).toBe(`Connecting.${NBSP}${NBSP}`);
  });

  it("clears its animation interval when unmounted", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    await act(async () => {
      rendered = create(<LoadingText label="Loading tasks" />);
    });

    await act(async () => rendered!.unmount());
    rendered = null;

    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });
});
