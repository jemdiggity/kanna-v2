import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { importTestRepo, resetDatabase } from "../helpers/reset";
import { execDb, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";
import { localProcessFetch } from "@kanna/local-process-fetch";

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

async function focusStoreTask(client: WebDriverClient, repoId: string, taskId: string): Promise<void> {
  await client.executeSync(
    `const store = window.__KANNA_E2E__.setupState.store;
     const lastSelected = store.lastSelectedItemByRepo?.value ?? store.lastSelectedItemByRepo;
     const nextLastSelected = { ...(lastSelected ?? {}) };
     nextLastSelected[${JSON.stringify(repoId)}] = ${JSON.stringify(taskId)};
     if (typeof store.$patch === "function") {
       store.$patch({ selectedItemId: ${JSON.stringify(taskId)}, lastSelectedItemByRepo: nextLastSelected });
     } else {
       if (store.selectedItemId?.__v_isRef) store.selectedItemId.value = ${JSON.stringify(taskId)};
       else store.selectedItemId = ${JSON.stringify(taskId)};
       if (store.lastSelectedItemByRepo?.__v_isRef) store.lastSelectedItemByRepo.value = nextLastSelected;
       else store.lastSelectedItemByRepo = nextLastSelected;
     }
     return "ok";`,
  );
}

async function closeRepoTasksDirectly(client: WebDriverClient, repoId: string): Promise<void> {
  const rows = await queryDb(
    client,
    "SELECT id FROM pipeline_item WHERE repo_id = ? AND closed_at IS NULL",
    [repoId],
  ) as Array<{ id?: string | null }>;
  const taskIds = rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  await Promise.all(taskIds.flatMap((taskId) => [
    tauriInvoke(client, "kill_session", { sessionId: taskId }).catch(() => undefined),
    tauriInvoke(client, "kill_session", { sessionId: `shell-wt-${taskId}` }).catch(() => undefined),
  ]));

  await execDb(
    client,
    "UPDATE pipeline_item SET closed_at = COALESCE(closed_at, datetime('now')) WHERE repo_id = ?",
    [repoId],
  ).catch(() => undefined);
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

async function waitForSidebarTaskOrder(
  client: WebDriverClient,
  expectedTaskIds: string[],
  timeoutMs = 10_000,
): Promise<Array<{ id: string; text: string; subtask: boolean; paddingLeft: string }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await client.executeSync<Array<{ id: string; text: string; subtask: boolean; paddingLeft: string }>>(
      `return Array.from(document.querySelectorAll(".sidebar .workflow-item")).map((row) => ({
         id: row.getAttribute("data-task-id") || "",
         text: row.textContent || "",
         subtask: row.classList.contains("subtask"),
         paddingLeft: getComputedStyle(row).paddingLeft,
       }));`,
    );
    const ids = rows.map((row) => row.id);
    const startIndex = ids.indexOf(expectedTaskIds[0] ?? "");
    if (
      startIndex >= 0
      && expectedTaskIds.every((id, offset) => ids[startIndex + offset] === id)
    ) {
      return rows;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for sidebar task order: ${expectedTaskIds.join(", ")}`);
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

async function desktopServerBaseUrl(client: WebDriverClient): Promise<string> {
  await tauriInvoke(client, "ensure_mobile_server");
  const port = await tauriInvoke(client, "read_env_var", { name: "KANNA_MOBILE_SERVER_PORT" }) as string;
  return `http://127.0.0.1:${port?.trim() || "48120"}`;
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
    await mkdir(join(kannaDir, "workflows"), { recursive: true });
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
      join(kannaDir, "workflows", "external-create-e2e.json"),
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
    if (repoId) {
      await closeRepoTasksDirectly(client, repoId);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  }, 240_000);

  it("refreshes a task created through POST /v1/tasks without moving the visible task", async () => {
    const visibleTaskId = "external-create-visible-task";
    const visiblePrompt = "Keep this task visible";
    const externalPrompt = "External server task";

    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+10 seconds'), datetime('now', '+10 seconds'))`,
      [
        visibleTaskId,
        repoId,
        visiblePrompt,
        "external-create-e2e",
        "in progress",
        null,
        "agent",
        "codex",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, visibleTaskId);
    await focusStoreTask(client, repoId, visibleTaskId);
    await client.waitForText(".sidebar", visiblePrompt);
    await client.waitForText(".task-header", visiblePrompt);

    const baseUrl = await desktopServerBaseUrl(client);
    const response = await localProcessFetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoId,
          prompt: externalPrompt,
          workflowName: "external-create-e2e",
          agentType: "pty",
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

    expect(branch).toBeTruthy();
  });

  it("renders a POST-created child task nested directly beneath its parent", async () => {
    const parentTaskId = "external-create-parent-task";
    const parentPrompt = "Parent task visible for nesting";
    const childPrompt = "Child task from local API";

    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-20 seconds'), datetime('now', '-20 seconds'))`,
      [
        parentTaskId,
        repoId,
        parentPrompt,
        "external-create-e2e",
        "in progress",
        null,
        "agent",
        "codex",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, parentTaskId);
    await client.waitForText(".sidebar", parentPrompt);

    const baseUrl = await desktopServerBaseUrl(client);
    const response = await localProcessFetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoId,
          prompt: childPrompt,
          workflowName: "external-create-e2e",
          agentType: "pty",
          agentProvider: "codex",
          permissionMode: "dontAsk",
          parentTaskId,
        }),
      });
    if (!response.ok) {
      throw new Error(`create child task failed: ${response.status} ${await response.text()}`);
    }

    const body = await response.json() as { taskId: string; repoId: string; title: string; stage: string };
    externalTaskId = body.taskId;
    expect(body).toMatchObject({
      repoId,
      title: childPrompt,
      stage: "in progress",
    });

    await waitForStoreTask(client, externalTaskId);
    await client.waitForText(".sidebar", childPrompt);

    const rows = (await queryDb(
      client,
      "SELECT parent_task_id, stage FROM pipeline_item WHERE id = ?",
      [externalTaskId],
    )) as Array<{ parent_task_id: string | null; stage: string }>;
    expect(rows).toEqual([{ parent_task_id: parentTaskId, stage: "in progress" }]);

    const sidebarRows = await waitForSidebarTaskOrder(client, [parentTaskId, externalTaskId]);
    const parentIndex = sidebarRows.findIndex((row) => row.id === parentTaskId);
    const childRow = sidebarRows[parentIndex + 1];
    expect(sidebarRows[parentIndex]).toMatchObject({
      id: parentTaskId,
      subtask: false,
    });
    expect(childRow).toMatchObject({
      id: externalTaskId,
      subtask: true,
    });
    expect(childRow.paddingLeft).not.toBe(sidebarRows[parentIndex].paddingLeft);

    const sectionLabels = await client.executeSync<string[]>(
      `return Array.from(document.querySelectorAll(".sidebar .section-label")).map((label) => label.textContent || "");`,
    );
    expect(sectionLabels.filter((label) => label === "pr")).toHaveLength(0);
  });

  it("refreshes a server-side task rename through KSP StateChanged without daemon session events", async () => {
    const taskId = "external-rename-task";
    const originalPrompt = "Task visible before external rename";
    const renamedTitle = "Renamed through local API";

    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-30 seconds'), datetime('now', '-30 seconds'))`,
      [
        taskId,
        repoId,
        originalPrompt,
        "external-create-e2e",
        "in progress",
        null,
        "agent",
        "codex",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, taskId);
    await client.waitForText(".sidebar", originalPrompt);

    const baseUrl = await desktopServerBaseUrl(client);
    const response = await localProcessFetch(`${baseUrl}/v1/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: renamedTitle }),
    });
    if (!response.ok) {
      throw new Error(`rename task failed: ${response.status} ${await response.text()}`);
    }

    await client.waitForText(".sidebar", renamedTitle);
    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    expect(sidebarText).toContain(renamedTitle);
    expect(sidebarText).not.toContain(originalPrompt);
  });
});
