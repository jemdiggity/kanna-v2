import type { Browser } from "webdriverio";
import { selectors } from "../../helpers/selectors";
import {
  ensureTaskListVisible,
  openPtyFixtureTask,
  inspectTerminalWebView,
  waitForRenderedPtyTerminal,
  waitForTaskTerminalLive,
  type PtyTerminalFixture
} from "../smoke/list-detail-back.e2e";
import { openProfileConnectionSheet } from "../smoke/profile-connection.e2e";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

interface RelayCredentials {
  email: string;
  password: string;
}

interface RelayTaskFlowOptions {
  credentials: RelayCredentials;
  fixture: PtyTerminalFixture;
  input: string;
}

interface RelayElement {
  addValue(value: string): Promise<unknown>;
  click(): Promise<unknown>;
  getText(): Promise<string>;
  isExisting(): Promise<boolean>;
  setValue(value: string): Promise<unknown>;
  waitForDisplayed(options: { timeout: number }): Promise<unknown>;
}

interface RelayUi {
  getAccountButton(): Promise<RelayElement>;
  getAccountCloseButton(): Promise<RelayElement>;
  getAccountConnectionStatus(): Promise<RelayElement>;
  getAccountConnectionTitle(): Promise<RelayElement>;
  getAccountEmailInput(): Promise<RelayElement>;
  getAccountPasswordInput(): Promise<RelayElement>;
  getAccountSheet(): Promise<RelayElement>;
  getAccountSignInButton(): Promise<RelayElement>;
  getAccountSignOutButton(): Promise<RelayElement>;
  getAgentMessageView(): Promise<RelayElement>;
  getAgentMessageReady(): Promise<RelayElement>;
  getBackButton(): Promise<RelayElement>;
  getTaskInput(): Promise<RelayElement>;
  getTaskDetailScreen(): Promise<RelayElement>;
  getTaskRowById(taskId: string): Promise<RelayElement>;
  getTaskRows(): Promise<RelayElement[]>;
  getTaskSendButton(): Promise<RelayElement>;
  getTerminalOverlay(): Promise<RelayElement>;
  inspectTerminalWebView(): ReturnType<typeof inspectTerminalWebView>;
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

interface RelayWebViewContextDriver {
  execute<T>(script: () => T): Promise<T>;
  getContext?: () => Promise<string>;
  getContexts?: () => Promise<unknown[]>;
  switchContext?: (context: string) => Promise<unknown>;
}

async function dismissSavePasswordPrompt(driver: Browser): Promise<void> {
  for (const selector of [
    "~Not Now",
    '-ios predicate string:name == "Not Now" OR label == "Not Now"'
  ]) {
    const notNow = await driver.$(selector);
    const isVisible = await notNow
      .waitForDisplayed({ timeout: 2_500 })
      .then(() => true)
      .catch(() => false);
    if (isVisible) {
      await notNow.click();
      return;
    }
  }
}

async function isTaskVisible(ui: RelayUi, taskId: string): Promise<boolean> {
  const task = await ui.getTaskRowById(taskId);
  return task
    .waitForDisplayed({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

function createRelayUi(driver: Browser): RelayUi {
  return {
    async getAccountButton() {
      return driver.$(selectors.accountButton);
    },
    async getAccountCloseButton() {
      return driver.$(selectors.accountCloseButton);
    },
    async getAccountConnectionStatus() {
      return driver.$(selectors.accountConnectionStatus);
    },
    async getAccountConnectionTitle() {
      return driver.$(selectors.accountConnectionTitle);
    },
    async getAccountEmailInput() {
      return driver.$(selectors.accountEmailInput);
    },
    async getAccountPasswordInput() {
      return driver.$(selectors.accountPasswordInput);
    },
    async getAccountSheet() {
      return driver.$(selectors.accountSheet);
    },
    async getAccountSignInButton() {
      return driver.$(selectors.accountSignInButton);
    },
    async getAccountSignOutButton() {
      return driver.$(selectors.accountSignOutButton);
    },
    async getAgentMessageView() {
      return driver.$(selectors.agentMessageView);
    },
    async getAgentMessageReady() {
      return driver.$(selectors.agentMessageReady);
    },
    async getBackButton() {
      return driver.$(selectors.taskBackButton);
    },
    async getTaskInput() {
      return driver.$(selectors.taskInput);
    },
    async getTaskDetailScreen() {
      return driver.$(selectors.taskDetailScreen);
    },
    async getTaskRowById(taskId) {
      return driver.$(`~mobile.task-row.${taskId}`);
    },
    async getTaskRows() {
      return Array.from(await driver.$$(selectors.taskRowsXPath));
    },
    async getTaskSendButton() {
      return driver.$(selectors.taskSendButton);
    },
    async getTerminalOverlay() {
      return driver.$(selectors.terminalOverlay);
    },
    async inspectTerminalWebView() {
      return inspectTerminalWebView(createWebViewContextDriver(driver));
    },
    async pause(ms) {
      return driver.pause(ms);
    },
    async waitUntil(condition, options) {
      return driver.waitUntil(condition, options);
    }
  };
}

function createWebViewContextDriver(driver: Browser): RelayWebViewContextDriver {
  return {
    execute: async <T>(script: () => T) => {
      return await driver.execute(script) as T;
    },
    getContext: driver.getContext
      ? async () => String(await driver.getContext?.())
      : undefined,
    getContexts: driver.getContexts
      ? async () => await driver.getContexts?.() ?? []
      : undefined,
    switchContext: driver.switchContext
      ? async (context: string) => await driver.switchContext?.(context)
      : undefined
  };
}

async function isRelayConnected(driver: Browser, ui: RelayUi): Promise<boolean> {
  const title = await ui.getAccountConnectionTitle();
  const status = await ui.getAccountConnectionStatus();
  const titleText = await title.getText().catch(() => "");
  const statusText = await status.getText().catch(() => "");
  if (titleText.includes("Kanna Cloud") && /connected|online|relay/i.test(statusText)) {
    return true;
  }

  const cloudText = await driver.$('-ios predicate string:name == "Kanna Cloud" OR label == "Kanna Cloud"');
  const connectedText = await driver.$('-ios predicate string:name == "Connected" OR label == "Connected"');
  return await cloudText.isExisting().catch(() => false) &&
    await connectedText.isExisting().catch(() => false);
}

async function closeAccountSheet(driver: Browser, ui: RelayUi): Promise<void> {
  const closeButton = await ui.getAccountCloseButton();
  if (await closeButton.isExisting()) {
    await closeButton.click();
    await ui.pause(500);
    return;
  }
  const nativeCloseButton = await driver.$("~Close account");
  if (await nativeCloseButton.isExisting().catch(() => false)) {
    await nativeCloseButton.click();
    await ui.pause(500);
  }
}

async function openRelayFixtureTask(ui: RelayUi, taskId: string): Promise<void> {
  await openPtyFixtureTask(ui, taskId);
}

async function returnToTaskListShell(ui: RelayUi): Promise<void> {
  const backButton = await ui.getBackButton();
  if (await backButton.isExisting().catch(() => false)) {
    await backButton.click();
    await ui.pause(500);
  }
}

async function signInToRelay(
  driver: Browser,
  ui: RelayUi,
  credentials: RelayCredentials
): Promise<void> {
  await openProfileConnectionSheet(ui);

  const signOutButton = await ui.getAccountSignOutButton();
  if (await signOutButton.isExisting().catch(() => false)) {
    await signOutButton.click();
    await ui.pause(1_000);
  }

  const emailInput = await ui.getAccountEmailInput();
  await emailInput.setValue(credentials.email);
  const passwordInput = await ui.getAccountPasswordInput();
  await passwordInput.setValue(credentials.password);
  const signInButton = await ui.getAccountSignInButton();
  await signInButton.click();
  await dismissSavePasswordPrompt(driver);

  await ui.waitUntil(
    async () => {
      await dismissSavePasswordPrompt(driver);
      return await isRelayConnected(driver, ui);
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected mobile app to connect through the relay-backed cloud path"
    }
  );
  await closeAccountSheet(driver, ui);
}

export async function runRelayTaskFlow(
  driver: Browser,
  options: RelayTaskFlowOptions
): Promise<void> {
  const ui = createRelayUi(driver);
  await dismissSavePasswordPrompt(driver);
  const appShell = await driver.$(selectors.appShell);
  await appShell.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await returnToTaskListShell(ui);

  if (!(await isTaskVisible(ui, options.fixture.taskId))) {
    await signInToRelay(driver, ui, options.credentials);
  }
  await ensureTaskListVisible(ui);
  await openRelayFixtureTask(ui, options.fixture.taskId);
  await waitForTaskTerminalLive(ui);
  await waitForRenderedPtyTerminal(ui, options.fixture);

  const input = await ui.getTaskInput();
  await input.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await input.setValue(options.input);
  const send = await ui.getTaskSendButton();
  await send.click();
}
