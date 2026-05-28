import { describe, expect, it } from "vitest";
import {
  getShellTitle,
  isTaskDetailVisible,
  shouldShowFloatingToolbar,
  shouldShowTopBar
} from "./appShell";

describe("isTaskDetailVisible", () => {
  it("treats a selected task outside More as the pushed detail screen", () => {
    expect(isTaskDetailVisible("task-1", "tasks")).toBe(true);
    expect(isTaskDetailVisible("task-1", "recent")).toBe(true);
    expect(isTaskDetailVisible("task-1", "more")).toBe(false);
    expect(isTaskDetailVisible(null, "tasks")).toBe(false);
  });
});

describe("shouldShowFloatingToolbar", () => {
  it("hides the toolbar only while task detail is visible", () => {
    expect(shouldShowFloatingToolbar("connected", "task-1", "tasks")).toBe(false);
    expect(shouldShowFloatingToolbar("connected", "task-1", "more")).toBe(true);
    expect(shouldShowFloatingToolbar("connected", null, "tasks")).toBe(true);
    expect(shouldShowFloatingToolbar("idle", null, "tasks")).toBe(true);
    expect(shouldShowFloatingToolbar("idle", "task-1", "tasks")).toBe(true);
  });
});

describe("shouldShowTopBar", () => {
  it("keeps profile access visible on the disconnected task list", () => {
    expect(shouldShowTopBar("idle", null, "tasks")).toBe(true);
    expect(shouldShowTopBar("error", null, "tasks")).toBe(true);
    expect(shouldShowTopBar("connected", "task-1", "tasks")).toBe(false);
  });
});

describe("getShellTitle", () => {
  it("uses task-specific copy instead of the product name for the default shell title", () => {
    expect(getShellTitle("tasks")).toBe("Tasks");
  });
});
