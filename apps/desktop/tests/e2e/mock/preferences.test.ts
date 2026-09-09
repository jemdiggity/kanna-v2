import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase } from "../helpers/reset";
import { tauriInvoke } from "../helpers/vue";

async function activeTabLabel(client: WebDriverClient): Promise<string> {
  return client.executeSync<string>(
    `return document.querySelector(".prefs-panel .tab.active")?.textContent?.trim() ?? "";`
  );
}

async function preferencesTabCount(client: WebDriverClient): Promise<number> {
  return client.executeSync<number>(
    `const tabs = window.__KANNA_E2E__?.setupState?.mainTabs;
     if (!tabs) throw new Error("main tabs are unavailable on setupState");
     return (tabs.tabs?.value ?? []).filter((tab) => tab.kind === "preferences").length;`
  );
}

describe("preferences", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync(`
      if (window.__KANNA_E2E__) {
        window.__KANNA_E2E__.mobileInstallUrl = "https://kanna.build/mobile";
      }
      return true;
    `);
    const configuredInstallUrl = await client.executeSync<string>(
      `return window.__KANNA_E2E__?.mobileInstallUrl || "";`,
    );
    expect(configuredInstallUrl).toBe("https://kanna.build/mobile");
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
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await client.waitForNoElement(".prefs-panel", 2_000);
  });

  // Preferences is a tab now, so its shortcut opens rather than toggles: a
  // second press brings the same tab forward instead of closing the one the
  // owner just asked for. Escape is what closes it.
  it("keeps one preferences tab open when the shortcut is pressed again", async () => {
    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    const panel = await client.waitForElement(".prefs-panel", 2_000);
    expect(panel).toBeTruthy();

    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    await client.waitForElement(".prefs-panel", 2_000);
    expect(await client.findElements(".prefs-panel")).toHaveLength(1);
    expect(await preferencesTabCount(client)).toBe(1);

    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await client.waitForNoElement(".prefs-panel", 2_000);
    expect(await preferencesTabCount(client)).toBe(0);
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
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
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

  it("shows the mobile access pairing panel on the Mobile tab", async () => {
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await client.waitForNoElement(".prefs-panel", 2_000);

    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    await client.waitForElement(".prefs-panel", 2_000);

    const mobileTab = await client.findElement('[data-testid="preferences-mobile-tab"]');
    await client.click(mobileTab);

    await client.waitForElement('[data-testid="mobile-access-panel"]', 2_000);
    await client.waitForText(".prefs-panel", "Mobile Access", 2_000);
    await client.waitForElement('[data-testid="mobile-access-install-qr"]', 2_000);
    await client.waitForElement('[data-testid="mobile-access-install-label"]', 2_000);

    await client.click(await client.findElement('[data-testid="mobile-access-start-pairing"]'));
    await client.waitForElement('[data-testid="mobile-access-pairing-qr"]', 2_000);
    await client.waitForElement('[data-testid="mobile-access-pairing-qr-label"]', 2_000);

    const labels = await client.executeSync<string[]>(`
      return Array.from(document.querySelectorAll(
        '[data-testid="mobile-access-install-label"], [data-testid="mobile-access-pairing-qr-label"]',
      ))
        .map((element) => element.textContent?.trim() || "");
    `);
    expect(labels).toEqual(["Get the Kanna mobile app", "Pairing QR code"]);
  });

  it("persists app and terminal code theme preferences", async () => {
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
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

    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
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

  // The palette stacks on top of Preferences rather than replacing it, so its tab
  // commands dispatch through AppModalLayer into the panel underneath.
  it("cycles preferences tabs from the command palette", async () => {
    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    await client.waitForElement(".prefs-panel", 2_000);
    expect(await activeTabLabel(client)).toBe("Preferences");

    await client.executeSync(buildGlobalKeydownScript({ key: "P", meta: true, shift: true }));
    await client.waitForElement(".palette-modal", 2_000);
    expect(await client.findElements(".prefs-panel")).toHaveLength(1);

    const labels = await client.executeSync<string[]>(
      `return Array.from(document.querySelectorAll(".palette-modal .command-label"))
        .map((element) => element.textContent?.trim() ?? "");`
    );
    expect(labels).toContain("Previous Tab");
    expect(labels).toContain("Next Tab");
    // The original bug: untranslated keys leaking into the palette.
    expect(labels.filter((label) => label.startsWith("shortcuts."))).toEqual([]);

    const input = await client.waitForElement(".palette-modal .palette-input");
    await client.sendKeys(input, "Next Tab");
    await client.waitForText(".palette-modal .command-item", "Next Tab", 2_000);
    const clicked = await client.executeSync<boolean>(
      `const command = Array.from(document.querySelectorAll(".palette-modal .command-item"))
        .find((element) => element.textContent?.includes("Next Tab"));
       if (!command) return false;
       command.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
       return true;`
    );
    expect(clicked).toBe(true);

    await client.waitForNoElement(".palette-modal", 5_000);
    await client.waitForElement(".prefs-panel", 2_000);
    expect(await activeTabLabel(client)).toBe("Account");
  });
});
