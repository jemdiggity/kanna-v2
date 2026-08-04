import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const diagnosticMocks = vi.hoisted(() => ({
  capture: vi.fn(() => ({ id: "diagnostic-123" })),
  format: vi.fn((records: unknown) => JSON.stringify(records))
}));
const nativeMocks = vi.hoisted(() => ({
  announceForAccessibility: vi.fn()
}));

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("../lib/diagnostics/mobileCrashDiagnostics", () => ({
  captureMobileCrashDiagnostic: diagnosticMocks.capture,
  formatMobileCrashDiagnostics: diagnosticMocks.format
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: {
    announceForAccessibility: nativeMocks.announceForAccessibility
  },
  Pressable: "Pressable",
  SafeAreaView: "SafeAreaView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

import { MobileCrashBoundary } from "./MobileCrashBoundary";

let rendered: ReactTestRenderer | null = null;

afterEach(async () => {
  if (rendered) {
    await act(async () => rendered?.unmount());
    rendered = null;
  }
  diagnosticMocks.capture.mockClear();
  diagnosticMocks.capture.mockReturnValue({ id: "diagnostic-123" });
  diagnosticMocks.format.mockClear();
  nativeMocks.announceForAccessibility.mockClear();
});

describe("MobileCrashBoundary", () => {
  it("retains render failure details and lets the operator retry", async () => {
    let shouldThrow = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Child() {
      if (shouldThrow) throw new Error("render exploded");
      return React.createElement("Text", null, "Recovered");
    }

    await act(async () => {
      rendered = create(
        <MobileCrashBoundary>
          <Child />
        </MobileCrashBoundary>
      );
    });

    expect(diagnosticMocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "react-render-error",
        message: "Error: render exploded"
      })
    );
    expect(
      rendered.root.findAllByType("Text").flatMap((node) => node.children)
    ).toContain(
      "Diagnostic diagnostic-123 was captured and can be copied below."
    );

    shouldThrow = false;
    await act(async () => {
      rendered?.root.findByProps({ accessibilityLabel: "Retry" }).props.onPress();
      await Promise.resolve();
    });

    expect(
      rendered.root.findAllByType("Text").flatMap((node) => node.children).join("|")
    ).toBe("Recovered");
    consoleError.mockRestore();
  });

  it("retains an exportable diagnostic when the child throws again after retry", async () => {
    const copyDiagnostic = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    diagnosticMocks.capture
      .mockReturnValueOnce({ id: "diagnostic-first" })
      .mockReturnValueOnce({ id: "diagnostic-after-retry" });
    function Child() {
      throw new Error("still broken");
    }

    await act(async () => {
      rendered = create(
        <MobileCrashBoundary copyDiagnostic={copyDiagnostic}>
          <Child />
        </MobileCrashBoundary>
      );
    });
    await act(async () => {
      rendered?.root.findByProps({ accessibilityLabel: "Retry" }).props.onPress();
      await Promise.resolve();
    });

    expect(diagnosticMocks.capture).toHaveBeenCalledTimes(2);
    expect(
      rendered.root.findAllByType("Text").flatMap((node) => node.children)
    ).toContain(
      "Diagnostic diagnostic-after-retry was captured and can be copied below."
    );

    await act(async () => {
      rendered?.root
        .findByProps({ accessibilityLabel: "Copy crash diagnostics" })
        .props.onPress();
      await Promise.resolve();
    });

    expect(diagnosticMocks.format).toHaveBeenCalledWith([
      { id: "diagnostic-after-retry" }
    ]);
    expect(copyDiagnostic).toHaveBeenCalledWith(
      '[{"id":"diagnostic-after-retry"}]'
    );
    expect(
      rendered.root.findAllByType("Text").flatMap((node) => node.children)
    ).toContain("Diagnostics copied");
    expect(
      rendered.root.findByProps({ accessibilityLabel: "Diagnostics copied" })
        .props.accessibilityRole
    ).toBe("button");
    expect(
      rendered.root.findByProps({ accessibilityLiveRegion: "polite" }).children
    ).toContain("Diagnostics copied");
    expect(
      rendered.root.findByProps({ accessibilityLiveRegion: "polite" }).props
        .accessibilityRole
    ).toBe("alert");
    expect(nativeMocks.announceForAccessibility).toHaveBeenCalledWith(
      "Diagnostics copied"
    );
    consoleError.mockRestore();
  });

  it("keeps clipboard feedback scoped to the diagnostic and latest request", async () => {
    let resolveFirstCopy: (() => void) | null = null;
    const firstCopy = new Promise<void>((resolve) => {
      resolveFirstCopy = resolve;
    });
    let rejectSecondCopy: ((reason: unknown) => void) | null = null;
    const secondCopy = new Promise<void>((_resolve, reject) => {
      rejectSecondCopy = reject;
    });
    const copyDiagnostic = vi
      .fn<(value: string) => Promise<void>>()
      .mockReturnValueOnce(firstCopy)
      .mockReturnValueOnce(secondCopy);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    diagnosticMocks.capture
      .mockReturnValueOnce({ id: "diagnostic-a" })
      .mockReturnValueOnce({ id: "diagnostic-b" });
    let failureMessage = "failure A";
    function Child() {
      throw new Error(failureMessage);
    }

    await act(async () => {
      rendered = create(
        <MobileCrashBoundary copyDiagnostic={copyDiagnostic}>
          <Child />
        </MobileCrashBoundary>
      );
    });
    act(() => {
      rendered?.root
        .findByProps({ accessibilityLabel: "Copy crash diagnostics" })
        .props.onPress();
    });

    failureMessage = "failure B";
    await act(async () => {
      rendered?.root.findByProps({ accessibilityLabel: "Retry" }).props.onPress();
      await Promise.resolve();
    });
    act(() => {
      rendered?.root
        .findByProps({ accessibilityLabel: "Copy crash diagnostics" })
        .props.onPress();
    });
    await act(async () => {
      rejectSecondCopy?.(new Error("clipboard unavailable"));
      await secondCopy.catch(() => undefined);
    });

    expect(
      rendered.root.findByProps({
        accessibilityLabel: "Copy failed — try again"
      }).props.accessibilityRole
    ).toBe("button");
    expect(
      rendered.root.findByProps({ accessibilityLiveRegion: "polite" }).children
    ).toContain("Copy failed — try again");
    expect(
      rendered.root.findByProps({ accessibilityLiveRegion: "polite" }).props
        .accessibilityRole
    ).toBe("alert");
    expect(nativeMocks.announceForAccessibility).toHaveBeenCalledWith(
      "Copy failed — try again"
    );

    await act(async () => {
      resolveFirstCopy?.();
      await firstCopy;
    });

    expect(
      rendered.root.findByProps({
        accessibilityLabel: "Copy failed — try again"
      }).props.accessibilityRole
    ).toBe("button");
    expect(
      rendered.root.findByProps({ accessibilityLiveRegion: "polite" }).children
    ).toContain("Copy failed — try again");
    expect(nativeMocks.announceForAccessibility).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });
});
