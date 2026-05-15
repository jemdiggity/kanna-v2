import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { callVueMethod } from "../helpers/vue";

const { primary, secondary } = createPrimaryAndSecondaryClients();
let testRepoPath = "";

async function setSetupState(client: typeof primary, key: string, value: unknown): Promise<void> {
  await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const key = ${JSON.stringify(key)};
    const value = ${JSON.stringify(value)};
    if (ctx[key]?.__v_isRef) ctx[key].value = value;
    else ctx[key] = value;
  `);
}

async function signIn(client: typeof primary): Promise<void> {
  await setSetupState(client, "showPreferencesPanel", true);
  await client.click(await client.waitForElement('[data-testid="preferences-account-tab"]'));
  await client.sendKeys(await client.waitForElement('[data-testid="account-email"]'), "upvote.sieve.7t@icloud.com");
  await client.sendKeys(await client.waitForElement('[data-testid="account-password"]'), "password123");
  await client.click(await client.waitForElement('[data-testid="account-sign-in"] .primary-button'));
  await client.waitForText(".prefs-panel", "upvote.sieve.7t@icloud.com", 15_000);
  await setSetupState(client, "showPreferencesPanel", false);
  await setSetupState(client, "maximized", false);
  await setSetupState(client, "sidebarHidden", false);
}

async function waitForSidebarTask(client: typeof primary, text: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    if (sidebarText.includes(text)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for sidebar text: ${text}`);
}

describe("cloud task sync", () => {
  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    await signIn(primary);
    await signIn(secondary);
    testRepoPath = await createFixtureRepo("cloud-task-sync-source");
  });

  afterAll(async () => {
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupFixtureRepos(testRepoPath ? [testRepoPath] : []).catch(() => undefined);
    await primary.deleteSession().catch(() => undefined);
    await secondary.deleteSession().catch(() => undefined);
  });

  it("shows a task created on one signed-in desktop on another signed-in desktop", async () => {
    const repoId = await importTestRepo(primary, testRepoPath, "cloud-sync-repo");
    await setSetupState(primary, "maximized", false);
    await setSetupState(primary, "sidebarHidden", false);
    const result = await callVueMethod(
      primary,
      "store.createItem",
      repoId,
      testRepoPath,
      "Cloud sync visible task",
      "sdk",
      { agentProvider: "codex", baseRef: "origin/main" },
    );
    if (result && typeof result === "object" && "__error" in result) {
      throw new Error(String((result as { __error: string }).__error));
    }

    await waitForSidebarTask(primary, "Cloud sync visible task");
    await sleep(1000);
    await waitForSidebarTask(secondary, "Cloud sync visible task");
    const secondaryText = await secondary.executeSync<string>("return document.body.innerText;");
    expect(secondaryText).toContain("peer-primary");
  });
});
