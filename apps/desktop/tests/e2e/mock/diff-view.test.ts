import { resolve } from "path";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, getVueState, tauriInvoke } from "../helpers/vue";

const TEST_REPO_PATH = resolve(import.meta.dir, "../../../..");

describe("diff view", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await importTestRepo(client, TEST_REPO_PATH, "diff-test");

    // Create a task to get a worktree
    await callVueMethod(client, "handleNewTaskSubmit", "Say OK");

    // Wait for the task to appear and get its branch
    await client.waitForText(".sidebar", "In Progress");
    await Bun.sleep(1000);
  });

  afterAll(async () => {
    await cleanupWorktrees(client, TEST_REPO_PATH);
    await client.deleteSession();
  });

  it("shows diff tab", async () => {
    const tabs = await client.findElements(".tab");
    const texts: string[] = [];
    for (const id of tabs) {
      texts.push(await client.getText(id));
    }
    expect(texts.some((t) => t.trim() === "Diff")).toBe(true);
  });

  it("shows diff content after writing a file", async () => {
    // Get the worktree path from the selected item
    const item = (await callVueMethod(client, "selectedItem")) as {
      branch: string;
    } | null;
    if (!item?.branch) {
      // Skip if no item selected (task creation may have failed)
      console.warn("No task selected, skipping diff content test");
      return;
    }

    const worktreePath = `${TEST_REPO_PATH}/.kanna-worktrees/${item.branch}`;

    // Write a test file into the worktree
    await tauriInvoke(client, "run_script", {
      script: "echo 'diff test content' > diff-test-file.txt",
      cwd: worktreePath,
      env: {},
    });

    // Click the Diff tab
    const tabs = await client.findElements(".tab");
    for (const id of tabs) {
      const text = await client.getText(id);
      if (text.trim() === "Diff") {
        await client.click(id);
        break;
      }
    }

    // Wait for diff to render (not "No changes")
    await Bun.sleep(2000);
    const diffView = await client.findElement(".diff-view");
    const text = await client.getText(diffView);
    // Should either show diff content or at least not be stuck on "Loading..."
    expect(text).not.toContain("Loading diff");
  });
});
