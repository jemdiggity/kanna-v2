import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_BOTTOM_INSET,
  getTerminalBottomInset
} from "./terminalSafeArea";

describe("getTerminalBottomInset", () => {
  it("uses the one-line fallback until both native boundaries are measured", () => {
    expect(getTerminalBottomInset(0, null)).toBe(
      DEFAULT_TERMINAL_BOTTOM_INSET
    );
    expect(getTerminalBottomInset(Number.NaN, 676)).toBe(
      DEFAULT_TERMINAL_BOTTOM_INSET
    );
    expect(getTerminalBottomInset(800, null)).toBe(
      DEFAULT_TERMINAL_BOTTOM_INSET
    );
    expect(getTerminalBottomInset(800, Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_TERMINAL_BOTTOM_INSET
    );
  });

  it.each([
    ["normal", 676, 132],
    ["multiline", 596, 212],
    ["keyboard", 362, 446],
    ["keyboard multiline", 282, 526]
  ])(
    "measures the %s composer obstruction in the task-screen coordinate space",
    (_name, composerTop, expectedInset) => {
      expect(getTerminalBottomInset(800, composerTop)).toBe(expectedInset);
    }
  );

  it("rounds up fractional layout values and never returns a negative inset", () => {
    expect(getTerminalBottomInset(800.2, 676.1)).toBe(133);
    expect(getTerminalBottomInset(800, 900)).toBe(0);
  });
});
