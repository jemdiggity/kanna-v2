import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod } from "../helpers/vue";
import { resolve } from "path";

setDefaultTimeout(120_000);

const TEST_REPO_PATH = resolve(import.meta.dir, "../../../../..");

describe("diff after claude (real CLI)", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await importTestRepo(client, TEST_REPO_PATH, "diff-real-test");
  });

  afterAll(async () => {
    await cleanupWorktrees(client, TEST_REPO_PATH);
    await client.deleteSession();
  });

  it("creates task that writes a file and shows diff", async () => {
    await callVueMethod(
      client,
      "handleNewTaskSubmit",
      "Create a file called e2e-test-output.txt containing exactly: E2E test content"
    );

    // Wait for task and completion
    await client.waitForText(".sidebar", "In Progress");
    await client.waitForElement(".result-block", 90_000);

    // Switch to Diff tab
    const tabs = await client.findElements(".tab");
    for (const id of tabs) {
      const text = await client.getText(id);
      if (text.trim() === "Diff") {
        await client.click(id);
        break;
      }
    }

    // Wait for diff to render
    await Bun.sleep(3000);

    const diffView = await client.findElement(".diff-view");
    const text = await client.getText(diffView);

    expect(text).toContain("e2e-test-output");
  });
});
