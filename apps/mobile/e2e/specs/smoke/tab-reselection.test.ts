import { describe, expect, it, vi } from "vitest";
import { runTabReselectionJourney } from "./tab-reselection.e2e";

function createHarness() {
  let headingY = 91;
  let keyboardShown = false;
  let moreVisible = false;

  const heading = {
    click: vi.fn(async () => undefined),
    getLocation: vi.fn(async () => headingY),
    isDisplayed: vi.fn(async () => moreVisible && headingY >= 0),
    scrollIntoView: vi.fn(async () => undefined),
    waitForDisplayed: vi.fn(async () => undefined)
  };
  const buildInfoToggle = {
    click: vi.fn(async () => undefined),
    getLocation: vi.fn(async () => 700),
    isDisplayed: vi.fn(async () => moreVisible && headingY < 0),
    scrollIntoView: vi.fn(async () => {
      headingY = -420;
    }),
    waitForDisplayed: vi.fn(async () => undefined)
  };
  const moreScreen = {
    ...heading,
    waitForDisplayed: vi.fn(async () => undefined)
  };
  const searchInput = {
    ...heading,
    click: vi.fn(async () => {
      keyboardShown = true;
    })
  };
  const moreTab = {
    ...heading,
    click: vi.fn(async () => {
      if (moreVisible) {
        headingY = 91;
        keyboardShown = false;
      } else {
        moreVisible = true;
      }
    })
  };

  const ui = {
    getBuildInfoToggle: vi.fn(async () => buildInfoToggle),
    getMoreHeading: vi.fn(async () => heading),
    getMoreScreen: vi.fn(async () => moreScreen),
    getMoreSearchInput: vi.fn(async () => searchInput),
    getMoreTab: vi.fn(async () => moreTab),
    isKeyboardShown: vi.fn(async () => keyboardShown),
    waitUntil: vi.fn(
      async (
        condition: () => Promise<boolean>,
        options: { timeoutMsg: string }
      ) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }
    )
  };

  return { buildInfoToggle, moreTab, searchInput, ui };
}

describe("active bottom-tab reselection", () => {
  it("observes a real scroll-away, exact top restoration, and keyboard dismissal", async () => {
    const harness = createHarness();

    await runTabReselectionJourney(harness.ui);

    expect(harness.buildInfoToggle.scrollIntoView).toHaveBeenCalledWith({
      direction: "down",
      maxScrolls: 8
    });
    expect(harness.moreTab.click).toHaveBeenCalledTimes(3);
    expect(harness.searchInput.click).toHaveBeenCalledOnce();
    expect(harness.ui.isKeyboardShown).toHaveBeenCalled();
  });
});
