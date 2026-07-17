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
  it("hides for task details and the self-contained Machines screen", () => {
    expect(shouldShowFloatingToolbar(false, "tasks")).toBe(true);
    expect(shouldShowFloatingToolbar(true, "tasks")).toBe(false);
    expect(shouldShowFloatingToolbar(false, "desktops")).toBe(false);
  });
});

describe("shouldShowTopBar", () => {
  it("hides for task details and the self-contained Machines screen", () => {
    expect(shouldShowTopBar(false, "tasks")).toBe(true);
    expect(shouldShowTopBar(true, "tasks")).toBe(false);
    expect(shouldShowTopBar(false, "desktops")).toBe(false);
  });
});

describe("getShellTitle", () => {
  it("uses task-specific copy instead of the product name for the default shell title", () => {
    expect(getShellTitle("tasks")).toBe("Tasks");
  });

  it("uses the product language for the machine inventory", () => {
    expect(getShellTitle("desktops")).toBe("Machines");
  });
});
