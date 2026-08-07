import { realpath } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildSelectorKeydownScript } from "../helpers/keyboard";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { importTestRepo, resetDatabase } from "../helpers/reset";
import { queryDb } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

interface RepoRow {
  id: string;
  name: string;
  path: string;
}

const ORIGINAL_NAME = "repo-rename-original";
const RENAMED_NAME = "Renamed Workspace";

async function sidebarRepoNames(client: WebDriverClient): Promise<string[]> {
  return await client.executeSync<string[]>(
    `return Array.from(document.querySelectorAll(".repo-header .repo-name"))
      .map((element) => element.textContent?.trim() ?? "");`,
  );
}

async function waitForSidebarRepoName(client: WebDriverClient, name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await sidebarRepoNames(client)).includes(name)) return;
    await sleep(100);
  }
  throw new Error(`sidebar never showed repo name: ${name}`);
}

async function openRepoRenameEditor(client: WebDriverClient, name: string): Promise<string> {
  const opened = await client.executeSync<boolean>(
    `const names = Array.from(document.querySelectorAll(".repo-header .repo-name"));
     const target = names.find((element) => element.textContent?.trim() === ${JSON.stringify(name)});
     if (!target) return false;
     target.dispatchEvent(new MouseEvent("dblclick", {
       bubbles: true,
       cancelable: true,
       view: window,
     }));
     return true;`,
  );
  if (!opened) throw new Error(`repo name not found for rename: ${name}`);
  return await client.waitForElement(".repo-rename-input", 5_000);
}

describe("repo rename", () => {
  const client = new WebDriverClient();
  let repoRoot = "";
  let repoId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    repoRoot = await createFixtureRepo(ORIGINAL_NAME);
    repoId = await importTestRepo(client, repoRoot, ORIGINAL_NAME);
    await waitForSidebarRepoName(client, ORIGINAL_NAME);
  });

  afterAll(async () => {
    await cleanupFixtureRepos(repoRoot ? [repoRoot] : []);
    await client.deleteSession();
  });

  it("renames only the imported repository display name from the sidebar", async () => {
    const input = await openRepoRenameEditor(client, ORIGINAL_NAME);
    await client.clear(input);
    await client.sendKeys(input, RENAMED_NAME);
    await client.executeSync(buildSelectorKeydownScript(".repo-rename-input", { key: "Enter" }));

    await waitForSidebarRepoName(client, RENAMED_NAME);
    expect(await sidebarRepoNames(client)).not.toContain(ORIGINAL_NAME);

    const rows = await queryDb(
      client,
      "SELECT id, name, path FROM repo WHERE id = ?",
      [repoId],
    ) as RepoRow[];
    expect(rows).toEqual([{ id: repoId, name: RENAMED_NAME, path: await realpath(repoRoot) }]);

    await client.reload();
    await waitForSidebarRepoName(client, RENAMED_NAME);
  });
});
