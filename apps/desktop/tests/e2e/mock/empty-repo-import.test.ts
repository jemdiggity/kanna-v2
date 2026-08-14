import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createEmptyFixtureRepo } from "../helpers/fixture-repo";
import { importTestRepo, resetDatabase } from "../helpers/reset";
import { queryDb } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

interface VisibleToast {
  type: string;
  message: string;
}

interface ImportedRepoRow {
  default_branch: string;
}

interface TaskCountRow {
  count: number;
}

const EMPTY_REPO_NAME = "empty-repo-first-import";
const EMPTY_REPO_GUIDANCE = "Create an initial commit, then run Set Up Repository.";

describe("first import of a zero-commit repository", () => {
  const client = new WebDriverClient();
  let repoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    repoPath = await createEmptyFixtureRepo(EMPTY_REPO_NAME, {
      initialBranch: "trunk",
    });
  });

  afterAll(async () => {
    if (repoPath) await cleanupFixtureRepos([repoPath]);
    await client.deleteSession();
  });

  it("imports successfully, preserves the unborn branch, and shows one guidance toast", async () => {
    const repoId = await importTestRepo(client, repoPath, EMPTY_REPO_NAME);
    await client.waitForText(".toast.warning", EMPTY_REPO_GUIDANCE, 5_000);

    const toasts = await client.executeSync<VisibleToast[]>(
      `return Array.from(document.querySelectorAll(".toast")).map((element) => ({
        type: ["info", "warning", "error"].find((type) => element.classList.contains(type)) || "",
        message: element.querySelector(".toast-message")?.textContent || "",
      }));`,
    );
    expect(toasts).toEqual([{ type: "warning", message: EMPTY_REPO_GUIDANCE }]);

    const repos = await queryDb(
      client,
      "SELECT default_branch FROM repo WHERE id = ?",
      [repoId],
    ) as ImportedRepoRow[];
    expect(repos).toEqual([{ default_branch: "trunk" }]);

    const taskCounts = await queryDb(
      client,
      "SELECT COUNT(*) AS count FROM pipeline_item WHERE repo_id = ?",
      [repoId],
    ) as TaskCountRow[];
    expect(taskCounts).toEqual([{ count: 0 }]);
  });
});
