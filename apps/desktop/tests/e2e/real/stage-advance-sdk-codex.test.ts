import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo, publishFixtureChanges } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { advanceStageWithShortcut } from "../helpers/stageAdvance";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";
import { waitForFile, waitForNewTaskWorktree } from "../helpers/worktreeFs";

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
}

async function readTaskWorktreeNames(repoPath: string): Promise<string[]> {
  return readdir(join(repoPath, ".kanna-worktrees"), { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("task-"))
        .map((entry) => entry.name),
    )
    .catch(() => []);
}

async function waitForTaskStage(
  client: WebDriverClient,
  taskId: string,
  expectedStage: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: { stage: string | null; closed_at: string | null } | undefined;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT stage, closed_at FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as Array<{ stage: string | null; closed_at: string | null }>;
    last = rows[0];
    if (last?.stage === expectedStage && last.closed_at === null) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${taskId} to reach ${expectedStage}; last: ${JSON.stringify(last)}`);
}

// Codex account/quota state makes this an explicit operator lane. The default
// real runner uses OpenCode's free model and must never launch this test.
describe.skipIf(process.env.KANNA_E2E_REAL_AGENT_PROVIDER !== "codex")("real Codex SDK stage advance", () => {
  const client = new WebDriverClient();
  const workflowName = "codex-sdk-stage-advance";
  let repoId = "";
  let sourceTaskId = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();

    testRepoPath = await createFixtureRepo("codex-sdk-stage-advance-real-test");
    const kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "workflows"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "qa-codex-sdk"), { recursive: true });
    await writeFile(
      join(kannaDir, "workflows", `${workflowName}.json`),
      JSON.stringify({
        name: workflowName,
        stages: [
          { name: "in progress", policy: { transition: "manual" } },
          {
            name: "qa",
            agent: "qa-codex-sdk",
            prompt: "Create a file named codex-sdk-stage-advance-output.txt in the current directory containing exactly: sdk stage advanced. Do not ask questions. Stop after writing the file.",
            policy: { transition: "manual" },
          },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "agents", "qa-codex-sdk", "AGENT.md"),
      [
        "---",
        "name: qa-codex-sdk",
        "description: Real Codex SDK next-stage agent.",
        "agent_provider: codex",
        "---",
        "Follow the stage instruction exactly. Do not ask questions.",
        "",
      ].join("\n"),
    );
    await publishFixtureChanges(testRepoPath, "test: add Codex SDK stage workflow");

    repoId = await importTestRepo(client, testRepoPath, "codex-sdk-stage-advance-real-test");
  });

  afterAll(async () => {
    if (sourceTaskId) {
      await tauriInvoke(client, "kill_session", { sessionId: sourceTaskId }).catch(() => undefined);
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("advances a Codex SDK task to the qa stage in place", async () => {
    const sourcePrompt = [
      "Create a file named codex-sdk-source-ready.txt in the current directory containing exactly: source ready.",
      "Do not ask questions. Stop after writing the file.",
    ].join(" ");
    const sourceBaseline = new Set(await readTaskWorktreeNames(testRepoPath));
    const createResult = await callVueMethod(
      client,
      "store.createItem",
      repoId,
      testRepoPath,
      sourcePrompt,
      "agent",
      {
        agentProvider: "codex",
        workflowName,
        selectOnCreate: true,
      },
    );
    if (isVueCallError(createResult)) throw new Error(createResult.__error);
    if (typeof createResult !== "string") throw new Error(`unexpected createItem result: ${JSON.stringify(createResult)}`);
    sourceTaskId = createResult;

    const sourceWorktreePath = await waitForNewTaskWorktree(testRepoPath, sourceBaseline, 60_000);
    await waitForFile(join(sourceWorktreePath, "codex-sdk-source-ready.txt"), 180_000, 1_000);
    expect((await readFile(join(sourceWorktreePath, "codex-sdk-source-ready.txt"), "utf8")).trimEnd()).toBe("source ready");

    // Durable model: a manual advance accepts the current stage's work and
    // spawns the next stage's agent session on the SAME task, in a freshly
    // forked branch + worktree cut from the committed tip.
    const worktreesBeforeAdvance = new Set(await readTaskWorktreeNames(testRepoPath));
    await advanceStageWithShortcut(client, "codex-sdk-source-ready.txt", sourceTaskId);

    await waitForTaskStage(client, sourceTaskId, "qa");
    const rows = (await queryDb(
      client,
      "SELECT agent_type, agent_provider FROM pipeline_item WHERE id = ?",
      [sourceTaskId],
    )) as Array<{ agent_type: string | null; agent_provider: string | null }>;
    expect(rows[0]).toMatchObject({
      agent_type: "agent",
      agent_provider: "codex",
    });

    // The qa agent runs inside the forked worktree; the source worktree
    // (and its uncommitted output) stays behind untouched. No next-stage
    // TASK is created — only a workspace.
    const qaWorktreePath = await waitForNewTaskWorktree(testRepoPath, worktreesBeforeAdvance, 60_000);
    expect(qaWorktreePath).not.toBe(sourceWorktreePath);
    const qaMarkerPath = join(qaWorktreePath, "codex-sdk-stage-advance-output.txt");
    await waitForFile(qaMarkerPath, 180_000, 1_000);
    expect((await readFile(qaMarkerPath, "utf8")).trimEnd()).toBe("sdk stage advanced");

    const runs = (await queryDb(
      client,
      "SELECT stage FROM stage_run WHERE task_id = ? AND stage = 'qa'",
      [sourceTaskId],
    )) as Array<{ stage: string | null }>;
    expect(runs.length).toBeGreaterThanOrEqual(1);
  }, 360_000);
});
