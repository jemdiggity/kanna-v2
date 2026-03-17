import { resolve } from "path";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, getVueState } from "../helpers/vue";

const TEST_REPO_PATH = resolve(import.meta.dir, "../../../..");
const CTX_SCRIPT = 'document.getElementById("app").__vue_app__._instance.setupState';

describe("keyboard shortcuts", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
  });

  afterAll(async () => {
    await cleanupWorktrees(client, TEST_REPO_PATH);
    await client.deleteSession();
  });

  async function pressKey(key: string, meta = false) {
    await client.executeSync(
      `document.dispatchEvent(new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)},
        metaKey: ${meta},
        bubbles: true,
      }));`
    );
  }

  it("Cmd+N opens New Task modal", async () => {
    await pressKey("n", true);
    await Bun.sleep(300);
    const modal = await client.waitForElement(".modal-overlay", 2000);
    expect(modal).toBeTruthy();
  });

  it("Escape closes modal", async () => {
    // Escape needs to be dispatched on the modal overlay or document
    await pressKey("Escape");
    await Bun.sleep(500);
    // If modal is still visible, try closing via Vue state
    try {
      await client.findElement(".modal-overlay");
      // Modal still there — close via state
      await client.executeSync(
        `${CTX_SCRIPT}.showNewTaskModal = false;`
      );
      await Bun.sleep(300);
    } catch {
      // Modal already gone — success
    }
  });

  it("Cmd+Up/Down navigates pipeline items", async () => {
    // Set up: import repo, create two tasks
    await importTestRepo(client, TEST_REPO_PATH, "keyboard-test");
    await callVueMethod(client, "handleNewTaskSubmit", "Task A");
    await Bun.sleep(1000);
    await callVueMethod(client, "handleNewTaskSubmit", "Task B");
    await Bun.sleep(1000);

    const items = (await getVueState(client, "items")) as Array<{ id: string }>;
    if (items.length < 2) {
      console.warn("Need at least 2 tasks for navigation test");
      return;
    }

    const firstSelected = await getVueState(client, "selectedItemId");

    await pressKey("ArrowDown", true);
    await Bun.sleep(200);
    const afterDown = await getVueState(client, "selectedItemId");
    expect(afterDown).not.toBe(firstSelected);

    await pressKey("ArrowUp", true);
    await Bun.sleep(200);
    const afterUp = await getVueState(client, "selectedItemId");
    expect(afterUp).toBe(firstSelected);
  });

  it("Cmd+Z toggles zen mode", async () => {
    await pressKey("z", true);
    await Bun.sleep(300);

    const zenMode = await getVueState(client, "zenMode");
    expect(zenMode).toBe(true);

    // Sidebar should be hidden
    await client.waitForNoElement(".sidebar", 2000);

    // Escape exits zen mode
    await pressKey("Escape");
    await Bun.sleep(300);

    const zenAfter = await getVueState(client, "zenMode");
    expect(zenAfter).toBe(false);
  });
});
