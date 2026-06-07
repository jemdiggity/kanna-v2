import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildGlobalKeydownScript, buildSelectorKeydownScript } from "../helpers/keyboard";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase } from "../helpers/reset";
import { tauriInvoke } from "../helpers/vue";

describe("preferences", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("opens preferences panel when settings button clicked", async () => {
    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    const panel = await client.waitForElement(".prefs-panel", 2000);
    expect(panel).toBeTruthy();
  });

  it("shows preference fields", async () => {
    const panelText = await client.executeSync<string>(
      `return document.querySelector(".prefs-panel")?.textContent || ""`
    );
    // Should contain labels for common settings
    expect(panelText.toLowerCase()).toContain("suspend");
    expect(panelText.toLowerCase()).toContain("ide");
  });

  it("closes preferences panel", async () => {
    await client.executeSync(buildSelectorKeydownScript(".modal-overlay", { key: "Escape" }));
    await client.waitForNoElement(".prefs-panel", 2_000);
  });

  it("toggles the preferences panel closed from the keyboard shortcut", async () => {
    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    const panel = await client.waitForElement(".prefs-panel", 2_000);
    expect(panel).toBeTruthy();

    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    await client.waitForNoElement(".prefs-panel", 2_000);
  });

  it("shows default settings in the UI", async () => {
    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    const panel = await client.waitForElement(".prefs-panel", 2_000);
    expect(panel).toBeTruthy();

    const values = await client.executeSync<string[]>(
      `return Array.from(document.querySelectorAll(".prefs-panel input, .prefs-panel select"))
        .map((element) => element.value);`
    );
    expect(values).toContain("5");
    expect(values).toContain("30");
  });

  it("shows the current desktop ID on the Account tab", async () => {
    await client.executeSync(buildSelectorKeydownScript(".modal-overlay", { key: "Escape" }));
    await client.waitForNoElement(".prefs-panel", 2_000);

    const status = await tauriInvoke(client, "mobile_server_status") as { desktopId?: string };
    expect(status.desktopId?.trim()).toBeTruthy();
    const desktopId = status.desktopId!.trim();

    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    await client.waitForElement(".prefs-panel", 2_000);

    const accountTab = await client.findElement('[data-testid="preferences-account-tab"]');
    await client.click(accountTab);

    await client.waitForText(".prefs-panel", "Desktop ID", 2_000);
    await client.waitForText(".prefs-panel", desktopId, 2_000);
  });

  it("persists app and terminal code theme preferences", async () => {
    await client.executeSync(buildSelectorKeydownScript(".modal-overlay", { key: "Escape" }));
    await client.waitForNoElement(".prefs-panel", 2_000);

    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    await client.waitForElement(".prefs-panel", 2_000);

    await client.executeSync(`
      const appTheme = document.querySelector('[data-testid="app-theme-select"]');
      const codeTheme = document.querySelector('[data-testid="code-theme-select"]');
      appTheme.value = "light";
      appTheme.dispatchEvent(new Event("change", { bubbles: true }));
      codeTheme.value = "dark";
      codeTheme.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `);
    await client.executeAsync(`
      const cb = arguments[arguments.length - 1];
      setTimeout(() => cb(true), 250);
    `);

    const attrs = await client.executeSync<{ theme?: string; codeTheme?: string }>(`
      return {
        theme: document.documentElement.dataset.theme,
        codeTheme: document.documentElement.dataset.codeTheme,
      };
    `);
    expect(attrs).toEqual({ theme: "light", codeTheme: "dark" });

    await client.executeSync(buildSelectorKeydownScript(".modal-overlay", { key: "Escape" }));
    await client.waitForNoElement(".prefs-panel", 2_000);
    await client.deleteSession();
    await client.createSession();

    const persisted = await client.executeSync<{ appTheme?: string; codeTheme?: string }>(`
      const unwrap = (value) => value && value.__v_isRef ? value.value : value;
      return window.__KANNA_E2E__?.setupState
        ? {
            appTheme: unwrap(window.__KANNA_E2E__.setupState.store?.appTheme),
            codeTheme: unwrap(window.__KANNA_E2E__.setupState.store?.codeTheme),
          }
        : {};
    `);
    expect(persisted).toEqual({ appTheme: "light", codeTheme: "dark" });
  });
});
