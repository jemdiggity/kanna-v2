import { setTimeout as sleep } from "node:timers/promises";

export interface TerminalInputClient {
  executeSync<T = unknown>(script: string, args?: unknown[]): Promise<T>;
  waitForElement(css: string, timeoutMs?: number): Promise<string>;
  sendKeys(elementId: string, text: string): Promise<void>;
  pressKey(value: string): Promise<void>;
}

export interface TerminalInputOptions {
  initialDelayMs?: number;
  attempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

const TERMINAL_CONTAINER_SELECTOR = ".terminal-container";
const TERMINAL_INPUT_SELECTOR = ".main-panel .xterm-helper-textarea";
const FOCUSED_TERMINAL_INPUT_SELECTOR = `${TERMINAL_INPUT_SELECTOR}:focus`;
const ENTER_KEY = "\uE007";

export async function sendKeysToActiveTerminal(
  client: TerminalInputClient,
  text: string,
  options: TerminalInputOptions = {},
): Promise<void> {
  await client.waitForElement(TERMINAL_CONTAINER_SELECTOR, 15_000);

  const initialDelayMs = options.initialDelayMs ?? 0;
  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }

  await client.executeSync(
    `const el = document.querySelector(${JSON.stringify(TERMINAL_INPUT_SELECTOR)});
     if (el instanceof HTMLElement) el.focus();`,
  );

  const input = await client.waitForElement(TERMINAL_INPUT_SELECTOR, 5_000);
  const attempts = options.attempts ?? 1;
  const intervalMs = options.intervalMs ?? 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await client.sendKeys(input, text);
    if (attempt < attempts - 1 && intervalMs > 0) {
      await sleep(intervalMs);
    }
  }
}

export async function nudgeTerminalTrustPrompt(
  client: TerminalInputClient,
  options: TerminalInputOptions = {},
): Promise<void> {
  await client.waitForElement(TERMINAL_CONTAINER_SELECTOR, 15_000);

  const initialDelayMs = options.initialDelayMs ?? 0;
  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }

  await client.executeSync(
    `const el = document.querySelector(${JSON.stringify(TERMINAL_INPUT_SELECTOR)});
     if (el instanceof HTMLElement) el.focus();`,
  );

  await client.waitForElement(TERMINAL_INPUT_SELECTOR, 5_000);
  const attempts = options.attempts ?? 1;
  const intervalMs = options.intervalMs ?? 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await client.pressKey(ENTER_KEY);
    if (attempt < attempts - 1 && intervalMs > 0) {
      await sleep(intervalMs);
    }
  }
}

export async function typeTextToFocusedTerminalWindow(
  client: TerminalInputClient,
  text: string,
  options: TerminalInputOptions = {},
): Promise<void> {
  await client.waitForElement(TERMINAL_CONTAINER_SELECTOR, 15_000);

  const initialDelayMs = options.initialDelayMs ?? 0;
  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }

  await waitForTerminalDomFocus(client, options.timeoutMs ?? 5_000);

  const input = await client.waitForElement(FOCUSED_TERMINAL_INPUT_SELECTOR, 5_000);
  await client.sendKeys(input, text);
}

export async function pressShiftEnterInActiveTerminal(
  client: TerminalInputClient,
  options: TerminalInputOptions = {},
): Promise<void> {
  await client.waitForElement(TERMINAL_CONTAINER_SELECTOR, 15_000);

  const initialDelayMs = options.initialDelayMs ?? 0;
  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }

  await client.executeSync(
    `const el = document.querySelector(${JSON.stringify(TERMINAL_INPUT_SELECTOR)});
     if (el instanceof HTMLElement) el.focus();`,
  );

  await client.waitForElement(TERMINAL_INPUT_SELECTOR, 5_000);
  await waitForTerminalDomFocus(client, options.timeoutMs ?? 5_000);
  await client.executeSync(
    `const el = document.querySelector(${JSON.stringify(TERMINAL_INPUT_SELECTOR)});
     if (!el) throw new Error("active terminal input not found");
     el.dispatchEvent(new KeyboardEvent("keydown", {
       key: "Enter",
       code: "Enter",
       shiftKey: true,
       bubbles: true,
       cancelable: true,
     }));`,
  );
}

async function waitForTerminalDomFocus(
  client: TerminalInputClient,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const focused = await client.executeSync<boolean>(
      `const el = document.activeElement;
       return el instanceof HTMLElement && el.matches(${JSON.stringify(TERMINAL_INPUT_SELECTOR)});`,
    );
    if (focused) return;
    await sleep(100);
  }
  throw new Error("Timed out waiting for xterm textarea to own focus in the active window.");
}
