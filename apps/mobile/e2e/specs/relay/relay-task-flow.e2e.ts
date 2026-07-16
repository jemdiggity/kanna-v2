import type { Browser } from "webdriverio";
import { extractTaskRowId, selectors } from "../../helpers/selectors";
import {
  ensureTaskListVisible,
  inspectTerminalWebView,
  waitForRenderedPtyTerminal,
  waitForTaskTerminalLive,
  type PtyTerminalFixture
} from "../smoke/list-detail-back.e2e";
import { openProfileConnectionSheet } from "../smoke/profile-connection.e2e";
import type { TaskActivity } from "../../../src/lib/api/types";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const QUICK_REPLY_LABEL = "SGTM. Proceed.";
const QUICK_REPLY_MENU_TITLE = "Quick Replies";
const QUICK_REPLY_LONG_PRESS_MS = 800;
const TASK_COMPOSER_PLACEHOLDER = "Reply…";

interface RelayCredentials {
  email: string;
  password: string;
}

interface RelayTaskFlowOptions {
  credentials: RelayCredentials;
  emitFilePreviewLinks(): Promise<void>;
  filePreview: RelayFilePreviewFixture;
  draft: string;
  fixture: PtyTerminalFixture;
  prepareTaskUnreadForMarkRead(): Promise<void>;
  setTaskActivity(activity: TaskActivity): Promise<void>;
  taskRow: RelayTaskRowExpectation;
  waitForLocalTaskActivity(activity: TaskActivity): Promise<void>;
}

interface RelayFilePreviewFixture {
  expectedHeading: string;
  expectedRawLine: string;
  expectedRenderedText: string;
  line: number;
  missingLink: string;
  path: string;
  rawLink: string;
  renderedLink: string;
}

export interface RelayTaskRowExpectation {
  originalPromptSnippet: string;
  repoLabel: string;
  stage: string;
  title: string;
  waitingPromptSnippet: string;
}

interface RelayElement {
  addValue(value: string): Promise<unknown>;
  click(): Promise<unknown>;
  getAttribute(name: string): Promise<string | null>;
  getText(): Promise<string>;
  isExisting(): Promise<boolean>;
  longPress(options: { duration: number }): Promise<unknown>;
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
  getQuickRepliesMenuTitle(): Promise<RelayElement>;
  getQuickReplyOption(label: string): Promise<RelayElement>;
  getTaskInput(): Promise<RelayElement>;
  getTaskDetailScreen(): Promise<RelayElement>;
  getTaskDetailActivity(): Promise<RelayElement>;
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
  getNativeInspection?: () => Promise<string | null>;
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
    async getQuickRepliesMenuTitle() {
      return driver.$(`~${QUICK_REPLY_MENU_TITLE}`);
    },
    async getQuickReplyOption(label) {
      return driver.$(`~${label}`);
    },
    async getTaskInput() {
      return driver.$(selectors.taskInput);
    },
    async getTaskDetailScreen() {
      return driver.$(selectors.taskDetailScreen);
    },
    async getTaskDetailActivity() {
      return driver.$(selectors.taskDetailTitle);
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

export async function verifyRelayQuickReplyJourney(
  ui: Pick<
    RelayUi,
    | "getQuickRepliesMenuTitle"
    | "getQuickReplyOption"
    | "getTaskInput"
    | "getTaskSendButton"
    | "waitUntil"
  >,
  draft: string,
): Promise<void> {
  const input = await ui.getTaskInput();
  await input.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await input.setValue(draft);

  const send = await ui.getTaskSendButton();
  await send.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await send.longPress({ duration: QUICK_REPLY_LONG_PRESS_MS });

  const menuTitle = await ui.getQuickRepliesMenuTitle();
  await menuTitle.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  const quickReply = await ui.getQuickReplyOption(QUICK_REPLY_LABEL);
  await quickReply.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await quickReply.click();

  await ui.waitUntil(
    async () => {
      const value = await input.getAttribute("value").catch(() => null);
      return value === "" || value === TASK_COMPOSER_PLACEHOLDER;
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected the task composer to clear after selecting a quick reply",
    },
  );
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
    getNativeInspection: async () => {
      const marker = await driver.$(selectors.terminalInspection);
      return marker.getAttribute("value").catch(() => null);
    },
    switchContext: driver.switchContext
      ? async (context: string) => await driver.switchContext?.(context)
      : undefined
  };
}

function terminalFileLinkAccessibilityLabel(
  path: string,
  line?: number
): string {
  return line === undefined
    ? `Open file ${path}`
    : `Open file ${path} at line ${line}`;
}

export async function verifyTerminalFileLinksStayInline(
  driver: Browser,
  ui: Pick<RelayUi, "inspectTerminalWebView" | "waitUntil">,
  fixture: RelayFilePreviewFixture
): Promise<void> {
  const terminalPaths = [
    fixture.renderedLink,
    fixture.rawLink,
    fixture.missingLink
  ];
  let lastInspection: Awaited<ReturnType<RelayUi["inspectTerminalWebView"]>> | null = null;

  await ui.waitUntil(
    async () => {
      lastInspection = await ui.inspectTerminalWebView();
      return lastInspection.kind === "rendered" && terminalPaths.every(
        (path) => lastInspection?.kind === "rendered" && lastInspection.text.includes(path)
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: `Expected emitted file paths to remain visible inside xterm; last inspection ${JSON.stringify(lastInspection)}`
    }
  );

  for (const { path, line } of [
    { path: fixture.path, line: undefined },
    { path: fixture.path, line: fixture.line },
    { path: fixture.missingLink, line: undefined }
  ]) {
    const accessibilityLabel = terminalFileLinkAccessibilityLabel(path, line);
    const separateControl = await driver.$(`~${accessibilityLabel}`);
    if (await separateControl.isExisting().catch(() => false)) {
      throw new Error(
        `Expected ${accessibilityLabel} to stay inline, but found a separate native file-link control`
      );
    }
  }
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

export async function assertRelayTaskRowPresentation(
  row: Pick<RelayElement, "getAttribute" | "getText">,
  expected: RelayTaskRowExpectation,
): Promise<void> {
  const nativeLabel = await row.getAttribute("label").catch(() => null);
  const label = nativeLabel?.trim() || (await row.getText()).trim();
  const expectedLabel = [
    expected.title,
    expected.stage,
    expected.waitingPromptSnippet === expected.title
      ? null
      : expected.waitingPromptSnippet,
  ].filter(Boolean).join(". ");
  const forbidden = [
    expected.originalPromptSnippet,
    expected.repoLabel,
    "TASK",
    "RECENT",
  ];
  if (label !== expectedLabel || forbidden.some((value) => label.includes(value))) {
    throw new Error(
      `Relay task row rendered unexpected content: ${JSON.stringify(label)}; ` +
        `expected ${JSON.stringify(expectedLabel)}`,
    );
  }
}

export async function openRelayFixtureTask(
  ui: Pick<RelayUi, "getTaskRowById">,
  taskId: string,
  expected?: RelayTaskRowExpectation,
): Promise<void> {
  if (expected) {
    const task = await ui.getTaskRowById(taskId);
    await task.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
    await assertRelayTaskRowPresentation(task, expected);
    await task.click();
    return;
  }
  const task = await ui.getTaskRowById(taskId);
  await task.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await task.click();
}

async function returnToTaskListShell(ui: RelayUi): Promise<void> {
  const backButton = await ui.getBackButton();
  if (await backButton.isExisting().catch(() => false)) {
    await backButton.click();
    await ui.pause(500);
  }
}

async function waitForTaskActivity(
  ui: Pick<RelayUi, "getTaskRowById" | "getTaskRows" | "waitUntil">,
  taskId: string,
  expectedActivity: TaskActivity,
): Promise<void> {
  let lastObserved: string | null = null;
  try {
    await ui.waitUntil(
      async () => {
        const task = await ui.getTaskRowById(taskId);
        lastObserved = await task.getAttribute("value").catch(() => null);
        return lastObserved === expectedActivity;
      },
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg: `Expected relay task ${taskId} activity ${expectedActivity}`,
      },
    );
  } catch {
    const renderedTaskIds: string[] = [];
    for (const row of await ui.getTaskRows().catch(() => [])) {
      const name = await row.getAttribute("name").catch(() => null) ??
        await row.getAttribute("label").catch(() => null);
      const renderedTaskId = extractTaskRowId(name);
      if (renderedTaskId) renderedTaskIds.push(renderedTaskId);
    }
    throw new Error(
      `Expected relay task ${taskId} activity ${expectedActivity}; ` +
        `last native accessibility value was ${String(lastObserved)}; ` +
        `rendered task row ids were ${JSON.stringify(renderedTaskIds.sort())}`,
    );
  }
}

async function waitForSelectedTaskDetailActivity(
  ui: Pick<RelayUi, "getTaskDetailActivity" | "waitUntil">,
  expectedActivity: TaskActivity,
): Promise<void> {
  let lastObserved: string | null = null;
  try {
    await ui.waitUntil(
      async () => {
        const activity = await ui.getTaskDetailActivity();
        lastObserved = await activity.getAttribute("value").catch(() => null);
        return lastObserved === expectedActivity;
      },
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg: `Expected selected relay task activity ${expectedActivity}`,
      },
    );
  } catch {
    throw new Error(
      `Expected selected relay task activity ${expectedActivity}; ` +
        `last native accessibility value was ${String(lastObserved)}`,
    );
  }
}

export async function verifyRelayTaskActivityTransitions(
  ui: Pick<RelayUi, "getTaskRowById" | "getTaskRows" | "waitUntil">,
  taskId: string,
  setTaskActivity: (activity: "unread" | "idle") => Promise<void>,
): Promise<void> {
  await waitForTaskActivity(ui, taskId, "working");
  await setTaskActivity("unread");
  await waitForTaskActivity(ui, taskId, "unread");
  await setTaskActivity("idle");
  await waitForTaskActivity(ui, taskId, "idle");
}

export async function verifyRelayTaskMarkedRead(
  ui: Pick<RelayUi, "getTaskRowById" | "getTaskRows" | "waitUntil">,
  taskId: string,
  actions: {
    closeTask(): Promise<void>;
    openTask(): Promise<void>;
    prepareUnread(): Promise<void>;
    waitForOwnerIdle(): Promise<void>;
    waitForSelectedDetailIdle(): Promise<void>;
  },
): Promise<void> {
  await actions.prepareUnread();
  await waitForTaskActivity(ui, taskId, "unread");
  await actions.openTask();
  await actions.waitForOwnerIdle();
  await actions.waitForSelectedDetailIdle();
  await actions.closeTask();
  await waitForTaskActivity(ui, taskId, "idle");
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
  const exactTaskRow = await ui.getTaskRowById(options.fixture.taskId);
  await exactTaskRow.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await assertRelayTaskRowPresentation(exactTaskRow, options.taskRow);
  await verifyRelayTaskActivityTransitions(
    ui,
    options.fixture.taskId,
    options.setTaskActivity,
  );
  await verifyRelayTaskMarkedRead(ui, options.fixture.taskId, {
    prepareUnread: options.prepareTaskUnreadForMarkRead,
    async openTask() {
      await openRelayFixtureTask(ui, options.fixture.taskId);
      const backButton = await ui.getBackButton();
      await backButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
    },
    waitForOwnerIdle: () => options.waitForLocalTaskActivity("idle"),
    waitForSelectedDetailIdle: () => waitForSelectedTaskDetailActivity(ui, "idle"),
    closeTask: () => returnToTaskListShell(ui),
  });
  await openRelayFixtureTask(ui, options.fixture.taskId);
  await waitForTaskTerminalLive(ui);
  await waitForRenderedPtyTerminal(ui, options.fixture);
  await options.emitFilePreviewLinks();
  await verifyTerminalFileLinksStayInline(driver, ui, options.filePreview);

  await verifyRelayQuickReplyJourney(ui, options.draft);
}
