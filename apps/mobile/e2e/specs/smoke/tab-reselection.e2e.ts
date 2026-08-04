import type { Browser } from "webdriverio";
import { selectors } from "../../helpers/selectors";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const TOP_OFFSET_TOLERANCE = 2;

interface TabReselectionElement {
  click(): Promise<unknown>;
  getLocation(axis: "y"): Promise<number>;
  isDisplayed(): Promise<boolean>;
  scrollIntoView(options: {
    direction: "down";
    maxScrolls: number;
  }): Promise<unknown>;
  waitForDisplayed(options: { timeout: number }): Promise<unknown>;
}

interface TabReselectionUi {
  getBuildInfoToggle(): Promise<TabReselectionElement>;
  getMoreHeading(): Promise<TabReselectionElement>;
  getMoreScreen(): Promise<TabReselectionElement>;
  getMoreSearchInput(): Promise<TabReselectionElement>;
  getMoreTab(): Promise<TabReselectionElement>;
  isKeyboardShown(): Promise<boolean>;
  waitUntil(
    condition: () => Promise<boolean>,
    options: { interval: number; timeout: number; timeoutMsg: string }
  ): Promise<unknown>;
}

export async function runTabReselectionJourney(
  ui: TabReselectionUi
): Promise<void> {
  const moreTab = await ui.getMoreTab();
  await moreTab.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await moreTab.click();
  await (await ui.getMoreScreen()).waitForDisplayed({
    timeout: SCREEN_TIMEOUT_MS
  });

  const heading = await ui.getMoreHeading();
  await heading.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  const topContentY = await heading.getLocation("y");

  const buildInfoToggle = await ui.getBuildInfoToggle();
  await buildInfoToggle.scrollIntoView({ direction: "down", maxScrolls: 8 });
  await ui.waitUntil(
    async () =>
      (await buildInfoToggle.isDisplayed()) && !(await heading.isDisplayed()),
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected the More view to be deliberately scrolled past its heading"
    }
  );

  await moreTab.click();
  await ui.waitUntil(
    async () =>
      (await heading.isDisplayed()) &&
      Math.abs((await heading.getLocation("y")) - topContentY) <=
        TOP_OFFSET_TOLERANCE,
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected active More tab reselection to restore the exact top content offset"
    }
  );

  const searchInput = await ui.getMoreSearchInput();
  await searchInput.click();
  await ui.waitUntil(() => ui.isKeyboardShown(), {
    interval: POLL_INTERVAL_MS,
    timeout: SCREEN_TIMEOUT_MS,
    timeoutMsg: "Expected the More search keyboard to open"
  });

  await moreTab.click();
  await ui.waitUntil(
    async () =>
      !(await ui.isKeyboardShown()) &&
      (await heading.isDisplayed()) &&
      Math.abs((await heading.getLocation("y")) - topContentY) <=
        TOP_OFFSET_TOLERANCE,
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected repeated top reselection to be harmless and dismiss the keyboard"
    }
  );
}

function createTabReselectionUi(driver: Browser): TabReselectionUi {
  return {
    getBuildInfoToggle: async () => driver.$(selectors.buildInfoToggle),
    getMoreHeading: async () => driver.$(selectors.moreHeading),
    getMoreScreen: async () => driver.$(selectors.moreScreen),
    getMoreSearchInput: async () => driver.$(selectors.moreSearchInput),
    getMoreTab: async () => driver.$(selectors.moreTab),
    isKeyboardShown: async () => driver.isKeyboardShown(),
    waitUntil: async (condition, options) => driver.waitUntil(condition, options)
  };
}

export async function runTabReselectionSmoke(driver: Browser): Promise<void> {
  const appShell = await driver.$(selectors.appShell);
  await appShell.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await runTabReselectionJourney(createTabReselectionUi(driver));
}
