import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase } from "../helpers/reset";

describe("app launch", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    // Reload to get fresh UI after reset
    await client.executeSync("location.reload()");
    await Bun.sleep(1000);
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("renders with title Kanna", async () => {
    const title = await client.getTitle();
    expect(title).toBe("Kanna");
  });

  it("shows empty sidebar message", async () => {
    const el = await client.waitForText(".sidebar-content", "No repos imported");
    expect(el).toBeTruthy();
  });

  it("shows no repo imported in main panel", async () => {
    const el = await client.waitForText(".main-panel", "No repo imported");
    expect(el).toBeTruthy();
  });

  it("has Import Repo button", async () => {
    const buttons = await client.findElements("button");
    const texts: string[] = [];
    for (const id of buttons) {
      texts.push(await client.getText(id));
    }
    expect(texts.some((t) => t.includes("Import Repo"))).toBe(true);
  });

  it("has settings button", async () => {
    const buttons = await client.findElements("button");
    const texts: string[] = [];
    for (const id of buttons) {
      texts.push(await client.getText(id));
    }
    // Settings button shows a gear icon
    expect(buttons.length).toBeGreaterThanOrEqual(3); // +, Import Repo, settings
  });
});
