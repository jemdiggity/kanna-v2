import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { execDb, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { buildGlobalKeydownScript } from "../helpers/keyboard";

async function waitForPipelineItem<T>(
  client: WebDriverClient,
  sql: string,
  params: unknown[],
  predicate: (row: T | undefined) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastRow: T | undefined;

  while (Date.now() < deadline) {
    const rows = (await queryDb(client, sql, params)) as T[];
    lastRow = rows[0];
    if (predicate(lastRow)) return lastRow;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for pipeline item state; last row was ${JSON.stringify(lastRow)}`);
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // The webview can be between documents during a reload.
    }
    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

async function seedPtyTask(
  client: WebDriverClient,
  task: {
    id: string;
    repoId: string;
    prompt: string;
    stage: string;
    branch: string;
    closedAt: string | null;
    createdAt: string;
  },
): Promise<void> {
  await execDb(
    client,
    `INSERT INTO pipeline_item (
       id, repo_id, prompt, pipeline, stage, tags, branch,
       agent_type, agent_provider, activity, closed_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'default', ?, '[]', ?, 'pty', 'claude', 'idle', ?, ?, ?)`,
    [
      task.id,
      task.repoId,
      task.prompt,
      task.stage,
      task.branch,
      task.closedAt,
      task.createdAt,
      task.createdAt,
    ],
  );
}

async function persistWindowSelection(
  client: WebDriverClient,
  selection: {
    repoId: string;
    itemId: string;
  },
): Promise<void> {
  const result = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     Promise.resolve(ctx.windowWorkspace.persistSelection({
       selectedRepoId: ${JSON.stringify(selection.repoId)},
       selectedItemId: ${JSON.stringify(selection.itemId)},
     }))
       .then(() => cb("ok"))
       .catch((error) => cb("__error:" + (error?.message || String(error))));`,
  );
  expect(result).toBe("ok");
}

async function getAppInvokeMetrics(client: WebDriverClient): Promise<{
  invokeCounts: Record<string, number>;
  invokeCalls?: Array<{ command: string; args: unknown }>;
}> {
  return client.executeSync(
    `return window.__KANNA_E2E__.appMetrics.snapshot();`,
  );
}

describe("task lifecycle", () => {
  const client = new WebDriverClient();
  let repoId = "";
  let fixtureRepoRoot = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("lifecycle-test");
    testRepoPath = fixtureRepoRoot;
    repoId = await importTestRepo(client, testRepoPath, "lifecycle-test");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("creates a task that appears in sidebar", async () => {
    // Internal setup only: lifecycle assertions need deterministic SDK-mode
    // tasks so closing behavior can be tested without launching a real agent.
    const result = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       try {
         const ctx = window.__KANNA_E2E__.setupState;
         ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(testRepoPath)}, "Say OK", "sdk")
           .then(function() { cb("ok"); })
           .catch(function(e) { cb("err:" + e); });
       } catch(e) { cb("outer:" + e); }`
    );
    expect(result).toBe("ok");

    const el = await client.waitForText(".sidebar", "Say OK");
    expect(el).toBeTruthy();
  });

  it("shows task header with prompt text", async () => {
    const el = await client.waitForText(".task-header", "Say OK");
    expect(el).toBeTruthy();
  });

  it("creates the task worktree", async () => {
    const rows = (await queryDb(
      client,
      "SELECT branch FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Say OK"],
    )) as Array<{ branch: string | null }>;
    const branch = rows[0]?.branch ?? null;
    expect(branch).toBeTruthy();
    if (!branch) {
      throw new Error("expected the created task to have a branch");
    }

    const exists = await tauriInvoke(client, "file_exists", {
      path: `${testRepoPath}/.kanna-worktrees/${branch}`,
    });
    expect(exists).toBe(true);
  });

  it("closes into teardown and stays visible when teardown commands exist", async () => {
    const rows = (await queryDb(
      client,
      "SELECT branch FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Say OK"],
    )) as Array<{ branch: string }>;
    const branch = rows[0]?.branch;
    expect(branch).toBeTruthy();
    if (!branch) {
      throw new Error("expected the created task to have a branch");
    }

    await tauriInvoke(client, "write_text_file", {
      path: `${testRepoPath}/.kanna-worktrees/${branch}/.kanna/config.json`,
      content: JSON.stringify({
        setup: [],
        teardown: ["printf 'teardown\\n' && sleep 2"],
      }),
    });

    await client.executeSync(buildGlobalKeydownScript({
      key: "Delete",
      meta: true,
      shift: true,
    }));

    const stageRow = await waitForPipelineItem<{ stage: string; teardown_started_at: string | null }>(
      client,
      "SELECT stage, teardown_started_at FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Say OK"],
      (row) => row?.stage === "in progress" && Boolean(row.teardown_started_at),
    );
    expect(stageRow.stage).toBe("in progress");
    expect(stageRow.teardown_started_at).toBeTruthy();

    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`
    );
    expect(sidebarText).toContain("Say OK");
    expect(sidebarText).not.toContain("teardown");

    const titleStyle = await client.executeSync<string>(
      `const titles = Array.from(document.querySelectorAll(".pipeline-item .item-title"));
       const title = titles.find((el) => (el.textContent || "").includes("Say OK"));
       return title ? window.getComputedStyle(title).textDecorationLine : "";`
    );
    expect(titleStyle).toContain("line-through");
  });

  it("closes directly to done and disappears when teardown commands do not exist", async () => {
    // Internal setup only: this creates a second inert task to isolate close
    // behavior from terminal and agent process startup.
    const createResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(testRepoPath)}, "Close Fast", "sdk")
         .then(() => cb("ok"))
         .catch((error) => cb("err:" + error));`
    );
    expect(createResult).toBe("ok");

    const header = await client.waitForText(".task-header", "Close Fast");
    expect(header).toBeTruthy();

    const rows = (await queryDb(
      client,
      "SELECT id, branch FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Close Fast"],
    )) as Array<{ id: string; branch: string }>;
    const branch = rows[0]?.branch;
    expect(branch).toBeTruthy();
    if (!branch) {
      throw new Error("expected the close-fast task to have a branch");
    }

    await tauriInvoke(client, "write_text_file", {
      path: `${testRepoPath}/.kanna-worktrees/${branch}/.kanna/config.json`,
      content: JSON.stringify({ setup: [] }),
    });

    await client.executeSync(buildGlobalKeydownScript({
      key: "Delete",
      meta: true,
      shift: true,
    }));

    const stageRow = await waitForPipelineItem<{ stage: string }>(
      client,
      "SELECT stage FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Close Fast"],
      (row) => row?.stage === "done",
    );
    expect(stageRow.stage).toBe("done");

    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`
    );
    expect(sidebarText).not.toContain("Close Fast");
  });

  it("keeps a closed active-stage task out of sidebar selection and terminal startup after reload", async () => {
    const openTaskId = "task-open-active-e2e";
    const closedTaskId = "task-e24fce1c";
    const openBranch = "task-open-active-e2e";
    const closedBranch = "task-e24fce1c";

    await seedPtyTask(client, {
      id: openTaskId,
      repoId,
      prompt: "Visible open task after reload",
      stage: "in progress",
      branch: openBranch,
      closedAt: null,
      createdAt: "2099-06-03T01:00:00.000Z",
    });
    await seedPtyTask(client, {
      id: closedTaskId,
      repoId,
      prompt: "Closed active-stage task should stay hidden",
      stage: "pr",
      branch: closedBranch,
      closedAt: "2026-06-03T01:05:00.000Z",
      createdAt: "2099-06-03T02:00:00.000Z",
    });
    await tauriInvoke(client, "ensure_directory", {
      path: `${testRepoPath}/.kanna-worktrees/${openBranch}`,
    });
    await execDb(
      client,
      `INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id, created_at)
       VALUES (?, ?, ?, 'claude', ?, NULL, ?)`,
      [
        `ts-${closedTaskId}`,
        repoId,
        closedTaskId,
        `${testRepoPath}/.kanna-worktrees/${closedBranch}`,
        "2026-06-03T02:00:00.000Z",
      ],
    );
    await persistWindowSelection(client, { repoId, itemId: closedTaskId });
    await client.executeSync("window.__KANNA_E2E__.appMetrics.clear(); location.reload();");
    await client.waitForAppReady();

    await waitForCondition(async () => {
      const selectedItemId = await getVueState(client, "selectedItemId");
      const currentItem = await getVueState(client, "currentItem") as { id?: string | null } | null;
      return selectedItemId !== closedTaskId && currentItem?.id === openTaskId;
    }, "closed task to be excluded from selection and current item after reload", 10_000);

    const state = await client.executeSync<{
      selectedItemId: string | null;
      currentItemId: string | null;
      currentItemPrompt: string | null;
      itemIds: string[];
    }>(
      `const ctx = window.__KANNA_E2E__.setupState;
       const read = (value) => value && value.__v_isRef ? value.value : value;
       const currentItem = read(ctx.store.currentItem);
       return {
         selectedItemId: read(ctx.store.selectedItemId),
         currentItemId: currentItem?.id ?? null,
         currentItemPrompt: currentItem?.prompt ?? null,
         itemIds: read(ctx.store.items).map((item) => item.id),
       };`,
    );
    expect(state).toMatchObject({
      currentItemId: openTaskId,
      currentItemPrompt: "Visible open task after reload",
      itemIds: expect.arrayContaining([openTaskId]),
    });
    expect(state.selectedItemId).not.toBe(closedTaskId);
    expect(state.itemIds).not.toContain(closedTaskId);

    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    expect(sidebarText).toContain("Visible open task after reload");
    expect(sidebarText).not.toContain("Closed active-stage task should stay hidden");

    await client.waitForElement(".main-panel .terminal-container", 10_000);
    await waitForCondition(async () => {
      const text = await client.executeSync<string>(
        `return document.querySelector(".main-panel")?.textContent || "";`,
      );
      return text.includes(openTaskId);
    }, "open task terminal output", 10_000);

    const mainPanelText = await client.executeSync<string>(
      `return document.querySelector(".main-panel")?.textContent || "";`,
    );
    expect(mainPanelText).toContain(openTaskId);
    expect(mainPanelText).not.toContain(closedTaskId);

    const metrics = await getAppInvokeMetrics(client);
    expect(metrics.invokeCounts.attach_session_with_snapshot ?? 0).toBeGreaterThanOrEqual(1);
    expect(metrics.invokeCounts.spawn_session ?? 0).toBeGreaterThanOrEqual(1);
    expect(metrics.invokeCalls).toBeDefined();

    const callsForClosedTask = (metrics.invokeCalls ?? []).filter((call) =>
      JSON.stringify(call).includes(closedTaskId)
      || JSON.stringify(call).includes(closedBranch)
    );
    expect(callsForClosedTask).toEqual([]);
  });
});
