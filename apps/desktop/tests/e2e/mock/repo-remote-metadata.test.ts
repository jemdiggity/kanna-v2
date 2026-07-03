import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { callVueMethod, execDb, queryDb } from "../helpers/vue";

interface RepoMetadataRow {
  id: string;
  remote_url: string | null;
  remote_url_hash: string | null;
}

async function e2eInvokeCommands(client: WebDriverClient): Promise<string[]> {
  return await client.executeSync<string[]>(
    `return window.__KANNA_E2E__.invokes.getAll().map((call) => call.cmd);`,
  );
}

async function waitForNoGitRemoteUrlInvokes(
  client: WebDriverClient,
  timeoutMs = 2500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let commands: string[] = [];

  while (Date.now() < deadline) {
    commands = await e2eInvokeCommands(client);
    expect(commands.filter((command) => command === "git_remote_url")).toEqual([]);
    await sleep(100);
  }
}

async function callLanRefresh(client: WebDriverClient): Promise<void> {
  const result = await callVueMethod(client, "refreshLanTasks");
  expect(result).toBeNull();
}

describe("repo remote metadata", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let repoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("repo-remote-metadata-cache");
    repoPath = fixtureRepoRoot;
  });

  afterAll(async () => {
    if (repoPath) {
      await cleanupWorktrees(client, repoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("uses persisted remote metadata for repeated LAN task index refreshes", async () => {
    const repoId = await importTestRepo(client, repoPath, "repo-remote-metadata-cache");
    const rows = await queryDb(
      client,
      "SELECT id, remote_url, remote_url_hash FROM repo WHERE id = ?",
      [repoId],
    ) as RepoMetadataRow[];
    expect(rows[0]).toEqual(expect.objectContaining({
      id: repoId,
      remote_url: expect.any(String),
      remote_url_hash: expect.any(String),
    }));

    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, branch,
         agent_type, agent_provider, activity, closed_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'default', 'in progress', ?, 'pty', 'claude', 'idle', NULL, datetime('now'), datetime('now'))`,
      ["task-remote-metadata-cache", repoId, "Publish cached remote metadata", "task-remote-metadata-cache"],
    );

    const refreshResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       Promise.resolve(window.__KANNA_E2E__.setupState.refreshAllItems())
         .then(() => cb("ok"))
         .catch((error) => cb("__error:" + (error?.message || String(error))));`,
    );
    expect(refreshResult).toBe("ok");
    await client.executeSync(`window.__KANNA_E2E__.invokes.clear();`);

    await callLanRefresh(client);
    await callLanRefresh(client);
    await waitForNoGitRemoteUrlInvokes(client);

    const commands = await e2eInvokeCommands(client);
    expect(commands.filter((command) => command === "set_transfer_task_snapshot").length).toBeGreaterThanOrEqual(2);
    expect(commands.filter((command) => command === "git_remote_url")).toEqual([]);
  });
});
