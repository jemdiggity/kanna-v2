import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

interface SidebarSearchSnapshot {
  inputValue: string;
  hasClearButton: boolean;
  isFiltering: boolean;
  repoCount: string | null;
  taskTitles: string[];
}

const SEARCH_INPUT_SELECTOR = ".sidebar .search-input";
const CLEAR_BUTTON_SELECTOR = '[data-testid="sidebar-search-clear"]';

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

async function getSidebarSearchSnapshot(client: WebDriverClient): Promise<SidebarSearchSnapshot> {
  return client.executeSync<SidebarSearchSnapshot>(
    `const isVisible = (element) => {
       if (!element || element.getClientRects().length === 0) return false;
       let current = element;
       while (current && current !== document.body) {
         const style = getComputedStyle(current);
         if (style.display === "none" || style.visibility === "hidden") return false;
         current = current.parentElement;
       }
       return true;
     };
     return {
       inputValue: document.querySelector(${JSON.stringify(SEARCH_INPUT_SELECTOR)})?.value ?? "",
       hasClearButton: Boolean(document.querySelector(${JSON.stringify(CLEAR_BUTTON_SELECTOR)})),
       isFiltering: Boolean(document.querySelector(".sidebar.is-filtering")),
       repoCount: document.querySelector(".sidebar .repo-count")?.textContent?.trim() ?? null,
       taskTitles: Array.from(document.querySelectorAll(".sidebar .workflow-item .item-title"))
         .filter(isVisible)
         .map((element) => element.textContent?.trim() ?? ""),
     };`,
  );
}

async function seedSearchRepo(client: WebDriverClient, repoPath: string): Promise<string> {
  const repoId = "repo-sidebar-task-search";
  await execDb(
    client,
    `INSERT INTO repo (id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, 0, 0, datetime('now'), datetime('now'))`,
    [repoId, repoPath, "sidebar-task-search-test", "main"],
  );
  const refreshResult = await callVueMethod(client, "refreshRepos");
  if (refreshResult && typeof refreshResult === "object" && "__error" in refreshResult) {
    throw new Error(String((refreshResult as { __error: unknown }).__error));
  }
  await callVueMethod(client, "store.selectRepo", repoId);
  return repoId;
}

async function waitForSidebarSnapshot(
  client: WebDriverClient,
  predicate: (snapshot: SidebarSearchSnapshot) => boolean,
  description: string,
): Promise<SidebarSearchSnapshot> {
  let lastSnapshot: SidebarSearchSnapshot | null = null;
  await waitForCondition(async () => {
    lastSnapshot = await getSidebarSearchSnapshot(client);
    return predicate(lastSnapshot);
  }, description);

  if (!lastSnapshot) {
    throw new Error(`No sidebar snapshot captured while waiting for ${description}`);
  }
  return lastSnapshot;
}

describe("sidebar task search", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    testRepoPath = await createFixtureRepo("sidebar-task-search-test");
    const repoId = await seedSearchRepo(client, testRepoPath);
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, display_name, stage, agent_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "sidebar-search-task-1",
        repoId,
        "Fix sidebar search visibility",
        "Sidebar visibility fix",
        "in progress",
        "agent",
        "2026-04-13T11:00:00.000Z",
        "2026-04-13T11:00:00.000Z",
      ],
    );
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, display_name, stage, agent_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "sidebar-search-task-2",
        repoId,
        "Refine merge queue behavior",
        "Merge queue polish",
        "pr",
        "agent",
        "2026-04-13T10:00:00.000Z",
        "2026-04-13T10:00:00.000Z",
      ],
    );
    await client.reload();
    await client.waitForText(".sidebar", "Sidebar visibility fix");
    await client.waitForText(".sidebar", "Merge queue polish");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupFixtureRepos([testRepoPath]);
    }
    await client.deleteSession();
  });

  it("shows and clears the task search filter from the sidebar", async () => {
    let snapshot = await waitForSidebarSnapshot(
      client,
      (current) =>
        current.inputValue === "" &&
        !current.hasClearButton &&
        !current.isFiltering &&
        current.repoCount === "2" &&
        current.taskTitles.includes("Sidebar visibility fix") &&
        current.taskTitles.includes("Merge queue polish"),
      "unfiltered sidebar task list",
    );

    expect(snapshot.taskTitles).toEqual(expect.arrayContaining([
      "Sidebar visibility fix",
      "Merge queue polish",
    ]));

    const searchInput = await client.waitForElement(SEARCH_INPUT_SELECTOR, 2_000);
    await client.sendKeys(searchInput, "visibility");

    snapshot = await waitForSidebarSnapshot(
      client,
      (current) =>
        current.inputValue === "visibility" &&
        current.hasClearButton &&
        current.isFiltering &&
        current.repoCount === "1/2" &&
        current.taskTitles.length === 1 &&
        current.taskTitles[0] === "Sidebar visibility fix",
      "filtered sidebar task search results",
    );

    expect(snapshot).toMatchObject({
      inputValue: "visibility",
      hasClearButton: true,
      repoCount: "1/2",
      taskTitles: ["Sidebar visibility fix"],
    });

    const clearButton = await client.waitForElement(CLEAR_BUTTON_SELECTOR, 2_000);
    await client.click(clearButton);

    snapshot = await waitForSidebarSnapshot(
      client,
      (current) =>
        current.inputValue === "" &&
        !current.hasClearButton &&
        !current.isFiltering &&
        current.repoCount === "2" &&
        current.taskTitles.includes("Sidebar visibility fix") &&
        current.taskTitles.includes("Merge queue polish"),
      "restored unfiltered sidebar task list after clearing search",
    );

    expect(snapshot.taskTitles).toEqual(expect.arrayContaining([
      "Sidebar visibility fix",
      "Merge queue polish",
    ]));
  });
});
