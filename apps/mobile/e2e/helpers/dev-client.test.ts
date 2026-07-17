import type { Browser } from "webdriverio";
import { describe, expect, it, vi } from "vitest";
import { dismissExpoDevClientOverlays } from "./dev-client";

function createDriver(options: {
  continueVisible?: boolean;
  tasksDisplayed: boolean[];
}) {
  const waitForExist = vi.fn().mockResolvedValue(undefined);
  const waitForDisplayed = vi.fn().mockResolvedValue(undefined);
  const isDisplayed = vi
    .fn()
    .mockImplementation(() => Promise.resolve(options.tasksDisplayed.shift() ?? true));
  const click = vi.fn().mockResolvedValue(undefined);
  const getWindowSize = vi.fn().mockResolvedValue({ width: 402, height: 874 });
  const execute = vi.fn().mockResolvedValue(undefined);
  const $ = vi.fn().mockImplementation((selector: string) => {
    if (selector === "~mobile.toolbar.tab.tasks") {
      return { isDisplayed, waitForDisplayed, waitForExist };
    }
    if (selector === "~Continue") {
      return {
        click,
        isDisplayed: vi.fn().mockResolvedValue(options.continueVisible ?? false)
      };
    }
    throw new Error(`Unexpected selector: ${selector}`);
  });

  return {
    driver: { $, execute, getWindowSize } as unknown as Browser,
    mocks: { click, execute, getWindowSize, isDisplayed, waitForDisplayed, waitForExist }
  };
}

describe("dismissExpoDevClientOverlays", () => {
  it("leaves a visible Kanna shell untouched", async () => {
    const { driver, mocks } = createDriver({ tasksDisplayed: [true] });

    await dismissExpoDevClientOverlays(driver);

    expect(mocks.waitForExist).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("accepts first-launch onboarding before checking the shell again", async () => {
    const { driver, mocks } = createDriver({
      continueVisible: true,
      tasksDisplayed: [false, true]
    });

    await dismissExpoDevClientOverlays(driver);

    expect(mocks.click).toHaveBeenCalledTimes(1);
    expect(mocks.waitForDisplayed).toHaveBeenCalledWith({ timeout: 10_000 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("drags down the native developer-menu sheet when it hides the shell", async () => {
    const { driver, mocks } = createDriver({ tasksDisplayed: [false] });

    await dismissExpoDevClientOverlays(driver);

    expect(mocks.getWindowSize).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledWith("mobile: dragFromToForDuration", {
      duration: 0.5,
      fromX: 201,
      fromY: 297,
      toX: 201,
      toY: 743
    });
    expect(mocks.waitForDisplayed).toHaveBeenCalledWith({ timeout: 10_000 });
  });
});
