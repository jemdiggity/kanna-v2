import type { Browser } from "webdriverio";
import { selectors } from "../../helpers/selectors";
import {
  ensureTaskListVisible,
  waitForTaskTerminalLive
} from "../smoke/list-detail-back.e2e";
import { openProfileConnectionSheet } from "../smoke/profile-connection.e2e";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

interface CloudCredentials {
  email?: string;
  password?: string;
}

interface CloudElement {
  addValue(value: string): Promise<unknown>;
  click(): Promise<unknown>;
  getText(): Promise<string>;
  isExisting(): Promise<boolean>;
  setValue(value: string): Promise<unknown>;
  waitForDisplayed(options: { timeout: number }): Promise<unknown>;
}

interface CloudUi {
  getAccountButton(): Promise<CloudElement>;
  getAccountSheet(): Promise<CloudElement>;
  getBackButton(): Promise<CloudElement>;
  getConnectionTitle(): Promise<CloudElement>;
  getEmailInput(): Promise<CloudElement>;
  getPasswordInput(): Promise<CloudElement>;
  getSignInButton(): Promise<CloudElement>;
  getAgentMessageView(): Promise<CloudElement>;
  getAgentMessageReady(): Promise<CloudElement>;
  getTaskDetailScreen(): Promise<CloudElement>;
  getTerminalOverlay(): Promise<CloudElement>;
  getTaskRows(): Promise<CloudElement[]>;
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

function createCloudUi(driver: Browser): CloudUi {
  return {
    async getAccountButton() {
      return driver.$(selectors.accountButton);
    },
    async getAccountSheet() {
      return driver.$(selectors.accountSheet);
    },
    async getBackButton() {
      return driver.$(selectors.taskBackButton);
    },
    async getConnectionTitle() {
      return driver.$(selectors.accountConnectionTitle);
    },
    async getEmailInput() {
      return driver.$(selectors.accountEmailInput);
    },
    async getPasswordInput() {
      return driver.$(selectors.accountPasswordInput);
    },
    async getSignInButton() {
      return driver.$(selectors.accountSignInButton);
    },
    async getAgentMessageView() {
      return driver.$(selectors.agentMessageView);
    },
    async getAgentMessageReady() {
      return driver.$(selectors.agentMessageReady);
    },
    async getTaskDetailScreen() {
      return driver.$(selectors.taskDetailScreen);
    },
    async getTerminalOverlay() {
      return driver.$(selectors.terminalOverlay);
    },
    async getTaskRows() {
      return Array.from(await driver.$$(selectors.taskRowsXPath));
    },
    async pause(ms) {
      return driver.pause(ms);
    },
    async waitUntil(condition, options) {
      return driver.waitUntil(condition, options);
    }
  };
}

async function signInToCloud(
  ui: CloudUi,
  credentials: Required<CloudCredentials>
): Promise<void> {
  await openProfileConnectionSheet(ui);

  const emailInput = await ui.getEmailInput();
  await emailInput.setValue(credentials.email);
  const passwordInput = await ui.getPasswordInput();
  await passwordInput.setValue(credentials.password);
  const signInButton = await ui.getSignInButton();
  await signInButton.click();

  await ui.waitUntil(
    async () => {
      const title = await ui.getConnectionTitle();
      return (await title.getText()).includes("Kanna Cloud");
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected force-cloud E2E to connect through Kanna Cloud instead of LAN"
    }
  );
}

function requireCloudCredentials(
  credentials: CloudCredentials
): Required<CloudCredentials> {
  if (!credentials.email || !credentials.password) {
    throw new Error(
      "KANNA_E2E_CLOUD_EMAIL and KANNA_E2E_CLOUD_PASSWORD are required for mobile cloud E2E."
    );
  }

  return {
    email: credentials.email,
    password: credentials.password
  };
}

export async function runCloudTaskFlow(
  driver: Browser,
  credentials: CloudCredentials
): Promise<void> {
  const resolvedCredentials = requireCloudCredentials(credentials);
  const ui = createCloudUi(driver);
  const appShell = await driver.$(selectors.appShell);
  await appShell.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });

  await signInToCloud(ui, resolvedCredentials);
  await ensureTaskListVisible(ui);

  const [firstTaskRow] = await driver.$$(selectors.taskRowsXPath);
  await firstTaskRow.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await firstTaskRow.click();
  await waitForTaskTerminalLive(ui);
}
