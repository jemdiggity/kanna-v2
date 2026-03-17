import { resolve } from "path";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { getVueState, callVueMethod } from "../helpers/vue";

// Use the kanna-tauri repo itself as a test fixture
const TEST_REPO_PATH = resolve(import.meta.dir, "../../../..");

describe("import repo", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("imports a repo and shows it in the sidebar", async () => {
    await importTestRepo(client, TEST_REPO_PATH, "kanna-tauri");

    // Repo should appear in sidebar
    const el = await client.waitForText(".sidebar", "kanna-tauri");
    expect(el).toBeTruthy();
  });

  it("shows task count badge as 0", async () => {
    // The repo header shows the count
    const text = await client.executeSync<string>(
      `const headers = document.querySelectorAll(".repo-header");
       for (const h of headers) {
         if (h.textContent.includes("kanna-tauri")) return h.textContent;
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
    // Import with a different name (same path is fine for DB purposes)
    await callVueMethod(client, "handleImportRepo", TEST_REPO_PATH, "second-repo", "main");
    const text = await client.executeSync<string>(
      `return document.querySelector(".sidebar").textContent;`
    );
    expect(text).toContain("kanna-tauri");
    expect(text).toContain("second-repo");
  });

  it("can select between repos", async () => {
    const repos = (await getVueState(client, "repos")) as Array<{ id: string; name: string }>;
    expect(repos.length).toBe(2);

    await callVueMethod(client, "handleSelectRepo", repos[0].id);
    const sel1 = await getVueState(client, "selectedRepoId");
    expect(sel1).toBe(repos[0].id);

    await callVueMethod(client, "handleSelectRepo", repos[1].id);
    const sel2 = await getVueState(client, "selectedRepoId");
    expect(sel2).toBe(repos[1].id);
  });
});
