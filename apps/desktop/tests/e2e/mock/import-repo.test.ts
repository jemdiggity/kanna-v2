import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { queryDb } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { pauseForSlowMode } from "../helpers/slowMode";

interface RepoOrderRow {
  id: string;
  name: string;
  sort_order: number;
}

const FIRST_REPO_NAME = "import-repo-primary";
const SECOND_REPO_NAME = "import-repo-secondary";
const INVALID_CREATE_REPO_NAME = "repo with spaces";

async function findRepoHeader(client: WebDriverClient, repoName: string): Promise<string> {
  const headers = await client.findElements(".repo-header");
  for (const header of headers) {
    const text = await client.getText(header);
    if (text.includes(repoName)) return header;
  }
  throw new Error(`repo header not found: ${repoName}`);
}

async function visibleRepoNames(client: WebDriverClient): Promise<string[]> {
  return await client.executeSync<string[]>(
    `return Array.from(document.querySelectorAll(".repo-header .repo-name"))
      .map((el) => el.textContent?.trim() || "");`
  );
}

async function waitForRepoOrder(client: WebDriverClient, expectedNames: string[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const names = await visibleRepoNames(client);
    if (expectedNames.every((name, index) => names[index] === name)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for repo order: ${expectedNames.join(", ")}`);
}

async function openCreateRepoModal(client: WebDriverClient): Promise<void> {
  const result = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__?.setupState;
     Promise.resolve(ctx?.keyboardActions?.createRepo?.())
       .then(() => cb("ok"))
       .catch((e) => cb("err:" + (e?.message || String(e))));`
  );
  expect(result).toBe("ok");
  await client.waitForText(".modal-overlay .tab.active", "Create New");
}

async function repoRows(client: WebDriverClient): Promise<RepoOrderRow[]> {
  return await queryDb(
    client,
    "SELECT id, name, sort_order FROM repo WHERE hidden = 0 ORDER BY sort_order ASC, created_at ASC",
  ) as RepoOrderRow[];
}

describe("import repo", () => {
  const client = new WebDriverClient();
  let firstRepoRoot = "";
  let secondRepoRoot = "";
  let firstRepoPath = "";
  let secondRepoPath = "";
  let firstRepoId = "";
  let secondRepoId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    firstRepoRoot = await createFixtureRepo(FIRST_REPO_NAME);
    secondRepoRoot = await createFixtureRepo(SECOND_REPO_NAME);
    firstRepoPath = firstRepoRoot;
    secondRepoPath = secondRepoRoot;
  });

  afterAll(async () => {
    await cleanupFixtureRepos([firstRepoRoot, secondRepoRoot].filter(Boolean));
    await client.deleteSession();
  });

  it("does not create a repo when the Create New repo name contains spaces", async () => {
    await openCreateRepoModal(client);

    const input = await client.waitForElement(".modal-overlay input.text-input");
    await client.sendKeys(input, INVALID_CREATE_REPO_NAME);

    await client.waitForText(
      ".modal-overlay .error-inline",
      "Repo names cannot contain spaces. Use hyphens instead.",
    );

    const createButtonState = await client.executeSync<{ disabled: boolean; text: string }>(
      `const button = document.querySelector(".modal-overlay .btn-primary");
       return { disabled: Boolean(button?.disabled), text: button?.textContent?.trim() || "" };`
    );
    expect(createButtonState).toEqual({ disabled: true, text: "Create" });

    await client.executeSync(
      `document.querySelector(".modal-overlay .btn-primary")?.dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true })
       );
       document.querySelector(".modal-overlay input.text-input")?.dispatchEvent(
         new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, metaKey: true })
       );
       window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));`
    );

    await client.waitForElement(".modal-overlay");
    expect(await repoRows(client)).toEqual([]);
    expect(await visibleRepoNames(client)).not.toContain(INVALID_CREATE_REPO_NAME);
  });

  it("imports a repo and shows it in the sidebar", async () => {
    firstRepoId = await importTestRepo(client, firstRepoPath, FIRST_REPO_NAME);

    // Repo should appear in sidebar
    const el = await client.waitForText(".repo-header", FIRST_REPO_NAME);
    expect(el).toBeTruthy();
    await pauseForSlowMode("first repo visible");
  });

  it("shows task count badge as 0", async () => {
    // The repo header shows the count
    const text = await client.executeSync<string>(
      `const headers = document.querySelectorAll(".repo-header");
       for (const h of headers) {
         if (h.textContent.includes(${JSON.stringify(FIRST_REPO_NAME)})) return h.textContent;
       }
       return "";`
    );
    expect(text).toContain("0");
  });

  it("shows No tasks under repo", async () => {
    const el = await client.waitForText(".sidebar", "No tasks");
    expect(el).toBeTruthy();
  });

  it("can import a second repo", async () => {
    secondRepoId = await importTestRepo(client, secondRepoPath, SECOND_REPO_NAME);
    await client.waitForText(".sidebar", SECOND_REPO_NAME, 10000);
    await pauseForSlowMode("second repo visible");
    const text = await client.executeSync<string>(
      `return document.querySelector(".sidebar").textContent;`
    );
    expect(text).toContain(FIRST_REPO_NAME);
    expect(text).toContain(SECOND_REPO_NAME);
  });

  it("can select between repos", async () => {
    const firstHeader = await findRepoHeader(client, FIRST_REPO_NAME);
    const secondHeader = await findRepoHeader(client, SECOND_REPO_NAME);

    await client.click(firstHeader);
    await client.waitForText(".repo-header.selected", FIRST_REPO_NAME);
    await pauseForSlowMode("first repo selected");

    await client.click(secondHeader);
    await client.waitForText(".repo-header.selected", SECOND_REPO_NAME);
    await pauseForSlowMode("second repo selected");
  });

  it("persists repos reordered by dragging their sidebar headers", async () => {
    const sourceHeader = await findRepoHeader(client, SECOND_REPO_NAME);
    const targetHeader = await findRepoHeader(client, FIRST_REPO_NAME);

    await client.click(targetHeader);
    await client.waitForText(".repo-header.selected", FIRST_REPO_NAME);
    await client.dragElementToElement(sourceHeader, targetHeader);
    await waitForRepoOrder(client, [SECOND_REPO_NAME, FIRST_REPO_NAME]);
    await pauseForSlowMode("repos reordered");

    const names = await visibleRepoNames(client);
    expect(names.slice(0, 2)).toEqual([SECOND_REPO_NAME, FIRST_REPO_NAME]);

    const rows = await repoRows(client);
    expect(rows.map((row) => row.id)).toEqual([secondRepoId, firstRepoId]);
    expect(rows.map((row) => row.sort_order)).toEqual([0, 1]);
  });
});
