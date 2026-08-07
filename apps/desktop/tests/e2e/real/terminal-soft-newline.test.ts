import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { pressShiftEnterInActiveTerminal } from "../helpers/terminalInput";
import { callVueMethod, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

const SHIFT_ENTER_CSI_U = [27, 91, 49, 51, 59, 50, 117];

interface DaemonSessionInfo {
  session_id?: string;
  state?: unknown;
}

function isVueCallError(value: unknown): value is { __error: string } {
  return typeof value === "object" && value !== null && "__error" in value;
}

async function waitForCurrentItemId(
  client: WebDriverClient,
  itemId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentItem = await getVueState(client, "currentItem") as { id?: string | null } | null;
    if (currentItem?.id === itemId) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for current item ${itemId}`);
}

async function waitForDaemonSession(
  client: WebDriverClient,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    latest = await tauriInvoke(client, "list_sessions").catch((error) => ({ error: String(error) }));
    if (Array.isArray(latest) && latest.some((session: DaemonSessionInfo) => session.session_id === sessionId)) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for daemon session ${sessionId}; latest=${JSON.stringify(latest)}`);
}

async function clearE2EInvokes(client: WebDriverClient): Promise<void> {
  await client.executeSync("window.__KANNA_E2E__.invokes.clear();");
}

async function waitForShiftEnterSendInput(
  client: WebDriverClient,
  sessionId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let calls: unknown[] = [];
  while (Date.now() < deadline) {
    const result = await client.executeSync<{ found: boolean; calls: unknown[] }>(
      `const calls = window.__KANNA_E2E__.invokes.getAll();
       const found = calls.some((call) =>
         call.cmd === "send_input" &&
         call.args?.sessionId === ${JSON.stringify(sessionId)} &&
         JSON.stringify(call.args?.data) === ${JSON.stringify(JSON.stringify(SHIFT_ENTER_CSI_U))}
       );
       return { found, calls };`,
    );
    calls = result.calls;
    if (result.found) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for OpenCode Shift+Enter send_input; calls=${JSON.stringify(calls)}`);
}

describe("opencode soft newline (real CLI)", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";
  let repoId = "";
  let taskId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();
    testRepoPath = await createFixtureRepo("opencode-soft-newline-real-test");
    repoId = await importTestRepo(client, testRepoPath, "opencode-soft-newline-real-test");
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

  it("sends Shift+Enter as soft newline after reattaching an OpenCode terminal", async () => {
    const createResult = await callVueMethod(
      client,
      "store.createItem",
      repoId,
      testRepoPath,
      "",
      "pty",
      {
        agentProvider: "opencode",
        permissionMode: "dontAsk",
        selectOnCreate: true,
      },
    );
    if (isVueCallError(createResult)) throw new Error(createResult.__error);
    if (typeof createResult !== "string") throw new Error(`unexpected createItem result: ${JSON.stringify(createResult)}`);
    taskId = createResult;

    const rows = await queryDb(
      client,
      "SELECT agent_provider FROM pipeline_item WHERE id = ?",
      [taskId],
    ) as Array<{ agent_provider: string | null }>;
    expect(rows[0]?.agent_provider).toBe("opencode");

    await waitForDaemonSession(client, taskId);
    await client.waitForElement(".terminal-container", 15_000);

    await client.reload();
    await callVueMethod(client, "store.selectRepo", repoId);
    await callVueMethod(client, "store.selectItem", taskId);
    await waitForCurrentItemId(client, taskId);
    await waitForDaemonSession(client, taskId);
    await client.waitForElement(".terminal-container", 15_000);

    await clearE2EInvokes(client);
    await pressShiftEnterInActiveTerminal(client);

    await waitForShiftEnterSendInput(client, taskId);
  }, 60_000);
});
