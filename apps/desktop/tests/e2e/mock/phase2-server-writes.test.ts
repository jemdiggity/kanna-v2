import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

interface TaskRow {
  id: string;
  repo_id?: string;
  prompt: string | null;
  display_name?: string | null;
  pipeline: string | null;
  pipeline_def?: string | null;
  stage: string | null;
  branch: string | null;
  closed_at: string | null;
  agent_type?: string | null;
  agent_provider?: string | null;
  activity?: string | null;
  port_offset?: number | null;
  port_env: string | null;
  agent_spawn_options?: string | null;
  parent_task_id?: string | null;
  notify_task_id?: string | null;
  teardown_started_at?: string | null;
}

interface WorktreeRow {
  pipeline_item_id: string;
  path: string;
  branch: string;
}

interface TaskPortRow {
  pipeline_item_id: string;
  env_name: string;
  port: number;
}

interface TaskBlockerRow {
  blocked_item_id: string;
  blocker_item_id: string;
}

interface CountRow {
  count: number;
}

async function waitForRow<T>(
  client: WebDriverClient,
  sql: string,
  params: unknown[],
  predicate: (row: T | undefined) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const rows = await queryDb(client, sql, params) as T[];
    last = rows[0];
    if (predicate(last)) return last as T;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${description}; last row: ${JSON.stringify(last)}`);
}

async function countRows(client: WebDriverClient, sql: string, params: unknown[] = []): Promise<number> {
  const rows = await queryDb(client, sql, params) as CountRow[];
  return rows[0]?.count ?? 0;
}

function isVueCallError(result: unknown): result is { __error: string } {
  return Boolean(
    result &&
    typeof result === "object" &&
    "__error" in result &&
    typeof (result as { __error?: unknown }).__error === "string",
  );
}

async function selectTask(client: WebDriverClient, taskId: string): Promise<void> {
  const result = await callVueMethod(client, "store.selectItem", taskId);
  if (isVueCallError(result)) throw new Error(result.__error);
  const deadline = Date.now() + 5_000;
  let lastSelected: unknown = null;
  while (Date.now() < deadline) {
    lastSelected = await getVueState(client, "selectedItemId");
    if (lastSelected === taskId) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for selected task ${taskId}; saw ${JSON.stringify(lastSelected)}`);
}

async function refreshSnapshot(client: WebDriverClient): Promise<void> {
  const result = await callVueMethod(client, "refreshAllItems");
  if (isVueCallError(result)) throw new Error(result.__error);
}

async function createServerTask(
  client: WebDriverClient,
  repoId: string,
  repoPath: string,
  prompt: string,
  options: Record<string, unknown> = {},
): Promise<string> {
  const createResult = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(repoPath)}, ${JSON.stringify(prompt)}, "pty", ${JSON.stringify({
       agentProvider: "codex",
       workflowName: "default",
       selectOnCreate: false,
       ...options,
     })})
       .then((id) => cb(id))
       .catch((error) => cb("__error:" + (error?.message || String(error))));`,
  );
  if (createResult.startsWith("__error:")) throw new Error(createResult);
  return createResult;
}

async function postDesktopTaskAction(
  client: WebDriverClient,
  taskId: string,
  action: string,
): Promise<{ status: number; body: string }> {
  // This call is made from inside the desktop webview, which is a real browser:
  // `kanna-server` classifies it as browser-originated and requires the local
  // control credential, exactly as it does for the app's own requests. So it
  // goes out through the same credential the app uses rather than through
  // `localProcessFetch`, which cannot run in a page.
  const result = await client.executeAsync<{ status?: number; body?: string; __error?: string }>(
    `const cb = arguments[arguments.length - 1];
     Promise.all([
       import("/src/utils/invokeHelpers.ts"),
       import("/src/services/localControlCredential.ts"),
     ])
       .then(async ([{ readEnvVarOptional }, { localControlAuthHeaders }]) => {
         const port = (await readEnvVarOptional("KANNA_MOBILE_SERVER_PORT")) || "48120";
         // local-fetch-exempt: a webview page cannot use node:http; it presents the credential instead
         const response = await fetch(
           "http://127.0.0.1:" + port + "/v1/tasks/" + encodeURIComponent(${JSON.stringify(taskId)}) + "/actions/" + ${JSON.stringify(action)},
           { method: "POST", headers: await localControlAuthHeaders() }
         );
         const body = await response.text();
         cb({ status: response.status, body });
       })
       .catch((error) => cb({ __error: error?.message || String(error) }));`,
  );
  if (result.__error) throw new Error(result.__error);
  return { status: result.status ?? 0, body: result.body ?? "" };
}

describe("Phase 2 server-owned task writes", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";
  let repoId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("phase2-server-writes-test");
    testRepoPath = await realpath(fixtureRepoRoot);

    const kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "workflows"), { recursive: true });
    await mkdir(join(kannaDir, "fake-bin"), { recursive: true });
    await writeFile(
      join(kannaDir, "config.json"),
      JSON.stringify({
        ports: {
          KANNA_DEV_PORT: 1420,
        },
        workspace: {
          path: {
            prepend: [".kanna/fake-bin"],
          },
        },
      }),
    );
    await writeFile(
      join(kannaDir, "workflows", "default.json"),
      JSON.stringify({
        name: "default",
        stages: [
          { name: "in progress", agent_provider: "codex", policy: { transition: "manual" } },
          { name: "review", agent_provider: "codex", policy: { transition: "manual" } },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "fake-bin", "codex"),
      [
        "#!/bin/sh",
        "mkdir -p .kanna",
        "printf '%s\\n' \"$@\" > .kanna/phase2-codex-args.txt",
        "printf 'phase2 fake codex complete\\n'",
        "",
      ].join("\n"),
    );
    await chmod(join(kannaDir, "fake-bin", "codex"), 0o755);

    await tauriInvoke(client, "run_script", {
      cwd: testRepoPath,
      script: "git add .kanna && git commit -m 'test: add phase2 fixtures'",
    });
    repoId = await importTestRepo(client, testRepoPath, "phase2-server-writes-test");
  });

  afterAll(async () => {
    if (testRepoPath) await cleanupWorktrees(client, testRepoPath);
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("creates through the desktop API with worktree, port, and transfer stage parity", async () => {
    const prompt = "Phase2 create server-owned transfer stage";
    const createResult = await createServerTask(client, repoId, testRepoPath, prompt, {
      stage: "review",
      displayName: "Transferred review task",
    });

    const row = await waitForRow<TaskRow>(
      client,
      `SELECT id, repo_id, prompt, display_name, pipeline, pipeline_def, stage, branch,
              closed_at, agent_type, agent_provider, activity, port_offset, port_env,
              agent_spawn_options, parent_task_id, notify_task_id, teardown_started_at
       FROM pipeline_item WHERE id = ?`,
      [createResult],
      (candidate) => candidate?.stage === "review" && Boolean(candidate.branch),
      "server-created review task",
    );
    expect(row).toMatchObject({
      repo_id: repoId,
      prompt,
      display_name: "Transferred review task",
      pipeline: "default",
      stage: "review",
      closed_at: null,
      agent_type: "pty",
      agent_provider: "codex",
      activity: "working",
      parent_task_id: null,
      notify_task_id: null,
      teardown_started_at: null,
    });
    expect(row.pipeline_def).toContain('"stages"');
    expect(JSON.parse(row.agent_spawn_options ?? "{}")).toMatchObject({
      allowedTools: [],
      disallowedTools: [],
      maxBudgetUsd: null,
      maxTurns: null,
      model: null,
      permissionMode: null,
    });
    expect(row.port_offset).toBeGreaterThanOrEqual(1);
    expect(row.port_env).toContain("KANNA_DEV_PORT");

    const worktrees = await queryDb(
      client,
      "SELECT pipeline_item_id, path, branch FROM worktree WHERE pipeline_item_id = ?",
      [row.id],
    ) as WorktreeRow[];
    expect(worktrees).toEqual([
      {
        pipeline_item_id: row.id,
        path: join(testRepoPath, ".kanna-worktrees", row.branch as string),
        branch: row.branch as string,
      },
    ]);

    const ports = await queryDb(
      client,
      "SELECT pipeline_item_id, env_name, port FROM task_port WHERE pipeline_item_id = ?",
      [row.id],
    ) as TaskPortRow[];
    expect(ports).toEqual([
      {
        pipeline_item_id: row.id,
        env_name: "KANNA_DEV_PORT",
        port: Number(JSON.parse(row.port_env ?? "{}").KANNA_DEV_PORT),
      },
    ]);
  });

  it("closes through the desktop API and lets the server release ports", async () => {
    const rows = await queryDb(
      client,
      "SELECT id FROM pipeline_item WHERE prompt = ? ORDER BY created_at DESC LIMIT 1",
      ["Phase2 create server-owned transfer stage"],
    ) as Array<{ id: string }>;
    const taskId = rows[0]?.id;
    expect(taskId).toBeTruthy();

    const result = await callVueMethod(client, "store.closeTask", taskId, { selectNext: false });
    if (isVueCallError(result)) throw new Error(result.__error);

    const row = await waitForRow<TaskRow>(
      client,
      `SELECT id, prompt, pipeline, stage, branch, closed_at, agent_type, agent_provider,
              activity, port_env, teardown_started_at
       FROM pipeline_item WHERE id = ?`,
      [taskId],
      (candidate) => typeof candidate?.closed_at === "string" && candidate.closed_at.length > 0,
      "closed task row",
    );
    expect(row).toMatchObject({
      prompt: "Phase2 create server-owned transfer stage",
      pipeline: "default",
      stage: "review",
      agent_type: "pty",
      agent_provider: "codex",
      activity: "working",
      port_env: expect.stringContaining("KANNA_DEV_PORT"),
    });
    expect(row.teardown_started_at).toBeNull();
    expect(await countRows(client, "SELECT COUNT(*) AS count FROM task_port WHERE pipeline_item_id = ?", [taskId])).toBe(0);
    expect(await countRows(client, "SELECT COUNT(*) AS count FROM stage_run WHERE task_id = ? AND status = 'running'", [taskId])).toBe(0);
  });

  it("blocks, unblocks, and surfaces server cycle rejection through the desktop API", async () => {
    await execDb(
      client,
      `INSERT INTO pipeline_item (id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider, activity, created_at, updated_at)
       VALUES
         ('phase2-blocked', ?, 'Phase2 blocked task', 'default', 'in progress', NULL, 'pty', 'codex', 'idle', datetime('now'), datetime('now')),
         ('phase2-blocker', ?, 'Phase2 blocker task', 'default', 'in progress', NULL, 'pty', 'codex', 'idle', datetime('now'), datetime('now'))`,
      [repoId, repoId],
    );
    await refreshSnapshot(client);
    await selectTask(client, "phase2-blocked");

    let result = await callVueMethod(client, "store.blockTask", ["phase2-blocker"]);
    if (isVueCallError(result)) throw new Error(result.__error);
    expect(await queryDb(
      client,
      "SELECT blocked_item_id, blocker_item_id FROM task_blocker WHERE blocked_item_id = ? ORDER BY blocker_item_id",
      ["phase2-blocked"],
    ) as TaskBlockerRow[]).toEqual([
      { blocked_item_id: "phase2-blocked", blocker_item_id: "phase2-blocker" },
    ]);

    result = await callVueMethod(client, "store.editBlockedTask", "phase2-blocked", []);
    if (isVueCallError(result)) throw new Error(result.__error);
    expect(await countRows(client, "SELECT COUNT(*) AS count FROM task_blocker WHERE blocked_item_id = ?", ["phase2-blocked"])).toBe(0);

    await execDb(
      client,
      "INSERT INTO task_blocker (blocked_item_id, blocker_item_id) VALUES (?, ?)",
      ["phase2-blocker", "phase2-blocked"],
    );
    await refreshSnapshot(client);
    result = await callVueMethod(client, "store.editBlockedTask", "phase2-blocked", ["phase2-blocker"]);
    expect(isVueCallError(result)).toBe(true);
    expect((result as { __error: string }).__error).toContain("circular");
    expect(await countRows(client, "SELECT COUNT(*) AS count FROM task_blocker WHERE blocked_item_id = ? AND blocker_item_id = ?", ["phase2-blocked", "phase2-blocker"])).toBe(0);
  });

  it("does not resurrect a closed task when advance and close race from the desktop", async () => {
    const taskId = await createServerTask(client, repoId, testRepoPath, "Phase2 advance close race");
    const original = await waitForRow<TaskRow>(
      client,
      "SELECT id, stage, branch, closed_at, port_env FROM pipeline_item WHERE id = ?",
      [taskId],
      (candidate) => candidate?.stage === "in progress" && Boolean(candidate.branch) && candidate.closed_at === null,
      "server-created race task",
    );
    await refreshSnapshot(client);
    await selectTask(client, taskId);

    const advance = await postDesktopTaskAction(client, taskId, "advance-stage");
    expect(advance.status, advance.body).toBe(200);
    expect(JSON.parse(advance.body)).toMatchObject({ taskId });

    const closeResult = await callVueMethod(client, "store.closeTask", taskId, { selectNext: false });
    if (isVueCallError(closeResult)) throw new Error(closeResult.__error);

    const row = await waitForRow<TaskRow>(
      client,
      "SELECT id, prompt, pipeline, stage, branch, closed_at, port_env FROM pipeline_item WHERE id = ?",
      [taskId],
      (candidate) => typeof candidate?.closed_at === "string" && candidate.closed_at.length > 0,
      "race task closed",
    );
    await sleep(1_000);

    const settled = await waitForRow<TaskRow>(
      client,
      "SELECT id, prompt, pipeline, stage, branch, closed_at, port_env FROM pipeline_item WHERE id = ?",
      [taskId],
      (candidate) => candidate?.closed_at === row.closed_at,
      "race task settled after detached advance",
      1_000,
    );
    // The real mock E2E daemon cannot be paused between the detached
    // advance's SessionCreated response and its DB write. This proves the
    // desktop wiring sends a valid server advance request for a server-created
    // task, then closes through the UI without resurrecting the row. The
    // deterministic "close lands before detached stage write" interleaving is
    // covered by the kanna-server race-boundary test.
    expect([original.stage, "review"]).toContain(settled.stage);
    expect(await countRows(client, "SELECT COUNT(*) AS count FROM pipeline_item WHERE id = ?", [taskId])).toBe(1);
  });
});
