import { mkdir } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { waitForTaskCreated } from "../helpers/taskCreation";
import { callVueMethod } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

// Claude is never driven by an unattended runner. Keep this coverage visible
// in the operator tier, but skipped unless a human deliberately configures a
// Claude-only run.
describe.skipIf(process.env.KANNA_E2E_REAL_AGENT_PROVIDER !== "claude")("themed Claude session (real CLI)", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();
    testRepoPath = await createFixtureRepo("themed-claude-session-real-test");
    await mkdir(`${testRepoPath}/.kanna`, { recursive: true });
    await importTestRepo(client, testRepoPath, "themed-claude-session-real-test");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("spawns a daemon agent session and renders the themed view", async () => {
    const repoId = await client.executeSync<string>(
      `return window.__KANNA_E2E__.setupState.store.repos.find((repo) => repo.path === ${JSON.stringify(testRepoPath)})?.id;`,
    );
    const prompt = "Reply with exactly: themed claude ok";

    const result = await callVueMethod(client, "store.createItem", repoId, testRepoPath, prompt, "agent", {
      agentProvider: "claude",
      permissionMode: "dontAsk",
    });
    expect(typeof result).toBe("string");

    const task = await waitForTaskCreated(client, prompt, 20_000);
    expect(task.agent_provider).toBe("claude");
    expect(task.agent_type).toBe("agent");

    await client.waitForElement('[data-testid="agent-message-view"]', 30_000);
  }, 120_000);
});
