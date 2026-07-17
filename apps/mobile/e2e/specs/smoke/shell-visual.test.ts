import { describe, expect, it, vi } from "vitest";
import { selectors } from "../../helpers/selectors";
import {
  exerciseShellVisualScreens,
  resolveShellScreenSelector
} from "./shell-visual.e2e";

describe("shell visual Appium flow", () => {
  it("waits on each screen root instead of its always-visible toolbar control", () => {
    expect(resolveShellScreenSelector("tasks")).toBe(selectors.tasksScreen);
    expect(resolveShellScreenSelector("recent")).toBe(selectors.recentScreen);
    expect(resolveShellScreenSelector("search")).toBe(selectors.searchScreen);
    expect(resolveShellScreenSelector("more")).toBe(selectors.moreScreen);
  });

  it("captures Tasks, Recent, Search, and More after each screen renders", async () => {
    const events: string[] = [];
    const selectScreen = vi.fn(async (screen: string) => {
      events.push(`select:${screen}`);
    });
    const waitForScreen = vi.fn(async (screen: string) => {
      events.push(`wait:${screen}`);
    });
    const captureScreen = vi.fn(async (screen: string) => {
      events.push(`capture:${screen}`);
    });

    await exerciseShellVisualScreens({
      captureScreen,
      selectScreen,
      waitForScreen
    });

    expect(events).toEqual([
      "wait:tasks",
      "capture:tasks",
      "select:recent",
      "wait:recent",
      "capture:recent",
      "select:search",
      "wait:search",
      "capture:search",
      "select:more",
      "wait:more",
      "capture:more",
      "select:tasks",
      "wait:tasks"
    ]);
  });
});
