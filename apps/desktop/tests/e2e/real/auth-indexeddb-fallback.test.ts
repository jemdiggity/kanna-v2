import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";

const client = new WebDriverClient();

async function openAccountPreferences(): Promise<void> {
  await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const tabs = ctx.mainTabs;
    if (!tabs) throw new Error("main tabs are unavailable on setupState");
    tabs.openTab({ kind: "preferences" });
  `);
  await client.click(await client.waitForElement('[data-testid="preferences-account-tab"]'));
}

async function accountPasswordType(): Promise<string | null> {
  return await client.executeSync(`
    return document.querySelector('[data-testid="account-password"]')?.getAttribute("type") ?? null;
  `);
}

async function waitForSignedInEmail(email: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastDiagnostics: unknown = null;
  while (Date.now() < deadline) {
    const panelText = await client.executeSync<string>(
      'return document.querySelector(".prefs-panel")?.textContent || "";',
    );
    if (panelText.includes(email)) return;
    lastDiagnostics = {
      panelText,
      fault: await client.executeSync("return window.__KANNA_E2E_AUTH_INDEXEDDB_FAULT__ ?? null;"),
    };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for signed-in email; diagnostics=${JSON.stringify(lastDiagnostics)}`);
}

async function reloadApp(): Promise<void> {
  await client.executeSync(`
    if (window.__KANNA_E2E__) window.__KANNA_E2E__.ready = false;
    location.reload();
  `);
  await client.waitForAppReady();
}

describe("desktop auth IndexedDB fallback", () => {
  beforeAll(async () => {
    await client.createSession();
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("signs in when Firebase Auth IndexedDB storage fails to open", async () => {
    const fault = await client.executeSync<{ installed?: boolean; openFailures?: number }>(
      "return window.__KANNA_E2E_AUTH_INDEXEDDB_FAULT__ ?? null;",
    );
    expect(fault?.installed).toBe(true);

    await openAccountPreferences();
    expect(await accountPasswordType()).toBe("password");
    await client.click(await client.waitForElement('[data-testid="account-toggle-password"]'));
    expect(await accountPasswordType()).toBe("text");
    await client.click(await client.waitForElement('[data-testid="account-toggle-password"]'));
    expect(await accountPasswordType()).toBe("password");

    await client.sendKeys(await client.waitForElement('[data-testid="account-email"]'), "upvote.sieve.7t@icloud.com");
    await client.sendKeys(await client.waitForElement('[data-testid="account-password"]'), "password123");
    await client.click(await client.waitForElement('[data-testid="account-sign-in"] .primary-button'));

    await waitForSignedInEmail("upvote.sieve.7t@icloud.com");

    const bodyText = await client.executeSync<string>("return document.body.innerText;");
    expect(bodyText).not.toContain("Firebase Auth storage is not available.");

    const afterSignInFault = await client.executeSync<{ openFailures?: number }>(
      "return window.__KANNA_E2E_AUTH_INDEXEDDB_FAULT__ ?? null;",
    );
    expect(afterSignInFault.openFailures ?? 0).toBeGreaterThan(0);

    await reloadApp();
    await openAccountPreferences();
    await waitForSignedInEmail("upvote.sieve.7t@icloud.com");
    expect(await client.findElements('[data-testid="account-email"]')).toHaveLength(0);
  });
});
