import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase } from "../helpers/reset";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo, publishFixtureChanges } from "../helpers/fixture-repo";
import { advanceStageWithShortcut } from "../helpers/stageAdvance";

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
}

describe("workflow title preservation", () => {
  const client = new WebDriverClient();
  let repoId = "";
  let fixtureRepoRoot = "";
  let testRepoPath = "";

  async function waitForCondition(
    predicate: () => Promise<boolean>,
    timeoutMs: number,
    message: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(message);
  }

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();
    fixtureRepoRoot = await createFixtureRepo("workflow-title-test");
    testRepoPath = join(fixtureRepoRoot, "apps");

    const workflowName = "title-e2e";
    // Definitions live in the `.kanna` subtree of the repository's origin
    // snapshot, which is rooted at the Git repository — never at an imported
    // subdirectory and never at the working tree.
    const kannaDir = join(fixtureRepoRoot, ".kanna");
    await mkdir(join(kannaDir, "workflows"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "qa-title-e2e"), { recursive: true });
    await writeFile(
      join(kannaDir, "workflows", `${workflowName}.json`),
      JSON.stringify({
        name: workflowName,
        stages: [
          { name: "in progress", transition: "manual" },
          {
            name: "qa",
            transition: "manual",
            agent: "qa-title-e2e",
            prompt: "Generated QA prompt marker for $TASK_PROMPT from $SOURCE_WORKTREE",
          },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "agents", "qa-title-e2e", "AGENT.md"),
      [
        "---",
        "name: QA Title E2E",
        "description: Verifies title preservation during stage advance.",
        "agent_provider: claude",
        "---",
        "QA agent generated prompt marker.",
        "",
      ].join("\n"),
    );

    await publishFixtureChanges(fixtureRepoRoot, "test: add workflow title fixtures");

    const importResult = await callVueMethod(client, "store.importRepo", testRepoPath, "workflow-title-test", "main");
    if (isVueCallError(importResult)) throw new Error(importResult.__error);
    if (typeof importResult !== "string") throw new Error(`unexpected import result: ${JSON.stringify(importResult)}`);
    repoId = importResult;
  });

  afterAll(async () => {
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("keeps the original title visible when advancing to a generated prompt stage", async () => {
    const workflowName = "title-e2e";
    const originalTitle = "Preserve workflow title";
    const generatedMarker = "Generated QA prompt marker";

    const createResult = await callVueMethod(
      client,
      "store.createItem",
      repoId,
      testRepoPath,
      originalTitle,
      "agent",
      { workflowName, agentProvider: "claude" },
    );
    if (isVueCallError(createResult)) throw new Error(createResult.__error);
    if (typeof createResult !== "string") throw new Error(`unexpected create result: ${JSON.stringify(createResult)}`);

    const sourceRows = (await queryDb(
      client,
      "SELECT id, branch FROM pipeline_item WHERE id = ?",
      [createResult],
    )) as Array<{ id: string; branch: string | null }>;
    const sourceTask = sourceRows[0];
    expect(sourceTask?.branch).toBeTruthy();
    if (!sourceTask?.branch) {
      throw new Error("expected source task to be created with a branch");
    }

    await waitForCondition(async () => {
      const exists = await tauriInvoke(client, "file_exists", {
        path: `${testRepoPath}/.kanna-worktrees/${sourceTask.branch}`,
      });
      return exists === true;
    }, 10_000, "source task worktree was not created");

    await advanceStageWithShortcut(client, originalTitle, sourceTask.id);

    // Durable model: the SAME task advances to the qa stage in place; the
    // generated stage prompt is delivered to the fresh agent session and
    // never overwrites the task's own prompt or title.
    await waitForCondition(async () => {
      const rows = (await queryDb(
        client,
        "SELECT stage FROM pipeline_item WHERE id = ? AND closed_at IS NULL",
        [sourceTask.id],
      )) as Array<{ stage: string | null }>;
      return rows[0]?.stage === "qa";
    }, 10_000, "task did not advance to the qa stage in place");

    const qaRows = (await queryDb(
      client,
      "SELECT prompt, display_name FROM pipeline_item WHERE id = ?",
      [sourceTask.id],
    )) as Array<{ prompt: string | null; display_name: string | null }>;
    expect(qaRows[0]?.prompt).toBe(originalTitle);
    expect(qaRows[0]?.prompt).not.toContain(generatedMarker);

    const qaRuns = (await queryDb(
      client,
      "SELECT id FROM stage_run WHERE task_id = ? AND stage = 'qa'",
      [sourceTask.id],
    )) as Array<{ id: string }>;
    expect(qaRuns.length).toBeGreaterThanOrEqual(1);

    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    expect(sidebarText).toContain(originalTitle);
    expect(sidebarText).not.toContain(generatedMarker);
  });
});
