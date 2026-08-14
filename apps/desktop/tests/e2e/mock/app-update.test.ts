import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase } from "../helpers/reset";

interface WebDriverErrorValue {
  error?: string;
  message?: string;
}

interface WebDriverResponse<T> {
  value: T | WebDriverErrorValue;
}

function getClientSessionId(client: WebDriverClient): string {
  const state = client as unknown as { sessionId?: string | null };
  if (!state.sessionId) {
    throw new Error("No WebDriver session. Call createSession() first.");
  }
  return state.sessionId;
}

async function getWindowHandles(client: WebDriverClient): Promise<string[]> {
  const sessionId = getClientSessionId(client);
  const response = await fetch(
    `${client.getBaseUrl()}/session/${sessionId}/window/handles`,
  );
  const body = await response.json() as WebDriverResponse<string[]>;
  if (
    typeof body.value === "object" &&
    body.value !== null &&
    "error" in body.value
  ) {
    throw new Error(`WebDriver error: ${body.value.message ?? "unknown error"}`);
  }
  return Array.isArray(body.value) ? body.value : [];
}

async function switchToWindow(client: WebDriverClient, handle: string): Promise<void> {
  const sessionId = getClientSessionId(client);
  const response = await fetch(`${client.getBaseUrl()}/session/${sessionId}/window`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ handle }),
  });
  const body = await response.json() as WebDriverResponse<null>;
  if (
    typeof body.value === "object" &&
    body.value !== null &&
    "error" in body.value
  ) {
    throw new Error(`WebDriver error: ${body.value.message ?? "unknown error"}`);
  }
}

async function waitForWindowCount(
  client: WebDriverClient,
  count: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handles = await getWindowHandles(client);
    if (handles.length === count) {
      return handles;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${count} windows.`);
}

async function closeFocusedWindowThroughAppAction(client: WebDriverClient): Promise<void> {
  const result = await client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     setTimeout(() => {
       void Promise.resolve(ctx.keyboardActions?.closeWindow?.() ?? ctx.windowWorkspace.closeWindow())
         .catch((error) => console.error("[e2e] close focused window failed", error));
     }, 0);
     cb("scheduled");`,
  );
  if (
    typeof result === "object" &&
    result !== null &&
    "__error" in result
  ) {
    throw new Error(String((result as { __error: unknown }).__error));
  }
}

async function injectUpdate(
  client: WebDriverClient,
  options: {
    version: string;
    body?: string;
    contentLength?: number;
    chunks?: number[];
    delayMs?: number;
    failInstall?: boolean;
    failInstallAttempts?: number;
    failMessage?: string;
  },
): Promise<void> {
  await client.executeSync(
    `window.__KANNA_E2E__.setupState.appUpdate.__e2eInjectUpdate(${JSON.stringify(options)});`,
  );
}

async function emitCurrentWindowEvent(
  client: WebDriverClient,
  event: "tauri://focus" | "tauri://blur",
  targetLabel?: string,
): Promise<void> {
  const result = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const label = ${JSON.stringify(targetLabel)} ?? window.__TAURI_INTERNALS__.metadata.currentWindow.label;
     window.__TAURI_INTERNALS__.invoke("plugin:event|emit_to", {
       target: { kind: "Window", label },
       event: ${JSON.stringify(event)},
       payload: null,
     }).then(() => cb("ok")).catch((error) => cb("err:" + String(error)));`,
  );
  if (result !== "ok") {
    throw new Error(`Failed to emit ${event}: ${result}`);
  }
}

describe("app update prompt", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await emitCurrentWindowEvent(client, "tauri://focus");
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("installs an available update and lets the user restart later", async () => {
    await injectUpdate(client, {
      version: "9.9.9",
      body: "Mock release notes",
      contentLength: 84,
      chunks: [20, 64],
      delayMs: 50,
    });

    await client.waitForText(".update-prompt", "Update available", 2000);
    await client.waitForText(".update-prompt", "9.9.9", 2000);
    await client.waitForText(".update-prompt", "Mock release notes", 2000);

    await client.click(await client.waitForElement('[data-testid="update-install"]', 2000));
    await client.waitForText(".update-prompt", "Downloading update", 2000);
    await client.waitForText(".update-prompt", "84", 2000);
    await client.waitForText(".update-prompt", "Ready to restart", 2000);

    await client.click(await client.waitForElement('[data-testid="update-later"]', 2000));
    await client.waitForNoElement(".update-prompt", 2000);
  });

  it("shows the update prompt only while its native window is focused", async () => {
    await injectUpdate(client, {
      version: "9.9.12",
      body: "Focus-aware update",
    });

    await client.waitForText(".update-prompt", "Focus-aware update", 2000);

    await emitCurrentWindowEvent(client, "tauri://blur");
    await client.waitForNoElement(".update-prompt", 2000);

    await emitCurrentWindowEvent(client, "tauri://focus");
    await client.waitForText(".update-prompt", "Focus-aware update", 2000);

    await client.click(await client.waitForElement('[data-testid="update-dismiss"]', 2000));
    await client.waitForNoElement(".update-prompt", 2000);
  });

  it("shows the update prompt exclusively in the focused native window", async () => {
    const initialHandles = await getWindowHandles(client);
    expect(initialHandles).toHaveLength(1);
    const sourceHandle = initialHandles[0] ?? "";
    const sourceLabel = await client.executeSync<string>(
      "return window.__TAURI_INTERNALS__.metadata.currentWindow.label;",
    );
    let secondHandle: string | undefined;

    try {
      const openResult = await client.executeAsync<string>(
        `const cb = arguments[arguments.length - 1];
         const ctx = window.__KANNA_E2E__.setupState;
         Promise.resolve(ctx.windowWorkspace.openWindow({
           selectedRepoId: null,
           selectedItemId: null,
         })).then(() => cb("ok"))
           .catch((error) => cb("err:" + String(error)));`,
      );
      if (openResult !== "ok") {
        throw new Error(`Failed to open second window: ${openResult}`);
      }

      const handles = await waitForWindowCount(client, initialHandles.length + 1);
      secondHandle = handles.find((handle) => !initialHandles.includes(handle));
      expect(secondHandle).toBeTruthy();

      await switchToWindow(client, secondHandle ?? "");
      await client.waitForAppReady();
      await dismissStartupShortcutsModal(client);
      const secondLabel = await client.executeSync<string>(
        "return window.__TAURI_INTERNALS__.metadata.currentWindow.label;",
      );
      await injectUpdate(client, {
        version: "9.9.13",
        body: "Multi-window focus-aware update",
      });

      await switchToWindow(client, sourceHandle);
      await client.waitForAppReady();
      await injectUpdate(client, {
        version: "9.9.13",
        body: "Multi-window focus-aware update",
      });

      await emitCurrentWindowEvent(client, "tauri://focus", sourceLabel);
      await emitCurrentWindowEvent(client, "tauri://blur", secondLabel);
      await client.waitForText(".update-prompt", "Multi-window focus-aware update", 2000);

      await switchToWindow(client, secondHandle ?? "");
      await client.waitForNoElement(".update-prompt", 2000);

      await emitCurrentWindowEvent(client, "tauri://blur", sourceLabel);
      await emitCurrentWindowEvent(client, "tauri://focus", secondLabel);
      await client.waitForText(".update-prompt", "Multi-window focus-aware update", 2000);

      await switchToWindow(client, sourceHandle);
      await client.waitForNoElement(".update-prompt", 2000);
    } finally {
      if (secondHandle) {
        await switchToWindow(client, secondHandle).catch(() => undefined);
        await client.waitForAppReady().catch(() => undefined);
        await closeFocusedWindowThroughAppAction(client).catch(() => undefined);
        await waitForWindowCount(client, initialHandles.length).catch(() => undefined);
      }
      await switchToWindow(client, sourceHandle).catch(() => undefined);
      await client.waitForAppReady().catch(() => undefined);
      await emitCurrentWindowEvent(client, "tauri://focus", sourceLabel).catch(() => undefined);
      const dismissButtons = await client.findElements('[data-testid="update-dismiss"]').catch(() => []);
      if (dismissButtons[0]) {
        await client.click(dismissButtons[0]).catch(() => undefined);
        await client.waitForNoElement(".update-prompt", 2000).catch(() => undefined);
      }
    }
  });

  it("shows install failures and retries successfully", async () => {
    await injectUpdate(client, {
      version: "9.9.10",
      body: "Broken mock release",
      contentLength: 12,
      chunks: [12],
      failInstallAttempts: 1,
      failMessage: "mock install failed",
    });

    await client.waitForText(".update-prompt", "Update available", 2000);
    await client.click(await client.waitForElement('[data-testid="update-install"]', 2000));
    await client.waitForText(".update-prompt", "Update failed", 2000);
    await client.waitForText(".update-prompt", "mock install failed", 2000);

    await client.click(await client.waitForElement('[data-testid="update-retry"]', 2000));
    await client.waitForText(".update-prompt", "Ready to restart", 2000);

    await client.click(await client.waitForElement('[data-testid="update-later"]', 2000));
    await client.waitForNoElement(".update-prompt", 2000);
  });

  it("keeps long release notes within the visible prompt", async () => {
    await injectUpdate(client, {
      version: "9.9.11",
      body: Array.from({ length: 80 }, (_, index) => `Release note ${index + 1}`).join("\n"),
    });

    await client.waitForText(".update-prompt", "Update available", 2000);
    await client.waitForText(".update-prompt", "Release note 1", 2000);

    const metrics = await client.executeSync<{
      promptHeight: number;
      viewportHeight: number;
      bodyClientHeight: number;
      bodyScrollHeight: number;
    }>(`
      const prompt = document.querySelector(".update-prompt");
      const body = document.querySelector(".update-prompt__body");
      if (!prompt || !body) throw new Error("update prompt missing");
      const promptRect = prompt.getBoundingClientRect();
      return {
        promptHeight: promptRect.height,
        viewportHeight: window.innerHeight,
        bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight,
      };
    `);

    expect(metrics.promptHeight).toBeLessThanOrEqual(metrics.viewportHeight - 32);
    expect(metrics.bodyScrollHeight).toBeGreaterThan(metrics.bodyClientHeight);

    await client.click(await client.waitForElement('[data-testid="update-dismiss"]', 2000));
    await client.waitForNoElement(".update-prompt", 2000);
  });
});
