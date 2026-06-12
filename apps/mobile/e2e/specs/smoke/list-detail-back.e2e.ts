import type { Browser } from "webdriverio";
import { selectors } from "../../helpers/selectors";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const BACK_NAVIGATION_SETTLE_MS = 500;

interface SmokeElement {
  click(): Promise<unknown>;
  isExisting(): Promise<boolean>;
}

interface SmokeUi {
  getAgentMessageView(): Promise<SmokeElement>;
  getBackButton(): Promise<SmokeElement>;
  getTerminalOverlay(): Promise<SmokeElement>;
  getTaskRows(): Promise<SmokeElement[]>;
  pause(ms: number): Promise<unknown>;
  waitUntil(
    condition: () => Promise<boolean>,
    options: {
      interval: number;
      timeout: number;
      timeoutMsg: string;
    }
  ): Promise<unknown>;
}

function createSmokeUi(driver: Browser): SmokeUi {
  return {
    async getAgentMessageView() {
      return driver.$(selectors.agentMessageView);
    },
    async getBackButton() {
      return driver.$(selectors.taskBackButton);
    },
    async getTerminalOverlay() {
      return driver.$(selectors.terminalOverlay);
    },
    async getTaskRows() {
      const taskRows = await driver.$$(selectors.taskRowsXPath);
      return Array.from(taskRows);
    },
    async pause(ms) {
      return driver.pause(ms);
    },
    async waitUntil(condition, options) {
      return driver.waitUntil(condition, options);
    }
  };
}

export async function waitForTaskTerminalLive(ui: SmokeUi): Promise<void> {
  await ui.waitUntil(
    async () => {
      const agentMessageView = await ui.getAgentMessageView();
      if (await agentMessageView.isExisting()) {
        return true;
      }
      const overlay = await ui.getTerminalOverlay();
      return !(await overlay.isExisting());
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected the mobile task terminal or agent view to become live after opening a task"
    }
  );
}

async function waitForTaskRows(ui: SmokeUi): Promise<void> {
  await ui.waitUntil(
    async () => {
      const taskRows = await ui.getTaskRows();
      return taskRows.length > 0;
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected at least one task row in the mobile task list"
    }
  );
}

export async function ensureTaskListVisible(ui: SmokeUi): Promise<void> {
  const backButton = await ui.getBackButton();
  if (await backButton.isExisting()) {
    await backButton.click();
    await ui.pause(BACK_NAVIGATION_SETTLE_MS);
  }

  await waitForTaskRows(ui);
}

export async function runListDetailBackSmoke(driver: Browser): Promise<void> {
  const ui = createSmokeUi(driver);
  const appShell = await driver.$(selectors.appShell);
  await appShell.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });

  await ensureTaskListVisible(ui);

  const [firstTaskRow] = await driver.$$(selectors.taskRowsXPath);
  await firstTaskRow.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await firstTaskRow.click();

  await driver.pause(1_000);
  await driver.waitUntil(
    async () => {
      const backButton = await driver.$(selectors.taskBackButton);
      return backButton.isExisting();
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected the task detail back button after opening a task"
    }
  );

  await waitForTaskTerminalLive(ui);

  const backButton = await driver.$(selectors.taskBackButton);
  await backButton.click();

  await driver.pause(BACK_NAVIGATION_SETTLE_MS);
  await waitForTaskRows(ui);
}
