import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";
import { waitForFile } from "../helpers/worktreeFs";
import { resolveAppKannaServer } from "../helpers/kannaServer";

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

async function waitForTaskBranch(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT branch FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as Array<{ branch?: string | null }>;
    const branch = rows[0]?.branch;
    if (branch) return branch;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for task branch: ${taskId}`);
}

describe("kanna-cli PATH in spawned tasks", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";
  let taskId = "";
  let cliCreatedTaskId = "";
  let worktreePath = "";
  let shellSessionId = "";
  let repoId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();

    testRepoPath = await createFixtureRepo("kanna-cli-path-real-test");
    await mkdir(join(testRepoPath, ".kanna"), { recursive: true });
    await writeFile(
      join(testRepoPath, ".kanna", "config.json"),
      JSON.stringify({
        setup: [
          "set -eu; resolved=$(command -v kanna-cli); test -n \"$resolved\"; printf '%s\\n' \"$resolved\" > .kanna-cli-from-path",
        ],
      }),
    );
    await git(testRepoPath, ["add", ".kanna/config.json"]);
    await git(testRepoPath, ["commit", "-m", "test: add kanna-cli path setup"]);
    await git(testRepoPath, ["push", "origin", "main"]);

    repoId = await importTestRepo(client, testRepoPath, "kanna-cli-path-real-test");
  });

  afterAll(async () => {
    if (shellSessionId) {
      await tauriInvoke(client, "kill_session", { sessionId: shellSessionId }).catch(() => undefined);
    }
    if (taskId) {
      await tauriInvoke(client, "kill_session", { sessionId: taskId }).catch(() => undefined);
    }
    if (cliCreatedTaskId) {
      await tauriInvoke(client, "kill_session", { sessionId: cliCreatedTaskId }).catch(() => undefined);
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  async function createTaskAndWaitForWorktree(): Promise<string> {
    if (worktreePath) return worktreePath;

    const createResult = await callVueMethod(
      client,
      "store.createItem",
      repoId,
      testRepoPath,
      "",
      "pty",
      { agentProvider: "codex", permissionMode: "dontAsk", selectOnCreate: false },
    );
    if (isVueCallError(createResult)) throw new Error(createResult.__error);
    if (typeof createResult !== "string") {
      throw new Error(`unexpected createItem result: ${JSON.stringify(createResult)}`);
    }
    taskId = createResult;

    const branch = await waitForTaskBranch(client, taskId);
    worktreePath = join(testRepoPath, ".kanna-worktrees", branch);

    return worktreePath;
  }

  async function startLocalServer(): Promise<string> {
    return (await resolveAppKannaServer(client)).baseUrl;
  }

  async function createTaskThroughKannaCli(kannaCliPath: string): Promise<string> {
    const serverUrl = await startLocalServer();
    const { stdout } = await execFileAsync(kannaCliPath, [
      "task",
      "create",
      "--repo-id",
      repoId,
      "--prompt",
      "",
      "--agent-provider",
      "codex",
      "--server-url",
      serverUrl,
    ]);
    const created = JSON.parse(stdout) as { taskId?: unknown };
    if (typeof created.taskId !== "string" || created.taskId.length === 0) {
      throw new Error(`unexpected task create output: ${stdout}`);
    }
    cliCreatedTaskId = created.taskId;

    const branch = await waitForTaskBranch(client, cliCreatedTaskId);
    return join(testRepoPath, ".kanna-worktrees", branch);
  }

  it("prepends the instance-local kanna-cli directory for task setup commands", async () => {
    const expectedKannaCliPath = await tauriInvoke(client, "which_binary", { name: "kanna-cli" });
    if (typeof expectedKannaCliPath !== "string" || expectedKannaCliPath.length === 0) {
      throw new Error(`unexpected kanna-cli path: ${JSON.stringify(expectedKannaCliPath)}`);
    }

    const taskWorktreePath = await createTaskAndWaitForWorktree();
    const markerPath = join(taskWorktreePath, ".kanna-cli-from-path");
    await waitForFile(markerPath, 60_000, 250);

    const resolvedFromTaskPath = (await readFile(markerPath, "utf8")).trim();
    expect(dirname(resolvedFromTaskPath)).toBe(dirname(expectedKannaCliPath));
    expect(resolvedFromTaskPath.endsWith("/kanna-cli")).toBe(true);
  }, 90_000);

  it("prepends the instance-local kanna-cli directory for task worktree shell sessions", async () => {
    const expectedKannaCliPath = await tauriInvoke(client, "which_binary", { name: "kanna-cli" });
    if (typeof expectedKannaCliPath !== "string" || expectedKannaCliPath.length === 0) {
      throw new Error(`unexpected kanna-cli path: ${JSON.stringify(expectedKannaCliPath)}`);
    }

    const taskWorktreePath = await createTaskAndWaitForWorktree();
    const rows = (await queryDb(
      client,
      "SELECT port_env FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as Array<{ port_env?: string | null }>;
    const markerPath = join(taskWorktreePath, ".kanna-cli-from-shell-path");
    shellSessionId = `shell-${taskId}`;

    const spawnResult = await callVueMethod(
      client,
      "store.spawnShellSession",
      shellSessionId,
      taskWorktreePath,
      rows[0]?.port_env ?? null,
      true,
      testRepoPath,
    );
    if (isVueCallError(spawnResult)) throw new Error(spawnResult.__error);

    await tauriInvoke(client, "send_input", {
      sessionId: shellSessionId,
      data: Array.from(
        new TextEncoder().encode(
          `set -eu; resolved=$(command -v kanna-cli); test -n "$resolved"; printf '%s\\n' "$resolved" > ${shellQuote(markerPath)}\n`,
        ),
      ),
    });

    await waitForFile(markerPath, 30_000, 250);
    const resolvedFromShellPath = (await readFile(markerPath, "utf8")).trim();
    expect(dirname(resolvedFromShellPath)).toBe(dirname(expectedKannaCliPath));
    expect(resolvedFromShellPath.endsWith("/kanna-cli")).toBe(true);
  }, 90_000);

  it("prepends the instance-local kanna-cli directory for tasks created through kanna-cli", async () => {
    const expectedKannaCliPath = await tauriInvoke(client, "which_binary", { name: "kanna-cli" });
    if (typeof expectedKannaCliPath !== "string" || expectedKannaCliPath.length === 0) {
      throw new Error(`unexpected kanna-cli path: ${JSON.stringify(expectedKannaCliPath)}`);
    }

    const taskWorktreePath = await createTaskThroughKannaCli(expectedKannaCliPath);
    const markerPath = join(taskWorktreePath, ".kanna-cli-from-path");
    await waitForFile(markerPath, 60_000, 250);

    const resolvedFromTaskPath = (await readFile(markerPath, "utf8")).trim();
    expect(dirname(resolvedFromTaskPath)).toBe(dirname(expectedKannaCliPath));
    expect(resolvedFromTaskPath.endsWith("/kanna-cli")).toBe(true);
  }, 90_000);
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
