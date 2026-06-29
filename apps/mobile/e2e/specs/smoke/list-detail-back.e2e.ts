import type { Browser } from "webdriverio";
import { selectors } from "../../helpers/selectors";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const BACK_NAVIGATION_SETTLE_MS = 500;

interface SmokeElement {
  click(): Promise<unknown>;
  isExisting(): Promise<boolean>;
}

interface TaskTerminalLiveUi {
  getAgentMessageView(): Promise<SmokeElement>;
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

interface RenderedPtyTerminalUi extends TaskTerminalLiveUi {
  inspectTerminalWebView(): Promise<TerminalWebViewInspection>;
}

interface SmokeUi extends TaskListUi, RenderedPtyTerminalUi {}

type TerminalWebViewInspection =
  | {
      kind: "rendered";
      byteCount: number;
      cols: number | null;
      frameCount: number;
      rows: number | null;
      text: string;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

interface WebViewContextDriver {
  execute<T>(script: () => T): Promise<T>;
  getContext?: () => Promise<string>;
  getContexts?: () => Promise<unknown[]>;
  switchContext?: (context: string) => Promise<unknown>;
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
    async inspectTerminalWebView() {
      return inspectTerminalWebView(driver as Browser & WebViewContextDriver);
    },
    async pause(ms) {
      return driver.pause(ms);
    },
    async waitUntil(condition, options) {
      return driver.waitUntil(condition, options);
    }
  };
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

export async function waitForRenderedPtyTerminal(
  ui: RenderedPtyTerminalUi
): Promise<void> {
  let lastInspection: TerminalWebViewInspection | null = null;
  const baseTimeoutMessage =
    "Expected mobile PTY terminal WebView to render nonblank xterm output with desktop PTY dimensions. " +
    "If this fails before WebView inspection, enable Appium iOS WebView context access and ensure the opened task has a live PTY snapshot.";

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
        return (
          lastInspection.kind === "rendered" &&
          lastInspection.byteCount > 0 &&
          lastInspection.frameCount > 0 &&
          lastInspection.cols !== null &&
          lastInspection.rows !== null
        );
      },
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg: baseTimeoutMessage
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : baseTimeoutMessage;
    throw new Error(`${message} Last inspection: ${JSON.stringify(lastInspection)}`);
  }
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

export async function ensureTaskListVisible(ui: TaskListUi): Promise<void> {
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
  await waitForRenderedPtyTerminal(ui);

  const backButton = await driver.$(selectors.taskBackButton);
  await backButton.click();

  await driver.pause(BACK_NAVIGATION_SETTLE_MS);
  await waitForTaskRows(ui);
}
