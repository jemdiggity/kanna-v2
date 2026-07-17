import type { Browser } from "webdriverio";
import { extractTaskRowId, selectors } from "../../helpers/selectors";
import {
  ensureTaskListVisible,
  inspectTerminalWebView,
  waitForRenderedPtyTerminal,
  waitForTaskTerminalLive,
  type PtyTerminalFixture
} from "../smoke/list-detail-back.e2e";
import { openProfileSheet } from "../smoke/profile-connection.e2e";
import type { TaskActivity } from "../../../src/lib/api/types";
import type {
  MobileRelayCompanionFixture,
  RelayTaskOrderingFixture
} from "../../helpers/relay-harness";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const QUICK_REPLY_LABEL = "SGTM. Proceed.";
const QUICK_REPLY_MENU_TITLE = "Quick Replies";
const QUICK_REPLY_LONG_PRESS_MS = 800;
const TASK_COMPOSER_PLACEHOLDER = "Reply…";
const TASK_COMPOSER_MULTILINE_DRAFT =
  "First relay line.\nSecond relay line.\nThird relay line.";
const TASK_ACTION_MENU_TITLE = "Task Actions";
const TASK_ACTION_LABELS = ["Advance Stage", "Close Task", "Cancel"] as const;

interface RelayCredentials {
  email: string;
  password: string;
}

interface RelayTaskFlowOptions {
  companion: RelayVisualCompanionActions & {
    fixture: MobileRelayCompanionFixture;
  };
  credentials: RelayCredentials;
  emitFilePreviewLinks(): Promise<void>;
  filePreview: RelayFilePreviewFixture;
  draft: string;
  fixture: PtyTerminalFixture;
  prepareTaskUnreadForMarkRead(): Promise<void>;
  setTaskActivity(activity: TaskActivity): Promise<void>;
  taskRow: RelayTaskRowExpectation;
  taskOrdering: RelayTaskOrderingFixture;
  waitForLocalTaskActivity(activity: TaskActivity): Promise<void>;
}

interface RelayVisualCompanionActions {
  reconnect(): Promise<void>;
  replaceHtml(): Promise<void>;
  stop(): Promise<void>;
  waitForEvent(choice: string): Promise<unknown>;
}

interface RelayVisualCompanionUi {
  clickChoice(choice: string): Promise<void>;
  close(): Promise<void>;
  open(): Promise<void>;
  readDocumentText(): Promise<string>;
  waitForEnded(): Promise<void>;
  waitUntil(
    condition: () => Promise<boolean>,
    options: { interval: number; timeout: number; timeoutMsg: string }
  ): Promise<unknown>;
}

interface RelayFilePreviewFixture {
  expectedHeading: string;
  expectedHighlightedToken: string;
  expectedHighlightedTokenClass: string;
  expectedRawLine: string;
  expectedRenderedText: string;
  line: number;
  missingLink: string;
  nonMarkdownLinks: readonly string[];
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
  getSize(): Promise<{ height: number; width: number }>;
  getText(): Promise<string>;
  isExisting(): Promise<boolean>;
  longPress(options: { duration: number }): Promise<unknown>;
  setValue(value: string): Promise<unknown>;
  waitForDisplayed(options: { timeout: number }): Promise<unknown>;
}

interface RelayUi {
  getAccountButton(): Promise<RelayElement>;
  getAccountCloseButton(): Promise<RelayElement>;
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
  getTaskActionMenuTitle(): Promise<RelayElement>;
  getTaskActionOption(label: string): Promise<RelayElement>;
  getTaskInput(): Promise<RelayElement>;
  getTaskDetailScreen(): Promise<RelayElement>;
  getTaskDetailActivity(): Promise<RelayElement>;
  getTaskMoreButton(): Promise<RelayElement>;
  getTaskRowById(taskId: string): Promise<RelayElement>;
  getTaskRows(): Promise<RelayElement[]>;
  getTasksTab(): Promise<RelayElement>;
  getTaskSendButton(): Promise<RelayElement>;
  getTerminalOverlay(): Promise<RelayElement>;
  inspectTerminalWebView(): ReturnType<typeof inspectTerminalWebView>;
  isKeyboardShown(): Promise<boolean>;
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

interface TaskFilePreviewInspection {
  content: string;
  initialLine: number | null;
  mode: "raw" | "rendered";
  path: string;
}

export type TaskFilePreviewWebViewInspection =
  | {
      kind: "rendered";
      path: string;
      tokenClass: string;
      tokenColor: string;
      tokenHeight: number;
      tokenText: string;
      tokenWidth: number;
      unhighlightedColor: string;
    }
  | {
      animationName: string;
      flashStarted: boolean;
      kind: "raw";
      line: number | null;
      overlayHeight: number;
      overlayTop: number;
      overlayWidth: number;
      path: string;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

interface RelayPtySnapshotRevisitJourney {
  closeTask(): Promise<void>;
  openTask(): Promise<void>;
  waitForRenderedTerminal(): Promise<void>;
}

interface RelayTaskJourneys {
  verifyComposerReset(): Promise<void>;
  verifyFilePreview(): Promise<void>;
  verifyMarkedRead(): Promise<void>;
  verifyPtySnapshotRevisit(): Promise<void>;
  verifyQuickReply(): Promise<void>;
  verifyTaskActionMenu(): Promise<void>;
  verifyVisualCompanion(): Promise<void>;
}

export async function runRelayTaskJourneys(
  journeys: RelayTaskJourneys,
): Promise<void> {
  await journeys.verifyMarkedRead();
  await journeys.verifyPtySnapshotRevisit();
  await journeys.verifyTaskActionMenu();
  await journeys.verifyVisualCompanion();
  await journeys.verifyFilePreview();
  await journeys.verifyComposerReset();
  await journeys.verifyQuickReply();
}

export async function verifyRelayPtySnapshotRevisit(
  journey: RelayPtySnapshotRevisitJourney,
): Promise<void> {
  await journey.openTask();
  await journey.waitForRenderedTerminal();
  await journey.closeTask();
  await journey.openTask();
  await journey.waitForRenderedTerminal();
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
    async getTaskActionMenuTitle() {
      return driver.$(`~${TASK_ACTION_MENU_TITLE}`);
    },
    async getTaskActionOption(label) {
      return driver.$(`~${label}`);
    },
    async getTaskInput() {
      return driver.$(selectors.taskInput);
    },
    async getTaskDetailScreen() {
      return driver.$(selectors.taskDetailScreen);
    },
    async getTaskDetailActivity() {
      return driver.$(selectors.taskTitleButton);
    },
    async getTaskMoreButton() {
      return driver.$(selectors.taskMoreButton);
    },
    async getTaskRowById(taskId) {
      return driver.$(`~mobile.task-row.${taskId}`);
    },
    async getTaskRows() {
      return Array.from(await driver.$$(selectors.taskRowsXPath));
    },
    async getTasksTab() {
      return driver.$(selectors.tasksTab);
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
    async isKeyboardShown() {
      return driver.isKeyboardShown();
    },
    async pause(ms) {
      return driver.pause(ms);
    },
    async waitUntil(condition, options) {
      return driver.waitUntil(condition, options);
    }
  };
}

export async function verifyRelayTaskActionMenuJourney(
  ui: Pick<
    RelayUi,
    | "getTaskActionMenuTitle"
    | "getTaskActionOption"
    | "getTaskMoreButton"
  >,
): Promise<void> {
  const taskMore = await ui.getTaskMoreButton();
  await taskMore.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await taskMore.click();

  const menuTitle = await ui.getTaskActionMenuTitle();
  await menuTitle.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  for (const label of TASK_ACTION_LABELS) {
    const option = await ui.getTaskActionOption(label);
    await option.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
    if (label === "Cancel") {
      await option.click();
    }
  }

  await taskMore.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
}

export async function verifyRelayComposerResetJourney(
  ui: Pick<
    RelayUi,
    | "getTaskInput"
    | "getTaskSendButton"
    | "isKeyboardShown"
    | "waitUntil"
  >,
): Promise<void> {
  const input = await ui.getTaskInput();
  await input.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  const initialHeight = (await input.getSize()).height;

  await input.click();
  await input.setValue(TASK_COMPOSER_MULTILINE_DRAFT);

  let expandedHeight = initialHeight;
  await ui.waitUntil(
    async () => {
      expandedHeight = (await input.getSize()).height;
      return expandedHeight > initialHeight && await ui.isKeyboardShown();
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected the multiline task composer to expand with the software keyboard shown",
    },
  );

  const send = await ui.getTaskSendButton();
  await send.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await send.click();

  await ui.waitUntil(
    async () => {
      const value = await input.getAttribute("value").catch(() => null);
      const label = value === null
        ? await input.getAttribute("label").catch(() => null)
        : null;
      const resetHeight = (await input.getSize()).height;
      const cleared =
        value === "" ||
        value === TASK_COMPOSER_PLACEHOLDER ||
        label === TASK_COMPOSER_PLACEHOLDER;

      return (
        cleared &&
        resetHeight <= initialHeight &&
        resetHeight < expandedHeight &&
        !(await ui.isKeyboardShown())
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected Send to clear, return to one-line height, and hide the keyboard",
    },
  );
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
      if (value === "" || value === TASK_COMPOSER_PLACEHOLDER) {
        return true;
      }
      if (value !== null) {
        return false;
      }

      const label = await input.getAttribute("label").catch(() => null);
      return label === TASK_COMPOSER_PLACEHOLDER;
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

async function withVisualCompanionWebView<T>(
  driver: Browser,
  action: () => Promise<T>
): Promise<T> {
  if (!driver.getContexts || !driver.switchContext) {
    throw new Error("Appium did not expose WebView context switching");
  }
  const previousContext = driver.getContext
    ? String(await driver.getContext())
    : "NATIVE_APP";
  const contexts = Array.from(await driver.getContexts()).map(String);
  try {
    for (const context of contexts) {
      if (!context.includes("WEBVIEW")) continue;
      await driver.switchContext(context);
      const isCompanion = await driver.execute(() =>
        Boolean(document.querySelector("#kanna-companion-bridge"))
      );
      if (isCompanion) return await action();
    }
  } finally {
    await driver.switchContext(previousContext);
  }
  throw new Error(
    `No visual companion WebView context was available. Contexts: ${contexts.join(", ")}`
  );
}

function createVisualCompanionUi(driver: Browser): RelayVisualCompanionUi {
  return {
    async open() {
      const button = await driver.$(selectors.visualCompanionButton);
      await button.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
      await button.click();
      const modal = await driver.$(selectors.visualCompanionModal);
      await modal.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
    },
    async close() {
      const close = await driver.$(selectors.visualCompanionClose);
      await close.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
      await close.click();
      await driver.waitUntil(
        async () =>
          !(await driver
            .$(selectors.visualCompanionModal)
            .isExisting()
            .catch(() => false)),
        {
          interval: POLL_INTERVAL_MS,
          timeout: SCREEN_TIMEOUT_MS,
          timeoutMsg: "Expected the visual companion modal to close"
        }
      );
    },
    async readDocumentText() {
      return withVisualCompanionWebView(driver, async () =>
        String(await driver.execute(() => document.body.innerText))
      );
    },
    async clickChoice(choice) {
      if (!/^[a-zA-Z0-9_-]+$/.test(choice)) {
        throw new Error(`Unsafe companion fixture choice ${JSON.stringify(choice)}`);
      }
      await withVisualCompanionWebView(driver, async () => {
        const element = await driver.$(`[data-choice="${choice}"]`);
        await element.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
        await element.click();
      });
    },
    waitForEnded: () =>
      expectNativeText(
        driver,
        selectors.visualCompanionStatus,
        "This visual companion has ended."
      ),
    waitUntil: (condition, options) => driver.waitUntil(condition, options)
  };
}

async function waitForCompanionMarker(
  ui: Pick<RelayVisualCompanionUi, "readDocumentText" | "waitUntil">,
  marker: string
): Promise<void> {
  let lastText = "";
  await ui.waitUntil(
    async () => {
      lastText = await ui.readDocumentText().catch(() => "");
      return lastText.includes(marker);
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        `Expected visual companion marker ${JSON.stringify(marker)}; ` +
        `last document text ${JSON.stringify(lastText)}`
    }
  );
}

export async function verifyRelayVisualCompanionJourney(
  ui: RelayVisualCompanionUi,
  fixture: MobileRelayCompanionFixture,
  actions: RelayVisualCompanionActions
): Promise<void> {
  await ui.open();
  await waitForCompanionMarker(ui, fixture.initialMarker);
  await ui.clickChoice(fixture.choice);
  await actions.waitForEvent(fixture.choice);

  await actions.replaceHtml();
  await waitForCompanionMarker(ui, fixture.updatedMarker);

  await actions.stop();
  await ui.waitForEnded();

  await actions.reconnect();
  await waitForCompanionMarker(ui, fixture.updatedMarker);
  await ui.close();
}

function terminalFileLinkAccessibilityLabel(
  path: string,
  line?: number
): string {
  return line === undefined
    ? `Open file ${path}`
    : `Open file ${path} at line ${line}`;
}

function webViewContextName(context: unknown): string | null {
  if (typeof context === "string") return context;
  if (!context || typeof context !== "object") return null;

  const record = context as Record<string, unknown>;
  for (const key of ["id", "name"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return null;
}

export async function inspectTaskFilePreviewWebView(
  driver: RelayWebViewContextDriver
): Promise<TaskFilePreviewWebViewInspection> {
  if (!driver.getContexts || !driver.switchContext) {
    return {
      kind: "unavailable",
      reason: "Appium driver does not expose WebView context APIs"
    };
  }

  const contexts = await driver.getContexts();
  const webViewContexts = contexts
    .map(webViewContextName)
    .filter(
      (context): context is string => Boolean(context?.includes("WEBVIEW"))
    );
  if (webViewContexts.length === 0) {
    return {
      kind: "unavailable",
      reason: `No WEBVIEW context was available. Contexts: ${contexts
        .map(webViewContextName)
        .filter(Boolean)
        .join(", ") || "<none>"}`
    };
  }

  const previousContext = driver.getContext ? await driver.getContext() : null;
  let inspection: Exclude<
    TaskFilePreviewWebViewInspection,
    { kind: "unavailable" }
  > | null = null;
  const failures: string[] = [];

  try {
    for (const context of webViewContexts) {
      try {
        await driver.switchContext(context);
        inspection = await driver.execute(() => {
          const path = document
            .querySelector<HTMLElement>(".document-path")
            ?.textContent?.trim();
          if (!path) return null;

          const raw = document.querySelector<HTMLElement>(".raw");
          if (raw) {
            const overlay = raw.querySelector<HTMLElement>(".raw-line");
            const bounds = overlay?.getBoundingClientRect();
            return {
              animationName: overlay ? getComputedStyle(overlay).animationName : "",
              flashStarted: overlay?.dataset.flashStarted === "true",
              kind: "raw" as const,
              line: overlay
                ? Number.parseInt(overlay.dataset.line ?? "", 10) || null
                : null,
              overlayHeight: bounds?.height ?? 0,
              overlayTop: bounds?.top ?? 0,
              overlayWidth: bounds?.width ?? 0,
              path
            };
          }

          const token = document.querySelector<HTMLElement>(
            '.markdown [class^="hljs-"], .markdown [class*=" hljs-"]'
          );
          if (!token) return null;
          const tokenBounds = token.getBoundingClientRect();
          const tokenClass = Array.from(token.classList).find((className) =>
            className.startsWith("hljs-")
          ) ?? "";
          const unhighlightedElement = token.closest("code") ?? token.parentElement;
          return {
            kind: "rendered" as const,
            path,
            tokenClass,
            tokenColor: getComputedStyle(token).color,
            tokenHeight: tokenBounds.height,
            tokenText: token.textContent ?? "",
            tokenWidth: tokenBounds.width,
            unhighlightedColor: unhighlightedElement
              ? getComputedStyle(unhighlightedElement).color
              : getComputedStyle(document.body).color
          };
        });
        if (inspection) break;
      } catch (error) {
        failures.push(
          `${context}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } finally {
    if (previousContext) await driver.switchContext(previousContext);
  }

  return inspection ?? {
    kind: "unavailable",
    reason:
      "No WebView document contained a rendered task file preview" +
      (failures.length > 0 ? ` (${failures.join("; ")})` : "")
  };
}

async function terminalFileLink(
  driver: Browser,
  path: string,
  line?: number
) {
  const link = await driver.$(`~${terminalFileLinkAccessibilityLabel(path, line)}`);
  await link.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  return link;
}

function terminalFileTarget(raw: string): { line?: number; path: string } {
  const match = raw.match(/^(.*?):(\d+)(?::\d+)?$/);
  return match
    ? { path: match[1], line: Number.parseInt(match[2], 10) }
    : { path: raw };
}

async function inspectTaskFilePreview(
  driver: Browser
): Promise<TaskFilePreviewInspection> {
  const marker = await driver.$(selectors.taskFilePreviewInspection);
  await marker.waitForExist({ timeout: SCREEN_TIMEOUT_MS });
  const value = await marker.getAttribute("value");
  if (!value) throw new Error("Task file preview inspection had no value");
  return JSON.parse(value) as TaskFilePreviewInspection;
}

async function expectNativeText(
  driver: Browser,
  selector: string,
  expected: string | RegExp
): Promise<void> {
  let lastText = "";
  await driver.waitUntil(
    async () => {
      const element = await driver.$(selector);
      if (!(await element.isExisting().catch(() => false))) return false;
      lastText = await element.getText().catch(() => "");
      return typeof expected === "string"
        ? lastText === expected
        : expected.test(lastText);
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: `Expected ${selector} to contain ${String(expected)}; last text ${JSON.stringify(lastText)}`
    }
  );
}

async function closeTaskFilePreview(driver: Browser): Promise<void> {
  const close = await driver.$(selectors.taskFilePreviewClose);
  await close.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await close.click();
  await driver.waitUntil(
    async () => {
      const path = await driver.$(selectors.taskFilePreviewPath);
      return !(await path.isExisting().catch(() => false));
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected task file preview to close"
    }
  );
}

// Xterm link hitboxes live inside a React Native WebView and are not exposed as
// XCUITest-native accessibility elements. The bridged native controls are the
// Appium-drivable inspection/activation surface; buildTerminalDocument tests
// separately exercise the exact xterm provider ranges and activation callback.
// True hitbox E2E would require E2E-only WebView instrumentation that reports
// provider ranges and activates a chosen row/cell through the native bridge.
export async function verifyTerminalMarkdownFileControls(
  driver: Browser,
  ui: Pick<RelayUi, "inspectTerminalWebView" | "waitUntil">,
  fixture: RelayFilePreviewFixture
): Promise<void> {
  const terminalPaths = [
    fixture.renderedLink,
    fixture.rawLink,
    fixture.missingLink,
    ...fixture.nonMarkdownLinks
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
    await terminalFileLink(driver, path, line);
  }

  for (const raw of fixture.nonMarkdownLinks) {
    const { path, line } = terminalFileTarget(raw);
    const accessibilityLabel = terminalFileLinkAccessibilityLabel(path, line);
    const control = await driver.$(`~${accessibilityLabel}`);
    if (await control.isExisting().catch(() => false)) {
      throw new Error(
        `Expected non-Markdown terminal path ${raw} to remain plain text, but found ${accessibilityLabel}`
      );
    }
  }
}

async function verifyTerminalFilePreviewFlow(
  driver: Browser,
  ui: Pick<RelayUi, "inspectTerminalWebView" | "waitUntil">,
  fixture: RelayFilePreviewFixture
): Promise<void> {
  await verifyTerminalMarkdownFileControls(driver, ui, fixture);
  const renderedLink = await terminalFileLink(driver, fixture.path);

  const [location, size] = await Promise.all([
    renderedLink.getLocation(),
    renderedLink.getSize()
  ]);
  const centerX = Math.round(location.x + size.width / 2);
  const centerY = Math.round(location.y + size.height / 2);
  await driver.actions([
    driver
      .action("pointer", { parameters: { pointerType: "touch" } })
      .move(centerX - 8, centerY)
      .down()
      .move({ duration: 650, x: centerX - 42, y: centerY })
      .up(),
    driver
      .action("pointer", { parameters: { pointerType: "touch" } })
      .move(centerX + 8, centerY)
      .down()
      .move({ duration: 650, x: centerX + 42, y: centerY })
      .up()
  ]);
  await driver
    .action("pointer", { parameters: { pointerType: "touch" } })
    .move(centerX + Math.min(60, size.width / 3), centerY)
    .down()
    .move({
      duration: 650,
      x: centerX - Math.min(60, size.width / 3),
      y: centerY
    })
    .up()
    .perform();
  await driver.pause(650);
  if (
    await driver.$(selectors.taskFilePreviewPath).isExisting().catch(() => false)
  ) {
    throw new Error("Scroll or pinch over a terminal file path opened the preview");
  }

  await (await terminalFileLink(driver, fixture.path)).click();
  await expectNativeText(driver, selectors.taskFilePreviewPath, fixture.path);
  await expectNativeText(driver, selectors.taskFilePreviewMode, "Rendered Markdown");
  let inspection = await inspectTaskFilePreview(driver);
  if (
    inspection.path !== fixture.path ||
    inspection.mode !== "rendered" ||
    !inspection.content.includes(`# ${fixture.expectedHeading}`) ||
    !inspection.content.includes(fixture.expectedRenderedText)
  ) {
    throw new Error(
      `Expected authenticated relay Markdown content in rendered preview; got ${JSON.stringify(inspection)}`
    );
  }
  let renderedWebView: TaskFilePreviewWebViewInspection = {
    kind: "unavailable",
    reason: "WebView inspection has not started"
  };
  try {
    await driver.waitUntil(
      async () => {
        renderedWebView = await inspectTaskFilePreviewWebView(
          createWebViewContextDriver(driver)
        );
        return (
          renderedWebView.kind === "rendered" &&
          renderedWebView.path === fixture.path &&
          renderedWebView.tokenClass === fixture.expectedHighlightedTokenClass &&
          renderedWebView.tokenText === fixture.expectedHighlightedToken &&
          Boolean(renderedWebView.tokenColor) &&
          renderedWebView.tokenColor !== renderedWebView.unhighlightedColor &&
          renderedWebView.tokenWidth > 0 &&
          renderedWebView.tokenHeight > 0
        );
      },
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg: "Expected rendered preview WebView syntax highlighting"
      }
    );
  } catch {
    throw new Error(
      `Expected rendered preview WebView syntax highlighting with a non-default computed color; got ${JSON.stringify(renderedWebView)}`
    );
  }
  await closeTaskFilePreview(driver);

  await (await terminalFileLink(driver, fixture.path, fixture.line)).click();
  await expectNativeText(driver, selectors.taskFilePreviewPath, fixture.path);
  await expectNativeText(driver, selectors.taskFilePreviewMode, "Raw source");
  inspection = await inspectTaskFilePreview(driver);
  if (
    inspection.mode !== "raw" ||
    inspection.initialLine !== fixture.line ||
    !inspection.content
      .split(/\r\n|\r|\n/)
      [fixture.line - 1]?.includes(fixture.expectedRawLine)
  ) {
    throw new Error(
      `Expected raw preview to target line ${fixture.line}; got ${JSON.stringify(inspection)}`
    );
  }
  let rawWebView: TaskFilePreviewWebViewInspection = {
    kind: "unavailable",
    reason: "WebView inspection has not started"
  };
  try {
    await driver.waitUntil(
      async () => {
        rawWebView = await inspectTaskFilePreviewWebView(
          createWebViewContextDriver(driver)
        );
        return (
          rawWebView.kind === "raw" &&
          rawWebView.path === fixture.path &&
          rawWebView.line === fixture.line &&
          rawWebView.flashStarted &&
          rawWebView.overlayWidth > 0 &&
          rawWebView.overlayHeight > 0 &&
          Number.isFinite(rawWebView.overlayTop)
        );
      },
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg: `Expected raw preview WebView line ${fixture.line}`
      }
    );
  } catch {
    throw new Error(
      `Expected raw preview WebView line ${fixture.line} to be laid out and flashed; got ${JSON.stringify(rawWebView)}`
    );
  }
  await closeTaskFilePreview(driver);

  await (await terminalFileLink(driver, fixture.missingLink)).click();
  await expectNativeText(driver, selectors.taskFilePreviewPath, fixture.missingLink);
  await expectNativeText(driver, selectors.taskFilePreviewError, "Couldn’t open file");
  await expectNativeText(
    driver,
    selectors.taskFilePreviewErrorMessage,
    /file not found/i
  );
  await closeTaskFilePreview(driver);
}

async function isRelaySignedIn(ui: RelayUi): Promise<boolean> {
  return (await ui.getAccountSignOutButton()).isExisting().catch(() => false);
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

async function renderedTaskRowIds(
  ui: Pick<RelayUi, "getTaskRows">,
): Promise<string[]> {
  const taskIds: string[] = [];
  for (const row of await ui.getTaskRows()) {
    const taskId = extractTaskRowId(
      await row.getAttribute("name").catch(() => null),
    );
    if (taskId) taskIds.push(taskId);
  }
  return taskIds;
}

export async function verifyTasksTabNewestFirst(
  ui: Pick<RelayUi, "getTasksTab" | "getTaskRows" | "waitUntil">,
  fixture: RelayTaskOrderingFixture,
): Promise<void> {
  const tasksTab = await ui.getTasksTab();
  await tasksTab.click();

  const fixtureIds = new Set(fixture.expectedVisualOrderTaskIds);
  let lastRenderedTaskIds: string[] = [];
  await ui.waitUntil(
    async () => {
      lastRenderedTaskIds = await renderedTaskRowIds(ui);
      return fixture.expectedVisualOrderTaskIds.every((taskId) =>
        lastRenderedTaskIds.includes(taskId)
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected both deterministic creation-order tasks on the Tasks tab",
    },
  );

  const actualVisualOrder = lastRenderedTaskIds.filter((taskId) =>
    fixtureIds.has(taskId)
  );
  if (
    actualVisualOrder.length !== fixture.expectedVisualOrderTaskIds.length ||
    actualVisualOrder.some(
      (taskId, index) => taskId !== fixture.expectedVisualOrderTaskIds[index],
    )
  ) {
    throw new Error(
      `Expected Tasks-tab creation order ${JSON.stringify(fixture.expectedVisualOrderTaskIds)}; ` +
        `source order was ${JSON.stringify(fixture.sourceOrderTaskIds)}; ` +
        `native visual order was ${JSON.stringify(actualVisualOrder)}`,
    );
  }
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
  await openProfileSheet(ui);

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
      return await isRelaySignedIn(ui);
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
  await verifyTasksTabNewestFirst(ui, options.taskOrdering);
  const exactTaskRow = await ui.getTaskRowById(options.fixture.taskId);
  await exactTaskRow.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await assertRelayTaskRowPresentation(exactTaskRow, options.taskRow);
  await verifyRelayTaskActivityTransitions(
    ui,
    options.fixture.taskId,
    options.setTaskActivity,
  );
  await runRelayTaskJourneys({
    verifyMarkedRead: () => verifyRelayTaskMarkedRead(ui, options.fixture.taskId, {
      prepareUnread: options.prepareTaskUnreadForMarkRead,
      async openTask() {
        await openRelayFixtureTask(ui, options.fixture.taskId);
        const backButton = await ui.getBackButton();
        await backButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
      },
      waitForOwnerIdle: () => options.waitForLocalTaskActivity("idle"),
      waitForSelectedDetailIdle: () => waitForSelectedTaskDetailActivity(ui, "idle"),
      closeTask: () => returnToTaskListShell(ui),
    }),
    verifyPtySnapshotRevisit: () => verifyRelayPtySnapshotRevisit({
      openTask: () => openRelayFixtureTask(ui, options.fixture.taskId),
      async waitForRenderedTerminal() {
        await waitForTaskTerminalLive(ui);
        await waitForRenderedPtyTerminal(ui, options.fixture);
      },
      closeTask: () => returnToTaskListShell(ui),
    }),
    verifyTaskActionMenu: () => verifyRelayTaskActionMenuJourney(ui),
    verifyVisualCompanion: () =>
      verifyRelayVisualCompanionJourney(
        createVisualCompanionUi(driver),
        options.companion.fixture,
        options.companion
      ),
    async verifyFilePreview() {
      await options.emitFilePreviewLinks();
      await verifyTerminalFilePreviewFlow(driver, ui, options.filePreview);
    },
    verifyComposerReset: () => verifyRelayComposerResetJourney(ui),
    verifyQuickReply: () => verifyRelayQuickReplyJourney(ui, options.draft),
  });
}
