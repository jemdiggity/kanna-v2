import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { queryDb, tauriInvoke, callVueMethod } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

const execFileAsync = promisify(execFile);

interface PipelineItemRow {
  id: string;
  branch: string;
  base_ref: string | null;
}

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args]);
  return stdout.trim();
}

async function waitForTaskRow(
  client: WebDriverClient,
  prompt: string,
  timeoutMs = 10_000,
): Promise<PipelineItemRow> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT id, branch, base_ref FROM pipeline_item WHERE prompt = ? ORDER BY created_at DESC LIMIT 1",
      [prompt],
    )) as PipelineItemRow[];
    const row = rows[0];
    if (row?.id && row.branch) return row;
    await sleep(200);
  }

  throw new Error(`timed out waiting for task row: ${prompt}`);
}

async function waitForWorktreeHead(
  repoPath: string,
  branch: string,
  timeoutMs = 20_000,
): Promise<string> {
  const worktreePath = join(repoPath, ".kanna-worktrees", branch);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const head = await git(worktreePath, ["rev-parse", "HEAD"]).catch(() => null);
    if (head) return head;
    await sleep(250);
  }

  throw new Error(`timed out waiting for worktree HEAD: ${worktreePath}`);
}

describe("task base branch", () => {
  const client = new WebDriverClient();
  const prompt = "Start task from origin main";
  let repoId = "";
  let testRepoPath = "";
  let taskId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);

    testRepoPath = await createFixtureRepo("task-base-branch-real-test");
    await writeFile(join(testRepoPath, "local-only.txt"), "local main only\n");
    await git(testRepoPath, ["add", "local-only.txt"]);
    await git(testRepoPath, ["commit", "-m", "test: local main only"]);

    repoId = await importTestRepo(client, testRepoPath, "task-base-branch-real-test");
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

  it("creates task worktrees from origin/main instead of the local main HEAD", async () => {
    const originMainHead = await git(testRepoPath, ["rev-parse", "origin/main"]);
    const localMainHead = await git(testRepoPath, ["rev-parse", "main"]);
    expect(localMainHead).not.toBe(originMainHead);

    const createResult = await callVueMethod(client, "store.createItem", repoId, testRepoPath, prompt, "agent");
    if (isVueCallError(createResult)) {
      throw new Error(createResult.__error);
    }

    const task = await waitForTaskRow(client, prompt);
    taskId = task.id;
    expect(task.base_ref).toBe("origin/main");

    const worktreeHead = await waitForWorktreeHead(testRepoPath, task.branch);
    expect(worktreeHead).toBe(originMainHead);
    expect(worktreeHead).not.toBe(localMainHead);
  });
});
