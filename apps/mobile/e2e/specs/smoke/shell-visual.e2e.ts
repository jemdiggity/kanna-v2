import type { Browser } from "webdriverio";
import {
  assertColorCoverage,
  decodePngScreenshot,
  isNonEmptyNativeRect,
  mapNativeRectToScreenshot,
  type NativeRect,
  type NativeSize
} from "../../helpers/native-shell-visual";
import { selectors } from "../../helpers/selectors";
import { waitFor } from "../../helpers/wait";

const SCREEN_TIMEOUT_MS = 30_000;
const CANVAS_COLOR = [8, 17, 30] as const;
const CHROME_COLOR = [8, 15, 27] as const;
const CHROME_BORDER_COLOR = [30, 48, 76] as const;

type ShellScreen = "tasks" | "recent" | "search" | "more";

export interface ShellVisualUi {
  captureScreen(screen: ShellScreen): Promise<void>;
  selectScreen(screen: ShellScreen): Promise<void>;
  waitForScreen(screen: ShellScreen): Promise<void>;
}

export async function exerciseShellVisualScreens(ui: ShellVisualUi): Promise<void> {
  await ui.waitForScreen("tasks");
  await ui.captureScreen("tasks");

  for (const screen of ["recent", "search", "more"] as const) {
    await ui.selectScreen(screen);
    await ui.waitForScreen(screen);
    await ui.captureScreen(screen);
  }

  await ui.selectScreen("tasks");
  await ui.waitForScreen("tasks");
}

function elementRect(driver: Browser, selector: string): Promise<NativeRect> {
  return waitFor(
    `non-empty native geometry for ${selector}`,
    async (recordReason) => {
      const describe = (error: unknown): null => {
        recordReason(error instanceof Error ? error.message : String(error));
        return null;
      };
      const element = await driver.$(selector);
      const location = await element.getLocation().catch(describe);
      const size = location ? await element.getSize().catch(describe) : null;
      const rect = location && size ? { ...location, ...size } : null;
      if (rect && isNonEmptyNativeRect(rect)) return rect;
      if (rect) recordReason(`element reported an empty rect ${JSON.stringify(rect)}`);
      return null;
    },
    { intervalMs: 100, timeoutMs: 5_000 }
  );
}

export function resolveShellScreenSelector(screen: ShellScreen): string {
  switch (screen) {
    case "recent":
      return selectors.recentScreen;
    case "search":
      return selectors.searchScreen;
    case "more":
      return selectors.moreScreen;
    case "tasks":
    default:
      return selectors.tasksScreen;
  }
}

function selectionSelector(screen: ShellScreen): string {
  switch (screen) {
    case "recent":
      return selectors.recentTab;
    case "search":
      return selectors.toolbarSearch;
    case "more":
      return selectors.moreTab;
    case "tasks":
    default:
      return selectors.tasksTab;
  }
}

async function assertRenderedShellColors(
  driver: Browser,
  screen: ShellScreen
): Promise<void> {
  const [shell, searchButton, navigation] = await Promise.all([
    elementRect(driver, selectors.appShell),
    elementRect(driver, selectors.toolbarSearch),
    elementRect(driver, selectors.toolbarNavigation)
  ]);
  const [screenshotBase64, windowSize] = await Promise.all([
    driver.takeScreenshot(),
    driver.getWindowSize()
  ]);
  const image = decodePngScreenshot(screenshotBase64);
  const nativeWindow: NativeSize = windowSize;
  const toScreenshotRect = (rect: NativeRect) =>
    mapNativeRectToScreenshot(rect, nativeWindow, image);

  const rightFormerCirclePatch: NativeRect = {
    x: shell.x + shell.width - 7,
    y: shell.y + 30,
    width: 5,
    height: Math.min(160, shell.height / 3)
  };
  const leftFormerCirclePatch: NativeRect = {
    x: shell.x + 2,
    y: shell.y + Math.max(0, shell.height - 320),
    width: 5,
    height: Math.min(140, shell.height / 4)
  };

  for (const [label, rect] of [
    ["upper-right former ambient-circle patch", rightFormerCirclePatch],
    ["lower-left former ambient-circle patch", leftFormerCirclePatch]
  ] as const) {
    assertColorCoverage({
      image,
      label: `${screen} ${label}`,
      minimumCoverage: 0.98,
      rect: toScreenshotRect(rect),
      expected: CANVAS_COLOR
    });
  }

  assertColorCoverage({
    image,
    label: `${screen} search utility chrome`,
    minimumCoverage: 0.25,
    rect: toScreenshotRect(searchButton),
    expected: CHROME_COLOR
  });
  assertColorCoverage({
    image,
    label: `${screen} navigation chrome`,
    minimumCoverage: 0.15,
    rect: toScreenshotRect(navigation),
    expected: CHROME_COLOR
  });
  assertColorCoverage({
    image,
    label: `${screen} navigation border`,
    minimumCoverage: 0.002,
    rect: toScreenshotRect(navigation),
    expected: CHROME_BORDER_COLOR
  });
}

export async function runShellVisualSmoke(driver: Browser): Promise<void> {
  await exerciseShellVisualScreens({
    async captureScreen(screen) {
      await assertRenderedShellColors(driver, screen);
    },
    async selectScreen(screen) {
      const control = await driver.$(selectionSelector(screen));
      await control.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
      await control.click();
    },
    async waitForScreen(screen) {
      const root = await driver.$(resolveShellScreenSelector(screen));
      await root.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
    }
  });
}
