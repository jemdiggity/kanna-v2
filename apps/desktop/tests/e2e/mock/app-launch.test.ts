import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase } from "../helpers/reset";
import { pauseForSlowMode } from "../helpers/slowMode";

describe("app launch", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession({ dismissStartupShortcuts: false });
    await pauseForSlowMode("app-launch session created");
    await resetDatabase(client);
    await pauseForSlowMode("app-launch database reset");
    // Reload to get fresh UI after reset
    await client.executeSync("location.reload()");
    await sleep(1000);
    await pauseForSlowMode("app-launch UI reloaded");
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("loads the frontend from this instance's dev server", async () => {
    // Tauri compiles `build.devUrl` into the binary, but each instance gets its own port
    // at launch. When a cached build keeps an earlier run's port the window is refused and
    // sits at about:blank — see apps/desktop/src-tauri/src/dev_url.rs.
    const devPort = process.env.KANNA_DEV_PORT;
    expect(devPort).toBeTruthy();
    const origin = await client.executeSync<string>("return location.origin;");
    expect(origin).toBe(`http://localhost:${devPort}`);
  });

  it("renders and screenshots without pulling the app into the foreground", async () => {
    // E2E runs launch real macOS apps. `KANNA_E2E_NO_ACTIVATE=1` — set for every
    // harness-launched instance — gives them a non-activating activation policy so a
    // run cannot take the operator's keyboard focus. An app that never activates is
    // only useful here if WebKit still paints it, so assert both halves.
    const screenshot = await client.screenshot();
    expect(Buffer.from(screenshot, "base64").byteLength).toBeGreaterThan(1024);
    if (process.env.KANNA_E2E_NO_ACTIVATE === "0") return;
    const hasFocus = await client.executeSync<boolean>("return document.hasFocus();");
    expect(hasFocus).toBe(false);
  });

  it("renders with title Kanna", async () => {
    await pauseForSlowMode("before title assertion");
    const title = await client.getTitle();
    expect(title).toBe("Kanna");
  });

  it("shows empty sidebar message", async () => {
    await pauseForSlowMode("before empty sidebar assertion");
    const el = await client.waitForText(".sidebar", "No repos yet.");
    expect(el).toBeTruthy();
  });

  it("shows onboarding guidance in main panel", async () => {
    await pauseForSlowMode("before onboarding guidance assertion");
    const el = await client.waitForText(".main-panel", "Press ⇧⌘J to open a shell");
    expect(el).toBeTruthy();
  });

  it("shows detected agent CLI versions", async () => {
    await client.waitForText(".main-panel", "v0.125.0-beta.1+20260429");
    const bodyText = await client.executeSync<string>("return document.body.innerText;");
    expect(bodyText).toContain("Claude Code");
    expect(bodyText).toContain("v2.1.118");
    expect(bodyText).toContain("GitHub Copilot");
    expect(bodyText).toContain("v1.0.32");
    expect(bodyText).toContain("Codex");
    expect(bodyText).toContain("v0.125.0-beta.1+20260429");
  });

  it("shows repo creation shortcut hint", async () => {
    await pauseForSlowMode("before repo creation hint assertion");
    const bodyText = await client.executeSync<string>("return document.body.innerText;");
    expect(bodyText).toContain("Press ⌘I to create one.");
  });

  it("shows keyboard shortcuts reference", async () => {
    await pauseForSlowMode("before keyboard shortcuts assertion");
    const bodyText = await client.executeSync<string>("return document.body.innerText;");
    expect(bodyText).toContain("Keyboard Shortcuts");
  });
});
