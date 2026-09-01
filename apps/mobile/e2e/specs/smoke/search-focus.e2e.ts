import type { Browser } from "webdriverio";
import { selectors } from "../../helpers/selectors";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

interface SearchFocusElement {
  click(): Promise<unknown>;
  getAttribute?(name: string): Promise<string | null>;
  isExisting(): Promise<boolean>;
  setValue?(value: string): Promise<unknown>;
  waitForDisplayed(options: { timeout: number }): Promise<unknown>;
}

export interface SearchFocusUi {
  captureTaskIdSearch?(): Promise<void>;
  getSearchInput(): Promise<SearchFocusElement>;
  getSearchKeyboardDismissTarget(): Promise<SearchFocusElement>;
  getSearchScreen(): Promise<SearchFocusElement>;
  getSearchToolbarButton(): Promise<SearchFocusElement>;
  getTaskResult(taskId: string): Promise<SearchFocusElement>;
  getTasksScreen(): Promise<SearchFocusElement>;
  getTasksTab(): Promise<SearchFocusElement>;
  isKeyboardShown(): Promise<boolean>;
  isSearchInputFocused(): Promise<boolean>;
  waitUntil(
    condition: () => Promise<boolean>,
    options: {
      interval: number;
      timeout: number;
      timeoutMsg: string;
    }
  ): Promise<unknown>;
}

export async function runSearchFocusJourney(
  ui: SearchFocusUi,
  taskId?: string,
  stopAfterTaskIdSearch = false
): Promise<void> {
  const searchButton = await ui.getSearchToolbarButton();
  await searchButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await searchButton.click();

  const searchScreen = await ui.getSearchScreen();
  await searchScreen.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  const searchInput = await ui.getSearchInput();
  await searchInput.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await waitForSearchFocus(ui, {
    focused: true,
    timeoutMsg:
      "Expected Search tasks input to have native focus and show keyboard after toolbar Search tap"
  });

  if (taskId) {
    await verifyTaskIdSearch(ui, taskId);
    await ui.captureTaskIdSearch?.();
    if (stopAfterTaskIdSearch) return;
  }

  await dismissSearchKeyboard(ui);

  const searchScreenAfterDismissal = await ui.getSearchScreen();
  await searchScreenAfterDismissal.waitForDisplayed({
    timeout: SCREEN_TIMEOUT_MS
  });

  const repeatedSearchButton = await ui.getSearchToolbarButton();
  await repeatedSearchButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await repeatedSearchButton.click();
  await waitForSearchFocus(ui, {
    focused: true,
    timeoutMsg:
      "Expected Search tasks input to regain native focus and show keyboard after second toolbar Search tap"
  });

  await dismissSearchKeyboard(ui);

  const tasksTab = await ui.getTasksTab();
  await tasksTab.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await tasksTab.click();
  const tasksScreen = await ui.getTasksScreen();
  await tasksScreen.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
}

async function verifyTaskIdSearch(
  ui: SearchFocusUi,
  taskId: string
): Promise<void> {
  const searchInput = await ui.getSearchInput();
  if (!searchInput.setValue) {
    throw new Error("Search input does not support setting a task ID query");
  }
  await searchInput.setValue(taskId.slice(0, 5));

  const result = await ui.getTaskResult(taskId);
  await result.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  const label = await result.getAttribute?.("label");
  if (!label?.includes(`Task ID ${taskId}`)) {
    throw new Error(`Expected task ID search result to render ${JSON.stringify(taskId)}`);
  }
}

async function dismissSearchKeyboard(ui: SearchFocusUi): Promise<void> {
  const dismissTarget = await ui.getSearchKeyboardDismissTarget();
  await dismissTarget.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await dismissTarget.click();
  await waitForSearchFocus(ui, {
    focused: false,
    timeoutMsg:
      "Expected Search tasks input to lose native focus after keyboard dismissal"
  });
}

async function waitForSearchFocus(
  ui: SearchFocusUi,
  options: { focused: boolean; timeoutMsg: string }
): Promise<void> {
  await ui.waitUntil(
    async () => {
      const input = await ui.getSearchInput();
      if (!(await input.isExisting())) return false;

      const focused = await ui.isSearchInputFocused();
      const keyboardShown = await ui.isKeyboardShown();
      return focused === options.focused && keyboardShown === options.focused;
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: options.timeoutMsg
    }
  );
}

function createSearchFocusUi(
  driver: Browser,
  screenshotPath?: string
): SearchFocusUi {
  return {
    async captureTaskIdSearch() {
      if (screenshotPath) await driver.saveScreenshot(screenshotPath);
    },
    async getSearchInput() {
      return driver.$(selectors.searchInput);
    },
    async getSearchKeyboardDismissTarget() {
      return driver.$(selectors.searchKeyboardDismissTarget);
    },
    async getSearchScreen() {
      return driver.$(selectors.searchScreen);
    },
    async getSearchToolbarButton() {
      return driver.$(selectors.searchToolbarButton);
    },
    async getTaskResult(taskId) {
      return driver.$(selectors.taskResult(taskId));
    },
    async getTasksScreen() {
      return driver.$(selectors.tasksScreen);
    },
    async getTasksTab() {
      return driver.$(selectors.tasksTab);
    },
    async isKeyboardShown() {
      return driver.isKeyboardShown();
    },
    async isSearchInputFocused() {
      const input = await driver.$(selectors.searchInput);
      const activeElement = await driver.getActiveElement().catch(() => null);
      return (await input.elementId) === elementReferenceId(activeElement);
    },
    async waitUntil(condition, options) {
      return driver.waitUntil(condition, options);
    }
  };
}

function elementReferenceId(reference: unknown): string | null {
  if (!reference || typeof reference !== "object") return null;
  const element = reference as Record<string, unknown>;
  for (const key of ["element-6066-11e4-a52e-4f735466cecf", "ELEMENT"]) {
    if (typeof element[key] === "string") return element[key];
  }
  return null;
}

export async function runSearchFocusSmoke(
  driver: Browser,
  options: {
    screenshotPath?: string;
    stopAfterTaskIdSearch?: boolean;
    taskId?: string;
  } = {}
): Promise<void> {
  const appShell = await driver.$(selectors.appShell);
  await appShell.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await runSearchFocusJourney(
    createSearchFocusUi(driver, options.screenshotPath),
    options.taskId,
    options.stopAfterTaskIdSearch
  );
}
