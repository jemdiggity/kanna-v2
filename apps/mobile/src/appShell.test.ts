import { describe, expect, it } from "vitest";
import {
  getShellTitle,
  isTaskDetailVisible,
  shouldShowFloatingToolbar,
  shouldShowTopBar
} from "./appShell";

describe("isTaskDetailVisible", () => {
  it.each([
    [false, "connected", false, "tasks"],
    [false, "idle", true, "tasks"],
    [false, "connecting", true, "tasks"],
    [false, "error", true, "tasks"],
    [true, "connected", true, "tasks"],
    [true, "connected", true, "recent"],
    [false, "connected", true, "more"]
  ] as const)(
    "returns %s for connection=%s, resolved=%s, view=%s",
    (expected, connectionState, hasSelectedTask, activeView) => {
      expect(
        isTaskDetailVisible(connectionState, hasSelectedTask, activeView)
      ).toBe(expected);
    }
  );
});

describe("shouldShowFloatingToolbar", () => {
  it("is the inverse of resolved task detail visibility", () => {
    expect(shouldShowFloatingToolbar(false)).toBe(true);
    expect(shouldShowFloatingToolbar(true)).toBe(false);
  });
});

describe("shouldShowTopBar", () => {
  it("is the inverse of resolved task detail visibility", () => {
    expect(shouldShowTopBar(false)).toBe(true);
    expect(shouldShowTopBar(true)).toBe(false);
  });
});

describe("getShellTitle", () => {
  it("uses task-specific copy instead of the product name for the default shell title", () => {
    expect(getShellTitle("tasks")).toBe("Tasks");
  });
});
