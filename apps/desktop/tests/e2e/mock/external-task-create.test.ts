import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { startTestKannaServer } from "../helpers/kannaServer";
import { execDb, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args]);
  return stdout.trim();
}

async function hydrateStoreItem(client: WebDriverClient, taskId: string): Promise<void> {
  const rows = (await queryDb(
    client,
    "SELECT * FROM pipeline_item WHERE id = ?",
    [taskId],
  )) as Array<Record<string, unknown>>;
  const item = rows[0];
  if (!item) {
    throw new Error(`seeded task ${taskId} was not found`);
  }

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
  if (result !== "ok") {
    throw new Error(`failed to hydrate store item: ${result}`);
  }
}

async function waitForStoreTask(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await getVueState(client, "items") as Array<{ id?: string }> | null;
    if (items?.some((item) => item.id === taskId)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for task ${taskId} in Vue store`);
}

async function waitForSelectedTask(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await getVueState(client, "selectedItemId") === taskId) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for selected task ${taskId}`);
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await stat(path).then((stats) => stats.isFile()).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("external task creation", () => {
  const client = new WebDriverClient();
  let repoId = "";
  let fixtureRepoRoot = "";
  let testRepoPath = "";
  let externalTaskId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("external-task-create-test");
    testRepoPath = fixtureRepoRoot;

    const kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "pipelines"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "external-create-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "fake-bin"), { recursive: true });
    await writeFile(
      join(kannaDir, "config.json"),
      JSON.stringify({
        workspace: {
          path: {
            prepend: [".kanna/fake-bin"],
          },
        },
      }),
    );
    await writeFile(
      join(kannaDir, "pipelines", "external-create-e2e.json"),
      JSON.stringify({
        name: "external-create-e2e",
        stages: [
          {
            name: "in progress",
            transition: "manual",
            agent: "external-create-e2e",
            agent_provider: "codex",
          },
          { name: "pr", transition: "manual" },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "agents", "external-create-e2e", "AGENT.md"),
      [
        "---",
        "name: External Create E2E",
        "description: Fake agent for external task creation tests.",
        "agent_provider: codex",
        "---",
        "External task prompt:",
        "$TASK_PROMPT",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(kannaDir, "fake-bin", "codex"),
      [
        "#!/bin/sh",
        "mkdir -p .kanna",
        "printf '%s\\n' \"$@\" > .kanna/external-create-codex-args.txt",
        "printf 'fake external codex complete\\n'",
        "",
      ].join("\n"),
    );
    await chmod(join(kannaDir, "fake-bin", "codex"), 0o755);
    await git(testRepoPath, ["add", ".kanna"]);
    await git(testRepoPath, ["commit", "-m", "test: add external create fixtures"]);
    await git(testRepoPath, ["push", "origin", "main"]);

    repoId = await importTestRepo(client, testRepoPath, "external-task-create-test");
  });

  afterAll(async () => {
    if (externalTaskId) {
      await tauriInvoke(client, "kill_session", { sessionId: externalTaskId }).catch(() => undefined);
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("refreshes a task created through POST /v1/tasks without moving the visible task", async () => {
    const visibleTaskId = "external-create-visible-task";
    const visiblePrompt = "Keep this task visible";
    const externalPrompt = "External server task";

    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-10 seconds'), datetime('now', '-10 seconds'))`,
      [
        visibleTaskId,
        repoId,
        visiblePrompt,
        "external-create-e2e",
        "in progress",
        null,
        "[]",
        null,
        "agent",
        "codex",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, visibleTaskId);
    await client.waitForText(".sidebar", visiblePrompt);
    await client.waitForText(".task-header", visiblePrompt);

    // This mirrors the startup/default-focus state covered by init.test.ts:
    // a task is visibly focused via currentItem before selectedItemId exists.
    expect(await getVueState(client, "selectedItemId")).toBeNull();

    const server = await startTestKannaServer(client, join(testRepoPath, ".kanna"));
    try {
      const response = await fetch(`${server.baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoId,
          prompt: externalPrompt,
          pipelineName: "external-create-e2e",
          agentProvider: "codex",
          permissionMode: "dontAsk",
        }),
      });
      if (!response.ok) {
        throw new Error(`create task failed: ${response.status} ${await response.text()}`);
      }

      const body = await response.json() as { taskId: string; repoId: string; title: string; stage: string };
      externalTaskId = body.taskId;
      expect(body).toMatchObject({
        repoId,
        title: externalPrompt,
        stage: "in progress",
      });

      await waitForStoreTask(client, externalTaskId);
      await client.waitForText(".sidebar", externalPrompt);
      await waitForSelectedTask(client, visibleTaskId);
      await client.waitForText(".task-header", visiblePrompt);
      await sleep(500);

      expect(await getVueState(client, "selectedItemId")).toBe(visibleTaskId);
      const headerText = await client.executeSync<string>(
        `return document.querySelector(".task-header")?.textContent || "";`,
      );
      expect(headerText).toContain(visiblePrompt);
      expect(headerText).not.toContain(externalPrompt);

      const rows = (await queryDb(
        client,
        "SELECT branch FROM pipeline_item WHERE id = ?",
        [externalTaskId],
      )) as Array<{ branch: string | null }>;
      const branch = rows[0]?.branch;
      expect(branch).toMatch(/^task-/);

      const capturedArgsPath = join(
        testRepoPath,
        ".kanna-worktrees",
        branch ?? "",
        ".kanna",
        "external-create-codex-args.txt",
      );
      await waitForFile(capturedArgsPath, 20_000);
      expect(await readFile(capturedArgsPath, "utf8")).toContain(externalPrompt);
    } finally {
      server.child.kill();
    }
  });
});
