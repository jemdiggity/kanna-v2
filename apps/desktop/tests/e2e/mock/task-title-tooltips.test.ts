import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

describe("task title tooltips", () => {
  const client = new WebDriverClient();
  const fullPrompt =
    "Investigate the complete sidebar and task header tooltip behavior for a deliberately long task prompt that should remain available through native title attributes.";

  let fixtureRepoRoot = "";
  let repoId = "";
  let taskId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("task-title-tooltips-test");
    repoId = await importTestRepo(client, fixtureRepoRoot, "task-title-tooltips-test");

    const createResult = await callVueMethod(
      client,
      "store.createItem",
      repoId,
      fixtureRepoRoot,
      fullPrompt,
      "sdk",
      { agentProvider: "claude" },
    );
    if (isVueCallError(createResult)) throw new Error(createResult.__error);
    if (typeof createResult !== "string") {
      throw new Error(`unexpected create result: ${JSON.stringify(createResult)}`);
    }
    taskId = createResult;

    const selectResult = await callVueMethod(client, "selectSidebarItemById", taskId);
    if (isVueCallError(selectResult)) throw new Error(selectResult.__error);
  });

  afterAll(async () => {
    if (fixtureRepoRoot) {
      await cleanupWorktrees(client, fixtureRepoRoot);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("exposes the full prompt through sidebar and task header title attributes", async () => {
    await client.waitForText(".sidebar .item-title", fullPrompt, 5_000);
    await client.waitForText(".task-header .task-title", fullPrompt, 5_000);

    // Browser-native tooltip popups are not exposed through the Tauri
    // WebDriver session, so the observable E2E contract is the title
    // attribute that native tooltips read from.
    await waitForCondition(async () => {
      const attributes = await client.executeSync<{
        sidebarTitle: string | null;
        headerTitle: string | null;
      }>(
        `return {
           sidebarTitle: document.querySelector(".sidebar .workflow-item.selected .item-title")?.getAttribute("title") ?? null,
           headerTitle: document.querySelector(".task-header .task-title")?.getAttribute("title") ?? null,
         };`,
      );

      return attributes.sidebarTitle === fullPrompt && attributes.headerTitle === fullPrompt;
    }, "task title tooltip attributes");
  });
});
