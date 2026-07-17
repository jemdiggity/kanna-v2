import type { Browser } from "webdriverio";

const APP_READY_TIMEOUT_MS = 30_000;
const OVERLAY_DISMISS_TIMEOUT_MS = 10_000;

/**
 * Wait for Kanna's native accessibility tree, then clear Expo UI that can
 * cover it on a freshly installed development client. The app-owned Tasks
 * tab is the readiness marker: it exists beneath Expo's sheet but is only
 * displayed after that sheet is gone.
 */
export async function dismissExpoDevClientOverlays(driver: Browser): Promise<void> {
  const tasksTab = await driver.$("~mobile.toolbar.tab.tasks");
  await tasksTab.waitForExist({ timeout: APP_READY_TIMEOUT_MS });
  if (await tasksTab.isDisplayed()) {
    return;
  }

  const continueButton = await driver.$("~Continue");
  const continueVisible = await continueButton.isDisplayed().catch(() => false);
  if (continueVisible) {
    await continueButton.click();
    const onboardingDismissed = await tasksTab
      .waitForDisplayed({ timeout: OVERLAY_DISMISS_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (onboardingDismissed) {
      return;
    }
  }

  const { width, height } = await driver.getWindowSize();
  const centerX = Math.round(width * 0.5);
  await driver.execute("mobile: dragFromToForDuration", {
    duration: 0.5,
    fromX: centerX,
    fromY: Math.round(height * 0.34),
    toX: centerX,
    toY: Math.round(height * 0.85)
  });
  await tasksTab.waitForDisplayed({ timeout: OVERLAY_DISMISS_TIMEOUT_MS });
}
