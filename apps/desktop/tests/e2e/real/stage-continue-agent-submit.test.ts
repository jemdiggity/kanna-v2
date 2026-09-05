import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo, publishFixtureChanges } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { pressAdvanceStageShortcut } from "../helpers/stageAdvance";
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
): Promise<{ agent_provider: string | null; agent_session_id: string | null }> {
  const rows = (await queryDb(
    client,
    "SELECT agent_provider, agent_session_id FROM pipeline_item WHERE id = ?",
    [taskId],
  )) as Array<{ agent_provider: string | null; agent_session_id: string | null }>;
  const row = rows[0];
  if (!row) throw new Error(`task ${taskId} was not found`);
  return row;
}

describe("real post injection into a live agent session", () => {
  const client = new WebDriverClient();
  const workflowName = "real-continue-submit";
  let repoId = "";
  let testRepoPath = "";
  let taskId = "";
  let worktreePath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();

    testRepoPath = await createFixtureRepo("stage-continue-real-agent-test");
    const kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "workflows"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "commit-real"), { recursive: true });
    // The commit work is a POST of `in progress`: advancing injects this
    // prompt into the LIVE agent session (same worktree, same process)
    // rather than spawning a fresh agent. The trailing `holding` stage gives
    // the post's success somewhere to transition to.
    await writeFile(
      join(kannaDir, "workflows", `${workflowName}.json`),
      JSON.stringify({
        name: workflowName,
        stages: [
          {
            name: "in progress",
            policy: { transition: "manual" },
            post: {
              name: "commit",
              agent: "commit-real",
              prompt: "Run exactly: printf 'submitted\\n' > continue-stage-real-submit.txt. Then call the MCP tool kanna_complete_stage with task_id from KANNA_TASK_ID, status success, and summary 'continue submitted'. Use the existing MCP connection. Do not use kanna-cli or HTTP for completion. Do not wait for any additional input.",
            },
          },
          { name: "holding", policy: { transition: "manual" } },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "agents", "commit-real", "AGENT.md"),
      [
        "---",
        "name: commit-real",
        "description: Real continue-stage E2E agent.",
        "---",
        "",
      ].join("\n"),
    );
    await publishFixtureChanges(testRepoPath, "test: add real continue workflow");

    repoId = await importTestRepo(client, testRepoPath, "stage-continue-real-agent-test");
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

  it("injects the commit post into the live agent session and executes it in place", async () => {
    const initialPrompt = process.env.KANNA_E2E_REAL_AGENT_PROVIDER === "codex"
      ? "Create a file named continue-stage-initial.txt in the current directory containing exactly: ready. Then stop."
      : "";
    const createResult = await callVueMethod(
      client,
      "store.createItem",
      repoId,
      testRepoPath,
      initialPrompt,
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
    if (initialRow.agent_provider === "codex") {
      const initialMarkerPath = join(worktreePath, "continue-stage-initial.txt");
      await waitForFile(initialMarkerPath, 180_000, 1_000);
      expect((await readFile(initialMarkerPath, "utf8")).trimEnd()).toBe("ready");
      await hydrateStoreItem(client, taskId);
    } else {
      await waitForActiveSession(client, taskId);
      await nudgeTerminalTrustPrompt(client, {
        initialDelayMs: 5_000,
        attempts: 4,
        intervalMs: 5_000,
      });
    }

    await execDb(
      client,
      "UPDATE pipeline_item SET activity = 'idle', updated_at = datetime('now') WHERE id = ?",
      [taskId],
    );
    await hydrateStoreItem(client, taskId);

    // Posts continue the session: advancing injects the commit prompt into
    // the LIVE agent (no respawn, no fork), which writes the marker in the
    // task's current worktree and records completion. The post's success
    // then performs the transition to `holding`.
    await pressAdvanceStageShortcut(client);

    const markerPath = join(worktreePath, "continue-stage-real-submit.txt");
    await waitForFile(markerPath, 180_000, 1_000);
    expect((await readFile(markerPath, "utf8")).trimEnd()).toBe("submitted");

    const runRows = (await queryDb(
      client,
      "SELECT kind, stage, status FROM stage_run WHERE task_id = ? AND kind = 'post'",
      [taskId],
    )) as Array<{ kind: string | null; stage: string | null; status: string | null }>;
    expect(runRows.length).toBeGreaterThanOrEqual(1);
    expect(runRows[0]?.stage).toBe("commit");

    await vi.waitFor(async () => {
      const stageRows = (await queryDb(
        client,
        "SELECT stage, closed_at FROM pipeline_item WHERE id = ?",
        [taskId],
      )) as Array<{ stage: string | null; closed_at: string | null }>;
      expect(stageRows[0]?.stage).toBe("holding");
      expect(stageRows[0]?.closed_at).toBeNull();
      const posts = (await queryDb(client,
        "SELECT status FROM stage_run WHERE task_id = ? AND kind = 'post'", [taskId],
      )) as Array<{ status: string }>;
      expect(posts).toHaveLength(1);
      expect(posts[0]?.status).toBe("succeeded");
    }, { timeout: 180_000, interval: 1_000 });

    expect(["codex", "claude", "copilot", "opencode", "antigravity"]).toContain(initialRow.agent_provider);
  }, 300_000);
});
