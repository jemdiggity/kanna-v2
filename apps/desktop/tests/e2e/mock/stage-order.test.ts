import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { callVueMethod, execDb } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";

interface PositionedText {
  text: string;
  top: number;
}

async function visibleStageLabels(client: WebDriverClient, repoId: string): Promise<string[]> {
  return await client.executeSync<string[]>(
    `return Array.from(document.querySelectorAll(${JSON.stringify(`.repo-section[data-repo-id="${repoId}"] .section-label`)}))
      .map((el) => el.textContent?.trim() || "")
      .filter(Boolean);`,
  );
}

async function visibleTaskPositions(client: WebDriverClient, repoId: string): Promise<PositionedText[]> {
  return await client.executeSync<PositionedText[]>(
    `return Array.from(document.querySelectorAll(${JSON.stringify(`.repo-section[data-repo-id="${repoId}"] .workflow-item .item-title`)}))
      .map((el) => ({ text: el.textContent?.trim() || "", top: el.getBoundingClientRect().top }))
      .filter((entry) => entry.text.length > 0);`,
  );
}

async function waitForStageLabels(
  client: WebDriverClient,
  repoId: string,
  expectedLabels: string[],
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const labels = await visibleStageLabels(client, repoId);
    if (expectedLabels.every((label, index) => labels[index] === label)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for stage labels: ${expectedLabels.join(", ")}`);
}

describe("stage order", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let repoId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("stage-order-test");
    repoId = await importTestRepo(client, fixtureRepoRoot, "stage-order-test");
  });

  afterAll(async () => {
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("uses the built-in stage order when the repo config has no stage_order", async () => {
    await execDb(
      client,
      `INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "stage-order-progress-task",
        repoId,
        "In progress marker",
        "in progress",
        "idle",
        "agent",
        "2026-04-29T00:03:00.000Z",
        "2026-04-29T00:03:00.000Z",
      ],
    );
    await execDb(
      client,
      `INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "stage-order-review-task",
        repoId,
        "Review marker",
        "review",
        "idle",
        "agent",
        "2026-04-29T00:01:00.000Z",
        "2026-04-29T00:01:00.000Z",
      ],
    );

    await callVueMethod(client, "loadItems");
    await client.waitForText(".sidebar", "In progress marker", 5000);
    await waitForStageLabels(client, repoId, ["review", "in progress"]);

    const taskPositions = await visibleTaskPositions(client, repoId);
    const reviewTop = taskPositions.find((entry) => entry.text === "Review marker")?.top;
    const progressTop = taskPositions.find((entry) => entry.text === "In progress marker")?.top;

    expect(reviewTop).toBeDefined();
    expect(progressTop).toBeDefined();
    expect(reviewTop).toBeLessThan(progressTop ?? Number.POSITIVE_INFINITY);
  });
});
