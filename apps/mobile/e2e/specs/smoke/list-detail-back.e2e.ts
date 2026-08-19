import type { Browser } from "webdriverio";
import {
  extractTaskRowId,
  selectors,
  tasksRepoSelector
} from "../../helpers/selectors";
import { DEFAULT_MOBILE_TERMINAL_GEOMETRY } from "../../../src/mobileTerminalGeometry";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const BACK_NAVIGATION_SETTLE_MS = 500;
const TEXT_SELECTION_LONG_PRESS_MS = 1_500;

// The old regression sliced a large base64 snapshot at 12,000 encoded chars,
// which can decode to at most about 9 KiB. Requiring 16 KiB decoded proves the
// smoke saw a full large snapshot instead of the capped mid-token fragment.
export const PTY_SNAPSHOT_MIN_DECODED_BYTES = 16_384;

interface SmokeElement {
  click(): Promise<unknown>;
  getAttribute?(name: string): Promise<string | null>;
  getSize?(): Promise<{ height: number; width: number }>;
  getText?(): Promise<string>;
  isDisplayed?(): Promise<boolean>;
  isEnabled?(): Promise<boolean>;
  isExisting(): Promise<boolean>;
  longPress?(options: { duration: number }): Promise<unknown>;
  waitForDisplayed?(options: { timeout: number }): Promise<unknown>;
}

interface TaskTerminalLiveUi {
  getAgentMessageView(): Promise<SmokeElement>;
  getAgentMessageReady?(): Promise<SmokeElement>;
  getTaskDetailScreen(): Promise<SmokeElement>;
  getTerminalOverlay(): Promise<SmokeElement>;
  waitUntil(
    condition: () => Promise<boolean>,
    options: {
      interval: number;
      timeout: number;
      timeoutMsg: string;
    }
  ): Promise<unknown>;
}

interface TaskListUi {
  getBackButton(): Promise<SmokeElement>;
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

interface ListDetailBackOriginUi {
  selectOrigin(origin: "tasks" | "recent"): Promise<void>;
  openTask(taskId: string): Promise<void>;
  goBack(): Promise<void>;
  assertOrigin(origin: "tasks" | "recent"): Promise<void>;
}

interface TaskPromptExpansionUi {
  getBackButton(): Promise<SmokeElement>;
  getClipboard(): Promise<string>;
  getCollapsedTaskId(): Promise<SmokeElement>;
  getCollapsedTitle(): Promise<SmokeElement>;
  getCopyMenuItem(): Promise<SmokeElement>;
  getExpandedPrompt(): Promise<SmokeElement>;
  getExpandedTaskId(): Promise<SmokeElement>;
  setClipboard(content: string): Promise<unknown>;
  getTitleButton(): Promise<SmokeElement>;
  getTitleDismissLayer(): Promise<SmokeElement>;
  waitUntil(
    condition: () => Promise<boolean>,
    options: {
      interval: number;
      timeout: number;
      timeoutMsg: string;
    }
  ): Promise<unknown>;
}

export interface TaskPromptFixture {
  expectedTitle: string;
  promptEndSentinel: string;
  taskId: string;
}

interface RenderedPtyTerminalUi extends TaskTerminalLiveUi {
  inspectTerminalWebView(): Promise<TerminalWebViewInspection>;
}

interface SmokeUi
  extends TaskListUi,
    RenderedPtyTerminalUi,
    PtyFixtureTaskUi,
    TaskPromptExpansionUi {}

export interface PtyTerminalFixture {
  taskId: string;
  sentinel: string;
  expectedCols: number;
  expectedRows: number;
  minDecodedBytes: number;
}

interface PtyFixtureTaskUi {
  getTaskRowById(taskId: string): Promise<SmokeElement>;
  waitUntil(
    condition: () => Promise<boolean>,
    options: {
      interval: number;
      timeout: number;
      timeoutMsg: string;
    }
  ): Promise<unknown>;
}

type TerminalWebViewInspection =
  | {
      kind: "rendered";
      byteCount: number;
      cols: number | null;
      frameCount: number;
      mentionedFiles?: {
        mentions: Array<{ line?: number; path: string; raw: string }>;
        overflow: boolean;
      };
      rows: number | null;
      text: string;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

interface WebViewContextDriver {
  execute<T>(script: () => T): Promise<T>;
  getNativeInspection?: () => Promise<string | null>;
  getContext?: () => Promise<string>;
  getContexts?: () => Promise<unknown[]>;
  switchContext?: (context: string) => Promise<unknown>;
}

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface MobileTaskPinSummary {
  id: string;
  repoId: string;
  pinned?: boolean;
  pinOrder?: number | null;
}

interface MobileTaskActivitySummary {
  id: string;
  activity?: string | null;
}

interface RunListDetailBackSmokeOptions {
  desktopServerUrl?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}

function createSmokeUi(driver: Browser): SmokeUi {
  return {
    async getAgentMessageView() {
      return driver.$(selectors.agentMessageView);
    },
    async getAgentMessageReady() {
      return driver.$(selectors.agentMessageReady);
    },
    async getTaskDetailScreen() {
      return driver.$(selectors.taskDetailScreen);
    },
    async getBackButton() {
      return driver.$(selectors.taskBackButton);
    },
    async getClipboard() {
      return driver.getClipboard("plaintext");
    },
    async getCollapsedTaskId() {
      return driver.$(selectors.taskDetailTaskId);
    },
    async getCollapsedTitle() {
      return driver.$(selectors.taskDetailTitle);
    },
    async getCopyMenuItem() {
      return driver.$("~Copy");
    },
    async getExpandedPrompt() {
      return driver.$(selectors.taskExpandedPrompt);
    },
    async getExpandedTaskId() {
      return driver.$(selectors.taskExpandedTaskId);
    },
    async setClipboard(content) {
      return driver.setClipboard(content, "plaintext");
    },
    async getTitleButton() {
      return driver.$(selectors.taskTitleButton);
    },
    async getTitleDismissLayer() {
      return driver.$(selectors.taskTitleDismissLayer);
    },
    async getTaskRowById(taskId) {
      return driver.$(`~mobile.task-row.${taskId}`);
    },
    async getTerminalOverlay() {
      return driver.$(selectors.terminalOverlay);
    },
    async getTaskRows() {
      const taskRows = await driver.$$(selectors.taskRowsXPath);
      return Array.from(taskRows);
    },
    async inspectTerminalWebView() {
      return inspectTerminalWebView({
        execute: async <T>(script: () => T) => await driver.execute(script) as T,
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
      });
    },
    async pause(ms) {
      return driver.pause(ms);
    },
    async waitUntil(condition, options) {
      return driver.waitUntil(condition, options);
    }
  };
}

function parsePositiveInteger(
  rawValue: string | undefined,
  envName: string,
  defaultValue: number
): number {
  const value = rawValue?.trim();
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

export function resolveRequiredPtyTerminalFixture(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >
): PtyTerminalFixture {
  const taskId = env.KANNA_E2E_PTY_TASK_ID?.trim();
  if (!taskId) {
    throw new Error(
      "KANNA_E2E_PTY_TASK_ID is required. Provide a known live PTY task whose " +
        "terminal snapshot contains KANNA_E2E_PTY_SENTINEL; opening an arbitrary " +
        "task row does not prove mobile PTY rendering."
    );
  }

  const sentinel = env.KANNA_E2E_PTY_SENTINEL?.trim();
  if (!sentinel) {
    throw new Error(
      "KANNA_E2E_PTY_SENTINEL is required so the smoke can prove rendered " +
        "terminal text came from the intended PTY fixture."
    );
  }

  return {
    taskId,
    sentinel,
    expectedCols: parsePositiveInteger(
      env.KANNA_E2E_PTY_EXPECTED_COLS,
      "KANNA_E2E_PTY_EXPECTED_COLS",
      DEFAULT_MOBILE_TERMINAL_GEOMETRY.cols
    ),
    expectedRows: parsePositiveInteger(
      env.KANNA_E2E_PTY_EXPECTED_ROWS,
      "KANNA_E2E_PTY_EXPECTED_ROWS",
      DEFAULT_MOBILE_TERMINAL_GEOMETRY.rows
    ),
    minDecodedBytes: parsePositiveInteger(
      env.KANNA_E2E_PTY_MIN_DECODED_BYTES,
      "KANNA_E2E_PTY_MIN_DECODED_BYTES",
      PTY_SNAPSHOT_MIN_DECODED_BYTES
    )
  };
}

function getStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : null;
}

export async function assertPtyTerminalFixtureAvailable(
  desktopServerUrl: string,
  fixture: PtyTerminalFixture,
  fetchImpl: FetchLike = fetch
): Promise<TaskPromptFixture> {
  const response = await fetchImpl(
    `${desktopServerUrl}/v1/tasks/${encodeURIComponent(fixture.taskId)}`
  );
  if (!response.ok) {
    throw new Error(
      `Known PTY fixture task ${fixture.taskId} was not available from ${desktopServerUrl}: ${response.status}`
    );
  }

  const task = await response.json();
  const agentType = getStringProperty(task, "agentType");
  const closedAt = getStringProperty(task, "closedAt");
  if (agentType !== "pty" || closedAt) {
    throw new Error(
      `Known PTY fixture task ${fixture.taskId} expected a live PTY task, got ` +
      `agentType=${agentType ?? "<missing>"} closedAt=${closedAt ?? "<open>"}.`
    );
  }

  const expectedTitle = getStringProperty(task, "title")?.trim();
  const prompt = getStringProperty(task, "prompt")?.trim();
  const promptLines = prompt?.split(/\r?\n/) ?? [];
  const promptEndSentinel = promptLines[promptLines.length - 1]?.trim();
  if (
    !expectedTitle ||
    !prompt ||
    promptLines.length < 2 ||
    expectedTitle === prompt ||
    !promptEndSentinel?.includes("PROMPT_END_SENTINEL")
  ) {
    throw new Error(
      `Known PTY fixture task ${fixture.taskId} must have a short renamed title and ` +
        "a distinct multiline prompt whose final line contains PROMPT_END_SENTINEL."
    );
  }

  return { expectedTitle, promptEndSentinel, taskId: fixture.taskId };
}

export async function smokeElementText(element: SmokeElement): Promise<string> {
  const text = await element.getText?.().catch(() => "");
  if (text?.trim()) return text;
  for (const attribute of ["label", "value", "name"] as const) {
    const value = await element.getAttribute?.(attribute).catch(() => null);
    if (value?.trim()) return value;
  }
  return "";
}

export async function exerciseTaskPromptExpansion(
  ui: TaskPromptExpansionUi,
  fixture: TaskPromptFixture
): Promise<void> {
  await ui.waitUntil(
    async () => {
      const collapsedTitle = await ui.getCollapsedTitle();
      return (
        (await collapsedTitle.isExisting()) &&
        (await smokeElementText(collapsedTitle)).includes(fixture.expectedTitle)
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: `Expected collapsed task title ${JSON.stringify(fixture.expectedTitle)}`
    }
  );

  // The collapsed header carries the id beside the truncating title, so the
  // one place the owner reads most never loses it to a long title.
  await ui.waitUntil(
    async () => {
      const collapsedTaskId = await ui.getCollapsedTaskId();
      return (
        (await collapsedTaskId.isExisting()) &&
        (await smokeElementText(collapsedTaskId)) === fixture.taskId
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: `Expected complete collapsed task ID ${JSON.stringify(fixture.taskId)}`
    }
  );

  const titleButton = await ui.getTitleButton();
  await titleButton.click();

  await ui.waitUntil(
    async () => {
      const expandedPrompt = await ui.getExpandedPrompt();
      return (
        (await expandedPrompt.isExisting()) &&
        (await smokeElementText(expandedPrompt)).includes(
          fixture.promptEndSentinel
        )
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        `Expected expanded task prompt through end sentinel ` +
        JSON.stringify(fixture.promptEndSentinel)
    }
  );

  await ui.waitUntil(
    async () => {
      const expandedTaskId = await ui.getExpandedTaskId();
      return (
        (await expandedTaskId.isExisting()) &&
        (await smokeElementText(expandedTaskId)) === fixture.taskId
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: `Expected complete expanded task ID ${JSON.stringify(fixture.taskId)}`
    }
  );

  const backButton = await ui.getBackButton();
  const backIsUsable =
    (await backButton.isExisting()) &&
    (await backButton.isDisplayed?.()) === true &&
    (await backButton.isEnabled?.()) === true;
  if (!backIsUsable) {
    throw new Error("Expected Back to remain usable while the task prompt is expanded");
  }
  if (!backButton.getSize) {
    throw new Error("Appium element does not expose Back control dimensions");
  }
  const backSize = await backButton.getSize();
  if (backSize.height < 48 || backSize.width < 48) {
    throw new Error(
      `Expected Back to expose at least a 48x48 hit target, got ${backSize.width}x${backSize.height}`
    );
  }

  const expandedTaskId = await ui.getExpandedTaskId();
  if (!expandedTaskId.longPress) {
    throw new Error("Appium element does not expose native longPress");
  }
  const originalClipboard = await ui.getClipboard();
  const clipboardSentinel = `kanna-e2e-before-native-copy:${fixture.taskId}`;
  await ui.setClipboard(
    Buffer.from(clipboardSentinel, "utf8").toString("base64")
  );

  try {
    await ui.waitUntil(
      async () =>
        Buffer.from(await ui.getClipboard(), "base64").toString("utf8") ===
        clipboardSentinel,
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg: "Expected Appium to seed the pre-copy clipboard sentinel"
      }
    );

    await expandedTaskId.longPress({ duration: TEXT_SELECTION_LONG_PRESS_MS });

    await ui.waitUntil(
      async () => {
        const copyMenuItem = await ui.getCopyMenuItem();
        return (
          (await copyMenuItem.isExisting()) &&
          (copyMenuItem.isDisplayed ? await copyMenuItem.isDisplayed() : true)
        );
      },
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg:
          "Expected the native iOS Copy action after long-pressing the task ID"
      }
    );

    const copyMenuItem = await ui.getCopyMenuItem();
    await copyMenuItem.click();
    await ui.waitUntil(
      async () =>
        Buffer.from(await ui.getClipboard(), "base64").toString("utf8") ===
        fixture.taskId,
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg:
          `Expected native Copy to place complete task ID ` +
          `${JSON.stringify(fixture.taskId)} on the clipboard`
      }
    );

    await ui.waitUntil(
      async () => {
        const expandedPrompt = await ui.getExpandedPrompt();
        const selectedTaskId = await ui.getExpandedTaskId();
        return (
          (await expandedPrompt.isExisting()) &&
          (await selectedTaskId.isExisting()) &&
          (await smokeElementText(expandedPrompt)).includes(
            fixture.promptEndSentinel
          ) &&
          (await smokeElementText(selectedTaskId)) === fixture.taskId
        );
      },
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg:
          "Expected the expanded task identity to remain mounted after Copy"
      }
    );
  } finally {
    await ui.setClipboard(originalClipboard);
  }

  const expandedTitleButton = await ui.getTitleButton();
  await expandedTitleButton.click();
  await ui.waitUntil(
    async () => {
      const expandedPrompt = await ui.getExpandedPrompt();
      const selectedTaskId = await ui.getExpandedTaskId();
      return (
        !(await expandedPrompt.isExisting()) &&
        !(await selectedTaskId.isExisting())
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected a normal title tap to collapse the selected task identity"
    }
  );

  const collapsedTitleButton = await ui.getTitleButton();
  await collapsedTitleButton.click();
  await ui.waitUntil(
    async () => {
      const expandedPrompt = await ui.getExpandedPrompt();
      const selectedTaskId = await ui.getExpandedTaskId();
      return (
        (await expandedPrompt.isExisting()) &&
        (await selectedTaskId.isExisting())
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected the task identity to re-expand after a normal title tap"
    }
  );

  const dismissLayer = await ui.getTitleDismissLayer();
  await dismissLayer.click();
  await ui.waitUntil(
    async () => {
      const expandedPrompt = await ui.getExpandedPrompt();
      const expandedTaskId = await ui.getExpandedTaskId();
      return (
        !(await expandedPrompt.isExisting()) &&
        !(await expandedTaskId.isExisting())
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected the task identity to collapse after an outside tap"
    }
  );
}

function contextName(context: unknown): string | null {
  if (typeof context === "string") {
    return context;
  }
  if (!context || typeof context !== "object") {
    return null;
  }

  const record = context as Record<string, unknown>;
  for (const key of ["id", "name"]) {
    if (typeof record[key] === "string") {
      return record[key];
    }
  }

  return null;
}

export async function inspectTerminalWebView(
  driver: WebViewContextDriver
): Promise<TerminalWebViewInspection> {
  const nativeInspection = await driver.getNativeInspection?.();
  if (nativeInspection) {
    try {
      const parsed = JSON.parse(nativeInspection) as Omit<
        Extract<TerminalWebViewInspection, { kind: "rendered" }>,
        "kind"
      >;
      return { kind: "rendered", ...parsed };
    } catch {
      return {
        kind: "unavailable",
        reason: `Native terminal inspection was not valid JSON: ${nativeInspection}`
      };
    }
  }

  if (!driver.getContexts || !driver.switchContext) {
    return {
      kind: "unavailable",
      reason: "Appium driver does not expose WebView context APIs"
    };
  }

  const contexts = await driver.getContexts();
  const webViewContext = contexts
    .map(contextName)
    .find((context): context is string => Boolean(context?.includes("WEBVIEW")));
  if (!webViewContext) {
    return {
      kind: "unavailable",
      reason: `No WEBVIEW context was available. Contexts: ${contexts
        .map(contextName)
        .filter(Boolean)
        .join(", ") || "<none>"}`
    };
  }

  const previousContext = driver.getContext ? await driver.getContext() : null;
  await driver.switchContext(webViewContext);
  try {
    return await driver.execute(() => {
      const root = document.getElementById("terminal-root");
      if (!root) {
        return {
          kind: "unavailable" as const,
          reason: "WebView document did not contain #terminal-root"
        };
      }

      const terminalRows =
        root.querySelector(".xterm-rows")?.textContent ?? root.textContent ?? "";
      const byteCount = Number.parseInt(root.dataset.kannaByteCount ?? "", 10);
      const cols = Number.parseInt(root.dataset.kannaCols ?? "", 10);
      const frameCount = Number.parseInt(root.dataset.kannaFrameCount ?? "", 10);
      const rows = Number.parseInt(root.dataset.kannaRows ?? "", 10);
      return {
        kind: "rendered" as const,
        byteCount: Number.isNaN(byteCount) ? 0 : byteCount,
        cols: Number.isNaN(cols) ? null : cols,
        frameCount: Number.isNaN(frameCount) ? 0 : frameCount,
        rows: Number.isNaN(rows) ? null : rows,
        text: terminalRows || root.dataset.kannaTextSample || ""
      };
    });
  } finally {
    if (previousContext) {
      await driver.switchContext(previousContext);
    }
  }
}

export async function waitForTaskTerminalLive(ui: TaskTerminalLiveUi): Promise<void> {
  await ui.waitUntil(
    async () => {
      const taskDetailScreen = await ui.getTaskDetailScreen();
      if (!(await taskDetailScreen.isExisting())) {
        return false;
      }
      const agentMessageView = await ui.getAgentMessageView();
      if (await agentMessageView.isExisting()) {
        if (!ui.getAgentMessageReady) {
          return false;
        }
        const agentMessageReady = await ui.getAgentMessageReady();
        return agentMessageReady.isExisting();
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

export async function waitForRenderedPtyTerminal(
  ui: RenderedPtyTerminalUi,
  fixture: PtyTerminalFixture
): Promise<void> {
  let lastInspection: TerminalWebViewInspection | null = null;
  const baseTimeoutMessage =
    `Expected mobile PTY terminal WebView to render at least ${fixture.minDecodedBytes} decoded bytes, ` +
    `desktop PTY dimensions ${fixture.expectedCols}x${fixture.expectedRows}, and sentinel text "${fixture.sentinel}". ` +
    "If this fails before WebView inspection, enable Appium iOS WebView context access and ensure KANNA_E2E_PTY_TASK_ID points at the known live PTY snapshot.";

  try {
    await ui.waitUntil(
      async () => {
        const agentMessageView = await ui.getAgentMessageView();
        if (await agentMessageView.isExisting()) {
          lastInspection = {
            kind: "unavailable",
            reason: "Opened task rendered the agent message view, not the PTY terminal WebView"
          };
          return false;
        }

        lastInspection = await ui.inspectTerminalWebView();
        return renderedPtyInspectionMatches(lastInspection, fixture);
      },
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg: baseTimeoutMessage
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : baseTimeoutMessage;
    throw new Error(
      `${message} Last validation error: ${describeRenderedPtyInspectionFailure(
        lastInspection,
        fixture
      )}. Last inspection: ${JSON.stringify(lastInspection)}`
    );
  }
}

function renderedPtyInspectionMatches(
  inspection: TerminalWebViewInspection,
  fixture: PtyTerminalFixture
): boolean {
  if (inspection.kind !== "rendered") {
    return false;
  }

  return (
    inspection.byteCount >= fixture.minDecodedBytes &&
    inspection.frameCount > 0 &&
    inspection.cols === fixture.expectedCols &&
    inspection.rows === fixture.expectedRows &&
    inspection.text.trim().length > 0 &&
    inspection.text.includes(fixture.sentinel)
  );
}

function describeRenderedPtyInspectionFailure(
  inspection: TerminalWebViewInspection | null,
  fixture: PtyTerminalFixture
): string {
  if (!inspection) {
    return "terminal WebView was not inspected";
  }
  if (inspection.kind === "unavailable") {
    return inspection.reason;
  }
  if (inspection.byteCount < fixture.minDecodedBytes) {
    return `byteCount ${inspection.byteCount} was below ${fixture.minDecodedBytes}`;
  }
  if (inspection.frameCount <= 0) {
    return `frameCount ${inspection.frameCount} did not prove a decoded terminal frame`;
  }
  if (inspection.cols !== fixture.expectedCols || inspection.rows !== fixture.expectedRows) {
    return `desktop PTY dimensions were ${inspection.cols}x${inspection.rows}, expected ${fixture.expectedCols}x${fixture.expectedRows}`;
  }
  if (inspection.text.trim().length === 0) {
    return "terminal text was blank after WebView rendering";
  }
  if (!inspection.text.includes(fixture.sentinel)) {
    return `terminal sentinel "${fixture.sentinel}" was missing from rendered text`;
  }
  return "terminal inspection did not match the fixture";
}

async function waitForTaskRows(ui: TaskListUi): Promise<void> {
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

export async function openPtyFixtureTask(
  ui: PtyFixtureTaskUi,
  taskId: string
): Promise<void> {
  await ui.waitUntil(
    async () => {
      const taskRow = await ui.getTaskRowById(taskId);
      return taskRow.isExisting();
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: `Expected known PTY fixture task row ${taskId} in the mobile task list`
    }
  );

  const taskRow = await ui.getTaskRowById(taskId);
  await taskRow.waitForDisplayed?.({ timeout: SCREEN_TIMEOUT_MS });
  await taskRow.click();
}

export async function ensureTaskListVisible(ui: TaskListUi): Promise<void> {
  const backButton = await ui.getBackButton();
  if (await backButton.isExisting()) {
    await backButton.click();
    await ui.pause(BACK_NAVIGATION_SETTLE_MS);
  }

  await waitForTaskRows(ui);
}

export async function exerciseListDetailBackFromOrigin(
  ui: ListDetailBackOriginUi,
  origin: "tasks" | "recent",
  taskId: string
): Promise<void> {
  await ui.selectOrigin(origin);
  await ui.openTask(taskId);
  await ui.goBack();
  await ui.assertOrigin(origin);
}

export async function performTaskDetailEdgeSwipeBack(
  driver: Browser
): Promise<void> {
  const { width, height } = await driver.getWindowSize();
  const verticalMidpoint = Math.round(height * 0.5);

  await driver.execute("mobile: dragFromToForDuration", {
    duration: 0.5,
    fromX: 1,
    fromY: verticalMidpoint,
    toX: Math.round(width * 0.75),
    toY: verticalMidpoint
  });

  await driver.waitUntil(
    async () => {
      const taskDetail = await driver.$(selectors.taskDetailScreen);
      const tasksScreen = await driver.$(selectors.tasksScreen);
      if ((await taskDetail.isExisting()) || !(await tasksScreen.isExisting())) {
        return false;
      }
      return tasksScreen.isDisplayed().catch(() => false);
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected left-edge swipe to dismiss TaskDetail and restore the Tasks list"
    }
  );
}

/** Rendered task rows, top to bottom, as the phone currently orders them. */
async function readRenderedTaskRowIds(driver: Browser): Promise<string[]> {
  const rows = Array.from(await driver.$$(selectors.taskRowsXPath));
  const taskIds: string[] = [];
  for (const row of rows) {
    const name =
      (await row.getAttribute("name").catch(() => null)) ??
      (await row.getAttribute("label").catch(() => null));
    const taskId = extractTaskRowId(name);
    if (taskId) taskIds.push(taskId);
  }
  return taskIds;
}

/**
 * One swipe on a task row, released well past the commit threshold — which is
 * what performs the row's action now that nothing rests open.
 */
async function dragRowPastCommitThreshold(
  driver: Browser,
  row: Awaited<ReturnType<Browser["$"]>>
): Promise<void> {
  const [{ x, y }, { width, height }] = await Promise.all([
    row.getLocation(),
    row.getSize()
  ]);
  await driver.execute("mobile: dragFromToForDuration", {
    duration: 0.35,
    fromX: Math.round(x + width * 0.8),
    fromY: Math.round(y + height / 2),
    toX: Math.round(x + width * 0.35),
    toY: Math.round(y + height / 2)
  });
}

/**
 * Pinning is phone-local: the swipe writes this device's own record and the
 * list reorders from it. The desktop's pin columns must not move — that
 * divergence is the design, so the journey asserts it rather than the old
 * server round-trip.
 */
export async function exerciseTaskPinSwipe(
  driver: Browser,
  desktopServerUrl: string,
  taskId: string,
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const detailResponse = await fetchImpl(
    `${desktopServerUrl}/v1/tasks/${encodeURIComponent(taskId)}`
  );
  if (!detailResponse.ok) {
    throw new Error(`Could not load pin fixture task (${detailResponse.status}).`);
  }
  const detail = (await detailResponse.json()) as { repoId?: unknown };
  if (typeof detail.repoId !== "string") {
    throw new Error("Pin fixture task did not expose a repository id.");
  }
  const taskUrl = `${desktopServerUrl}/v1/repos/${encodeURIComponent(detail.repoId)}/tasks`;
  const readPinState = async (): Promise<{
    pinned: boolean;
    pinOrder: number | null;
  }> => {
    const response = await fetchImpl(taskUrl);
    if (!response.ok) {
      throw new Error(`Could not read pin fixture state (${response.status}).`);
    }
    const tasks = (await response.json()) as MobileTaskPinSummary[];
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("Pin fixture task disappeared from its repository.");
    return {
      pinned: task.pinned ?? false,
      pinOrder: task.pinOrder ?? null
    };
  };
  const desktopPinStateBefore = await readPinState();

  // The row commits on release: the drag past the threshold *is* the pin,
  // with no revealed button left to tap afterwards.
  const swipeRowToTogglePin = async (): Promise<void> => {
    const row = await driver.$(`~mobile.task-row.${taskId}`);
    await row.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
    await dragRowPastCommitThreshold(driver, row);
  };

  const repo = await driver.$(tasksRepoSelector(detail.repoId));
  await repo.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await repo.click();

  try {
    await swipeRowToTogglePin();
    // A pin that does not lift the row is the bug this journey guards, and it
    // must land from the local write alone — no read is awaited in between.
    await driver.waitUntil(
      async () => (await readRenderedTaskRowIds(driver))[0] === taskId,
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg:
          "Expected the pinned task to render as the first row of its repo list"
      }
    );
    const desktopPinStateAfter = await readPinState();
    if (
      desktopPinStateAfter.pinned !== desktopPinStateBefore.pinned ||
      desktopPinStateAfter.pinOrder !== desktopPinStateBefore.pinOrder
    ) {
      throw new Error(
        "Expected the phone-local pin to leave the desktop's pin state alone, " +
          `but it became ${JSON.stringify(desktopPinStateAfter)}`
      );
    }
  } finally {
    // Leave the phone as it was found: the pin lives only on this device, so
    // the app itself is the only place to take it back off.
    await swipeRowToTogglePin();
    await driver.waitUntil(
      async () => {
        const rows = await readRenderedTaskRowIds(driver);
        return rows.length > 0 && rows[0] !== taskId;
      },
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg: "Expected the unpinned task to fall back down its repo list"
      }
    ).catch(() => undefined);
  }
}

async function prepareTaskUnreadActivity(
  desktopServerUrl: string,
  taskId: string,
  fetchImpl: FetchLike
): Promise<void> {
  const actionUrl = `${desktopServerUrl}/v1/tasks/${encodeURIComponent(taskId)}/actions/runtime-status`;
  for (const status of ["busy", "idle"] as const) {
    const response = await fetchImpl(actionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, selected: false })
    });
    if (!response.ok) {
      throw new Error(
        `Could not prepare unread Activity fixture (${response.status}).`
      );
    }
  }
}

/**
 * Dismissing is phone-local too: the row leaves this device's Activity list
 * while the desktop stays unread, and newer activity on the same task brings
 * the row back.
 */
export async function exerciseActivityDismissSwipe(
  driver: Browser,
  desktopServerUrl: string,
  taskId: string,
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const readActivity = async (): Promise<string | null> => {
    const response = await fetchImpl(`${desktopServerUrl}/v1/tasks/recent`);
    if (!response.ok) {
      throw new Error(`Could not read Activity fixture (${response.status}).`);
    }
    const tasks = (await response.json()) as MobileTaskActivitySummary[];
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error("Activity fixture task was removed from recent tasks.");
    }
    return task.activity ?? null;
  };

  await prepareTaskUnreadActivity(desktopServerUrl, taskId, fetchImpl);
  const activityTab = await driver.$(selectors.recentTab);
  await activityTab.click();
  const screen = await driver.$(selectors.recentScreen);
  await screen.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  const row = await driver.$(`~mobile.task-row.${taskId}`);
  await row.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  // Activity reads the same gesture as the task list: releasing the swipe past
  // the threshold dismisses, with no second tap.
  await dragRowPastCommitThreshold(driver, row);
  await driver.waitUntil(
    async () => {
      const dismissedRow = await driver.$(`~mobile.task-row.${taskId}`);
      return !(await dismissedRow.isExisting());
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected the dismissed Activity row to leave the list"
    }
  );
  // The desktop keeps its own read state: only this phone stopped showing it.
  const desktopActivity = await readActivity();
  if (desktopActivity !== "unread") {
    throw new Error(
      `Expected the local dismissal to leave the desktop unread, but it is ${desktopActivity}.`
    );
  }

  // Newer activity than the dismissed generation resurfaces the row.
  await prepareTaskUnreadActivity(desktopServerUrl, taskId, fetchImpl);
  const laterActivityRow = await driver.$(`~mobile.task-row.${taskId}`);
  await laterActivityRow.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
}

export async function runListDetailBackSmoke(
  driver: Browser,
  options: RunListDetailBackSmokeOptions = {}
): Promise<void> {
  const ui = createSmokeUi(driver);
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const desktopServerUrl =
    options.desktopServerUrl ?? env.KANNA_E2E_DESKTOP_SERVER_URL?.trim();
  if (!desktopServerUrl) {
    throw new Error(
      "KANNA_E2E_DESKTOP_SERVER_URL is required to validate the known PTY fixture task."
    );
  }
  const fixture = resolveRequiredPtyTerminalFixture(env);
  const promptFixture = await assertPtyTerminalFixtureAvailable(
    desktopServerUrl,
    fixture,
    options.fetchImpl
  );

  const appShell = await driver.$(selectors.appShell);
  await appShell.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });

  await ensureTaskListVisible(ui);
  await exerciseTaskPinSwipe(
    driver,
    desktopServerUrl,
    fixture.taskId,
    options.fetchImpl
  );
  await exerciseActivityDismissSwipe(
    driver,
    desktopServerUrl,
    fixture.taskId,
    options.fetchImpl
  );
  await openPtyFixtureTask(ui, fixture.taskId);

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
  await waitForRenderedPtyTerminal(ui, fixture);
  await exerciseTaskPromptExpansion(ui, promptFixture);

  const taskInput = await driver.$(selectors.taskInput);
  await taskInput.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await taskInput.click();
  await driver.waitUntil(
    () => driver.isKeyboardShown(),
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected the task keyboard to open before exercising Back"
    }
  );

  const backButton = await driver.$(selectors.taskBackButton);
  await backButton.click();

  await driver.pause(BACK_NAVIGATION_SETTLE_MS);
  await waitForTaskRows(ui);
  await driver.waitUntil(
    async () => !(await driver.isKeyboardShown()),
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected Back navigation to dismiss the task keyboard"
    }
  );

  const tasksTab = await driver.$(selectors.tasksTab);
  await tasksTab.click();
  const tasksScreen = await driver.$(selectors.tasksScreen);
  await tasksScreen.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });

  await openPtyFixtureTask(ui, fixture.taskId);
  const edgeSwipeTaskDetail = await driver.$(selectors.taskDetailScreen);
  await edgeSwipeTaskDetail.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await waitForTaskTerminalLive(ui);
  await waitForRenderedPtyTerminal(ui, fixture);
  await performTaskDetailEdgeSwipeBack(driver);
  await waitForTaskRows(ui);

  await prepareTaskUnreadActivity(
    desktopServerUrl,
    fixture.taskId,
    options.fetchImpl ?? fetch
  );

  await exerciseListDetailBackFromOrigin(
    {
      async selectOrigin(origin) {
        const tab = await driver.$(
          origin === "recent" ? selectors.recentTab : selectors.tasksTab
        );
        await tab.click();
        const screen = await driver.$(
          origin === "recent" ? selectors.recentScreen : selectors.tasksScreen
        );
        await screen.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
      },
      async openTask(taskId) {
        await openPtyFixtureTask(ui, taskId);
        const detail = await driver.$(selectors.taskDetailScreen);
        await detail.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
      },
      async goBack() {
        const taskBackButton = await driver.$(selectors.taskBackButton);
        await taskBackButton.click();
        await driver.pause(BACK_NAVIGATION_SETTLE_MS);
      },
      async assertOrigin(origin) {
        const screen = await driver.$(
          origin === "recent" ? selectors.recentScreen : selectors.tasksScreen
        );
        await driver.waitUntil(
          async () =>
            (await screen.isExisting()) &&
            (await screen.isDisplayed?.().catch(() => false)) === true,
          {
            interval: POLL_INTERVAL_MS,
            timeout: SCREEN_TIMEOUT_MS,
            timeoutMsg: `Expected Back to restore the ${origin} task list`
          }
        );
      }
    },
    "recent",
    fixture.taskId
  );
}
