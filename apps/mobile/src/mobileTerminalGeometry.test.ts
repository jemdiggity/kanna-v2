import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOBILE_TERMINAL_GEOMETRY,
  resolveMobileTerminalGeometry
} from "./mobileTerminalGeometry";

describe("resolveMobileTerminalGeometry", () => {
  it("uses 80x48 for a phone-sized task detail surface", () => {
    expect(DEFAULT_MOBILE_TERMINAL_GEOMETRY).toEqual({ cols: 80, rows: 48 });
    expect(Object.isFrozen(DEFAULT_MOBILE_TERMINAL_GEOMETRY)).toBe(true);
    expect(resolveMobileTerminalGeometry({ width: 390, height: 844 })).toEqual({
      cols: 80,
      rows: 48
    });
  });

  it("expands the grid for an iPad-sized task detail surface", () => {
    expect(resolveMobileTerminalGeometry({ width: 1024, height: 1366 })).toEqual({
      cols: 128,
      rows: 72
    });
  });

  it("floors fractional cells instead of overflowing the viewport", () => {
    expect(resolveMobileTerminalGeometry({ width: 799.9, height: 1000.9 })).toEqual({
      cols: 99,
      rows: 51
    });
  });

  it.each([
    null,
    { width: 0, height: 844 },
    { width: 390, height: Number.NaN },
    { width: Number.POSITIVE_INFINITY, height: 844 }
  ])("falls back to 80x48 for an unusable layout: %o", (layout) => {
    expect(resolveMobileTerminalGeometry(layout)).toEqual({ cols: 80, rows: 48 });
  });
});
