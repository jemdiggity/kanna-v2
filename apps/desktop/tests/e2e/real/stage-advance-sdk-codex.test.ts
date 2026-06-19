import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { advanceStageWithShortcut } from "../helpers/stageAdvance";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
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

async function hydrateStoreItem(client: WebDriverClient, taskId: string): Promise<void> {
  const rows = (await queryDb(
    client,
    "SELECT * FROM pipeline_item WHERE id = ?",
    [taskId],
  )) as Array<Record<string, unknown>>;
  const item = rows[0];
  if (!item) throw new Error(`task ${taskId} was not found`);

  const result = await client.executeSync<string>(
    `const item = ${JSON.stringify(item)};
     const ctx = window.__KANNA_E2E__.setupState;
     const items = ctx.store?.items?.value ?? ctx.store?.items;
     if (!Array.isArray(items)) return "items-unavailable";
     const index = items.findIndex((candidate) => candidate.id === item.id);
     if (index >= 0) items.splice(index, 1, item);
     else items.push(item);
     return "ok";`,
  );
  if (result !== "ok") throw new Error(`failed to hydrate store item: ${result}`);
}

async function waitForCreatedStageTask(
  client: WebDriverClient,
  repoId: string,
  stage: string,
  excludedIds: Set<string>,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT id FROM pipeline_item WHERE repo_id = ? AND stage = ? AND closed_at IS NULL ORDER BY created_at DESC",
      [repoId, stage],
    )) as Array<{ id: string | null }>;
    const row = rows.find((candidate) => candidate.id && !excludedIds.has(candidate.id));
    if (row?.id) return row.id;
    await sleep(250);
  }
  throw new Error(`timed out waiting for created ${stage} task`);
}

async function getStageTaskIds(client: WebDriverClient, repoId: string, stage: string): Promise<Set<string>> {
  const rows = (await queryDb(
    client,
    "SELECT id FROM pipeline_item WHERE repo_id = ? AND stage = ? AND closed_at IS NULL",
    [repoId, stage],
  )) as Array<{ id: string | null }>;
  return new Set(rows.flatMap((row) => (row.id ? [row.id] : [])));
}

async function waitForAgentTerminalSession(client: WebDriverClient, taskId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT daemon_session_id, label FROM terminal_session WHERE pipeline_item_id = ?",
      [taskId],
    )) as Array<{ daemon_session_id: string | null; label: string | null }>;
    if (rows.some((row) => row.daemon_session_id === taskId && row.label === "agent")) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for agent terminal session for ${taskId}`);
}

describe("real Codex SDK stage advance", () => {
  const client = new WebDriverClient();
  const pipelineName = "codex-sdk-stage-advance";
  let repoId = "";
  let sourceTaskId = "";
  let nextTaskId = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    testRepoPath = await createFixtureRepo("codex-sdk-stage-advance-real-test");
    const kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "pipelines"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "qa-codex-sdk"), { recursive: true });
    await writeFile(
      join(kannaDir, "pipelines", `${pipelineName}.json`),
      JSON.stringify({
        name: pipelineName,
        stages: [
          { name: "in progress", transition: "manual" },
          {
            name: "qa",
            transition: "manual",
            agent: "qa-codex-sdk",
            prompt: "Create a file named codex-sdk-stage-advance-output.txt in the current directory containing exactly: sdk stage advanced. Do not ask questions. Stop after writing the file.",
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

    repoId = await importTestRepo(client, testRepoPath, "codex-sdk-stage-advance-real-test");
  });

  afterAll(async () => {
    await Promise.all(
      [sourceTaskId, nextTaskId]
        .filter((taskId) => taskId.length > 0)
        .map((taskId) => tauriInvoke(client, "kill_session", { sessionId: taskId }).catch(() => undefined)),
    );
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("advances a Codex SDK task into a new Codex SDK agent task", async () => {
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
        pipelineName,
        selectOnCreate: true,
      },
    );
    if (isVueCallError(createResult)) throw new Error(createResult.__error);
    if (typeof createResult !== "string") throw new Error(`unexpected createItem result: ${JSON.stringify(createResult)}`);
    sourceTaskId = createResult;

    const sourceWorktreePath = await waitForNewTaskWorktree(testRepoPath, sourceBaseline, 60_000);
    await waitForFile(join(sourceWorktreePath, "codex-sdk-source-ready.txt"), 180_000, 1_000);
    expect((await readFile(join(sourceWorktreePath, "codex-sdk-source-ready.txt"), "utf8")).trimEnd()).toBe("source ready");

    await execDb(
      client,
      "UPDATE pipeline_item SET stage_result = ?, activity = 'idle', updated_at = datetime('now') WHERE id = ?",
      [JSON.stringify({ status: "success", summary: "source stage complete" }), sourceTaskId],
    );
    await hydrateStoreItem(client, sourceTaskId);

    const existingQaTaskIds = await getStageTaskIds(client, repoId, "qa");
    const nextBaseline = new Set(await readTaskWorktreeNames(testRepoPath));
    await advanceStageWithShortcut(client, "codex-sdk-source-ready.txt", sourceTaskId);

    nextTaskId = await waitForCreatedStageTask(client, repoId, "qa", existingQaTaskIds);
    const nextRows = (await queryDb(
      client,
      "SELECT agent_type, agent_provider FROM pipeline_item WHERE id = ?",
      [nextTaskId],
    )) as Array<{ agent_type: string | null; agent_provider: string | null }>;
    expect(nextRows[0]).toMatchObject({
      agent_type: "agent",
      agent_provider: "codex",
    });
    await waitForAgentTerminalSession(client, nextTaskId);

    const nextWorktreePath = await waitForNewTaskWorktree(testRepoPath, nextBaseline, 60_000);
    const nextMarkerPath = join(nextWorktreePath, "codex-sdk-stage-advance-output.txt");
    await waitForFile(nextMarkerPath, 180_000, 1_000);
    expect((await readFile(nextMarkerPath, "utf8")).trimEnd()).toBe("sdk stage advanced");
  }, 360_000);
});
