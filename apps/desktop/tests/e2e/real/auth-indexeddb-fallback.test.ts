import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";

const client = new WebDriverClient();

async function openAccountPreferences(): Promise<void> {
  await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    if (ctx.showPreferencesPanel?.__v_isRef) ctx.showPreferencesPanel.value = true;
    else ctx.showPreferencesPanel = true;
  `);
  await client.click(await client.waitForElement('[data-testid="preferences-account-tab"]'));
}

async function desktopAuthState(): Promise<{ status?: string; message?: string; user?: { email?: string | null } }> {
  return await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const state = ctx.desktopAuthState?.__v_isRef ? ctx.desktopAuthState.value : ctx.desktopAuthState;
    return JSON.parse(JSON.stringify(state ?? null));
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
      authState: await desktopAuthState(),
      fault: await client.executeSync("return window.__KANNA_E2E_AUTH_INDEXEDDB_FAULT__ ?? null;"),
    };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for signed-in email; diagnostics=${JSON.stringify(lastDiagnostics)}`);
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
    await client.sendKeys(await client.waitForElement('[data-testid="account-email"]'), "upvote.sieve.7t@icloud.com");
    await client.sendKeys(await client.waitForElement('[data-testid="account-password"]'), "password123");
    await client.click(await client.waitForElement('[data-testid="account-sign-in"] .primary-button'));

    await waitForSignedInEmail("upvote.sieve.7t@icloud.com");

    const bodyText = await client.executeSync<string>("return document.body.innerText;");
    expect(bodyText).not.toContain("Firebase Auth storage is not available.");
    expect(await desktopAuthState()).toMatchObject({
      status: "signedIn",
      user: { email: "upvote.sieve.7t@icloud.com" },
    });

    const afterSignInFault = await client.executeSync<{ openFailures?: number }>(
      "return window.__KANNA_E2E_AUTH_INDEXEDDB_FAULT__ ?? null;",
    );
    expect(afterSignInFault.openFailures ?? 0).toBeGreaterThan(0);
  });
});
