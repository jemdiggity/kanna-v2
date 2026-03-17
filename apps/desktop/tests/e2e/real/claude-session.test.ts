import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod } from "../helpers/vue";
import { resolve } from "path";

setDefaultTimeout(15_000);

// Resolve repo path relative to this file
const TEST_REPO_PATH = resolve(import.meta.dir, "../../../../..");

describe("claude session (real CLI)", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await importTestRepo(client, TEST_REPO_PATH, "claude-real-test");
  });

  afterAll(async () => {
    await cleanupWorktrees(client, TEST_REPO_PATH);
    await client.deleteSession();
  });

  it("creates task and receives Claude output", async () => {
    await callVueMethod(
      client,
      "handleNewTaskSubmit",
      "Respond with exactly: E2E_TEST_OK"
    );

    // Wait for task to appear
    await client.waitForText(".sidebar", "In Progress");

    // Wait for result block — up to 90s for Claude to respond
    const result = await client.waitForElement(".result-block", 90_000);
    expect(result).toBeTruthy();

    const text = await client.getText(result);
    expect(text).toContain("Completed");
  });

  it("rendered at least one assistant message before result", async () => {
    const textBlocks = await client.findElements(".agent-view .text-block");
    expect(textBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it("agent is no longer running", async () => {
    await client.waitForNoElement(".running-indicator", 5000);
  });
});
