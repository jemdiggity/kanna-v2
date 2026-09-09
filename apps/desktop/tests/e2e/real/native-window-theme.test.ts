import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { resetDatabase } from "../helpers/reset";
import { WebDriverClient } from "../helpers/webdriver";

async function currentNativeWindowTheme(client: WebDriverClient): Promise<string | null> {
  const result = await client.executeAsync<{ value?: string | null; error?: string }>(
    `const cb = arguments[arguments.length - 1];
     const internals = window.__TAURI_INTERNALS__;
     const label = internals?.metadata?.currentWindow?.label;
     if (!internals?.invoke || !label) {
       cb({ error: "Tauri window internals are unavailable" });
       return;
     }
     internals.invoke("plugin:window|theme", { label })
       .then((theme) => cb({ value: theme ?? null }))
       .catch((error) => cb({ error: error?.message || String(error) }));`,
  );

  if (result?.error) {
    throw new Error(result.error);
  }
  return result?.value ?? null;
}

describe("native window theme", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("updates the current Tauri window theme when app theme is changed to light", async () => {
    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    await client.waitForElement(".prefs-panel", 2_000);

    await client.executeSync(`
      const appTheme = document.querySelector('[data-testid="app-theme-select"]');
      appTheme.value = "light";
      appTheme.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `);
    await client.executeAsync(`
      const cb = arguments[arguments.length - 1];
      setTimeout(() => cb(true), 250);
    `);

    const documentTheme = await client.executeSync<string | undefined>(
      `return document.documentElement.dataset.theme;`,
    );
    expect(documentTheme).toBe("light");

    // WebDriver cannot inspect non-webview macOS traffic-light/titlebar pixels today.
    // The narrowest native-boundary coverage available is Tauri's real Window.theme()
    // getter after driving the preferences flow in the running desktop app.
    await expect(currentNativeWindowTheme(client)).resolves.toBe("light");

    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await client.waitForNoElement(".prefs-panel", 2_000);
  });
});
