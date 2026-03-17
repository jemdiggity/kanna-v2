import { resolve } from "path";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod } from "../helpers/vue";

const TEST_REPO_PATH = resolve(import.meta.dir, "../../../..");

describe("task lifecycle", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await importTestRepo(client, TEST_REPO_PATH, "lifecycle-test");
  });

  afterAll(async () => {
    await cleanupWorktrees(client, TEST_REPO_PATH);
    await client.deleteSession();
  });

  it("creates a task that appears in sidebar", async () => {
    await callVueMethod(
      client,
      "handleNewTaskSubmit",
      "Say OK"
    );

    // Task should appear in sidebar with In Progress badge
    const el = await client.waitForText(".sidebar", "In Progress");
    expect(el).toBeTruthy();
  });

  it("shows task header with prompt text", async () => {
    const el = await client.waitForText(".task-header", "Say OK");
    expect(el).toBeTruthy();
  });

  it("shows Agent tab as active", async () => {
    const activeTab = await client.findElement(".tab.active");
    const text = await client.getText(activeTab);
    expect(text.trim()).toBe("Agent");
  });

  it("shows agent output after Claude responds", async () => {
    // Wait for at least one message block to appear (up to 60s for real Claude)
    const el = await client.waitForElement(".agent-view .message-block", 60000);
    expect(el).toBeTruthy();
  }, 65000);

  it("shows result block when completed", async () => {
    const el = await client.waitForElement(".result-block", 60000);
    const text = await client.getText(el);
    expect(text).toContain("Completed");
  }, 65000);

  it("closes task and updates stage", async () => {
    // Find and click the Close button
    const buttons = await client.findElements("button");
    for (const id of buttons) {
      const text = await client.getText(id);
      if (text.trim() === "Close") {
        await client.click(id);
        break;
      }
    }

    // Stage should update to Closed in sidebar
    await Bun.sleep(500);
    const el = await client.waitForText(".sidebar", "Closed");
    expect(el).toBeTruthy();
  });
});
