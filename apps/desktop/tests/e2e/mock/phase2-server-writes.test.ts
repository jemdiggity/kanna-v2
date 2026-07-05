import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

interface TaskRow {
  id: string;
  prompt: string | null;
  pipeline: string | null;
  stage: string | null;
  branch: string | null;
  closed_at: string | null;
  port_env: string | null;
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

describe("Phase 2 server-owned task writes", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";
  let repoId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("phase2-server-writes-test");
    testRepoPath = fixtureRepoRoot;

    const kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "pipelines"), { recursive: true });
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
      join(kannaDir, "pipelines", "default.json"),
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
    const createResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(testRepoPath)}, ${JSON.stringify(prompt)}, "pty", {
         agentProvider: "codex",
         pipelineName: "default",
         stage: "review",
         displayName: "Transferred review task",
         selectOnCreate: false
       })
         .then((id) => cb(id))
         .catch((error) => cb("__error:" + (error?.message || String(error))));`,
    );
    if (createResult.startsWith("__error:")) throw new Error(createResult);

    const row = await waitForRow<TaskRow>(
      client,
      "SELECT id, prompt, pipeline, stage, branch, closed_at, port_env FROM pipeline_item WHERE id = ?",
      [createResult],
      (candidate) => candidate?.stage === "review" && Boolean(candidate.branch),
      "server-created review task",
    );
    expect(row).toMatchObject({
      prompt,
      pipeline: "default",
      stage: "review",
      closed_at: null,
    });
    expect(row.port_env).toContain("KANNA_DEV_PORT");
    expect(await countRows(client, "SELECT COUNT(*) AS count FROM worktree WHERE pipeline_item_id = ?", [row.id])).toBe(1);
    expect(await countRows(client, "SELECT COUNT(*) AS count FROM task_port WHERE pipeline_item_id = ?", [row.id])).toBe(1);
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
      "SELECT id, prompt, pipeline, stage, branch, closed_at, port_env FROM pipeline_item WHERE id = ?",
      [taskId],
      (candidate) => typeof candidate?.closed_at === "string" && candidate.closed_at.length > 0,
      "closed task row",
    );
    expect(row.stage).toBe("review");
    expect(await countRows(client, "SELECT COUNT(*) AS count FROM task_port WHERE pipeline_item_id = ?", [taskId])).toBe(0);
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
    expect(await countRows(client, "SELECT COUNT(*) AS count FROM task_blocker WHERE blocked_item_id = ? AND blocker_item_id = ?", ["phase2-blocked", "phase2-blocker"])).toBe(1);

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
    await execDb(
      client,
      `INSERT INTO pipeline_item (id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider, activity, created_at, updated_at)
       VALUES (?, ?, ?, 'default', 'review', ?, 'pty', 'codex', 'idle', datetime('now'), datetime('now'))`,
      ["phase2-race", repoId, "Phase2 advance close race", "task-phase2-race"],
    );
    await refreshSnapshot(client);
    await selectTask(client, "phase2-race");

    const result = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const store = window.__KANNA_E2E__.setupState.store;
       Promise.allSettled([
         store.advanceStage("phase2-race"),
         store.closeTask("phase2-race", { selectNext: false })
       ])
         .then((results) => cb(JSON.stringify(results.map((entry) => entry.status))))
         .catch((error) => cb("__error:" + (error?.message || String(error))));`,
    );
    if (result.startsWith("__error:")) throw new Error(result);

    const row = await waitForRow<TaskRow>(
      client,
      "SELECT id, prompt, pipeline, stage, branch, closed_at, port_env FROM pipeline_item WHERE id = ?",
      ["phase2-race"],
      (candidate) => typeof candidate?.closed_at === "string" && candidate.closed_at.length > 0,
      "race task closed",
    );
    expect(row.stage).toBe("review");
    expect(await countRows(client, "SELECT COUNT(*) AS count FROM pipeline_item WHERE id = ?", ["phase2-race"])).toBe(1);
  });
});
