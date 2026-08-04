import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const diagnosticMocks = vi.hoisted(() => ({
  capture: vi.fn(() => ({ id: "diagnostic-123" }))
}));

vi.mock("../lib/diagnostics/mobileCrashDiagnostics", () => ({
  captureMobileCrashDiagnostic: diagnosticMocks.capture
}));
vi.mock("react-native", () => ({
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
      "Diagnostic diagnostic-123 was captured. After retrying, open More → About this build to copy it."
    );

    shouldThrow = false;
    await act(async () => {
      rendered?.root.findByType("Pressable").props.onPress();
      await Promise.resolve();
    });

    expect(
      rendered.root.findAllByType("Text").flatMap((node) => node.children).join("|")
    ).toBe("Recovered");
    consoleError.mockRestore();
  });
});
