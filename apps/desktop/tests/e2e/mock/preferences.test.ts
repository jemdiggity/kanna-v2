import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase } from "../helpers/reset";
import { queryDb } from "../helpers/vue";

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
    // Find and click the settings/gear button
    const buttons = await client.findElements("button");
    for (const id of buttons) {
      const text = await client.getText(id);
      if (text.includes("\u2699") || text.includes("settings") || text.includes("\u{2699}")) {
        await client.click(id);
        break;
      }
    }

    await Bun.sleep(500);
    const panel = await client.waitForElement(".prefs-panel", 2000);
    expect(panel).toBeTruthy();
  });

  it("shows preference fields", async () => {
    const panelText = await client.executeSync<string>(
      `return document.querySelector(".prefs-panel")?.textContent || ""`
    );
    // Should contain labels for common settings
    expect(panelText.toLowerCase()).toContain("font");
    expect(panelText.toLowerCase()).toContain("appearance");
  });

  it("closes preferences panel", async () => {
    // Find close button within preferences
    const buttons = await client.findElements(".prefs-panel button");
    for (const id of buttons) {
      const text = await client.getText(id);
      if (text.includes("Close") || text.includes("\u2715") || text === "X") {
        await client.click(id);
        break;
      }
    }

    await Bun.sleep(300);
    await client.waitForNoElement(".prefs-panel", 2000);
  });

  it("default settings are in DB", async () => {
    const rows = (await queryDb(
      client,
      "SELECT key, value FROM settings ORDER BY key"
    )) as Array<{ key: string; value: string }>;

    const keys = rows.map((r) => r.key);
    expect(keys).toContain("terminal_font_family");
    expect(keys).toContain("terminal_font_size");
    expect(keys).toContain("appearance_mode");
  });
});
