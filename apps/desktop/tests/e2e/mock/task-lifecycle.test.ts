import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, execDb, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
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
       id, repo_id, prompt, pipeline, stage, branch,
       agent_type, agent_provider, activity, closed_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'default', ?, ?, 'pty', 'claude', 'idle', ?, ?, ?)`,
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

async function waitForE2EInvoke<T>(
  client: WebDriverClient,
  predicateSource: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let calls: unknown[] = [];

  while (Date.now() < deadline) {
    const result = await client.executeSync<{ match: T | null; calls: unknown[] }>(
      `const calls = window.__KANNA_E2E__.invokes.getAll();
       const match = calls.find(${predicateSource});
       return { match: match ? JSON.parse(JSON.stringify(match.args)) : null, calls };`
    );
    calls = result.calls;
    if (result.match) return result.match;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for E2E invoke; calls were ${JSON.stringify(calls)}`);
}

async function waitForE2EInvokes<T>(
  client: WebDriverClient,
  predicateSource: string,
  description: string,
  timeoutMs = 5_000,
): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  let calls: unknown[] = [];

  while (Date.now() < deadline) {
    const result = await client.executeSync<{ matches: T[]; calls: unknown[] }>(
      `const calls = window.__KANNA_E2E__.invokes.getAll();
       const matches = calls.filter(${predicateSource}).map((call) => call.args);
       return { matches: JSON.parse(JSON.stringify(matches)), calls };`
    );
    calls = result.calls;
    if (result.matches.length > 0) return result.matches;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${description}; calls were ${JSON.stringify(calls)}`);
}

async function expectNoE2EInvoke(
  client: WebDriverClient,
  predicateSource: string,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let calls: unknown[] = [];

  while (Date.now() < deadline) {
    const result = await client.executeSync<{ match: unknown | null; calls: unknown[] }>(
      `const calls = window.__KANNA_E2E__.invokes.getAll();
       const match = calls.find(${predicateSource});
       return { match: match ? JSON.parse(JSON.stringify(match.args)) : null, calls };`
    );
    calls = result.calls;
    if (result.match) {
      throw new Error(`Unexpected ${description}: ${JSON.stringify(result.match)}; calls were ${JSON.stringify(calls)}`);
    }
    await sleep(100);
  }
}

function encodeInput(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
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
         ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(testRepoPath)}, "Say OK", "agent")
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

  it("launches a new PTY task with runtime guidance without persisting or displaying it as the user prompt", async () => {
    const prompt = "Inspect the runtime guidance launch path";
    const createResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       window.__KANNA_E2E__.invokes.clear();
       ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(testRepoPath)}, ${JSON.stringify(prompt)}, "pty", {
         agentProvider: "codex",
       })
         .then(() => cb("ok"))
         .catch((error) => cb("err:" + error));`
    );
    expect(createResult).toBe("ok");

    const rows = (await queryDb(
      client,
      "SELECT id, prompt FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, prompt],
    )) as Array<{ id: string; prompt: string }>;
    expect(rows[0]?.prompt).toBe(prompt);

    const spawnCall = await waitForE2EInvoke<{ args?: string[]; env?: Record<string, string> }>(
      client,
      `(call) => call.cmd === "spawn_session" && call.args?.sessionId === ${JSON.stringify(rows[0]?.id)}`,
    );
    expect(spawnCall).toBeTruthy();

    const firstTaskRows = (await queryDb(
      client,
      "SELECT id FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Say OK"],
    )) as Array<{ id: string }>;
    await callVueMethod(client, "store.selectItem", firstTaskRows[0]?.id);

    const command = spawnCall?.args?.join(" ") ?? "";
    expect(command).toMatch(/This\s+session\s+was\s+launched\s+by\s+Kanna/);
    expect(command).toContain(prompt);
    expect(command).toContain(`$ %s\\033[0m\\n' 'codex `);

    const visibleCommandMatch = command.match(/printf '\\033\[2m\$ %s\\033\[0m\\n' 'codex ([\s\S]*?)' && codex /);
    expect(visibleCommandMatch?.[1]).toContain(prompt.replace(/'/g, "'\\''"));
    expect(visibleCommandMatch?.[1]).not.toMatch(/This\s+session\s+was\s+launched\s+by\s+Kanna/);
    expect(spawnCall?.env?.KANNA_TASK_ID).toBe(rows[0]?.id);

    const sendInputCalls = await waitForE2EInvokes<{ sessionId?: string; data?: number[] }>(
      client,
      `(call) => call.cmd === "send_input" &&
        call.args?.sessionId === ${JSON.stringify(rows[0]?.id)} &&
        JSON.stringify(call.args?.data) === ${JSON.stringify(JSON.stringify(encodeInput("\r")))}`,
      "Codex PTY task creation submit input",
      7_000,
    );
    expect(sendInputCalls).toContainEqual({
      sessionId: rows[0]?.id,
      data: encodeInput("\r"),
    });

    const oldCsiUFollowUpDelayMs = 1_000;
    await expectNoE2EInvoke(
      client,
      `(call) => call.cmd === "send_input" &&
        call.args?.sessionId === ${JSON.stringify(rows[0]?.id)} &&
        JSON.stringify(call.args?.data) === ${JSON.stringify(JSON.stringify(encodeInput("\x1b[13u")))}`,
      "Codex PTY task creation CSI-u follow-up input",
      oldCsiUFollowUpDelayMs + 250,
    );
  });

  it("closes into teardown and stays visible when teardown commands exist", async () => {
    const rows = (await queryDb(
      client,
      "SELECT id, branch FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Say OK"],
    )) as Array<{ id: string; branch: string }>;
    const taskId = rows[0]?.id;
    const branch = rows[0]?.branch;
    expect(taskId).toBeTruthy();
    expect(branch).toBeTruthy();
    if (!taskId || !branch) {
      throw new Error("expected the created task to have a branch");
    }

    await tauriInvoke(client, "write_text_file", {
      path: `${testRepoPath}/.kanna-worktrees/${branch}/.kanna/config.json`,
      content: JSON.stringify({
        setup: [],
        teardown: ["printf 'teardown\\n' && sleep 2"],
      }),
    });

    await callVueMethod(client, "store.selectItem", taskId);

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

  it("closes immediately and disappears when teardown commands do not exist", async () => {
    // Internal setup only: this creates a second inert task to isolate close
    // behavior from terminal and agent process startup.
    const createResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(testRepoPath)}, "Close Fast", "agent")
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

    // closed_at is the sole done indicator — closing never rewrites stage.
    const closedRow = await waitForPipelineItem<{ closed_at: string | null }>(
      client,
      "SELECT closed_at FROM pipeline_item WHERE repo_id = ? AND prompt = ? ORDER BY created_at DESC LIMIT 1",
      [repoId, "Close Fast"],
      (row) => typeof row?.closed_at === "string" && row.closed_at.length > 0,
    );
    expect(closedRow.closed_at).toBeTruthy();

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
    expect(metrics.invokeCounts.spawn_session ?? 0).toBeGreaterThanOrEqual(1);
    expect(metrics.invokeCalls).toBeDefined();

    const callsForClosedTask = (metrics.invokeCalls ?? []).filter((call) =>
      JSON.stringify(call).includes(closedTaskId)
      || JSON.stringify(call).includes(closedBranch)
    );
    expect(callsForClosedTask).toEqual([]);
  });
});
