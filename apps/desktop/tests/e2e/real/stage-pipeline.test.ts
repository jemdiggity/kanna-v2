import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { advanceStageWithShortcut } from "../helpers/stageAdvance";
import { WebDriverClient } from "../helpers/webdriver";
import { waitForFile } from "../helpers/worktreeFs";

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
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

async function waitForStageCount(
  client: WebDriverClient,
  repoId: string,
  stage: string,
  expectedCount: number,
  timeoutMs: number,
  activeOnly = true,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      activeOnly
        ? "SELECT COUNT(*) AS count FROM pipeline_item WHERE repo_id = ? AND stage = ? AND closed_at IS NULL"
        : "SELECT COUNT(*) AS count FROM pipeline_item WHERE repo_id = ? AND stage = ?",
      [repoId, stage],
    )) as Array<{ count: number }>;
    if (rows[0]?.count === expectedCount) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${expectedCount} ${stage} task(s)`);
}

describe("real stage pipeline", () => {
  const client = new WebDriverClient();
  const taskId = "stage-pipeline-real-task";
  const branch = "task-stage-pipeline-real";
  let repoId = "";
  let testRepoPath = "";
  let worktreePath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    testRepoPath = await createFixtureRepo("stage-pipeline-real-test");
    worktreePath = join(testRepoPath, ".kanna-worktrees", branch);
    const kannaDir = join(testRepoPath, ".kanna");
    const pipelineName = "real-stage-e2e";
    await mkdir(join(kannaDir, "pipelines"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "commit-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "review-e2e"), { recursive: true });

    await writeFile(
      join(kannaDir, "pipelines", `${pipelineName}.json`),
      JSON.stringify({
        name: pipelineName,
        stages: [
          { name: "in progress", transition: "manual" },
          {
            name: "commit",
            transition: "auto",
            mode: "continue",
            agent: "commit-e2e",
            prompt: "Commit marker for $TASK_PROMPT",
          },
          {
            name: "review",
            transition: "auto",
            mode: "continue",
            agent: "review-e2e",
            prompt: "Review previous result: $PREV_RESULT",
          },
          {
            name: "pr",
            transition: "manual",
            follow_task: false,
          },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "agents", "commit-e2e", "AGENT.md"),
      [
        "---",
        "name: commit-e2e",
        "description: Real E2E commit stage.",
        "---",
        "Commit stage prompt marker.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(kannaDir, "agents", "review-e2e", "AGENT.md"),
      [
        "---",
        "name: review-e2e",
        "description: Real E2E review stage.",
        "---",
        "Review stage prompt marker.",
        "",
      ].join("\n"),
    );

    const importResult = await callVueMethod(client, "store.importRepo", testRepoPath, "stage-pipeline-real-test", "main");
    if (isVueCallError(importResult)) throw new Error(importResult.__error);
    if (typeof importResult !== "string") throw new Error(`unexpected import result: ${JSON.stringify(importResult)}`);
    repoId = importResult;
  });

  afterAll(async () => {
    await tauriInvoke(client, "kill_session", { sessionId: taskId }).catch(() => undefined);
    if (repoId) {
      const rows = (await queryDb(
        client,
        "SELECT id FROM pipeline_item WHERE repo_id = ?",
        [repoId],
      ).catch(() => [])) as Array<{ id: string }>;
      await Promise.all(rows.map((row) => tauriInvoke(client, "kill_session", { sessionId: row.id }).catch(() => undefined)));
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("continues in-place through commit and review and creates one PR task", async () => {
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        taskId,
        repoId,
        "exercise the real stage pipeline",
        "real-stage-e2e",
        "in progress",
        null,
        "[]",
        branch,
        "pty",
        "codex",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, taskId);
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch,
      path: worktreePath,
      startPoint: "main",
    });
    await writeFile(join(worktreePath, "e2e-pipeline-marker.txt"), "implemented\n");
    await writeFile(
      join(worktreePath, ".kanna-stage-driver.sh"),
      [
        "#!/bin/sh",
        "set -eu",
        "IFS= read -r commit_prompt",
        "printf '%s\\n' \"$commit_prompt\" > .kanna-commit-prompt.txt",
        "git add e2e-pipeline-marker.txt",
        "git commit -m 'test: commit e2e pipeline marker'",
        "kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status success --summary 'committed e2e pipeline marker'",
        "IFS= read -r review_prompt",
        "printf '%s\\n' \"$review_prompt\" > .kanna-review-prompt.txt",
        "kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status success --summary 'reviewed e2e pipeline marker'",
        "sleep 30",
        "",
      ].join("\n"),
    );

    const appDataDir = await tauriInvoke(client, "get_app_data_dir") as string;
    const dbName = await tauriInvoke(client, "read_env_var", { name: "KANNA_DB_NAME" }) as string;
    const socketPath = await tauriInvoke(client, "get_pipeline_socket_path") as string;
    const kannaCliPath = await tauriInvoke(client, "which_binary", { name: "kanna-cli" }) as string;
    await tauriInvoke(client, "spawn_session", {
      sessionId: taskId,
      cwd: worktreePath,
      executable: "/bin/sh",
      args: [".kanna-stage-driver.sh"],
      env: {
        KANNA_TASK_ID: taskId,
        KANNA_CLI_DB_PATH: `${appDataDir}/${dbName}`,
        KANNA_SOCKET_PATH: socketPath,
        PATH: `${kannaCliPath.slice(0, kannaCliPath.lastIndexOf("/"))}:${process.env.PATH ?? ""}`,
      },
      cols: 80,
      rows: 24,
      agentProvider: "codex",
    });

    await advanceStageWithShortcut(client, "exercise the real stage pipeline", taskId);

    await waitForStageCount(client, repoId, "review", 1, 30_000, false);
    await advanceStageWithShortcut(client, "exercise the real stage pipeline", taskId);
    await waitForStageCount(client, repoId, "pr", 1, 60_000);
    await waitForFile(join(worktreePath, ".kanna-commit-prompt.txt"), 5_000, 100);
    await waitForFile(join(worktreePath, ".kanna-review-prompt.txt"), 5_000, 100);

    expect(await readFile(join(worktreePath, ".kanna-commit-prompt.txt"), "utf8")).toContain("Commit stage prompt marker.");
  }, 90_000);
});
