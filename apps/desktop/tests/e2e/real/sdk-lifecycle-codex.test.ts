import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";
import { waitForFile, waitForNewTaskWorktree } from "../helpers/worktreeFs";

const execFileAsync = promisify(execFile);

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
}

async function git(repoPath: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repoPath, ...args]);
}

async function readTaskPortEnv(client: WebDriverClient, taskId: string): Promise<Record<string, string>> {
  const rows = (await queryDb(
    client,
    "SELECT port_env FROM pipeline_item WHERE id = ?",
    [taskId],
  )) as Array<{ port_env: string | null }>;
  return JSON.parse(rows[0]?.port_env ?? "{}") as Record<string, string>;
}

async function waitForTaskPortEnv(client: WebDriverClient, taskId: string, timeoutMs = 20_000): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const portEnv = await readTaskPortEnv(client, taskId);
    if (Object.keys(portEnv).length > 0) return portEnv;
    await sleep(250);
  }
  throw new Error(`timed out waiting for task port env: ${taskId}`);
}

async function waitForAgentTerminalSession(client: WebDriverClient, taskId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT daemon_session_id, label FROM terminal_session WHERE pipeline_item_id = ?",
      [taskId],
    )) as Array<{ daemon_session_id: string | null; label: string | null }>;
    if (rows.some((row) => row.daemon_session_id === taskId && row.label === "agent")) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for agent terminal session for ${taskId}`);
}

async function readTaskWorktreeNames(repoPath: string): Promise<string[]> {
  return readdir(join(repoPath, ".kanna-worktrees"), { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("task-"))
        .map((entry) => entry.name),
    )
    .catch(() => []);
}

// Codex account/quota state makes this an explicit operator lane. The default
// real runner uses OpenCode's free model and must never launch this test.
describe.skipIf(process.env.KANNA_E2E_REAL_AGENT_PROVIDER !== "codex")("real Codex SDK lifecycle commands", () => {
  const client = new WebDriverClient();
  let repoId = "";
  let taskId = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();

    testRepoPath = await createFixtureRepo("codex-sdk-lifecycle-real-test");
    await mkdir(join(testRepoPath, ".kanna"), { recursive: true });
    await writeFile(
      join(testRepoPath, ".kanna", "config.json"),
      JSON.stringify({
        ports: {
          KANNA_DEV_PORT: 1420,
        },
        setup: [
          "set -eu; printf 'setup task:%s port:%s\\n' \"$KANNA_TASK_ID\" \"${KANNA_DEV_PORT:-missing}\" > codex-sdk-setup-marker.txt",
        ],
        teardown: [
          "set -eu; printf 'teardown task:%s port:%s\\n' \"$KANNA_TASK_ID\" \"${KANNA_DEV_PORT:-missing}\" > codex-sdk-teardown-marker.txt",
        ],
      }),
    );
    await git(testRepoPath, ["add", ".kanna/config.json"]);
    await git(testRepoPath, ["commit", "-m", "test: add sdk lifecycle commands"]);
    await git(testRepoPath, ["push", "origin", "main"]);

    repoId = await importTestRepo(client, testRepoPath, "codex-sdk-lifecycle-real-test");
  });

  afterAll(async () => {
    if (taskId) {
      await Promise.all([
        tauriInvoke(client, "kill_session", { sessionId: taskId }).catch(() => undefined),
        tauriInvoke(client, "kill_session", { sessionId: `td-${taskId}` }).catch(() => undefined),
      ]);
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("runs setup before a Codex SDK agent and teardown with task env", async () => {
    const baseline = new Set(await readTaskWorktreeNames(testRepoPath));
    const createResult = await callVueMethod(
      client,
      "store.createItem",
      repoId,
      testRepoPath,
      "Stop immediately. Do not make changes.",
      "agent",
      {
        agentProvider: "codex",
        selectOnCreate: true,
      },
    );
    if (isVueCallError(createResult)) throw new Error(createResult.__error);
    if (typeof createResult !== "string") throw new Error(`unexpected createItem result: ${JSON.stringify(createResult)}`);
    taskId = createResult;

    const worktreePath = await waitForNewTaskWorktree(testRepoPath, baseline, 60_000);
    const portEnv = await waitForTaskPortEnv(client, taskId);
    const expectedPort = portEnv.KANNA_DEV_PORT;
    expect(expectedPort).toBeTruthy();
    await waitForAgentTerminalSession(client, taskId);

    await waitForFile(join(worktreePath, "codex-sdk-setup-marker.txt"), 30_000, 500);
    expect((await readFile(join(worktreePath, "codex-sdk-setup-marker.txt"), "utf8")).trim()).toBe(
      `setup task:${taskId} port:${expectedPort}`,
    );

    const closeResult = await callVueMethod(client, "store.closeTask", taskId, { selectNext: false });
    if (isVueCallError(closeResult)) throw new Error(closeResult.__error);

    await waitForFile(join(worktreePath, "codex-sdk-teardown-marker.txt"), 30_000, 500);
    expect((await readFile(join(worktreePath, "codex-sdk-teardown-marker.txt"), "utf8")).trim()).toBe(
      `teardown task:${taskId} port:${expectedPort}`,
    );
  }, 300_000);
});
