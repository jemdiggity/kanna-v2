import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase } from "../helpers/reset";

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
): Promise<void> {
  const result = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
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
