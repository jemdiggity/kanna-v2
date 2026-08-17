import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo, publishFixtureChanges } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { nudgeTerminalTrustPrompt } from "../helpers/terminalInput";
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

async function waitForActiveSession(client: WebDriverClient, taskId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const sessions = await tauriInvoke(client, "list_sessions") as Array<{ session_id?: string; state?: string }>;
    const session = sessions.find((candidate) => candidate.session_id === taskId);
    if (session?.state === "Active" || session?.state === "Suspended") return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for active session ${taskId}`);
}

async function readTaskRow(
  client: WebDriverClient,
  taskId: string,
): Promise<{ agent_provider: string | null }> {
  const rows = (await queryDb(
    client,
    "SELECT agent_provider FROM pipeline_item WHERE id = ?",
    [taskId],
  )) as Array<{ agent_provider: string | null }>;
  const row = rows[0];
  if (!row) throw new Error(`task ${taskId} was not found`);
  return row;
}

async function countOpenBlockerEdges(client: WebDriverClient, taskId: string): Promise<number> {
  const rows = (await queryDb(
    client,
    "SELECT COUNT(*) AS blocker_count FROM task_blocker WHERE blocked_item_id = ?",
    [taskId],
  )) as Array<{ blocker_count: number }>;
  return rows[0]?.blocker_count ?? 0;
}

// Quarantined for the server/daemon product gap documented in
// docs/2026-08-17-live-blocked-task-unblock-context-e2e-gap.md.
describe.skip("real blocked task resume agent submission", () => {
  const client = new WebDriverClient();
  const workflowName = "real-blocked-resume-submit";
  let repoId = "";
  let testRepoPath = "";
  let taskId = "";
  let worktreePath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();

    testRepoPath = await createFixtureRepo("blocked-resume-real-agent-test");
    const kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "workflows"), { recursive: true });
    await writeFile(
      join(kannaDir, "workflows", `${workflowName}.json`),
      JSON.stringify({
        name: workflowName,
        stages: [
          { name: "in progress", transition: "manual" },
        ],
      }),
    );
    await publishFixtureChanges(testRepoPath, "test: add blocked resume workflow");

    repoId = await importTestRepo(client, testRepoPath, "blocked-resume-real-agent-test");
  });

  afterAll(async () => {
    if (taskId) {
      await tauriInvoke(client, "kill_session", { sessionId: taskId }).catch(() => undefined);
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("resumes a live blocked task and submits the unblock prompt without a manual Enter", async () => {
    const createResult = await callVueMethod(
      client,
      "store.createItem",
      repoId,
      testRepoPath,
      "",
      "pty",
      {
        workflowName,
        permissionMode: "dontAsk",
        selectOnCreate: true,
      },
    );
    if (isVueCallError(createResult)) throw new Error(createResult.__error);
    if (typeof createResult !== "string") throw new Error(`unexpected createItem result: ${JSON.stringify(createResult)}`);
    taskId = createResult;

    worktreePath = await waitForNewTaskWorktree(testRepoPath, new Set(), 60_000);
    const initialRow = await readTaskRow(client, taskId);
    await waitForActiveSession(client, taskId);
    await nudgeTerminalTrustPrompt(client, {
      initialDelayMs: 5_000,
      attempts: 4,
      intervalMs: 5_000,
    });

    const blockerId = "blocked-resume-blocker";
    const blockerDisplayName = "Create a file named blocked-resume-real-submit.txt containing exactly resumed";
    // Closed blocker: closed_at set, stage keeps its last real value.
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, pipeline, stage, branch, closed_at,
          agent_type, agent_provider, activity, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'),
          ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        blockerId,
        repoId,
        "Complete dependency",
        workflowName,
        "in progress",
        "task-blocked-resume-blocker",
        "pty",
        initialRow.agent_provider ?? "opencode",
        "idle",
        blockerDisplayName,
      ],
    );
    await execDb(
      client,
      "INSERT INTO task_blocker (blocked_item_id, blocker_item_id) VALUES (?, ?)",
      [taskId, blockerId],
    );
    // Blocked-ness comes from the task_blocker row inserted above, not tags.
    await execDb(
      client,
      "UPDATE pipeline_item SET activity = 'idle', updated_at = datetime('now') WHERE id = ?",
      [taskId],
    );
    await hydrateStoreItem(client, taskId);

    const editResult = await callVueMethod(client, "store.editBlockedTask", taskId, []);
    if (isVueCallError(editResult)) throw new Error(editResult.__error);

    const markerPath = join(worktreePath, "blocked-resume-real-submit.txt");
    await waitForFile(markerPath, 180_000, 1_000);
    expect((await readFile(markerPath, "utf8")).trimEnd()).toBe("resumed");

    expect(await countOpenBlockerEdges(client, taskId)).toBe(0);
    expect(["codex", "claude", "copilot", "opencode"]).toContain(initialRow.agent_provider);
  }, 300_000);
});
